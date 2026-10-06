"use server";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { revalidatePath } from "next/cache";
import { requireActionScope } from "@/lib/team-auth";
import { refuseSelfCheck } from "@/lib/self-check-action";
import { appPath } from "@/lib/app-shell";
import { verifyPick } from "@/lib/session-view";
import { chooseApp } from "@/lib/shopify-connect";
import { startSavedApp } from "@/lib/start-saved-app";
import { recordTeamEvent } from "@/lib/team-events";
import type { UserPlan } from "@/lib/enums";

// CHE-333: the person picked their app on the sign-in page; the session host
// signed what it read (its handle, name and the origin it is served from). We
// save it and start its first check. `app.credentials.write`: what is saved
// names where a check of this app may act, the same rule as allowed origins on
// the settings page (createActionFor).
export async function chooseShopifyApp(appId: string, pickToken: string): Promise<{ error: string; href?: string } | { runHref: string; appHref: string }> {
  await refuseSelfCheck(appPath.signIn(appId));
  const { user, db, team } = await requireActionScope("app.credentials.write");
  const { env } = getCloudflareContext();
  const secret = (env as unknown as { SESSION_VIEW_SECRET?: string }).SESSION_VIEW_SECRET;
  const pick = secret ? await verifyPick(secret, pickToken) : null;
  if (!pick) return { error: "That choice has expired. Choose the app again." };
  const actor = { userId: user.id, teamId: team.id, plan: team.plan as UserPlan };
  const chosen = await chooseApp(db, actor, appId, pick);
  if (!("ok" in chosen)) return { error: chosen.error, ...(chosen.appId ? { href: appPath.page(chosen.appId) } : {}) };
  await recordTeamEvent(db, {
    teamId: team.id,
    actorUserId: user.id,
    action: "app.created",
    subject: chosen.appSlug,
    summary: `connected ${pick.name} in ${pick.store}`,
  });
  revalidatePath("/", "layout");
  const run = await startSavedApp(db, { id: user.id, teamId: team.id, plan: team.plan as UserPlan }, appId);
  if ("error" in run) return { error: run.error, href: appPath.page(appId) };
  return { runHref: `/run/${run.publicId}`, appHref: appPath.page(appId) };
}
