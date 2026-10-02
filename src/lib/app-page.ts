// The App page (CHE-358, epic CHE-348 direction C): the small decisions the
// page makes before it draws, pure so scripts/verify-app-page.ts can hold them.
//
// Nothing here is written by a model. The line under the app's name is the
// strip's own story (src/lib/all-apps.ts stripStory); a check's line in the
// timeline is the first sentence of the bottom line that check already gave
// its owner — customer text that passed the verdict-language gate when it was
// written (CLAUDE.md §1), shortened, never rephrased.

/**
 * The first sentence of a check's bottom line, for one row of the timeline.
 * A sentence ends at ". ", "! " or "? " followed by a capital or a quote, or at
 * the end — so "v2.1 is live" and "$0.89" do not end one. Longer than `max`,
 * it is cut at a word and marked.
 */
export function firstSentence(text: string | null | undefined, max = 200): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const end = clean.search(/[.!?](?=\s+["'“‘(]?[A-Z0-9])/);
  const sentence = end >= 0 ? clean.slice(0, end + 1) : clean;
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).replace(/[,;:—–-]+$/, "")}…`;
}

// A check that re-walked only part of the app opens its bottom line with a
// fixed sentence about that (src/agent/partial.ts coveragePrefix): "Re-checked
// 5 of 8 journeys; 3 carried forward from Run #278 (last walked Sep 30)."
// In the timeline that is how much was looked at, not what was found — so the
// row leads with what the check said and keeps the coverage as a short note.
const COVERAGE =
  /^(Re-checked \d+ of \d+ journeys?)(?: \(\d+ couldn't be re-walked this run\))?; \d+ carried forward from (?:Run #\d+|\d+ earlier runs) \(last walked [^)]+\)\.\s*/;

export function splitBottomLine(text: string | null | undefined): { coverage: string | null; said: string } {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  const m = clean.match(COVERAGE);
  return m ? { coverage: m[1], said: clean.slice(m[0].length) } : { coverage: null, said: clean };
}

/** "None", "1 account", "3 accounts": the default login counts as one. */
export function accountsLabel(hasDefault: boolean, named: number): string {
  const n = (hasDefault ? 1 : 0) + named;
  return n === 0 ? "None" : `${n} account${n === 1 ? "" : "s"}`;
}

/** What the app is connected to, by name; "None" when nothing is. */
export function integrationsLabel(i: { tracker: boolean; analyticsProject: string | null; repo: boolean; webhook: boolean; slack: boolean }): string {
  const names = [
    i.tracker ? "Linear" : null,
    i.analyticsProject !== null ? "PostHog" : null,
    i.repo ? "GitHub" : null,
    i.slack ? "Slack" : null,
    i.webhook ? "Webhook" : null,
  ].filter(Boolean);
  return names.length ? names.join(" · ") : "None";
}

/** "12 journeys", "1 journey", "Not mapped yet". */
export function journeysLabel(n: number): string {
  return n === 0 ? "Not mapped yet" : `${n} journey${n === 1 ? "" : "s"}`;
}

/**
 * The sentence under "This app costs": who started the window's checks.
 * "30 scheduled checks $13.63, 1 on request $1.09." — a side with no checks is
 * left out, and an app nobody checked says so.
 */
export function costSplit(scheduled: { count: number; usd: number }, onRequest: { count: number; usd: number }, usd: (n: number) => string): string {
  const parts = [
    scheduled.count > 0 ? `${scheduled.count} scheduled ${scheduled.count === 1 ? "check" : "checks"} ${usd(scheduled.usd)}` : null,
    onRequest.count > 0 ? `${onRequest.count} on request ${usd(onRequest.usd)}` : null,
  ].filter(Boolean);
  return parts.length ? `${parts.join(", ")}.` : "No checks in this window.";
}
