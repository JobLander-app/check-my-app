// Watch scheduler (CHE-41). The agent worker's cron tick claims every Watch row
// whose nextRunAt has come due, creates a queued Run for it and starts the
// CheckRunWorkflow — the same two steps the web app does in /api/checks, minus
// the HTTP hop (here the workflow binding is the worker's own).
//
// Cost is bounded three times over: at most MAX_PER_TICK runs start per tick, a
// Watch whose previous run is still moving is skipped entirely, and every run
// spends its team's balance (CHE-327) — a team whose balance is used is paused.

import { nextRunNumber } from "@/lib/db";
import { TERMINAL_RUN_STATUSES, type UserPlan, type WatchFrequency } from "@/lib/enums";
import { admitTeamCheck, shouldSkipWatch, utcMonthStart } from "@/lib/plans";
import { snapshotAppAccounts } from "@/lib/test-accounts";
import { sweepExpiredEphemeral, sweepExpiredPendingChecks, sweepTestAccounts } from "./janitor";
import { sendBalanceUsedUp, sendWatchTrialPaused } from "@/lib/email";
import { captureServer } from "@/lib/analytics-server";
import { captureBalanceExhausted } from "@/lib/balance-events";
import { makeAgentEnv, type AgentEnv, type AgentBindings } from "./env";

// The cron fires every 15 minutes and a full run costs real money, so cap the
// fan-out per tick rather than the number of watches we're willing to hold.
const MAX_PER_TICK = 3;
// Read more candidates than we can start so watches blocked by an in-flight run
// don't starve the ones behind them in the queue.
const CANDIDATE_LIMIT = 20;

const INTERVAL_HOURS: Record<WatchFrequency, number> = { daily: 24, every_6h: 6, manual: 0 };

// How long a watch paused by an expired free trial waits before the scheduler
// looks at it again (CHE-54). It is NOT a claim — no run happens — it just keeps
// the paused row from sitting permanently at the head of the due queue, which is
// ordered by nextRunAt and only CANDIDATE_LIMIT deep: a handful of never-upgraded
// trials would otherwise starve every paying watch behind them. The cost is that
// an owner who upgrades waits up to an hour, not a full daily cycle.
const TRIAL_RECHECK_HOURS = 1;

// A run in any other status is still moving; its Watch must not fire again yet.
// CHE-265: `canceled` belongs here. It is a run that has stopped — and a
// canceled run left out of this list is a watch that never runs again, because
// the scheduler sees it as permanently in flight. The state is not
// hypothetical: T12 canceled run #203 the moment a reader-scope key started it.
// Two definitions of "terminal" disagreeing is how a watch goes quiet without
// anything failing (rule 2 — the silence would be ours, not the app's).
// Read from the one classification rather than spelled again here: a status
// added later is classified once, in enums.ts, and everything that asks "is
// anything still running" follows without being edited.
const TERMINAL_STATUSES = TERMINAL_RUN_STATUSES;

export interface TickResult {
  started: string[];
  skipped: number;
}

