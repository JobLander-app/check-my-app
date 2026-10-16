// The funnel comes from the journey we walked (CHE-238).
//
// Asking a founder to define a funnel for us is homework, and homework is a
// hard failure of rule 1. We already have what a funnel is made of: the walk
// recorded every page it moved through, in order (`Step.actions`, CHE-129).
//
// Everything downstream of this file is a claim about the customer's product —
// "of 100 people who start this, 12 finish" — so the derivation is pure, and
// the cases where it REFUSES matter more than the cases where it succeeds. A
// funnel we derive badly does not look wrong on the screen. It looks like the
// customer's product converting badly, which is rule 8's failure exactly: our
// incapacity sold as their defect.
//
// Written against three real walks of joblander.app, read out of production on
// 2026-09-16, because a derivation invented at a desk would have got two of
// them wrong:
//
//   A "Try the AI interview coach demo"
//       / → /practice → /login?back=%2Fpractice
//     Three clean stages once the query string goes. This is a funnel, and a
//     good one: landing, the thing, the login wall.
//
//   B "Tutorial onboarding for new users"
//       / → /login → /dashboard → /first-time → /tutorials
//         → /tutorials/101-getting-live-insights → /tutorials/mirror-mode
//         → /tutorials/102-… → /tutorials/my-stories → /tutorials/103-…
//         → /tutorials/104-…
//     Eleven paths, of which six are SIBLING tutorial pages. Measured as
//     eleven ordered stages, virtually no real user completes it — they read
//     one tutorial, not all six in our order. We would have reported the
//     customer's onboarding as catastrophically broken, on the strength of our
//     own browsing. So consecutive siblings under a parent we already visited
//     collapse into that parent: reading six tutorials is one stage, "reached
//     the tutorials", which is the thing a real user either does or doesn't.
//
//   C "Explore the app in different languages (i18n)"
//       / → /de → /de/about → /de/login → /es → /es/about → /es/tutorials
//         → /es/terms → /es/login
//     With locale prefixes normalised this REVISITS /about and /login. A walk
//     that doubles back is not a user's path through a product; it is us
//     looking around. Kept as a funnel it would measure nothing real.
//
// So: a journey that cannot produce a funnel is OUR gap, filed like any other
// capability gap (rule 2), never a caveat pushed at the customer.

import { normalizePath } from "./dedup";

/**
 * Past this many stages it is not a funnel, it is an itinerary. Real
 * conversion funnels are short; a long one measures our wandering, and every
 * extra stage multiplies the drop-off we would wrongly attribute to the
 * customer. Eight is generous — walk B above lands on five once its siblings
 * collapse.
 */
export const MAX_FUNNEL_STAGES = 8;

/** Below this there is no conversion to measure, only arrival. */
export const MIN_FUNNEL_STAGES = 2;

export interface RecordedOutcome {
  outcome?: { urlAfter?: string | null } | null;
}

export type FunnelRefusal =
  /** One page. Measured as "reached the page", not as a conversion. */
  | "single_stage"
  /** The walk doubled back: not a path a person takes through a product. */
  | "revisits"
  /** Too many stages to be a funnel rather than an itinerary. */
  | "wandering"
  /** The walk recorded no pages at all. */
  | "no_pages";

export type DerivedFunnel =
  | { ok: true; stages: string[] }
  | { ok: false; refusal: FunnelRefusal; stages: string[] };

/** Everything before the last segment. "/a/b/c" → "/a/b"; "/a" → "/". */
function parentOf(path: string): string {
  const at = path.lastIndexOf("/");
  if (at <= 0) return "/";
  return path.slice(0, at);
}

/** Trailing slash removed, "/" preserved. Done here rather than in dedup.ts,
 *  whose output is keyed on by every open ticket. */
function trimmed(path: string): string {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return p || "/";
}

/**
 * Collapse path segments that belong to ONE VISIT rather than to a page.
 *
 * `normalizePath` already collapses bare numeric and hex segments, which is
 * enough for a failure signature. It is not enough for a funnel, and running
 * the derivation over every trail in production is what showed it — two real
 * funnels came out as:
 *
 *   / → /login → /dashboard → /practice/coaching_1788470882972 → /settings
 *   / → /onboarding → /dashboard → /dashboard/cmtmsvbyx0001rz1tkzevj5dc
 *
 * A session id and a cuid. Stored, each would drift on the next run — and
 * worse, "how many people reached /practice/coaching_1788470882972" measures a
 * single session of a single walk, which is a number about us wearing the
 * clothes of a number about the customer.
 *
 * Kept narrow on purpose. Every rule here erases a distinction, and erasing a
 * real one merges two pages into a stage that is neither.
 */
