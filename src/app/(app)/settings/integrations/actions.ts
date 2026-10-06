"use server";

import { redirect } from "next/navigation";
import { requireActionScope } from "@/lib/team-auth";
import { refuseSelfCheck } from "@/lib/self-check-action";
import { recordTeamEvent } from "@/lib/team-events";
import { mappingFromForm, saveRepoMapping } from "@/lib/github-mapping";

const BACK = "/settings/integrations";

// CHE-369: which app a repository deploys, and whether its deploys are
// checked. The same gate as connecting a tracker — turning it on lets the
// team's deploys start checks the team pays for.
export async function setGitHubRepo(formData: FormData) {
  await refuseSelfCheck(BACK);
  const { user, db, team } = await requireActionScope("integration.connect");
  const input = mappingFromForm(formData);
  if ("error" in input) redirect(`${BACK}?error=${encodeURIComponent(input.error)}#github`);
  const saved = await saveRepoMapping(db, team.id, input);
  if ("error" in saved) redirect(`${BACK}?error=${encodeURIComponent(saved.error)}#github`);
  await recordTeamEvent(db, {
    teamId: team.id,
    actorUserId: user.id,
    action: "integration.connected",
    subject: saved.repoFullName,
    summary:
      saved.appSlug && input.policy === "production"
        ? `checks every production deploy of ${saved.repoFullName} as ${saved.appSlug}`
        : saved.appSlug
          ? `maps ${saved.repoFullName} to ${saved.appSlug}, deploys not checked`
          : `unmapped ${saved.repoFullName}`,
  });
  redirect(`${BACK}?integration=github_mapped#github`);
}
