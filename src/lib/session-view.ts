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
export const VIEW_HOST = "wss://view.checkmyapp.dev/v1/view";

const base64url = (bytes: Uint8Array) => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

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

// What a person types as their store: "prod-release-1", "prod-release-1.myshopify.com",
// "https://prod-release-1.myshopify.com/", or an admin address
// "https://admin.shopify.com/store/prod-release-1/…". The handle, or null.
export function parseStoreInput(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  const admin = storeOfAdminUrl(text.startsWith("http") ? text : `https://${text}`);
  if (admin) return admin;
  let host = text;
  try {
    host = new URL(text.startsWith("http") ? text : `https://${text}`).hostname;
  } catch {
    return null;
  }
  const handle = host.endsWith(".myshopify.com") ? host.slice(0, -".myshopify.com".length) : host.includes(".") ? null : host;
  return handle && /^[a-z0-9][a-z0-9-]{0,62}$/.test(handle) ? handle : null;
}

export const shopifyAdminUrl = (store: string, handle?: string) =>
  `https://admin.shopify.com/store/${store}${handle ? `/apps/${handle}` : ""}`;
// One app per store and app handle, the way an extension is one app per id:
// every Shopify app's address is on admin.shopify.com, so the host alone would
// make a team's second Shopify app a duplicate of its first.
export const shopifySlug = (store: string, handle?: string) => `shopify:${store}${handle ? `/${handle}` : ""}`;

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
