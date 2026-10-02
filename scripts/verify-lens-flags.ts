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
//      back, and refuses what a write cannot clear; and posthog:setup itself,
//      run whole against a fake PostHog, does nothing else to a declared flag
//      (CHE-386);
//   5. no browser code can read these flags: no module in the client graph —
//      read from its syntax tree — imports the server flag modules, mentions
//      a key or its constant, builds a key at run time, or imports a module
//      chosen at run time (CHE-381, CHE-386).
//
// --live asks the real project: every declared flag holds exactly the
// declared state; the owner, a fresh account, a test account and a look-alike
// e-mail get what they should; a person with is_test_account="true" and the
// owner's e-mail stored (set here with the public token, as anyone could) gets
// nothing as a stranger, nothing with an empty e-mail, and nothing through a
// request that does not say it is a server. That person is this run's own and
// is deleted at the end, pass or fail.
// Needs POSTHOG_PERSONAL_API_KEY (.env); not in CI.
//
// Usage: npm run verify:lens-flags [-- --live]

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { API as SETUP_API, makeApi, runSetup } from "./posthog-setup";
import ts from "typescript";

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
    ["bucketed by device", { ...held, bucketing_identifier: "device_id" }, "update"],
    ["limited to evaluation contexts", { ...held, evaluation_contexts: ["web"] }, "update"],
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
    ["a drifted bucketing identifier and evaluation contexts", { ...held, bucketing_identifier: "device_id", evaluation_contexts: ["web"] }],
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

}

// ─── 4b. The whole of posthog:setup, against a fake PostHog (CHE-386) ────────
//
// reconcileFlag is one function of setup. A flag write added to setup beside
// it, or a request changed on its way out, would pass every check above and be
// found only by --live, after the bad write. So setup itself is run here —
// `runSetup` through its own `makeApi`, with only `fetch` replaced — and every
// write it makes to a flag is read: a write that touches a declared flag
// carries exactly the declared body, and when setup is done each declared key
// is held by one flag in the declared state.

function fakePostHog(initial: Record<string, unknown>[], onTheWay: (body: string) => string = (b) => b) {
  const admin = fakeAdmin(initial);
  let nextId = 5000;
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const address = String(url);
    if (!address.startsWith(SETUP_API)) throw new Error(`setup called outside the project's API: ${address}`);
    const path = address.slice(SETUP_API.length);
    const method = (init?.method ?? "GET") as "GET" | "POST" | "PATCH";
    const body = typeof init?.body === "string" ? JSON.parse(onTheWay(init.body)) : undefined;
    if (path.startsWith("/feature_flags/")) {
      try {
        return Response.json(await admin.api(method, path, body));
      } catch (err) {
        return Response.json({ detail: String(err) }, { status: 404 });
      }
    }
    // Experiments and insights: none exist, each create is answered with an id.
    if (method === "GET") return Response.json({ results: [] });
    const id = nextId++;
    return Response.json({ id, short_id: `s${id}`, start_date: null, ...(body as Record<string, unknown>) });
  }) as typeof fetch;
  return { fetchImpl, writes: admin.writes, flagsById: admin.flagsById };
}

/** What setup did to a declared flag that it should not have, in words. Empty when it did nothing wrong. */
function setupOffenders(writes: { method: string; path: string; body: unknown }[], flagsById: Map<number, Record<string, unknown>>): string[] {
  const declared = new Map(DECLARED_FLAGS.map((d) => [d.key, d]));
  const out: string[] = [];
  for (const w of writes) {
    const id = w.path.match(/^\/feature_flags\/(\d+)\/$/)?.[1];
    const named = new Set([String((w.body as { key?: unknown } | undefined)?.key ?? ""), id ? String(flagsById.get(Number(id))?.key ?? "") : ""]);
    for (const key of named) {
      const d = declared.get(key);
      if (d && JSON.stringify(w.body) !== JSON.stringify(flagWriteBody(d))) out.push(`${w.method} ${w.path} writes ${key} with a body that is not the declared one`);
    }
  }
  for (const d of DECLARED_FLAGS) {
    const held = [...flagsById.values()].filter((f) => f.key === d.key);
    if (held.length !== 1) out.push(`${held.length} flags hold ${d.key} after setup`);
    else if (flagState(held[0]) !== declaredState(d)) out.push(`${d.key} is not as declared after setup`);
  }
  return out;
}

