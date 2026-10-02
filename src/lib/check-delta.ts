// What a check changed against the one before it (CHE-371): the line under a
// check opened inside the app.
//
// It rests on recurrence as it stood AT that check (src/lib/recurring.ts,
// recurrencesAsOf) and on nothing else — in particular not on comparing two
// lists of findings. A check that walked only what had changed, or carried a
// journey forward, does not list a problem it did not look at; reading that
// absence as "gone" would be a claim with no evidence under it (CLAUDE.md §8).
// "Gone" here is recurrence's own: a later check looked again at the same
// place and did not find it.

import type { Recurrence } from "@/lib/recurring";

export interface CheckDelta {
  // The check before this one in the app's history. Null: this is the first.
  previous: number | null;
  // Problems first seen in this check (or seen again after having gone).
  fresh: number;
  // Problems this check found that an earlier check had found too.
  still: number;
  // Problems an earlier check found, that this check looked for again and did not find.
  gone: number;
}

/**
 * `recurrences`: the app's problems as of check `runNumber` (history cut at it).
 * `checks`: the numbers of the checks in that history, oldest first.
 */
export function checkDelta(recurrences: Recurrence[], checks: number[], runNumber: number): CheckDelta {
  const earlier = checks.filter((n) => n < runNumber);
  // Ruled not a bug by the owner or their tracker: not a problem to count.
  const problems = recurrences.filter((r) => r.issue.state !== "not_a_bug");
  const seenHere = problems.filter((r) => r.sightings.some((s) => s.runNumber === runNumber));
  return {
    previous: earlier.length ? earlier[earlier.length - 1] : null,
    fresh: seenHere.filter((r) => r.issue.firstSeenRunNumber === runNumber).length,
    still: seenHere.filter((r) => r.issue.firstSeenRunNumber < runNumber).length,
    gone: problems.filter((r) => r.goneSinceRunNumber === runNumber).length,
  };
}

/**
 * "Since check #290: 1 new problem, 2 still there, 1 gone."
 * `quick`: the check found nothing changed and walked nothing — it has no
 * findings of its own to compare, and says only that.
 */
export function deltaLine(d: CheckDelta, quick: boolean): string {
  if (d.previous === null) return "The first check of this app.";
  if (quick) return `Nothing had changed since check #${d.previous}, so nothing was walked again.`;
  // "Since", not "against": a problem that is gone now may have been found
  // several checks back and only looked at again in this one.
  if (d.fresh === 0 && d.still === 0 && d.gone === 0) return `Since check #${d.previous}: nothing new.`;
  const parts = [
    d.fresh > 0 ? `${d.fresh} new problem${d.fresh === 1 ? "" : "s"}` : "nothing new",
    d.still > 0 ? `${d.still} still there` : null,
    d.gone > 0 ? `${d.gone} gone` : null,
  ].filter(Boolean);
  return `Since check #${d.previous}: ${parts.join(", ")}.`;
}
