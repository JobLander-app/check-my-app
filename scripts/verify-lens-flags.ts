// CHE-352 / CHE-367 / CHE-380 / CHE-381: the flags the server reads — the
// three beta lenses of the redesign (CHE-348) and the extension check — decide
// only on what the server sends. `lens-product`, `lens-release` and
// `home-extension-check` are on for the owner's e-mail only, `lens-marketing`
// for no one; test accounts and anonymous visitors are always off. This
// proves, without PostHog:
//
//   1. the keys are the ones the epic's shared contract names, letter for
//      letter, and each wrapper asks PostHog for its own key and nothing else;
//   2. against a fake PostHog that evaluates scripts/posthog-flags.ts the way
//      PostHog does — falling back to STORED person properties for anything
//      the request does not override, `exact` ignoring case, server-only
//      flags left out of a request that does not say it is a server — the
//      owner gets Product and Release and not Marketing; a fresh account, a
//      look-alike e-mail, an empty e-mail, a test account and no one get
//      nothing; a stranger who stored is_test_account="true" or the owner's
//      e-mail on their own distinct id gets nothing (CHE-380), even from the
//      stale condition that was live on home-extension-check; and a browser
//      (posthog-js: no overrides, no runtime) is not answered at all;
//   3. a PostHog that hangs is cut off at FLAG_TIMEOUT_MS, and one that errors
//      or answers garbage is off;
//   4. the declaration allows only `exact` conditions on the properties the
//      server sends; flagPlan rewrites any drift that changes an audience,
//      inside or outside the conditions (CHE-381); and reconcileFlag — the
//      code posthog:setup runs — writes exactly the declared body, reads it
//      back, and refuses what a write cannot clear;
//   5. no browser code can read these flags: no client module mentions their
//      keys or imports the server flag modules (CHE-381).
//
// --live asks the real project: every declared flag holds exactly the
// declared state; the owner, a fresh account, a test account and a look-alike
// e-mail get what they should; a person with is_test_account="true" and the
// owner's e-mail stored (set here with the public token, as anyone could) gets
// nothing as a stranger, nothing with an empty e-mail, and nothing through a
// browser-shaped request. That person is deleted at the end, pass or fail.
// Needs POSTHOG_PERSONAL_API_KEY (.env); not in CI.
//
// Usage: npm run verify:lens-flags [-- --live]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as featureFlags from "@/lib/feature-flags";
import * as viewerFlags from "@/lib/viewer-flags";
import {
  DECLARED_FLAGS,
  declaredState,
  flagPlan,
  flagState,
  flagWriteBody,
  OWNER_EMAILS,
  reconcileFlag,
  unsafeCondition,
  type DeclaredFlag,
  type FlagCondition,
  type PostHogApi,
} from "./posthog-flags";

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
// For each property a condition reads: the request's override if it sent one
// (an empty string is an override), otherwise what is stored about the
// person. `exact` compares as strings ignoring case, as PostHog does (checked
// live on 2026-10-01: SOROKINVJ@GMAIL.COM matches); `icontains` is
// case-insensitive substring. Any other operator answers 400. A flag at
// runtime "server" is left out of the answer unless the request says
// `evaluation_runtime: "server"`. Early-access `super_groups` are evaluated
// like groups.

type Body = { distinct_id: string; person_properties?: Record<string, unknown>; flag_keys_to_evaluate: string[]; evaluation_runtime?: string };
type Answer = (body: Body, init: RequestInit) => Response | Promise<Response>;
type FakeFlag = { evaluation_runtime?: string; filters: { groups: unknown[]; super_groups?: unknown[] } };

const calls: Body[] = [];
const stored: Record<string, Record<string, string>> = {};

function installFakePostHog(answer: Answer): void {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    calls.push(body);
    return answer(body, init ?? {});
  }) as typeof fetch;
}

function matches(groups: unknown[], body: Body): boolean {
  return (groups as FlagCondition[]).some((g) => {
    const props = g.properties.every((p) => {
      const overrides = body.person_properties ?? {};
      const raw = p.key in overrides ? overrides[p.key] : stored[body.distinct_id]?.[p.key];
      if (raw === undefined) return false;
      const v = String(raw).toLowerCase();
      if (p.operator === "exact") return p.value.some((x) => String(x).toLowerCase() === v);
      if ((p.operator as string) === "icontains") return p.value.some((x) => v.includes(String(x).toLowerCase()));
      throw new Error(`unknown operator ${p.operator}`);
    });
    return props && g.rollout_percentage >= 100;
  });
}

