// What each plan allows, and the gates that enforce it (CHE-34, rebuilt around
// one currency in CHE-327). `Team.plan` drives the gates.

import type { UserPlan, WatchFrequency } from "./enums";
import type { PrismaClient } from "@/generated/prisma/client";
import { ownerScoped, teamOwned } from "@/lib/tenant-db";
import { PAID_RETRY_SOURCE } from "@/lib/failed-run";

export interface PlanLimits {
  // CHE-327 (owner, 2026-09-28): a plan is a dollar BALANCE, and every check
  // has its own price. What a check is for does not matter — a watch's
  // scheduled tick, a check the coding agent starts, the dashboard's button, a
  // re-check, a full re-check all spend the same balance. Someone working
  // through their agent may want forty checks and no watch at all; a
  // watch-slot cap told them no, and a count of "full re-checks" meant nothing
  // across apps of different size.
  //
  // `creditUsd` is what the plan puts on the balance each UTC month (no
  // rollover). Free's is one-time: it never renews. null = unlimited.
  creditUsd: number | null;
  // INTERNAL. A check's price is what it cost us × this. Never shown to a
  // customer, anywhere (owner: "×2–3 makes people think look how much they
  // earn") — the customer sees a check's price and their balance, nothing
  // else. It appears in code and on our own Notion page, and
  // scripts/verify-balance.ts fails the build if a customer surface prints it.
  priceMultiplier: number;
  trackerIntegration: boolean;
  // No API flag here, on purpose (CHE-316, owner 2026-09-27): the coding agent
  // is the primary interface, so every plan — Free included — can mint a key
  // and connect MCP. What bounds a key's spending is what bounds the UI's: the
  // team's balance (assertCanStartRun).
  //
  // CHE-259: how many BILLABLE seats the plan carries before the subscription's
  // quantity has to grow. A billable seat is an admin or a member — the two
  // scopes that can spend the team's plan. Readers are free, deliberately: a
  // team should be able to give its designer, its support person and its
  // investor a way to read what broke without anyone counting heads.
  // null = no ceiling (enterprise talks to a human).
  includedSeats: number | null;
}

export const PLAN_LIMITS: Record<UserPlan, PlanLimits> = {
  free: { creditUsd: 3, priceMultiplier: 3, trackerIntegration: false, includedSeats: 1 },
  starter: { creditUsd: 29, priceMultiplier: 3, trackerIntegration: true, includedSeats: 3 },
  growth: { creditUsd: 99, priceMultiplier: 2.5, trackerIntegration: true, includedSeats: 10 },
  business: { creditUsd: 499, priceMultiplier: 2, trackerIntegration: true, includedSeats: 50 },
  enterprise: { creditUsd: null, priceMultiplier: 2, trackerIntegration: true, includedSeats: null },
};

// What a check costs us, measured (prod, 30 days to 2026-09-28, 120 finished
// runs: avg $0.32, p50 $0.24, p90 $0.75, max $1.63). The customer never sees
// these; they see a PRICE range derived from them for their own plan
// (typicalPriceRange), which is how /pricing, the guide and the agent can say
// "a check typically costs $X–$Y" without a number anyone has to keep in sync.
// Re-measure with scripts/measure/pricing-hypotheses.ts.
export const TYPICAL_CHECK_COST_USD = { low: 0.24, high: 0.75 } as const;

// A check whose survey found nothing changed walks no journey and carries the
// last verdict forward (src/agent/replay.ts). It costs this, and is priced like
// any other check — a few cents — so a 6-hourly watch costs almost nothing on
// the days nothing happens.
export const SMOKE_COST_USD = 0.01;

// A safety fuse, not fair use. A single check that has cost this much is far
// past anything measured (max $1.63), which means something of OURS is looping —
// so it is stopped as our failure: price 0, internal reason, nothing published
// (rule 4). The agent's per-phase iteration caps (src/agent/limits.ts,
// instructions.ts) bound one journey; nothing bounded a run's journeys
// together, and that is the gap this closes.
export const RUNAWAY_COST_USD = 3;

