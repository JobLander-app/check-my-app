// CHE-352 / CHE-367 / CHE-380: the flags the server reads — the three beta
// lenses of the redesign (CHE-348) and the extension check — decide only on
// what the server sends. `lens-product`, `lens-release` and
// `home-extension-check` are on for the owner's e-mail only, `lens-marketing`
// for no one; test accounts and anonymous visitors are always off. This
// proves, without PostHog:
//
//   1. the keys are the ones the epic's shared contract names, letter for
//      letter, and each wrapper asks PostHog for its own key and nothing else;
//   2. against a fake PostHog that evaluates scripts/posthog-flags.ts the way
//      PostHog does — including its fallback to STORED person properties for
//      anything the request does not override — the owner gets Product and
//      Release and not Marketing; a fresh account, a look-alike e-mail, a test
//      account and no one get nothing; and a stranger who stored
//      is_test_account="true" on their own distinct id (CHE-380) gets nothing,
//      even from the stale condition that was live on home-extension-check;
//   3. a PostHog that hangs is cut off at FLAG_TIMEOUT_MS, and one that errors
//      or answers garbage is off;
//   4. the declaration allows only `exact` conditions on the properties the
//      server sends, and posthog:setup reconciles PostHog to it.
//
// --live asks the real project the same questions: every declared flag exists
// with exactly the declared conditions; the owner, a fresh account, a test
// account and a look-alike e-mail get what they should; and a distinct id with
// a stored is_test_account="true" (set here with the public token, as anyone
// could) gets nothing. Needs POSTHOG_PERSONAL_API_KEY (.env); not in CI.
//
// Usage: npm run verify:lens-flags [-- --live]

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as featureFlags from "@/lib/feature-flags";
import * as viewerFlags from "@/lib/viewer-flags";
import { conditionsSignature, DECLARED_FLAGS, flagPlan, OWNER_EMAILS, unsafeCondition, type FlagCondition } from "./posthog-flags";

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
  { lens: "extension", constant: "HOME_EXTENSION_CHECK_FLAG", key: "home-extension-check", wrapper: "extensionCheckFor", owner: true },
] as const;

const OWNER_EMAIL = OWNER_EMAILS[0];
const OWNER: User = { clerkUserId: "user_owner", email: OWNER_EMAIL, isTestAccount: false };
const FRESH: User = { clerkUserId: "user_fresh", email: "fresh-signup@example.com", isTestAccount: false };
const TEST: User = { clerkUserId: "user_dogfood", email: OWNER_EMAIL, isTestAccount: true };
const SPOOFER: User = { clerkUserId: "user_spoofer", email: "stranger@example.com", isTestAccount: false };
const LOOKALIKES = [`x${OWNER_EMAIL}`, `${OWNER_EMAIL}.evil.example`, OWNER_EMAIL.replace("@", "+1@")];

type Answers = Record<string, boolean | string>;
const ownerOnly = (a: Answers) => LENSES.every((l) => a[l.lens] === l.owner);
const allOff = (a: Answers) => LENSES.every((l) => a[l.lens] === false);

async function ask(user: User | null): Promise<Answers> {
  const out: Answers = {};
  for (const l of LENSES) {
    const fn = wrappers[l.wrapper];
    out[l.lens] = typeof fn === "function" ? await fn(user) : "missing";
  }
  return out;
}

// ─── 1. The contract ────────────────────────────────────────────────────────

function contractChecks(): void {
  for (const l of LENSES) {
    check(`${l.constant} is "${l.key}"`, flags[l.constant] === l.key, JSON.stringify(flags[l.constant]));
    check(`${l.wrapper}(user) is exported from viewer-flags`, typeof wrappers[l.wrapper] === "function");
  }
}

// ─── 2. A fake PostHog that behaves like the real one ───────────────────────
//
// For each property a condition reads: the request's override if it sent
// one, otherwise what is stored about the person. `exact` matches the value
// list as strings; `icontains` is case-insensitive substring. Any other
// operator answers 400, as an unknown filter would.

type Body = { distinct_id: string; person_properties: Record<string, unknown>; flag_keys_to_evaluate: string[] };
type Answer = (body: Body, init: RequestInit) => Response | Promise<Response>;

const calls: Body[] = [];
const stored: Record<string, Record<string, string>> = {};

function installFakePostHog(answer: Answer): void {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    calls.push(body);
    return answer(body, init ?? {});
  }) as typeof fetch;
}

function matches(groups: FlagCondition[] | unknown[], body: Body): boolean {
  return (groups as FlagCondition[]).some((g) => {
    const props = g.properties.every((p) => {
      const raw = p.key in body.person_properties ? body.person_properties[p.key] : stored[body.distinct_id]?.[p.key];
      if (raw === undefined) return false;
      const v = String(raw);
      if (p.operator === "exact") return p.value.map(String).includes(v);
      if ((p.operator as string) === "icontains") return p.value.some((x) => v.toLowerCase().includes(String(x).toLowerCase()));
      throw new Error(`unknown operator ${p.operator}`);
    });
    return props && g.rollout_percentage >= 100;
  });
}

