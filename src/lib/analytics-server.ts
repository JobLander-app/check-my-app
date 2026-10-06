// Server-side PostHog capture for events that happen in API routes and
// webhooks, where there is no browser: a run created, a checkout completed,
// a one-off check paid. One event per request over fetch — no SDK, nothing
// that assumes Node, so it runs unchanged on Workers.
//
// Not wired yet (phase 2). What phase 2 must respect:
//
// - `distinctId` decides whom the event belongs to. For a signed-in caller use
//   the Clerk user id — the browser identifies with the same id, so the two
//   streams merge. For an anonymous caller use `distinctIdFromCookies()` on the
//   incoming request so the event joins the browser's device; without it the
//   event is an orphan in PostHog and cannot be attributed to a landing variant.
// - Super properties registered in the browser (`landing_variant`) do not
//   travel to the server. Pass them explicitly when the route knows them.
// - This file imports nothing from src/lib/analytics.ts on purpose: that file
//   pulls in posthog-js, which has no business in a Worker route bundle.

export const POSTHOG_SERVER_HOST = "https://us.i.posthog.com";
// Same public client token as the browser (project 595090, US cloud).
export const POSTHOG_SERVER_TOKEN = "phc_yDqQQgx3vGfFvp97tEWsExEsLPnnGi6jp9XAqfooQTcn";
// Single-event ingestion endpoint per the current PostHog capture API docs
// (https://posthog.com/docs/api/capture): POST /i/v0/e/ with api_key,
// event, distinct_id, properties, timestamp.
export const POSTHOG_CAPTURE_URL = `${POSTHOG_SERVER_HOST}/i/v0/e/`;

export type ServerAnalyticsEvents = {
  /** A run row was created for `appSlug`; `paid` when a $1 one-off check bought it. */
  run_created: { appSlug: string; paid: boolean; hasCredentials: boolean };
  /**
   * Stripe reported a completed subscription checkout for `plan`. `teamId`
   * (CHE-327) joins it to `balance_exhausted`, so "the balance ran out → the
   * team upgraded" is countable per team, not only per person.
   */
  checkout_completed: { plan: string; teamId?: string };
  /** Stripe reported a paid one-off check for `appSlug`. */
  one_check_paid: { appSlug: string };
  /**
   * CHE-327: a team whose balance was too low was refused a check. `source` is
   * the door it came through: the dashboard (`ui`), the coding agent (`mcp`),
   * the REST API (`api`), our GitHub Action (`action`, CHE-383), a deploy the
   * GitHub App heard about (`github`, CHE-369), or a watch's scheduled tick
   * (`watch` — once per window, not once per tick).
   */
  balance_exhausted: { plan: string; source: "ui" | "mcp" | "action" | "api" | "github" | "watch"; teamId: string };
  /** CHE-327: Stripe reported a paid top-up of `amountUsd` for the team. */
  balance_topped_up: { plan: string; amountUsd: number; teamId: string };
};

/**
 * Whom a server event belongs to when the request carried no PostHog cookie
 * (Do Not Track, an API-key caller, a webhook): the signed-in owner if there
 * is one, else a per-object id that keeps the event countable without
 * inventing a person — `$process_person_profile: false` tells PostHog not to
 * create one.
 */
export function serverDistinctId(
  fromCookie: string | null,
  ownerId: string | null,
  fallback: string,
): { distinctId: string; extra: Record<string, unknown> } {
  if (fromCookie) return { distinctId: fromCookie, extra: {} };
  if (ownerId) return { distinctId: ownerId, extra: {} };
  return { distinctId: fallback, extra: { $process_person_profile: false } };
}

export type ServerAnalyticsEvent = keyof ServerAnalyticsEvents;

export const SERVER_ANALYTICS_EVENTS = [
  "run_created",
  "checkout_completed",
  "one_check_paid",
  "balance_exhausted",
  "balance_topped_up",
] as const satisfies readonly ServerAnalyticsEvent[];

export type CapturePayload = {
  api_key: string;
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp: string;
};

/** The exact body sent to PostHog. Pure, so the verification script can check it. */
export function buildCapturePayload<E extends ServerAnalyticsEvent>(
  event: E,
  distinctId: string,
  props: ServerAnalyticsEvents[E] & Record<string, unknown>,
  now: Date = new Date(),
): CapturePayload {
  return {
    api_key: POSTHOG_SERVER_TOKEN,
    event,
    distinct_id: distinctId,
    properties: { ...props, $lib: "checkmyapp-server" },
    timestamp: now.toISOString(),
  };
}

export type FetchLike = (input: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

/**
 * Send one event. Never throws: analytics must not fail a checkout or a run.
 * Returns whether PostHog accepted it, for logging.
 */
export async function captureServer<E extends ServerAnalyticsEvent>(
  event: E,
  distinctId: string,
  props: ServerAnalyticsEvents[E] & Record<string, unknown>,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  const payload = buildCapturePayload(event, distinctId, props);
  try {
    const res = await fetchImpl(POSTHOG_CAPTURE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.warn(`[analytics] posthog refused ${event}: HTTP ${res.status}`);
    return res.ok;
  } catch (err) {
    console.warn(`[analytics] posthog unreachable for ${event}:`, err);
    return false;
  }
}

/** Name of the cookie posthog-js keeps in `localStorage+cookie` persistence. */
export const POSTHOG_COOKIE_NAME = `ph_${POSTHOG_SERVER_TOKEN}_posthog`;

/**
 * The browser's PostHog distinct id, read from the request's Cookie header, so
 * a server-side event lands on the same person as the browser's events.
 * Returns null when the visitor has no PostHog cookie (Do Not Track, first
 * request, cookies blocked).
 */
export function distinctIdFromCookies(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const prefix = `${POSTHOG_COOKIE_NAME}=`;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(prefix)) continue;
    try {
      const parsed: unknown = JSON.parse(decodeURIComponent(trimmed.slice(prefix.length)));
      const id = (parsed as { distinct_id?: unknown })?.distinct_id;
      return typeof id === "string" && id.length > 0 ? id : null;
    } catch {
      return null;
    }
  }
  return null;
}
