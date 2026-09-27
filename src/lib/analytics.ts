// Product analytics for the launch (owner, 2026-09-05): PostHog on the client,
// one typed `track()` for the product's own events, and a client-side A/B
// bucket so two landing variants can be measured side by side without a
// PostHog experiment (we hold no personal API key, so flags cannot be created
// server-side; the bucket is computed here and stamped on every event).
//
// What this file guarantees, by mechanism rather than by habit:
//
// - Every event name is a member of `AnalyticsEvents`; `track()` refuses any
//   other string and any property shape other than the one declared here.
//   scripts/verify-analytics.ts checks the catalogue has no duplicates.
// - Nothing a customer typed for us — a test password, a test e-mail, the
//   address of their app beyond its hostname — can ride along on an event:
//   `guardEvent` (installed as `before_send`) drops autocapture events that
//   touch a sensitive input and strips property keys that look like secrets.
//   The SDK already skips inputs of type text/email/password/url on its own;
//   the guard is the belt to that pair of braces.
// - The landing variant is a pure function of the browser's device id, so a
//   visitor sees the same variant on every visit and after signing in.
//
// Inputs that must carry `className="ph-no-capture"` once phase 2 touches the
// forms (the SDK ignores such elements for autocapture, rage clicks and dead
// clicks): the test-login e-mail and password in src/components/submit-form.tsx,
// the notify e-mail there, and any credential field a later form adds. The
// guard below is the safety net for the day someone forgets.

import posthog from "posthog-js";
import type { CaptureResult } from "posthog-js";
import { useSyncExternalStore } from "react";

// Public client token for PostHog project 595090 (US cloud). It is a write-only
// key that every visitor's browser receives anyway; keeping it a constant means
// no env plumbing and no build that silently ships without analytics.
export const POSTHOG_TOKEN = "phc_yDqQQgx3vGfFvp97tEWsExEsLPnnGi6jp9XAqfooQTcn";
export const POSTHOG_HOST = "https://us.i.posthog.com";

// ─── Event catalogue ────────────────────────────────────────────────────────
//
// One entry per event the product emits from the browser, with the exact
// property shape. Phase 2 wires the calls; the names are fixed here so that
// PostHog insights built against them survive the wiring.
//
// `appSlug` is the hostname of the customer's app — never the full URL, never
// a path, never a query string.

export type AnalyticsEvents = {
  /** One per client-side navigation, sent to PostHog as `$pageview`. */
  pageview: { path: string };
  /** The check form was submitted and accepted client-side. */
  check_submitted: { appSlug: string; hasCredentials: boolean; hasNotifyEmail: boolean };
  /**
   * A check was refused — by the form (`invalid_url`) or by the API (`code`
   * is its rejection code). The `input*` fields describe what was typed
   * without carrying it: on 2026-09-10 and 2026-09-11 the only two strangers
   * who pressed the button in a month were refused with `invalid_url`, and
   * the event said nothing about what they had typed. `inputHost` is the
   * hostname when the text parses as a URL, else "" — same rule as `appSlug`.
   */
  check_rejected: {
    code: string;
    /**
     * What was typed, trimmed to 200 characters — the app URL a visitor
     * wanted checked, which is public on /checks/today the moment it is
     * accepted. Omitted when it contains "@": a userinfo URL or a pasted
     * e-mail is not ours to keep.
     */
    inputText?: string;
    inputLength?: number;
    inputHasScheme?: boolean;
    inputHasDot?: boolean;
    inputHasSpace?: boolean;
    inputHost?: string;
    extensionMode?: boolean;
  };
  /** The site-wide daily quota page was shown. */
  quota_site_hit: undefined;
  /** The one-off paid check call to action was clicked. */
  one_check_clicked: undefined;
  /** A Stripe checkout was opened for `plan`. */
  checkout_opened: { plan: string };
  /** A verdict page was viewed. `verdict` is the run's verdict enum value. */
  verdict_viewed: { appSlug: string; verdict: string; isOwner: boolean };
  /** The example verdict link on the landing page was clicked. */
  example_verdict_clicked: undefined;
  /** The "checks run today" list was viewed. */
  today_checks_viewed: undefined;
  /** A sign-in control was clicked; `from` names the surface (header, verdict…). */
  sign_in_clicked: { from: string };
  /** Daily watch was enabled for an app. */
  watch_enabled: { appSlug: string };
  /**
   * A re-check button on a verdict was pressed (CHE-137). `regular` is the
   * re-check after a deploy (re-walks what changed, not limited on paid
   * plans); `full` walks every journey from scratch and is metered per plan.
   */
  recheck_clicked: { kind: "regular" | "full"; appSlug: string };
  /**
   * The verdict page rendered the refusal of a full re-check: the month's
   * allowance is used up, or the plan carries none. `remaining` is what the
   * plan still allows this month, so it is 0 here — kept as a property so
   * the event has the same shape as the API's 403 body.
   */
  full_recheck_denied: { appSlug: string; remaining: number };
  /**
   * Which way in a person took from the first onboarding screen (CHE-324):
   * `agent` — connected their coding agent and left for the dashboard
   * without adding an app here; `app` — chose to fill in the form.
   */
  onboarding_path_chosen: { path: "agent" | "app" };
};

