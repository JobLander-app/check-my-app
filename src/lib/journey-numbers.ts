// Our estimate and their measurement, side by side, never mistaken for each
// other (CHE-240).
//
// Two numbers about the same journey come from completely different places:
//
//   price, conversion (ours)  — a judgement we formed by walking it (CHE-235)
//   conversion (measured)     — a count from the customer's own analytics (CHE-239)
//
// A reader who cannot tell which is which will act on the wrong one. "45 of 100
// finish" is a thing we believe; "38% of 412 people over 14 days" is a thing
// that happened, and only the second is worth rearranging a roadmap for. So
// every line this file produces names its source, and no line can be produced
// without one — the label is not decoration applied at render time, it is part
// of the value.
//
// Rule 1 applies to every string here: these are read by the customer. Nothing
// about how we check, no browser, no request counts, and above all no homework
// — never "verify this yourself". src/lib/verdict-language.ts is the mechanism;
// scripts/verify-journey-numbers.ts holds these strings to it directly.

// The measurement's own floor, imported rather than restated: two constants
// for "enough people to state a percentage" is how a product comes to withhold
// a rate in one place and print it in another (CHE-292).
import { MIN_SAMPLE } from "./posthog/measure";

export type NumberSource = "ours" | "measured";

export interface OurJudgement {
  /** Actions a person performs to finish. Null when we did not price it. */
  price: number | null;
  /** Out of 100, our estimate of how many finish. Null when unpriced. */
  conversion: number | null;
}

/** One page we walked, and how many of their people reached it. */
export interface WalkedStage {
  stage: string;
  count: number;
}

/**
 * The pages of this journey that are the journey's own, and the one that is not.
 *
 * Our walk enters every journey through the app's front door, so that page is
 * stage one of almost every funnel and its count is the app's whole audience
 * (CHE-287). On joblander.app the entry drop is `/` 1,690 → `/signup` 13, which
 * says only that most visitors did not come to sign up. Reporting it as part of
 * the journey drowns the journey; dropping it leaves the pages the journey is
 * actually made of.
 *
 * `entry` is kept rather than discarded because "13 people reached your signup
 * form, out of 1,690 who came to the site" is a different and sometimes better
 * sentence than either half — but it is context, never the subject.
 */
export interface JourneyPages {
  own: WalkedStage[];
  entry: WalkedStage | null;
}

/**
 * A completion rate we are entitled to state, because the walk finished.
 *
 * The entitlement is the whole content of this type (CHE-283). A funnel derived
 * from a walk that never performed the journey's finishing action cannot contain
 * the completion page — no stage-picking rule recovers a page nobody reached —
 * and 8 of 16 journeys in production are in exactly that state, deliberately:
 * without test credentials we check read-only rather than create records in
 * someone's product.
 *
 * So this exists only where the walk's last step was not skipped, and `to` is
 * then genuinely where the journey ends rather than where we stopped.
 */
export interface TheirCompletion {
  /** 0-100, of the people who reached the journey's own first page. */
  conversion: number;
  /** People on that first page — the honesty of the number above. */
  sample: number;
  from: string;
  to: string;
  windowDays: number;
}

/**
 * The completion rate for a journey whose walk finished, or null.
 *
 * Null when there are fewer than two of the journey's own pages (one page is
 * arrival, not conversion), when nobody reached the first — a rate out of zero
 * is not a small rate, it is no rate — or when too few people did (CHE-292).
 *
 * The floor is the measurement's own, deliberately the same constant rather
 * than a second opinion about what "enough" means. CHE-287 settled the rule the
 * two sides of it follow: a COUNT is true at any size ("3 people reached this
 * page"), so the counts still render; a RATE is a statement about a population,
 * and one of three is not a population. The measurement already withholds its
 * percentage below this line and keeps the counts — recomputing the percentage
 * here from exactly those counts walked around its own floor, and turned three
 * sessions on checkmyapp.dev into "67% did not reach /verdict/:id" about a flow
 * nothing was wrong with.
 */
export function completionOf(p: JourneyPages, windowDays: number): TheirCompletion | null {
  const own = p.own;
  if (own.length < 2) return null;
  const first = own[0];
  const last = own[own.length - 1];
  if (first.count < MIN_SAMPLE) return null;
  return {
    conversion: Math.round((last.count / first.count) * 100),
    sample: first.count,
    from: first.stage,
    to: last.stage,
    windowDays,
  };
}

