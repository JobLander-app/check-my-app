// CHE-353 verification: what each app of a team costs, and how its checks went.
//
// appHealth (src/lib/app-health.ts) is the data under Home, Health → Apps, the
// App page and Billing (epic CHE-348). A fixture team with known runs goes in;
// every number that comes out is asserted against the figure worked out by
// hand below:
//   1. spend per app and in total, per day, scheduled (watchId set) vs on
//      request, each with its count; a failed, canceled or in-flight run is a
//      check at $0;
//   2. the window: the last N UTC days, today included, from midnight to the
//      midnight after `now` — a run one second before it is out, one at its
//      first midnight is in, one at the midnight after `now` or stamped days
//      ahead is out, and a report as of a past date ends on that date;
//   3. the daily series: one point per day of the window, adding up to the
//      spend to the cent;
//   4. the verdict strip: the last 21 finished verdicts, oldest first, not
//      limited to the window; failed runs and unpublished extension reports are
//      not in it;
//   5. the latest check, with the same price explanation explainPrice gives
//      everywhere else;
//   6. a run with no appId belongs to the team's one app with its host, and to
//      no app when two of the team's apps share it; a PR preview counts in the
//      total only; another team's runs and anonymous runs count nowhere;
//   7. the run rate a month and "the plan covers it N times" — null for Free's
//      one-time credit, for an unlimited plan and when nothing was spent;
//   8. no cost, token or multiplier anywhere in the report (CLAUDE.md §10);
//   9. (CHE-382) dates as D1 holds them — text, in two spellings — at every
//      edge: the window's first day and the day after, a verdict given after
//      midnight, a finished run with no completedAt, two spellings on one day
//      in the strip's order and at its 21st place; in the in-memory client and
//      in a real local D1, which must return the same report;
//  10. (CHE-382) `days` from a query string: not a number → 30, else 1–90.
//
// The database is the in-memory stub from scripts/fixtures/mcp-db.ts, which
// evaluates every `where` — a query that forgot its team clause would pick up
// the other team's $9.99 here exactly as it would in D1 — and, for section 9,
// also a real D1 (scripts/fixtures/real-d1.ts: Miniflare, every migration, the
// generated Prisma client and @prisma/adapter-d1).
//
// On origin/main this fails at the import: src/lib/app-health.ts does not exist.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-app-health.ts

import "./fixtures/wasm-module-loader.mjs";
import { createStubDb } from "./fixtures/mcp-db";
import { realD1 } from "./fixtures/real-d1";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// What a check cost us, on every fixture run: a number distinctive enough that
// finding it in the report can only mean it leaked.
const COST = 0.4217;
const NOW = new Date("2026-10-01T15:00:00Z");
const at = (iso: string) => new Date(iso);
const plus10m = (d: Date) => new Date(d.getTime() + 10 * 60 * 1000);

type Seed = Record<string, unknown>;
function run(runNumber: number, createdAt: string, over: Seed = {}): Seed {
  const created = at(createdAt);
  const status = (over.status as string | undefined) ?? "completed";
  const live = !["completed", "partial", "failed", "canceled"].includes(status);
  return {
    id: `r${runNumber}`, publicId: `pub_${runNumber}`, runNumber,
    teamId: "t", appId: "a_shop", appSlug: "shop.test", targetKind: "website",
    status, verdict: "all_good", watchId: null,
    costUsd: COST, priceUsd: live ? null : 0.5, priceFromTopupUsd: 0, quickPagesOpened: null,
    createdAt: created, startedAt: created, completedAt: live ? null : plus10m(created),
    ...over,
  };
}

