// Subscription tier limits (CHE-34). Enforcement only — no billing yet (Stripe /
// Clerk Billing wire later, per the PRD). `User.plan` drives the gates.

import type { UserPlan, WatchFrequency } from "./enums";
import type { PrismaClient } from "@/generated/prisma/client";
import { ownerScoped, teamOwned } from "@/lib/tenant-db";

export interface PlanLimits {
  // 0 = no Daily Watch (one-off runs only).
  maxWatches: number;
  // Most-frequent cadence allowed; null = no recurring checks.
  maxFrequency: WatchFrequency | null;
  trackerIntegration: boolean;
  // No API flag here, on purpose (CHE-316, owner 2026-09-27): the coding agent
  // is the primary interface, so every plan — Free included — can mint a key
  // and connect MCP. What bounds a key's spending is what bounds the UI's: the
  // run quota (assertCanStartRun), the watch cap and the daily budget below.
  // CHE-106: what one watched app may spend on agent work per day. Measured
  // reality is ~$0.44/tick, so these are budgets for roughly one deep check a
  // day plus room for a re-check when something is wrong. Beyond it, ticks
  // still run — as smoke passes, which cost ~$0.01 and still catch an app
  // going down. Set against revenue: Starter is $29/mo/app ≈ $0.97/day.
  dailyBudgetUsd: number;
  // CHE-137: how many FULL re-checks an owner may start per UTC calendar
  // month; null = unlimited. The default re-check is the ladder (smoke /
  // partial / full, decided by the survey — re-walk only what changed, map
  // reused from Daily Watch) and is not limited here. A full re-check skips
  // the ladder and walks everything, which on the current model tiers costs
  // $0.16–0.24 a run (CHE-184: run #145 at $0.193), so it is metered per plan
  // against what the plan pays: Starter $29/mo carries 5, Growth $99/mo 20,
  // Business 100. Free carries none — the ladder re-check is the trial. The
  // "30 runs a month" Starter promise was dropped with this (owner,
  // 2026-09-06).
  fullRechecksPerMonth: number | null;
  // CHE-259: how many BILLABLE seats the plan carries before the subscription's
  // quantity has to grow. A billable seat is an admin or a member — the two
  // scopes that can spend the team's plan. Readers are free, deliberately: a
  // team should be able to give its designer, its support person and its
  // investor a way to read what broke without anyone counting heads.
  // null = no ceiling (enterprise talks to a human).
  includedSeats: number | null;
}

export const PLAN_LIMITS: Record<UserPlan, PlanLimits> = {
  // Free gets ONE daily watch: every verdict page advertises "Enable Daily
  // Watch", and with no billing wired a 0-cap made the button a dead end for
  // every account that exists. One watch is the product's hook; caps bite at
  // the second app.
  free: {
    maxWatches: 1,
    maxFrequency: "daily",
    trackerIntegration: false,
    // A trial should be able to show its best work once a day.
    dailyBudgetUsd: 1.2,
    fullRechecksPerMonth: 0,
    includedSeats: 1,
  },
  starter: {
    maxWatches: 1,
    maxFrequency: "daily",
    trackerIntegration: true,
    dailyBudgetUsd: 1.2,
    fullRechecksPerMonth: 5,
    includedSeats: 3,
  },
  growth: {
    maxWatches: 5,
    maxFrequency: "every_6h",
    trackerIntegration: true,
    // $99/mo across 5 apps ≈ $0.66/day/app of revenue; one deep walk a day
    // plus smoke on the other ticks fits inside it.
    dailyBudgetUsd: 0.8,
    fullRechecksPerMonth: 20,
    includedSeats: 10,
  },
  business: {
    maxWatches: 50,
    maxFrequency: "every_6h",
    trackerIntegration: true,
    dailyBudgetUsd: 4,
    fullRechecksPerMonth: 100,
    includedSeats: 50,
  },
  enterprise: {
    maxWatches: Number.MAX_SAFE_INTEGER,
    maxFrequency: "every_6h",
    trackerIntegration: true,
    dailyBudgetUsd: 10,
    fullRechecksPerMonth: null,
    includedSeats: null,
  },
};

