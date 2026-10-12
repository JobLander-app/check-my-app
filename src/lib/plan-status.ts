// What a team's plan allows and how much of it is left, told to the coding
// agent (CHE-325; the balance since CHE-327).
//
// Every MCP tool works on every plan (CHE-316); a plan only sets how much can
// be spent. An agent that does not know the balance spends the last of it
// without a word and the person meets the limit as a refusal. So the agent is
// told up front — in the connection's instructions and in list_apps /
// latest_results — and every refusal carries the links to top up or upgrade.
//
// Each number is read through the function the matching gate enforces with
// (src/lib/plans.ts): teamBalance for the balance, activeWatchCount for Free's
// one watch, watchTrialState for the trial, estimateCheckPrice for "can this
// app be checked now". Nothing is re-derived here, so what the agent is told
// is what the gate will say. Prices only — never a cost or a multiplier.

import type { PrismaClient } from "@/generated/prisma/client";
import type { UserPlan } from "@/lib/enums";
import {
  FREE_TRIAL_WATCHES,
  PLAN_LIMITS,
  TOPUP_AMOUNTS_USD,
  WATCH_TRIAL_DAYS,
  activeWatchCount,
  balanceDecision,
  estimateCheckPrice,
  planLabel,
  teamBalance,
  typicalPriceRange,
  usd,
  watchTrialState,
  type TeamBalance,
} from "@/lib/plans";
import { BALANCE_PATH, PRICING_PATH } from "@/lib/balance-links";
import { teamOwned } from "@/lib/tenant-db";
import { byokRefusal } from "@/lib/byok-credit";

export { BALANCE_PATH, PRICING_PATH };

export interface PlanStatus {
  plan: UserPlan;
  balance: {
    // What the team can spend now; null = unlimited.
    usd: number | null;
    // What the plan puts on it each month (Free: once); null = unlimited.
    plan_credit_usd: number | null;
    // "October 1"; null when the credit never renews (Free).
    renews_on: string | null;
    // What checks were priced at in this period.
    spent_this_period_usd: number;
    // Bought balance still unspent (spent after the plan's credit).
    topped_up_usd: number;
  };
  // What a check typically costs on this plan. Each app's own range is on the
  // app (list_apps) once it has a history.
  typical_check_price_usd: { low: number; high: number };
  // Free's trial is one app; every paid plan has no limit.
  watches: { active: number; limit: number | null };
  // The Free watch's trial; null when no watch of the team is on one.
  watch_trial: { app: string; ended: boolean; days_left: number | null } | null;
  upgrade_url: string;
  // Top up the balance ($10, $25 or $50).
  buy_url: string;
  // CHE-458: the team's checks run on its own OpenRouter key and that key
  // cannot pay — the sentence that says so, or null.
  paused_by_team_key: string | null;
}

export function balanceBlock(b: TeamBalance): PlanStatus["balance"] {
  return {
    usd: b.balanceUsd,
    plan_credit_usd: b.creditUsd,
    renews_on: b.renewsOn,
    spent_this_period_usd: b.spentUsd,
    topped_up_usd: b.topupUsd,
  };
}

export async function loadPlanStatus(
  db: PrismaClient,
  team: { id: string; plan: UserPlan },
  origin: string,
  now: Date = new Date(),
): Promise<PlanStatus> {
  const free = team.plan === "free";
  const [balance, watchesActive, keyPaused, trialWatches] = await Promise.all([
    teamBalance(db, team, now),
    activeWatchCount(db, team.id),
    byokRefusal(db, team.id),
    // Only Free has a trial (watchTrialState answers "none" for any other plan).
    free
      ? db.watch.findMany({
          where: { ...teamOwned(team.id), active: true },
          orderBy: { createdAt: "asc" },
          select: { appSlug: true, trialEndsAt: true },
        })
      : Promise.resolve([]),
  ]);
  let watch_trial: PlanStatus["watch_trial"] = null;
  for (const w of trialWatches) {
    const state = watchTrialState(w, team.plan, now);
    if (state.kind === "none") continue;
    watch_trial = {
      app: w.appSlug,
      ended: state.kind === "ended",
      days_left: state.kind === "active" ? state.daysLeft : null,
    };
    break;
  }
  return {
    plan: team.plan,
    balance: balanceBlock(balance),
    typical_check_price_usd: typicalPriceRange(team.plan),
    watches: { active: watchesActive, limit: free ? FREE_TRIAL_WATCHES : null },
    watch_trial,
    upgrade_url: `${origin}${PRICING_PATH}`,
    buy_url: `${origin}${BALANCE_PATH}`,
    paused_by_team_key: keyPaused,
  };
}

// Whether a check of `appSlug` would be admitted right now, and what it would
// usually cost — the gate's own decision (src/lib/plans.ts balanceDecision).
// A watch whose app is refused here is paused until a top-up or the next
// credit; list_apps says so per app.
export async function appCanRun(
  db: PrismaClient,
  team: { id: string; plan: UserPlan },
  balance: TeamBalance,
  appSlug: string,
  // CHE-458: whether the team's own key cannot pay — required, so no caller can
  // forget it and report a check as able to start when the gate will refuse it
  // (CodeRabbit on #332). The caller reads it once for all apps (byokRefusal).
  keyPaused: boolean,
): Promise<{ ok: boolean; estimate_usd: number; why: "team_key" | "balance" | null }> {
  const estimate = await estimateCheckPrice(db, team, appSlug);
  if (keyPaused) return { ok: false, estimate_usd: estimate, why: "team_key" };
  const ok = balanceDecision(team.plan, balance, estimate).ok;
  return { ok, estimate_usd: estimate, why: ok ? null : "balance" };
}

// ---------------------------------------------------------------------------
// The same allowances as a sentence per plan, for /guides/connect-your-agent.
// Generated from PLAN_LIMITS so the guide cannot drift from the gates.

export const GUIDE_PLANS: readonly UserPlan[] = ["free", "starter", "growth", "business"];

export function planAllowance(plan: UserPlan): { name: string; text: string } {
  const credit = PLAN_LIMITS[plan].creditUsd;
  const range = typicalPriceRange(plan);
  const typical = `a check typically costs ${usd(range.low)}–${usd(range.high)}, and one that finds nothing changed a few cents`;
  const topUp = `top up from $${TOPUP_AMOUNTS_USD[0]} any time`;
  if (plan === "free") {
    return {
      name: planLabel(plan),
      text:
        `${usd(credit ?? 0)} of checks, once, for the whole team; ${typical}. 1 watched app, checked daily, ` +
        `on a ${WATCH_TRIAL_DAYS}-day trial; ${topUp}.`,
    };
  }
  return {
    name: planLabel(plan),
    text:
      `${credit === null ? "Unlimited" : `${usd(credit)} of checks every month`}, spent on anything — recurring checks, ` +
      `your agent, the dashboard; ${typical}. Any number of watched apps, daily or every 6 hours; ${topUp}.`,
  };
}
