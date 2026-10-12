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
import { teamOwned } from "@/lib/tenant-db";
import { priceRun, voidRunPrice } from "@/agent/pricing";

export const IN_FLIGHT = ["queued", "connecting", "surface_scan", "discovery", "walking", "anatomy", "writing"] as const;

/** What the feed says, and what the customer reads: who stopped it, and that it costs nothing. */
export function stoppedLine(who: string): string {
  return `Stopped by ${who} before it finished — nothing was published, and it costs nothing.`;
}

export type CancelActor = { userId: string; teamId: string; scope: TeamScope; name: string };

export type CancelResult =
  | { ok: true; runId: string; publicId: string; was: string }
  | { ok: false; code: "forbidden" | "not_found" | "invalid_input"; error: string };

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
  const run = await db.run.findFirst({ where: { ...teamOwned(actor.teamId), publicId }, select: { id: true, status: true, events: true } });
  if (!run) return { ok: false, code: "not_found", error: "Check not found in this team." };
  if (!(IN_FLIGHT as readonly string[]).includes(run.status)) {
    return { ok: false, code: "invalid_input", error: `This check has already finished (${run.status}); there is nothing to stop.` };
  }
  let events: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(run.events ?? "[]");
    if (Array.isArray(parsed)) events = parsed;
  } catch {
    events = [];
  }
  events.push({ at: now.toISOString(), phase: run.status, icon: "warn", text: stoppedLine(actor.name) });
  const moved = await db.run.updateMany({
    where: { id: run.id, status: { in: [...IN_FLIGHT] } },
    data: { status: "canceled", completedAt: now, currentAction: null, errorMessage: `canceled by ${actor.name}`, events: JSON.stringify(events) },
  });
  if (moved.count !== 1) {
    return { ok: false, code: "invalid_input", error: "This check finished just now; there is nothing to stop." };
  }
  // $0, and any bought balance a price had taken goes back. Never fatal.
  await priceRun(db, run.id)
    .then(() => voidRunPrice(db, run.id))
    .catch((e) => console.warn(`[cancel] zeroing ${run.id} did not happen: ${e instanceof Error ? e.message : String(e)}`));
  await terminate(run.id).catch((e) => console.warn(`[cancel] terminating ${run.id}: ${e instanceof Error ? e.message : String(e)}`));
  return { ok: true, runId: run.id, publicId, was: run.status };
}