function evaluate(table: Record<string, FakeFlag>, body: Body): Record<string, { key: string; enabled: boolean }> {
  const result: Record<string, { key: string; enabled: boolean }> = {};
  for (const key of body.flag_keys_to_evaluate) {
    const flag = table[key];
    if (!flag) continue;
    if (flag.evaluation_runtime === "server" && body.evaluation_runtime !== "server") continue;
    result[key] = { key, enabled: matches(flag.filters.super_groups ?? [], body) || matches(flag.filters.groups, body) };
  }
  return result;
}

function postHogWith(table: Record<string, FakeFlag>): Answer {
  return (body) => {
    try {
      return Response.json({ flags: evaluate(table, body) });
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 400 });
    }
  };
}

const declaredTable: Record<string, FakeFlag> = Object.fromEntries(DECLARED_FLAGS.map((f) => [f.key, flagWriteBody(f)]));
// home-extension-check as it was live until CHE-380 (id 913845, read from
// PostHog on 2026-10-01): the owner condition plus a stale one on a property
// the browser can set for itself.
const STALE_GROUPS = [
  ...DECLARED_FLAGS.find((f) => f.key === featureFlags.HOME_EXTENSION_CHECK_FLAG)!.groups,
  { properties: [{ key: "is_test_account", type: "person", operator: "exact", value: ["true"] }], rollout_percentage: 100 },
];
const staleTable: Record<string, FakeFlag> = {
  ...declaredTable,
  [featureFlags.HOME_EXTENSION_CHECK_FLAG]: { ...declaredTable[featureFlags.HOME_EXTENSION_CHECK_FLAG], filters: { groups: STALE_GROUPS } },
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
          JSON.stringify(Object.keys(c.person_properties ?? {}).sort()) === JSON.stringify([...featureFlags.FLAG_PERSON_PROPERTIES].sort()) &&
          c.person_properties?.email === OWNER_EMAIL &&
          c.person_properties?.is_test_account === false,
      ),
    JSON.stringify(calls[0]?.person_properties),
  );
  check("every request says it is a server (CHE-381)", calls.length > 0 && calls.every((c) => c.evaluation_runtime === "server"), JSON.stringify(calls[0]?.evaluation_runtime));

  check("the fake matches PostHog: exact ignores case", (await ask({ ...OWNER, email: OWNER_EMAIL.toUpperCase() })).product === true);

  const fresh = await ask(FRESH);
  check("fresh account: all off", allOff(fresh), JSON.stringify(fresh));

  for (const email of LOOKALIKES) {
    const a = await ask({ ...FRESH, email });
    check(`look-alike e-mail ${email}: all off`, allOff(a), JSON.stringify(a));
  }

  // CHE-380: anyone can `$set` these on their own distinct id with the public token.
  stored[SPOOFER.clerkUserId] = { is_test_account: "true", email: OWNER_EMAIL };
  const spoofed = await ask(SPOOFER);
  check("stranger with stored is_test_account=\"true\" and the owner's stored e-mail: all off", allOff(spoofed), JSON.stringify(spoofed));
  // CHE-381: an empty e-mail is still an override, or the stored one decides.
  calls.length = 0;
  const empty = await ask({ ...SPOOFER, email: "" });
  check("…with an empty e-mail of their own: all off", allOff(empty), JSON.stringify(empty));
  check("…because the empty e-mail is sent as an override", calls.length > 0 && calls.every((c) => c.person_properties?.email === ""), JSON.stringify(calls[0]?.person_properties));
  installFakePostHog(postHogWith(staleTable));
  const spoofedStale = await ask(SPOOFER);
  check("…even against the stale is_test_account condition that was live until CHE-380", allOff(spoofedStale), JSON.stringify(spoofedStale));
  const ownerStale = await ask(OWNER);
  check("…while the owner still gets the extension check there", ownerStale.extension === true, JSON.stringify(ownerStale));
  installFakePostHog(postHogWith(declaredTable));

  // CHE-381: what posthog-js asks from the browser — no overrides, no runtime.
  const browser = evaluate(declaredTable, { distinct_id: SPOOFER.clerkUserId, flag_keys_to_evaluate: LENSES.map((l) => l.key) });
  check("a browser-shaped request with the owner's stored e-mail gets no answer for any of them", Object.keys(browser).length === 0, JSON.stringify(browser));

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

