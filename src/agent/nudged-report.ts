// A walk that stopped without recording a step is asked once to report what it
// did (core.ts `untilSatisfied`). What it answers then is a report written on
// request, not one that came out of the walk — and a model asked to report
// something will report something. So what that turn reports is written only
// on what the walk itself left behind:
//   - ok: the walk acted — a navigation, a click or a fill is on the action
//     trail. An "ok" from a walk that did nothing observed nothing, and would
//     otherwise present the journey as verified;
//   - negative: positive evidence the page produced — an error answer from the
//     product's own origin, or a console error — AND the step's own words name
//     it. An unrelated favicon 404 earlier in the walk is not evidence for a
//     claim about something else;
//   - skipped: claims nothing about the product, so it stands.
// Silence is not evidence (CLAUDE.md §3), and "the walk navigated" is not
// evidence of a defect — every walk does. Without it nothing is written and
// the walk is as unrecorded as it was before it was asked (the fixed sentence
// and the gap, execution.ts).
//
// Pure: no database, no browser, so the verify script drives the real code.

import type { RecordedAction, ReportedStep } from "./tools";

// What a walk is told when it stops with nothing recorded. Model-facing only:
// it never reaches Step.attempted/observed or any other customer-facing text.
export const WALK_MUST_REPORT_NOTE =
  "You have not called report_step yet, so nothing of this journey is recorded. " +
  "Call report_step now for what you actually did and saw — the page you reached, " +
  "what it showed. If you could not get as far as the journey's first step, record " +
  "that as a skipped step. Report only what you observed.";

export const WALK_MAX_NUDGES = 1;

const NEGATIVE = new Set<ReportedStep["status"]>(["risky", "confusing", "broken", "exposed"]);

export interface NudgedEvidence {
  networkLog: string[];
  consoleLog: string[];
  ownOrigins: string[];
  actionTrail: RecordedAction[];
}

// What a step says, to be matched against the evidence it relies on.
function wordsOf(step: ReportedStep): string {
  return `${step.observed ?? ""} ${step.attempted ?? ""}`.toLowerCase();
}

// "METHOD url → status" lines (tools.ts attachLogCapture). 429 is our own
// request volume (CLAUDE.md §3), never evidence. A failure counts for this
// step only when the step names it: the status code, or the path that failed.
function failedOwnRequestNamed(networkLog: string[], ownOrigins: string[], words: string): boolean {
  const own = ownOrigins.map((o) => o.toLowerCase());
  return networkLog.some((line) => {
    const m = /^\S+ (\S+) → (\d{3})$/.exec(line);
    if (!m) return false;
    const status = Number(m[2]);
    if (status < 400 || status === 429) return false;
    try {
      const url = new URL(m[1]);
      if (!own.includes(url.origin.toLowerCase())) return false;
      const path = url.pathname.toLowerCase();
      return new RegExp(`\\b${status}\\b`).test(words) || (path.length > 1 && words.includes(path));
    } catch {
      return false;
    }
  });
}

// Words that open nearly every console line and say nothing about which one.
const CONSOLE_COMMON = new Set(["uncaught", "error", "failed", "resource", "status", "unhandled", "console", "exception", "message"]);

// A console error counts for this step when the step repeats something
// particular from it — a word of five letters or more that is not boilerplate.
function consoleErrorNamed(consoleLog: string[], words: string): boolean {
  return consoleLog.some((line) => {
    if (!line.startsWith("[error]")) return false;
    const tokens = line.slice("[error]".length).toLowerCase().match(/[a-z0-9_]{5,}/g) ?? [];
    return tokens.some((t) => !CONSOLE_COMMON.has(t) && words.includes(t));
  });
}

export function hasPositiveEvidence(args: { networkLog: string[]; consoleLog: string[]; ownOrigins: string[]; words: string }): boolean {
  return failedOwnRequestNamed(args.networkLog, args.ownOrigins, args.words) || consoleErrorNamed(args.consoleLog, args.words);
}

// Whether a step reported after the nudge may be written.
export function nudgedStepStands(step: ReportedStep, evidence: NudgedEvidence): boolean {
  if (step.status === "skipped") return true;
  if (step.status === "ok") return evidence.actionTrail.length > 0;
  if (!NEGATIVE.has(step.status)) return false;
  return hasPositiveEvidence({ ...evidence, words: wordsOf(step) });
}
