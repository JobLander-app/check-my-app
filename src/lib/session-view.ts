// CHE-419: the token a person's page presents to the session host's live view
// (spikes/shopify-session/viewer.mjs) — HMAC-SHA256 over {v, slot, store, exp}
// with SESSION_VIEW_SECRET, the same bytes viewer.mjs verifies. WebCrypto, so
// it runs in the web worker and in Node alike.
//
// Minted only for a signed-in member of the team that owns the app, only for
// an app checked inside a signed-in session, and short-lived: the page asks
// for a fresh one each time it is opened.

export const VIEW_TOKEN_VERSION = 1;
export const VIEW_TOKEN_SECONDS = 30 * 60;
// CHE-464: the live view is a team's own container, reached through the agent
// worker (src/agent/session-runner.ts routeLiveView) — no longer the VM.
export const VIEW_HOST = "wss://live.checkmyapp.dev/session/view";

const base64url = (bytes: Uint8Array) => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const hmac = async (secret: string, text: string): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
};

// CHE-482: a session browser is one PERSON's in one team, not the team's. A
// Shopify sign-in is a person's own account: while a team had one browser, the
// second person to sign in replaced the first one's sign-in, and their dev
// stores could never be checked side by side. So a browser is named by its
// slot, `<teamId>--<userId>`, and a store is checked in the slot of whoever
// connected it (App.ownerId) — a dev store is that person's test account.
export const SESSION_SLOT = /^[A-Za-z0-9_-]{1,100}$/;

// Team and user ids are cuids ([a-z0-9]) or `team_<cuid>`; neither holds the
// separator, so a slot reads back into exactly the two ids it was made of.
const SLOT_ID = /^[A-Za-z0-9_]{1,48}$/;
const SLOT_SEPARATOR = "--";

export function sessionSlot(teamId: string, userId: string): string {
  if (!SLOT_ID.test(teamId) || !SLOT_ID.test(userId)) throw new Error("internal: a session slot needs a team id and a user id");
  return `${teamId}${SLOT_SEPARATOR}${userId}`;
}

/** The team and the person a slot names, or null for anything else. */
export function slotParts(slot: string): { teamId: string; userId: string } | null {
  if (!SESSION_SLOT.test(slot)) return null;
  const parts = slot.split(SLOT_SEPARATOR);
  if (parts.length !== 2 || !SLOT_ID.test(parts[0]) || !SLOT_ID.test(parts[1])) return null;
  return { teamId: parts[0], userId: parts[1] };
}

/** The slot a store is checked in: its team's, signed in as whoever connected it. */
export function storeSlot(app: { teamId: string | null; ownerId: string | null }): string | null {
  return app.teamId && app.ownerId ? sessionSlot(app.teamId, app.ownerId) : null;
}

// Who may sign in for a store, on its sign-in page: only the person whose
// Shopify sign-in its checks use. Anyone else on the team signing in there
// would put THEIR account into someone else's browser — and the next check of
// every store of that person would open as them.
export type StoreSignIn = { kind: "mine"; slot: string } | { kind: "theirs"; ownerId: string } | { kind: "none" };

export function storeSignIn(app: { teamId: string | null; ownerId: string | null }, viewerId: string): StoreSignIn {
  const slot = storeSlot(app);
  if (!slot || !app.ownerId) return { kind: "none" };
  return app.ownerId === viewerId ? { kind: "mine", slot } : { kind: "theirs", ownerId: app.ownerId };
}

// CHE-464: a slot's view key. Every container holds a key of its own, derived
// from SESSION_VIEW_SECRET and its slot, never the secret itself: a container
// can mint a view token, and sign an app pick, for its own slot only. Tokens
// for a slot are minted, and its picks verified, with this key.
export async function viewKeyFor(secret: string, slot: string): Promise<string> {
  return [...(await hmac(secret, `session-view:${slot}`))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The slot a token names, read before it is verified — to know which slot's
// key verifies it. Never trusted on its own.
export function viewTokenSlot(token: string): string | null {
  if (typeof token !== "string" || token.length > 2048) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(token.split(".")[0] ?? "")));
    return typeof payload?.slot === "string" && SESSION_SLOT.test(payload.slot) ? payload.slot : null;
  } catch {
    return null;
  }
}

// viewer.mjs verifyViewToken, in WebCrypto: the payload, or null for anything
// not signed with this key, expired, or of another version.
export async function verifyViewToken(key: string, token: string, now = Date.now()): Promise<{ slot: string; store: string; exp: number } | null> {
  if (typeof token !== "string" || token.length > 2048) return null;
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined) return null;
  try {
    const signing = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    if (!(await crypto.subtle.verify("HMAC", signing, fromBase64url(mac), new TextEncoder().encode(body)))) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(body)));
    if (payload?.v !== VIEW_TOKEN_VERSION || payload.kind !== undefined) return null;
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return null;
    if (typeof payload.slot !== "string" || typeof payload.store !== "string") return null;
    return { slot: payload.slot, store: payload.store, exp: payload.exp };
  } catch {
    return null;
  }
}

