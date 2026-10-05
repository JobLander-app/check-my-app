"use server";

import { refuseSelfCheck } from "@/lib/self-check-action";
import { requireActionScope } from "@/lib/team-auth";
import { markFindingSchema } from "@/lib/validation";
import { refreshOpenIssues } from "@/lib/open-issues";

// The owner's answer to a problem (CHE-360), written as a server action so the
// four marks work from the first HTML and need no second mutation path
// (docs/CODE_STANDARDS.md R5; Codex on #263). The finding is the problem's
// latest sighting — the one the next check and the tracker rules read
// (Finding.mark). It may be marked by anyone on the team the run belongs to,
// which is who the Issues page shows it to.
export type MarkFindingResult = { ok: true } | { error: string };

export async function markFinding(findingId: string, mark: string): Promise<MarkFindingResult> {
  // CHE-193: our own checker never marks a finding. First, before anything else.
  await refuseSelfCheck("/health/issues");
  const { user, db, team } = await requireActionScope("finding.mark");
  const parsed = markFindingSchema.safeParse({ mark });
  if (!parsed.success) return { error: "Invalid input" };

  const finding = await db.finding.findFirst({
    where: { id: findingId, run: { OR: [{ teamId: team.id }, { ownerId: user.id }] } },
    select: { id: true, run: { select: { appId: true } } },
  });
  if (!finding) return { error: "Problem not found" };

  await db.finding.update({ where: { id: finding.id }, data: { mark: parsed.data.mark } });
  // CHE-399: the number beside Issues follows the answer at once.
  await refreshOpenIssues(db, finding.run.appId);
  return { ok: true };
}
