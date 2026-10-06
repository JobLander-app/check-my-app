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
