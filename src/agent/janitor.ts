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
import { isSelfUrl } from "./self-hosts";

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
  await removeApps(env, ids);

  console.log(
    `[janitor] removed ${stale.length} test-account app(s): ${stale.map((a) => a.appSlug).join(", ")}`,
  );
  return { appsRemoved: stale.length, watchesRemoved: watches, slugs: stale.map((a) => a.appSlug) };
}

// What removing an App takes with it, in the order the foreign keys allow.
// Shared by the test-account sweep and the self-check leftover sweep so the two
// can never disagree about what an app's removal leaves behind.
async function removeApps(env: AgentEnv, ids: string[]): Promise<void> {
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
}

// Leftovers of a self-check that ran under an ordinary account.
//
// sweepTestAccounts keys on who owns the app, and checkmyapp.dev is checked as
// the owner's own account (CLAUDE.md §6: a self-check is identified by its
// target, not by whose account owns the row). So an app the checker registered
// there — "CheckMyApp test r113", from a run before the self-check guard made
// our hosts read-only — was never swept, its ledger row stayed open, and every
// later run of our own product found the same row and filed the same
// "[Checker gap] Checker leaves test records behind" again: 60 comments over
// six weeks about one record, no run of which had created anything.
//
// The ledger row is the evidence of what the checker made, and the marker it
// carries is unique to one run ("CheckMyApp test r<N>"), so the app is found by
// that marker — never by "looks like a test" — inside the account that ran the
// check. Only records of kind "app" are removed: the App table is the one place
// such a record lives, so finding no match means it is already gone and the
// ledger can say so. Every other kind of record stays open, because we cannot
// reach it from here and closing it would hide a real leftover.
const LEFTOVER_KIND = "app";
const MARKER_PREFIX = "CheckMyApp test r";
const LEFTOVER_BATCH = 200;

export interface LeftoverSweepResult {
  appsRemoved: number;
  ledgerClosed: number;
}

// Both a marker and a name/slug are folded to lower-case words so that
// "CheckMyApp test r113" is found in "checkmyapp-test-r113.example.com" — and
// r11 is not found in r113: the marker must end where a word ends.
function words(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function carriesMarker(text: string, marker: string): boolean {
  const m = words(marker);
  if (!m) return false;
  return `-${words(text)}-`.includes(`-${m}-`);
}

// The ledger holds every record every run ever made, and most open rows are
// not ours to close (a customer's run, a kind we cannot reach). Those rows sort
// first forever, so a single batch of the oldest ones could be all of them and
// the eligible row behind them would never be seen. The query keeps out what
// SQL can tell (a run with an owner, a kind that mentions "app"); whether the
// target is one of our own hosts is a list in the environment, so it is judged
// in code — and the sweep walks the ledger batch by batch until it is read to
// the end. The page cap keeps one tick bounded however long the ledger grows.
const LEFTOVER_MAX_PAGES = 50;

export async function sweepSelfCheckLeftovers(env: AgentEnv, now: Date = new Date()): Promise<LeftoverSweepResult> {
  const cutoff = new Date(now.getTime() - GRACE_HOURS * 60 * 60 * 1000);
  const total: LeftoverSweepResult = { appsRemoved: 0, ledgerClosed: 0 };
  let after: string | null = null;
  for (let page = 0; page < LEFTOVER_MAX_PAGES; page++) {
    const open: LedgerRow[] = await env.db.createdResource.findMany({
      where: {
        deletedAt: null,
        createdAt: { lt: cutoff },
        marker: { startsWith: MARKER_PREFIX },
        kind: { contains: LEFTOVER_KIND },
        run: { ownerId: { not: null } },
      },
      select: {
        id: true,
        kind: true,
        marker: true,
        run: { select: { targetUrl: true, ownerId: true, teamId: true } },
      },
      // The id breaks ties, so the cursor names one place in the order.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: LEFTOVER_BATCH,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    });
    if (open.length === 0) break;
    after = open[open.length - 1].id;

    const done = await sweepLeftoverBatch(env, open, now);
    total.appsRemoved += done.appsRemoved;
    total.ledgerClosed += done.ledgerClosed;
    if (open.length < LEFTOVER_BATCH) break;
  }
  return total;
}

interface LedgerRow {
  id: string;
  kind: string;
  marker: string;
  run: { targetUrl: string; ownerId: string | null; teamId: string | null };
}

async function sweepLeftoverBatch(env: AgentEnv, open: LedgerRow[], now: Date): Promise<LeftoverSweepResult> {
  const ours = open.filter(
    (r) =>
      r.kind.trim().toLowerCase() === LEFTOVER_KIND &&
      r.run.ownerId !== null &&
      isSelfUrl(r.run.targetUrl, env.bindings.SELF_CHECK_HOSTS),
  );
  if (ours.length === 0) return { appsRemoved: 0, ledgerClosed: 0 };

  const ownerIds = [...new Set(ours.map((r) => r.run.ownerId as string))];
  // "contains", not "startsWith": the agent names an app as it likes ("My
  // CheckMyApp test r113"), and the marker, checked word by word below, is what
  // decides — the query only has to not hide the app from it.
  const candidates = await env.db.app.findMany({
    where: {
      ownerId: { in: ownerIds },
      OR: [{ appSlug: { contains: "checkmyapp-test-" } }, { name: { contains: "CheckMyApp test" } }],
    },
    select: { id: true, appSlug: true, name: true, ownerId: true, teamId: true },
  });

  const removeIds = new Set<string>();
  const removedSlugs: string[] = [];
  for (const r of ours) {
    for (const a of candidates) {
      if (a.ownerId !== r.run.ownerId) continue;
      if (r.run.teamId && a.teamId && a.teamId !== r.run.teamId) continue;
      if (!carriesMarker(a.appSlug, r.marker) && !(a.name && carriesMarker(a.name, r.marker))) continue;
      if (!removeIds.has(a.id)) removedSlugs.push(a.appSlug);
      removeIds.add(a.id);
    }
  }
  if (removeIds.size > 0) await removeApps(env, [...removeIds]);

  // Closed with what happened, so the ledger stays a record and not a blank.
  await env.db.createdResource.updateMany({
    where: { id: { in: ours.map((r) => r.id) } },
    data: { deletedAt: now, cleanupNote: "removed by the janitor — a record of a past self-check" },
  });

  console.log(
    `[janitor] closed ${ours.length} self-check ledger row(s), removed ${removeIds.size} app(s)` +
      `${removedSlugs.length ? `: ${removedSlugs.join(", ")}` : ""}`,
  );
  return { appsRemoved: removeIds.size, ledgerClosed: ours.length };
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
