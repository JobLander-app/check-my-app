// What each app of a team costs, and how its checks have gone (CHE-353).
//
// The numbers Home, Health → Apps, the App page and Billing are built from
// (epic CHE-348): per app, what it cost over a rolling window — in total, a
// day, scheduled vs on request — how many checks that was, a daily series for
// the sparkline, the last 21 verdicts for the strip, and the latest check with
// its price and the reason for it (explainPrice, so "click the price, see why"
// is the same text everywhere). For the team: the total, the run rate a month,
// and how many times the plan's monthly credit covers it.
//
// A rolling window, not "this month": on October 1 the old block read "$0.89
// spent this month", which told the owner nothing (2026-10-01). Calendar-month
// spending stays where the balance is (teamBalance in src/lib/plans.ts).
//
// The rules, each one a decision rather than an accident:
//
//   - The window is the last `days` UTC days, today included, from midnight
//     UTC to the midnight after `now` — so the daily series has exactly `days`
//     points and adds up to the spend to the cent. Runs are placed by
//     createdAt, as the balance places them (plans.ts windowWhere).
//   - A check is every run of the app started in the window, whatever became of
//     it. A failed run counts as a check at $0 (our failure is free, rule 4 —
//     its price is 0); one still in flight counts at $0 until it is priced.
//   - Scheduled means a watch started it (watchId set); everything else — the
//     coding agent, the API, the dashboard's button, a re-check — is on request.
//   - A run belongs to an app by appId. A run with no appId (checked before the
//     app was saved, or detached from it) belongs to the team's app with the
//     same host when exactly one has it: the team paid for it, and it checked
//     that app. Anything else — a PR preview, a host the team never saved —
//     counts in the team's total and in no app, so the total can exceed the sum
//     of the apps.
//   - The verdict strip and the latest check do not start where the window
//     starts — an app checked once a month still has a strip — but they end
//     where it ends: nothing that finished after `now`'s day (a verdict is
//     placed by when it was given; money by createdAt). Only finished runs with a
//     verdict are in it — a failed run says nothing about the app (CLAUDE.md
//     §4), and an extension report without a verdict is not published
//     (extensionReportPublished). The latest check is the newest of those that
//     has been priced: the workflow writes the verdict one step before the
//     price, and a check is never shown without its price and its reason.
//   - The run rate is the window's spending per day × 30. The plan "covers it N
//     times" is the plan's monthly credit over that, to one decimal; null when
//     the credit is unlimited, when it is Free's one-time credit (it does not
//     renew, so it covers no month), or when nothing was spent.
//
// Prices only (CLAUDE.md §10): this file reads priceUsd and never what a check
// cost us. scripts/verify-cost-never-shown.ts scans it; scripts/verify-app-
// health.ts asserts every number above on a fixture team.

import type { PrismaClient } from "@/generated/prisma/client";
import type { UserPlan } from "@/lib/enums";
import { explainPrice, type PriceExplanation } from "@/lib/check-price";
import { planCredit, utcDayStart } from "@/lib/plans";
import { teamOwned } from "@/lib/tenant-db";

export interface AppHealth {
  appId: string;
  appSlug: string;
  targetKind: string;
  latest: {
    runNumber: number;
    publicId: string;
    verdict: string | null;
    status: string;
    completedAt: Date | null;
    priceUsd: number;
    price: PriceExplanation;
  } | null;
  spendUsd: number;
  perDayUsd: number;
  scheduled: { count: number; usd: number };
  onRequest: { count: number; usd: number };
  checks: number;
  daily: { date: string /* YYYY-MM-DD UTC */; usd: number }[];
  verdicts: { runNumber: number; verdict: string }[]; // last 21, oldest first
}

export interface AppHealthReport {
  windowDays: number;
  // Every check of the team in the window, including the ones that belong to
  // no app (a PR preview, a host the team never saved) — what totalSpendUsd
  // was spent on. The apps' own counts can add up to less.
  totalChecks: number;
  totalSpendUsd: number;
  perDayUsd: number;
  monthlyRunRateUsd: number;
  // What the saved apps cost a month: the run rate of the checks that belong
  // to an app. `monthlyRunRateUsd` is everything the balance paid for — a PR
  // preview, an address never saved, an app since removed included — and is
  // what the plan is measured against. "Your apps cost" is this one: a one-off
  // check is not what an app costs.
  appsMonthlyUsd: number;
  planCoversTimes: number | null;
  apps: AppHealth[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const STRIP = 21;
// Finished with a verdict; `failed` is ours, not the app's (latest-results.ts).
const FINISHED = ["completed", "partial"];

// The window a caller asked for, as a whole number of days from 1 to 90. The
// pages pass it from a query string: anything that is not a number is the
// default, 30 (NaN would make no series and an invalid date).
const MAX_DAYS = 90;
function windowDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days)) return 30;
  return Math.min(MAX_DAYS, Math.max(1, Math.floor(days)));
}