/**
 * The sentence that puts our judgement and their count together.
 *
 * Removed in CHE-279 and restored here under the condition that makes it valid:
 * it is reachable only from a `TheirCompletion`, which exists only when the walk
 * finished the journey. The version that was removed compared our estimate —
 * "of the people who set out to do this, how many finish" — against a count
 * whose denominator was everyone who arrived at the app, and on joblander.app
 * that produced "100% do not finish it" about a signup form our own walk had
 * just found clean.
 *
 * Null when there is nothing worth saying, which is most of the time: a page
 * that comments on every journey teaches people to skip the comments.
 */
export function comparisonLine(ours: OurJudgement, theirs: TheirCompletion): string | null {
  if (ours.conversion === null) return null;
  const gap = theirs.conversion - ours.conversion;

  // CHE-321: each sentence opens by saying what we expected, and that opening
  // has to be true of the estimate printed two lines above it. "We expected
  // this to be hard going" under "Likely to finish: 65 of 100", or "we expected
  // most people to get through" under 40 of 100, is the page contradicting
  // itself. Where the opening would be false, the page says nothing.
  const weExpectedMost = ours.conversion >= HEALTHY_CONVERSION;

  if (Math.abs(gap) < SHARP_DISAGREEMENT) {
    return theirs.conversion >= HEALTHY_CONVERSION || weExpectedMost
      ? null
      : `We expected this to be hard going, and your own numbers agree: ${theirs.conversion}% of the ` +
          `${theirs.sample.toLocaleString("en-US")} people who reached ${theirs.from} got to ${theirs.to}.`;
  }
  if (gap < 0) {
    if (!weExpectedMost) return null;
    return (
      `We expected most people to get through this. Of the ${theirs.sample.toLocaleString("en-US")} who ` +
      `reached ${theirs.from}, ${100 - theirs.conversion}% did not reach ${theirs.to}.`
    );
  }
  return (
    `This looked harder than it turns out to be — ${theirs.conversion}% of the ` +
    `${theirs.sample.toLocaleString("en-US")} people who reached ${theirs.from} got to ${theirs.to}.`
  );
}

/** Percentage points between our estimate and their count before it is news. */
export const SHARP_DISAGREEMENT = 20;
/** At or above this, a journey is doing fine and needs no commentary. */
export const HEALTHY_CONVERSION = 50;

// There is deliberately no type here for a conversion rate we did not earn.
//
// There was one, and a rate rendered from it. It is gone because we cannot say
// what the rate is OF: the funnel's first stage is where our walk entered the
// app and its last is wherever the walk stopped, so neither end is the
// journey's own (CHE-279, CHE-283). Naming both ends made the sentence true,
// but it never made it useful — "0% of the 1,690 people who reached / went on
// to /login" is a fact about site traffic wearing a journey's name.
//
// What replaced it is `JourneyPages` above: the pages, and how many people were
// on each. A count has no denominator to get wrong (CHE-287).

/** Why there is no measured number. Each is a different sentence, on purpose. */
export type NoMeasurement =
  /** The team has connected no analytics at all. */
  | "not_connected"
  /** Connected, and this journey has no funnel to measure along. */
  | "no_funnel"
  /** Connected and measurable, but nothing has counted it yet. */
  | "not_measured_yet"
  /** Connected, measured, and there were too few people to mean anything. */
  | "below_floor"
  /**
   * Connected, but the grant is narrower than a funnel query needs (CHE-286).
   *
   * Its own reason because it is the only one of these that is PERMANENT and
   * fixable by the owner. Folded into "not measured yet" — which is where it
   * used to land — it became a promise that a number was coming, when in fact
   * every query would be refused for ever.
   */
  | "access_narrowed";

export interface NumberLine {
  label: string;
  value: string;
  /** Named on every line. A number without its source is the whole defect. */
  source: string;
  sourceKind: NumberSource;
}

/**
 * Split the stages we counted into the journey's own pages and the entry page.
 *
 * The entry page is recognised by the app's own address, not by position: a
 * journey that genuinely starts somewhere else keeps all its stages, and a
 * journey whose every stage is the entry page keeps none — which is an honest
 * "we have nothing to say about this one" rather than a number.
 */
