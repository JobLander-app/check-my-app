// CHE-451: a Shopify app lives on several dev stores — staging, production, a
// store full of fraud orders. An App row stays what a check runs against (one
// store, one app); the rows of a team that open the same app handle in the
// Shopify admin are ONE Shopify app on several stores. Read from the app's
// address in the admin (admin.shopify.com/store/<store>/apps/<handle>), with the
// slug as a second source: apps connected before #288 carry the slug
// "admin.shopify.com", so the address is the one that is always there.
//
// What that means today:
//   - the team's scenarios are the Shopify app's: a store added later gets the
//     ones its siblings have (carryScenarios), and add_scenario can write to
//     every store at once;
//   - MCP names a check by `shopify_app` + `store`, adds a store with
//     add_store, and list_apps shows each store beside its siblings.

import type { PrismaClient } from "@/generated/prisma/client";
import { journeyKey } from "@/lib/journey-key";
import { appHandleOfAdminUrl, isPendingShopifyApp, storeOfAdminUrl } from "@/lib/session-view";
import { teamOwned } from "@/lib/tenant-db";

const SLUG = /^shopify:([^/]+)\/(.+)$/;

/** The store and the app's handle of a connected Shopify app, or null. */
export function shopifyAppOf(app: { appSlug: string; targetUrl: string }): { store: string; handle: string } | null {
  const store = storeOfAdminUrl(app.targetUrl);
  const handle = appHandleOfAdminUrl(app.targetUrl);
  if (store && handle) return { store, handle };
  const m = SLUG.exec(app.appSlug);
  return m ? { store: m[1], handle: m[2] } : null;
}

/**
 * The same, only once the app is connected — the person picked it after signing
 * in. A store still waiting for that pick is not "where the app is": its address
 * may already name the handle (add_store writes it), but nothing has confirmed
 * the app is installed there (CodeRabbit on #324).
 */
export function connectedShopifyAppOf(app: { appSlug: string; targetUrl: string; targetKind: string }): { store: string; handle: string } | null {
  return isPendingShopifyApp(app) ? null : shopifyAppOf(app);
}

export type StoreOfApp = { appId: string; store: string };

/** Every store of the team where this Shopify app is connected, by store name. */
export async function storesOf(db: PrismaClient, teamId: string, handle: string): Promise<StoreOfApp[]> {
  const rows = await db.app.findMany({
    where: {
      ...teamOwned(teamId),
      OR: [{ targetUrl: { startsWith: "https://admin.shopify.com/store/" } }, { appSlug: { startsWith: "shopify:" } }],
    },
    select: { id: true, appSlug: true, targetUrl: true, targetKind: true },
  });
  return rows
    .map((r) => ({ appId: r.id, of: connectedShopifyAppOf(r) }))
    .filter((r): r is { appId: string; of: { store: string; handle: string } } => r.of?.handle === handle)
    .map((r) => ({ appId: r.appId, store: r.of.store }))
    .sort((a, b) => a.store.localeCompare(b.store));
}

/** The app of `handle` on `store`, if the team has connected it there. */
export async function appOnStore(db: PrismaClient, teamId: string, handle: string, store: string): Promise<string | null> {
  return (await storesOf(db, teamId, handle)).find((s) => s.store === store)?.appId ?? null;
}

/** The live team scenarios the app's other stores have and this one lacks (by title). */
async function missingScenarios(db: PrismaClient, teamId: string, appId: string, handle: string) {
  const siblings = (await storesOf(db, teamId, handle)).filter((s) => s.appId !== appId).map((s) => s.appId);
  if (siblings.length === 0) return [];
  const [theirs, mine] = await Promise.all([
    db.appJourney.findMany({
      where: { appId: { in: siblings }, source: "team", retiredAt: null },
      select: { title: true, description: true, daily: true, authorId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    db.appJourney.findMany({ where: { appId }, select: { title: true, retiredAt: true } }),
  ]);
  const have = new Set(mine.filter((m) => !m.retiredAt).map((m) => m.title.trim().toLowerCase()));
  const seen = new Set<string>();
  return theirs.filter((t) => {
    const k = t.title.trim().toLowerCase();
    if (have.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** How many of the app's scenarios a store would get when it is added. */
export async function scenariosToCarry(db: PrismaClient, teamId: string, appId: string, handle: string): Promise<number> {
  return (await missingScenarios(db, teamId, appId, handle)).length;
}

/**
 * The Shopify app's team scenarios, written onto a store that lacks them. Once
 * per title: a store that has a scenario of the same name keeps its own.
 */
export async function carryScenarios(db: PrismaClient, teamId: string, appId: string, handle: string): Promise<number> {
  const missing = await missingScenarios(db, teamId, appId, handle);
  if (missing.length === 0) return 0;
  const keys = (await db.appJourney.findMany({ where: { appId }, select: { key: true } })).map((k) => k.key);
  for (const s of missing) {
    const key = journeyKey(s.title, keys);
    keys.push(key);
    await db.appJourney.create({
      data: { appId, key, title: s.title, description: s.description, source: "team", daily: s.daily, authorId: s.authorId },
    });
  }
  return missing.length;
}