// Run quotas (CHE-40 phase 1 — limits only, no checkout). A run costs real
// money to execute, so the free funnel is capped at both ends: one taste for a
// stranger, a handful for a signed-up account. Every paid plan is uncapped for
// now; per-tier run allowances land with billing.
export const ANON_RUNS_PER_DAY = 1;
export const FREE_RUNS_LIFETIME = 3;

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
    where: { ownerId: null, paidCheckoutSessionId: null, createdAt: { gte: dayStart } },
  });
  return { used, cap, dayStartIso: dayStart.toISOString() };
}

// Daily Watch on Free is a trial, not a tier (CHE-54): the one free watch runs
// for this many days so an owner sees the product do its job on their own app,
// then pauses until they subscribe.
export const WATCH_TRIAL_DAYS = 7;
const TRIAL_MS = WATCH_TRIAL_DAYS * 24 * 60 * 60 * 1000;

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

const FREQ_RANK: Record<WatchFrequency, number> = { manual: 0, daily: 1, every_6h: 2 };

export function canUseFrequency(plan: UserPlan, freq: WatchFrequency): boolean {
  const max = PLAN_LIMITS[plan].maxFrequency;
  return max !== null && FREQ_RANK[freq] <= FREQ_RANK[max];
}

export type WatchGate = { ok: true } | { ok: false; reason: string };

// Pure half of assertCanAddWatch: the cap decision given how many active
// watches the owner already has. Split out so the rule can be asserted without
// a database, and so the Free copy says what Free actually is — one app, on a
// trial — instead of a bare number.
export function watchCapReason(plan: UserPlan, activeWatches: number): string | null {
  const limits = PLAN_LIMITS[plan];
  if (limits.maxWatches === 0) {
    return "Daily Watch isn't available on the Free plan — upgrade to enable it.";
  }
  if (activeWatches < limits.maxWatches) return null;
  return plan === "free"
    ? `Free covers one app, on a ${WATCH_TRIAL_DAYS}-day trial. Upgrade to Starter to watch this one too.`
    : `Your team's plan covers ${limits.maxWatches} watched app(s), and they are all in use.`;
}

// CHE-325: what the watch cap counts — every ACTIVE watch of the team, a Free
// watch whose trial has ended included (it is still switched on; the scheduler
// skips it). One count for the gate and for what an agent is told is left.
export async function activeWatchCount(db: PrismaClient, teamId: string): Promise<number> {
  return db.watch.count({ where: { ...teamOwned(teamId), active: true } });
}

// CHE-325: turning back on a Free watch whose trial is over would say "on" and
// never run (shouldSkipWatch). Refused instead, with the way forward.
export const TRIAL_ENDED_REASON =
  `The free ${WATCH_TRIAL_DAYS}-day Daily Watch trial on this app has ended. Upgrade to keep it running.`;

// Gate for enabling/configuring a Daily Watch. existingWatchId set → it's an
// update of an existing watch, so it doesn't count against the per-plan cap.
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
  if (PLAN_LIMITS[opts.plan].maxWatches === 0) {
    return { ok: false, reason: watchCapReason(opts.plan, 0)! };
  }
  if (!canUseFrequency(opts.plan, opts.frequency)) {
    return { ok: false, reason: `Your plan doesn't allow ${opts.frequency} checks.` };
  }
  if (!opts.existingWatchId) {
    const count = await activeWatchCount(db, opts.teamId);
    const reason = watchCapReason(opts.plan, count);
    if (reason) return { ok: false, reason };
  }
  return { ok: true };
}

// What a Free team's lifetime allowance counts: every run of the team, however
// it started. The gate below and the "free checks left" an agent is told
// (src/lib/plan-status.ts, CHE-325) read this one count, so the number said is
// the number enforced.
export async function teamRunsUsed(db: PrismaClient, teamId: string): Promise<number> {
  return db.run.count({ where: { ...teamOwned(teamId) } });
}

export type RunGate =
  | { ok: true }
  | { ok: false; reason: string; code: "quota_anon" | "quota_free" | "quota_site" };