async function wholeSetupChecks(): Promise<void> {
  const quiet = () => {};
  const ext = DECLARED_FLAGS.find((f) => f.key === featureFlags.HOME_EXTENSION_CHECK_FLAG)!;
  const stale = { ...asPostHogHolds(ext, 913845), evaluation_runtime: "all", filters: { groups: STALE_GROUPS } };
  const ICONTAINS = { filters: { groups: [{ properties: [{ key: "email", type: "person", operator: "icontains", value: ["@"] }], rollout_percentage: 100 }] } };

  for (const [name, initial] of [["an empty project", []], ["a project holding the stale 913845", [stale]]] as [string, Record<string, unknown>[]][]) {
    const ph = fakePostHog(initial);
    let error = "";
    await runSetup(makeApi(ph.fetchImpl, "fake-key"), { launch: false, log: quiet }).catch((e: Error) => (error = e.message));
    const offenders = setupOffenders(ph.writes, ph.flagsById);
    const flagWrites = ph.writes.filter((w) => DECLARED_FLAGS.some((d) => d.key === (w.body as { key?: string }).key));
    check(
      `posthog:setup, run whole on ${name}: every declared flag written once, as declared, and nothing else done to one`,
      !error && offenders.length === 0 && flagWrites.length === DECLARED_FLAGS.length,
      error || offenders.join("; ") || `${flagWrites.length} writes`,
    );
  }

  // The same audit must see what the two bypasses would do (shown red here, so
  // the day one is written into setup the check above is what goes red).
  {
    const ph = fakePostHog([]);
    const api = makeApi(ph.fetchImpl, "fake-key");
    let error = "";
    await runSetup(api, { launch: false, log: quiet }).catch((e: Error) => (error = e.message));
    const id = [...ph.flagsById.values()].find((f) => f.key === ext.key)?.id;
    if (!error && id !== undefined) await api("PATCH", `/feature_flags/${id}/`, ICONTAINS);
    const offenders = setupOffenders(ph.writes, ph.flagsById);
    check("…a further PATCH of a declared flag after the loop (icontains) is caught", !error && offenders.length === 2, error.split("\n")[0] || offenders.join("; ") || "nothing caught");
  }
  {
    const ph = fakePostHog([], (body) => body.replaceAll('"operator":"exact"', '"operator":"icontains"'));
    let error = "";
    await runSetup(makeApi(ph.fetchImpl, "fake-key"), { launch: false, log: quiet }).catch((e: Error) => (error = e.message));
    const offenders = setupOffenders(ph.writes, ph.flagsById);
    check(
      "…a request rewritten on its way out (exact → icontains) stops setup at the read-back and is caught",
      /is not as declared after setup/.test(error) && offenders.length > 0,
      `${error.split("\n")[0] || "no error"} · ${offenders.length} offenders`,
    );
  }

  const setup = readFileSync(join(process.cwd(), "scripts/posthog-setup.ts"), "utf8");
  check("setup reconciles every declared flag through reconcileFlag", /for \(const declared of DECLARED_FLAGS\) \w+\.push\(await reconcileFlag\(api, declared, log\)\)/.test(setup));
  check("…and spells out no server-read flag by itself", !/DeclaredFlag|flagWriteBody|evaluation_runtime/.test(setup));
  check("the owner's e-mail is written in one place", !setup.includes(OWNER_EMAIL));
  const entry = setup.slice(setup.indexOf("if (require.main === module)"));
  check(
    "run as a script, setup is runSetup through makeApi and the real fetch — the lines that start it make no request of their own",
    entry.startsWith("if (require.main === module)") && /await runSetup\(makeApi\(fetch, key\), \{ launch: process\.argv\.includes\("--launch"\) \}\);/.test(entry) && !/\bapi\(|fetch\(/.test(entry),
  );
  check("…and nothing in setup calls fetch but makeApi", (setup.match(/\bfetchImpl\(/g) ?? []).length === 1 && !/[^.\w]fetch\(/.test(setup));
}

// ─── 5. No browser code reads these flags ───────────────────────────────────
//
// posthog-js evaluates flags without our overrides, from properties the
// browser stores itself, so a browser read of one of these flags would answer
// from what the visitor chose. Server-only runtime already withholds them; this
// keeps anyone from writing the read in the first place.
//
// Browser code is the client module graph, as Next.js builds it: every module
// that says "use client" or imports posthog-js, and everything those import,
// transitively — a helper without the directive is bundled for the browser
// all the same. The walk stops at a "use server" module: a client component
// that imports a server action receives a reference to it, not its code
// (src/app/onboarding/actions.ts reads the extension flag exactly that way).
// Type-only imports are erased and are not followed. Nothing in that graph
// may reach feature-flags / viewer-flags or mention a server flag's key or
// constant.

const SOURCE = /\.(ts|tsx|js|jsx|mjs)$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return SOURCE.test(name) ? [path] : [];
  });
}

// What a module is, read from its syntax tree and not from its text (CHE-386).
// The text was read with patterns before, and four ways around them exited 0:
// a dynamic import written as a template literal, a path with a `.js` suffix,
// a string holding "/*" or "//" that made the comment stripper eat the code
// after it, and a flag key put together at run time. A tree has none of the
// first three problems by construction; the fourth is a rule below.
//
// Comments are not in it: a comment saying "this prop is the flag X, evaluated
// by the page" is how a browser component documents that it does NOT read the flag.
type Module = {
  directive: "use client" | "use server" | null;
  /** Module specifiers pulled into the bundle: imports, re-exports, dynamic imports, requires — nothing that is types only. */
  imports: string[];
  /** A dynamic import or require whose module is decided at run time: `import(\`@/lib/${x}\`)`. */
  opaqueImports: string[];
  identifiers: Set<string>;
  /** Every string and every piece of a template literal, as written. */
  strings: string[];
  /** A string that something is appended to at run time: the head of `\`lens-${x}\``, the left side of `"lens-" + x`. */
  stems: string[];
};

function readModule(path: string, source: string): Module {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : path.endsWith(".jsx") ? ts.ScriptKind.JSX : /\.(js|mjs)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const m: Module = { directive: null, imports: [], opaqueImports: [], identifiers: new Set(), strings: [], stems: [] };
  for (const s of file.statements) {
    if (!ts.isExpressionStatement(s) || !ts.isStringLiteral(s.expression)) break;
    if (s.expression.text === "use client" || s.expression.text === "use server") m.directive = s.expression.text;
  }
  // `import { type A, type B } from "x"` is erased like `import type`; one value among them keeps the import.
  const typesOnly = (elements: readonly { isTypeOnly: boolean }[]) => elements.length > 0 && elements.every((e) => e.isTypeOnly);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const c = node.importClause;
      const erased = c !== undefined && (c.isTypeOnly || (!c.name && c.namedBindings !== undefined && ts.isNamedImports(c.namedBindings) && typesOnly(c.namedBindings.elements)));
      if (!erased) m.imports.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const erased = node.isTypeOnly || (node.exportClause !== undefined && ts.isNamedExports(node.exportClause) && typesOnly(node.exportClause.elements));
      if (!erased) m.imports.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      if (!node.isTypeOnly) m.imports.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const arg = node.arguments[0];
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) m.imports.push(arg.text);
      else if (arg) m.opaqueImports.push(arg.getText(file));
    }
    if (ts.isIdentifier(node)) m.identifiers.add(node.text);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      m.strings.push(node.text);
      if (ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken && node.parent.left === node) m.stems.push(node.text);
    }
    if (ts.isTemplateExpression(node)) {
      m.strings.push(node.head.text, ...node.templateSpans.map((s) => s.literal.text));
      m.stems.push(node.head.text, ...node.templateSpans.slice(0, -1).map((s) => s.literal.text));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return m;
}

