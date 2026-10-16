// A walk that stopped without recording a step is asked once to report what it
// did (core.ts `untilSatisfied`). What it answers then is a report written on
// request, not one that came out of the walk — and a model asked to report
// something will report something. So what that turn reports is written only
// on what the walk itself left behind, and only where the step's own words
// meet it:
//   - ok: an action on the trail that the step names (a page it went to, a
//     control it pressed or filled) and whose outcome was not an error. A walk
//     that went to one page cannot be reported as having completed another
//     step, and an "ok" from a walk that did nothing observed nothing — either
//     would present the journey as verified;
//   - negative: positive evidence the page produced — an error answer from the
//     product's own origin, or a console error — that the step names. An
//     unrelated favicon 404 earlier in the walk is not evidence for a claim
//     about something else;
//   - skipped: claims nothing about the product, so it stands.
// Silence is not evidence (CLAUDE.md §3), and "the walk navigated" is neither
// evidence of success nor of a defect — every walk does. Without it nothing is
// written and the walk is as unrecorded as it was before it was asked (the
// fixed sentence and the gap, execution.ts).
//
// The evidence is the walk's retained record (ToolEnv.walkEvidence), not the
// rolling logs: get_network_log empties those, and a walk that read the error
// it then reports must not lose it by having looked.
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
  // The walk's retained error answers and console errors (ToolEnv.walkEvidence).
  networkLog: string[];
  consoleLog: string[];
  ownOrigins: string[];
  actionTrail: RecordedAction[];
}

// What a step says, to be matched against the evidence it relies on.
function wordsOf(step: ReportedStep): string {
  return `${step.label ?? ""} ${step.observed ?? ""} ${step.attempted ?? ""}`.toLowerCase();
}

// The path as a whole, not as the front of a longer one: "/api" is not named by
// "/api/practice".
function namesPath(words: string, path: string): boolean {
  for (let at = words.indexOf(path); at !== -1; at = words.indexOf(path, at + 1)) {
    const before = words[at - 1];
    const after = words[at + path.length];
    if ((before === undefined || !/[a-z0-9_/-]/.test(before)) && (after === undefined || !/[a-z0-9_/-]/.test(after))) return true;
  }
  return false;
}

// "/practice/" and "/practice" are one address.
function pathOf(url: URL): string {
  const p = url.pathname.toLowerCase();
  return p.length > 1 ? p.replace(/\/+$/, "") || "/" : p;
}

// An address on one of the product's own origins as { origin, path }, or null.
function ownAddress(raw: string, own: string[]): { origin: string; path: string } | null {
  try {
    const url = new URL(raw);
    const origin = url.origin.toLowerCase();
    return own.includes(origin) ? { origin, path: pathOf(url) } : null;
  } catch {
    return null;
  }
}

// "METHOD url → status" lines (tools.ts attachLogCapture) that are an error
// answer from the product's own origin. 429 is our own request volume
// (CLAUDE.md §3), never evidence.
function ownFailures(networkLog: string[], own: string[]): { origin: string; path: string }[] {
  const out: { origin: string; path: string }[] = [];
  for (const line of networkLog) {
    const m = /^\S+ (\S+) → (\d{3})$/.exec(line);
    if (!m) continue;
    const status = Number(m[2]);
    if (status < 400 || status === 429) continue;
    const address = ownAddress(m[1], own);
    if (address) out.push(address);
  }
  return out;
}

// Every address on the product's own origins the walk stood on.
function stoodOn(trail: RecordedAction[], own: string[]): { origin: string; path: string }[] {
  const out: { origin: string; path: string }[] = [];
  for (const a of trail) {
    for (const raw of a.kind === "navigate" ? [a.url, a.outcome.urlAfter] : [a.outcome.urlAfter]) {
      const address = ownAddress(raw, own);
      if (address) out.push(address);
    }
  }
  return out;
}

// A failure counts for this step when the step names the path that failed — a
// status code alone is not enough, an unrelated 500 elsewhere would back any
// "returned 500". The root has no name to be spoken in, so there the walk's own
// position stands in for it: it was on that page when the page failed.
function failedOwnRequestNamed(args: { networkLog: string[]; own: string[]; words: string; actionTrail: RecordedAction[] }): boolean {
  const failures = ownFailures(args.networkLog, args.own);
  if (!failures.length) return false;
  const stood = stoodOn(args.actionTrail, args.own);
  return failures.some((f) =>
    f.path === "/"
      ? stood.some((s) => s.origin === f.origin && s.path === "/")
      : namesPath(args.words, f.path),
  );
}

