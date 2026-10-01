// Server-side PostHog feature flags (CHE-320). One request to the public
// flags endpoint per evaluation — no SDK, nothing that assumes Node, so it
// runs unchanged on Workers, like src/lib/analytics-server.ts.
//
// Why on the server: a flag that hides something must decide before the HTML
// leaves. Read in the browser, the hidden control would render for everyone
// and vanish a few hundred milliseconds later — the public would see exactly
// what the flag exists to keep from them.
//
// The one rule every caller relies on: anything short of PostHog saying
// "enabled" is off. No person, a timeout, an HTTP error, a malformed body, a
// deleted flag — all false. A flag that fails open would show the public the
// thing the owner asked to hide the first time PostHog has a bad minute.
//
// Pure apart from the injected fetch, so scripts/verify-home-extension-flag.ts
// exercises every branch without a network.

// Same public client token as the browser and analytics-server.ts (project
// 595090, US cloud). The flags endpoint takes the public token; no secret
// ever reaches this file.
const POSTHOG_FLAGS_TOKEN = "phc_yDqQQgx3vGfFvp97tEWsExEsLPnnGi6jp9XAqfooQTcn";
// https://posthog.com/docs/api/flags — `v=2` returns
// `{ flags: { <key>: { enabled, variant, reason } } }`.
export const POSTHOG_FLAGS_URL = "https://us.i.posthog.com/flags?v=2";

/**
 * The Chrome-extension check on the home page and in onboarding. Created by
 * `npm run posthog:setup`: off for everyone, on for the owner's e-mail.
 * Never on for a test account (see evaluateFlag).
 */
export const HOME_EXTENSION_CHECK_FLAG = "home-extension-check";

/**
 * The beta lenses of the redesign (CHE-348), read by the sidebar and the
 * lens routes. Created by `npm run posthog:setup`: Product (CHE-352) and
 * Release (CHE-367) on for the owner's e-mail only, the same condition as
 * the extension flag; Marketing (CHE-352) off for everyone, with no teaser.
 * Never on for a test account (see evaluateFlag).
 */
export const LENS_PRODUCT_FLAG = "lens-product";
export const LENS_MARKETING_FLAG = "lens-marketing";
export const LENS_RELEASE_FLAG = "lens-release";

/** Who the flag is asked about. The distinct id is the Clerk user id — the id the browser identifies with. */
export type FlagPerson = { distinctId: string; email: string; isTestAccount: boolean };

export type FlagFetch = (input: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The whole wait a page will accept for a flag before it renders without it. */
export const FLAG_TIMEOUT_MS = 1500;

/** The exact body sent to PostHog. Pure, so the verification script can check it. */
export function buildFlagsPayload(key: string, person: FlagPerson) {
  return {
    api_key: POSTHOG_FLAGS_TOKEN,
    distinct_id: person.distinctId,
    // Sent with the request, not left for PostHog to remember: the browser
    // sets `email` on identify, but only after a visit. PostHog evaluates
    // against this override. No `is_test_account` since CHE-334: a test
    // account never reaches this request (evaluateFlag).
    person_properties: { email: person.email },
    flag_keys_to_evaluate: [key],
  };
}

/** Whether a flags response says `key` is on. Anything unexpected is off. */
export function flagEnabledIn(body: unknown, key: string): boolean {
  const flags = (body as { flags?: Record<string, { enabled?: unknown } | undefined> } | null)?.flags;
  return flags?.[key]?.enabled === true;
}

/**
 * Evaluate one boolean flag for one person. Never throws. No person (an
 * anonymous visitor) is off without a request: the flags we keep this way
 * are released to named people, and a stranger's page should not wait on a
 * round trip whose answer is already known.
 *
 * A test account is evaluated as a stranger, also without a request (CHE-334).
 * Test accounts are the ones our self-check of checkmyapp.dev signs in with,
 * and what the self-check sees is what it reports: with this flag on for test
 * accounts, run #260 filed "Homepage layout diverges between anonymous and
 * signed-in visitors" — our own configuration, published as the product's
 * defect in front of a prospect (rule 8). The checking account sees what a
 * stranger sees, so no flag of ours can differ between its two walks.
 */
export async function evaluateFlag(
  key: string,
  person: FlagPerson | null,
  fetchImpl: FlagFetch = fetch,
): Promise<boolean> {
  if (!person || person.isTestAccount) return false;
  try {
    const res = await fetchImpl(POSTHOG_FLAGS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildFlagsPayload(key, person)),
      signal: AbortSignal.timeout(FLAG_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[flags] posthog refused ${key}: HTTP ${res.status}`);
      return false;
    }
    return flagEnabledIn(await res.json(), key);
  } catch (err) {
    console.warn(`[flags] posthog unreachable for ${key}:`, err);
    return false;
  }
}
