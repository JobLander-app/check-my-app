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
          `(e.g. https://admin.shopify.com); CheckMyApp's own hosts cannot be added.`,
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