function resolveModule(root: string, from: string, spec: string, files: Set<string>): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(root, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = join(from, "..", spec);
  else return null; // a package: not ours to walk
  // "./x.js" names x.ts as well: the suffix a bundler accepts for a TypeScript file.
  const bare = base.replace(/\.(js|jsx|mjs)$/, "");
  const candidates = [base, ...[bare, base].flatMap((b) => [".ts", ".tsx", ".js", ".jsx", ".mjs"].map((e) => b + e)), ...["ts", "tsx", "js", "jsx"].map((e) => join(base, `index.${e}`))];
  return candidates.find((c) => files.has(c)) ?? null;
}

/** Every module in the client graph, each with the import chain that put it there. */
function clientGraph(root: string, modules: Map<string, Module>): Map<string, string[]> {
  const fileSet = new Set(modules.keys());
  const graph = new Map<string, string[]>();
  const queue: string[] = [];
  for (const [f, m] of modules) {
    if (m.directive === "use client" || m.imports.includes("posthog-js")) {
      graph.set(f, [relative(root, f)]);
      queue.push(f);
    }
  }
  while (queue.length > 0) {
    const f = queue.shift()!;
    for (const spec of modules.get(f)!.imports) {
      const target = resolveModule(root, f, spec, fileSet);
      if (!target || graph.has(target) || modules.get(target)!.directive === "use server") continue;
      graph.set(target, [...graph.get(f)!, relative(root, target)]);
      queue.push(target);
    }
  }
  return graph;
}

