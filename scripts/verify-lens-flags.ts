// CHE-352 / CHE-367: the three beta lenses of the redesign (CHE-348) are
// behind PostHog flags — `lens-product` and `lens-release` on for the owner
// only, `lens-marketing` off for everyone; test accounts and anonymous
// visitors always off. This proves, without PostHog:
//
//   1. the keys are the ones the epic's shared contract names, letter for
//      letter, and each wrapper asks PostHog for its own key and nothing else;
//   2. with PostHog answering the way posthog:setup configures it, the owner
//      gets Product and Release and not Marketing, a fresh account gets none,
//      a test account gets none without a request, and so does no one;
//   3. PostHog unreachable, erroring or answering garbage: all three off;
//   4. posthog:setup creates every key the app reads, with the owner-only
//      condition the extension flag already uses for Product and Release, and
//      nobody for Marketing.
//
// The wrappers read through the global fetch (as in production), so the fake
// PostHog is installed there for the length of the offline checks.
//
// --live additionally asks the real PostHog project the same questions. Not in
// CI (network).
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-lens-flags.ts [--live]

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as featureFlags from "@/lib/feature-flags";
import * as viewerFlags from "@/lib/viewer-flags";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}

type User = { clerkUserId: string; email: string; isTestAccount: boolean };
type Wrapper = (user: User | null) => Promise<boolean>;

const flags = featureFlags as unknown as Record<string, unknown>;
const wrappers = viewerFlags as unknown as Record<string, Wrapper | undefined>;

// The shared contract (CHE-348, Gate 1): constant → key, wrapper → constant.
const LENSES = [
  { lens: "product", constant: "LENS_PRODUCT_FLAG", key: "lens-product", wrapper: "productLensFor", owner: true },
  { lens: "marketing", constant: "LENS_MARKETING_FLAG", key: "lens-marketing", wrapper: "marketingLensFor", owner: false },
  { lens: "release", constant: "LENS_RELEASE_FLAG", key: "lens-release", wrapper: "releaseLensFor", owner: true },
] as const;

const OWNER: User = { clerkUserId: "user_owner", email: "sorokinvj@gmail.com", isTestAccount: false };
const FRESH: User = { clerkUserId: "user_fresh", email: "fresh-signup@example.com", isTestAccount: false };
const TEST: User = { clerkUserId: "user_dogfood", email: "sorokinvj@gmail.com", isTestAccount: true };

// ─── 1. The contract ────────────────────────────────────────────────────────

function contractChecks(): void {
  for (const l of LENSES) {
    check(`${l.constant} is "${l.key}"`, flags[l.constant] === l.key, JSON.stringify(flags[l.constant]));
    check(`${l.wrapper}(user) is exported from viewer-flags`, typeof wrappers[l.wrapper] === "function");
  }
}

// ─── 2–3. The wrappers against a fake PostHog ───────────────────────────────

type Answer = (body: { distinct_id: string; person_properties: { email: string }; flag_keys_to_evaluate: string[] }) => Response | Promise<Response>;

const calls: { distinctId: string; email: string; keys: string[] }[] = [];

function installFakePostHog(answer: Answer): void {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ distinctId: body.distinct_id, email: body.person_properties?.email, keys: body.flag_keys_to_evaluate });
    return answer(body);
  }) as typeof fetch;
}

// What PostHog answers once posthog:setup has run: Product and Release match
// the owner's e-mail, Marketing matches no one.
const configured: Answer = (body) => {
  const result: Record<string, { key: string; enabled: boolean }> = {};
  for (const key of body.flag_keys_to_evaluate) {
    const ownerOnly = key === "lens-product" || key === "lens-release";
    result[key] = { key, enabled: ownerOnly && body.person_properties.email === OWNER.email };
  }
  return Response.json({ flags: result });
};

async function ask(user: User | null): Promise<Record<string, boolean | string>> {
  const out: Record<string, boolean | string> = {};
  for (const l of LENSES) {
    const fn = wrappers[l.wrapper];
    out[l.lens] = typeof fn === "function" ? await fn(user) : "missing";
  }
  return out;
}