const W = "w_shop";
const RUNS: Seed[] = [
  // shop.test — a watched app checked on request too.
  run(101, "2026-09-01T23:59:59Z", { watchId: W, priceUsd: 5, verdict: "mostly_ok" }), // one second before the window
  run(102, "2026-09-02T00:00:00Z", { watchId: W, priceUsd: 0.5 }), // the window's first instant
  run(103, "2026-09-10T08:00:00Z", { watchId: W, priceUsd: 0.75, verdict: "needs_attention" }),
  run(104, "2026-09-10T20:00:00Z", { priceUsd: 1.2, status: "partial", verdict: "mostly_ok" }),
  run(105, "2026-09-20T06:00:00Z", { watchId: W, priceUsd: 0, status: "failed", verdict: null }),
  run(109, "2026-09-15T09:00:00Z", { priceUsd: 0, status: "canceled", verdict: null }),
  run(106, "2026-09-21T12:00:00Z", { appId: null, priceUsd: 0.33 }), // checked before the app was saved
  run(107, "2026-10-01T10:00:00Z", { watchId: W, priceUsd: 0.03, quickPagesOpened: 3 }), // a quick check
  run(108, "2026-10-01T14:00:00Z", { status: "walking", verdict: null }), // in flight
  // After the window: the midnight after NOW, and a row stamped days ahead.
  run(113, "2026-10-02T00:00:00Z", { watchId: W, priceUsd: 4 }),
  run(114, "2026-10-05T09:00:00Z", { priceUsd: 2, verdict: "broken" }),
  // A PR preview of the team's: the team paid, no app owns it.
  run(110, "2026-09-15T10:00:00Z", { appId: null, appSlug: "pr-7.preview.test", priceUsd: 0.4, ephemeral: true }),
  // Another team's app on the same host, and an anonymous check of it.
  run(111, "2026-09-15T11:00:00Z", { teamId: "t2", appId: "a_other", watchId: "w_other", priceUsd: 9.99 }),
  run(112, "2026-09-15T12:00:00Z", { teamId: null, appId: null, priceUsd: null }),
  // blog.test — 25 daily checks, all before the window.
  ...Array.from({ length: 25 }, (_, i) =>
    run(201 + i, `2026-07-${String(i + 1).padStart(2, "0")}T06:00:00Z`, {
      appId: "a_blog", appSlug: "blog.test", watchId: "w_blog", priceUsd: 0.6, verdict: i % 2 ? "broken" : "all_good",
    })),
  // The extension: two failed runs, an unpublished report, a published one.
  ...[
    [301, "21:00", { status: "failed", verdict: null, priceUsd: 0 }],
    [302, "21:30", { status: "failed", verdict: null, priceUsd: 0 }],
    [303, "22:00", { appId: null, status: "partial", verdict: null, priceUsd: 0.11 }],
    [304, "22:30", { verdict: "unverified", priceUsd: 0.11 }],
  ].map(([n, time, over]) =>
    run(n as number, `2026-09-14T${time}:00Z`, { appId: "a_ext", appSlug: "extension:abc", targetKind: "extension", ...(over as Seed) })),
  // Two members of t3 each saved dup.test; a run with no appId is neither's.
  run(401, "2026-09-20T10:00:00Z", { teamId: "t3", appId: null, appSlug: "dup.test", priceUsd: 1 }),
  run(402, "2026-09-20T11:00:00Z", { teamId: "t3", appId: "b1", appSlug: "dup.test", priceUsd: 0.5 }),
  // tw: a team read week by week (the UI's default) and by the month.
  run(806, "2026-09-10T09:00:00Z", { teamId: "tw", appId: "wk", appSlug: "week.test", watchId: "w_wk", priceUsd: 2 }),
  run(801, "2026-09-24T23:59:59Z", { teamId: "tw", appId: "wk", appSlug: "week.test", watchId: "w_wk", priceUsd: 0.9 }),
  run(802, "2026-09-25T00:00:00Z", { teamId: "tw", appId: "wk", appSlug: "week.test", watchId: "w_wk", priceUsd: 0.4 }),
  run(803, "2026-09-27T12:00:00Z", { teamId: "tw", appId: "wk", appSlug: "week.test", priceUsd: 1.1 }),
  run(804, "2026-09-29T08:00:00Z", { teamId: "tw", appId: "wk", appSlug: "week.test", watchId: "w_wk", priceUsd: 0, status: "failed", verdict: null }),
  run(805, "2026-10-01T09:00:00Z", { teamId: "tw", appId: "wk", appSlug: "week.test", watchId: "w_wk", priceUsd: 0.25 }),
  // tc: a check that started at 23:50 and gave its verdict at 00:10 the next day.
  run(901, "2026-09-09T10:00:00Z", { teamId: "tc", appId: "c1", appSlug: "late.test", priceUsd: 0.3 }),
  run(902, "2026-09-10T23:50:00Z", { teamId: "tc", appId: "c1", appSlug: "late.test", priceUsd: 0.5, verdict: "broken",
    completedAt: at("2026-09-11T00:10:00Z") }),
  // Free, enterprise.
  run(501, "2026-09-20T10:00:00Z", { teamId: "t_free", appId: "f1", appSlug: "free.test", priceUsd: 0.3 }),
  run(601, "2026-09-20T10:00:00Z", { teamId: "t_ent", appId: "e1", appSlug: "ent.test", priceUsd: 7 }),
];

const { db, table } = createStubDb({
  team: [
    { id: "t", plan: "business" }, { id: "t2", plan: "business" }, { id: "t3", plan: "starter" },
    { id: "t_free", plan: "free" }, { id: "t_ent", plan: "enterprise" }, { id: "t_empty", plan: "growth" },
    { id: "tw", plan: "business" }, { id: "tc", plan: "business" },
  ],
  app: [
    { id: "a_shop", teamId: "t", appSlug: "shop.test", targetKind: "website", createdAt: at("2026-06-01") },
    { id: "a_blog", teamId: "t", appSlug: "blog.test", targetKind: "website", createdAt: at("2026-06-02") },
    { id: "a_ext", teamId: "t", appSlug: "extension:abc", targetKind: "extension", createdAt: at("2026-06-03") },
    { id: "a_other", teamId: "t2", appSlug: "shop.test", targetKind: "website", createdAt: at("2026-06-01") },
    { id: "b1", teamId: "t3", appSlug: "dup.test", targetKind: "website", createdAt: at("2026-06-01") },
    { id: "b2", teamId: "t3", appSlug: "dup.test", targetKind: "website", createdAt: at("2026-06-02") },
    { id: "f1", teamId: "t_free", appSlug: "free.test", targetKind: "website", createdAt: at("2026-06-01") },
    { id: "e1", teamId: "t_ent", appSlug: "ent.test", targetKind: "website", createdAt: at("2026-06-01") },
    { id: "g1", teamId: "t_empty", appSlug: "new.test", targetKind: "website", createdAt: at("2026-06-01") },
    { id: "wk", teamId: "tw", appSlug: "week.test", targetKind: "website", createdAt: at("2026-06-01") },
    { id: "c1", teamId: "tc", appSlug: "late.test", targetKind: "website", createdAt: at("2026-06-01") },
  ],
  run: RUNS,
});

