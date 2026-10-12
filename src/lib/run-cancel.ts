// CHE-454: a started check can be stopped — by MCP cancel_check(run_id) and
// by the Stop button on the live check. Owner, 2026-10-12: if an agent started
// the wrong thing, the check otherwise runs its 20–40 minutes and spends time
// and money. A stopped check costs $0: its unfinished work is on us.
//
// Order matters. The row moves to "canceled" FIRST, fenced on the run still
// being unfinished — every later write of the workflow is fenced the other way
// (src/agent/workflow.ts: transition, the verdict write, the final status), so
// a step that ends after the cancel cannot write a verdict over it. Then the
// Workflow instance is terminated, so no further step runs and nothing more is
// spent. A session host's lease the run held is released by the scheduler's
// next tick (src/agent/scheduler.ts), since only the agent worker reaches it.

import type { PrismaClient } from "@/generated/prisma/client";
import { can, type TeamScope } from "@/lib/scopes";
import { alreadyScoped, systemWide, teamOwned } from "@/lib/tenant-db";
import { clearedCredentials } from "@/lib/test-accounts";
import { priceRun, voidRunPrice } from "@/agent/pricing";

// What a fenced write throws when the run was stopped meanwhile. The workflow
// recognises it by name or message and ends the run without writing more.
export const RUN_CANCELED = "the check was stopped by its team; nothing more is written";
export class RunCanceledError extends Error {
  constructor() {
    super(RUN_CANCELED);
    this.name = "RunCanceled";
  }
}

export const IN_FLIGHT =["queued", "connecting", "surface_scan", "discovery", "walking", "anatomy", "writing"] as const;

/** What the feed says, and what the customer reads: who stopped it, and that it costs nothing. */
export function stoppedLine(who: string): string {
  return `Stopped by ${who} before it finished — nothing was published, and it costs nothing.`;
}

export type CancelActor = { userId: string; teamId: string; scope: TeamScope; name: string };

export type CancelResult =
  | { ok: true; runId: string; publicId: string; was: string }
  | { ok: false; code: "forbidden" | "not_found" | "invalid_input"; error: string };

/** Why a check cannot be stopped midway, or null when it can. */
export function unstoppableReason(run: { targetKind: string; app: { writeMode: string } | null }): string | null {
  if (run.targetKind === "extension") {
    return "An extension check cannot be stopped midway: it holds a browser session that only its own end releases. It finishes on its own.";
  }
  if (run.app?.writeMode === "create_cleanup") {
    return "This check may create test records and removes them at its end, so it cannot be stopped midway. It finishes on its own.";
  }
  return null;
}

export async function cancelRun(
  db: PrismaClient,
  actor: CancelActor,
  publicId: string,
  terminate: (runId: string) => Promise<void>,
  now: Date = new Date(),
): Promise<CancelResult> {
  if (!can(actor.scope, "run.start")) {
    return { ok: false, code: "forbidden", error: "Your access to this team is read-only. An admin or a member who can start checks can stop one." };
  }
  const run = await db.run.findFirst({
    where: { ...teamOwned(actor.teamId), publicId },
    select: { id: true, status: true, events: true, watchId: true, testAccounts: true, targetKind: true, app: { select: { writeMode: true } } },
  });
  if (!run) return { ok: false, code: "not_found", error: "Check not found in this team." };
  if (!(IN_FLIGHT as readonly string[]).includes(run.status)) {
    return { ok: false, code: "invalid_input", error: `This check has already finished (${run.status}); there is nothing to stop.` };
  }
  // Two kinds of check clean up after themselves at their own end, and that end
  // is what a stop would cut off (Codex on #329): an extension check holds a
  // paid browser session only its own disposal releases, and a check allowed to
  // create records deletes them and audits what it made last. Stopped midway,
  // either would leave something behind in the customer's account. Until their
  // cleanup can run on a stop, they run to their end — said, not silently.
  const unstoppable = unstoppableReason(run);
  if (unstoppable) return { ok: false, code: "invalid_input", error: unstoppable };
  let events: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(run.events ?? "[]");
    if (Array.isArray(parsed)) events = parsed;
  } catch {
    events = [];
  }
  events.push({ at: now.toISOString(), phase: run.status, icon: "warn", text: stoppedLine(actor.name) });
  // A one-off check forgets its passwords when it ends, and a stopped one ends
  // here — its workflow is terminated and never reaches its own cleanup. A
  // watch's run keeps them for the watch's next check, as on every other path.
  const cleared = run.watchId ? {} : clearedCredentials(run);
  const moved = await db.run.updateMany({
    ...alreadyScoped("already read in this request"),
    where: { id: run.id, status: { in: [...IN_FLIGHT] } },
    data: {
      status: "canceled",
      completedAt: now,
      currentAction: null,
      errorMessage: `canceled by ${actor.name}`,
      events: JSON.stringify(events),
      ...cleared,
    },
  });
  if (moved.count !== 1) {
    return { ok: false, code: "invalid_input", error: "This check finished just now; there is nothing to stop." };
  }
  // $0, and any bought balance a price had taken goes back. If it fails here,
  // the scheduler's next tick does it (settleCanceledPrices) — the refund does
  // not depend on this request getting through (Codex on #329).
  await zeroCanceledPrice(db, run.id).catch((e) => console.warn(`[cancel] zeroing ${run.id} deferred to the tick: ${e instanceof Error ? e.message : String(e)}`));
  await terminate(run.id).catch((e) => console.warn(`[cancel] terminating ${run.id}: ${e instanceof Error ? e.message : String(e)}`));
  return { ok: true, runId: run.id, publicId, was: run.status };
}

/** A stopped check's price is 0, and bought balance a price took goes back. Idempotent. */
export async function zeroCanceledPrice(db: PrismaClient, runId: string): Promise<void> {
  await priceRun(db, runId);
  await voidRunPrice(db, runId);
}

/**
 * The scheduler's half of the refund: every stopped check whose price is not
 * yet 0 — the stop's own zeroing failed, or a priced step landed after it — is
 * zeroed on the next tick. Returns the runs it settled.
 */
export async function settleCanceledPrices(db: PrismaClient): Promise<string[]> {
  const rows = await db.run.findMany({
    ...systemWide("scheduler"),
    where: { status: "canceled", teamId: { not: null }, OR: [{ priceUsd: null }, { priceUsd: { not: 0 } }] },
    select: { id: true },
    take: 50,
  });
  const settled: string[] = [];
  for (const r of rows) {
    try {
      await zeroCanceledPrice(db, r.id);
      settled.push(r.id);
    } catch (e) {
      console.warn(`[cancel] settling ${r.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return settled;
}
