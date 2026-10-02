// recurringByApp over a real D1, at the size of a real team (CHE-354).
//
// recurrence() is pure and scripts/verify-finding-signature.ts holds its rules.
// What reads the database had no check at all — and the first page that called
// it (All apps, on the CHE-357 stand, 2026-10-02) took 30 s and crashed the
// query engine ("RuntimeError: unreachable"): the loader asked for every run →
// journey → step of an app's history as one nested select. It now reads the
// team's history in four flat statements.
//
// Held here, in a local D1 with every migration applied:
//   1. a team of two apps, 150 checks, 900 journeys and 4,500 steps is read and
//      grouped in seconds, not tens of seconds;
//   2. the answer is right: the problem seen in the last two checks is
//      recurring (2×), the one a later walk did not see again is gone, the
//      second app's single finding is new;
//   3. another team's checks stay out;
//   4. the loader holds no nested run → journey → step select.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-recurring-load.ts

import "./fixtures/wasm-module-loader.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { realD1 } from "./fixtures/real-d1";
import { recurringByApp } from "../src/lib/recurring";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const CHECKS = 150;
const JOURNEYS = 6;
const STEPS = 5;
const BUDGET_MS = 10_000;

async function main() {
  const real = await realD1();
  try {
    const { db } = real;
    await db.user.create({ data: { id: "u", clerkUserId: "ck_u", email: "load@example.test" } });
    await db.team.createMany({ data: [{ id: "t", name: "Load", plan: "business" }, { id: "other", name: "Other", plan: "business" }] });
    const app = (id: string, teamId: string) => ({ id, teamId, ownerId: "u", appSlug: `${id}.test`, targetUrl: `https://${id}.test`, targetKind: "website" });
    await db.app.createMany({ data: [app("big", "t"), app("small", "t"), app("theirs", "other")] });

    const day = (n: number) => new Date(Date.UTC(2026, 4, 1) + n * 86_400_000);
    const runRow = (id: string, n: number, appId: string, teamId: string) => ({
      id, publicId: `p_${id}`, runNumber: n, teamId, appId, appSlug: `${appId}.test`, targetUrl: `https://${appId}.test`, targetKind: "website",
      status: "completed", verdict: "mostly_ok", priceUsd: 0.5, startedAt: day(n), createdAt: day(n), completedAt: day(n),
    });
    const runs = [
      ...Array.from({ length: CHECKS }, (_, i) => runRow(`b${i + 1}`, i + 1, "big", "t")),
      runRow("s1", 201, "small", "t"),
      runRow("x1", 301, "theirs", "other"),
      runRow("x2", 302, "theirs", "other"),
    ];
    const journeys = runs.flatMap((r) =>
      Array.from({ length: JOURNEYS }, (_, k) => ({ id: `${r.id}_j${k}`, runId: r.id, order: k, title: `Journey ${k}`, status: "ok", journeyKey: `journey-${k}` })),
    );
    const steps = journeys.flatMap((j) =>
      Array.from({ length: STEPS }, (_, s) => ({ id: `${j.id}_s${s}`, journeyId: j.id, order: s, label: `step ${s}`, status: "ok" })),
    );
    const finding = (id: string, runId: string, title: string, where: string, journeyIndex: number, stepIndex: number) => ({
      id, runId, number: 1, title, category: "broken", severity: "high",
      detail: JSON.stringify({ where }), anchor: JSON.stringify({ stepRef: { journeyIndex, stepIndex } }),
    });
    const findings = [
      finding("f_gone", "b100", "Invoice download returns an empty file", "/invoices", 1, 1),
      finding("f_149", "b149", "Checkout button does nothing", "/checkout", 0, 2),
      finding("f_150", "b150", "Checkout button does nothing when clicked", "/checkout", 0, 2),
      finding("f_small", "s1", "Footer link to the terms page is dead", "/", 0, 0),
      finding("f_x1", "x1", "Their sign-in page shows a blank screen", "/login", 0, 0),
      finding("f_x2", "x2", "Their sign-in page shows a blank screen", "/login", 0, 0),
    ];
    // Twelve columns a row, and D1 binds at most a hundred values a statement.
    const inChunks = async <T,>(rows: T[], size: number, write: (chunk: T[]) => Promise<unknown>) => {
      for (let i = 0; i < rows.length; i += size) await write(rows.slice(i, i + size));
    };
    await inChunks(runs, 7, (data) => db.run.createMany({ data: data as never }));
    await inChunks(journeys, 16, (data) => db.journey.createMany({ data }));
    await inChunks(steps, 20, (data) => db.step.createMany({ data }));
    await db.finding.createMany({ data: findings });

    const started = Date.now();
    const byApp = await recurringByApp(db, "t");
    const ms = Date.now() - started;
    check(`${CHECKS} checks, ${journeys.length} journeys, ${steps.length} steps are read and grouped within ${BUDGET_MS / 1000} s`, ms < BUDGET_MS, `${ms} ms`);

    const big = byApp.get("big") ?? [];
    const checkout = big.find((i) => /Checkout button/.test(i.title));
    check("the problem seen in the last two checks is recurring, seen 2×, #149 → #150",
      checkout?.state === "recurring" && checkout.timesSeen === 2 && checkout.firstSeenRunNumber === 149 && checkout.lastSeenRunNumber === 150,
      JSON.stringify(checkout && { state: checkout.state, timesSeen: checkout.timesSeen, first: checkout.firstSeenRunNumber, last: checkout.lastSeenRunNumber }));
    const invoice = big.find((i) => /Invoice download/.test(i.title));
    check("the problem a later walk looked at again and did not see is gone", invoice?.state === "gone", String(invoice?.state));
    check("the big app has exactly those two issues", big.length === 2, String(big.length));
    const small = byApp.get("small") ?? [];
    check("the second app's single finding is new", small.length === 1 && small[0].state === "new", JSON.stringify(small.map((i) => i.state)));
    check("another team's checks stay out: only the team's two apps are answered for",
      [...byApp.keys()].sort().join(",") === "big,small" && ![...byApp.values()].flat().some((i) => /Their sign-in/.test(i.title)),
      [...byApp.keys()].join(","));

    // One app's page asks for one app (CHE-358): the same answer for it, and
    // nothing for an app of another team even when asked for by id.
    const onlySmall = await recurringByApp(db, "t", "small");
    check("asked for one app: that app alone, with the same answer",
      [...onlySmall.keys()].join(",") === "small" && JSON.stringify(onlySmall.get("small")) === JSON.stringify(small), [...onlySmall.keys()].join(","));
    const onlyBig = await recurringByApp(db, "t", "big");
    check("…and the big app alone is the big app's two issues", JSON.stringify(onlyBig.get("big")) === JSON.stringify(big) && onlyBig.size === 1);
    const notOurs = await recurringByApp(db, "t", "theirs");
    check("asked for another team's app by id: nothing is read", notOurs.size === 0, [...notOurs.keys()].join(","));

    const src = readFileSync(path.join(repoRoot, "src/lib/recurring.ts"), "utf8");
    check("the loader holds no nested run → journey → step select", !/steps:\s*\{\s*orderBy/.test(src) && !/db\.run\.findMany/.test(src));
  } finally {
    await real.dispose();
  }
}

main().then(() => {
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
});