const toCents = (usd: number | null) => Math.round((usd ?? 0) * 100);
const fromCents = (c: number) => c / 100;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export async function appHealth(
  db: PrismaClient,
  teamId: string,
  opts: { days?: number; now?: Date } = {},
): Promise<AppHealthReport> {
  const days = windowDays(opts.days);
  const now = opts.now ?? new Date();
  const since = new Date(utcDayStart(now).getTime() - (days - 1) * DAY_MS);
  // Exclusive: the midnight after `now`. A `now` in the past (a report as of a
  // date) or a row stamped ahead of the clock must not land past the series.
  const until = new Date(utcDayStart(now).getTime() + DAY_MS);
  const inWindow = (d: Date) => d >= since && d < until;
  // The same edge as D1 can test it. D1 compares DateTime as text. Prisma
  // writes "2026-09-03T00:00:00.000+00:00"; a row fixed by hand (a SQL UPDATE
  // with datetime('now')) holds "2026-09-03 21:23:10", which sorts before
  // every Prisma-spelled value of its day. Production has both: createdAt on
  // runs up to 2026-09-03, completedAt on #191 and #203 (2026-09-14 and -16),
  // so one can be written again any day. "< midnight" would let such a row
  // from the next day in; "<= 23:59:59.999 of the last day" holds for both
  // spellings: every row of that day sorts at or below it, every row of the
  // next day above.
  const lastInstant = new Date(until.getTime() - 1);

  const [team, apps, runs] = await Promise.all([
    db.team.findUnique({ where: { id: teamId }, select: { plan: true } }),
    db.app.findMany({
      where: { ...teamOwned(teamId) },
      orderBy: { createdAt: "asc" },
      select: { id: true, appSlug: true, targetKind: true },
    }),
    // The one pass over the window's money, on the [teamId, createdAt] index.
    // A day of slack at the start, with the exact edge drawn in code: a run in
    // the old spelling on the window's first day sorts before its midnight and
    // would silently drop out (Run #137).
    db.run.findMany({
      where: { ...teamOwned(teamId), createdAt: { gte: new Date(since.getTime() - DAY_MS), lte: lastInstant } },
      select: { appId: true, appSlug: true, watchId: true, priceUsd: true, createdAt: true },
    }),
  ]);
  const plan = (team?.plan ?? "free") as UserPlan;

  const byId = new Map(apps.map((a) => [a.id, a]));
  const slugCount = new Map<string, number>();
  for (const a of apps) slugCount.set(a.appSlug, (slugCount.get(a.appSlug) ?? 0) + 1);
  const bySlug = new Map(apps.filter((a) => slugCount.get(a.appSlug) === 1).map((a) => [a.appSlug, a]));
  const ownerOf = (r: { appId: string | null; appSlug: string }) =>
    r.appId ? byId.get(r.appId) : bySlug.get(r.appSlug);

  const dates = Array.from({ length: days }, (_, i) => isoDay(new Date(since.getTime() + i * DAY_MS)));
  type Tally = { cents: number; scheduled: { count: number; cents: number }; onRequest: { count: number; cents: number }; daily: Map<string, number> };
  const tallies = new Map<string, Tally>(
    apps.map((a) => [a.id, { cents: 0, scheduled: { count: 0, cents: 0 }, onRequest: { count: 0, cents: 0 }, daily: new Map() }]),
  );
  let totalCents = 0;
  let totalChecks = 0;
  for (const r of runs) {
    if (!inWindow(r.createdAt)) continue;
    const c = toCents(r.priceUsd);
    totalCents += c;
    totalChecks++;
    const app = ownerOf(r);
    if (!app) continue;
    const t = tallies.get(app.id)!;
    t.cents += c;
    const side = r.watchId ? t.scheduled : t.onRequest;
    side.count++;
    side.cents += c;
    const day = isoDay(r.createdAt);
    t.daily.set(day, (t.daily.get(day) ?? 0) + c);
  }

  const health = await Promise.all(
    apps.map(async (app): Promise<AppHealth> => {
      const t = tallies.get(app.id)!;
      const unique = bySlug.get(app.appSlug) === app;
      const where = {
        ...teamOwned(teamId),
        OR: [{ appId: app.id }, ...(unique ? [{ appId: null, appSlug: app.appSlug }] : [])],
        status: { in: FINISHED },
        verdict: { not: null },
        // As of `now`: nothing finished after the window's last day — a check
        // that started at 23:50 and finished at 00:10 had no verdict yet. In
        // the query, not after it, so a later run cannot take a place of the
        // 21. (Spend stays placed by createdAt, as the balance places it.)
        createdAt: { lte: lastInstant },
        completedAt: { lte: lastInstant },
      };
      // D1 orders completedAt as text, so within one day the two spellings
      // interleave out of time order (a hand-written 23:30 sorts before 22:00).
      // Across days the text order is right: every day strictly between the
      // newest and the 21st row's day is whole in `head`. So the two edge days
      // are fetched whole and the strip is ordered by the parsed time.
      const head = await db.run.findMany({
        where: { ...teamOwned(teamId), ...where }, orderBy: { completedAt: "desc" }, take: STRIP, select: { completedAt: true },
      });
      const edge = (r: { completedAt: Date | null } | undefined) => utcDayStart(r!.completedAt!).getTime();
      const finished = head.length === 0 ? [] : (await db.run.findMany({
        where: {
          ...teamOwned(teamId),
          ...where,
          // The newest row's day through the 21st's, both whole, in either
          // spelling (the same ±1 ms edges as lastInstant).
          AND: [{ completedAt: { gt: new Date(edge(head.at(-1)) - 1), lte: new Date(edge(head[0]) + DAY_MS - 1) } }],
        },
        select: {
          id: true, teamId: true, appSlug: true, runNumber: true, publicId: true, verdict: true, status: true,
          completedAt: true, priceUsd: true, quickPagesOpened: true,
        },
      }))
        .sort((a, b) => b.completedAt!.getTime() - a.completedAt!.getTime() || b.runNumber - a.runNumber)
        .slice(0, STRIP);
      const priced = finished.find((r) => r.priceUsd !== null);
      const price = priced ? await explainPrice(db, priced, plan) : null;
      const checks = t.scheduled.count + t.onRequest.count;
      return {
        appId: app.id,
        appSlug: app.appSlug,
        targetKind: app.targetKind,
        latest:
          priced && price
            ? {
                runNumber: priced.runNumber,
                publicId: priced.publicId,
                verdict: priced.verdict,
                status: priced.status,
                completedAt: priced.completedAt,
                priceUsd: priced.priceUsd!,
                price,
              }
            : null,
        spendUsd: fromCents(t.cents),
        perDayUsd: fromCents(Math.round(t.cents / days)),
        scheduled: { count: t.scheduled.count, usd: fromCents(t.scheduled.cents) },
        onRequest: { count: t.onRequest.count, usd: fromCents(t.onRequest.cents) },
        checks,
        daily: dates.map((date) => ({ date, usd: fromCents(t.daily.get(date) ?? 0) })),
        verdicts: finished.map((r) => ({ runNumber: r.runNumber, verdict: r.verdict! })).reverse(),
      };
    }),
  );

  const monthlyCents = Math.round((totalCents / days) * 30);
  const { window, creditUsd } = planCredit(plan);
  const planCoversTimes =
    window === "month" && creditUsd !== null && monthlyCents > 0
      ? Math.round((creditUsd / fromCents(monthlyCents)) * 10) / 10
      : null;

  return {
    windowDays: days,
    totalChecks,
    totalSpendUsd: fromCents(totalCents),
    perDayUsd: fromCents(Math.round(totalCents / days)),
    monthlyRunRateUsd: fromCents(monthlyCents),
    appsMonthlyUsd: fromCents(Math.round(([...tallies.values()].reduce((s, t) => s + t.cents, 0) / days) * 30)),
    planCoversTimes,
    apps: health.sort((a, b) => b.spendUsd - a.spendUsd || a.appSlug.localeCompare(b.appSlug)),
  };
}
