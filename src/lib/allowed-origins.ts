// CHE-373: the origins a check may open and act on besides the app's own.
//
// An app embedded in someone else's page — a Shopify app inside
// admin.shopify.com, rendered in iframe[name=app-iframe] from its own origin —
// is two origins at once: the host page the owner signs in to, and the frame
// the app itself lives in. A run keyed on one origin refused to navigate to the
// other and would not type the test login into it, so the app could only ever
// be photographed. The owner names the extra origins; nothing else widens what
// the checker may touch.
//
// Stored as a JSON array of origins on App.allowedOrigins and copied onto
// Run.allowedOrigins like scopeHints. Empty or absent = the run is the
// single-origin run it always was.
//
// Pure: no Prisma, no bindings, so the agent, the web app and the verify script
// share it.

import { isSelfUrl } from "@/agent/self-hosts";

export const MAX_ALLOWED_ORIGINS = 5;

// A public suffix is a namespace many unrelated owners register under, never
// one owner's site: an allowed "https://com.au" or "https://github.io" would
// make evil-shop.com.au or anyone.github.io "the product", and their errors
// evidence against the customer (rule 8). There is no PSL package in this repo
// and the agent bundle should not grow one for five origins, so: the shared
// hosting namespaces we meet (Mozilla PSL "private" section, the common ones),
// plus the rule that covers the ICANN half — a generic second-level label
// under a two-letter country code (com.au, co.uk, org.br, ac.jp, gov.in) is a
// registry, not a site. A suffix missing from this list is still never
// widened to its subdomains: isTargetHost matches an allowed origin's host
// exactly (tools.ts).
const SHARED_HOSTING_SUFFIXES = new Set([
  "github.io", "gitlab.io", "bitbucket.io", "pages.dev", "workers.dev", "vercel.app", "now.sh",
  "netlify.app", "netlify.com", "herokuapp.com", "herokussl.com", "myshopify.com", "shopifypreview.com",
  "web.app", "firebaseapp.com", "appspot.com", "cloudfunctions.net", "run.app", "azurewebsites.net",
  "azurestaticapps.net", "cloudfront.net", "amazonaws.com", "elasticbeanstalk.com", "onrender.com",
  "fly.dev", "railway.app", "up.railway.app", "glitch.me", "repl.co", "replit.app", "replit.dev",
  "surge.sh", "ngrok.io", "ngrok-free.app", "ngrok.app", "blogspot.com", "wordpress.com", "wixsite.com",
  "squarespace.com", "webflow.io", "framer.app", "framer.website", "bubbleapps.io", "carrd.co",
  "notion.site", "streamlit.app", "hf.space", "deno.dev", "supabase.co", "lovable.app", "bolt.new",
  "netlify.live", "pythonanywhere.com", "readthedocs.io", "gitbook.io",
]);
const GENERIC_SECOND_LEVEL = new Set(["com", "co", "net", "org", "gov", "edu", "ac", "ne", "or", "go", "gob", "mil", "nic", "ltd", "plc", "sch", "nom"]);

/** True for a host that names a registry or a shared hosting namespace rather than one site. */
export function isPublicSuffix(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const labels = host.split(".");
  if (labels.length < 2) return true;
  if (SHARED_HOSTING_SUFFIXES.has(host)) return true;
  return labels.length === 2 && labels[1].length === 2 && GENERIC_SECOND_LEVEL.has(labels[0]);
}

/**
 * One origin, as stored: `https://host[:port]`, lower-cased, nothing after it.
 * Null for anything else — http, a path, a query, credentials, a wildcard.
 *
 * https only: a test login typed into a frame travels to that origin, and the
 * only origins it may travel to are ones the owner named AND that encrypt it.
 * Our own hosts are refused: the click gates that keep a self-check from
 * spending money (tools.ts SELF_HOST_GUARDED_VERBS) are keyed on the target, so
 * a customer's run allowed onto checkmyapp.dev would walk our product with none
 * of them.
 */
export function normalizeAllowedOrigin(raw: string): string | null {
  const text = raw.trim();
  if (!text || text.includes("*")) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  // "https://a.com/" is the same origin as "https://a.com"; anything else after
  // the host was refused above.
  if (text.replace(/\/$/, "").toLowerCase() !== url.origin.toLowerCase()) return null;
  if (isPublicSuffix(url.hostname)) return null;
  if (isSelfUrl(url.origin)) return null;
  return url.origin.toLowerCase();
}

export type AllowedOriginsParse = { ok: true; origins: string[] } | { ok: false; error: string };

/** Validate what an owner or an agent sent. Dedupes; an empty list is valid and clears. */
export function parseAllowedOriginsInput(input: readonly string[]): AllowedOriginsParse {
  const origins: string[] = [];
  for (const raw of input) {
    const origin = normalizeAllowedOrigin(raw);
    if (!origin) {
      return {
        ok: false,
        error:
          `"${raw}" is not an allowed origin. Give https origins with nothing after the host ` +
          `(e.g. https://admin.shopify.com); CheckMyApp's own hosts and shared namespaces ` +
          `(https://github.io, https://com.au) cannot be added.`,
      };
    }
    if (!origins.includes(origin)) origins.push(origin);
  }
  if (origins.length > MAX_ALLOWED_ORIGINS) {
    return { ok: false, error: `At most ${MAX_ALLOWED_ORIGINS} allowed origins.` };
  }
  return { ok: true, origins };
}

/** The stored column for a validated list: null when there is nothing to allow. */
export function serializeAllowedOrigins(origins: readonly string[]): string | null {
  return origins.length ? JSON.stringify(origins) : null;
}

/**
 * The stored column read back. Anything unparsable or invalid is dropped rather
 * than trusted: a row that says less than it should costs reach, one that says
 * more than it should costs a credential.
 *
 * `selfCheckHosts` is the agent's SELF_CHECK_HOSTS binding (staging, previews):
 * the web app cannot see it when the list is saved, so the run drops those
 * hosts here — before the list reaches the tools, the evidence rules or the
 * prompt that calls every allowed origin part of the customer's product.
 */
export function parseAllowedOrigins(stored: string | null | undefined, selfCheckHosts?: string): string[] {
  if (!stored) return [];
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const origin = normalizeAllowedOrigin(item);
    if (origin && !isSelfUrl(origin, selfCheckHosts) && !out.includes(origin)) out.push(origin);
  }
  return out.slice(0, MAX_ALLOWED_ORIGINS);
}
