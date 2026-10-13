// CHE-464: what a team's Shopify cookie jar is, as pure functions — shared by
// the container (jar.mjs, which reads and writes Chrome's jar) and the team's
// Durable Object (src/agent/session-runner.ts, which keeps it). No import:
// the Worker bundles this file, the guard runs it in Node.
//
// CHE-461 measured why a jar is enough: the three `.shopify.com` cookies
// (`_merchant_essential` is the session, re-issued on every admin load;
// `_merchant_analytics`; `cf_clearance`) open the admin in a never-used Chrome
// on another machine and another address. Whatever is said about a jar is
// said with `describeJar`: names and counts, never a value.

// The Shopify sign-in and nothing else of the browser's: the admin, the
// accounts host, the stores, and Cloudflare's clearance on them.
const JAR_DOMAIN = /(^|\.)(shopify\.com|myshopify\.com)$/i;
export const SESSION_COOKIE = "_merchant_essential";
const MAX_COOKIES = 300;

// What Storage.setCookies takes back of what Storage.getCookies gave.
const FIELDS = ["name", "value", "domain", "path", "secure", "httpOnly", "sameSite", "expires", "priority", "sourceScheme", "sourcePort", "partitionKey"];

const domainOf = (cookie) => String(cookie?.domain ?? "").replace(/^\./, "");

/** The cookies of a browser → the team's jar (Shopify's, in the shape setCookies takes). */
export function jarOf(cookies) {
  const jar = [];
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    if (typeof cookie?.name !== "string" || typeof cookie?.value !== "string") continue;
    if (!JAR_DOMAIN.test(domainOf(cookie))) continue;
    const kept = {};
    for (const field of FIELDS) if (cookie[field] !== undefined && cookie[field] !== null) kept[field] = cookie[field];
    // A session cookie comes back with expires -1 (and session: true); given
    // back with that it would be refused, so it goes in without an expiry.
    if (cookie.session === true || (typeof kept.expires === "number" && kept.expires <= 0)) delete kept.expires;
    jar.push(kept);
    if (jar.length >= MAX_COOKIES) break;
  }
  return jar;
}

/** Does this jar hold a sign-in at all? */
export const holdsSignIn = (jar) =>
  Array.isArray(jar) && jar.some((cookie) => cookie?.name === SESSION_COOKIE && typeof cookie.value === "string" && cookie.value.length > 0);

/** What may be said about a jar — never a value. */
export function describeJar(jar) {
  const list = Array.isArray(jar) ? jar : [];
  return { count: list.length, signedIn: holdsSignIn(list), names: [...new Set(list.map((c) => String(c?.name ?? "")))].sort().slice(0, 60) };
}
