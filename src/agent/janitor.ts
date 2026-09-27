// Housekeeping for the self-check account (CHE-105).
//
// CheckMyApp checks CheckMyApp by signing in as a real account and using the
// product. That account is deliberately ordinary — the owner can sign in as it
// and see exactly what the agent saw — but everything it accumulates is
// disposable, and nobody should have to remember to tidy it.
//
// Twice now the absence of this cost real money: a placeholder app the agent
// registered was checked daily for two days, and a watch the owner had paused
// came back to life because the agent pressed resume while exploring. The
// guards for both exist now; this is the backstop that makes them unnecessary.
//
// Deliberately narrow: only accounts flagged isTestAccount, only apps older
// than the grace period (so a self-check that just ran is still inspectable),
// and never anything belonging to a real owner.

import type { AgentEnv } from "./env";
import { sweepExpiredEphemeralRuns, type EphemeralSweepResult } from "@/lib/ephemeral";

// Long enough that the owner can sign in after a nightly self-check and see
// what happened; short enough that nothing accumulates.
const GRACE_HOURS = 12;

export interface JanitorResult {
  appsRemoved: number;
  watchesRemoved: number;
  slugs: string[];
}

export async function sweepTestAccounts(env: AgentEnv, now: Date = new Date()): Promise<JanitorResult> {
  const cutoff = new Date(now.getTime() - GRACE_HOURS * 60 * 60 * 1000);
  await sweepOwnerlessSnapshots(env, cutoff);
  const stale = await env.db.app.findMany({
    where: { owner: { isTestAccount: true }, createdAt: { lt: cutoff } },
    select: { id: true, appSlug: true },
  });
  if (stale.length === 0) return { appsRemoved: 0, watchesRemoved: 0, slugs: [] };

  const ids = stale.map((a) => a.id);
  const watches = await env.db.watch.count({ where: { appId: { in: ids } } });

  // Runs are detached rather than deleted: their verdict pages are the record
  // of what the self-check saw, and they cost money to produce.
  await env.db.run.updateMany({ where: { appId: { in: ids } }, data: { appId: null, watchId: null } });
  await env.db.createdResource.updateMany({ where: { appId: { in: ids } }, data: { appId: null } });
  await env.db.issueLink.deleteMany({ where: { appId: { in: ids } } });
  // CHE-132: the page snapshots are the app's baseline for "did it change?".
  // Left behind, a re-registered self-check app would compare against a
  // history that is not its own (rule 6: self-check state is disposable, in
  // code).
  await env.db.appSnapshot.deleteMany({ where: { appId: { in: ids } } });
  await env.db.watch.deleteMany({ where: { appId: { in: ids } } });
  await env.db.ticketPolicy.deleteMany({ where: { appId: { in: ids } } });
  await env.db.trackerIntegration.deleteMany({ where: { appId: { in: ids } } });
  await env.db.repoIntegration.deleteMany({ where: { appId: { in: ids } } });
  // CHE-322: stored credentials never outlive the app they sign in to.
  await env.db.testAccount.deleteMany({ where: { appId: { in: ids } } });
  await env.db.app.deleteMany({ where: { id: { in: ids } } });

  console.log(
    `[janitor] removed ${stale.length} test-account app(s): ${stale.map((a) => a.appSlug).join(", ")}`,
  );
  return { appsRemoved: stale.length, watchesRemoved: watches, slugs: stale.map((a) => a.appSlug) };
}

// CHE-132: a signed-in one-off check has an owner but no App row, so the
// snapshot it takes carries no appId and the app-keyed delete above never
// reaches it. Those rows cannot be keyed by hostname either: rows without an
// appId are the shared history of every anonymous check of that host, by
// design, and deleting them by slug would erase other people's baselines. The
// only key that is the test account's alone is the run that took the
// snapshot. Bounded to runs that still point at one, and the pointer is
// cleared afterwards so the set never grows.
// A $1 check nobody paid for (src/lib/one-check.ts): the parked form input —
// including an encrypted test password — outlives its Checkout Session by
// nothing. Rows that never got a run are deleted once past their expiry; a
// row with a run is the payment's record and stays. Same shape as the sweeps
// above: narrow, on every tick, never fails the tick.
export async function sweepExpiredPendingChecks(env: AgentEnv, now: Date = new Date()): Promise<number> {
  const { count } = await env.db.pendingCheck.deleteMany({
    where: { runId: null, expiresAt: { lt: now } },
  });
  if (count > 0) console.log(`[janitor] removed ${count} expired unpaid pending check(s)`);
  return count;
}

// CHE-202: ephemeral runs (a PR preview is a run, not an app) past their
// expiresAt, deleted outright with their evidence — the one kind of run we
// delete, because the target it describes is gone too. The rule and the sweep
// live in src/lib/ephemeral.ts; this is the tick's call, with the bucket the
// objects live in. Same shape as the sweeps above: narrow, every tick, never
// fails the tick (the caller wraps it).
export async function sweepExpiredEphemeral(env: AgentEnv, now: Date = new Date()): Promise<EphemeralSweepResult> {
  const result = await sweepExpiredEphemeralRuns(env.db, now, env.bindings.EVIDENCE);
  if (result.runs > 0) {
    console.log(`[janitor] removed ${result.runs} expired ephemeral run(s), ${result.evidence} object(s)`);
  }
  return result;
}

async function sweepOwnerlessSnapshots(env: AgentEnv, cutoff: Date): Promise<void> {
  const runs = await env.db.run.findMany({
    where: {
      owner: { isTestAccount: true },
      appId: null,
      snapshotId: { not: null },
      createdAt: { lt: cutoff },
    },
    select: { id: true },
  });
  if (runs.length === 0) return;
  const runIds = runs.map((r) => r.id);
  await env.db.appSnapshot.deleteMany({ where: { appId: null, runId: { in: runIds } } });
  await env.db.run.updateMany({ where: { id: { in: runIds } }, data: { snapshotId: null } });
}