export type AnalyticsEvent = keyof AnalyticsEvents;

/** The catalogue as data, for verification and for building insights. */
export const ANALYTICS_EVENTS = [
  "pageview",
  "check_submitted",
  "check_rejected",
  "quota_site_hit",
  "one_check_clicked",
  "checkout_opened",
  "verdict_viewed",
  "example_verdict_clicked",
  "today_checks_viewed",
  "sign_in_clicked",
  "watch_enabled",
  "recheck_clicked",
  "full_recheck_denied",
  "onboarding_path_chosen",
] as const satisfies readonly AnalyticsEvent[];

/** Names PostHog treats specially. Everything else is sent verbatim. */
export const POSTHOG_EVENT_NAME: Partial<Record<AnalyticsEvent, string>> = {
  pageview: "$pageview",
};

export function posthogEventName(event: AnalyticsEvent): string {
  return POSTHOG_EVENT_NAME[event] ?? event;
}

export type TrackArgs<E extends AnalyticsEvent> = AnalyticsEvents[E] extends undefined
  ? []
  : [props: AnalyticsEvents[E]];

/**
 * Capture a product event. Typed so an unknown event or a wrong property shape
 * is a compile error, not a stray row in PostHog. Safe to call before the
 * provider has initialised PostHog and safe on the server: both are no-ops.
 */
export function track<E extends AnalyticsEvent>(event: E, ...args: TrackArgs<E>): void {
  if (typeof window === "undefined" || !posthog.__loaded) return;
  const props = args[0] as Record<string, unknown> | undefined;
  posthog.capture(posthogEventName(event), props ?? undefined);
}

// ─── Guard: nothing the customer typed for us leaves the browser ────────────

/** Input types the SDK itself treats as sensitive (it never captures their events). */
export const SENSITIVE_INPUT_TYPES = ["password", "email", "text", "search", "url", "tel", "number"];

/**
 * Property keys that may never carry a value on an event, whatever the caller
 * meant. A boolean under such a key (`hasCredentials`) is a fact about the
 * form, not a secret, and is kept.
 */
export const SECRET_PROPERTY_KEY = /password|passwd|secret|credential|token|api[_-]?key|authorization/i;

type ElementSnapshot = Record<string, unknown> & { tag_name?: string; $el_text?: string };

function touchesSensitiveInput(elements: unknown): boolean {
  if (!Array.isArray(elements)) return false;
  return elements.some((el: ElementSnapshot) => {
    if (!el || typeof el !== "object") return false;
    const cls = String(el.attr__class ?? "");
    if (cls.split(/\s+/).includes("ph-no-capture")) return true;
    if (el.tag_name === "input" || el.tag_name === "textarea") {
      const type = String(el.attr__type ?? "text").toLowerCase();
      if (SENSITIVE_INPUT_TYPES.includes(type)) return true;
      if ("attr__value" in el) return true;
    }
    return false;
  });
}

/**
 * `before_send` hook. Returns the event to send, or null to drop it.
 * Pure, so scripts/verify-analytics.ts can exercise it without a browser.
 */
export function guardEvent(cr: CaptureResult | null): CaptureResult | null {
  if (!cr) return cr;
  if (cr.event === "$autocapture" || cr.event === "$rageclick" || cr.event === "$dead_click") {
    if (touchesSensitiveInput(cr.properties?.$elements)) return null;
  }
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cr.properties ?? {})) {
    if (isSecretProperty(key, value)) continue;
    properties[key] = value;
  }
  return { ...cr, properties };
}