function postHogWith(table: Record<string, unknown[]>): Answer {
  return (body) => {
    try {
      const result: Record<string, { key: string; enabled: boolean }> = {};
      for (const key of body.flag_keys_to_evaluate) if (table[key]) result[key] = { key, enabled: matches(table[key], body) };
      return Response.json({ flags: result });
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 400 });
    }
  };
}

const declaredTable = Object.fromEntries(DECLARED_FLAGS.map((f) => [f.key, f.groups]));
// home-extension-check as it was live until CHE-380 (id 913845, read from
// PostHog on 2026-10-01): the owner condition plus a stale one on a property
// the browser can set for itself.
const staleTable = {
  ...declaredTable,
  [featureFlags.HOME_EXTENSION_CHECK_FLAG]: [
    ...declaredTable[featureFlags.HOME_EXTENSION_CHECK_FLAG],
    { properties: [{ key: "is_test_account", type: "person", operator: "exact", value: ["true"] }], rollout_percentage: 100 },
  ],
};

async function wrapperChecks(): Promise<void> {
  installFakePostHog(postHogWith(declaredTable));

  calls.length = 0;
  const owner = await ask(OWNER);
  check("owner: Product, Release and the extension check on; Marketing off", ownerOnly(owner), JSON.stringify(owner));
  check(
    "each wrapper asks PostHog for its own key, once, as the Clerk id",
    JSON.stringify(calls.map((c) => c.flag_keys_to_evaluate)) === JSON.stringify(LENSES.map((l) => [l.key])) &&
      calls.every((c) => c.distinct_id === OWNER.clerkUserId),
    JSON.stringify(calls.map((c) => [c.distinct_id, c.flag_keys_to_evaluate])),
  );
  check(
    "every request overrides every property a condition may read (CHE-380)",
    calls.length > 0 &&
      calls.every(
        (c) =>
          JSON.stringify(Object.keys(c.person_properties).sort()) === JSON.stringify([...featureFlags.FLAG_PERSON_PROPERTIES].sort()) &&
          c.person_properties.email === OWNER_EMAIL &&
          c.person_properties.is_test_account === false,
      ),
    JSON.stringify(calls[0]?.person_properties),
  );

  const fresh = await ask(FRESH);
  check("fresh account: all off", allOff(fresh), JSON.stringify(fresh));

  for (const email of LOOKALIKES) {
    const a = await ask({ ...FRESH, email });
    check(`look-alike e-mail ${email}: all off`, allOff(a), JSON.stringify(a));
  }

  // CHE-380: anyone can `$set` this on their own distinct id with the public token.
  stored[SPOOFER.clerkUserId] = { is_test_account: "true", email: OWNER_EMAIL };
  const spoofed = await ask(SPOOFER);
  check("stranger with stored is_test_account=\"true\" and the owner's stored e-mail: all off", allOff(spoofed), JSON.stringify(spoofed));
  installFakePostHog(postHogWith(staleTable));
  const spoofedStale = await ask(SPOOFER);
  check("…even against the stale is_test_account condition that was live until CHE-380", allOff(spoofedStale), JSON.stringify(spoofedStale));
  const ownerStale = await ask(OWNER);
  check("…while the owner still gets the extension check there", ownerStale.extension === true, JSON.stringify(ownerStale));
  installFakePostHog(postHogWith(declaredTable));

  calls.length = 0;
  const test = await ask(TEST);
  check("test account, even with the owner's e-mail: all off", allOff(test), JSON.stringify(test));
  check("…and no request is made for it", calls.length === 0, `${calls.length} calls`);

  calls.length = 0;
  const nobody = await ask(null);
  check("no one signed in: all off", allOff(nobody), JSON.stringify(nobody));
  check("…and no request is made", calls.length === 0, `${calls.length} calls`);
}

// ─── 3. Outages ─────────────────────────────────────────────────────────────

