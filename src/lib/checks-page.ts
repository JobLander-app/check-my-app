// Health → Checks (CHE-360, epic CHE-348): every check of the team, newest
// first — its number, its app, when, what started it, how it came out and its
// price. Prices only (CLAUDE.md §10).

import { startedBySchedule } from "@/lib/started-via";

export type StartedFilter = "all" | "scheduled" | "request";

export const STARTED_FILTERS: { key: StartedFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "scheduled", label: "Scheduled" },
  { key: "request", label: "On request" },
];

export function startedFilter(raw: string | undefined): StartedFilter {
  return STARTED_FILTERS.some((f) => f.key === raw) ? (raw as StartedFilter) : "all";
}

export const CHECKS_PAGE = 50;

/** A whole positive number from the address, or null. */
export function runNumberParam(raw: string | undefined): number | null {
  return raw && /^\d{1,9}$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
}

// What started a check, in the reader's words. "Scheduled" is one rule
// everywhere (startedBySchedule — appHealth's split, All apps' columns, this
// page's filter). `startedVia` exists since CHE-327; a row from before it says
// only that somebody asked, or that a watch did.
const VIA: Record<string, string> = {
  ui: "From the app",
  api: "API",
  mcp: "Your agent",
  action: "GitHub Action",
  anon: "Public form",
  // The re-check owed after a check that did not finish (src/lib/failed-run.ts).
  paid_retry: "Run again",
};

export function startedLabel(run: { watchId: string | null; startedVia: string | null }): string {
  if (startedBySchedule(run)) return "Scheduled";
  return (run.startedVia && VIA[run.startedVia]) || "On request";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2 Oct, 01:02" (UTC) — spelled here: runtimes disagree on locale data. */
export function whenLine(at: Date): string {
  const hhmm = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}, ${hhmm}`;
}

// How a check came out, for a row. A check that did not finish is ours, not a
// statement about the app (CLAUDE.md §4): it says so and that it was not
// charged, and never shows a verdict.
export type Outcome = { kind: "verdict"; verdict: string } | { kind: "running" } | { kind: "unfinished" };

export function outcome(run: { status: string; verdict: string | null }, live: readonly string[]): Outcome {
  if (live.includes(run.status)) return { kind: "running" };
  if ((run.status === "completed" || run.status === "partial") && run.verdict) return { kind: "verdict", verdict: run.verdict };
  return { kind: "unfinished" };
}

export function checksHref(q: { app?: string | null; started?: StartedFilter; before?: number | null; why?: number | null }): string {
  const p = new URLSearchParams();
  if (q.app) p.set("app", q.app);
  if (q.started && q.started !== "all") p.set("started", q.started);
  if (q.before) p.set("before", String(q.before));
  if (q.why) p.set("why", String(q.why));
  const s = p.toString();
  return `${s ? `/health/checks?${s}` : "/health/checks"}${q.why ? `#c${q.why}` : ""}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The header's line: the window's numbers — appHealth's, the ones All apps and Billing show. */
export function checksLine(i: { windowDays: number; checks: number; usd: string; scheduled?: number; onRequest?: number }): string {
  if (i.checks === 0) return `No checks in the last ${i.windowDays} days.`;
  const split = i.scheduled === undefined || i.onRequest === undefined ? "" : ` ${i.scheduled} scheduled, ${i.onRequest} on request.`;
  return `${plural(i.checks, "check")} in the last ${i.windowDays} days, ${i.usd}.${split}`;
}
