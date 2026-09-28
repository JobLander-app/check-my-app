// What a team's plan allows and how much of it is left, told to the coding
// agent (CHE-325).
//
// Every MCP tool works on every plan (CHE-316); a plan only sets volumes. An
// agent that does not know the volumes spends the last free check without a
// word and the person meets the limit as a refusal. So the agent is told up
// front — in the connection's instructions and in list_apps / latest_results —
// and every refusal carries the link to upgrade.
//
// Each number is read through the function the matching gate enforces with
// (src/lib/plans.ts): teamRunsUsed for the Free lifetime runs, activeWatchCount
// for the watch cap, watchTrialState for the trial, fullRechecksRemaining for
// the month's full re-checks. Nothing is re-derived here, so what the agent is
// told is what the gate will say.

import type { PrismaClient } from "@/generated/prisma/client";
import type { UserPlan, WatchFrequency } from "@/lib/enums";
import {
  FREE_RUNS_LIFETIME,
  PLAN_LIMITS,
  WATCH_TRIAL_DAYS,
  activeWatchCount,
  fullRechecksRemaining,
  planLabel,
  teamRunsUsed,
  watchTrialState,
} from "@/lib/plans";
import { teamOwned } from "@/lib/tenant-db";

// Where an upgrade happens. Checkout itself (POST /api/billing/checkout) needs
// a signed-in admin's session and a POST, so it is not a link anyone can be
// handed; /pricing is, and its buttons start that checkout once signed in.
export const PRICING_PATH = "/pricing";

export interface PlanStatus {
  plan: UserPlan;
  // null: checks are not counted on this plan.
  free_checks: { limit: number; used: number; left: number } | null;
  // limit null: no ceiling.
  watches: { used: number; limit: number | null };
  // The Free watch's trial; null when no watch of the team is on one.
  watch_trial: { app: string; ended: boolean; days_left: number | null } | null;
  // limit / left null: unlimited.
  full_rechecks: { limit: number | null; used: number; left: number | null; resets_on: string };
  upgrade_url: string;
}

// Enterprise carries Number.MAX_SAFE_INTEGER watches: "no ceiling", not a
// number to print.
function watchLimit(plan: UserPlan): number | null {
  const n = PLAN_LIMITS[plan].maxWatches;
  return n >= Number.MAX_SAFE_INTEGER ? null : n;
}

export async function loadPlanStatus(
  db: PrismaClient,
  team: { id: string; plan: UserPlan },
  origin: string,
  now: Date = new Date(),
): Promise<PlanStatus> {
  const free = team.plan === "free";
  const [runsUsed, watchesUsed, full, trialWatches] = await Promise.all([
    free ? teamRunsUsed(db, team.id) : Promise.resolve(0),
    activeWatchCount(db, team.id),
    fullRechecksRemaining(db, team, now),
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
    free_checks: free
      ? { limit: FREE_RUNS_LIFETIME, used: runsUsed, left: Math.max(0, FREE_RUNS_LIFETIME - runsUsed) }
      : null,
    watches: { used: watchesUsed, limit: watchLimit(team.plan) },
    watch_trial,
    full_rechecks: { limit: full.limit, used: full.used, left: full.remaining, resets_on: full.resetsOn },
    upgrade_url: `${origin}${PRICING_PATH}`,
  };
}

// ---------------------------------------------------------------------------
// The same volumes as a sentence per plan, for /guides/connect-your-agent.
// Generated from PLAN_LIMITS so the guide cannot drift from the gates.

export const GUIDE_PLANS: readonly UserPlan[] = ["free", "starter", "growth", "business"];

const CADENCE: Record<WatchFrequency, string> = { daily: "checked daily", every_6h: "checked every 6 hours", manual: "on demand" };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function planAllowance(plan: UserPlan): { name: string; text: string } {
  const limits = PLAN_LIMITS[plan];
  const watches = watchLimit(plan);
  const cadence = limits.maxFrequency ? CADENCE[limits.maxFrequency] : "";
  const watched = watches === null ? "Any number of watched apps" : plural(watches, "watched app");
  const full = limits.fullRechecksPerMonth;
  if (plan === "free") {
    return {
      name: planLabel(plan),
      text:
        `${plural(FREE_RUNS_LIFETIME, "check")} for the whole team; ${watched}, ${cadence}, ` +
        `on a ${WATCH_TRIAL_DAYS}-day trial; ${full ? `${plural(full, "full re-check")} a month` : "no full re-checks"}.`,
    };
  }
  return {
    name: planLabel(plan),
    text:
      `Unlimited checks; ${watched}, ${cadence}; ` +
      `${full === null ? "unlimited full re-checks" : `${plural(full, "full re-check")} a month`}.`,
  };
}
