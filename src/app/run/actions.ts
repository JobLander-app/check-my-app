"use server";

// CHE-454: the Stop button on a live check. The run's own team decides — a
// member or an admin of the team the run belongs to, whichever team the person
// is acting as right now — through the same cancelRun as MCP cancel_check.

import { revalidatePath } from "next/cache";
import { getDbFromContext } from "@/lib/db";
import { getOptionalUser } from "@/lib/auth";
import { cancelRun } from "@/lib/run-cancel";
import { terminateRun } from "@/lib/trigger";
import { publicRow } from "@/lib/tenant-db";
import { refuseSelfCheck } from "@/lib/self-check-action";
import type { TeamScope } from "@/lib/scopes";

export type StopState = { error?: string; stopped?: boolean } | null;

export async function stopRunAction(publicId: string): Promise<StopState> {
  await refuseSelfCheck(`/run/${publicId}`);
  const db = await getDbFromContext();
  const user = await getOptionalUser(db);
  if (!user) return { error: "Sign in to stop a check." };
  const run = await db.run.findUnique({ ...publicRow(), where: { publicId }, select: { teamId: true } });
  if (!run?.teamId) return { error: "This check cannot be stopped from here." };
  const member = await db.membership.findFirst({ where: { teamId: run.teamId, userId: user.id }, select: { scope: true } });
  if (!member) return { error: "Only the team this check belongs to can stop it." };
  const result = await cancelRun(
    db,
    { userId: user.id, teamId: run.teamId, scope: member.scope as TeamScope, name: user.name?.trim() || user.email },
    publicId,
    terminateRun,
  );
  if (!result.ok) return { error: result.error };
  revalidatePath(`/run/${publicId}`);
  return { stopped: true };
}
