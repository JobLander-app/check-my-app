import { SETTINGS_SECTIONS } from "./app-settings-sections";

// Which parts of the product we actually reached (CHE-107).
//
// Owner concern, 2026-09-01: "волнуюсь, что мы пропустим важные ui пути".
// A worry is not answerable by a prompt — asking the walker whether its own
// coverage was good is the observer certifying itself, which rule §8 says never
// works. It is answerable by counting.
//
// Discovery already writes down what it found (Run.anatomy.pages) and the walk
// already records where it went (each step's request log). Run #128 knew about
// seven pages and built four journeys, and nothing anywhere said which three
// pages no journey ever opened. That difference is the worry, in numbers.
//
// CHE-476: the list above is what DISCOVERY found, which is not what the owner
// asked for. Run #387 was given notes naming three things — the tracker card on
// an app's Integrations settings, the one on the app's page, and the answer on
// /faq — and its coverage line named nine old verdict pages instead, so the
// verdict read as if the change had been checked. The places the notes name are
// counted the same way, and said first.
//
// Carried journeys and stale evidence are NOT here: partialBottomLine already
// states "Re-checked 3 of 5 journeys; 2 carried forward from Run #101 (last
// walked Aug 29)", and FULL_RUN_MAX_AGE_DAYS already forces a full walk when
// any carried evidence gets old.