// Gate for starting a one-off run from the submit form. Only that route calls
// it: Watch/scheduler runs are already paid for by the plan that enabled them
// and must never be blocked by a quota.
//
// `anonKeyHash` identifies the client of an anonymous submission; null means we
// couldn't derive one (see hashClientKey), and an unidentifiable client is let
// through rather than blocked — over-counting strangers would break the funnel
// this whole product runs on.
//
// `opts.siteCap` is the effective site-wide cap (siteCapFromEnv); callers in
// the web app pass what the runtime env says, and the constant is the default.
export async function assertCanStartRun(
  db: PrismaClient,
  // CHE-260: the team acting. `id` is the TEAM id, and the lifetime free-run
  // allowance is the team's — five people on one Free team share three runs.
  team: { id: string; plan: UserPlan } | null,
  anonKeyHash: string | null,
  opts: { siteCap?: number } = {},
): Promise<RunGate> {
  if (team) {
    if (team.plan !== "free") return { ok: true };
    const used = await teamRunsUsed(db, team.id);
    if (used >= FREE_RUNS_LIFETIME) {
      return {
        ok: false,
        code: "quota_free",
        reason: `Your team has used all ${FREE_RUNS_LIFETIME} runs on the Free plan. Enable Daily Watch on an app you've already checked, or upgrade for unlimited runs.`,
      };
    }
    return { ok: true };
  }

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

// ---------------------------------------------------------------------------
// Full re-checks per month (CHE-137).
//
// The allowance is a UTC calendar month, and the count is Run rows with
// forceFull set for the same owner since the month began — no counter row to
// keep in sync, no schema change, and the number the owner is shown is the
// number the gate enforces. Every forceFull row counts, including one whose
// run later failed: the allowance is what the owner asked to start.

// Start of the current UTC month — the allowance resets there, and the copy
// names that date.
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

// How many full re-checks this owner has started this UTC month.
export async function fullRechecksUsed(
  db: PrismaClient,
  teamId: string,
  now: Date = new Date(),
): Promise<number> {
  return db.run.count({
    where: { ...teamOwned(teamId), forceFull: true, createdAt: { gte: utcMonthStart(now) } },
  });
}

export type FullRecheckGate =
  // `remaining` is what is left AFTER the re-check being gated; null = the
  // plan has no limit.
  | { ok: true; remaining: number | null }
  | { ok: false; reason: string };

// Pure decision: may an owner on `plan`, having started `used` full re-checks
// this month, start one more? Split from the count so the rule and its wording
// can be asserted without a database (scripts/verify-recheck-limits.ts).
//
// The wording names the plan's own number and the reset date, and always says
// that the regular re-check is still there — the limit is on the expensive
// mode, never on re-checking.
export function fullRecheckGate(plan: UserPlan, used: number, now: Date = new Date()): FullRecheckGate {
  const limit = PLAN_LIMITS[plan].fullRechecksPerMonth;
  if (limit === null) return { ok: true, remaining: null };
  if (limit === 0) {
    return {
      ok: false,
      reason:
        `Full re-checks aren't included on the ${planLabel(plan)} plan. ` +
        `Upgrade to Starter for ${PLAN_LIMITS.starter.fullRechecksPerMonth} a month. ` +
        REGULAR_RECHECK_STILL_AVAILABLE,
    };
  }
  if (used >= limit) {
    return {
      ok: false,
      reason:
        `Full re-checks on your team's plan: ${limit} a month, all used until ${nextUtcMonthLabel(now)}. ` +
        REGULAR_RECHECK_STILL_AVAILABLE,
    };
  }
  return { ok: true, remaining: limit - used - 1 };
}

const REGULAR_RECHECK_STILL_AVAILABLE =
  "A regular re-check is still available and re-walks what changed.";

export function planLabel(plan: UserPlan): string {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

// What the dashboard shows: the month's allowance, how much of it is used, and
// what is left right now (nothing pending — unlike the gate's `remaining`,
// which is after the re-check it is deciding). `limit` and `remaining` null =
// unlimited.
export async function fullRechecksRemaining(
  db: PrismaClient,
  team: { id: string; plan: UserPlan },
  now: Date = new Date(),
): Promise<{ used: number; limit: number | null; remaining: number | null; resetsOn: string }> {
  const limit = PLAN_LIMITS[team.plan].fullRechecksPerMonth;
  const used = await fullRechecksUsed(db, team.id, now);
  return {
    used,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - used),
    resetsOn: nextUtcMonthLabel(now),
  };
}