// ─── 4. The declaration, flagPlan and reconcileFlag ─────────────────────────

// A flag as PostHog returns it once it holds the declared body exactly: its
// own fields and defaults around what we wrote.
function asPostHogHolds(d: DeclaredFlag, id = 1): Record<string, unknown> {
  const body = flagWriteBody(d);
  return {
    id,
    ...body,
    deleted: false,
    archived: false,
    bucketing_identifier: "distinct_id",
    evaluation_contexts: [],
    features: [],
    experiment_set: [],
    created_at: "2026-10-01T21:48:19Z",
    version: 1,
    filters: { ...body.filters, groups: body.filters.groups.map((g) => ({ ...g, aggregation_group_type_index: null })), aggregation_group_type_index: null },
  };
}

const ENROLLMENT = (key: string) => [
  { properties: [{ key: `$feature_enrollment/${key}`, type: "person", operator: "exact", value: ["true"] }], rollout_percentage: 100 },
];

function declarationChecks(): void {
  for (const l of LENSES) {
    const d = DECLARED_FLAGS.find((f) => f.key === l.key);
    check(`${l.key} is declared for ${l.owner ? "the owner only" : "nobody"}`, d?.audience === (l.owner ? "owner" : "nobody"), JSON.stringify(d?.audience));
    if (!d) continue;
    const expected = l.owner
      ? [{ properties: [{ key: "email", type: "person", operator: "exact", value: OWNER_EMAILS }], rollout_percentage: 100 }]
      : [{ properties: [], rollout_percentage: 0 }];
    const body = flagWriteBody(d);
    check(`${l.key}: its conditions are exactly that`, JSON.stringify(body.filters.groups) === JSON.stringify(expected), JSON.stringify(body.filters.groups));
    check(`${l.key}: no condition a stored property could decide`, unsafeCondition(body.filters.groups) === null, String(unsafeCondition(body.filters.groups)));
    check(`${l.key}: server-only, active, no experience continuity`, body.evaluation_runtime === "server" && body.active === true && body.ensure_experience_continuity === false);
  }
  check(
    "unsafeCondition refuses icontains, a stored-only property and a cohort",
    unsafeCondition([{ properties: [{ key: "email", type: "person", operator: "icontains", value: ["x"] }] }]) !== null &&
      unsafeCondition([{ properties: [{ key: "$geoip_country_code", type: "person", operator: "exact", value: ["PT"] }] }]) !== null &&
      unsafeCondition([{ properties: [{ key: "id", type: "cohort", value: 1 }] }]) !== null,
  );

  // What setup plans for a flag in each state PostHog might hold.
  const ext = DECLARED_FLAGS.find((f) => f.key === featureFlags.HOME_EXTENSION_CHECK_FLAG)!;
  const held = asPostHogHolds(ext);
  const heldFilters = held.filters as Record<string, unknown>;
  const cases: [string, Record<string, unknown> | undefined, "create" | "keep" | "update"][] = [
    ["missing", undefined, "create"],
    ["exactly as declared, with PostHog's own fields", held, "keep"],
    ["with the stale is_test_account condition (913845 until CHE-380)", { ...held, filters: { ...heldFilters, groups: STALE_GROUPS } }, "update"],
    ["with icontains instead of exact", { ...held, filters: { ...heldFilters, groups: ext.groups.map((g) => ({ ...g, properties: g.properties.map((p) => ({ ...p, operator: "icontains" })) })) } }, "update"],
    ["switched off", { ...held, active: false }, "update"],
    ["evaluated in the browser too (runtime all)", { ...held, evaluation_runtime: "all" }, "update"],
    ["with an early-access enrollment condition anyone can $set", { ...held, filters: { ...heldFilters, super_groups: ENROLLMENT(ext.key) } }, "update"],
    ["with holdout groups", { ...held, filters: { ...heldFilters, holdout_groups: [{ properties: [], rollout_percentage: 10, variant: "holdout-1" }] } }, "update"],
    ["in a holdout", { ...held, holdout: { id: 3 } }, "update"],
    ["linked to an early-access feature", { ...held, features: [{ id: 7 }] }, "update"],
    ["linked to an experiment", { ...held, experiment_set: [11] }, "update"],
    ["with experience continuity", { ...held, ensure_experience_continuity: true }, "update"],
    ["made multivariate", { ...held, filters: { ...heldFilters, multivariate: { variants: [{ key: "a", rollout_percentage: 100 }] } } }, "update"],
    ["deleted", { ...held, deleted: true }, "update"],
  ];
  for (const [state, found, want] of cases) {
    const plan = flagPlan(ext, found);
    check(`flagPlan, flag ${state}: ${want}`, plan === want, plan);
  }
}

