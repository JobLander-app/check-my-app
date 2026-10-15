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
import { carryScenarios } from "@/lib/shopify-stores";

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
): Promise<{ ok: true; appId: string; store: string; handle: string; reused: boolean; connected: boolean } | AppRefusal | { error: string; code: "forbidden" }> {
  if (!(await teamHasFeature(db, actor.teamId, "shopify"))) return { error: NOT_OPEN_YET, code: "invalid_input" };
  // CHE-482 (Codex on #351): a store is connected with the connector's own
  // Shopify sign-in, so the connector must be on the team. A team key outlives
  // the person who made it; through it, someone who left would be recorded as
  // the store's connector, and nobody could ever sign in for it.
  if (!(await db.membership.findFirst({ where: { teamId: actor.teamId, userId: actor.userId }, select: { id: true } }))) {
    return { error: CONNECT_ERRORS.notOnTeam, code: "forbidden" };
  }
  const link = parseAppLink(rawLink);
  if (!link) return { error: BAD_LINK, code: "invalid_input" };
  const { store, handle } = link;
  // This app already connected: its page, not a second row.
  const existing = await db.app.findFirst({ where: { ...teamOwned(actor.teamId), appSlug: shopifySlug(store, handle) }, select: { id: true, ownerId: true } });
  if (existing) {
    // CHE-482 (Codex on #351): unless whoever connected it is no longer on the
    // team. Their sign-in left with them and nothing checks the store now;
    // whoever connects it again makes it theirs, and signs in for it.
    const connectorOnTeam = existing.ownerId
      ? (await db.membership.findFirst({ where: { teamId: actor.teamId, userId: existing.ownerId }, select: { id: true } })) !== null
      : false;
    if (connectorOnTeam) return { ok: true, appId: existing.id, store, handle, reused: true, connected: true };
    // Back to waiting for its pick, in the new connector's name: their sign-in
    // page then picks the linked app and starts the first check, as for any
    // store just connected (Codex on #351) — the address keeps the app, so
    // the pick is the one it had. Its history, scenarios and watch stay.
    await db.app.update({
      ...alreadyScoped("the App was just scoped to this team"),
      where: { id: existing.id },
      data: { ownerId: actor.userId, appSlug: shopifySlug(store), targetUrl: shopifyAdminUrl(store, handle) },
    });
    return { ok: true, appId: existing.id, store, handle, reused: true, connected: false };
  }
  // A store already waiting for its app is the same pending app — pointed at
  // the app asked for now: opening the connect page twice must not leave two.
  // CHE-482: and it becomes the store of whoever connects it now. A store is
  // checked signed in as its connector, and nobody has signed in for a pending
  // one yet; left with a teammate who started and walked away, it would send
  // this person to a sign-in page that is not theirs to use. One's own pending
  // store first, so a person never takes over a teammate's while holding one.
  const targetUrl = shopifyAdminUrl(store, handle);
  const pendingRows = await db.app.findMany({ where: { ...teamOwned(actor.teamId), appSlug: shopifySlug(store) }, select: { id: true, ownerId: true } });
  const pending = pendingRows.find((p) => p.ownerId === actor.userId) ?? pendingRows[0];
  if (pending) {
    await db.app.update({ ...alreadyScoped("the App was just scoped to this team"), where: { id: pending.id }, data: { targetUrl, ownerId: actor.userId } });
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
  | { ok: true; appId: string; appSlug: string; carried: number; watchRefused?: string }
  | { error: string; code: "invalid_input" | "not_found" | "duplicate"; appId?: string };

// Saves the app the person picked on the sign-in page. `pick` is what the host
// signed (verifyPick); its store must be this app's store.
export async function chooseApp(db: PrismaClient, actor: AppActor, appId: string, pick: Pick): Promise<ChooseResult> {
  const app = await db.app.findFirst({
    where: { ...teamOwned(actor.teamId), id: appId },
    select: { id: true, targetUrl: true, targetKind: true, appSlug: true, ownerId: true },
  });
  if (!app || app.targetKind !== "session") return { error: CONNECT_ERRORS.notFound, code: "not_found" };
  // CHE-482: the pick was read in the chooser's own browser; the store's checks
  // run in its connector's. Only the connector's pick is saved.
  if (app.ownerId !== actor.userId) return { error: CONNECT_ERRORS.notYours, code: "invalid_input" };
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
  // CHE-451: the same Shopify app on another store of the team — its scenarios
  // come with it, before the first check, so that check covers them. Copied
  // BEFORE the app is marked chosen (CodeRabbit on #324): a copy that throws
  // leaves the store still pending, so the person picks again and the copy
  // resumes — once per title, so a scenario copied the first time is not copied
  // twice. The other order left a chosen app whose missing scenarios nothing
  // would ever bring.
  const carried = await carryScenarios(db, actor.teamId, app.id, pick.handle);
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
  return { ok: true, appId: app.id, appSlug, carried, ...(watch.kind === "gated" ? { watchRefused: watch.reason } : {}) };
}
