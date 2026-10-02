// One problem, one identity, however the finding about it is worded (CHE-354).
//
// meetbashar.com reported one dead YouTube video on its Holotope guide in seven
// checks in a row (#241 … #267). Seven titles ("Holotope guide links twice to a
// removed YouTube video", "Dead YouTube source link (404) cited twice on the
// Holotope guide", …), severity flipping between high and medium. The ticket
// key (dedupKeyForFinding, src/lib/tracker/file.ts) hashes the title and the
// severity whenever no request is named, so those were seven problems, and "how
// many problems keep coming back" could not be counted.
//
// What stayed put across the seven, read from prod D1 on 2026-10-01:
//   - detail.where began with the page, /learn/holotope-meditation, 7 of 7;
//   - category was "broken", 7 of 7;
//   - the AppJourney the stepRef named was the same, 7 of 7 — but across the
//     whole table the journey is NOT a property of the problem: the one dead
//     "Check your app →" link on checkmyapp.dev/checks/today was reported under
//     five different journeys (#227 … #257), because a stepRef names whichever
//     walk happened to trip over it;
//   - the step did not: index 1, 4, 4, 3, 3, 3, 3 and the labels were reworded;
//   - the dead video id did not either: #246 wrote 4EjTHkgOgO8 for 4EjTHkgOgG8.
// So the stored signature is built from machine facts first and the page
// second; title, severity, journey and step stay out of it:
//
//   ours: test records our own check left behind (OUR_LEFTOVERS_WHERE below);
//   ext:  an extension's error signature (the extension-alert ticket key);
//   req:  "METHOD /path status" named anywhere in the finding (CHE-59);
//   page: the normalised page path at the head of detail.where + category;
//   text: neither exists. We then have no stable fact to key on, and say so:
//         the wording is part of the key, so a reworded finding of this kind is
//         a new one. Two different problems merged into one "recurring" claim
//         would be a claim about the customer's product resting on our own
//         bookkeeping (CLAUDE.md §8); a missed recurrence costs nothing.
//
// "page" and "req" are too coarse to be a problem's identity: different
// problems of one category on one page share a page signature (/login on
// joblander.app holds a dozen), and one failing request is cited by findings
// about different things. They are buckets. Inside a bucket,
// src/lib/recurring.ts tells problems apart by how much their titles say the
// same thing (sameProblem below) — measured on prod, see SAME_PROBLEM.
//
// The string carries a version (`page:v1:…`): a stored signature written by
// one version of these rules is never silently compared with another's.
//
// Pure and free of Next / server-only imports: the agent worker writes it with
// every finding (src/agent/workflow.ts persistFindings), and the backfill
// (scripts/backfill-finding-signature.ts) and src/lib/recurring.ts recompute it
// for rows that predate the column.

import { dedupKey, normalizePath, requestSignature } from "@/lib/dedup";
import { parseJson } from "@/lib/json";
import type { FindingDetail } from "@/lib/types";

export interface SignatureFinding {
  appSlug: string;
  title: string;
  category: string;
  detail: string | null;
  anchor?: string | null;
}

export type SignatureKind = "ours" | "ext" | "req" | "page" | "text";

export const SIGNATURE_VERSION = "v1";

export function signatureKind(signature: string): SignatureKind {
  return signature.slice(0, signature.indexOf(":")) as SignatureKind;
}

// The `where` of the one finding that is about US: test records our own check
// left in the customer's app (src/agent/cleanup.ts). It reaches the verdict so
// they can delete them by hand, but its recurring is our lifecycle bug, not
// their product's (CLAUDE.md §2), so it gets a kind of its own and
// src/lib/recurring.ts leaves it out of the customer's count.
export const OUR_LEFTOVERS_WHERE = "Records created during this check";

const signed = (kind: SignatureKind, parts: Parameters<typeof dedupKey>[0]) => `${kind}:${SIGNATURE_VERSION}:${dedupKey(parts)}`;

export function findingSignature(f: SignatureFinding): string {
  const errorSignature = parseJson<{ errorSignature?: string }>(f.anchor ?? null)?.errorSignature;
  if (f.appSlug.startsWith("extension:") && typeof errorSignature === "string" && /^[a-f0-9]{64}$/.test(errorSignature)) {
    return signed("ext", { journeyTitle: f.appSlug, stepLabel: errorSignature, failureSignature: "extension-alert" });
  }
  const detail = parseJson<FindingDetail>(f.detail) ?? {};
  if (detail.where === OUR_LEFTOVERS_WHERE) {
    return signed("ours", { journeyTitle: f.appSlug, stepLabel: OUR_LEFTOVERS_WHERE, failureSignature: "leftovers" });
  }
  const request = requestSignature([detail.where, f.title, detail.whatHappened]);
  if (request) {
    return signed("req", { journeyTitle: f.appSlug, stepLabel: request, failureSignature: "request" });
  }
  const page = pageOf(detail.where);
  if (page) {
    return signed("page", { journeyTitle: f.appSlug, stepLabel: page, failureSignature: `page/${f.category}` });
  }
  return signed("text", { journeyTitle: f.appSlug, stepLabel: `${detail.where ?? ""} | ${f.title}`, failureSignature: `text/${f.category}` });
}