export function journeyPages(
  stages: readonly WalkedStage[],
  entryPath: string,
): JourneyPages {
  const entryAt = stages.findIndex((s) => s.stage === entryPath);
  if (entryAt !== 0) return { own: [...stages], entry: null };
  return { own: stages.slice(1), entry: stages[0] };
}

/**
 * What their analytics counted, said as pages rather than as a rate.
 *
 * A count needs no denominator and cannot be misread: "13 people reached
 * /signup" is true whatever this journey turns out to be. A rate between two
 * named pages is safe for the same reason — both ends are on the page, so the
 * reader is not left to supply "…of the journey" (CHE-279).
 *
 * What this deliberately never says is how many people *finished the journey*.
 * We do not know where the journey starts or ends (CHE-283); we know which
 * pages we walked and how many people were on them.
 */
export function pagesLine(p: JourneyPages, windowDays: number): NumberLine | null {
  const own = p.own;
  if (own.length === 0) return null;

  const window = `last ${windowDays} days`;
  const people = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "person" : "people"}`;
  // CHE-321: every count here is of people who got to this page having passed
  // the earlier ones in order — including the entry page, which is dropped from
  // the list but not from the count. Left unsaid, one verdict page printed
  // "0 people reached /verdict/:id" under one journey and "then 1 to
  // /verdict/:id" under the next (checkmyapp.dev, run #247), and "74 people
  // reached /login" beside "then 6 to /login" (joblander.app, run #254): the
  // same page, two numbers, each true of a different path. Naming where the
  // path starts makes each number say which one. The entry page's own crowd
  // stays out of it (CHE-287) — only its name is needed.
  const reached = (s: WalkedStage) =>
    `${people(s.count)} reached ${s.stage}${p.entry ? ` from ${p.entry.stage}` : ""}`;

  if (own.length === 1) {
    return {
      label: "Reached",
      value: `${reached(own[0])}, ${window}`,
      source: "your analytics",
      sourceKind: "measured",
    };
  }

  // Two or more of the journey's own pages: say where they went, in order, so
  // the step people leave on is visible rather than inferred from one rate.
  const first = own[0];
  const rest = own
    .slice(1)
    .map((s) => `${s.count.toLocaleString("en-US")} to ${s.stage}`)
    .join(", then ");
  return {
    label: "Reached",
    value: `${reached(first)}, then ${rest} — ${window}`,
    source: "your analytics",
    sourceKind: "measured",
  };
}

/** What we judged, in the customer's terms. Never called a measurement. */
export function ourLines(j: OurJudgement): NumberLine[] {
  const lines: NumberLine[] = [];
  if (j.price !== null) {
    lines.push({
      label: "Effort",
      value: `${j.price} ${j.price === 1 ? "action" : "actions"} to finish`,
      source: "our estimate",
      sourceKind: "ours",
    });
  }
  if (j.conversion !== null) {
    lines.push({
      label: "Likely to finish",
      value: `${j.conversion} of 100`,
      source: "our estimate",
      sourceKind: "ours",
    });
  }
  return lines;
}

/** Journey statuses the page labels as working ("Works", "Works · partly verified"). */
const WORKING_STATUSES = new Set(["ok", "partial"]);

/**
 * Our judgement as it may stand beside this journey's status (CHE-321).
 *
 * A conversion of 0 means one thing in the guide that produces it: "cannot be
 * finished at all: it is blocked, broken, or the control does nothing". Printed
 * under a journey the same page marks "✓ Works", it is the page contradicting
 * itself — and it happened: "Check a website anonymously" on checkmyapp.dev
 * read "✓ Works" and "Likely to finish: 0 of 100" on run #247, the zero
 * standing on a note about our own inability to target a button (rule 8).
 *
 * The walk is the evidence and the zero is an opinion, so the opinion yields:
 * the zero is withheld and the price, which says nothing about finishing,
 * stays. Nothing stored changes; this decides only what may be shown together.
 */
export function judgementBeside(ours: OurJudgement, journeyStatus: string): OurJudgement {
  if (ours.conversion === 0 && WORKING_STATUSES.has(journeyStatus)) {
    return { ...ours, conversion: null };
  }
  return ours;
}

/**
 * The sentence for a journey with no measured number.
 *
 * Three different facts, three different sentences, and none of them an empty
 * cell pretending to be a zero. A blank where a number belongs reads as "nobody
 * finished this", which would be a claim about the customer's product that
 * nothing supports.
 */
/**
 * Why our walk did not reach the end of a journey.
 *
 * Mirrors `Step.unverifiedReason`, and the distinction is the whole point: one
 * of these is the owner's to fix and one is ours, and confusing them is how a
 * customer ends up doing our work (rule 1) or waiting forever for a number we
 * were never going to produce (rule 2).
 */
export type UnfinishedReason = "missing_access" | "our_capability";

/**
 * What to say when the pages were counted but the journey was never completed.
 *
 * This sentence did not exist until CHE-283, and its absence was the defect:
 * 25 steps in recent production runs are recorded `missing_access`, the
 * database knows exactly which journeys we could not finish and why, and none
 * of it reached a single customer-facing surface. The owner saw page counts and
 * no completion rate, with nothing to explain the difference and nothing to act
 * on.
 *
 * `missing_access` is the one thing CLAUDE.md rule 2 permits asking for — "that
 * is access, not verification work" — so it names what would change and stops.
 * `our_capability` is OUR defect, already filed on our own board by
 * capability-gaps.ts, and the customer is told the consequence without being
 * handed the problem.
 */
export function unfinishedLine(reason: UnfinishedReason): string {
  switch (reason) {
    case "missing_access":
      return (
        "We could not finish this journey ourselves — it needs a sign-in we do not have. " +
        "Add test credentials for this app and the next check will measure how many of your " +
        "people get through it."
      );
    case "our_capability":
      // Deliberately no ask and no apology: the gap is ours, it is already a
      // ticket on our board, and the customer's only interest is that the
      // number is not there yet.
      return "We could not get to the end of this journey this time, so there is no completion rate for it yet.";
  }
}

export function noMeasurementLine(reason: NoMeasurement, sample?: number): string {
  switch (reason) {
    case "not_connected":
      return "Connect your analytics to see how many people actually finish this.";
    case "no_funnel":
      return "This journey does not have a measurable path yet, so there is no completion rate for it.";
    case "not_measured_yet":
      // Deliberately NOT "not enough traffic": that would state something about
      // the customer's users we have not established.
      return "No completion rate for this one yet — it will appear after the next check.";
    case "below_floor":
      return sample !== undefined
        ? `Not enough traffic to measure yet — ${sample.toLocaleString("en-US")} ${sample === 1 ? "person" : "people"} in the last two weeks.`
        : "Not enough traffic to measure yet.";
    case "access_narrowed":
      // The only one of these the owner can act on, and the only one that is
      // permanent. It says what is missing and what changes when it is granted,
      // and it never says "yet" — waiting is precisely what will not help.
      return (
        "Your analytics connection was granted less than a funnel query needs, so this cannot be " +
        "measured. Reconnect PostHog and allow it to run queries, and the next check will count it."
      );
  }
}

// ── There is deliberately no comparison between the two numbers ──────────────
//
// There was one, and it was the best line on the page when it was right:
// "We expected most people to get through this. Your own numbers say 97% do not
// finish it." It is removed because the subtraction underneath it is invalid
// (CHE-279).
//
// Our estimate answers "of the people who set out to do this, how many finish".
// The measurement answers "of the people who reached one page, how many reached
// another" — and the first of those pages is where our walk entered the app, so
// it is shared by most journeys of that app and carries no intent. Two numbers
// over different denominators can be subtracted, and the result is an artefact.
// On joblander.app that artefact was 67 points, and the sentence it produced was
// about a login our own walk had just completed successfully.
//
// This is not a claim that the comparison is worthless. It is a claim that we
// cannot make it yet, which makes it our gap rather than a caveat for the
// customer (rule 2). It returns the day a funnel provably spans its journey at
// both ends — and on that day it is one function and a threshold, not a
// redesign. Until then, both numbers stand on the page with their sources
// named, and the reader draws no line between them that we have not earned.
//
// scripts/verify-measured-denominator.ts reads this file and fails if a
// comparison reappears under any name.
