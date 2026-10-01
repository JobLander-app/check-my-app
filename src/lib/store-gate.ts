// The storefront password page (CHE-372).
//
// A Shopify store that is password-protected answers every storefront address
// with a redirect to /password: one field, "Enter store password". Runs
// #281–#283 on such a store reached nothing else, and since CHE-365 that run is
// Not verified with a request for the password. This module is the one
// definition of where that gate lives, read by the agent's unlock and every
// tool that must not type into it (src/agent/store-password.ts, tools.ts) and
// by the verdict's bottom line (src/agent/verdict-integrity.ts).
//
// Pure: no browser, no database.

/** The path a password-protected store sends every visitor to. */
export const STORE_GATE_PATH = "/password";

/**
 * Is `url` the address of the storefront password page of the store at
 * `target`? Exactly the target's origin — https, same host, same port, so a
 * password is never typed into a plain-http page or another host — and the
 * path exactly /password, not /account/password, not /password-reset.
 *
 * The address alone is not the gate: an ordinary app can have a change-password
 * page at /password. src/agent/store-password.ts also requires Shopify's own
 * storefront-password form on the page before anything is typed there.
 */
export function isStoreGateUrl(url: string | null | undefined, target: string | null | undefined): boolean {
  if (!url || !target) return false;
  try {
    const u = new URL(url);
    const t = new URL(target);
    if (u.protocol !== "https:" || u.origin !== t.origin) return false;
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return path === STORE_GATE_PATH;
  } catch {
    return false;
  }
}
