"use server";

// CHE-434: a report of the check's mistake from the page. The same giveFeedback
// the MCP `report_check_mistake` tool calls, so the two doors cannot disagree.

import { revalidatePath } from "next/cache";
import { requireActionScope } from "@/lib/team-auth";
import { refuseSelfCheck } from "@/lib/self-check-action";
import { giveFeedback, type FeedbackTarget } from "@/lib/feedback";
import { teamFeatures } from "@/lib/team-features";

export type FeedbackFormState = { error?: string; sent?: boolean } | null;

export async function giveFeedbackAction(
  target: FeedbackTarget,
  back: string,
  _prev: FeedbackFormState,
  formData: FormData,
): Promise<FeedbackFormState> {
  await refuseSelfCheck(back);
  const { user, db, team, scope } = await requireActionScope("feedback.write");
  const result = await giveFeedback(
    db,
    { userId: user.id, teamId: team.id, scope, features: await teamFeatures(db, team.id) },
    { target, reason: String(formData.get("reason") ?? ""), text: String(formData.get("text") ?? "") },
  );
  if (!result.ok) return { error: result.error };
  revalidatePath(back);
  return { sent: true };
}
