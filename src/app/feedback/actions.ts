"use server";

// CHE-434: a report of the check's mistake from the page. The same giveFeedback
// the MCP `report_check_mistake` tool calls, so the two doors cannot disagree.

import { revalidatePath } from "next/cache";
import { requireActionScope } from "@/lib/team-auth";
import { refuseSelfCheck } from "@/lib/self-check-action";
import { giveFeedback, type FeedbackTarget } from "@/lib/feedback";
import { teamFeatures } from "@/lib/team-features";

export type FeedbackFormState = { error?: string; sent?: boolean } | null;

// `back` is bound on the page but arrives from the browser like any argument,
// so only a verdict's own address is ever revalidated.
const VERDICT_PAGE = /^\/(verdict\/[A-Za-z0-9_-]+|health\/apps\/[A-Za-z0-9_-]+\/checks\/\d+)$/;

export async function giveFeedbackAction(
  target: FeedbackTarget,
  back: string,
  _prev: FeedbackFormState,
  formData: FormData,
): Promise<FeedbackFormState> {
  await refuseSelfCheck(VERDICT_PAGE.test(back) ? back : "/");
  if (!VERDICT_PAGE.test(back)) return { error: "This page cannot take a report." };
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
