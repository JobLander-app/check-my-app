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
//     where it ends: nothing after `now`'s day. Only finished runs with a
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
  totalSpendUsd: number;
  perDayUsd: number;
  monthlyRunRateUsd: number;
  planCoversTimes: number | null;
  apps: AppHealth[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const STRIP = 21;
// Finished with a verdict; `failed` is ours, not the app's (latest-results.ts).
const FINISHED = ["completed", "partial"];

const toCents = (usd: number | null) => Math.round((usd ?? 0) * 100);
const fromCents = (c: number) => c / 100;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export async function appHealth(
  db: PrismaClient,
  teamId: string,
  opts: { days?: number; now?: Date } = {},
): Promise<AppHealthReport> {
  const days = Math.max(1, Math.floor(opts.days ?? 30));
  const now = opts.now ?? new Date();
  const since = new Date(utcDayStart(now).getTime() - (days - 1) * DAY_MS);
  // Exclusive: the midnight after `now`. A `now` in the past (a report as of a
  // date) or a row stamped ahead of the clock must not land past the series.
  const until = new Date(utcDayStart(now).getTime() + DAY_MS);
  const inWindow = (d: Date) => d >= since && d < until;

  const [team, apps, runs] = await Promise.all([
    db.team.findUnique({ where: { id: teamId }, select: { plan: true } }),
    db.app.findMany({
      where: { ...teamOwned(teamId) },
      orderBy: { createdAt: "asc" },
      select: { id: true, appSlug: true, targetKind: true },
    }),
    // The one pass over the window's money, on the [teamId, createdAt] index.
    // A day of slack at the start, and both edges drawn exactly in code: D1
    // compares DateTime as text, and rows written before 2026-09-04 spell it
    // "2026-09-03 21:23:10", which sorts before the adapter's
    // "2026-09-03T00:00:00.000+00:00" — so on the window's first day such a run
    // would silently drop out (Run #137), and on the day after its last it
    // would slip in.
    db.run.findMany({
      where: { ...teamOwned(teamId), createdAt: { gte: new Date(since.getTime() - DAY_MS), lt: until } },
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
  for (const r of runs) {
    if (!inWindow(r.createdAt)) continue;
    const c = toCents(r.priceUsd);
    totalCents += c;
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
      const finished = await db.run.findMany({
        where: {
          ...teamOwned(teamId),
          OR: [{ appId: app.id }, ...(unique ? [{ appId: null, appSlug: app.appSlug }] : [])],
          status: { in: FINISHED },
          verdict: { not: null },
          // As of `now`: nothing started after the window's last day.
          createdAt: { lt: until },
        },
        orderBy: { completedAt: "desc" },
        take: STRIP,
        select: {
          id: true, teamId: true, appSlug: true, runNumber: true, publicId: true, verdict: true, status: true,
          completedAt: true, priceUsd: true, quickPagesOpened: true,
        },
      });
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
    totalSpendUsd: fromCents(totalCents),
    perDayUsd: fromCents(Math.round(totalCents / days)),
    monthlyRunRateUsd: fromCents(monthlyCents),
    planCoversTimes,
    apps: health.sort((a, b) => b.spendUsd - a.spendUsd || a.appSlug.localeCompare(b.appSlug)),
  };
}