function collapseVolatile(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      // A cuid: 'c' then 24 lowercase alphanumerics. Our own ids, and common.
      if (/^c[a-z0-9]{24}$/.test(seg)) return ":id";
      // Any segment carrying a long digit run — epoch milliseconds, order
      // numbers, "coaching_1788470882972". Eight digits is past the point where
      // a number is part of a page's name (v2, 2024, 101-getting-started).
      if (/\d{8,}/.test(seg)) return ":id";
      return seg;
    })
    .join("/");
}

/** The pages a walk moved through, in order, before any funnel reasoning. */
export function pagesWalked(actions: readonly RecordedOutcome[]): string[] {
  return actions
    .map((a) => a?.outcome?.urlAfter)
    .filter((u): u is string => typeof u === "string" && u.length > 0)
    .map((u) => collapseVolatile(trimmed(normalizePath(u))))
    .filter((p) => p.startsWith("/"));
}

/**
 * A path from somewhere else, said in the vocabulary the stored stages use.
 *
 * The page survey records literal paths — `/dashboard/cmtmsvbyx0001rz1tkzevj5dc`
 * — while a stage that names the same page reads `/dashboard/:id`, because a
 * stage must survive the next run. Comparing the two as strings answers "no"
 * for every page whose address carries an id, which is most of the pages behind
 * a login. So the outside path is reduced the same way a walked one is, and the
 * two vocabularies meet (CHE-285).
 */
export function asStage(pathOrUrl: string): string {
  return collapseVolatile(trimmed(normalizePath(pathOrUrl)));
}

/**
 * Does this funnel name a page that changed?
 *
 * The question a metric alert needs answered: the number moved, and is the page
 * it was counted on still the page it was. Keyed on the journey's OWN stages,
 * which is what the app has, rather than on whatever this run happened to walk
 * — a journey the run skipped still runs on the pages it runs on.
 *
 * `changedPaths` arrives raw, as the survey recorded it.
 */
export function namesAChangedPage(
  stages: readonly string[],
  changedPaths: readonly string[],
): boolean {
  if (stages.length === 0 || changedPaths.length === 0) return false;
  const changed = new Set(changedPaths.map(asStage));
  return stages.some((s) => changed.has(asStage(s)));
}

/**
 * The funnel a walk implies, or the reason there is not one.
 *
 * `stages` is returned even on refusal, because the reason is only legible
 * next to what was actually walked — and because the gap ticket we file needs
 * to say what we saw.
 */