export async function mintViewToken(
  secret: string,
  { slot, store, now = Date.now(), seconds = VIEW_TOKEN_SECONDS }: { slot: string; store: string; now?: number; seconds?: number },
): Promise<string> {
  const payload = { v: VIEW_TOKEN_VERSION, slot, store, exp: Math.floor(now / 1000) + seconds };
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `${body}.${base64url(mac)}`;
}

const fromBase64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export interface Pick {
  slot: string;
  store: string;
  handle: string;
  name: string;
  origin: string;
}

// What the host's viewer read for the person and signed (viewer.mjs signPick):
// the chosen app's handle, name and the origin of its frame. Null for anything
// not signed with our secret, expired, or not a pick.
export async function verifyPick(secret: string, token: string, now = Date.now()): Promise<Pick | null> {
  if (typeof token !== "string" || token.length > 4096) return null;
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined) return null;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("HMAC", key, fromBase64url(mac), new TextEncoder().encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(body)));
    if (payload?.v !== VIEW_TOKEN_VERSION || payload.kind !== "pick") return null;
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return null;
    for (const field of ["slot", "store", "handle", "name", "origin"] as const) if (typeof payload[field] !== "string") return null;
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(payload.handle)) return null;
    return { slot: payload.slot, store: payload.store, handle: payload.handle, name: payload.name.slice(0, 80), origin: payload.origin };
  } catch {
    return null;
  }
}

// The link to an app inside a store's admin, as a person copies it from the
// address bar: https://admin.shopify.com/store/<store>/apps/<handle>[/…], or
// the older https://<store>.myshopify.com/admin/apps/<handle>[/…]; with or
// without the scheme. The store and the app's handle, or null.
export function parseAppLink(raw: string): { store: string; handle: string } | null {
  const text = raw.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const STORE = "([a-z0-9][a-z0-9-]{0,62})";
  const HANDLE = "([a-z0-9][a-z0-9-]{0,99})";
  if (host === "admin.shopify.com") {
    const m = new RegExp(`^/store/${STORE}/apps/${HANDLE}(?:/|$)`).exec(url.pathname.toLowerCase());
    return m ? { store: m[1], handle: m[2] } : null;
  }
  if (host.endsWith(".myshopify.com")) {
    const store = host.slice(0, -".myshopify.com".length);
    const m = new RegExp(`^/admin/apps/${HANDLE}(?:/|$)`).exec(url.pathname.toLowerCase());
    return m && new RegExp(`^${STORE}$`).test(store) ? { store, handle: m[1] } : null;
  }
  return null;
}

// The app's handle in a saved admin address, or null (a store's own address).
export function appHandleOfAdminUrl(targetUrl: string): string | null {
  try {
    const url = new URL(targetUrl);
    if (url.hostname !== "admin.shopify.com") return null;
    return /^\/store\/[a-z0-9][a-z0-9-]{0,62}\/apps\/([a-z0-9][a-z0-9-]{0,99})(?:\/|$)/.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

export const shopifyAdminUrl = (store: string, handle?: string) =>
  `https://admin.shopify.com/store/${store}${handle ? `/apps/${handle}` : ""}`;
// One app per store and app handle, the way an extension is one app per id:
// every Shopify app's address is on admin.shopify.com, so the host alone would
// make a team's second Shopify app a duplicate of its first.
export const shopifySlug = (store: string, handle?: string) => `shopify:${store}${handle ? `/${handle}` : ""}`;

// A store connected, its app not chosen yet: no check may run (Codex on #288 —
// the address is the admin's home, and a verdict about it would be about
// Shopify, not the customer's app). Checked where every check starts
// (startSavedApp), so the app page's Run, MCP start_check and anything later
// all refuse.
export const isPendingShopifyApp = (app: { targetKind: string; appSlug: string }) =>
  app.targetKind === "session" && /^shopify:[a-z0-9][a-z0-9-]*$/.test(app.appSlug);
export const PENDING_SHOPIFY_APP = "Choose which app in this store to check first, on the store's sign-in page.";

// The store handle of an app checked inside the Shopify admin, from its saved
// address (https://admin.shopify.com/store/<handle>/apps/<app>), or null.
export function storeOfAdminUrl(targetUrl: string): string | null {
  try {
    const url = new URL(targetUrl);
    if (url.hostname !== "admin.shopify.com") return null;
    return /^\/store\/([a-z0-9][a-z0-9-]{0,62})(?:\/|$)/.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}