// A key put together at run time — `lens-${name}`, "lens-" + name — names a
// server flag without spelling one. The stem that gives it away: what every
// server flag's key begins with, up to and including a dash.
function keyStems(keys: string[]): string[] {
  return [...new Set(keys.flatMap((k) => [...k.matchAll(/-/g)].map((d) => k.slice(0, d.index! + 1))))];
}

function browserOffenders(root: string): { offenders: string[]; graphSize: number } {
  const files = sourceFiles(join(root, "src"));
  const modules = new Map(files.map((f) => [f, readModule(f, readFileSync(f, "utf8"))]));
  const graph = clientGraph(root, modules);
  const keys = LENSES.map((l) => l.key);
  const names = LENSES.map((l) => l.constant);
  const stems = keyStems(keys);
  const serverModules = [join("src", "lib", "feature-flags.ts"), join("src", "lib", "viewer-flags.ts")];
  const offenders: string[] = [];
  for (const [path, chain] of graph) {
    const rel = relative(root, path);
    const where = chain.join(" → ");
    if (serverModules.includes(rel)) {
      offenders.push(`browser code reaches ${rel}: ${where}`);
      continue;
    }
    const m = modules.get(path)!;
    for (const k of keys) if (m.strings.some((s) => s.includes(k))) offenders.push(`${where} mentions ${k}`);
    for (const n of names) if (m.identifiers.has(n)) offenders.push(`${where} mentions ${n}`);
    for (const s of m.stems) if (stems.some((stem) => s.endsWith(stem))) offenders.push(`${where} builds a flag key at run time from "${s}"`);
    for (const spec of m.opaqueImports) offenders.push(`${where} imports a module chosen at run time (${spec}), which cannot be followed`);
  }
  for (const [path, m] of modules) {
    const rel = relative(root, path);
    if (graph.has(path) || rel === serverModules[0]) continue;
    for (const k of keys) if (m.strings.includes(k)) offenders.push(`${rel} spells out "${k}" instead of importing its constant`);
  }
  return { offenders, graphSize: graph.size };
}

function browserChecks(): void {
  const { offenders, graphSize } = browserOffenders(process.cwd());
  check(`client graph found to inspect (${graphSize} modules)`, graphSize > 0);
  check("no browser code reaches a server flag module, mentions a server flag or builds its key", offenders.length === 0, offenders.join("; "));
}

