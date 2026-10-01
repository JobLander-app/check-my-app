// The boolean PostHog flags the app reads on the server, declared once
// (CHE-352, CHE-380). scripts/posthog-setup.ts makes PostHog match this list —
// it creates a missing flag and rewrites one whose conditions drifted — and
// scripts/verify-lens-flags.ts checks the list offline and, with --live, checks
// PostHog against it. Changing who sees a flag is an edit here plus a setup
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
 * A flag's conditions reduced to what decides who gets it, in a stable form,
 * so a declared flag and the one PostHog returns compare as strings. PostHog
 * adds fields of its own (`aggregation_group_type_index`, `variant`, …); they
 * are dropped here, and anything that changes the audience is kept.
 */
export function conditionsSignature(groups: unknown): string {
  const list = Array.isArray(groups) ? groups : [];
  return JSON.stringify(
    list.map((g: { properties?: unknown[]; rollout_percentage?: unknown }) => ({
      properties: (g.properties ?? []).map((p) => {
        const { key, type, operator, value } = p as Record<string, unknown>;
        return { key, type, operator, value };
      }),
      rollout_percentage: g.rollout_percentage ?? null,
    })),
  );
}

/**
 * What posthog:setup does with one declared flag, given what PostHog holds
 * under its key: create it, keep it, or rewrite it. Anything that is not
 * active with exactly the declared conditions is rewritten — a flag that
 * exists is not a flag that is right (CHE-380).
 */
export function flagPlan(
  declared: DeclaredFlag,
  found: { active: boolean; filters: { groups?: unknown } } | undefined,
): "create" | "keep" | "update" {
  if (!found) return "create";
  return found.active && conditionsSignature(found.filters.groups) === conditionsSignature(declared.groups) ? "keep" : "update";
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
