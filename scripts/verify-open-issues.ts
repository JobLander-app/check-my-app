// CHE-399: the number beside Issues in the menu and the Issues page count the
// same thing from one stored figure (App.openIssues, src/lib/open-issues.ts).
//
// On a real D1 (every migration applied):
//   1. an app nothing has written yet: the column is null and the sidebar
//      falls back to its own count of unanswered findings in the latest check
//      — which differs from the page where two findings are one problem;
//   2. refreshOpenIssues stores what Issues' first filter shows for the app,
//      and from then on the sidebar's number is the page's;
//   3. an answer ("that's fine") changes the page's number, and a refresh
//      after it changes the sidebar's to the same;
//   4. a later check that sees the problem again makes it open again, and
//      the recount follows; a check of a deleted app recounts nothing and
//      does not throw.
// And in the source: the three write sites — the workflow after each price
// step, inside a catch; the PATCH route and the markFinding action after
// their update — and the migration that adds the column.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-open-issues.ts

import "./fixtures/wasm-module-loader.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { realD1 } from "./fixtures/real-d1";
import { openIssuesOf, refreshOpenIssues } from "../src/lib/open-issues";
import { loadShellData } from "../src/lib/shell-data";
import { teamRecurrences } from "../src/lib/recurring";
import { inIssuesFilter, issueView } from "../src/lib/issues-page";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