async function outageChecks(): Promise<void> {
  // The 500 carries a body that says yes to everything: the status alone must decide.
  const allOn = (keys: string[]) => ({ flags: Object.fromEntries(keys.map((k) => [k, { key: k, enabled: true }])) });
  const outages: [string, Answer][] = [
    ["PostHog unreachable (network error)", () => { throw new TypeError("fetch failed"); }],
    ["PostHog HTTP 500", (body) => Response.json(allOn(body.flag_keys_to_evaluate), { status: 500 })],
    ["PostHog answers something that is not JSON", () => new Response("<html>bad gateway</html>", { status: 200 })],
    ["PostHog does not know the flag (deleted, renamed)", () => Response.json({ flags: {} })],
  ];
  for (const [name, answer] of outages) {
    installFakePostHog(answer);
    const owner = await ask(OWNER);
    check(`${name}: all off for the owner`, allOff(owner), JSON.stringify(owner));
  }

  // A PostHog that never answers. Only the request's own abort signal ends
  // it; without one the page would wait as long as PostHog does.
  installFakePostHog(
    (_body, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")));
      }),
  );
  // The guard timer stays referenced: AbortSignal.timeout's own timer does
  // not keep Node alive, and with nothing else pending the process would
  // simply end mid-check.
  const limit = featureFlags.FLAG_TIMEOUT_MS + 1000;
  const started = Date.now();
  let guard: ReturnType<typeof setTimeout> | undefined;
  const hung = await Promise.race([
    viewerFlags.productLensFor(OWNER),
    new Promise<"still waiting">((resolve) => {
      guard = setTimeout(() => resolve("still waiting"), limit);
    }),
  ]);
  clearTimeout(guard);
  const waited = Date.now() - started;
  check(
    `PostHog hangs: off within FLAG_TIMEOUT_MS (${featureFlags.FLAG_TIMEOUT_MS} ms)`,
    hung === false && waited < limit,
    `${JSON.stringify(hung)} after ${waited} ms`,
  );
}

// ─── 4. The declaration and posthog:setup ───────────────────────────────────