// What the customer pays for a check that cost us `costUsd`, in cents.
export function priceForCost(plan: UserPlan, costUsd: number): number {
  return Math.round(Math.max(0, costUsd) * PLAN_LIMITS[plan].priceMultiplier * 100) / 100;
}

// The price range a check typically has on this plan.
export function typicalPriceRange(plan: UserPlan): { low: number; high: number } {
  return {
    low: priceForCost(plan, TYPICAL_CHECK_COST_USD.low),
    high: priceForCost(plan, TYPICAL_CHECK_COST_USD.high),
  };
}

export function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

// Run quotas for the anonymous funnel (CHE-40).
export const ANON_RUNS_PER_DAY = 1;

// CHE-327: the top-up amounts the buttons offer. Nothing below $10, so Stripe's
// fixed fee per payment does not eat the purchase. Bought balance never expires
// and is spent after the plan's own credit.
export const TOPUP_AMOUNTS_USD = [10, 25, 50] as const;
export type TopUpAmount = (typeof TOPUP_AMOUNTS_USD)[number];
export function isTopUpAmount(n: unknown): n is TopUpAmount {
  return typeof n === "number" && (TOPUP_AMOUNTS_USD as readonly number[]).includes(n);
}

// Site-wide cap on free anonymous checks per UTC day (owner decision,
// 2026-09-05, before launch). The per-visitor cap above bounds one stranger;
// this one bounds the whole site, so a launch-day crowd cannot spend without a
// ceiling. Economics behind the number: over the last 30 days an anonymous run
// cost ~$0.28 on average and $0.91 at most, so 20 free runs bound the daily
// free spend at roughly $6 typical, ~$18 worst case. Past the cap a visitor can
// still run their check for $1 (which covers the overflow), or read today's
// checks — every anonymous check is public.
export const ANON_RUNS_PER_DAY_SITE = 20;

// The cap the site is actually running with. The constant above is the
// default; the web worker's runtime env may raise or lower it without a
// deploy (`wrangler secret put ANON_RUNS_PER_DAY_SITE` on checkmyapp-web — the
// owner sets 100 for launch day and 20 the day after, see DEPLOY.md). Only a
// positive integer counts; anything else (unset, empty, "abc", "0", "1.5",
// "-5") is the default, so a typo can never open the site or close it.
// Pure so the rule is testable; the web app reads its env in
// src/lib/site-cap.ts and threads the value into the two functions below.
export function siteCapFromEnv(env: Record<string, unknown> | null | undefined): number {
  const raw = env?.ANON_RUNS_PER_DAY_SITE;
  if (typeof raw !== "string" && typeof raw !== "number") return ANON_RUNS_PER_DAY_SITE;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return ANON_RUNS_PER_DAY_SITE;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : ANON_RUNS_PER_DAY_SITE;
}

// Start of the current UTC day — the cap resets at midnight UTC, and the copy
// says so.
export function utcDayStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// How many free anonymous runs the site has used today, against the cap. The
// count is by ownerId null — the only runs the free funnel creates — minus the
// paid $1 runs: a run someone paid for (Run.paidCheckoutSessionId set, see
// src/lib/one-check.ts) is not a free check and never consumes the free cap.
// `cap` is the effective cap (siteCapFromEnv); the default is the constant.
export async function anonRunsToday(
  db: PrismaClient,
  now: Date = new Date(),
  cap: number = ANON_RUNS_PER_DAY_SITE,
): Promise<{ used: number; cap: number; dayStartIso: string }> {
  const dayStart = utcDayStart(now);
  const used = await db.run.count({ ...ownerScoped(),
    where: {
      ownerId: null,
      paidCheckoutSessionId: null,
      // CHE-335: a failed $1 check's owed re-check is paid for too. The null
      // branch keeps runs from before startedVia existed — SQL's NULL <> x is
      // not true, so a bare `not` would drop them from the count.
      OR: [{ startedVia: null }, { startedVia: { not: PAID_RETRY_SOURCE } }],
      createdAt: { gte: dayStart },
    },
  });
  return { used, cap, dayStartIso: dayStart.toISOString() };
}

