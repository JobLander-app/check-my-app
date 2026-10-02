// The boolean PostHog flags the app reads on the server, declared once
// (CHE-352, CHE-380, CHE-381). scripts/posthog-setup.ts makes PostHog match
// this list through reconcileFlag — it creates a missing flag, rewrites one
// that drifted in any way that changes its audience, and reads it back — and
// scripts/verify-lens-flags.ts checks the list and reconcileFlag offline and,
// with --live, checks PostHog against it. Changing who sees a flag is an edit here plus a setup
// run, never a hand edit in PostHog: the next setup run would undo it.
//
// No side effects and no environment, so the verify script can import it.

import {
  FLAG_PERSON_PROPERTIES,
  HOME_EXTENSION_CHECK_FLAG,
  LENS_MARKETING_FLAG,
  LENS_PRODUCT_FLAG,
  LENS_RELEASE_FLAG,
} from "@/lib/feature-flags";

export const OWNER_EMAILS = ["sorokinvj@gmail.com"];

export type FlagCondition = {
  properties: { key: (typeof FLAG_PERSON_PROPERTIES)[number]; type: "person"; operator: "exact"; value: string[] }[];
  rollout_percentage: number;
};

export type DeclaredFlag = { key: string; audience: "owner" | "nobody"; name: string; groups: FlagCondition[] };

// One release condition and nothing else — no rollout percentage, so no
// stranger lands in it by chance. `exact` on the e-mail the server sends as an
// override (src/lib/feature-flags.ts), never a stored property.
const OWNER_ONLY: FlagCondition[] = [
  { properties: [{ key: "email", type: "person", operator: "exact", value: OWNER_EMAILS }], rollout_percentage: 100 },
];

// Active, with one condition that releases to 0%: PostHog answers it, and the
// answer is off for everyone.
const NOBODY: FlagCondition[] = [{ properties: [], rollout_percentage: 0 }];

export const DECLARED_FLAGS: DeclaredFlag[] = [
  {
    key: HOME_EXTENSION_CHECK_FLAG,
    audience: "owner",
    // Owner, 2026-09-27: the Chrome-extension option is not for the public
    // yet. Its second condition, is_test_account, went with CHE-334 in code
    // and stayed in PostHog until CHE-380, because setup never updated a flag
    // that already existed.
    name: "Chrome-extension check on / and in onboarding (CHE-320). Off for the public and for test accounts (CHE-334); on for the owner. Evaluated server-side in src/lib/viewer-flags.ts.",
    groups: OWNER_ONLY,
  },
  {
    key: LENS_PRODUCT_FLAG,
    audience: "owner",
    name: "Product lens in the sidebar and its routes (CHE-352). On for the owner only; off for the public and for test accounts. Evaluated server-side by productLensFor() in src/lib/viewer-flags.ts.",
    groups: OWNER_ONLY,
  },
  {
    key: LENS_MARKETING_FLAG,
    audience: "nobody",
    name: "Marketing lens (CHE-352). Off for everyone, not rendered at all while off. Evaluated server-side by marketingLensFor() in src/lib/viewer-flags.ts.",
    groups: NOBODY,
  },
  {
    key: LENS_RELEASE_FLAG,
    audience: "owner",
    name: "Release lens (CHE-367). On for the owner only until it is proven, then public; off for test accounts. Evaluated server-side by releaseLensFor() in src/lib/viewer-flags.ts.",
    groups: OWNER_ONLY,
  },
];

/**
 * Who may evaluate these flags. "server" means PostHog answers them only to a
 * request that says it is a server (`evaluation_runtime` in the body, which
 * src/lib/feature-flags.ts sends) and leaves them out of what posthog-js
 * receives in the browser (CHE-381). Checked live on 2026-10-01: with a flag
 * at "server", a request without the field gets no answer for it at all, so a
 * browser read of a hidden flag is off instead of answered from properties the
 * browser stored itself. It is not a boundary — anyone can send the field —
 * which is why the override of every property stays.
 */
export const SERVER_RUNTIME = "server";

/**
 * The one body posthog:setup writes for a declared flag, on create and on
 * update. A PATCH changes only the fields it carries, so every writable field
 * flagState compares is spelled out at its declared value — a default left
 * implicit is a drift the update cannot undo. Checked live on 2026-10-01:
 * `bucketing_identifier` and `evaluation_contexts` drift and reset through a
 * PATCH like this one.
 */
export function flagWriteBody(declared: DeclaredFlag) {
  return {
    key: declared.key,
    name: declared.name,
    active: true,
    evaluation_runtime: SERVER_RUNTIME,
    ensure_experience_continuity: false,
    bucketing_identifier: "distinct_id",
    evaluation_contexts: [] as string[],
    filters: { groups: declared.groups },
  };
}

// Drop what carries no meaning — null, undefined, [], {} — so PostHog's
// defaults (`aggregation_group_type_index: null`, `payloads: {}`, …) compare
// equal to their absence, and everything else is kept.
function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = prune((value as Record<string, unknown>)[k]);
      const empty = v === null || v === undefined || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
      if (!empty) out[k] = v;
    }
    return out;
  }
  return value;
}

