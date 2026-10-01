// CHE-215: which columns of a Finding a customer may receive.
//
// The verdict page read findings with a blanket `include` and handed the whole
// array to FindingsList, a client component. Next serializes every prop across
// that boundary whether or not the component renders it, so each Finding column
// lands in the page's RSC payload and is readable in view-source. Nothing was
// wrong with that until CHE-215 added `anchor` — our record of what a finding
// was allowed to rest on, with the step it named, the hands it claimed and
// whether the run had a machine trail. That is our kitchen, and CLAUDE.md rule
// 1 keeps the kitchen out of what a customer reads.
//
// A `select` on that one query would fix today and rot tomorrow: the next
// column added to Finding would leak exactly the same way, and the next reader
// would have no reason to think about it. So the projection lives here, every
// column is classified, and scripts/verify-viewer-capabilities.ts asserts the
// two lists together cover Prisma's own FindingScalarFieldEnum — a new column
// fails that check until somebody decides which side it belongs on.

import type { Finding } from "@/generated/prisma/client";

/** Columns the customer's own verdict is made of. */
export const FINDING_PUBLIC_FIELDS = [
  "id",
  "runId",
  "number",
  "title",
  "category",
  "severity",
  "detail",
  "mark",
  "createdAt",
] as const;

/** Columns that are ours: never rendered, never serialized, never emailed. */
// CHE-354: `signature` is our identity for a problem across checks
// (src/lib/finding-signature.ts) — its kind prefix says how we keyed it.
export const FINDING_INTERNAL_FIELDS = ["anchor", "signature"] as const;

export type FindingPublicField = (typeof FINDING_PUBLIC_FIELDS)[number];

// What a client component may be handed. Naming it here means the compiler
// refuses a whole Finding at that boundary, so the `select` above cannot be
// quietly widened back to an `include` without the type failing too.
export type PublicFinding = Pick<Finding, FindingPublicField>;

/** Prisma `select` for anything that crosses to a browser. */
export const FINDING_PUBLIC_SELECT: Record<FindingPublicField, true> = Object.fromEntries(
  FINDING_PUBLIC_FIELDS.map((f) => [f, true]),
) as Record<FindingPublicField, true>;
