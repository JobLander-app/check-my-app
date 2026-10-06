// CHE-333: connecting a Shopify app is not connecting a website. A Shopify app
// developer has no "address of the app": the app lives inside their store's
// admin, in a frame whose origin they never think about, behind a sign-in our
// checker must never perform. So the input is the STORE, and the rest is read
// from the admin after the person signs in on our page (CHE-419):
//
//   1. connectStore — the store becomes a pending app (kind "session", slug
//      shopify:<store>, its daily check off) and the person is sent to sign in;
//   2. chooseApp — after sign-in, the session host lists the store's installed
//      apps; the person picks one, the host reads the origin it is served from
//      and signs what it read; we save it (slug shopify:<store>/<handle>, the
//      admin and the app's origin allowed), switch the daily check on and
//      start the first one.
//
// One implementation behind the site's pages and MCP create_app.

import type { PrismaClient } from "@/generated/prisma/client";
import { createAppForTeam, type AppActor, type AppRefusal } from "@/lib/app-settings";
import { parseAllowedOriginsInput, serializeAllowedOrigins } from "@/lib/allowed-origins";
import { alreadyScoped, teamOwned } from "@/lib/tenant-db";
import { enableWatchForApp } from "@/lib/watch-enable";
import { isPendingShopifyApp, parseStoreInput, shopifyAdminUrl, shopifySlug, storeOfAdminUrl, type Pick } from "@/lib/session-view";

export const SHOPIFY_ADMIN_ORIGIN = "https://admin.shopify.com";

// Which teams the session host serves today. One browser holds one Shopify
// sign-in, so until each team has its own (CHE-333, "one browser per team")
// a store is connected only for the teams named in SESSION_TEAMS.
export function sessionTeamAllowed(env: { SESSION_TEAMS?: string }, teamId: string): boolean {
  return (env.SESSION_TEAMS ?? "").split(",").map((t) => t.trim()).filter(Boolean).includes(teamId);
}
export const NOT_OPEN_YET = "Checking Shopify apps is not open for your team yet.";
export const BAD_STORE = "Enter your store — its name, like my-store, or its address, like my-store.myshopify.com.";

export async function connectStore(
  db: PrismaClient,
  actor: AppActor,
  env: { SESSION_TEAMS?: string },
  rawStore: string,
): Promise<{ ok: true; appId: string; store: string; reused: boolean } | AppRefusal> {
  if (!sessionTeamAllowed(env, actor.teamId)) return { error: NOT_OPEN_YET, code: "invalid_input" };
  const store = parseStoreInput(rawStore);
  if (!store) return { error: BAD_STORE, code: "invalid_input" };
  // A store already waiting for its app is the same pending app: opening the
  // connect page twice must not leave two.
  const pending = await db.app.findFirst({ where: { ...teamOwned(actor.teamId), appSlug: shopifySlug(store) }, select: { id: true } });
  if (pending) return { ok: true, appId: pending.id, store, reused: true };
  const created = await createAppForTeam(db, actor, {
    targetUrl: shopifyAdminUrl(store),
    session: { slug: shopifySlug(store) },
    allowedOrigins: [SHOPIFY_ADMIN_ORIGIN],
  });
  if (!("ok" in created)) return created;
  return { ok: true, appId: created.app.id, store, reused: false };
}

export type ChooseResult =
  | { ok: true; appId: string; appSlug: string; watchRefused?: string }
  | { error: string; code: "invalid_input" | "not_found" | "duplicate"; appId?: string };

// Saves the app the person picked on the sign-in page. `pick` is what the host
// signed (verifyPick); its store must be this app's store.
export async function chooseApp(db: PrismaClient, actor: AppActor, appId: string, pick: Pick): Promise<ChooseResult> {
  const app = await db.app.findFirst({
    where: { ...teamOwned(actor.teamId), id: appId },
    select: { id: true, targetUrl: true, targetKind: true, appSlug: true },
  });
  if (!app || app.targetKind !== "session") return { error: "App not found.", code: "not_found" };
  const store = storeOfAdminUrl(app.targetUrl);
  if (!store || store !== pick.store) return { error: "That app belongs to another store.", code: "invalid_input" };
  // Only a store still waiting for its app takes a choice: a connected app is
  // not repointed at another one by a stale page.
  if (!isPendingShopifyApp(app)) return { error: "This store's app is already chosen.", code: "invalid_input" };
  const origins = parseAllowedOriginsInput([SHOPIFY_ADMIN_ORIGIN, pick.origin]);
  if (!origins.ok) return { error: "This app cannot be checked: the address it is served from is not one we can open.", code: "invalid_input" };
  const appSlug = shopifySlug(store, pick.handle);
  const other = await db.app.findFirst({ where: { ...teamOwned(actor.teamId), appSlug, NOT: { id: app.id } }, select: { id: true } });
  if (other) return { error: `${pick.name} is already connected.`, code: "duplicate", appId: other.id };
  const targetUrl = shopifyAdminUrl(store, pick.handle);
  await db.app.update({
    ...alreadyScoped("the App was just scoped to this team"),
    where: { id: app.id },
    data: { targetUrl, appSlug, allowedOrigins: serializeAllowedOrigins(origins.origins) },
  });
  // The daily check is switched on through the same gate as anywhere else
  // (Codex on #288): the plan's watch cap counts it now, and a Free trial is
  // stamped from today, not from when the store was first typed in. Refused,
  // the app is still connected; its first check still runs, and the reason is
  // said.
  const watch = await enableWatchForApp(db, { id: actor.userId, teamId: actor.teamId, plan: actor.plan }, app.id, { frequency: "daily" });
  return { ok: true, appId: app.id, appSlug, ...(watch.kind === "gated" ? { watchRefused: watch.reason } : {}) };
}
