// Health → Issues (CHE-360, epic CHE-348): every problem across the team's
// apps, one row per problem — not per finding. The grouping, the states and
// "gone" are recurrence's (src/lib/recurring.ts, CHE-354); this module names
// them for the page and decides which rows a filter shows.
//
// One distinction is this page's own. A problem that is not gone and not
// answered is either in the app's LATEST check — fresh evidence that it is
// there — or was found earlier in a place no check has walked since. The
// second kind is not known to be there today; saying "open" of it would be a
// claim with nothing recent under it (CLAUDE.md §8). So the page leads with the
// first ("In the latest checks", the number beside Issues in the menu) and
// calls the second what it is: not checked again.

import type { Recurrence, RecurringIssue } from "@/lib/recurring";

export type IssuesFilter = "latest" | "stale" | "recurring" | "answered" | "gone" | "all";

export const ISSUES_FILTERS: { key: IssuesFilter; label: string }[] = [
  { key: "latest", label: "In the latest checks" },
  { key: "stale", label: "Not checked again" },
  { key: "recurring", label: "Keep coming back" },
  { key: "answered", label: "Answered" },
  { key: "gone", label: "Gone" },
  { key: "all", label: "All" },
];

export function issuesFilter(raw: string | undefined): IssuesFilter {
  return ISSUES_FILTERS.some((f) => f.key === raw) ? (raw as IssuesFilter) : "latest";
}

// How a row reads on the page.
//   fresh_new / fresh_recurring — seen in the app's latest check, unanswered;
//   stale     — unanswered, last seen in an earlier check, and no check since
//               has looked at that place again (recurrence would call it gone
//               if one had and found nothing, and it would be in the latest
//               check if one had and found it);
//   known / not_a_bug — the owner's word;
//   gone      — a later check looked again and did not find it.
export type IssueView = "fresh_new" | "fresh_recurring" | "stale" | "known" | "not_a_bug" | "gone";

export function issueView(r: Pick<Recurrence, "sightings"> & { issue: Pick<RecurringIssue, "state"> }, latestRunNumber: number | null): IssueView {
  const { state } = r.issue;
  if (state !== "new" && state !== "recurring") return state;
  const inLatest = latestRunNumber !== null && r.sightings.some((s) => s.runNumber === latestRunNumber);
  return inLatest ? (state === "recurring" ? "fresh_recurring" : "fresh_new") : "stale";
}

/**
 * Which rows a filter shows. "Keep coming back" goes by recurrence's own state
 * — found in two or more checks in a row and not gone — whichever check saw it
 * last: it is the number in All apps' "Recurring" column.
 */
export function inIssuesFilter(filter: IssuesFilter, view: IssueView, state: RecurringIssue["state"]): boolean {
  switch (filter) {
    case "latest":
      return view === "fresh_new" || view === "fresh_recurring";
    case "stale":
      return view === "stale";
    case "recurring":
      return state === "recurring";
    case "answered":
      return view === "known" || view === "not_a_bug";
    case "gone":
      return view === "gone";
    case "all":
      return true;
  }
}

export const VIEW_LABEL: Record<IssueView, string> = {
  fresh_new: "New",
  fresh_recurring: "Keeps coming back",
  stale: "Not checked again",
  known: "Acknowledged",
  not_a_bug: "Not a bug",
  gone: "Gone",
};

// The palette's own tokens (src/lib/status.ts).
export const VIEW_CLASS: Record<IssueView, string> = {
  fresh_new: "border-status-confusing/40 text-status-confusing",
  fresh_recurring: "border-status-risky/40 text-status-risky",
  stale: "border-ink-600 text-fg-muted",
  known: "border-ink-600 text-fg-muted",
  not_a_bug: "border-ink-600 text-fg-muted",
  gone: "border-status-ok/40 text-status-ok",
};

/** "Seen in check #290" · "Seen in 3 checks in a row, #278 to #284" · "…Gone by check #288". */
export function seenLine(r: Pick<Recurrence, "goneSinceRunNumber"> & { issue: Pick<RecurringIssue, "timesSeen" | "firstSeenRunNumber" | "lastSeenRunNumber"> }): string {
  const { timesSeen: n, firstSeenRunNumber: first, lastSeenRunNumber: last } = r.issue;
  const seen = n <= 1 ? `Seen in check #${last}` : `Seen in ${n} checks in a row, #${first} to #${last}`;
  return r.goneSinceRunNumber === null ? seen : `${seen}. Gone by check #${r.goneSinceRunNumber}`;
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];
const VIEW_ORDER: IssueView[] = ["fresh_recurring", "fresh_new", "stale", "known", "not_a_bug", "gone"];

/** What keeps coming back first, then the new; inside a kind the most severe, then the most recently seen. */
export function sortIssues<T extends { view: IssueView; issue: Pick<RecurringIssue, "severity" | "lastSeenRunNumber"> }>(rows: T[]): T[] {
  const rank = (list: readonly string[], v: string) => (list.indexOf(v) === -1 ? list.length : list.indexOf(v));
  return [...rows].sort(
    (a, b) =>
      rank(VIEW_ORDER, a.view) - rank(VIEW_ORDER, b.view) ||
      rank(SEVERITY_ORDER, a.issue.severity) - rank(SEVERITY_ORDER, b.issue.severity) ||
      b.issue.lastSeenRunNumber - a.issue.lastSeenRunNumber,
  );
}

export function issuesHref(filter: IssuesFilter, appId?: string | null): string {
  const q = new URLSearchParams();
  if (filter !== "latest") q.set("show", filter);
  if (appId) q.set("app", appId);
  const s = q.toString();
  return s ? `/health/issues?${s}` : "/health/issues";
}

const problems = (n: number) => `${n} problem${n === 1 ? "" : "s"}`;

/** The header's two sentences: what the latest checks hold, and what was found earlier and not looked at since. */
export function issuesLine(fresh: number, stale: number): string {
  const first = fresh === 0 ? "No open problems in the latest checks of your apps." : `${problems(fresh)} in the latest checks of your apps.`;
  if (stale === 0) return first;
  return `${first} ${stale === 1 ? "1 more was" : `${stale} more were`} found earlier, in a place no check has walked since.`;
}

/** Ids in portions a D1 statement can bind (its cap is a hundred values). */
export function portions<T>(ids: T[], size = 80): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** A tracker ticket as the row names it: its key when it has one ("JOB-123"), else that one was filed. */
export function ticketLabel(link: { externalIssueId: string; status: string }): string {
  const key = /^[A-Z][A-Z0-9]{1,9}-\d+$/.test(link.externalIssueId) ? link.externalIssueId : "Ticket";
  const state = link.status === "open" ? "open" : link.status === "fixed" ? "marked done" : link.status === "resolved" ? "fix confirmed" : link.status === "suppressed" ? "closed as not a bug" : link.status;
  return `${key} · ${state}`;
}