/**
 * Everything on a PostHog flag that can change who gets it, in a stable form:
 * the whole `filters` object (conditions, early-access `super_groups`,
 * `holdout_groups`, variants, payloads — CHE-381), plus the fields beside it
 * that decide or link an audience: active / deleted, the runtime, experience
 * continuity, bucketing, evaluation contexts, a holdout, early-access
 * features and experiments. Missing fields take PostHog's defaults, so a
 * declared body and the flag PostHog returns compare as strings.
 */
export function flagState(flag: Record<string, unknown>): string {
  const ids = (list: unknown) => (Array.isArray(list) ? list.map((x) => (x && typeof x === "object" ? (x as { id?: unknown }).id ?? x : x)) : []);
  return JSON.stringify(
    prune({
      active: flag.active ?? false,
      deleted: flag.deleted ?? false,
      evaluation_runtime: flag.evaluation_runtime ?? "all",
      ensure_experience_continuity: flag.ensure_experience_continuity ?? false,
      bucketing_identifier: flag.bucketing_identifier ?? "distinct_id",
      evaluation_contexts: flag.evaluation_contexts ?? [],
      holdout: flag.holdout ?? null,
      early_access_features: ids(flag.features),
      experiments: ids(flag.experiment_set),
      filters: flag.filters ?? {},
    }),
  );
}

/** What a declared flag looks like once PostHog holds exactly it. */
export function declaredState(declared: DeclaredFlag): string {
  return flagState(flagWriteBody(declared));
}

/**
 * What posthog:setup does with one declared flag, given what PostHog holds
 * under its key: create it, keep it, or rewrite it. Anything whose state is
 * not exactly the declared one is rewritten — a flag that exists is not a
 * flag that is right (CHE-380), and conditions are not all of a flag (CHE-381).
 */
export function flagPlan(declared: DeclaredFlag, found: Record<string, unknown> | undefined): "create" | "keep" | "update" {
  if (!found) return "create";
  return flagState(found) === declaredState(declared) ? "keep" : "update";
}

export type PostHogApi = (method: "GET" | "POST" | "PATCH", path: string, body?: unknown) => Promise<unknown>;
type StoredFlag = Record<string, unknown> & { id: number; key: string };

/**
 * Make PostHog hold exactly the declared flag, and prove it by reading it
 * back. Refuses to write an unsafe condition; throws when PostHog keeps
 * something a write cannot clear (an early-access link, an experiment, a
 * holdout), because that is for a person to undo, not for setup to ignore.
 * The API is passed in so scripts/verify-lens-flags.ts runs this exact code
 * against a fake PostHog and checks what it writes.
 */
export async function reconcileFlag(api: PostHogApi, declared: DeclaredFlag, log: (line: string) => void = console.log): Promise<StoredFlag> {
  const body = flagWriteBody(declared);
  const unsafe = unsafeCondition(body.filters.groups);
  if (unsafe) throw new Error(`refusing to write ${declared.key}: ${unsafe}`);
  const listed = (await api("GET", `/feature_flags/?search=${declared.key}&limit=50`)) as { results: StoredFlag[] };
  // The listing finds the id; the flag itself is read in full, so the plan
  // never rests on fields a listing might leave out.
  const match = listed.results.find((f) => f.key === declared.key);
  const found = match ? ((await api("GET", `/feature_flags/${match.id}/`)) as StoredFlag) : undefined;
  const plan = flagPlan(declared, found);
  let written: StoredFlag;
  if (plan === "keep" && found) {
    log(`flag        exists  id=${found.id} key=${found.key} state=${flagState(found)}`);
    written = found;
  } else if (plan === "create") {
    written = (await api("POST", "/feature_flags/", body)) as StoredFlag;
    log(`flag        created id=${written.id} key=${written.key}`);
  } else {
    written = (await api("PATCH", `/feature_flags/${found?.id}/`, body)) as StoredFlag;
    log(`flag        updated id=${written.id} key=${written.key}`);
    log(`              was ${found ? flagState(found) : "?"}`);
  }
  const stored = (await api("GET", `/feature_flags/${written.id}/`)) as StoredFlag;
  if (flagState(stored) !== declaredState(declared)) {
    throw new Error(`${declared.key} (id ${written.id}) is not as declared after setup:\n  holds    ${flagState(stored)}\n  declared ${declaredState(declared)}`);
  }
  if (plan !== "keep") log(`              now ${flagState(stored)}`);
  return stored;
}

/**
 * Why a set of conditions could be decided by something other than what the
 * server sends, or null when it cannot. A condition on any other property, a
 * cohort, or an operator other than `exact` lets stored or partial values in.
 */
export function unsafeCondition(groups: unknown): string | null {
  const allowed: readonly string[] = FLAG_PERSON_PROPERTIES;
  for (const g of Array.isArray(groups) ? groups : []) {
    for (const p of (g as { properties?: Record<string, unknown>[] }).properties ?? []) {
      if (p.type !== "person") return `condition of type ${String(p.type)} on ${String(p.key)}`;
      if (!allowed.includes(String(p.key))) return `condition on ${String(p.key)}, which the server does not send`;
      if (p.operator !== "exact") return `operator ${String(p.operator)} on ${String(p.key)}`;
    }
  }
  return null;
}