function declarationChecks(): void {
  for (const l of LENSES) {
    const d = DECLARED_FLAGS.find((f) => f.key === l.key);
    check(`${l.key} is declared for ${l.owner ? "the owner only" : "nobody"}`, d?.audience === (l.owner ? "owner" : "nobody"), JSON.stringify(d?.audience));
    const expected = l.owner
      ? [{ properties: [{ key: "email", type: "person", operator: "exact", value: OWNER_EMAILS }], rollout_percentage: 100 }]
      : [{ properties: [], rollout_percentage: 0 }];
    check(`${l.key}: its conditions are exactly that`, conditionsSignature(d?.groups) === conditionsSignature(expected), conditionsSignature(d?.groups));
    check(`${l.key}: no condition a stored property could decide`, d !== undefined && unsafeCondition(d.groups) === null, d ? String(unsafeCondition(d.groups)) : "undeclared");
  }
  check(
    "unsafeCondition refuses icontains, a stored-only property and a cohort",
    unsafeCondition([{ properties: [{ key: "email", type: "person", operator: "icontains", value: ["x"] }] }]) !== null &&
      unsafeCondition([{ properties: [{ key: "$geoip_country_code", type: "person", operator: "exact", value: ["PT"] }] }]) !== null &&
      unsafeCondition([{ properties: [{ key: "id", type: "cohort", value: 1 }] }]) !== null,
  );

  // What setup does with each flag, decided by flagPlan.
  const ext = DECLARED_FLAGS.find((f) => f.key === featureFlags.HOME_EXTENSION_CHECK_FLAG);
  if (ext) {
    const plans = {
      missing: flagPlan(ext, undefined),
      "as declared": flagPlan(ext, { active: true, filters: { groups: ext.groups } }),
      "as declared, with PostHog's extra fields": flagPlan(ext, {
        active: true,
        filters: { groups: ext.groups.map((g) => ({ ...g, variant: null, aggregation_group_type_index: null })) },
      }),
      "with the stale is_test_account condition (913845 until CHE-380)": flagPlan(ext, { active: true, filters: { groups: staleTable[ext.key] } }),
      "with icontains instead of exact": flagPlan(ext, {
        active: true,
        filters: { groups: ext.groups.map((g) => ({ ...g, properties: g.properties.map((p) => ({ ...p, operator: "icontains" })) })) },
      }),
      "switched off": flagPlan(ext, { active: false, filters: { groups: ext.groups } }),
    };
    const expected: Record<keyof typeof plans, string> = {
      missing: "create",
      "as declared": "keep",
      "as declared, with PostHog's extra fields": "keep",
      "with the stale is_test_account condition (913845 until CHE-380)": "update",
      "with icontains instead of exact": "update",
      "switched off": "update",
    };
    for (const [state, plan] of Object.entries(plans)) {
      const want = expected[state as keyof typeof plans];
      check(`posthog:setup, flag ${state}: ${want}`, plan === want, plan);
    }
  } else check("home-extension-check is declared", false);

  const setup = readFileSync(join(process.cwd(), "scripts/posthog-setup.ts"), "utf8");
  check("posthog:setup reconciles every declared flag", /for \(const declared of DECLARED_FLAGS\) \w+\.push\(await reconcileFlag\(declared\)\)/.test(setup));
  check(
    "…acting on flagPlan: POST on create, return on keep, PATCH otherwise",
    /const plan = flagPlan\(declared, found\);\s*if \(plan === "create"\) \{\s*const created = await api<BooleanFlag>\("POST"/.test(setup) &&
      /if \(plan === "keep"\) \{[\s\S]*?return found;\s*\}\s*const updated = await api<BooleanFlag>\("PATCH", `\/feature_flags\/\$\{found\.id\}\/`/.test(setup),
  );
  check("…and refusing to write an unsafe condition", /const unsafe = unsafeCondition\(declared\.groups\);\s*if \(unsafe\) throw/.test(setup));
  check("the owner's e-mail is written in one place", !setup.includes(OWNER_EMAIL));
}

// ─── Live (optional) ────────────────────────────────────────────────────────

const POSTHOG_API = "https://us.posthog.com/api/projects/595090";
const SPOOFED_ID = "verify-che-380-spoofed";

async function liveChecks(realFetch: typeof fetch): Promise<void> {
  globalThis.fetch = realFetch;
  await import("dotenv/config");
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  check("live: POSTHOG_PERSONAL_API_KEY is set", Boolean(key));
  if (!key) return;
  const get = async (path: string) => (await fetch(`${POSTHOG_API}${path}`, { headers: { Authorization: `Bearer ${key}` } })).json();

  for (const d of DECLARED_FLAGS) {
    const found = ((await get(`/feature_flags/?search=${d.key}&limit=50`)).results ?? []).find((f: { key: string }) => f.key === d.key);
    check(`live: ${d.key} exists and is active`, found?.active === true, found ? `active=${found.active}` : "missing");
    check(
      `live: ${d.key} has exactly the declared conditions`,
      conditionsSignature(found?.filters?.groups) === conditionsSignature(d.groups),
      conditionsSignature(found?.filters?.groups),
    );
  }

  const stamp = Date.now();
  const owner = await ask({ ...OWNER, clerkUserId: `verify-che-352-owner-${stamp}` });
  check("live: owner gets Product, Release and the extension check, not Marketing", ownerOnly(owner), JSON.stringify(owner));
  const fresh = await ask({ ...FRESH, clerkUserId: `verify-che-352-fresh-${stamp}` });
  check("live: a fresh account gets none", allOff(fresh), JSON.stringify(fresh));
  const test = await ask({ ...TEST, clerkUserId: `verify-che-352-test-${stamp}` });
  check("live: a test account gets none", allOff(test), JSON.stringify(test));
  const lookalike = await ask({ ...FRESH, clerkUserId: `verify-che-352-lookalike-${stamp}`, email: LOOKALIKES[0] });
  check(`live: a look-alike e-mail (${LOOKALIKES[0]}) gets none`, allOff(lookalike), JSON.stringify(lookalike));

  // The CHE-380 attack, with the public token, on a fixed distinct id: set
  // the property, wait until PostHog has stored it (so the check below is
  // not green merely because ingestion is slow), then ask as the server does.
  await fetch("https://us.i.posthog.com/i/v0/e/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: (featureFlags.buildFlagsPayload("", { distinctId: SPOOFED_ID, email: "", isTestAccount: false })).api_key,
      event: "$set",
      distinct_id: SPOOFED_ID,
      properties: { $set: { is_test_account: "true", email: OWNER_EMAIL } },
    }),
  });
  let storedProps: Record<string, unknown> | undefined;
  for (let i = 0; i < 12; i++) {
    storedProps = (await get(`/persons/?distinct_id=${SPOOFED_ID}`)).results?.[0]?.properties;
    if (storedProps?.is_test_account === "true" && storedProps?.email === OWNER_EMAIL) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  check(
    `live: PostHog stores is_test_account="true" and the owner's e-mail for ${SPOOFED_ID} (the attack's precondition)`,
    storedProps?.is_test_account === "true" && storedProps?.email === OWNER_EMAIL,
    JSON.stringify({ is_test_account: storedProps?.is_test_account, email: storedProps?.email }),
  );
  const spoofed = await ask({ ...SPOOFER, clerkUserId: SPOOFED_ID });
  check("live: that stranger gets none", allOff(spoofed), JSON.stringify(spoofed));
}

// A run that ends before its summary — the event loop drained under a pending
// await — is a failure, never a silent exit 0.
let finished = false;
process.on("exit", (code) => {
  if (!finished && code === 0) {
    console.log("\nFAIL  the script ended before its summary");
    process.exitCode = 1;
  }
});

(async () => {
  const realFetch = globalThis.fetch;
  // Quiet the reader's own warnings while it is being fed failures on purpose.
  const warn = console.warn;
  console.warn = () => {};
  contractChecks();
  await wrapperChecks();
  await outageChecks();
  console.warn = warn;
  globalThis.fetch = realFetch;
  declarationChecks();
  if (process.argv.includes("--live")) await liveChecks(realFetch);
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  finished = true;
  process.exit(failures === 0 ? 0 : 1);
})();