/**
 * The SDK's own properties are `$`-prefixed and stay. `token` is the one
 * SDK-owned key without the prefix: it carries the public project token on
 * every event and ingestion refuses an event without it — so `token` stays
 * exactly when it holds that token, and goes when it holds anything else.
 */
export function isSecretProperty(key: string, value: unknown): boolean {
  if (key.startsWith("$")) return false;
  if (key === "token") return value !== POSTHOG_TOKEN;
  return SECRET_PROPERTY_KEY.test(key) && typeof value !== "boolean";
}

// ─── A/B bucket for the landing page ────────────────────────────────────────
//
// The bucket is the PostHog feature flag `landing-variant` (multivariate A/B,
// 50/50; created by scripts/posthog-setup.ts together with the experiment
// "Landing headline A/B" that reads it). Reading the flag through
// `getFeatureFlag` also emits `$feature_flag_called`, which is the exposure
// event the experiment counts.
//
// If the flag does not resolve after flags have loaded (flag deleted, the
// flags request failed or timed out), the bucket falls back to FNV-1a over
// the browser's PostHog device id, which persists in localStorage+cookie for
// a year and survives `identify()` and `reset()`: even → A, odd → B.
// Whichever source resolved, the result is registered as the super property
// `landing_variant`, so every event — pageview, check_submitted, checkout —
// can be broken down by variant in an insight.
//
// Limits, stated plainly:
// - Per browser, not per person: the same person on two devices may see both.
// - Server-rendered HTML does not know the variant. A component that renders
//   a variant must render A on the server and may switch to B after mount;
//   `useLandingVariant()` returns "A" until flags have loaded. That is a
//   flash for half of B's visitors, accepted for launch.
// - Do Not Track / Global Privacy Control: PostHog never initialises for such
//   visitors, so they always see A and are never counted. Neither bias is
//   measured; both are small and known.
// - A fallback bucket is not the flag's bucket: a visitor bucketed by hash
//   while the flags request was down may land elsewhere once it is back.
//   PostHog's experiment analysis excludes people seen in more than one
//   variant by default.

export type LandingVariant = "A" | "B";

export const LANDING_VARIANT_FLAG = "landing-variant";

export type LandingVariantSource = "flag" | "hash";

/**
 * Decide the bucket from what the flag returned and the device id. Pure, so
 * scripts/verify-analytics.ts can exercise it.
 */
export function resolveLandingVariant(
  flagValue: unknown,
  deviceId: string | null,
): { variant: LandingVariant; source: LandingVariantSource } {
  if (flagValue === "A" || flagValue === "B") return { variant: flagValue, source: "flag" };
  return { variant: deviceId ? variantForId(deviceId) : "A", source: "hash" };
}

/** 32-bit FNV-1a. Exported for the verification script's known-answer test. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic bucket for a device id. */
export function variantForId(id: string): LandingVariant {
  const h = fnv1a32(id);
  // Fold the word onto itself so the decision bit depends on every input byte,
  // not only on their parity (the multiply by an odd prime keeps bit 0 weak).
  const folded = h ^ (h >>> 16) ^ (h >>> 8);
  return (folded & 1) === 0 ? "A" : "B";
}

// The resolved bucket as a tiny external store so React can subscribe without
// a context provider (and so `getLandingVariant()` works outside React).
// null until flags have loaded (or failed to) on the client.
let resolved: { variant: LandingVariant; source: LandingVariantSource } | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function deviceId(): string | null {
  const id = posthog.get_property("$device_id") ?? posthog.get_distinct_id();
  return typeof id === "string" && id.length > 0 ? id : null;
}

// Runs on every flags load (first load, reload after identify) and on a
// failed or timed-out load (`errorsLoading`). The flag's answer for this
// device does not change between loads, so re-registering is idempotent; if
// the flag ever went away mid-session the hash takes over.
//
// Order matters: the bucket is read from the callback's `variants` and
// registered first, and only then is `getFeatureFlag` called — that call
// emits `$feature_flag_called`, the experiment's exposure event, and this way
// it carries `landing_variant` like every event after it.
function onFlagsLoaded(_flags: string[], variants: Record<string, string | boolean>, context?: { errorsLoading?: boolean }): void {
  const next = resolveLandingVariant(context?.errorsLoading ? undefined : variants[LANDING_VARIANT_FLAG], deviceId());
  posthog.register({ landing_variant: next.variant, landing_variant_source: next.source });
  if (next.source === "flag") posthog.getFeatureFlag(LANDING_VARIANT_FLAG);
  if (resolved?.variant === next.variant && resolved.source === next.source) return;
  resolved = next;
  for (const listener of listeners) listener();
}