// Discovery writes pages as prose with the path in backticks — "Login
// (`/login`)". The path is the part a request log can be matched against; the
// prose around it is for the reader.
const PATH_IN_LABEL = /`(\/[^`\s]*)`/;

export interface PageRef {
  /** As discovery wrote it, for anything a person reads. */
  label: string;
  /** The path we can actually look for, lower-cased. */
  path: string;
  /** Our own app's settings section, which lives under each app's address (…/apps/<id>/settings/x). */
  nested?: boolean;
}

export function pagePaths(pages: string[]): PageRef[] {
  const out: PageRef[] = [];
  for (const label of pages) {
    const m = label.match(PATH_IN_LABEL);
    if (!m) continue;
    const path = m[1].toLowerCase().replace(/\/+$/, "");
    // The homepage is loaded by the surface scan on every single run, so it is
    // never evidence of anything and would match every URL in the log besides.
    if (!path) continue;
    out.push({ label, path });
  }
  return out;
}

// Pages discovery found that no step went to. `evidence` is everything the walk
// wrote down that can contain a URL — request logs first, prose as a fallback.
//
// Deliberately conservative: a path counts as reached on a plain substring hit.
// Over-claiming coverage would be the dangerous direction (it hides a gap);
// under-claiming only nags. Where a path is a prefix of a deeper one
// (/tutorials vs /tutorials/101), the shallower one is credited by the deeper
// visit — which is true of a real user's navigation too.
export function unreachedPages(pages: string[], evidence: string[]): PageRef[] {
  const haystack = evidence.filter(Boolean).join("\n").toLowerCase();
  return pagePaths(pages).filter((p) => !haystack.includes(p.path));
}

// One sentence for the verdict, or null when there is nothing to disclose.
// Speaks about the customer's product only — these are their pages, and this is
// the honest scope of what we looked at (rule §2), never a note about how we
// work (rule §1).
export function coverageSentence(unreached: PageRef[], knownCount: number, asked: PageRef[] = []): string | null {
  const askedPaths = new Set(asked.map((p) => p.path));
  const rest = unreached.filter((p) => !askedPaths.has(p.path));
  const sentences: string[] = [];
  if (asked.length > 0) {
    sentences.push(`Asked for in your notes and not opened this run: ${listOf(asked)} — so nothing here speaks to ${asked.length === 1 ? "it" : "them"}.`);
  }
  if (rest.length > 0 && knownCount > 0) {
    sentences.push(`Not opened this run: ${listOf(rest)} — so nothing here speaks to ${rest.length === 1 ? "it" : "them"}.`);
  }
  return sentences.length ? sentences.join(" ") : null;
}

function listOf(pages: PageRef[]): string {
  const names = pages.slice(0, 4).map((p) => p.path);
  const more = pages.length - names.length;
  return names.join(", ") + (more > 0 ? ` and ${more} more` : "");
}

// The addresses a person's notes name. Only the owner's own words count — never
// scope hints, which say where a check may NOT go. Two shapes are read:
//   - a path written out: "/faq", "`/roles`", "(/pricing)";
//   - on our own app only, a settings section written as "settings →
//     Integrations", which is our address /settings/integrations. A customer's
//     app has its own routes, and ours say nothing about where its Integrations
//     screen lives (Codex, #345).
// A path a prohibition governs ("don't touch /admin") is not an ask. The
// prohibition reaches to the next "but", "however", "instead", "then", or an
// "and"/comma that opens a new request ("…, and check /faq"): "Don't touch
// /admin, but check /faq" asks for /faq (Codex, #345); "Don't touch /admin and
// also /billing" and "Avoid sensitive pages, including /billing" ask for neither.
// Anything else the notes describe in words ("the card on the app's page") has
// no address to look for here and is not claimed either way.
const PATH_IN_NOTES = /(?<![\w/:.@%-])(\/[\w~%.-]+(?:\/[\w~%.-]*)*)/g;
const FORBIDS = /\b(?:don'?t|do not|never|avoid|skip|except|without|exclude|excluding|ignore|not touch)\b/i;
const SECTION_IN_NOTES = /\bsettings\s*(?:→|->|›|»|>)\s*([A-Za-z][A-Za-z ]{0,30})/gi;
// Where a prohibition stops governing what follows it.
const ASK_VERB = String.raw`(?:check|open|visit|look|test|verify|go|see|walk|try|review|focus|cover|confirm|ensure|make\s+sure)`;
const PHRASE_BREAK = new RegExp(String.raw`\b(?:but|however|instead|then|while|yet)\b|(?:,|\band\b)(?=\s+(?:please\s+)?${ASK_VERB}\b)`, "gi");

/** Is the match at `index` governed by a prohibition earlier in its own phrase? */
function forbidden(clause: string, index: number): boolean {
  const before = clause.slice(0, index);
  // A bare "not" right before the path: "Check /faq, not /admin" (Codex, #345).
  if (/\bnot\s+$/i.test(before)) return true;
  let start = 0;
  for (const m of before.matchAll(PHRASE_BREAK)) start = (m.index ?? 0) + m[0].length;
  return FORBIDS.test(before.slice(start));
}

export function notePaths(notes: string | null | undefined, { ownApp = false }: { ownApp?: boolean } = {}): PageRef[] {
  if (!notes) return [];
  const out = new Map<string, PageRef>();
  const add = (label: string, raw: string, nested = false) => {
    const path = raw.toLowerCase().replace(/[.,;:!?)]+$/, "").replace(/\/+$/, "");
    if (!path || path.includes("{")) return;
    if (!out.has(path)) out.set(path, nested ? { label, path, nested } : { label, path });
  };
  for (const clause of notes.split(/\n+|;|\.(?=\s)/)) {
    for (const m of clause.matchAll(PATH_IN_NOTES)) {
      if (forbidden(clause, m.index ?? 0)) continue;
      add(m[1], m[1]);
    }
    if (!ownApp) continue;
    for (const m of clause.matchAll(SECTION_IN_NOTES)) {
      if (forbidden(clause, m.index ?? 0)) continue;
      const said = m[1].trim().toLowerCase();
      const section = SETTINGS_SECTIONS.find((s) => said.startsWith(s.label.toLowerCase()) || said.startsWith(s.key));
      if (section) add(`settings → ${section.label}`, `/settings/${section.key}`, true);
    }
  }
  return [...out.values()];
}

// The pathnames on the checked app's own hosts that the walk actually stood on:
// a recorded action's navigate "url", any action's "outcome.urlAfter" (a click
// that changed the page in a single-page app counts), and a "navigation to" in
// the walker's excerpt. Not a plain GET: a framework prefetch (GET /faq?_rsc=…)
// or an API call is not the page being opened. Not prose, "?next=/faq", a value
// typed into a field, or another site's /faq (Codex, #345).
// The walker's excerpt reads "GET https://app/x → 200; navigation to
// https://app/y → 200" (Step.networkLog, prod).
const NAVIGATION_IN_LOG = /\b(?:navigation to|navigated to)\s+((?:https?:\/\/|\/)[^\s;,]+)/gi;
const bare = (host: string) => host.toLowerCase().replace(/^www\./, "");
export function visitedPaths(navigation: string[], targetHost?: string): string[] {
  const own = targetHost ? bare(targetHost) : null;
  const out = new Set<string>();
  const add = (raw: unknown) => {
    if (typeof raw !== "string" || !raw) return;
    let path: string;
    try {
      if (raw.startsWith("/")) {
        // A relative address is on the app itself; only its query and fragment go.
        path = raw.split(/[?#]/)[0];
      } else {
        const url = new URL(raw);
        const host = bare(url.hostname);
        if (own && host !== own && !host.endsWith(`.${own}`)) return;
        path = url.pathname;
      }
    } catch {
      return;
    }
    out.add(path.toLowerCase().replace(/\/+$/, "") || "/");
  };
  for (const text of navigation.filter(Boolean)) {
    const actions = (() => {
      try {
        const parsed: unknown = JSON.parse(text);
        return Array.isArray(parsed) ? (parsed as { kind?: string; url?: unknown; outcome?: { urlAfter?: unknown } }[]) : null;
      } catch {
        return null;
      }
    })();
    if (actions) {
      for (const a of actions) {
        if (a?.kind === "navigate") add(a.url);
        add(a?.outcome?.urlAfter);
      }
      continue;
    }
    for (const m of text.matchAll(NAVIGATION_IN_LOG)) add(m[1]);
  }
  return [...out];
}

// A place counts as reached by itself or a page under it, anchored at the route
// root: /faq by /faq and /faq/billing, never by /faq-old or /help/faq (Codex,
// #345). Our own settings section is the one nested exception: it lives under
// each app, /health/apps/a1/settings/integrations.
function reached(place: PageRef, visited: string[]): boolean {
  return visited.some((v) => v === place.path || v.startsWith(`${place.path}/`) || (place.nested === true && `${v}/`.includes(`${place.path}/`)));
}

// Places the notes name that the walk never requested or navigated to.
// `navigation` is request logs and recorded actions, never prose.
export function unreachedAsked(
  notes: string | null | undefined,
  navigation: string[],
  options: { ownApp?: boolean; targetHost?: string } = {},
): PageRef[] {
  const visited = visitedPaths(navigation, options.targetHost);
  return notePaths(notes, options).filter((p) => !reached(p, visited));
}
