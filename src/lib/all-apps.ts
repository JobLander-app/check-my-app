// Health → All apps (CHE-357, epic CHE-348 direction C): what the page decides
// before it draws anything. Pure, so scripts/verify-all-apps.ts can hold every
// sentence and every choice without a browser.
//
//   - Which view: the address says (?view=list), else the viewer's last choice
//     (a cookie the toggle writes when it is clicked), else cards. In the
//     address, so the server renders it and the link can be shared.
//   - Which apps: all, the ones whose latest check needs attention, or the ones
//     checked on a schedule (?show=…).
//   - The one line under an app's strip of checks: what the strip says, in
//     words. Counted from the same verdicts the strip draws — never written by
//     a model, so it cannot disagree with the bars above it.

import { VERDICT_META } from "@/lib/status";

export const APPS_VIEW_COOKIE = "cma_apps_view";
export type AppsView = "cards" | "list";
const VIEWS: readonly string[] = ["cards", "list"];

export function appsView(param: string | undefined, cookie: string | undefined): AppsView {
  return ([param, cookie].find((v) => v !== undefined && VIEWS.includes(v)) as AppsView | undefined) ?? "cards";
}

export type AppsFilter = "all" | "attention" | "scheduled";
export const APPS_FILTERS: { key: AppsFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "attention", label: "Need attention" },
  { key: "scheduled", label: "On a schedule" },
];

export function appsFilter(param: string | undefined): AppsFilter {
  return APPS_FILTERS.find((f) => f.key === param)?.key ?? "all";
}

const TROUBLE = new Set(["needs_attention", "broken"]);
const FINE = new Set(["all_good", "mostly_ok"]);

// `trialEnded` is the scheduler's own rule (shouldSkipWatch in src/lib/plans.ts),
// decided by the page: a Free team's watch stays `active` after its trial, and
// the scheduler never starts it again.
export type WatchState = { active: boolean; frequency: string; trialEnded: boolean } | undefined;

/** A watch that will start checks by itself: active, not "manual", and not past its trial. */
export function isScheduled(watch: WatchState): boolean {
  return watch !== undefined && watch.active && watch.frequency !== "manual" && !watch.trialEnded;
}

export function scheduleLabel(watch: WatchState): string {
  if (!watch || watch.frequency === "manual") return "Not scheduled";
  if (!watch.active) return "Paused";
  if (watch.trialEnded) return "Trial ended";
  return watch.frequency === "every_6h" ? "Every 6 hours" : "Daily";
}

export function inFilter(filter: AppsFilter, app: { latestVerdict: string | null; watch: WatchState }): boolean {
  if (filter === "attention") return app.latestVerdict !== null && TROUBLE.has(app.latestVerdict);
  if (filter === "scheduled") return isScheduled(app.watch);
  return true;
}

/** The page's own address with a view and a filter; defaults are left out. */
export function allAppsHref(view: AppsView, filter: AppsFilter): string {
  const q = new URLSearchParams();
  q.set("view", view);
  if (filter !== "all") q.set("show", filter);
  return `/health/apps?${q}`;
}

/**
 * How many of an app's problems are recurring: seen in two or more checks in a
 * row and still there. Not the ones seen once, not the ones that are gone, and
 * not the ones somebody answered ("that's fine", a disputed one).
 */
export function recurringCount(issues: { state: string }[]): number {
  return issues.filter((i) => i.state === "recurring").length;
}

export function recurringLine(n: number): string {
  if (n === 0) return "nothing keeps coming back";
  return n === 1 ? "problem seen check after check" : "problems seen check after check";
}

const checks = (n: number) => `${n} check${n === 1 ? "" : "s"}`;

/**
 * The strip in one line. `verdicts` is the strip itself: oldest first, at most
 * 21. The latest check and how long it has been that way come first; what came
 * before is said only when it differs.
 */
export function stripStory(verdicts: string[]): string {
  const n = verdicts.length;
  if (n === 0) return "Not checked yet.";
  const group = (v: string) => (TROUBLE.has(v) ? "trouble" : FINE.has(v) ? "fine" : "none");
  const latest = verdicts[n - 1];
  let streak = 1;
  while (streak < n && group(verdicts[n - 1 - streak]) === group(latest)) streak++;
  const before = verdicts.slice(0, n - streak);
  const label = VERDICT_META[latest]?.label ?? latest;

  if (group(latest) === "none") {
    return streak === n ? "Nothing verified yet." : `Nothing verified in the last ${checks(streak)}.`;
  }

  if (group(latest) === "fine") {
    const broken = before.filter((v) => v === "broken").length;
    const trouble = before.filter((v) => TROUBLE.has(v)).length;
    if (trouble === 0) {
      if (n === 1) return `${label} in its first check.`;
      // A check that verified nothing is not a check that found nothing: it is
      // counted apart, never folded into "nothing broken".
      const blind = verdicts.filter((v) => group(v) === "none").length;
      return blind === 0
        ? `Steady: nothing broken in the last ${checks(n)}.`
        : `Nothing broken in the ${checks(n - blind)} that verified something; ${blind} of the last ${n} verified nothing.`;
    }
    const since = streak === 1 ? "fine in the latest check" : `fine for the last ${streak}`;
    if (before.length === 1) return `${broken ? "Broken" : "Needed attention"} in the check before; ${since}.`;
    const attention = trouble - broken;
    const what =
      broken > 0 && attention > 0
        ? `Broken in ${broken} and needed attention in ${attention}`
        : broken > 0
          ? `Broken in ${broken}`
          : `Needed attention in ${attention}`;
    return `${what} of the ${checks(before.length)} before; ${since}.`;
  }

  const run = verdicts.slice(n - streak);
  if (streak === 1) {
    if (before.length === 0) return `${label} in its first check.`;
    // The check before is fine or verified nothing (a third kind would have
    // extended the streak). One that verified nothing cannot say the problem
    // was absent.
    return group(before[before.length - 1]) === "none"
      ? `${label} in the latest check; the check before verified nothing.`
      : `${label} in the latest check; it was not in the one before.`;
  }
  const allBroken = run.every((v) => v === "broken");
  return `${allBroken ? "Broken" : "Needs attention or broken"} ${streak} checks in a row.`;
}

/** "12 min ago", "3 h ago", "5 days ago", then the date ("12 Sep"). */
export function checkedWhen(at: Date, now: Date = new Date()): string {
  const min = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} h ago`;
  const days = Math.floor(min / (24 * 60));
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return dayMonth(at);
}

/** "12 Sep" (UTC). Spelled here, not by the runtime's locale data: Node and the Workers runtime do not agree on "Sep" / "Sept". */
export function dayMonth(at: Date): string {
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
