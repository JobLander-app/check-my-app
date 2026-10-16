// A walk that stopped without recording a step is asked once to report what it
// did (core.ts `untilSatisfied`). What it answers then is a report written on
// request, not one that came out of the walk — and a model asked to report
// something will report something. So a negative step from that turn is
// written only on positive evidence the page itself produced: an error answer
// from the product's own origin, or a console error. Silence is not evidence
// (CLAUDE.md §3), and "the walk navigated" is not evidence of anything — every
// walk does. Without it nothing is written and the walk is as unrecorded as it
// was before it was asked (the fixed sentence and the gap, execution.ts).
//
// Pure: no database, no browser, so the verify script drives the real code.

import type { ReportedStep } from "./tools";

// What a walk is told when it stops with nothing recorded. Model-facing only:
// it never reaches Step.attempted/observed or any other customer-facing text.
export const WALK_MUST_REPORT_NOTE =
  "You have not called report_step yet, so nothing of this journey is recorded. " +
  "Call report_step now for what you actually did and saw — the page you reached, " +
  "what it showed. If you could not get as far as the journey's first step, record " +
  "that as a skipped step. Report only what you observed.";

export const WALK_MAX_NUDGES = 1;

const NEGATIVE = new Set<ReportedStep["status"]>(["risky", "confusing", "broken", "exposed"]);

// "METHOD url → status" lines (tools.ts attachLogCapture). 429 is our own
// request volume (CLAUDE.md §3), never evidence.
function failedOwnRequest(networkLog: string[], ownOrigins: string[]): boolean {
  const own = ownOrigins.map((o) => o.toLowerCase());
  return networkLog.some((line) => {
    const m = /^\S+ (\S+) → (\d{3})$/.exec(line);
    if (!m) return false;
    const status = Number(m[2]);
    if (status < 400 || status === 429) return false;
    try {
      return own.includes(new URL(m[1]).origin.toLowerCase());
    } catch {
      return false;
    }
  });
}

function consoleError(consoleLog: string[]): boolean {
  return consoleLog.some((line) => line.startsWith("[error]"));
}

export function hasPositiveEvidence(args: { networkLog: string[]; consoleLog: string[]; ownOrigins: string[] }): boolean {
  return failedOwnRequest(args.networkLog, args.ownOrigins) || consoleError(args.consoleLog);
}

// Whether a step reported after the nudge may be written. A negative one needs
// positive evidence; ok and skipped claim nothing against the product.
export function nudgedStepStands(
  step: ReportedStep,
  evidence: { networkLog: string[]; consoleLog: string[]; ownOrigins: string[] },
): boolean {
  return !NEGATIVE.has(step.status) || hasPositiveEvidence(evidence);
}