// Words that open nearly every console line and say nothing about which one.
const CONSOLE_COMMON = new Set(["uncaught", "error", "failed", "resource", "status", "unhandled", "console", "exception", "message",
  "undefined", "typeerror", "referenceerror", "syntaxerror", "rangeerror", "cannot", "property", "properties", "reading", "defined", "object", "function", "denied", "refused",
  "unhandledrejection", "networkerror", "domexception", "securityerror", "evalerror", "urierror"]);

// What in a console line is one thing and not a word of English: camelCase or
// PascalCase, snake_case, or letters with a digit in them. "module" is shared
// by every unrelated "Failed to load module script"; "practiceModule" is not.
function distinctiveIdentifiers(line: string): string[] {
  const out: string[] = [];
  for (const t of line.match(/[A-Za-z_$][A-Za-z0-9_$]{4,}/g) ?? []) {
    const distinctive = /[a-z0-9][A-Z]/.test(t) || /[A-Za-z]_[A-Za-z]/.test(t) || (/[A-Za-z]/.test(t) && /[0-9]/.test(t));
    const lower = t.toLowerCase();
    if (distinctive && !CONSOLE_COMMON.has(lower)) out.push(lower);
  }
  return out;
}

// A console error counts for this step when the step repeats such an
// identifier from it, as a whole word (not a substring: "widget" inside
// "analyticswidget" is another thing).
function consoleErrorNamed(consoleLog: string[], words: string): boolean {
  const stepTokens = new Set(words.match(/[a-z0-9_$]+/g) ?? []);
  return consoleLog.some((line) => line.startsWith("[error]") && distinctiveIdentifiers(line.slice("[error]".length)).some((t) => stepTokens.has(t)));
}

export function hasPositiveEvidence(args: { networkLog: string[]; consoleLog: string[]; ownOrigins: string[]; actionTrail?: RecordedAction[]; words: string }): boolean {
  const own = args.ownOrigins.map((o) => o.toLowerCase());
  return failedOwnRequestNamed({ networkLog: args.networkLog, own, words: args.words, actionTrail: args.actionTrail ?? [] })
    || consoleErrorNamed(args.consoleLog, args.words);
}

// Words that name a control or a page without saying which.
const GENERIC = new Set(["button", "click", "clicked", "submit", "page", "pages", "link", "links", "input", "field", "form", "screen", "menu", "other", "there", "first", "after", "about"]);

// Whole words of five letters or more that a control or an address carries.
function particulars(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]{5,}/g) ?? []).filter((t) => !GENERIC.has(t));
}

// How the root is spoken of — it has no path to be named by.
const HOME_WORDS = /\b(home ?page|landing page|front page|main page|start page)\b/;

// Whether the step names this action: the page it reached (the whole path, or
// a word of it), or the control it pressed or filled.
function stepNames(action: RecordedAction, words: string, stepTokens: Set<string>, own: string[]): boolean {
  const address = ownAddress(action.outcome.urlAfter, own);
  if (address) {
    if (address.path === "/") {
      if (HOME_WORDS.test(words)) return true;
    } else if (namesPath(words, address.path) || particulars(address.path).some((t) => stepTokens.has(t))) {
      return true;
    }
  }
  const control = action.kind === "click" ? action.name : action.kind === "fill" ? action.label : undefined;
  return control !== undefined && particulars(control).some((t) => stepTokens.has(t));
}

// An ok stands on the walk when an action the step names ended without an error
// answer — its own, or any the walk met on that page.
function okBackedByWalk(step: ReportedStep, evidence: NudgedEvidence): boolean {
  const own = evidence.ownOrigins.map((o) => o.toLowerCase());
  const words = wordsOf(step);
  const stepTokens = new Set(words.match(/[a-z0-9]{5,}/g) ?? []);
  const named = evidence.actionTrail.filter((a) => stepNames(a, words, stepTokens, own));
  if (!named.length) return false;
  const failures = ownFailures(evidence.networkLog, own);
  return named.every((a) => {
    if (a.kind === "navigate" && a.outcome.status !== null && a.outcome.status >= 400 && a.outcome.status !== 429) return false;
    const address = ownAddress(a.outcome.urlAfter, own);
    return !address || !failures.some((f) => f.origin === address.origin && f.path === address.path);
  });
}

// Whether a step reported after the nudge may be written.
export function nudgedStepStands(step: ReportedStep, evidence: NudgedEvidence): boolean {
  if (step.status === "skipped") return true;
  if (step.status === "ok") return okBackedByWalk(step, evidence);
  if (!NEGATIVE.has(step.status)) return false;
  return hasPositiveEvidence({ ...evidence, words: wordsOf(step) });
}
