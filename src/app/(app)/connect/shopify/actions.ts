"use server";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireActionScope } from "@/lib/team-auth";
import { refuseSelfCheck } from "@/lib/self-check-action";
import { appPath } from "@/lib/app-shell";
import { connectStore } from "@/lib/shopify-connect";
import type { UserPlan } from "@/lib/enums";

// CHE-333: a Shopify app is connected by its store; the person then signs in to
// that store on our page and picks the app (sign-in/actions.ts). The pending
// app allows admin.shopify.com, so this is `app.credentials.write` like any
// app added with allowed origins (createActionFor).
export async function connectShopifyStore(_previous: { error: string } | null, formData: FormData): Promise<{ error: string } | null> {
  await refuseSelfCheck("/connect/shopify");
  const { user, db, team } = await requireActionScope("app.credentials.write");
  const { env } = getCloudflareContext();
  const result = await connectStore(
    db,
    { userId: user.id, teamId: team.id, plan: team.plan as UserPlan },
    env as unknown as { SESSION_TEAMS?: string },
    String(formData.get("store") ?? ""),
  );
  if (!("ok" in result)) return { error: result.error };
  if (!result.reused) revalidatePath("/", "layout");
  redirect(appPath.signIn(result.appId));
}