// Daily Watch on Free is a trial, not a tier (CHE-54): the one free watch runs
// for this many days so an owner sees the product do its job on their own app,
// then pauses until they subscribe.
export const WATCH_TRIAL_DAYS = 7;
const TRIAL_MS = WATCH_TRIAL_DAYS * 24 * 60 * 60 * 1000;

// CHE-327: the one watch-shaped limit left. A paid team may watch any number
// of apps at any cadence — a watch is a schedule that spends the team's
// balance, and the balance is the limit. Free keeps its trial: one app, daily,
// for WATCH_TRIAL_DAYS, spending the same one-time credit everything else does.
export const FREE_TRIAL_WATCHES = 1;

// trialEndsAt to stamp on a watch the given plan is enabling. Paid plans get
// null — no trial, no expiry.
export function watchTrialEnd(plan: UserPlan, now: Date = new Date()): Date | null {
  return plan === "free" ? new Date(now.getTime() + TRIAL_MS) : null;
}

// Scheduler rule for a trial watch, pure so the decision is testable without a
// database or a clock. Two properties matter:
//   - NULL trialEndsAt never expires (paid + legacy ownerless watches).
//   - The owner's CURRENT plan is what's checked, so an owner who upgrades
//     resumes on their own with no second flag to keep in sync — including
//     plans set by hand in D1, which no Stripe webhook would have cleared.
export function shouldSkipWatch(
  watch: { trialEndsAt: Date | null },
  ownerPlan: UserPlan | null,
  now: Date = new Date(),
): boolean {
  if (!watch.trialEndsAt) return false;
  if (ownerPlan !== "free") return false;
  return watch.trialEndsAt.getTime() <= now.getTime();
}

export type TrialState =
  | { kind: "none" }
  | { kind: "active"; daysLeft: number }
  | { kind: "ended" };

// What the dashboard should say about a watch's trial. Mirrors shouldSkipWatch
// — a state other than "ended" means the scheduler will still run it.
export function watchTrialState(
  watch: { trialEndsAt: Date | null } | null | undefined,
  ownerPlan: UserPlan | null,
  now: Date = new Date(),
): TrialState {
  if (!watch?.trialEndsAt || ownerPlan !== "free") return { kind: "none" };
  const left = watch.trialEndsAt.getTime() - now.getTime();
  if (left <= 0) return { kind: "ended" };
  // Round up: with 20 hours to go the owner has "1 day left", not zero.
  return { kind: "active", daysLeft: Math.ceil(left / (24 * 60 * 60 * 1000)) };
}

// Every paid plan may use every cadence; Free's trial watch is daily.
export function canUseFrequency(plan: UserPlan, freq: WatchFrequency): boolean {
  return plan !== "free" || freq !== "every_6h";
}

export type WatchGate = { ok: true } | { ok: false; reason: string };

// Pure half of assertCanAddWatch: the Free trial's one app. Every other plan
// has no watch count to run out of (CHE-327).
export function watchCapReason(plan: UserPlan, activeWatches: number): string | null {
  if (plan !== "free" || activeWatches < FREE_TRIAL_WATCHES) return null;
  return `Free covers one app, on a ${WATCH_TRIAL_DAYS}-day trial. Upgrade to Starter to watch this one too.`;
}

// CHE-325: what the Free cap counts — every ACTIVE watch of the team, a Free
// watch whose trial has ended included (it is still switched on; the scheduler
// skips it). One count for the gate and for what an agent is told.
export async function activeWatchCount(db: PrismaClient, teamId: string): Promise<number> {
  return db.watch.count({ where: { ...teamOwned(teamId), active: true } });
}

// CHE-325: turning back on a Free watch whose trial is over would say "on" and
// never run (shouldSkipWatch). Refused instead, with the way forward.
export const TRIAL_ENDED_REASON =
  `The free ${WATCH_TRIAL_DAYS}-day Daily Watch trial on this app has ended. Upgrade to keep it running.`;