// The walk itself, on a small tree written for the purpose: a client
// component → a plain helper without the directive → viewer-flags must be
// caught; the same component calling a "use server" action that reads the
// flag must not; nor may a type-only import.
function clientGraphFixtureChecks(): void {
  const root = mkdtempSync(join(tmpdir(), "che-381-graph-"));
  const write = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  try {
    write("src/lib/feature-flags.ts", `export const LENS_PRODUCT_FLAG = "lens-product";\n`);
    write("src/lib/viewer-flags.ts", `import { LENS_PRODUCT_FLAG } from "./feature-flags";\nexport const productLensFor = async () => Boolean(LENS_PRODUCT_FLAG);\n`);
    write("src/app/actions.ts", `"use server";\nimport { productLensFor } from "@/lib/viewer-flags";\nexport async function save() { return productLensFor(); }\n`);
    write("src/lib/types.ts", `export type { FlagPerson } from "./feature-flags";\n`);
    write(
      "src/components/ok.tsx",
      [
        `"use client";`,
        `import { save } from "@/app/actions";`,
        `import type { FlagPerson } from "@/lib/feature-flags";`,
        // Types only, written inline: erased like the line above (it was a false alarm before CHE-386).
        `import { type FlagPerson as Person } from "@/lib/feature-flags";`,
        // Strings that look like comment marks, and a comment that names the flag: none of it is a read.
        `const glob = "/lenses/*"; const address = "https://example.test//a"; /* lens-product is evaluated by the page */`,
        `const cls = \`lens\${glob}-\${address}\`;`,
        `export const Ok = () => [save, cls] as [typeof save, string, Person?, FlagPerson?];`,
      ].join("\n"),
    );
    const clean = browserOffenders(root).offenders;
    check("client graph: a component calling a \"use server\" action that reads the flag, with type-only imports of the flag module, is fine", clean.length === 0, clean.join("; "));

    // Each way round the walk, alone: written, caught, removed, clean again.
    const bypasses: [string, string, string, RegExp][] = [
      ["client component → plain helper without the directive → viewer-flags", "src/components/sidebar.tsx", `"use client";\nimport { showProduct } from "@/lib/lens-helper";\nexport const Sidebar = () => showProduct;\n`, /reaches src\/lib\/viewer-flags\.ts/],
      ["a dynamic import written as a template literal", "src/components/lazy.tsx", `"use client";\nexport const load = () => import(\`@/lib/viewer-flags\`);\n`, /reaches src\/lib\/viewer-flags\.ts/],
      ["a path with a .js suffix", "src/components/suffix.tsx", `"use client";\nimport { productLensFor } from "../lib/viewer-flags.js";\nexport const S = productLensFor;\n`, /reaches src\/lib\/viewer-flags\.ts/],
      ["an import after a string holding \"/*\" (the old comment stripper ate it)", "src/components/star.tsx", `"use client";\nconst glob = "/lenses/*";\nimport { productLensFor } from "@/lib/viewer-flags";\nexport const S = [glob, productLensFor]; /* done */\n`, /reaches src\/lib\/viewer-flags\.ts/],
      ["an import on a line after a string holding \"//\"", "src/components/slashes.tsx", `"use client";\nconst a = "x//y"; import { productLensFor } from "@/lib/viewer-flags";\nexport const S = [a, productLensFor];\n`, /reaches src\/lib\/viewer-flags\.ts/],
      ["a require", "src/components/req.tsx", `"use client";\nexport const S = require("@/lib/viewer-flags");\n`, /reaches src\/lib\/viewer-flags\.ts/],
      ["a key built in a template literal", "src/components/built.tsx", `"use client";\nexport const key = (name: string) => \`lens-\${name}\`;\n`, /builds a flag key at run time from "lens-"/],
      ["a key built by concatenation", "src/components/concat.tsx", `"use client";\nexport const key = (name: string) => "home-extension-" + name;\n`, /builds a flag key at run time from "home-extension-"/],
      ["a module chosen at run time", "src/components/opaque.tsx", `"use client";\nexport const load = (name: string) => import(\`@/lib/\${name}\`);\n`, /imports a module chosen at run time/],
      ["a key spelled out in a string", "src/components/spelled.tsx", `"use client";\nexport const key = "lens-release";\n`, /mentions lens-release/],
      ["the constant's name", "src/components/named.tsx", `"use client";\nimport * as all from "@/lib/types";\nexport const key = (all as Record<string, unknown>).LENS_PRODUCT_FLAG;\n`, /mentions LENS_PRODUCT_FLAG/],
    ];
    write("src/lib/lens-helper.ts", `export { productLensFor as showProduct } from "../lib/viewer-flags";\n`);
    for (const [name, rel, text, expected] of bypasses) {
      write(rel, text);
      const found = browserOffenders(root).offenders;
      rmSync(join(root, rel));
      const after = browserOffenders(root).offenders;
      check(`client graph: ${name} is caught`, found.some((o) => expected.test(o)) && after.length === 0, found.join("; ") || "nothing caught");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── Live (optional) ────────────────────────────────────────────────────────

const POSTHOG_API = "https://us.posthog.com/api/projects/595090";
// One person per run (CHE-386): with a fixed id, two --live runs at once
// stored, read and deleted the same person under each other.
const SPOOFED_ID = `verify-che-381-spoofed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
    // Named for what it is (CHE-386): the body posthog-js sends — no overrides,
    // no runtime — from Node, so not a browser's headers. PostHog decides on
    // the body's `evaluation_runtime`, which is what is absent here.
    check("live: a request for that person that does not say it is a server gets no answer for any of them", res.ok && answered.length === 0, `HTTP ${res.status} ${JSON.stringify(answered)}`);
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
  await wholeSetupChecks();
  clientGraphFixtureChecks();
  browserChecks();
  if (process.argv.includes("--live")) await liveChecks(realFetch);
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  finished = true;
  process.exit(failures === 0 ? 0 : 1);
})();