/**
 * Run `fn` once the bucket is known — at once if it already is, otherwise
 * when flags load, or after `maxWaitMs` if they never do. The landing
 * pageview waits on this so the very first event of a visit already carries
 * `landing_variant`; the flags round trip is a few hundred milliseconds.
 */
export function whenVariantResolved(fn: () => void, maxWaitMs = 4000): void {
  if (typeof window === "undefined") return;
  if (resolved) {
    fn();
    return;
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    unsubscribe();
    clearTimeout(timer);
    fn();
  };
  const unsubscribe = subscribe(finish);
  const timer = setTimeout(finish, maxWaitMs);
}

/** "A" until flags have loaded on the client, then the flag's bucket (or the hash fallback). */
export function getLandingVariant(): LandingVariant {
  if (typeof window === "undefined" || !resolved) return "A";
  return resolved.variant;
}

/** Where the current bucket came from; null until flags have loaded. */
export function getLandingVariantSource(): LandingVariantSource | null {
  return resolved?.source ?? null;
}

const serverVariant = (): LandingVariant => "A";

/** React hook form of `getLandingVariant()`; re-renders once the bucket is known. */
export function useLandingVariant(): LandingVariant {
  return useSyncExternalStore(subscribe, getLandingVariant, serverVariant);
}

// ─── Initialisation ─────────────────────────────────────────────────────────

/**
 * Initialise PostHog once. Idempotent; a no-op on the server. Called by
 * AnalyticsProvider and by anything that may run before it (child effects run
 * before parent effects in React).
 */
export function initAnalytics(): void {
  if (typeof window === "undefined" || posthog.__loaded) return;
  posthog.init(POSTHOG_TOKEN, {
    api_host: POSTHOG_HOST,
    // Dated defaults (SDK 1.427): scripts injected into <head>, localhost
    // visitors flagged as internal/test users, storage writes debounced,
    // URL hashes not captured, cookie wins on conflict. Everything we care
    // about is set explicitly below regardless.
    defaults: "2026-08-30",
    // Pageviews are captured by AnalyticsPageView on every App Router
    // navigation; the SDK's own history hook would double-count.
    capture_pageview: false,
    capture_pageleave: true,
    persistence: "localStorage+cookie",
    autocapture: true,
    // Session replay, with the masking review it was waiting for (2026-09-18):
    // every input is masked — the test email, the password (always), notes —
    // except the one field whose content is the point of the product, the
    // app's URL, which the visitor is about to publish on /checks/today
    // anyway. The reason: the only two strangers who pressed the button in
    // a month were refused by the form, and nothing recorded what they had
    // typed. Recording is also switched on in the project settings
    // (session_recording_opt_in, 100 % sample); both have to be on.
    disable_session_recording: false,
    session_recording: {
      maskAllInputs: true,
      maskInputFn: (text, element) =>
        element?.getAttribute("data-ph-unmask") === "url" ? text : "*".repeat(text.length),
    },
    respect_dnt: true,
    // Masks e-mail addresses and the like inside captured URLs.
    mask_personal_data_properties: true,
    before_send: guardEvent,
    // The flags request has a 3 s timeout (feature_flag_request_timeout_ms);
    // the callback fires on success and on failure, so the bucket is always
    // decided — by the flag, or by the hash.
    loaded: (client) => {
      client.onFeatureFlags(onFlagsLoaded);
    },
  });
  // What the PostHog snippet does by itself: the client on `window.posthog`,
  // so a person debugging a page (or forcing a flag with
  // posthog.featureFlags.overrideFeatureFlags) can reach it. Nothing on it is
  // secret — the token is the one every visitor already holds.
  (window as unknown as { posthog?: typeof posthog }).posthog = posthog;
}

/** Tie the browser's events to a signed-in user. Idempotent for the same id. */
export function identifyUser(userId: string, email: string | null | undefined): void {
  if (typeof window === "undefined" || !posthog.__loaded) return;
  if (posthog.get_distinct_id() === userId) return;
  posthog.identify(userId, email ? { email } : undefined);
}

/** Forget the signed-in user on sign-out. Keeps the device id, so the A/B bucket holds. */
export function resetUser(): void {
  if (typeof window === "undefined" || !posthog.__loaded) return;
  if (!posthog._isIdentified()) return;
  posthog.reset();
}

export { posthog };
