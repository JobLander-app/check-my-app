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
// So the identity is built from machine facts first and the page second, and
// title, severity, journey and step stay out of it:
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
// Known cost of "page": two different problems of one category on one page are
// one signature. On prod (407 findings, 2026-10-01) a signature is shared by
// two findings of the same check 20 times, 18 of them in checks from before
// findings carried an anchor (CHE-215, when a check reported up to a dozen
// findings, many on /login); the other 2 are the same problem written up twice
// in #242. Across checks, src/lib/recurring.ts bounds the merge: a problem that
// was gone and is seen again starts a new streak. Signatures are compared
// within one app only.
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

export function signatureKind(signature: string): SignatureKind {
  return signature.slice(0, signature.indexOf(":")) as SignatureKind;
}

// The `where` of the one finding that is about US: test records our own check
// left in the customer's app (src/agent/cleanup.ts). It reaches the verdict so
// they can delete them by hand, but its recurring is our lifecycle bug, not
// their product's (CLAUDE.md §2), so it gets a kind of its own and
// src/lib/recurring.ts leaves it out of the customer's count.
export const OUR_LEFTOVERS_WHERE = "Records created during this check";

export function findingSignature(f: SignatureFinding): string {
  const errorSignature = parseJson<{ errorSignature?: string }>(f.anchor ?? null)?.errorSignature;
  if (f.appSlug.startsWith("extension:") && typeof errorSignature === "string" && /^[a-f0-9]{64}$/.test(errorSignature)) {
    return `ext:${dedupKey({ journeyTitle: f.appSlug, stepLabel: errorSignature, failureSignature: "extension-alert" })}`;
  }
  const detail = parseJson<FindingDetail>(f.detail) ?? {};
  if (detail.where === OUR_LEFTOVERS_WHERE) {
    return `ours:${dedupKey({ journeyTitle: f.appSlug, stepLabel: OUR_LEFTOVERS_WHERE, failureSignature: "leftovers" })}`;
  }
  const request = requestSignature([detail.where, f.title, detail.whatHappened]);
  if (request) {
    return `req:${dedupKey({ journeyTitle: f.appSlug, stepLabel: request, failureSignature: "request" })}`;
  }
  const page = pageOf(detail.where);
  if (page) {
    return `page:${dedupKey({ journeyTitle: f.appSlug, stepLabel: page, failureSignature: `page/${f.category}` })}`;
  }
  return `text:${dedupKey({
    journeyTitle: f.appSlug,
    stepLabel: `${detail.where ?? ""} | ${f.title}`,
    failureSignature: `text/${f.category}`,
  })}`;
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
