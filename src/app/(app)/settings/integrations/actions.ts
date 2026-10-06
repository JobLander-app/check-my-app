"use server";

import { redirect } from "next/navigation";
import { requireActionScope } from "@/lib/team-auth";
import { refuseSelfCheck } from "@/lib/self-check-action";
import { recordTeamEvent } from "@/lib/team-events";
import { mappingEventSummary, mappingFromForm, saveRepoMapping } from "@/lib/github-mapping";

const BACK = "/settings/integrations";

// CHE-369: which app a repository deploys, and whether its deploys are
// checked. The same gate as connecting a tracker — turning it on lets the
// team's deploys start checks the team pays for. A refusal travels as a
// code, resolved on the page against the guarded sentences.
export async function setGitHubRepo(formData: FormData) {
  await refuseSelfCheck(BACK);
  const { user, db, team } = await requireActionScope("integration.connect");
  const input = mappingFromForm(formData);
  if ("error" in input) redirect(`${BACK}?github_error=${input.error}#github`);
  const saved = await saveRepoMapping(db, team.id, input);
  if ("error" in saved) redirect(`${BACK}?github_error=${saved.error}#github`);
  await recordTeamEvent(db, {
    teamId: team.id,
    actorUserId: user.id,
    action: "integration.connected",
    subject: saved.repoFullName,
    summary: mappingEventSummary({ repoFullName: saved.repoFullName, appSlug: saved.appSlug, policy: input.policy }),
  });
  redirect(`${BACK}?integration=github_mapped#github`);
}