// A fake PostHog admin API with the semantics reconcileFlag relies on: a POST
// fills PostHog's defaults; a PATCH replaces the fields it carries, `filters`
// whole; links to early-access features, experiments and holdouts are other
// objects a flag PATCH does not touch.
function fakeAdmin(initial: Record<string, unknown>[]) {
  const flagsById = new Map<number, Record<string, unknown>>(initial.map((f) => [f.id as number, structuredClone(f)]));
  const writes: { method: string; path: string; body: unknown }[] = [];
  let nextId = 900;
  const api: PostHogApi = async (method, path, body) => {
    const byId = path.match(/^\/feature_flags\/(\d+)\/$/);
    if (method === "GET" && path.startsWith("/feature_flags/?search=")) {
      const q = decodeURIComponent(path.split("search=")[1].split("&")[0]);
      return { results: [...flagsById.values()].filter((f) => String(f.key).includes(q)).map((f) => structuredClone(f)) };
    }
    if (method === "GET" && byId) {
      const f = flagsById.get(Number(byId[1]));
      if (!f) throw new Error(`404 ${path}`);
      return structuredClone(f);
    }
    writes.push({ method, path, body: structuredClone(body) });
    const b = body as Record<string, unknown>;
    if (method === "POST" && path === "/feature_flags/") {
      const f = { deleted: false, evaluation_runtime: "all", ensure_experience_continuity: false, bucketing_identifier: "distinct_id", evaluation_contexts: [], features: [], experiment_set: [], ...b, id: nextId++ };
      flagsById.set(f.id as number, f);
      return structuredClone(f);
    }
    if (method === "PATCH" && byId) {
      const f = flagsById.get(Number(byId[1]));
      if (!f) throw new Error(`404 ${path}`);
      Object.assign(f, b);
      return structuredClone(f);
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, writes, flagsById };
}

async function reconcileChecks(): Promise<void> {
  const quiet = () => {};
  for (const d of DECLARED_FLAGS) {
    const { api, writes } = fakeAdmin([]);
    let error = "";
    const result = await reconcileFlag(api, d, quiet).catch((e: Error) => ((error = e.message), null));
    check(
      `reconcileFlag creates a missing ${d.key} with exactly the declared body`,
      !error && writes.length === 1 && writes[0].method === "POST" && JSON.stringify(writes[0].body) === JSON.stringify(flagWriteBody(d)),
      error || JSON.stringify(writes.map((w) => [w.method, w.body])),
    );
    check(`…and what PostHog then holds is the declared state`, result !== null && flagState(result) === declaredState(d), result ? flagState(result) : error);
  }

  const ext = DECLARED_FLAGS.find((f) => f.key === featureFlags.HOME_EXTENSION_CHECK_FLAG)!;
  const held = asPostHogHolds(ext, 913845);
  const heldFilters = held.filters as Record<string, unknown>;
  const fixable: [string, Record<string, unknown>][] = [
    ["the stale 913845", { ...held, evaluation_runtime: "all", filters: { ...heldFilters, groups: STALE_GROUPS } }],
    ["an early-access enrollment condition", { ...held, filters: { ...heldFilters, super_groups: ENROLLMENT(ext.key) } }],
    ["icontains", { ...held, filters: { ...heldFilters, groups: [{ ...ext.groups[0], properties: [{ ...ext.groups[0].properties[0], operator: "icontains" }] }] } }],
  ];
  for (const [name, start] of fixable) {
    const { api, writes, flagsById } = fakeAdmin([start]);
    let error = "";
    await reconcileFlag(api, ext, quiet).catch((e: Error) => (error = e.message));
    const after = flagsById.get(913845)!;
    check(
      `reconcileFlag rewrites ${name} with one PATCH of exactly the declared body`,
      !error && writes.length === 1 && writes[0].method === "PATCH" && writes[0].path === "/feature_flags/913845/" && JSON.stringify(writes[0].body) === JSON.stringify(flagWriteBody(ext)),
      error || JSON.stringify(writes.map((w) => [w.method, w.path, w.body])),
    );
    check(`…and PostHog then holds the declared state`, flagState(after) === declaredState(ext), flagState(after));
  }

  {
    const { api, writes } = fakeAdmin([held]);
    let error = "";
    await reconcileFlag(api, ext, quiet).catch((e: Error) => (error = e.message));
    check("reconcileFlag leaves a flag that is already as declared alone", !error && writes.length === 0, error || JSON.stringify(writes));
  }

  for (const [name, start] of [
    ["linked to an early-access feature", { ...held, features: [{ id: 7 }] }],
    ["in a holdout", { ...held, holdout: { id: 3 } }],
  ] as [string, Record<string, unknown>][]) {
    const { api } = fakeAdmin([start]);
    let error = "";
    await reconcileFlag(api, ext, quiet).catch((e: Error) => (error = e.message));
    check(`reconcileFlag refuses to call a flag ${name} done: it throws after the write`, /is not as declared after setup/.test(error), error || "no error");
  }

  const setup = readFileSync(join(process.cwd(), "scripts/posthog-setup.ts"), "utf8");
  check("posthog:setup reconciles every declared flag through reconcileFlag", /for \(const declared of DECLARED_FLAGS\) \w+\.push\(await reconcileFlag\(api, declared\)\)/.test(setup));
  check("…and writes no server-read flag by itself", !/DeclaredFlag|flagWriteBody|evaluation_runtime/.test(setup));
  check("the owner's e-mail is written in one place", !setup.includes(OWNER_EMAIL));
}

// ─── 5. No browser code reads these flags ───────────────────────────────────
//
// posthog-js evaluates flags without our overrides, from properties the
// browser stores itself, so a browser read of one of these flags would answer
// from what the visitor chose. Server-only runtime already withholds them; this
// keeps anyone from writing the read in the first place. A module is browser
// code when it says "use client" or imports posthog-js.

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|jsx|mjs)$/.test(name) ? [path] : [];
  });
}