// The page a finding happened on, from the head of detail.where: the first
// path-shaped token ("/learn/holotope-meditation — …", "Settings → General
// (/en/settings/general)", "https://app.example.com/pricing"). Reduced the way
// requestSignature reduces a path, and further: a trailing slash dropped, and
// a long opaque segment (a cuid in /verdict/<id>) collapsed like a numeric one.
// Those two are safe here and not in normalizePath, which open tickets are
// keyed on. A lone "/" counts only when written as the whole place or "(/)":
// in prose a slash is usually "sign in / sign up".
export function pageOf(where: string | undefined): string | null {
  if (!where) return null;
  const trimmed = where.trim();
  if (trimmed === "/" || /\(\/\)/.test(trimmed)) return "/";
  const m = trimmed.match(/(?:^|[\s("'“‘`])((?:https?:\/\/[^\s/"'”’]+)?\/[A-Za-z0-9_\-.%[\]:][A-Za-z0-9_\-.%/[\]:]*)/);
  if (!m) return null;
  let path = normalizePath(m[1]);
  path = path.replace(/\/[a-z0-9]{20,}(?=\/|$)/g, (seg) => (/\d/.test(seg) ? "/:id" : seg));
  path = path.replace(/\/+$/, "");
  return path || "/";
}

// ─── Same problem, inside one bucket ──────────────────────────────────────────
//
// Two findings in one bucket ("page" or "req", see src/lib/recurring.ts) are
// the same problem when their titles share at least SAME_PROBLEM of their
// content words (Jaccard; stop words and our own coverage boilerplate — "could
// not be confirmed this run" — dropped, a crude stem so "cites"/"cited" meet).
// Title only: whatHappened adds shared boilerplate that pulled different
// problems together.
//
// Measured on prod history, 2026-10-01 (407 findings of 284 checks, 19 apps;
// each finding compared with the LATEST member of a candidate group, the way a
// streak continues; scripts/measure/recurring-dump.ts prints every group):
//   0.25  the seven Holotope findings are one group, but different problems
//         merge too: "'Sign in' stays stuck in Loading" with "Successful login
//         doesn't forward to the intended destination"; "Google OAuth
//         initiates correctly" with "Google OAuth completion: could not be
//         confirmed";
//   0.30  Holotope one group; the 11 mixed pairs the cross-review listed are
//         all apart; of the 27 groups seen in two or more checks, read one by
//         one, none holds two problems;
//   0.35  the Holotope seven split in two.
// 0.30 is the highest value that keeps the Holotope seven together. The margin
// above it is thin, and that is stated rather than hidden.
//
// The cost is on the safe side: a problem whose wording drifts further than
// this is counted as two — joblander.app's sign-in button stuck in "Loading"
// is one problem in #265, #274, #278 and #284 and is grouped only as #278 +
// #284. A missed recurrence costs nothing; a merge of two problems is a claim
// about the customer's product resting on our bookkeeping (CLAUDE.md §8).
// Keeping the category in the page bucket is the same trade: without it three
// more mixes appear ("'Send reset link' does nothing" with "'Send reset link'
// button: could not be confirmed"), and a finding whose category flips
// between checks starts a new group.
export const SAME_PROBLEM = 0.3;

const STOP = new Set(
  (
    "the a an and or of to in on for with is are was were be been it its this that from by as at our your their you we not no " +
    "but into than then there here when while after before over under only also any all one two three can could may might " +
    "will would should does did done has have had more most some same both each other such very just " +
    // our coverage boilerplate, never the problem itself
    "confirm confirmed run verified verify unverified test page"
  ).split(" "),
);
const stem = (w: string) => w.replace(/ies$/, "y").replace(/(ing|ed|es|s)$/, "");

export function titleWords(title: string): Set<string> {
  return new Set(
    (title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map(stem)
      .filter((w) => !STOP.has(w)),
  );
}

export function titleSimilarity(a: string, b: string): number {
  const x = titleWords(a);
  const y = titleWords(b);
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  const union = x.size + y.size - shared;
  return union === 0 ? 0 : shared / union;
}

export function sameProblem(a: { title: string }, b: { title: string }): boolean {
  return titleSimilarity(a.title, b.title) >= SAME_PROBLEM;
}
