// What changed in the flow, next to the number that moved (CHE-242).
//
// This is the half PostHog cannot have. It already tells a founder that
// conversion fell on Tuesday. It cannot tell them that on Tuesday the form grew
// two fields and started demanding a code from the mailbox. We walked it, so we
// know — and the pairing is the product. Neither half is worth much alone.
//
// ── The discipline, which is most of the design ──────────────────────────────
//
// Everything here is **what changed**, never **why the number moved**. Rule 9:
// take them over the water, do not build them the bridge. "This flow went from
// six actions to eight" is an observation the owner can act on with information
// we do not have. "The extra email step is causing your drop" is a diagnosis we
// are not entitled to, and being right about it occasionally is worse than
// never saying it — it teaches people to trust a guess.
//
// So there is no ranking, no "likely cause", no fix. The changes are listed;
// the reader connects them. And when nothing we hold changed, that is said
// outright rather than filled with the nearest available noise:
//
//   "conversion fell 16 points; nothing changed in this flow between the two
//    checks"
//
// is a genuinely useful sentence, and an honest one. An empty list dressed up
// as an explanation is how a product starts lying politely.
//
// ── One thing the ticket asked for that is not here ─────────────────────────
//
// The ticket lists "the note that named the change" among the sources. That is
// `AppJourney.metricNote`, and the schema says of it: "Internal — never
// rendered into a verdict or an email as written." It is the model's own
// sentence about its own judgement, which is our machinery (rule 1). The price
// MOVEMENT is a fact and is reported; the note explaining it stays where it is.

import { STEP_STATUS_META } from "./status";

export interface FlowSnapshot {
  /** Actions we judged it takes to finish. */
  price: number | null;
  /** The value before the last move, when there was one. */
  prevPrice: number | null;
  /** Step labels, in order, as the walk produced them. */
  plan: readonly string[];
  /** The plan as of the earlier run being compared against. */
  prevPlan: readonly string[];
  /** Journey status now, and at the earlier run. */
  status: string | null;
  prevStatus: string | null;
  /** Findings that landed on this journey's steps in the later run. */
  newFindings: readonly string[];
  /** CHE-132: the survey saw the page itself change between the two runs. */
  pageChanged: boolean;
}

export type FlowChange =
  | { kind: "price"; from: number; to: number; text: string }
  | { kind: "step_added"; text: string }
  | { kind: "step_removed"; text: string }
  | { kind: "status"; text: string }
  | { kind: "finding"; text: string }
  | { kind: "page"; text: string };

/** How many changes are worth listing before the list stops being read. */
const MAX_CHANGES = 5;

/**
 * Everything we hold that changed in this flow between the two checks.
 *
 * Order is by how concrete each one is — a step that appeared is something the
 * owner can go and look at; "the page changed" is the vaguest thing we can
 * truthfully say, so it goes last. That is presentation, not ranking by
 * likelihood: we are not claiming any of them explains anything.
 */
export function flowChanges(s: FlowSnapshot): FlowChange[] {
  const out: FlowChange[] = [];

  const added = s.plan.filter((step) => !s.prevPlan.includes(step));
  const removed = s.prevPlan.filter((step) => !s.plan.includes(step));
  for (const step of added.slice(0, 2)) {
    out.push({ kind: "step_added", text: `a step that was not there before: “${step}”` });
  }
  for (const step of removed.slice(0, 2)) {
    out.push({ kind: "step_removed", text: `a step that is gone: “${step}”` });
  }

  if (s.price !== null && s.prevPrice !== null && s.price !== s.prevPrice) {
    out.push({
      kind: "price",
      from: s.prevPrice,
      to: s.price,
      text: `it takes ${s.prevPrice} → ${s.price} actions to finish`,
    });
  }

  for (const f of s.newFindings.slice(0, 2)) {
    // "a problem on one of its steps", not "something to fix" — the verify
    // script refuses any sentence containing "fix", and rewording was the right
    // answer rather than loosening the check: a guard that has to distinguish
    // "a thing to fix" from "here is the fix" is a guard that will one day get
    // it wrong. Rule 5's own vocabulary: findings are problems.
    out.push({ kind: "finding", text: `a problem on one of its steps: ${f}` });
  }

  // CHE-321: in the words the verdict page uses for the same journey, never the
  // stored code — the mail said "partial" where the page the link opens says
  // "Works · partly verified". And "ok" ↔ "partial" is not a change in the flow
  // at all: both read "Works", and the difference is only how much of it we
  // confirmed, which is ours to report elsewhere and not theirs to connect to
  // a number that moved.
  const working = (st: string) => st === "ok" || st === "partial";
  if (
    s.status &&
    s.prevStatus &&
    s.status !== s.prevStatus &&
    !(working(s.status) && working(s.prevStatus))
  ) {
    const label = (st: string) => STEP_STATUS_META[st]?.label ?? st;
    out.push({
      kind: "status",
      text: `this flow now reads as “${label(s.status)}”, where it read “${label(s.prevStatus)}”`,
    });
  }

  if (s.pageChanged) {
    out.push({ kind: "page", text: "the page it runs on is not the page it was" });
  }

  return out.slice(0, MAX_CHANGES);
}

/**
 * The paragraph that goes next to the movement.
 *
 * `movement` is CHE-241's sentence — already written, already rule-1 clean.
 * This adds the half PostHog cannot have, or says plainly that we have nothing.
 */
export function pairedSentence(movement: string, changes: readonly FlowChange[]): string {
  if (changes.length === 0) {
    // The honest empty answer. Said outright, because an owner who reads
    // "nothing changed here" knows to look somewhere else — at a price change,
    // a campaign, a competitor — and an owner who reads nothing at all assumes
    // we simply did not look.
    return `${movement} Nothing changed in this flow between the two checks.`;
  }
  const list = changes.map((c) => c.text);
  const tail =
    list.length === 1
      ? list[0]
      : `${list.slice(0, -1).join("; ")}; and ${list[list.length - 1]}`;
  return `${movement} What changed in it since the last check: ${tail}.`;
}