// Code only: a comment saying "this prop is the flag X, evaluated by the page"
// is how a browser component documents that it does NOT read the flag.
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function browserChecks(): void {
  const root = process.cwd();
  const keys = LENSES.map((l) => l.key);
  const names = LENSES.map((l) => l.constant);
  const offenders: string[] = [];
  let browserModules = 0;
  for (const path of sourceFiles(join(root, "src"))) {
    const text = withoutComments(readFileSync(path, "utf8"));
    const rel = relative(root, path);
    const isBrowser = /^\s*["']use client["']/m.test(text) || /from ["']posthog-js["']/.test(text);
    if (isBrowser) {
      browserModules++;
      for (const k of [...keys, ...names]) if (text.includes(k)) offenders.push(`${rel} mentions ${k}`);
      if (/from ["'](@\/lib|\.{1,2})\/(?:[\w-]+\/)*(feature-flags|viewer-flags)["']/.test(text)) offenders.push(`${rel} imports the server flag modules`);
    } else if (rel !== join("src", "lib", "feature-flags.ts")) {
      for (const k of keys) if (text.includes(`"${k}"`) || text.includes(`'${k}'`)) offenders.push(`${rel} spells out "${k}" instead of importing its constant`);
    }
  }
  check(`browser modules found to inspect (${browserModules})`, browserModules > 0);
  check("no browser module reads a server flag, and no other module spells out its key", offenders.length === 0, offenders.join("; "));
}

// ─── Live (optional) ────────────────────────────────────────────────────────

const POSTHOG_API = "https://us.posthog.com/api/projects/595090";
const SPOOFED_ID = "verify-che-381-spoofed";

async function liveChecks(realFetch: typeof fetch): Promise<void> {
  globalThis.fetch = realFetch;
  await import("dotenv/config");
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  check("live: POSTHOG_PERSONAL_API_KEY is set", Boolean(key));
  if (!key) return;
  const admin = async (method: string, path: string) => {
    const res = await fetch(`${POSTHOG_API}${path}`, { method, headers: { Authorization: `Bearer ${key}` } });
    return { status: res.status, json: res.status === 204 || method === "DELETE" ? null : await res.json() };
  };

  for (const d of DECLARED_FLAGS) {
    const match = ((await admin("GET", `/feature_flags/?search=${d.key}&limit=50`)).json.results ?? []).find((f: { key: string }) => f.key === d.key);
    const full = match ? (await admin("GET", `/feature_flags/${match.id}/`)).json : null;
    check(`live: ${d.key} holds exactly the declared state`, full !== null && flagState(full) === declaredState(d), full ? flagState(full) : "missing");
  }

  const stamp = Date.now();
  const owner = await ask({ ...OWNER, clerkUserId: `verify-che-381-owner-${stamp}` });
  check("live: owner gets Product, Release and the extension check, not Marketing", ownerOnly(owner), JSON.stringify(owner));
  const fresh = await ask({ ...FRESH, clerkUserId: `verify-che-381-fresh-${stamp}` });
  check("live: a fresh account gets none", allOff(fresh), JSON.stringify(fresh));
  const test = await ask({ ...TEST, clerkUserId: `verify-che-381-test-${stamp}` });
  check("live: a test account gets none", allOff(test), JSON.stringify(test));
  const lookalike = await ask({ ...FRESH, clerkUserId: `verify-che-381-lookalike-${stamp}`, email: LOOKALIKES[0] });
  check(`live: a look-alike e-mail (${LOOKALIKES[0]}) gets none`, allOff(lookalike), JSON.stringify(lookalike));

  // The attack, with the public token: store is_test_account="true" and the
  // owner's e-mail on a distinct id, wait until PostHog has stored them (so
  // nothing below is green merely because ingestion is slow), then ask as the
  // server does and as a browser does. The person is deleted afterwards
  // whatever happened.
  try {
    await fetch("https://us.i.posthog.com/i/v0/e/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: featureFlags.POSTHOG_FLAGS_TOKEN,
        event: "$set",
        distinct_id: SPOOFED_ID,
        properties: { $set: { is_test_account: "true", email: OWNER_EMAIL } },
      }),
    });
    let storedProps: Record<string, unknown> | undefined;
    for (let i = 0; i < 24; i++) {
      storedProps = (await admin("GET", `/persons/?distinct_id=${SPOOFED_ID}`)).json.results?.[0]?.properties;
      if (storedProps?.is_test_account === "true" && storedProps?.email === OWNER_EMAIL) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    check(
      `live: PostHog stores is_test_account="true" and the owner's e-mail for ${SPOOFED_ID} (the attack's precondition)`,
      storedProps?.is_test_account === "true" && storedProps?.email === OWNER_EMAIL,
      JSON.stringify({ is_test_account: storedProps?.is_test_account, email: storedProps?.email }),
    );
    const spoofed = await ask({ ...SPOOFER, clerkUserId: SPOOFED_ID });
    check("live: that person, as a stranger, gets none", allOff(spoofed), JSON.stringify(spoofed));
    const empty = await ask({ ...SPOOFER, clerkUserId: SPOOFED_ID, email: "" });
    check("live: that person with an empty e-mail gets none", allOff(empty), JSON.stringify(empty));
    const res = await fetch(featureFlags.POSTHOG_FLAGS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: featureFlags.POSTHOG_FLAGS_TOKEN, distinct_id: SPOOFED_ID, flag_keys_to_evaluate: LENSES.map((l) => l.key) }),
    });
    const answered = Object.keys(((await res.json()) as { flags?: object }).flags ?? {});
    check("live: a browser-shaped request for that person gets no answer for any of them", res.ok && answered.length === 0, `HTTP ${res.status} ${JSON.stringify(answered)}`);
  } finally {
    let left = 1;
    for (let i = 0; i < 12 && left > 0; i++) {
      const people = (await admin("GET", `/persons/?distinct_id=${SPOOFED_ID}`)).json.results ?? [];
      for (const p of people) await admin("DELETE", `/persons/${p.id}/`);
      left = people.length === 0 ? 0 : ((await admin("GET", `/persons/?distinct_id=${SPOOFED_ID}`)).json.results ?? []).length;
      if (left > 0) await new Promise((r) => setTimeout(r, 5000));
    }
    check(`live: no person is left behind (${SPOOFED_ID} deleted)`, left === 0, `${left} left`);
  }
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
  await reconcileChecks();
  browserChecks();
  if (process.argv.includes("--live")) await liveChecks(realFetch);
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  finished = true;
  process.exit(failures === 0 ? 0 : 1);
})();