async function main() {
  const { appHealth } = await import("@/lib/app-health");
  const { explainPrice } = await import("@/lib/check-price");

  const report = await appHealth(db, "t", { now: NOW });
  const app = (slug: string, r = report) => r.apps.find((a) => a.appSlug === slug)!;
  const shop = app("shop.test");
  const blog = app("blog.test");
  const ext = app("extension:abc");

  // CHE-358: a page about one app asks for that app alone. Its entry is the
  // same, the team's totals are still the team's, and no other app is built.
  const onlyShop = await appHealth(db, "t", { now: NOW, only: shop.appId });
  check("only: one app is built, identical to its entry in the full report",
    onlyShop.apps.length === 1 && JSON.stringify(onlyShop.apps[0]) === JSON.stringify(shop), `${onlyShop.apps.length} app(s)`);
  check("only: the team's totals do not change",
    onlyShop.totalSpendUsd === report.totalSpendUsd && onlyShop.monthlyRunRateUsd === report.monthlyRunRateUsd && onlyShop.planCoversTimes === report.planCoversTimes);
  check("only: an id that is not the team's builds nothing", (await appHealth(db, "t", { now: NOW, only: "not-an-app" })).apps.length === 0);

  // ─── 1. Spend, per day, scheduled vs on request ──────────────────────────
  check("the window is 30 days by default", report.windowDays === 30);
  check("every app of the team is listed, biggest spend first; no other team's app",
    same(report.apps.map((a) => [a.appId, a.appSlug, a.targetKind]),
      [["a_shop", "shop.test", "website"], ["a_ext", "extension:abc", "extension"], ["a_blog", "blog.test", "website"]]),
    JSON.stringify(report.apps.map((a) => a.appSlug)));
  // .50 + .75 + 1.20 + 0 (failed) + 0 (canceled) + .33 (no appId) + .03 + 0 (in flight)
  check("shop.test: $2.81 over 8 checks", shop.spendUsd === 2.81 && shop.checks === 8, JSON.stringify([shop.spendUsd, shop.checks]));
  check("shop.test: scheduled 4 checks / $1.28 (.50 + .75 + failed 0 + .03)",
    same(shop.scheduled, { count: 4, usd: 1.28 }), JSON.stringify(shop.scheduled));
  check("shop.test: on request 4 checks / $1.53 (1.20 + .33 + canceled 0 + in flight 0)",
    same(shop.onRequest, { count: 4, usd: 1.53 }), JSON.stringify(shop.onRequest));
  check("shop.test: scheduled + on request = checks and spend",
    shop.scheduled.count + shop.onRequest.count === shop.checks &&
      Math.round((shop.scheduled.usd + shop.onRequest.usd) * 100) === Math.round(shop.spendUsd * 100));
  check("shop.test: $0.09 a day ($2.81 / 30)", shop.perDayUsd === 0.09, String(shop.perDayUsd));
  check("extension: 2 failed at $0, an unpublished report and a published one at $0.11 → $0.22 over 4 checks, all on request",
    ext.spendUsd === 0.22 && ext.checks === 4 && same(ext.scheduled, { count: 0, usd: 0 }) && same(ext.onRequest, { count: 4, usd: 0.22 }),
    JSON.stringify([ext.spendUsd, ext.checks, ext.scheduled, ext.onRequest]));
  check("blog.test: nothing in the window → $0, 0 checks, $0 a day",
    blog.spendUsd === 0 && blog.checks === 0 && blog.perDayUsd === 0 && blog.scheduled.count === 0 && blog.onRequest.count === 0);
  check("team: $3.43 in total — the apps' $3.03 plus the PR preview's $0.40", report.totalSpendUsd === 3.43, String(report.totalSpendUsd));
  check("team: $0.11 a day ($3.43 / 30)", report.perDayUsd === 0.11, String(report.perDayUsd));
  // CHE-355: the checks the total was spent on — the apps' own, plus the PR
  // preview that belongs to no app. A page that counted only the apps' checks
  // could show money spent on "no checks".
  const inApps = report.apps.reduce((n, a) => n + a.checks, 0);
  check("team: the total counts every check of the window — the apps' and the PR preview's", report.totalChecks === inApps + 1, `${report.totalChecks} vs ${inApps} in apps`);

  // ─── 2. The window's edges ───────────────────────────────────────────────
  const daily = shop.daily;
  check("the run one second before midnight UTC of day 1 is out, the one at midnight is in",
    daily[0].date === "2026-09-02" && daily[0].usd === 0.5);
  // (Dates in the old "YYYY-MM-DD HH:MM:SS" spelling at the window's edges:
  // section 9, in the in-memory client and in a real D1.)
  check("runs after NOW's day — at the next midnight, or stamped days ahead — are in no number, strip or latest",
    report.totalSpendUsd === 3.43 && shop.checks === 8 && !shop.verdicts.some((v) => v.runNumber >= 113) && shop.latest?.runNumber === 107);
  {
    // A report as of a past date: the window ends at the midnight after it.
    const past = await appHealth(db, "t", { now: at("2026-09-10T12:00:00Z") });
    const s = app("shop.test", past);
    check("as of 2026-09-10 12:00: shop.test is #101–#104 — $7.45, 4 checks, 3 scheduled / $6.25 — and nothing later",
      s.spendUsd === 7.45 && s.checks === 4 && same(s.scheduled, { count: 3, usd: 6.25 }) && same(s.onRequest, { count: 1, usd: 1.2 }) &&
        past.totalSpendUsd === 7.45,
      JSON.stringify([s.spendUsd, s.checks, s.scheduled, s.onRequest, past.totalSpendUsd]));
    check("as of 2026-09-10: 30 points 2026-08-12 … 2026-09-10, adding up to the spend",
      s.daily.length === 30 && s.daily[0].date === "2026-08-12" && s.daily[29].date === "2026-09-10" &&
        past.apps.every((a) => Math.round(a.daily.reduce((x, d) => x + d.usd * 100, 0)) === Math.round(a.spendUsd * 100)));
    check("as of 2026-09-10: the strip ends at #104 and the latest check is #104",
      s.verdicts.at(-1)?.runNumber === 104 && s.latest?.runNumber === 104, JSON.stringify([s.verdicts.map((v) => v.runNumber), s.latest?.runNumber]));
  }
  {
    // Spend is placed by when a check started (as the balance places it); a
    // verdict by when it was given.
    const late = (await appHealth(db, "tc", { now: at("2026-09-10T12:00:00Z") })).apps[0];
    check("as of 2026-09-10: a check started 23:50 and finished 00:10 the next day is spent that day, but has no verdict yet — not in the strip, not the latest",
      late.spendUsd === 0.8 && late.checks === 2 && same(late.verdicts.map((v) => v.runNumber), [901]) && late.latest?.runNumber === 901,
      JSON.stringify([late.spendUsd, late.checks, late.verdicts.map((v) => v.runNumber), late.latest?.runNumber]));
    const next = (await appHealth(db, "tc", { now: at("2026-09-11T12:00:00Z") })).apps[0];
    check("as of 2026-09-11: its verdict is there, and it is the latest check",
      same(next.verdicts.map((v) => v.runNumber), [901, 902]) && next.latest?.runNumber === 902,
      JSON.stringify([next.verdicts.map((v) => v.runNumber), next.latest?.runNumber]));
  }
  {
    const week = await appHealth(db, "t", { now: NOW, days: 7 });
    const s = app("shop.test", week);
    check("days: 7 → from 2026-09-25: shop.test is the quick check and the one in flight",
      week.windowDays === 7 && s.spendUsd === 0.03 && s.checks === 2 && same(s.scheduled, { count: 1, usd: 0.03 }) && same(s.onRequest, { count: 1, usd: 0 }),
      JSON.stringify([s.spendUsd, s.checks, s.scheduled, s.onRequest]));
    check("days: 7 → 7 daily points, 2026-09-25 … 2026-10-01", s.daily.length === 7 && s.daily[0].date === "2026-09-25" && s.daily[6].date === "2026-10-01");
    check("days: 7 → $0.03 in total, $0.00 a day, $0.13 a month (0.03 / 7 × 30)",
      week.totalSpendUsd === 0.03 && week.perDayUsd === 0 && week.monthlyRunRateUsd === 0.13,
      JSON.stringify([week.totalSpendUsd, week.perDayUsd, week.monthlyRunRateUsd]));
    check("days: 7 → Business's $499 covers that 3838.5 times", week.planCoversTimes === 3838.5, String(week.planCoversTimes));
    check("days: 7 → the verdict strip and latest check do not depend on the window",
      same(s.verdicts, shop.verdicts) && s.latest?.runNumber === shop.latest?.runNumber);
  }
  {
    // `days` is a parameter: one team read over 7 days and over 30, every
    // number; the money line stays monthly whatever the window.
    const [week, month] = await Promise.all([7, 30].map((days) => appHealth(db, "tw", { now: NOW, days })));
    const w = week.apps[0];
    const m = month.apps[0];
    check("7 days (from 2026-09-25 00:00): $1.75 over 4 checks — #801 one second earlier is out, the failed #804 is a $0 check",
      w.spendUsd === 1.75 && w.checks === 4 && same(w.scheduled, { count: 3, usd: 0.65 }) && same(w.onRequest, { count: 1, usd: 1.1 }),
      JSON.stringify([w.spendUsd, w.checks, w.scheduled, w.onRequest]));
    check("7 days: $0.25 a day for the app and the team ($1.75 / 7)", w.perDayUsd === 0.25 && week.perDayUsd === 0.25,
      JSON.stringify([w.perDayUsd, week.perDayUsd]));
    check("7 days: 7 points 2026-09-25 … 2026-10-01 — 09-25 $0.40, 09-27 $1.10, 10-01 $0.25 — adding up to the spend",
      w.daily.length === 7 && w.daily[0].date === "2026-09-25" && w.daily[6].date === "2026-10-01" &&
        same(w.daily.filter((d) => d.usd).map((d) => [d.date, d.usd]), [["2026-09-25", 0.4], ["2026-09-27", 1.1], ["2026-10-01", 0.25]]) &&
        Math.round(w.daily.reduce((x, d) => x + d.usd * 100, 0)) === 175,
      JSON.stringify(w.daily));
    check("7 days: still a month in money — $7.50 a month (1.75 / 7 × 30), Business's $499 covers it 66.5 times",
      week.totalSpendUsd === 1.75 && week.monthlyRunRateUsd === 7.5 && week.planCoversTimes === 66.5,
      JSON.stringify([week.totalSpendUsd, week.monthlyRunRateUsd, week.planCoversTimes]));
    check("30 days, same team: $4.65 over 6 checks, 5 scheduled / $3.55, $0.16 a day, 30 points adding up",
      m.spendUsd === 4.65 && m.checks === 6 && same(m.scheduled, { count: 5, usd: 3.55 }) && same(m.onRequest, { count: 1, usd: 1.1 }) &&
        m.perDayUsd === 0.16 && m.daily.length === 30 && Math.round(m.daily.reduce((x, d) => x + d.usd * 100, 0)) === 465,
      JSON.stringify([m.spendUsd, m.checks, m.scheduled, m.perDayUsd, m.daily.length]));
    check("30 days: $4.65 a month, covered 107.3 times", month.monthlyRunRateUsd === 4.65 && month.planCoversTimes === 107.3,
      JSON.stringify([month.monthlyRunRateUsd, month.planCoversTimes]));
    check("7 and 30 days: the same strip (#806 #801 #802 #803 #805) and the same latest check (#805)",
      same(w.verdicts.map((v) => v.runNumber), [806, 801, 802, 803, 805]) && same(w.verdicts, m.verdicts) &&
        w.latest?.runNumber === 805 && same(w.latest, m.latest),
      JSON.stringify(w.verdicts.map((v) => v.runNumber)));
  }

  // ─── 3. The daily series ─────────────────────────────────────────────────
  check("30 daily points, 2026-09-02 … 2026-10-01, in order",
    daily.length === 30 && daily[29].date === "2026-10-01" && daily.every((d, i) => i === 0 || d.date > daily[i - 1].date));
  const nonzero = Object.fromEntries(daily.filter((d) => d.usd !== 0).map((d) => [d.date, d.usd]));
  check("shop.test by day: 09-02 $0.50, 09-10 $1.95, 09-21 $0.33, 10-01 $0.03",
    same(nonzero, { "2026-09-02": 0.5, "2026-09-10": 1.95, "2026-09-21": 0.33, "2026-10-01": 0.03 }), JSON.stringify(nonzero));
  for (const a of report.apps) {
    check(`${a.appSlug}: the series adds up to the spend to the cent`,
      Math.round(a.daily.reduce((s, d) => s + d.usd * 100, 0)) === Math.round(a.spendUsd * 100));
  }
  check("extension by day: 09-14 $0.22", ext.daily.find((d) => d.date === "2026-09-14")?.usd === 0.22);

  // ─── 4. The verdict strip ────────────────────────────────────────────────
  check("shop.test strip: every finished verdict oldest first, the one before the window included, no failed/canceled/in-flight",
    same(shop.verdicts, [
      { runNumber: 101, verdict: "mostly_ok" }, { runNumber: 102, verdict: "all_good" },
      { runNumber: 103, verdict: "needs_attention" }, { runNumber: 104, verdict: "mostly_ok" },
      { runNumber: 106, verdict: "all_good" }, { runNumber: 107, verdict: "all_good" },
    ]), JSON.stringify(shop.verdicts));
  check("blog.test strip: the last 21 of 25, oldest first (#205 … #225)",
    blog.verdicts.length === 21 && blog.verdicts[0].runNumber === 205 && blog.verdicts[20].runNumber === 225 &&
      blog.verdicts.every((v, i) => v.verdict === ((i + 4) % 2 ? "broken" : "all_good")),
    JSON.stringify(blog.verdicts.map((v) => v.runNumber)));
  check("extension strip: only the published report", same(ext.verdicts, [{ runNumber: 304, verdict: "unverified" }]), JSON.stringify(ext.verdicts));

  // ─── 5. The latest check ─────────────────────────────────────────────────
  const rowOf = (n: number) => table("run").find((r) => r.runNumber === n) as Parameters<typeof explainPrice>[1];
  const expected = async (n: number) => explainPrice(db, rowOf(n), "business");
  check("shop.test latest: #107, the quick check — not the run in flight",
    shop.latest?.runNumber === 107 && shop.latest.publicId === "pub_107" && shop.latest.verdict === "all_good" &&
      shop.latest.status === "completed" && shop.latest.priceUsd === 0.03 &&
      shop.latest.completedAt?.getTime() === at("2026-10-01T10:10:00Z").getTime(),
    JSON.stringify({ ...shop.latest, price: undefined }));
  check("shop.test latest: explainPrice's explanation, word for word",
    same(shop.latest?.price, await expected(107)) && shop.latest?.price.work === "Quick check — nothing had changed, 3 pages opened",
    JSON.stringify(shop.latest?.price));
  check("blog.test latest: #225 from before the window, with its explanation",
    blog.latest?.runNumber === 225 && blog.latest.priceUsd === 0.6 && same(blog.latest.price, await expected(225)));
  check("extension latest: #304, the published report", ext.latest?.runNumber === 304 && same(ext.latest.price, await expected(304)));
  {
    // The workflow writes the verdict one step before the price. In between,
    // the latest check is the newest one that has a price.
    const r = rowOf(107) as unknown as Record<string, unknown>;
    r.priceUsd = null;
    const between = app("shop.test", await appHealth(db, "t", { now: NOW }));
    r.priceUsd = 0.03;
    check("a check with a verdict but no price yet is in the strip, and latest is the newest priced one",
      between.latest?.runNumber === 106 && between.verdicts.at(-1)?.runNumber === 107, JSON.stringify([between.latest?.runNumber, between.verdicts.at(-1)]));
  }

  // ─── 6. Whose run is it ──────────────────────────────────────────────────
  {
    const other = await appHealth(db, "t2", { now: NOW });
    check("t2 sees its own shop.test: $9.99, 1 scheduled check — and none of t's",
      other.apps.length === 1 && other.apps[0].spendUsd === 9.99 && same(other.apps[0].scheduled, { count: 1, usd: 9.99 }) &&
        other.totalSpendUsd === 9.99 && same(other.apps[0].verdicts, [{ runNumber: 111, verdict: "all_good" }]),
      JSON.stringify(other.apps.map((a) => [a.appId, a.spendUsd, a.checks, a.verdicts.length])));
    const dup = await appHealth(db, "t3", { now: NOW });
    const b1 = dup.apps.find((a) => a.appId === "b1")!;
    const b2 = dup.apps.find((a) => a.appId === "b2")!;
    check("two apps on one host: a run with no appId belongs to neither, but the team paid for it",
      b1.spendUsd === 0.5 && b1.checks === 1 && b2.spendUsd === 0 && b2.checks === 0 && dup.totalSpendUsd === 1.5 &&
        same(b1.verdicts, [{ runNumber: 402, verdict: "all_good" }]) && b2.verdicts.length === 0,
      JSON.stringify(dup.apps.map((a) => [a.appId, a.spendUsd, a.checks, a.verdicts.length])));
  }

  // ─── 7. Run rate, and what the plan covers ───────────────────────────────
  check("team: $3.43 a month at this rate (3.43 / 30 × 30)", report.monthlyRunRateUsd === 3.43, String(report.monthlyRunRateUsd));
  check("team: Business's $499 covers that 145.5 times", report.planCoversTimes === 145.5, String(report.planCoversTimes));
  {
    const free = await appHealth(db, "t_free", { now: NOW });
    check("Free: $0.30 a month, and no 'covers it N times' — its credit is once, not monthly",
      free.monthlyRunRateUsd === 0.3 && free.planCoversTimes === null, JSON.stringify([free.monthlyRunRateUsd, free.planCoversTimes]));
    const ent = await appHealth(db, "t_ent", { now: NOW });
    check("Enterprise: $7.00 a month, unlimited credit → null", ent.monthlyRunRateUsd === 7 && ent.planCoversTimes === null);
    const starter = await appHealth(db, "t3", { now: NOW });
    check("Starter: $29 over $1.50 a month → 19.3 times", starter.planCoversTimes === 19.3, String(starter.planCoversTimes));
    const empty = await appHealth(db, "t_empty", { now: NOW });
    const g = empty.apps[0];
    check("a team that spent nothing: $0 everywhere, covers null; its app has no latest, no strip, 30 zero days",
      empty.totalSpendUsd === 0 && empty.monthlyRunRateUsd === 0 && empty.planCoversTimes === null &&
        g.latest === null && g.verdicts.length === 0 && g.daily.length === 30 && g.daily.every((d) => d.usd === 0),
      JSON.stringify({ ...empty, apps: empty.apps.map((a) => ({ ...a, daily: a.daily.length })) }));
  }

  // ─── 8. Prices only ──────────────────────────────────────────────────────
  {
    const json = JSON.stringify(report);
    check("no cost, token or multiplier key in the report", !/cost|token|multipl|markup/i.test(json), json.match(/"[^"]*(cost|token|multipl|markup)[^"]*"/i)?.[0] ?? "");
    check("no cost value in the report", !json.includes(String(COST)));
  }

  // ─── 9. Dates as D1 holds them (CHE-382) ─────────────────────────────────
  // D1 stores a DateTime as TEXT and compares and orders it as text. Prisma
  // writes "2026-09-02T21:23:10.000+00:00"; a row written by hand (a SQL
  // UPDATE with datetime('now')) holds "2026-09-02 21:23:10", and " " sorts
  // before "T". Production has both: createdAt on runs up to 2026-09-03,
  // completedAt on #191 and #203 (2026-09-14, 2026-09-16), which means a hand
  // fix can write one again any day. One fixture team, read through the
  // in-memory client (which now compares and orders dates as D1 does) and
  // through a real local D1; the two must say the same, and both must be right.
  {
    const TD = "td";
    const legacyRun = (n: number, appId: string, createdAt: string, over: Seed = {}) =>
      run(n, createdAt.replace(" ", "T") + (createdAt.includes(" ") ? "Z" : ""), {
        teamId: TD, appId, appSlug: `${appId}.test`, targetUrl: `https://${appId}.test`, priceUsd: 0.1, ...over,
        ...(createdAt.includes(" ") ? { createdAt } : {}),
      });
    const day = (d: number) => String(d).padStart(2, "0");
    const DATES_RUNS: Seed[] = [
      // edges: the window's first day and the day after NOW, in the old spelling;
      // twenty July checks so the strip is full and a run that slipped in would
      // push one out.
      ...Array.from({ length: 20 }, (_, i) => legacyRun(811 + i, "edges", `2026-07-${day(i + 1)}T06:00:00Z`)),
      legacyRun(801, "edges", "2026-09-02 21:23:10", { priceUsd: 1.61, completedAt: at("2026-09-02T21:33:10Z") }),
      legacyRun(803, "edges", "2026-09-03 08:00:00", { priceUsd: 0.2, verdict: "broken", completedAt: at("2026-09-03T08:10:00Z") }),
      legacyRun(802, "edges", "2026-10-02 05:00:00", { priceUsd: 0.7, verdict: "broken", completedAt: at("2026-10-02T05:10:00Z") }),
      // late: a verdict given at 00:10 the next day, its completedAt in the old
      // spelling (as #191 and #203 hold theirs).
      legacyRun(806, "late", "2026-09-19T10:00:00Z", { priceUsd: 0.3 }),
      legacyRun(804, "late", "2026-09-20T23:50:00Z", { priceUsd: 0.4, verdict: "mostly_ok", completedAt: "2026-09-21 00:10:00" }),
      // nullc: a finished run with no completedAt — D1 leaves it out of any
      // completedAt range; JS `null <= date` would let it in.
      legacyRun(807, "nullc", "2026-09-06T10:00:00Z", { priceUsd: 0.3 }),
      legacyRun(805, "nullc", "2026-09-07T10:00:00Z", { priceUsd: 0.3, verdict: "broken", completedAt: null }),
      // mixfirst: two verdicts on one day in two spellings; the later one is in
      // the old spelling, so text puts it first in ascending order — last in
      // the strip only if the module orders by time.
      legacyRun(871, "mixfirst", "2026-09-21T21:50:00Z", { completedAt: at("2026-09-21T22:00:00Z") }),
      legacyRun(872, "mixfirst", "2026-09-21T23:20:00Z", { verdict: "broken", completedAt: "2026-09-21 23:30:00" }),
      // mixlast: 20 checks Sep 1–20, and two on Aug 31 — 08:00 new spelling,
      // 20:00 old. The 21st place belongs to the 20:00 one.
      ...Array.from({ length: 20 }, (_, i) => legacyRun(881 + i, "mixlast", `2026-09-${day(i + 1)}T12:00:00Z`)),
      legacyRun(879, "mixlast", "2026-08-31T07:50:00Z", { completedAt: at("2026-08-31T08:00:00Z") }),
      legacyRun(880, "mixlast", "2026-08-31T19:50:00Z", { verdict: "broken", completedAt: "2026-08-31 20:00:00" }),
    ];
    const DATES_APPS = ["edges", "late", "nullc", "mixfirst", "mixlast"].map((id) =>
      ({ id, teamId: TD, ownerId: "ud", appSlug: `${id}.test`, targetUrl: `https://${id}.test`, targetKind: "website", createdAt: at("2026-06-01") }));

    const fake = createStubDb({ team: [{ id: TD, plan: "business", name: "Dates" }], app: DATES_APPS, run: DATES_RUNS }).db;
    const real = await realD1();
    try {
      await real.db.user.create({ data: { id: "ud", clerkUserId: "ck_ud", email: "dates@example.test" } });
      await real.db.team.create({ data: { id: TD, name: "Dates", plan: "business" } });
      for (const a of DATES_APPS) await real.db.app.create({ data: a });
      // Prisma writes every row in its own spelling; the old-spelling columns
      // are then rewritten by hand, the way production got them.
      const asDate = (v: unknown) => (typeof v === "string" ? new Date(`${v.replace(" ", "T")}Z`) : v);
      const COLUMNS = ["id", "publicId", "runNumber", "teamId", "appId", "appSlug", "targetUrl", "targetKind", "status", "verdict",
        "priceUsd", "priceFromTopupUsd", "quickPagesOpened", "costUsd", "createdAt", "startedAt", "completedAt"];
      for (const r of DATES_RUNS) {
        await real.db.run.create({ data: Object.fromEntries(COLUMNS.map((k) => [k, /At$/.test(k) ? asDate(r[k]) : r[k]])) as never });
        for (const col of ["createdAt", "completedAt"]) {
          if (typeof r[col] === "string") await real.exec(`UPDATE Run SET "${col}" = ? WHERE id = ?`, r[col], r.id);
        }
      }
      const stored = (await real.exec(`SELECT COUNT(*) n FROM Run WHERE createdAt NOT LIKE '%T%' OR completedAt NOT LIKE '%T%'`)) as unknown as { results: { n: number }[] };
      check("real D1: the fixture holds old-spelling dates (6 rows), as production does", stored.results[0].n === 6, JSON.stringify(stored.results));

      for (const [name, client] of [["in-memory", fake], ["real D1", real.db as unknown as typeof db]] as const) {
        const strip = (r: Awaited<ReturnType<typeof appHealth>>, id: string) => r.apps.find((a) => a.appId === id)!;
        const nums = (a: { verdicts: { runNumber: number }[] }) => a.verdicts.map((v) => v.runNumber);
        const seq = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
        const now = await appHealth(client, TD, { now: NOW });
        const e = strip(now, "edges");
        check(`${name}: an old-spelling run on the window's first day is counted, one on the day after is not`,
          e.spendUsd === 1.81 && e.checks === 2 && e.daily[0].usd === 1.61, JSON.stringify([e.spendUsd, e.checks, e.daily[0]]));
        check(`${name}: …and the one on the day after is neither the latest check nor in the strip, nor takes a place of the 21`,
          e.latest?.runNumber === 803 && same(nums(e), [...seq(812, 830), 801, 803]), JSON.stringify([e.latest?.runNumber, nums(e)]));
        const asOf = await appHealth(client, TD, { now: at("2026-09-02T12:00:00Z") });
        const ea = strip(asOf, "edges");
        check(`${name}: as of 2026-09-02, an old-spelling finished run on 09-03 is in no number, strip or latest`,
          ea.spendUsd === 1.61 && ea.checks === 1 && ea.latest?.runNumber === 801 && same(nums(ea), [...seq(811, 830), 801]),
          JSON.stringify([ea.spendUsd, ea.checks, ea.latest?.runNumber, nums(ea)]));
        const late = strip(await appHealth(client, TD, { now: at("2026-09-20T12:00:00Z") }), "late");
        check(`${name}: as of 2026-09-20, a verdict given at "2026-09-21 00:10:00" is not there yet (its spend is)`,
          late.spendUsd === 0.7 && same(nums(late), [806]) && late.latest?.runNumber === 806, JSON.stringify([late.spendUsd, nums(late), late.latest?.runNumber]));
        check(`${name}: as of NOW it is, and it is the latest`, same(nums(strip(now, "late")), [806, 804]) && strip(now, "late").latest?.runNumber === 804);
        const nc = strip(now, "nullc");
        check(`${name}: a finished run with no completedAt is not in the strip`, same(nums(nc), [807]) && nc.latest?.runNumber === 807, JSON.stringify(nums(nc)));
        const mf = strip(now, "mixfirst");
        check(`${name}: two verdicts on one day in two spellings — the later one (23:30, old spelling) is the latest and last in the strip`,
          same(nums(mf), [871, 872]) && mf.latest?.runNumber === 872, JSON.stringify([nums(mf), mf.latest?.runNumber]));
        const ml = strip(now, "mixlast");
        check(`${name}: the 21st place goes to the later of two Aug 31 verdicts (20:00, old spelling), not the earlier`,
          same(nums(ml), [880, ...seq(881, 900)]), JSON.stringify(nums(ml)));
      }
      const [a, b] = await Promise.all([appHealth(fake, TD, { now: NOW }), appHealth(real.db as unknown as typeof db, TD, { now: NOW })]);
      const diff = a.apps.filter((x) => !same(x, b.apps.find((y) => y.appId === x.appId))).map((x) => x.appSlug);
      check("the in-memory client and the real D1 return the same report", same(a, b), same(a, b) ? "" : `differs on ${diff.join(", ") || "the team totals"}`);
    } finally {
      await real.dispose();
    }
  }
  {
    // The in-memory client's own NULL rule, read directly: no comparison with
    // NULL is true, as in SQL.
    const { db: nul } = createStubDb({ run: [{ id: "n", completedAt: null }, { id: "d", completedAt: at("2026-09-01T00:00:00Z") }] });
    const bound = at("2026-10-01T00:00:00Z");
    const ids = async (where: Record<string, unknown>) =>
      ((await nul.run.findMany({ where, select: { id: true } } as never)) as unknown as { id: string }[]).map((r) => r.id);
    check("in-memory client: NULL passes no lte / gte / lt / gt, as in D1",
      same(await ids({ completedAt: { lte: bound } }), ["d"]) && same(await ids({ completedAt: { gte: at("2026-01-01T00:00:00Z") } }), ["d"]) &&
        same(await ids({ completedAt: { lt: bound } }), ["d"]) && same(await ids({ completedAt: { gt: at("2026-01-01T00:00:00Z") } }), ["d"]));
  }

  // ─── 10. `days` from a query string ──────────────────────────────────────
  // UI callers pass ?days=…: anything not a number is the default 30; a number
  // is a whole day count from 1 to 90.
  for (const [given, want] of [[NaN, 30], [Infinity, 30], [0, 1], [-5, 1], [7.9, 7], [365, 90], [90, 90]] as const) {
    const r = await appHealth(db, "t", { now: NOW, days: given }).catch((err: Error) => err);
    if (r instanceof Error) {
      check(`days: ${given} → a ${want}-day window with ${want} valid daily points`, false, `throws ${r.name}: ${r.message}`);
      continue;
    }
    check(`days: ${given} → a ${want}-day window with ${want} valid daily points`,
      r.windowDays === want && r.apps.every((a) => a.daily.length === want && a.daily.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date))) &&
        Number.isFinite(r.perDayUsd) && Number.isFinite(r.monthlyRunRateUsd),
      JSON.stringify([r.windowDays, r.apps[0]?.daily.length, r.apps[0]?.daily[0]?.date, r.perDayUsd]));
  }

  finish();
}

function finish() {
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-app-health: crashed:", err);
  process.exit(1);
});