export async function runDueWatches(
  bindings: AgentBindings,
  now: Date = new Date(),
): Promise<TickResult> {
  const env = makeAgentEnv(bindings);

  // CHE-105: clear what the self-check account left behind before deciding what
  // to run, so a stale placeholder app can never take a slot — or a budget.
  // Never fails the tick: housekeeping must not stop real work.
  try {
    await sweepTestAccounts(env, now);
  } catch (err) {
    console.warn(`[janitor] sweep failed: ${err instanceof Error ? err.message : err}`);
  }
  // Launch: parked $1 checks that were never paid for.
  try {
    await sweepExpiredPendingChecks(env, now);
  } catch (err) {
    console.warn(`[janitor] pending-check sweep failed: ${err instanceof Error ? err.message : err}`);
  }
  // CHE-202: ephemeral runs (PR previews) past their expiry, evidence included.
  try {
    await sweepExpiredEphemeral(env, now);
  } catch (err) {
    console.warn(`[janitor] ephemeral sweep failed: ${err instanceof Error ? err.message : err}`);
  }

  const due = await env.db.watch.findMany({
    where: {
      active: true,
      frequency: { not: "manual" },
      OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
    },
    // SQLite sorts NULL first, so watches that have never fired go to the front.
    orderBy: { nextRunAt: "asc" },
    take: CANDIDATE_LIMIT,
    select: {
      id: true,
      appSlug: true,
      targetUrl: true,
      frequency: true,
      notifyEmail: true,
      testEmail: true,
      testPasswordEnc: true,
      appId: true,
      ownerId: true,
      teamId: true,
      // Free-trial gate (CHE-54): the plan is read fresh on every tick, so an
      // upgrade resumes the watch without anything else having to update it.
      // CHE-253: it is the TEAM's plan — the watch is paid for by the team, not
      // by whoever happened to enable it.
      trialEndsAt: true,
      trialNoticeSentAt: true,
      team: { select: { plan: true } },
      // Owner-configured scope/notes live on the App; watch runs must carry
      // them (run #19 self-check submitted a real paid check because the
      // "don't press the button" scope hint never reached the agent).
      app: { select: { scopeHints: true, userNotes: true, focusAreas: true, targetKind: true, extensionId: true, extensionConfig: true } },
    },
  });

  const started: string[] = [];
  let skipped = 0;

  for (const watch of due) {
    if (started.length >= MAX_PER_TICK) break;

    try {
      if (shouldSkipWatch(watch, (watch.team?.plan ?? null) as UserPlan | null, now)) {
        skipped++;
        console.log(
          `[scheduler] watch ${watch.id} (${watch.appSlug}) skipped — free trial ended ` +
            `${watch.trialEndsAt?.toISOString()}, team still on free`,
        );
        await pauseExpiredTrial(env, bindings, watch, now);
        continue;
      }

      const inFlight = await env.db.run.count({
        where: { watchId: watch.id, status: { notIn: TERMINAL_STATUSES } },
      });
      if (inFlight > 0) {
        skipped++;
        console.log(`[scheduler] watch ${watch.id} skipped — ${inFlight} run(s) still in flight`);
        continue;
      }

      // The run this one gets diffed against: the watch's latest finished run.
      const baseline = await env.db.run.findFirst({
        where: { watchId: watch.id, status: "completed" },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });

      // CHE-327: a watch is a schedule that spends the team's balance. The
      // tick is admitted by the same gate every other start goes through, so
      // what the dashboard and the agent are told is left is what the
      // scheduler spends from. A legacy ownerless watch (teamId NULL) has no
      // balance and is left as it always ran.
      const plan = (watch.team?.plan ?? "free") as UserPlan;
      if (watch.teamId) {
        const admitted = await admitTeamCheck(env.db, { id: watch.teamId, plan }, watch.appSlug, now);
        if (!admitted.ok) {
          skipped++;
          console.log(`[scheduler] watch ${watch.id} (${watch.appSlug}) skipped — ${admitted.reason}`);
          await pauseBalanceUsedUp(env, bindings, { ...watch, teamId: watch.teamId, plan, reason: admitted.reason }, now);
          continue;
        }
      }

      // Claim before running: with nextRunAt already pushed forward, an
      // overlapping tick (or a retry of this one) can't start the same watch
      // twice. Crashing after the claim costs a skipped cycle, not a double spend.
      const hours = INTERVAL_HOURS[watch.frequency as WatchFrequency] || 24;
      await env.db.watch.update({
        where: { id: watch.id },
        data: { lastRunAt: now, nextRunAt: new Date(now.getTime() + hours * 60 * 60 * 1000) },
      });
      const run = await createWatchRun(env, watch, baseline?.id ?? null);

      await bindings.CHECK_RUN.create({ params: { runId: run.id } });
      started.push(run.id);
      console.log(`[scheduler] watch ${watch.id} (${watch.appSlug}) → run ${run.id}`);
    } catch (err) {
      // One bad watch must not take the whole tick down with it.
      console.error(
        `[scheduler] watch ${watch.id} failed to start: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return { started, skipped };
}

type DueWatch = {
  id: string;
  appSlug: string;
  targetUrl: string;
  notifyEmail: string | null;
  testEmail: string | null;
  testPasswordEnc: string | null;
  appId: string | null;
  ownerId: string | null;
  teamId: string | null;
  app: {
    scopeHints: string | null;
    userNotes: string | null;
    focusAreas: string | null;
    targetKind: string;
    extensionId: string | null;
    extensionConfig: string | null;
  } | null;
};

async function createWatchRun(
  env: AgentEnv,
  watch: DueWatch,
  baselineRunId: string | null,
): Promise<{ id: string }> {
  return env.db.run.create({
    data: {
      runNumber: await nextRunNumber(env.db),
      startedVia: "watch",
      targetUrl: watch.targetUrl,
      targetKind: watch.app?.targetKind ?? "website",
      extensionId: watch.app?.extensionId ?? null,
      extensionConfig: watch.app?.extensionConfig ?? null,
      appSlug: watch.appSlug,
      testEmail: watch.testEmail,
      testPasswordEnc: watch.testPasswordEnc,
      // CHE-322: the app's named accounts, read from the app itself — the
      // Watch keeps a copy of the default login only (legacy), never these.
      testAccounts: await snapshotAppAccounts(env.db, {
        id: watch.appId,
        teamId: watch.teamId,
        targetKind: watch.app?.targetKind,
      }),
      notifyEmail: watch.notifyEmail,
      scopeHints: watch.app?.scopeHints ?? null,
      userNotes: watch.app?.userNotes ?? null,
      focusAreas: watch.app?.focusAreas ?? null,
      watchId: watch.id,
      baselineRunId,
      appId: watch.appId,
      ownerId: watch.ownerId,
      teamId: watch.teamId,
      status: "queued",
    },
    select: { id: true },
  });
}

// CHE-327: a watch whose team's balance is too low for another check. Like an
// ended trial, the pause is a consequence of the balance, not a state we
// write: the watch stays active, and the next tick after a top-up or the
// plan's next credit runs it. The team hears it once per window
// (balanceNoticeSentAt), not once per tick — by mail, because a watch that
// quietly stops is the one nobody notices until the thing it was watching
// breaks.
async function pauseBalanceUsedUp(
  env: AgentEnv,
  bindings: AgentBindings,
  watch: {
    id: string;
    appSlug: string;
    notifyEmail: string | null;
    ownerId: string | null;
    teamId: string;
    plan: UserPlan;
    reason: string;
  },
  now: Date,
): Promise<void> {
  // Same reason as TRIAL_RECHECK_HOURS: out of the head of the due queue, so
  // a paused team cannot starve every paying watch behind it. A top-up is
  // picked up within the hour.
  await env.db.watch.update({
    where: { id: watch.id },
    data: { nextRunAt: new Date(now.getTime() + TRIAL_RECHECK_HOURS * 60 * 60 * 1000) },
  });

  const team = await env.db.team.findUnique({ where: { id: watch.teamId }, select: { balanceNoticeSentAt: true } });
  // Free's credit never renews, so its notice goes once ever; a paid team's
  // once per UTC month.
  const windowStart = watch.plan === "free" ? new Date(0) : utcMonthStart(now);
  if (team?.balanceNoticeSentAt && team.balanceNoticeSentAt >= windowStart) return;

  try {
    // Counted once per window like the mail, so the event reads "a team's
    // watches ran dry this month", not "a tick happened".
    await captureBalanceExhausted(captureServer, {
      distinctId: watch.ownerId,
      teamId: watch.teamId,
      plan: watch.plan,
      source: "watch",
    });
    if (watch.notifyEmail) {
      await sendBalanceUsedUp({
        to: watch.notifyEmail,
        appSlug: watch.appSlug,
        reason: watch.reason,
        apiKey: bindings.EMAIL_API_KEY,
        from: bindings.EMAIL_FROM,
        baseUrl: bindings.APP_URL,
      });
    }
    // Stamped only after a successful send, like the trial notice — a
    // transient mail failure costs a retry next tick, not the notice.
    await env.db.team.update({ where: { id: watch.teamId }, data: { balanceNoticeSentAt: now } });
  } catch (err) {
    console.warn(
      `[scheduler] balance-used-up email for watch ${watch.id} failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// Housekeeping for a watch the trial gate just declined to run (CHE-54). The row
// stays active and untouched otherwise — pausing is a consequence of the plan,
// not a state we write — so upgrading is the only thing needed to resume it.
async function pauseExpiredTrial(
  env: AgentEnv,
  bindings: AgentBindings,
  watch: {
    id: string;
    appSlug: string;
    notifyEmail: string | null;
    trialNoticeSentAt: Date | null;
  },
  now: Date,
): Promise<void> {
  // Move it out of the head of the due queue first (see TRIAL_RECHECK_HOURS);
  // this has to happen even if the mail below fails.
  await env.db.watch.update({
    where: { id: watch.id },
    data: { nextRunAt: new Date(now.getTime() + TRIAL_RECHECK_HOURS * 60 * 60 * 1000) },
  });

  if (watch.trialNoticeSentAt || !watch.notifyEmail) return;

  try {
    await sendWatchTrialPaused({
      to: watch.notifyEmail,
      appSlug: watch.appSlug,
      apiKey: bindings.EMAIL_API_KEY,
      from: bindings.EMAIL_FROM,
      baseUrl: bindings.APP_URL,
    });
    // Stamped only after a successful send, so a transient Resend failure costs
    // a retry on the next tick rather than the notice itself.
    await env.db.watch.update({
      where: { id: watch.id },
      data: { trialNoticeSentAt: now },
    });
  } catch (err) {
    console.warn(
      `[scheduler] trial-paused email for watch ${watch.id} failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}
