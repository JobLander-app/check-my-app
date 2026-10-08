// CHE-333: connecting a Shopify app is not connecting a website. The app lives
// inside a store's admin, in a frame whose origin its developer never thinks
// about, behind a sign-in our checker must never perform. So the input is the
// link to the app INSIDE the store admin (owner, 2026-10-06: «онбординг должен
// просить ссылку сразу на апп внутри стора») — what anyone gets by opening
// their app in Shopify and copying the address. The rest is read from the
// admin after the person signs in on our page (CHE-419):
//
//   1. connectApp — the link becomes a pending app (kind "session", slug
//      shopify:<store>, no daily check, no check can start) whose address is
//      the app in the admin, and the person is sent to sign in;
//   2. chooseApp — after sign-in the session host opens that app, reads the
//      origin it is served from and signs what it read; we save it (slug
//      shopify:<store>/<handle>, the admin and the app's origin allowed),
//      switch the daily check on and start the first one.
//
// One implementation behind the site's pages and MCP connect_shopify_app.

import type { PrismaClient } from "@/generated/prisma/client";
import { createAppForTeam, type AppActor, type AppRefusal } from "@/lib/app-settings";
import { parseAllowedOriginsInput, serializeAllowedOrigins } from "@/lib/allowed-origins";
import { alreadyScoped, teamOwned } from "@/lib/tenant-db";
import { enableWatchForApp } from "@/lib/watch-enable";
import { CONNECT_ERRORS } from "@/lib/sign-in-copy";
import { teamHasFeature } from "@/lib/team-features";
import { appHandleOfAdminUrl, isPendingShopifyApp, parseAppLink, shopifyAdminUrl, shopifySlug, storeOfAdminUrl, type Pick } from "@/lib/session-view";

export const SHOPIFY_ADMIN_ORIGIN = "https://admin.shopify.com";

// Which teams may connect a Shopify app: those given the "shopify" feature
// (CHE-433, src/lib/team-features.ts) — the Securify pilot, CHE-432.
// The words are in the guarded copy module (src/lib/sign-in-copy.ts).
export const NOT_OPEN_YET = CONNECT_ERRORS.notOpen;
export const BAD_LINK = CONNECT_ERRORS.badLink;

export async function connectApp(
  db: PrismaClient,
  actor: AppActor,
  rawLink: string,
): Promise<{ ok: true; appId: string; store: string; handle: string; reused: boolean; connected: boolean } | AppRefusal> {
  if (!(await teamHasFeature(db, actor.teamId, "shopify"))) return { error: NOT_OPEN_YET, code: "invalid_input" };
  const link = parseAppLink(rawLink);
  if (!link) return { error: BAD_LINK, code: "invalid_input" };
  const { store, handle } = link;
  // This app already connected: its page, not a second row.
  const existing = await db.app.findFirst({ where: { ...teamOwned(actor.teamId), appSlug: shopifySlug(store, handle) }, select: { id: true } });
  if (existing) return { ok: true, appId: existing.id, store, handle, reused: true, connected: true };
  // A store already waiting for its app is the same pending app — pointed at
  // the app asked for now: opening the connect page twice must not leave two.
  const targetUrl = shopifyAdminUrl(store, handle);
  const pending = await db.app.findFirst({ where: { ...teamOwned(actor.teamId), appSlug: shopifySlug(store) }, select: { id: true } });
  if (pending) {
    await db.app.update({ ...alreadyScoped("the App was just scoped to this team"), where: { id: pending.id }, data: { targetUrl } });
    return { ok: true, appId: pending.id, store, handle, reused: true, connected: false };
  }
  const created = await createAppForTeam(db, actor, {
    targetUrl,
    session: { slug: shopifySlug(store) },
    allowedOrigins: [SHOPIFY_ADMIN_ORIGIN],
  });
  if (!("ok" in created)) return created;
  return { ok: true, appId: created.app.id, store, handle, reused: false, connected: false };
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
  if (!app || app.targetKind !== "session") return { error: CONNECT_ERRORS.notFound, code: "not_found" };
  const store = storeOfAdminUrl(app.targetUrl);
  if (!store || store !== pick.store) return { error: CONNECT_ERRORS.otherStore, code: "invalid_input" };
  // Only a store still waiting for its app takes a choice: a connected app is
  // not repointed at another one by a stale page.
  if (!isPendingShopifyApp(app)) return { error: CONNECT_ERRORS.alreadyChosen, code: "invalid_input" };
  // The app the person linked to is the app saved — not another one a stale
  // page or a pick of something else would name.
  const linked = appHandleOfAdminUrl(app.targetUrl);
  if (linked && linked !== pick.handle) return { error: CONNECT_ERRORS.notLinked, code: "invalid_input" };
  const origins = parseAllowedOriginsInput([SHOPIFY_ADMIN_ORIGIN, pick.origin]);
  if (!origins.ok) return { error: CONNECT_ERRORS.cannotOpen, code: "invalid_input" };
  const appSlug = shopifySlug(store, pick.handle);
  const other = await db.app.findFirst({ where: { ...teamOwned(actor.teamId), appSlug, NOT: { id: app.id } }, select: { id: true } });
  if (other) return { error: CONNECT_ERRORS.alreadyConnected(pick.name), code: "duplicate", appId: other.id };
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
