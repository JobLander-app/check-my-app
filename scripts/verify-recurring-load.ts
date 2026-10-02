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
import { recurrencesAsOf, recurringByApp } from "../src/lib/recurring";
import { checkDelta, deltaLine } from "../src/lib/check-delta";

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

    // CHE-371 (Codex P1s on #247). Three small apps beside the two above:
    //   presave — a check of its address made with no app (#401), then an
    //             attached one (#402); another team checked the same address
    //             with no app too (#601);
    //   twin_a / twin_b — two apps of one address, and a check of it with no
    //             app (#501): it is neither's;
    //   cat — a journey walked in #701, not listed in #702, retired between
    //             #702 and #703.
    await db.user.create({ data: { id: "u2", clerkUserId: "ck_u2", email: "load2@example.test" } });
    await db.app.createMany({
      data: [app("presave", "t"), app("cat", "t"), { ...app("twin_a", "t"), appSlug: "twin.test" }, { ...app("twin_b", "t"), ownerId: "u2", appSlug: "twin.test" }],
    });
    const loose = (id: string, n: number, slug: string, teamId: string) => ({ ...runRow(id, n, "none", teamId), appId: null, appSlug: slug, targetUrl: `https://${slug}` });
    await db.run.createMany({
      data: [
        loose("p1", 401, "presave.test", "t"), runRow("p2", 402, "presave", "t"), loose("tw1", 501, "twin.test", "t"), loose("o1", 601, "presave.test", "other"),
        runRow("c1", 701, "cat", "t"), runRow("c2", 702, "cat", "t"), runRow("c3", 703, "cat", "t"),
      ] as never,
    });
    await db.appJourney.createMany({
      data: [
        { id: "aj_old", appId: "cat", key: "old-flow", title: "Old flow", retiredAt: new Date(day(702).getTime() + 12 * 3_600_000) },
        { id: "aj_new", appId: "cat", key: "new-flow", title: "New flow" },
      ],
    });
    const oneJourney = (runId: string, appJourneyId?: string) => ({ id: `${runId}_j0`, runId, order: 0, title: "Journey 0", status: "ok", journeyKey: "journey-0", appJourneyId });
    await db.journey.createMany({
      data: [oneJourney("p1"), oneJourney("p2"), oneJourney("tw1"), oneJourney("o1"), oneJourney("c1", "aj_old"), oneJourney("c2", "aj_new"), oneJourney("c3", "aj_new")],
    });
    await db.step.createMany({
      data: ["p1", "p2", "tw1", "o1", "c1", "c2", "c3"].map((r) => ({ id: `${r}_j0_s0`, journeyId: `${r}_j0`, order: 0, label: "step 0", status: "ok" })),
    });
    await db.finding.createMany({
      data: [
        finding("f_p1", "p1", "Export button returns an empty file", "/export", 0, 0),
        finding("f_p2", "p2", "Export button returns an empty file", "/export", 0, 0),
        finding("f_tw", "tw1", "Twin page shows a blank screen", "/twin", 0, 0),
        finding("f_o1", "o1", "Export button returns an empty file", "/export", 0, 0),
        finding("f_c1", "c1", "Old flow shows a blank page", "/old", 0, 0),
      ],
    });

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
    check("another team's checks stay out: only the team's own apps are answered for",
      [...byApp.keys()].sort().join(",") === "big,cat,presave,small,twin_a,twin_b" && ![...byApp.values()].flat().some((i) => /Their sign-in/.test(i.title)),
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

    // A check opened inside the app says what it changed (CHE-371): the same
    // rule over the history cut at that check — what was true THEN.
    const lineAt = async (appId: string, n: number) => {
      const asOf = await recurrencesAsOf(db, "t", appId, n);
      return asOf ? deltaLine(checkDelta(asOf.recurrences, asOf.checks, n), false) : null;
    };
    const eq = (name: string, got: unknown, want: unknown) => check(name, got === want, JSON.stringify(got));
    eq("as of #100: the invoice problem is new", await lineAt("big", 100), "Since check #99: 1 new problem.");
    eq("as of #101: that check looked again and did not find it — gone, on evidence", await lineAt("big", 101), "Since check #100: nothing new, 1 gone.");
    eq("as of #102: it is not announced as gone a second time", await lineAt("big", 102), "Since check #101: nothing new.");
    eq("as of #149: the checkout problem is new — and #150 has not happened yet", await lineAt("big", 149), "Since check #148: 1 new problem.");
    eq("as of #150: it is still there", await lineAt("big", 150), "Since check #149: nothing new, 1 still there.");
    eq("as of #1: the first check", await lineAt("big", 1), "The first check of this app.");
    const at149 = await recurrencesAsOf(db, "t", "big", 149);
    check("history cut at #149 holds no check after it", at149 !== null && Math.max(...at149.checks) === 149 && !at149.recurrences.some((r) => r.sightings.some((s) => s.runNumber > 149)));
    eq("a number that is not one of this app's checks has no history to stand in", await lineAt("big", 201), null);
    eq("another team's app, asked for by id and by its own check's number: nothing", await lineAt("theirs", 301), null);

    // A check of the app's address that carries no app is the app's when it is
    // the team's only app of that address — appHealth's rule, which the app's
    // page and the check's page already list by.
    const presave = byApp.get("presave") ?? [];
    check("a check with no app joins the history of the team's only app of that address: seen 2×, #401 → #402",
      presave.length === 1 && presave[0].state === "recurring" && presave[0].firstSeenRunNumber === 401 && presave[0].lastSeenRunNumber === 402,
      JSON.stringify(presave.map((i) => [i.state, i.firstSeenRunNumber, i.lastSeenRunNumber])));
    eq("…so the attached check after it is not 'the first', and its problem is not 'new'", await lineAt("presave", 402), "Since check #401: nothing new, 1 still there.");
    eq("…and the check with no app has a history to stand in", await lineAt("presave", 401), "The first check of this app.");
    const presaveAt = await recurrencesAsOf(db, "t", "presave", 402);
    eq("…another team's check of the same address stays out of it", presaveAt?.checks.join(","), "401,402");
    check("an address two apps share: a check of it with no app is neither's",
      (byApp.get("twin_a") ?? []).length === 0 && (byApp.get("twin_b") ?? []).length === 0 && (await recurrencesAsOf(db, "t", "twin_a", 501)) === null);

    // The catalog as of the check asked about: a journey retired after it was
    // still the app's then, and a check that merely did not list it is not a
    // second look.
    eq("as of #702 the journey is not yet retired: its problem is not released by a check that did not list it", await lineAt("cat", 702), "Since check #701: nothing new.");
    eq("as of #703, the first check after the retirement, it is", await lineAt("cat", 703), "Since check #702: nothing new, 1 gone.");

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