async function wrapperChecks(): Promise<void> {
  installFakePostHog(configured);

  calls.length = 0;
  const owner = await ask(OWNER);
  check("owner: Product on", owner.product === true, JSON.stringify(owner));
  check("owner: Release on", owner.release === true, JSON.stringify(owner));
  check("owner: Marketing off", owner.marketing === false, JSON.stringify(owner));
  check(
    "each wrapper asks PostHog for its own key, once, as the Clerk id with the e-mail",
    JSON.stringify(calls.map((c) => c.keys)) === JSON.stringify(LENSES.map((l) => [l.key])) &&
      calls.every((c) => c.distinctId === OWNER.clerkUserId && c.email === OWNER.email),
    JSON.stringify(calls),
  );

  const fresh = await ask(FRESH);
  check("fresh account: all off", fresh.product === false && fresh.release === false && fresh.marketing === false, JSON.stringify(fresh));

  calls.length = 0;
  const test = await ask(TEST);
  check("test account, even with the owner's e-mail: all off", test.product === false && test.release === false && test.marketing === false, JSON.stringify(test));
  check("…and no request is made for it", calls.length === 0, `${calls.length} calls`);

  calls.length = 0;
  const nobody = await ask(null);
  check("no one signed in: all off", nobody.product === false && nobody.release === false && nobody.marketing === false, JSON.stringify(nobody));
  check("…and no request is made", calls.length === 0, `${calls.length} calls`);

  // The 500 carries a body that says yes to everything: the status alone must decide.
  const allOn = (keys: string[]) => ({ flags: Object.fromEntries(keys.map((k) => [k, { key: k, enabled: true }])) });
  const outages: [string, Answer][] = [
    ["PostHog unreachable (network error / timeout)", () => { throw new DOMException("timed out", "TimeoutError"); }],
    ["PostHog HTTP 500", (body) => Response.json(allOn(body.flag_keys_to_evaluate), { status: 500 })],
    ["PostHog answers something that is not JSON", () => new Response("<html>bad gateway</html>", { status: 200 })],
    ["PostHog does not know the flag (deleted, renamed)", () => Response.json({ flags: {} })],
  ];
  for (const [name, answer] of outages) {
    installFakePostHog(answer);
    const owner = await ask(OWNER);
    check(`${name}: all off for the owner`, owner.product === false && owner.release === false && owner.marketing === false, JSON.stringify(owner));
  }
}

// ─── 4. posthog:setup creates what the app reads ────────────────────────────

function setupChecks(): void {
  const setup = readFileSync(join(process.cwd(), "scripts/posthog-setup.ts"), "utf8");
  for (const l of LENSES) {
    check(
      `posthog:setup creates ${l.key} under the key the app reads, for ${l.owner ? "the owner only" : "nobody"}`,
      new RegExp(`ensure${l.owner ? "Owner" : "Nobody"}Flag\\(\\s*${l.constant}\\b`).test(setup),
    );
  }
  check(
    "the extension flag and the owner-only lenses share one owner condition",
    /ensureOwnerFlag\(\s*HOME_EXTENSION_CHECK_FLAG\b/.test(setup) && (setup.match(/sorokinvj@gmail\.com/g) ?? []).length === 1,
  );
  check(
    "the off-for-everyone flag releases to no one",
    /function ensureNobodyFlag[\s\S]*?\[\{ properties: \[\], rollout_percentage: 0 \}\]/.test(setup),
  );
}

// ─── Live (optional) ────────────────────────────────────────────────────────

async function liveChecks(realFetch: typeof fetch): Promise<void> {
  globalThis.fetch = realFetch;
  const stamp = Date.now();
  const owner = await ask({ ...OWNER, clerkUserId: `verify-che-352-owner-${stamp}` });
  check("live: owner gets Product and Release, not Marketing", owner.product === true && owner.release === true && owner.marketing === false, JSON.stringify(owner));
  const fresh = await ask({ ...FRESH, clerkUserId: `verify-che-352-fresh-${stamp}` });
  check("live: a fresh account gets none", fresh.product === false && fresh.release === false && fresh.marketing === false, JSON.stringify(fresh));
  const test = await ask({ ...TEST, clerkUserId: `verify-che-352-test-${stamp}` });
  check("live: a test account gets none", test.product === false && test.release === false && test.marketing === false, JSON.stringify(test));
}

(async () => {
  const realFetch = globalThis.fetch;
  // Quiet the reader's own warnings while it is being fed failures on purpose.
  const warn = console.warn;
  console.warn = () => {};
  contractChecks();
  await wrapperChecks();
  console.warn = warn;
  globalThis.fetch = realFetch;
  setupChecks();
  if (process.argv.includes("--live")) await liveChecks(realFetch);
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