export function deriveFunnel(actions: readonly RecordedOutcome[]): DerivedFunnel {
  const walked = pagesWalked(actions);
  if (walked.length === 0) return { ok: false, refusal: "no_pages", stages: [] };

  // 1. The same page twice in a row is one visit — a fill and its click both
  //    record where they left you standing.
  const consecutive: string[] = [];
  for (const p of walked) {
    if (consecutive[consecutive.length - 1] !== p) consecutive.push(p);
  }

  // 2. Consecutive siblings under a parent we have already stood on are one
  //    stage: that parent. This is walk B — six tutorials read in a row is
  //    "reached the tutorials", not six things a user must do in our order.
  const collapsed: string[] = [];
  for (let i = 0; i < consecutive.length; i++) {
    const path = consecutive[i];
    const parent = parentOf(path);
    const siblingRun =
      parent !== "/" &&
      collapsed.includes(parent) &&
      // it and its neighbour share a parent — a run, not a single descent
      ((i + 1 < consecutive.length && parentOf(consecutive[i + 1]) === parent) ||
        (i > 0 && parentOf(consecutive[i - 1]) === parent));
    if (siblingRun) continue;
    if (collapsed[collapsed.length - 1] !== path) collapsed.push(path);
  }

  // 3. A walk that FINISHES by going back is not doubling back inside the path.
  //    "Check a website" ends on the verdict and then returns to the form;
  //    "Sign in" ends signed in and then returns to where it began. Run #204
  //    refused both as "revisits", and every run since has refused them again,
  //    so two of the app's own core journeys had no funnel for weeks. The way
  //    back is not a stage anybody converts through — the path ended before it.
  //    Only the tail is dropped, and only pages the walk had already stood on:
  //    a new page at the end is still part of the path.
  const stages = [...collapsed];
  const standingOn = new Set<string>();
  let firstRepeat = stages.length;
  for (let i = 0; i < stages.length; i++) {
    if (standingOn.has(stages[i])) {
      firstRepeat = i;
      break;
    }
    standingOn.add(stages[i]);
  }
  // Everything from the first repeat onward must itself be pages already seen,
  // or the doubling back is in the middle of the walk and not at its end — and
  // it must visit each of them once. A tail that keeps oscillating among known
  // pages (a b c a b a c) is not a way back, it is more wandering, and letting
  // it through would let any length of looking around evade both the revisit
  // refusal and the stage cap. One pass back over what was seen is a return.
  const tail = stages.slice(firstRepeat);
  const onlyWayBack =
    tail.every((p) => standingOn.has(p)) && new Set(tail).size === tail.length;
  const path = onlyWayBack ? stages.slice(0, firstRepeat) : stages;

  // 4. A walk that returns to a page it has already left, and then goes on to
  //    somewhere new, is us looking around, not a person moving through a
  //    product. Walk C.
  const seen = new Set<string>();
  for (const p of path) {
    if (seen.has(p)) return { ok: false, refusal: "revisits", stages: collapsed };
    seen.add(p);
  }

  if (path.length < MIN_FUNNEL_STAGES) {
    return { ok: false, refusal: "single_stage", stages: path };
  }
  if (path.length > MAX_FUNNEL_STAGES) {
    return { ok: false, refusal: "wandering", stages: path };
  }
  return { ok: true, stages: path };
}

/**
 * Why we could not measure a conversion for this journey, in our own words.
 *
 * Phrased for OUR board, never for the customer: each of these is a thing
 * CheckMyApp cannot yet do, not a thing the customer must fix (rule 2).
 */
export function refusalReason(refusal: FunnelRefusal): string {
  switch (refusal) {
    case "no_pages":
      return "the walk recorded no pages, so there is nothing to measure a conversion along";
    case "single_stage":
      return "the journey stayed on one page, so there is arrival to measure but no conversion";
    case "revisits":
      return "the walk doubled back to a page it had already left, so the path is ours rather than a user's";
    case "wandering":
      return "the walk covered too many pages to be a conversion path rather than an itinerary";
  }
}

/** Is `inner` contained in `outer` in order, extra stages allowed between? */
function isSubsequence(inner: readonly string[], outer: readonly string[]): boolean {
  let i = 0;
  for (const stage of outer) {
    if (i < inner.length && inner[i] === stage) i++;
  }
  return i === inner.length;
}

/**
 * Has the funnel's shape really changed?
 *
 * A funnel that changes silently between runs makes every comparison
 * meaningless — yesterday's 12% and today's 40% would be measuring different
 * questions while looking like a trend. So the stored funnel wins and drift is
 * reported rather than applied. Changing it is a decision, not a side effect.
 *
 * But "different" is not the same as "changed shape", and two consecutive runs
 * in production showed exactly why. The same journey walked:
 *
 *     run #204   /checks/today → /verdict/:id
 *     run #205   /check → /checks/today → /verdict/:id
 *
 * The walk entered from the landing page the second time. Nothing about the
 * conversion path changed; one extra earlier stage was seen. Reporting that as
 * drift would make this flag fire on ordinary entry-point variance — and a
 * flag that fires on everything stops meaning anything, which is how the real
 * shape change, when it comes, goes unnoticed.
 *
 * So drift means **incompatible**: neither funnel is a subsequence of the
 * other. A longer walk that still passes through the stored stages in order is
 * the same funnel seen from further back; a shorter one skipped a stage. A
 * REORDERED path is a genuinely different funnel, and is reported.
 */
export function funnelDrifted(stored: readonly string[], derived: readonly string[]): boolean {
  if (stored.length === derived.length && stored.every((s, i) => s === derived[i])) return false;
  return !isSubsequence(stored, derived) && !isSubsequence(derived, stored);
}
