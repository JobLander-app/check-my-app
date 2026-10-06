// CHE-426: one browser per team on the session host. A team's Shopify sign-in
// lives in its own slot — its own Chrome there (spikes/shopify-session:
// session-slot-chrome@<n>) — so one team never signs in over another's, never
// sees another's admin, and its checks lease only its own browser.
//
// The table holds the slots the host is provisioned with (migration 0060 seeds
// "main" — ours — and 1..3). A team is given a free slot the first time it
// connects a Shopify app, and keeps it.
//
// Shared by the web worker (connect, the sign-in page's view token) and the
// agent (the slot its session lease names), so nothing here is Next-only.

import type { PrismaClient } from "@/generated/prisma/client";
import { alreadyScoped, teamOwned, teamRows } from "@/lib/tenant-db";

/** The team's slot, or null when it has none. */
export async function slotOfTeam(db: PrismaClient, teamId: string): Promise<string | null> {
  const row = await db.sessionSlot.findFirst({ where: { ...teamOwned(teamId) }, select: { slot: true } });
  return row?.slot ?? null;
}

/**
 * The team's slot, giving it a free one if it has none; null when every slot
 * is taken. One statement claims the slot (D1 has no transactions): it only
 * writes a row that is still free, and the unique team key refuses a second
 * slot for a team that raced itself — in both cases the answer is read back.
 */
export async function claimSlot(db: PrismaClient, teamId: string): Promise<string | null> {
  const held = await slotOfTeam(db, teamId);
  if (held) return held;
  try {
    await db.$executeRaw`UPDATE "SessionSlot" SET "teamId" = ${teamRows(teamId)}, "assignedAt" = CURRENT_TIMESTAMP
      WHERE "slot" = (SELECT "slot" FROM "SessionSlot" WHERE "teamId" IS NULL ORDER BY "slot" LIMIT 1) AND "teamId" IS NULL`;
  } catch {
    // The team took a slot in a parallel request: the unique key said so.
  }
  return slotOfTeam(db, teamId);
}

export class NoSessionSlotError extends Error {
  constructor(teamId: string | null) {
    super(`internal: no session slot for team ${teamId ?? "(none)"}`);
    this.name = "NoSessionSlotError";
  }
}

/** The slot a session run of this team leases. Never another team's, never a guess. */
export async function sessionSlotForRun(db: PrismaClient, runId: string): Promise<string> {
  const run = await db.run.findUnique({ ...alreadyScoped("already read in this request"), where: { id: runId }, select: { teamId: true } });
  const slot = run?.teamId ? await slotOfTeam(db, run.teamId) : null;
  if (!slot) throw new NoSessionSlotError(run?.teamId ?? null);
  return slot;
}