async function main() {
  const real = await realD1();
  try {
    const { db } = real;
    await db.user.create({ data: { id: "u", clerkUserId: "ck_u", email: "open@example.test" } });
    await db.team.create({ data: { id: "t", name: "T", plan: "business" } });
    await db.app.create({ data: { id: "shop", teamId: "t", ownerId: "u", appSlug: "shop.test", targetUrl: "https://shop.test", targetKind: "website" } });

    const day = (n: number) => new Date(Date.UTC(2026, 4, 1) + n * 86_400_000);
    const runRow = (id: string, n: number) => ({
      id, publicId: `p_${id}`, runNumber: n, teamId: "t", appId: "shop", appSlug: "shop.test", targetUrl: "https://shop.test", targetKind: "website",
      status: "completed", verdict: "mostly_ok", priceUsd: 0.5, startedAt: day(n), createdAt: day(n), completedAt: day(n),
    });
    const journey = (runId: string, k: number) => ({ id: `${runId}_j${k}`, runId, order: k, title: `Journey ${k}`, status: "ok", journeyKey: `journey-${k}` });
    const step = (j: string, s: number) => ({ id: `${j}_s${s}`, journeyId: j, order: s, label: `step ${s}`, status: "ok" });
    const finding = (id: string, runId: string, title: string, where: string, journeyIndex: number, stepIndex: number) => ({
      id, runId, number: 1, title, category: "broken", severity: "high",
      detail: JSON.stringify({ where }), anchor: JSON.stringify({ stepRef: { journeyIndex, stepIndex } }),
    });
    const seedRun = async (id: string, n: number) => {
      await db.run.create({ data: runRow(id, n) as never });
      await db.journey.createMany({ data: [journey(id, 0), journey(id, 1)] });
      await db.step.createMany({ data: [step(`${id}_j0`, 0), step(`${id}_j0`, 1), step(`${id}_j0`, 2), step(`${id}_j1`, 0), step(`${id}_j1`, 1)] });
    };

    // Check #1: two findings of ONE problem (same place, same step, reworded)
    // and one of another — Issues shows two problems; the latest-check SQL
    // counts three unanswered findings.
    await seedRun("r1", 1);
    await db.finding.createMany({ data: [
      finding("f1a", "r1", "Checkout button does nothing", "/checkout", 0, 2),
      finding("f1b", "r1", "Checkout button does nothing when clicked", "/checkout", 0, 2),
      finding("f1c", "r1", "Invoice download returns an empty file", "/invoices", 1, 1),
    ] });

    const pageCount = async () => {
      const shell = await loadShellData(db, "t");
      const latest = shell.apps.find((a) => a.id === "shop")?.latestRunNumber ?? null;
      const rows = (await teamRecurrences(db, "t", "shop")).get("shop") ?? [];
      return rows.filter((r) => inIssuesFilter("latest", issueView(r, latest), r.issue.state)).length;
    };
    const stored = async () => (await db.app.findUnique({ where: { id: "shop" }, select: { openIssues: true } }))?.openIssues ?? null;

    // 1 — nothing written yet.
    const before = await loadShellData(db, "t");
    check("1. an app nothing has written yet holds null, and the sidebar falls back to the latest check's unanswered findings",
      (await stored()) === null && before.openIssues === 3, JSON.stringify({ stored: await stored(), sidebar: before.openIssues }));
    check("…which is not what the page shows: two findings of one problem are one row there", (await pageCount()) === 2, String(await pageCount()));
    check("openIssuesOf is the page's number", (await openIssuesOf(db, "t", "shop")) === 2);

    // 2 — the recount.
    const written = await refreshOpenIssues(db, "shop");
    const after = await loadShellData(db, "t");
    check("2. refreshOpenIssues stores the page's number, and the sidebar sums the column from then on",
      written === 2 && (await stored()) === 2 && after.openIssues === 2, JSON.stringify({ written, stored: await stored(), sidebar: after.openIssues }));

    // 3 — an answer.
    await db.finding.update({ where: { id: "f1c" }, data: { mark: "known" } });
    check("3. the owner's answer changes the page's number…", (await pageCount()) === 1 && (await loadShellData(db, "t")).openIssues === 2,
      JSON.stringify({ page: await pageCount(), sidebarBeforeRefresh: (await loadShellData(db, "t")).openIssues }));
    await refreshOpenIssues(db, "shop");
    check("…and the recount after it makes the sidebar's the same", (await stored()) === 1 && (await loadShellData(db, "t")).openIssues === 1);

    // 4 — a later check: the checkout problem is seen again, the invoice one is
    // not looked at (its journey walked, no finding) → gone; a brand-new one.
    await seedRun("r2", 2);
    await db.finding.createMany({ data: [
      finding("f2a", "r2", "Checkout button does nothing", "/checkout", 0, 2),
      finding("f2b", "r2", "Search returns no results for any query", "/search", 1, 0),
    ] });
    check("4. a new check moves the page's number before any recount, and the stored figure still says the old one",
      (await pageCount()) === 2 && (await stored()) === 1);
    const recounted = await refreshOpenIssues(db, "shop");
    check("…the recount after the check makes them one number again", recounted === 2 && (await loadShellData(db, "t")).openIssues === 2, String(recounted));
    check("a recount of no app, or of an app that is gone, writes nothing and does not throw",
      (await refreshOpenIssues(db, null)) === null && (await refreshOpenIssues(db, "no-such-app")) === null);
  } finally {
    await real.dispose();
  }

  // ── the write sites and the column ─────────────────────────────────────────
  const workflow = read("src/agent/workflow.ts");
  check("workflow: the recount runs after the full run's price step and after the quick check's, in a step of its own",
    /await step\.do\("price", async \(\) => \{\s*await priceRun\(env\.db, runId\);\s*\}\);[\s\S]{0,400}await step\.do\("count-open-issues", \(\) => countOpenIssues\(env, run\.appId\)\);/.test(workflow) &&
      /await step\.do\("price-quick", async \(\) => \{\s*await priceRun\(env\.db, runId\);\s*\}\);\s*await step\.do\("count-open-issues-quick", \(\) => countOpenIssues\(env, run\.appId\)\);/.test(workflow));
  check("…inside a catch that logs and swallows: a counter never fails a run (rule 4)",
    /async function countOpenIssues\(env: AgentEnv, appId: string \| null\): Promise<void> \{\s*try \{\s*await refreshOpenIssues\(env\.db, appId\);\s*\} catch \(err\) \{\s*console\.warn\(/.test(workflow));
  const route = read("src/app/api/findings/[id]/route.ts");
  check("PATCH /api/findings/{id} recounts the finding's app after the mark is written",
    route.indexOf("await refreshOpenIssues(prisma, existing.run.appId)") > route.indexOf("data: { mark: parsed.data.mark }"));
  const action = read("src/app/(app)/health/issues/actions.ts");
  check("markFinding recounts the finding's app after the mark is written",
    action.indexOf("await refreshOpenIssues(db, finding.run.appId)") > action.indexOf("data: { mark: parsed.data.mark }"));
  check("reconcile changes a ticket's state only inside the workflow, whose finish step recounts — no fourth write site needed",
    !/reconcileIssueLinks|verifyFixedLinks/.test(read("src/agent/scheduler.ts")) && /reconcileIssueLinks\(env, run\)/.test(workflow));
  check("the sidebar reads the column and falls back per app", /a\.openIssues \?\? openOf\.get\(a\.id\) \?\? 0/.test(read("src/lib/shell-data.ts")));
  check("the column: in the schema and in a migration of its own",
    /openIssues\s+Int\?/.test(read("prisma/schema.prisma")) && /ALTER TABLE "App" ADD COLUMN "openIssues" INTEGER;/.test(read("prisma/migrations/0056_app_open_issues.sql")));

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("verify-open-issues: crashed:", err);
  process.exit(1);
});
