// Today (CHE-361, epic CHE-348 direction C): the briefing. One sentence on
// whether everything is alive, then the checks by day, then what it costs.
//
// The sentence is a template over data — which apps were checked in the last
// 24 hours and what their latest verdict was — never a model's summary
// (CLAUDE.md §1 applies to anything written here). The one piece of prose in it
// is the first sentence of the bottom line the troubled app's check already
// gave its owner, quoted, not rewritten.

const TROUBLE = ["broken", "needs_attention"];
const FINE = ["all_good", "mostly_ok"];

export interface BriefingCheck {
  name: string;
  verdict: string;
  publicId: string;
  // What the check said, already reduced to one sentence ("" when it said nothing).
  said: string;
}

export interface Briefing {
  // "In the last 24 hours 3 apps were checked. 2 are fine."
  lead: string;
  // The part the page colours and links: "checkmyapp.dev needs you:" + what its check said.
  attention: { label: string; text: string; publicId: string } | null;
}

/**
 * `checked`: the latest check of each app that had one in the last 24 hours.
 * `apps`: how many apps the team has at all (an empty team gets no sentence).
 */
export function briefing(checked: BriefingCheck[], apps: number): Briefing {
  const n = checked.length;
  if (n === 0) return { lead: apps === 0 ? "" : "No app was checked in the last 24 hours.", attention: null };
  // Broken before needs-attention; the caller's order (newest first) within each.
  const trouble = TROUBLE.flatMap((v) => checked.filter((c) => c.verdict === v));
  const fine = checked.filter((c) => FINE.includes(c.verdict));
  const blind = checked.filter((c) => !FINE.includes(c.verdict) && !TROUBLE.includes(c.verdict));

  const parts = [`In the last 24 hours ${n} app${n === 1 ? " was" : "s were"} checked.`];
  if (trouble.length === 0 && blind.length === 0) {
    parts.push(n === 1 ? "It is fine." : n === 2 ? "Both are fine." : `All ${n} are fine.`);
  } else if (fine.length > 0) {
    parts.push(`${fine.length} ${fine.length === 1 ? "is" : "are"} fine.`);
  }
  if (blind.length === 1) parts.push(`${blind[0].name} could not be verified.`);
  else if (blind.length > 1) parts.push(`${blind.length} could not be verified.`);

  const first = trouble[0];
  if (!first) return { lead: parts.join(" "), attention: null };
  const others = trouble.length - 1;
  const who = others === 0 ? first.name : `${first.name} and ${others} more`;
  const verb = first.verdict === "broken" ? (others === 0 ? "is broken" : "are in trouble") : others === 0 ? "needs you" : "need you";
  return {
    lead: parts.join(" "),
    attention: { label: `${who} ${verb}${first.said ? ":" : "."}`, text: first.said, publicId: first.publicId },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const utcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/** "Friday, 2 October" (UTC) — spelled here: runtimes disagree on locale data. */
export function longDate(now: Date): string {
  return `${WEEKDAYS[now.getUTCDay()]}, ${now.getUTCDate()} ${MONTHS[now.getUTCMonth()]}`;
}

/** Which day of the feed a check belongs to: 0 = today, 1 = yesterday, … (UTC days). */
export function daysAgo(at: Date, now: Date): number {
  return Math.round((utcDay(now) - utcDay(at)) / DAY_MS);
}

/** "Today" · "Yesterday" · "30 September". */
export function dayLabel(at: Date, now: Date): string {
  const ago = daysAgo(at, now);
  return ago <= 0 ? "Today" : ago === 1 ? "Yesterday" : `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
}

/** "00:38" (UTC). */
export function hhmm(at: Date): string {
  return `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
}

/** The latest check of each app among `checks` (newest first) that finished within 24 hours of `now`. */
export function latestPerApp<T extends { appKey: string; completedAt: Date }>(checks: T[], now: Date): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const c of checks) {
    if (now.getTime() - c.completedAt.getTime() > DAY_MS || c.completedAt.getTime() > now.getTime()) continue;
    if (seen.has(c.appKey)) continue;
    seen.add(c.appKey);
    out.push(c);
  }
  return out;
}
