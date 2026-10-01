// The storefront password page (CHE-372).
//
// A Shopify store that is password-protected answers every storefront address
// with a redirect to /password: one field, "Enter store password". Runs
// #281–#283 on such a store reached nothing else, and since CHE-365 that run is
// Not verified with a request for the password. This module is the one
// definition of "this page is that gate", read by the agent's unlock
// (src/agent/store-password.ts), by the verdict's bottom line
// (src/agent/verdict-integrity.ts) and by the journey sentence a customer reads
// (src/lib/journey-numbers-load.ts) — so the three can never disagree about it.
//
// Pure: no browser, no database.

/** The path a password-protected store sends every visitor to. */
export const STORE_GATE_PATH = "/password";

function site(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

/**
 * Is `url` the storefront password page of the store at `target`? Same site
 * (www folded, so an apex target and its www redirect are one store) and the
 * path is exactly /password — not /account/password, not /password-reset.
 */
export function isStoreGateUrl(url: string | null | undefined, target: string | null | undefined): boolean {
  if (!url || !target) return false;
  try {
    const u = new URL(url);
    const t = new URL(target);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return site(u.hostname) === site(t.hostname) && path === STORE_GATE_PATH;
  } catch {
    return false;
  }
}
