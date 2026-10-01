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
//   8. no cost, token or multiplier anywhere in the report (CLAUDE.md §10).
//
// The database is the in-memory stub from scripts/fixtures/mcp-db.ts, which
// evaluates every `where` — a query that forgot its team clause would pick up
// the other team's $9.99 here exactly as it would in D1.
//
// On origin/main this fails at the import: src/lib/app-health.ts does not exist.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-app-health.ts

import { createStubDb } from "./fixtures/mcp-db";

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
  // Free, enterprise.
  run(501, "2026-09-20T10:00:00Z", { teamId: "t_free", appId: "f1", appSlug: "free.test", priceUsd: 0.3 }),
  run(601, "2026-09-20T10:00:00Z", { teamId: "t_ent", appId: "e1", appSlug: "ent.test", priceUsd: 7 }),
];

const { db, table } = createStubDb({
  team: [
    { id: "t", plan: "business" }, { id: "t2", plan: "business" }, { id: "t3", plan: "starter" },
    { id: "t_free", plan: "free" }, { id: "t_ent", plan: "enterprise" }, { id: "t_empty", plan: "growth" },
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

  // ─── 2. The window's edges ───────────────────────────────────────────────
  const daily = shop.daily;
  check("the run one second before midnight UTC of day 1 is out, the one at midnight is in",
    daily[0].date === "2026-09-02" && daily[0].usd === 0.5);
  {
    // D1 compares DateTime as TEXT. Prisma's adapter sends a Date as
    // "2026-09-02T00:00:00.000+00:00"; rows written before 2026-09-04 hold
    // "2026-09-02 21:23:10", and " " sorts before "T". This client compares
    // createdAt the way D1 does, so a run in the old spelling on the window's
    // first day is counted only if the module does not trust the text edge.
    const legacy = createStubDb({
      team: [{ id: "tl", plan: "business" }],
      app: [{ id: "l1", teamId: "tl", appSlug: "legacy.test", targetKind: "website", createdAt: at("2026-06-01") }],
      run: [
        run(701, "2026-09-02T21:23:10Z", { teamId: "tl", appId: "l1", appSlug: "legacy.test", priceUsd: 1.61 }),
        run(702, "2026-10-02T05:00:00Z", { teamId: "tl", appId: "l1", appSlug: "legacy.test", priceUsd: 0.7 }),
      ],
    });
    const STORED: Record<string, string> = { r701: "2026-09-02 21:23:10", r702: "2026-10-02 05:00:00" };
    const asD1 = (d: Date) => d.toISOString().replace("Z", "+00:00");
    const inner = legacy.db as unknown as Record<string, Record<string, (a: Record<string, unknown>) => Promise<unknown>>>;
    const d1Db = new Proxy({}, {
      get: (_t, model: string) => model !== "run" ? inner[model] : {
        ...inner.run,
        findMany: async (args: Record<string, unknown>) => {
          const where = (args.where ?? {}) as Record<string, unknown>;
          const { gte, lt } = (where.createdAt ?? {}) as { gte?: Date; lt?: Date };
          if (!gte && !lt) return inner.run.findMany(args);
          const text = (r: Record<string, unknown>) => STORED[r.id as string] ?? asD1(r.createdAt as Date);
          const ids = legacy.table("run")
            .filter((r) => (!gte || text(r) >= asD1(gte)) && (!lt || text(r) < asD1(lt)))
            .map((r) => r.id);
          return inner.run.findMany({ ...args, where: { ...where, createdAt: undefined, id: { in: ids } } });
        },
      },
    }) as typeof db;
    const l = await appHealth(d1Db, "tl", { now: NOW });
    check("a run stored in the old \"YYYY-MM-DD HH:MM:SS\" spelling on the window's first day is counted, one on the day after it is not",
      l.totalSpendUsd === 1.61 && l.apps[0].checks === 1 && l.apps[0].daily[0].usd === 1.61,
      JSON.stringify([l.totalSpendUsd, l.apps[0].checks]));
  }
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
