// Product → Journeys (CHE-362): what the page says, kept apart from how it is
// drawn so scripts/verify-journeys-page.ts holds every sentence to the rules a
// customer reads under (CLAUDE.md §1). The loader is src/lib/journeys-load.ts.

import { dayLabel } from "./today";

// The card's order: what needs the owner first — by how the last walk ended,
// worst first, then the ones never walked; the catalog's own order (oldest
// first) inside each.
const BY_TROUBLE = ["broken", "exposed", "risky", "confusing", "partial", "ok", "skipped"];

export function sortJourneys<T extends { walk: { status: string } | null }>(journeys: T[]): T[] {
  const rank = (j: T) => {
    if (!j.walk) return BY_TROUBLE.length + 1;
    const at = BY_TROUBLE.indexOf(j.walk.status);
    return at === -1 ? BY_TROUBLE.length : at;
  };
  return journeys.map((j, i) => ({ j, i })).sort((a, b) => rank(a.j) - rank(b.j) || a.i - b.i).map((x) => x.j);
}

/** "12 journeys of checkmyapp.dev, each as the screens of its last walk." */
export function journeysLine(app: string, total: number, walked: number): string {
  if (total === 0) return `No journeys of ${app} yet. They appear after its first full check.`;
  const n = `${total} journey${total === 1 ? "" : "s"} of ${app}`;
  if (walked === 0) return `${n}. None has been walked yet.`;
  if (walked < total) return `${n}; ${walked} ${walked === 1 ? "is" : "are"} shown as the screens of ${walked === 1 ? "its" : "their"} last walk.`;
  return total === 1 ? `${n}, as the screens of its last walk.` : `${n}, each as the screens of its last walk.`;
}

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

/** "Last walked today" · "Last walked yesterday" · "Last walked 30 September" — the link to the check follows it on the page. */
export function lastWalkedLabel(at: Date | null, now: Date): string {
  if (!at) return "Last walked";
  const day = dayLabel(at, now);
  return `Last walked ${day === "Today" || day === "Yesterday" ? day.toLowerCase() : day}`;
}

/** "walked 5 times" — the walks in published checks, the shown one included. */
export function walkCountLabel(walkCount: number): string {
  return walkCount > 0 ? `walked ${times(walkCount)}` : "";
}

/**
 * The mark of a journey with no walk in a published check. A check that did
 * not finish publishes nothing (CLAUDE.md §4), so a journey only such checks
 * went through is, on this page, not walked. No promise about when it will be:
 * which journeys a check walks is the rotation's call (CHE-232), not this page's.
 */
export const NOT_WALKED = "Not walked yet";

/**
 * "In trouble since 28 September — 3 walks in a row." The last `inARow` walks
 * ended neither "works" nor "works, partly verified"; `since` is the day of the
 * first of them. Null when the last walk was healthy. The pill beside it says
 * how the last one ended, so this names no status of its own.
 */
export function failingLine(inARow: number, since: Date | null, now: Date): string | null {
  if (inARow <= 0) return null;
  const day = since ? dayLabel(since, now) : null;
  const when = day === null ? "" : ` since ${day === "Today" || day === "Yesterday" ? day.toLowerCase() : day}`;
  return inARow > 1 ? `In trouble${when} — ${inARow} walks in a row.` : `In trouble${when}.`;
}

/** "Step 2 of 5: Enter email and password" — a frame's accessible name. */
export function frameLabel(index: number, total: number, label: string): string {
  return `Step ${index + 1} of ${total}: ${label}`;
}

export function journeysHref(appId: string | null): string {
  return appId ? `/product/journeys?app=${encodeURIComponent(appId)}` : "/product/journeys";
}