// Gate for enabling/configuring a Daily Watch. existingWatchId set → it's an
// update of an existing watch, so it doesn't count against Free's one app.
export async function assertCanAddWatch(
  db: PrismaClient,
  opts: {
    // CHE-260: the TEAM whose plan is being spent — not the person who clicked.
    // Inviting a colleague must not mint a second allowance.
    teamId: string;
    plan: UserPlan;
    frequency: WatchFrequency;
    existingWatchId?: string | null;
  },
): Promise<WatchGate> {
  if (!canUseFrequency(opts.plan, opts.frequency)) {
    return { ok: false, reason: "The free Daily Watch trial checks once a day. Upgrade to check every 6 hours." };
  }
  if (opts.plan === "free" && !opts.existingWatchId) {
    const reason = watchCapReason(opts.plan, await activeWatchCount(db, opts.teamId));
    if (reason) return { ok: false, reason };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The balance (CHE-327): one number for every surface.
//
// A check is priced when it finishes (priceRun, called by the workflow): what
// it cost us × the plan's multiplier, stored on Run.priceUsd. The price is
// taken from the plan's credit for the window first; whatever the credit
// cannot cover comes off the team's bought balance (Team.topupUsd), and that
// part is stored as Run.priceFromTopupUsd so the window's plan spending is a
// plain sum over the rows. Two rules decide what is free:
//
//   - A run that failed — ours, by definition (rule 4: our failures never
//     reach the customer) — costs 0. Whatever it had been priced at is given
//     back (voidRunPrice).
//   - A check whose survey found nothing changed is NOT free: it costs its
//     real, tiny price (SMOKE_COST_USD × multiplier, a few cents). Nothing is
//     hidden in "it didn't count".
//
// A check may start while the balance is positive and at least what a check of
// this app usually costs (estimateCheckPrice). The finishing check may take the
// balance slightly below zero; that blocks the next start and nothing else.
// The number a person or an agent is told (teamBalance) and the number the
// gate reads are the same computation over the same rows.

// Start of the current UTC month — the credit renews there, and the copy names
// that date.
export function utcMonthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// The first day of the following UTC month, as the copy says it: "October 1".
// A fixed English table rather than Intl so the wording is the same on every
// runtime (workerd, Node in a verify script).
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
export function nextUtcMonthLabel(now: Date = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return `${MONTH_NAMES[next.getUTCMonth()]} 1`;
}

export function planLabel(plan: UserPlan): string {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

// The plan's credit and the window it covers. Free's is once, ever; every
// other plan's renews on the first of the UTC month.
export function planCredit(plan: UserPlan): { window: "lifetime" | "month"; creditUsd: number | null } {
  return { window: plan === "free" ? "lifetime" : "month", creditUsd: PLAN_LIMITS[plan].creditUsd };
}

function windowWhere(plan: UserPlan, now: Date) {
  return planCredit(plan).window === "month" ? { createdAt: { gte: utcMonthStart(now) } } : {};
}

const cents = (n: number) => Math.round(n * 100) / 100;

export interface TeamBalance {
  window: "lifetime" | "month";
  // What the plan puts on the balance for the window; null = unlimited.
  creditUsd: number | null;
  // Everything this window's checks were priced at (credit + bought).
  spentUsd: number;
  // The part of that the plan's credit covered.
  planSpentUsd: number;
  // Bought balance not yet spent (can be slightly negative after a check
  // finished above what was left).
  topupUsd: number;
  // What the team can spend now; null = unlimited.
  balanceUsd: number | null;
  // "October 1" for a monthly plan; null for Free, whose credit never renews.
  renewsOn: string | null;
}

// Pure: the balance from its parts, so the rule can be asserted without a
// database.
export function balanceFrom(
  plan: UserPlan,
  parts: { spentUsd: number; planSpentUsd: number; topupUsd: number },
  now: Date = new Date(),
): TeamBalance {
  const { window, creditUsd } = planCredit(plan);
  return {
    window,
    creditUsd,
    spentUsd: cents(parts.spentUsd),
    planSpentUsd: cents(parts.planSpentUsd),
    topupUsd: cents(parts.topupUsd),
    balanceUsd: creditUsd === null ? null : cents(Math.max(0, creditUsd - parts.planSpentUsd) + parts.topupUsd),
    renewsOn: window === "month" ? nextUtcMonthLabel(now) : null,
  };
}

export async function teamBalance(
  db: PrismaClient,
  team: { id: string; plan: UserPlan },
  now: Date = new Date(),
): Promise<TeamBalance> {
  const [sums, row] = await Promise.all([
    db.run.aggregate({
      where: { ...teamOwned(team.id), ...windowWhere(team.plan, now) },
      _sum: { priceUsd: true, priceFromTopupUsd: true },
    }),
    db.team.findUnique({ where: { id: team.id }, select: { topupUsd: true } }),
  ]);
  const spentUsd = sums._sum.priceUsd ?? 0;
  const fromTopup = sums._sum.priceFromTopupUsd ?? 0;
  return balanceFrom(team.plan, { spentUsd, planSpentUsd: spentUsd - fromTopup, topupUsd: row?.topupUsd ?? 0 }, now);
}

// A check that walked something: anything above the smoke price. A smoke pass
// is a few cents and says nothing about what a real check of the app costs.
const WALKED = { costUsd: { gt: SMOKE_COST_USD * 1.1 } };

// What checks of this app usually cost the team, from its own recent priced
// checks; null until there are three. Priced on the CURRENT plan, so a team
// that just upgraded is told the price it will pay, not the one it paid.
export async function appPriceRange(
  db: PrismaClient,
  team: { id: string; plan: UserPlan },
  appSlug: string,
): Promise<{ low: number; high: number; median: number } | null> {
  const rows = await db.run.findMany({
    where: { ...teamOwned(team.id), appSlug, priceUsd: { gt: 0 }, ...WALKED },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { costUsd: true },
  });
  if (rows.length < 3) return null;
  const prices = rows.map((r) => priceForCost(team.plan, r.costUsd ?? 0)).sort((a, b) => a - b);
  const at = (q: number) => prices[Math.min(prices.length - 1, Math.floor(q * prices.length))];
  return { low: at(0.25), high: at(0.75), median: at(0.5) };
}

// What the start gate expects the next check of an app to cost: this app's
// median, or the plan's typical low end for an app with no history yet.
export async function estimateCheckPrice(
  db: PrismaClient,
  team: { id: string; plan: UserPlan },
  appSlug: string | null,
): Promise<number> {
  const range = appSlug ? await appPriceRange(db, team, appSlug) : null;
  return range?.median ?? typicalPriceRange(team.plan).low;
}

// The refusal when the balance is too low, with both ways out named: top up,
// or upgrade. Never a bare "limit reached" — a limit with no visible door is
// the opaque throttle the owner ruled out (2026-09-28).
export function balanceTooLowReason(plan: UserPlan, balance: Pick<TeamBalance, "balanceUsd" | "renewsOn">, estimateUsd: number): string {
  const topUp = `Top up your balance (from $${TOPUP_AMOUNTS_USD[0]})`;
  const left = balance.balanceUsd ?? 0;
  if (plan === "free") {
    return (
      `Your team's free ${usd(PLAN_LIMITS.free.creditUsd ?? 0)} of checks is used (${usd(left)} left; a check of this app ` +
      `costs about ${usd(estimateUsd)}). ${topUp}, or upgrade to Starter for ${usd(PLAN_LIMITS.starter.creditUsd ?? 0)} of checks every month.`
    );
  }
  return (
    `Your team's balance is ${usd(left)} — not enough for another check (about ${usd(estimateUsd)}). ` +
    `${topUp}, or upgrade — the plan's credit renews ${balance.renewsOn}.`
  );
}

export type BalanceDecision =
  | { ok: true }
  | { ok: false; reason: string; code: "quota_free" | "quota_balance" };

// Pure: may a team with `balance` start a check expected to cost `estimateUsd`?
export function balanceDecision(plan: UserPlan, balance: TeamBalance, estimateUsd: number): BalanceDecision {
  if (balance.balanceUsd === null) return { ok: true };
  if (balance.balanceUsd > 0 && balance.balanceUsd >= estimateUsd) return { ok: true };
  return {
    ok: false,
    code: plan === "free" ? "quota_free" : "quota_balance",
    reason: balanceTooLowReason(plan, balance, estimateUsd),
  };
}

// Admit one check for a team: the one decision every start goes through — the
// dashboard, the API, MCP, a re-check, a watch's tick.
export async function admitTeamCheck(
  db: PrismaClient,
  team: { id: string; plan: UserPlan },
  appSlug: string | null,
  now: Date = new Date(),
): Promise<BalanceDecision> {
  const [balance, estimate] = await Promise.all([
    teamBalance(db, team, now),
    estimateCheckPrice(db, team, appSlug),
  ]);
  return balanceDecision(team.plan, balance, estimate);
}

// Pure: how a price splits between the plan's credit left in the window and
// the bought balance. Whatever the credit cannot cover comes off the bought
// balance, even past zero — the check was admitted and did its work.
export function splitPrice(priceUsd: number, creditLeftUsd: number | null): { fromTopupUsd: number } {
  if (creditLeftUsd === null) return { fromTopupUsd: 0 };
  return { fromTopupUsd: cents(Math.max(0, priceUsd - Math.max(0, creditLeftUsd))) };
}

// Pricing a finished run onto the balance (priceRun, voidRunPrice) is the
// agent's act and lives with it: src/agent/pricing.ts.

export type RunGate =
  | { ok: true }
  | { ok: false; reason: string; code: "quota_anon" | "quota_free" | "quota_site" | "quota_balance" };

// Gate for starting a run: the dashboard, the API, MCP, a re-check. A team's
// run needs the team's balance (admitTeamCheck); an anonymous one goes through
// the free funnel's caps.
//
// `anonKeyHash` identifies the client of an anonymous submission; null means we
// couldn't derive one (see hashClientKey), and an unidentifiable client is let
// through rather than blocked — over-counting strangers would break the funnel
// this whole product runs on.
//
// `opts.siteCap` is the effective site-wide cap (siteCapFromEnv); callers in
// the web app pass what the runtime env says, and the constant is the default.
// `opts.appSlug` is the app about to be checked, whose own recent prices set
// what the check is expected to cost.
export async function assertCanStartRun(
  db: PrismaClient,
  // CHE-260: the team acting. `id` is the TEAM id, and the balance is the
  // team's — five people on one team share it.
  team: { id: string; plan: UserPlan } | null,
  anonKeyHash: string | null,
  opts: { siteCap?: number; appSlug?: string | null; now?: Date } = {},
): Promise<RunGate> {
  if (team) return admitTeamCheck(db, team, opts.appSlug ?? null, opts.now);

  // The site-wide cap comes first: once today's free checks are gone, no
  // stranger gets one — identifiable or not — and the answer names the two
  // ways forward instead of the per-visitor line.
  const site = await anonRunsToday(db, new Date(), opts.siteCap ?? ANON_RUNS_PER_DAY_SITE);
  if (site.used >= site.cap) {
    return {
      ok: false,
      code: "quota_site",
      reason:
        "Today's free checks are all used up. Run this one for $1, or read today's checks — it opens again at midnight UTC.",
    };
  }

  if (!anonKeyHash) return { ok: true };
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  // Same exclusion as the site count: a $1 run this visitor paid for is not
  // the free one they get a day.
  const used = await db.run.count({ ...ownerScoped(),
    where: { anonKeyHash, paidCheckoutSessionId: null, createdAt: { gte: since } },
  });
  if (used >= ANON_RUNS_PER_DAY) {
    return {
      ok: false,
      code: "quota_anon",
      reason: "That was your free run for today. Sign up for a free account to get more.",
    };
  }
  return { ok: true };
}
