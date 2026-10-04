// One IssueLink row per (app, regression signature). Deliberately NOT keyed by
// run: the same broken checkout seen on ten daily watch runs must land on one
// ticket that counts to ten, which is the whole point of comment-and-count and
// the escalation threshold. Built from the same three fields the ticket draft
// describes the regression with, via the CHE-32 hash.
//
// In a module of its own so recurrence (src/lib/recurring.ts, which points
// pre-CHE-103 tickets at their finding by this key) and the filing module
// (src/lib/tracker/file.ts, which reads recurrence for a ticket's priority)
// can each import it without importing each other.

import { dedupKey, requestSignature } from "@/lib/dedup";
import { parseJson } from "@/lib/json";
import type { FindingDetail } from "@/lib/types";

// Param is the minimal subset the key actually hashes, so reconcile (CHE-61)
// can re-key findings it loads without the evidence join.
export function dedupKeyForFinding(
  finding: { title: string; category: string; severity: string; detail: string | null; anchor?: string | null },
  run: { appSlug: string },
): string {
  const errorSignature = parseJson<{ errorSignature?: string }>(finding.anchor)?.errorSignature;
  if (run.appSlug.startsWith("extension:") && typeof errorSignature === "string" && /^[a-f0-9]{64}$/.test(errorSignature)) {
    return dedupKey({ journeyTitle: run.appSlug, stepLabel: errorSignature, failureSignature: "extension-alert" });
  }
  const detail = parseJson<FindingDetail>(finding.detail) ?? {};
  // CHE-59: machine facts first. A finding that names a failing request keys on
  // (app, METHOD path status) — category/severity/prose all drift run-to-run,
  // the broken endpoint doesn't. Prose key stays as the fallback for pure-UX
  // findings with no request to point at.
  const sig = requestSignature([detail.where, finding.title, detail.whatHappened]);
  if (sig) {
    return dedupKey({ journeyTitle: run.appSlug, stepLabel: sig, failureSignature: "request" });
  }
  return dedupKey({
    journeyTitle: detail.where ?? run.appSlug,
    stepLabel: finding.title,
    failureSignature: `${finding.category}/${finding.severity}`,
  });
}
