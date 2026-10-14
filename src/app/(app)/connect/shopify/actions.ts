"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireActionScope } from "@/lib/team-auth";
import { refuseSelfCheck } from "@/lib/self-check-action";
import { appPath } from "@/lib/app-shell";
import { connectApp } from "@/lib/shopify-connect";
import type { UserPlan } from "@/lib/enums";

// CHE-333: a Shopify app is connected by the link to it inside the store's
// admin — the store and the app are both read from it; the person then signs
// in to that store on our page and the app is picked up (sign-in/actions.ts).
// CHE-482: `shopify.store.connect`, which a member has — the store is the
// person's own, opened with their own Shopify sign-in. The origins it allows
// are fixed (the admin, then the one the app is read to be served from), never
// typed in, which is what kept allowed origins an admin's.
export async function connectShopifyApp(_previous: { error: string } | null, formData: FormData): Promise<{ error: string } | null> {
  await refuseSelfCheck("/connect/shopify");
  const { user, db, team } = await requireActionScope("shopify.store.connect");
  const result = await connectApp(db, { userId: user.id, teamId: team.id, plan: team.plan as UserPlan }, String(formData.get("link") ?? ""));
  if (!("ok" in result)) {
    // A refusal is the person's to read, and ours to see: the owner's first
    // try (2026-10-06 15:59 UTC) was refused and nothing in the logs said so.
    console.log(`[connect-shopify] refused team=${team.id} code=${result.code}: ${result.error}`);
    return { error: result.error };
  }
  console.log(`[connect-shopify] team=${team.id} app=${result.appId} store=${result.store} handle=${result.handle} reused=${result.reused} connected=${result.connected}`);
  if (!result.reused) revalidatePath("/", "layout");
  redirect(result.connected ? appPath.page(result.appId) : appPath.signIn(result.appId));
}
