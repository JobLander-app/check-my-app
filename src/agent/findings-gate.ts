// CHE-188: a finding that rests only on a skipped step is not written.
//
// Run #153 (joblander.app): the step "Modify Insight Preferences (slider) and
// Save/Reset" was recorded skipped / our_capability — our fill did not move the
// range inputs, which is our incapacity, not their defect. Synthesis wrote the
// finding "Save Changes stays disabled — styling sliders didn't respond"
// anyway, with a stepRef pointing at that very step. It was low/confusing, so
// no ticket went out, but the owner read it on the verdict page. CLAUDE.md
// rule 3: an interaction that produced nothing for us is not evidence. The
// synthesis prompt has said "a skipped step must never become a finding" since
// CHE-82; a prompt is a request, and this is the mechanism.
//
// Pure: no database, no model. The workflow calls it between synthesis and
// persistence, so a dropped finding never reaches a row, a ticket or the page.
// The bottom line is not touched here — the coverage sentence for a skipped
// step is already written by CHE-107, and the integrity check that runs after
// persistence (workflow.ts checkVerdictIntegrity) downgrades a verdict that
// leaned on a finding this gate removed.

// CHE-215 extends the same gate with the harder version of the same failure: a
// finding that rests on no step at all.
//
// Run #159 (checkmyapp.dev) published "Credential/notes field in 'Add login &
// notes' didn't accept input", whatWeTried ["Expanded the accordion",
// "Attempted to type test credentials into the notes field"]. None of the run's
// 35 steps mentions an accordion, an expansion or a failed fill; the /check
// step that exists says the URL field accepted input and the page reacted. The
// finding had a stepRef — it carries a screenshot copied from the step it named
// — so demanding a reference would not have stopped it, and its words overlap
// the walked steps heavily enough that no bag-of-words rule tells it from a
// true one ("field", "input", "accept" are the vocabulary of both).
//
// What tells them apart is the machine record. `Step.actions` (CHE-129) is
// written by the tools, never by the model, and only after Playwright has done
// the thing: a refused or errored call leaves no entry. Run #159's whole trail
// is two fills — "Email address" and the URL box — and eight link clicks. No
// control called notes, credentials or accordion was ever driven. So the rule
// is narrow and machine-anchored: when a finding's evidence is that OUR
// interaction produced nothing, the run must show that we drove that control.
// This is CLAUDE.md rule 3 ("a step that produced no effect for us proves
// nothing") given the one record that cannot be contaminated by our own prose,
// and rule 8's demand that a claim rest on evidence uncontaminated by our state.

import { splitSentences } from "@/lib/verdict-language";
import { STORE_GATE_PATH } from "@/lib/store-gate";
import type { SynthesizedFinding } from "./synthesis";
import { accessGate, type IntegrityJourney } from "./verdict-integrity";

export interface GateStep {
  status: string;
  unverifiedReason: string | null;
  label: string;
  observed: string | null;
  // CHE-215. Optional so the older callers and the verify scripts that build a
  // step by hand keep compiling; absent means the rule below cannot speak and
  // the finding is kept.
  attempted?: string | null;
  // JSON RecordedAction[] — what the browser actually executed for this step.
  actions?: string | null;
}

export interface GateJourney {
  // CHE-372: read by the store-gate rule (accessGate); absent = walked.
  status?: string;
  steps: GateStep[];
}

export interface GateResult {
  kept: SynthesizedFinding[];
  dropped: Array<{ finding: SynthesizedFinding; reason: string }>;
}

// The reason string for the one case the ticket asked to be told apart: an
// `exposed` finding is not spared by rule (b) — a security exposure can be
// real even when our step was skipped, but then it must point at the step
// that showed it. Without a stepRef and with only skipped steps to match, it is
// dropped like any other, and the log names it so the pattern can be counted.
export const EXPOSED_NO_EVIDENCE = "exposed dropped — no step evidence";

// CHE-215: the reason string for a finding whose evidence is that one of our
// interactions produced nothing, in a run whose action trail shows we never
// drove that control.
export const NO_INTERACTION_RECORDED = "no interaction recorded";

// CHE-420: the reason string for a finding that names no step and whose words
// match no step this run walked.
export const NO_STEP_SUPPORTS = "no step in this run supports it";

// Two shared distinctive tokens is the threshold: one is a coincidence ("page"
// is on every step), two names a control ("insight" + "preferences").
const SHARED_TOKENS_MIN = 2;

// Words of five letters or more carry the identity of a control or a page;
// these are the ones of that length that carry none, so they cannot be the
// two tokens that tie a finding to a step.
const STOP_WORDS = new Set([
  "about",
  "above",
  "after",
  "again",
  "against",
  "along",
  "already",
  "although",
  "always",
  "among",
  "another",
  "anything",
  "around",
  "because",
  "before",
  "being",
  "below",
  "between",
  "cannot",
  "could",
  "during",
  "either",
  "every",
  "everything",
  "further",
  "having",
  "however",
  "instead",
  "itself",
  "might",
  "neither",
  "never",
  "nothing",
  "often",
  "other",
  "others",
  "otherwise",
  "rather",
  "should",
  "since",
  "still",
  "their",
  "there",
  "these",
  "those",
  "though",
  "through",
  "toward",
  "towards",
  "under",
  "until",
  "unless",
  "where",
  "whether",
  "which",
  "while",
  "whose",
  "within",
  "without",
  "would",
  "seems",
  "appears",
  "appear",
  "doesn",
  "didn",
  "wasn",
  "isn",
  "aren",
  "weren",
  "hasn",
  "haven",
  "couldn",
  "wouldn",
  "shouldn",
]);

// Lower-cased letter runs of five or more, stop words removed, a plural "s"
// folded so "slider" in a label meets "sliders" in a finding.
export function distinctiveTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (raw.length < 5 || STOP_WORDS.has(raw)) continue;
    const word = raw.length > 5 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw;
    out.add(word);
  }
  return out;
}

function sharedCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

function findingText(f: SynthesizedFinding): string {
  const d = f.detail ?? {};
  return [f.title, d.whatHappened ?? "", d.where ?? ""].join(" ");
}

function stepText(s: GateStep): string {
  return `${s.label} ${s.observed ?? ""}`;
}

// ─── CHE-215: the interaction anchor ─────────────────────────────────────────

// A finding says "our interaction produced nothing" in a handful of shapes, and
// they are listed here for the same reason the leak phrasings live in
// verdict-language.ts rather than in a prompt: a new phrasing is a line added
// here, not a paragraph asked of a model. Matched against the finding's title,
// whatHappened and whatWeTried, on text with curly apostrophes folded.
export const NULL_EFFECT_PHRASES: RegExp[] = [
  /\b(?:did|does|do|would|will)\s+not\s+(?:accept|take|register|respond|react|work|open|expand|submit|fire|trigger|change|update|save|apply|appear|load)\b/,
  /\b(?:didn|doesn|don|wouldn|won|couldn|can)'?t\s+(?:accept|take|register|respond|react|work|open|expand|submit|fire|trigger|change|update|save|apply|appear|load)\b/,
  /\b(?:could|can)\s?not\s+(?:enter|type|input|fill|click|press|expand|collapse|toggle|select|drag|upload|interact|reach|scroll)\b/,
  /\b(?:couldn|can)'?t\s+(?:enter|type|input|fill|click|press|expand|collapse|toggle|select|drag|upload|interact|reach|scroll)\b/,
  /\b(?:no|without\s+any?)\s+(?:visible\s+|apparent\s+)?(?:effect|reaction|response|change|feedback)\b/,
  /\bnothing\s+(?:happened|happens|occurred|changed|was\s+sent)\b/,
  /\b(?:stayed|stays|stayed|remained|remains|stay)\s+(?:disabled|empty|blank|unchanged|greyed|grayed|inert|closed)\b/,
  /\b(?:not|never|un)\s?(?:clickable|reachable|interactable|editable|typeable|selectable)\b/,
  /\b(?:aren|isn|weren|wasn)'?t\s+(?:clickable|reachable|interactable|editable|selectable)\b/,
  /\b(?:input|fill|click|typing)\s+(?:attempt\s+)?(?:did\s+not|didn'?t)\b/,
  /\bhad\s+no\s+(?:effect|result)\b/,
  // CHE-219, from run #159's journey summary and bottom line, which the list
  // above did not match: "fails to accept input", "the fill operation times
  // out". The timeout pattern is deliberately tied to one of our own verbs —
  // a bare "times out" is often the product's own answer (a checkout that
  // stalls), and only "the fill/click/… times out" is a sentence about us.
  /\bfails?\s+to\s+(?:accept|respond|react|register|take|open|expand|submit|load|work)\b/,
  /\bnever\s+(?:responds?|responded|reacts?|reacted|registers?|registered|opens?|opened)\b/,
  /\b(?:does|did)\s+nothing\b/,
  /\b(?:fill|click|type|typing|input|press|tap|drag|interaction|operation)\b[^.]{0,40}?\btimes?\s+out\b/,
  /\b(?:fill|click|type|typing|input|press|tap|drag|interaction|operation)\b[^.]{0,40}?\btimed\s+out\b/,
];

// Which hand did the finding claim to use. Kept apart because the trail is
// kept apart: run #159's words tie it to a "check" the run really did click
// ("Check your app →", a link on the way to the page), while the fill it
// actually claims — typing into a credentials field — has a trail of its own
// with one entry, "Email address". Matching a fill claim against clicks is how
// a navigation link ends up vouching for a form control.
export type ClaimedHand = "fill" | "click";

const FILL_WORDS =
  /\b(?:type|typed|typing|enter|entered|entering|input|inputs|inputted|fill|filled|filling|paste|pasted|text|credential|credentials|password|keystroke)\b/;
const CLICK_WORDS =
  /\b(?:click|clicked|clicking|press|pressed|pressing|tap|tapped|button|expand|expanded|collapse|collapsed|toggle|toggled|select|selected|accordion|dropdown|checkbox|slider|drag|dragged)\b/;

// Does this finding's evidence amount to "we acted and nothing came back", and
// with which hand? Empty means no such claim — a finding about a wrong price, a
// 500, a console exception or a dead outbound link says nothing about our own
// hands and is never touched here.
export function claimedHands(f: SynthesizedFinding): ClaimedHand[] {
  const d = f.detail ?? {};
  return handsInText(
    [f.title, d.whatHappened ?? "", ...(Array.isArray(d.whatWeTried) ? d.whatWeTried : [])].join(" · "),
  );
}

// The same question of any prose — a finding's fields joined, or one sentence
// of a journey summary (CHE-219). One idea, two entry points: a second notion
// of "we pressed this" would drift from the first the week after it was
// written.
// Where a sentence carries the claim and the observation together, judging or
// cutting the whole sentence throws away what we did see. Run #159's step read
// "The field is present but the input attempt did not take" — one sentence,
// two halves, and only the second is about us. CLAUSE_BREAK in tools.ts splits
// on punctuation; a plain "but" needs no comma, so this list is its own.
const CLAUSE_JOINS =
  /\s+(?:but|though|although|however|yet|whereas|while)\s+|\s+[—–]+\s+|;\s+|,\s+(?=(?:but|though|although|however|yet|whereas|and|so|which|because|since)\b)/i;

// A clause that says the interaction WORKED is not a claim that it produced
// nothing. Run #158 stored "The field accepted the text (a CSS-selector fill
// first timed out during hydration, but the placeholder-targeted fill
// succeeded)" — a success narrated with the stumble that preceded it — and the
// timeout phrasing fires on it.
//
// The first version of this exception was a hole wide enough to drive the
// whole point through, and review found it by running these functions rather
// than reading them:
//
//   "The button click landed on the wrong page and did nothing."
//       any success word within sixty characters of any hand word counted, so
//       "click … landed" excused "did nothing" — though "landed" says WHERE
//       the click went, not that it worked.
//   "The field never really accepted the input, nothing happened."
//       negation was checked only in the token immediately before the verb, so
//       a single adverb ("never really accepted") walked past it.
//
// Both are closed by being stricter about what counts as success: the verb must
// govern the named hand, with at most two words between them, and "landed" is
// gone because it is about direction rather than outcome; and the negation is
// looked for across everything before the verb instead of the token before it.
const HAND_SUCCESS: RegExp[] = [
  // "the placeholder-targeted fill succeeded", "the click went through"
  /\b(?:fill|click|type|typing|input|press|tap|drag|interaction|operation|submission)\b(?:\s+\S+){0,2}\s+(?:succeeded|succeeds|worked|works|went through|goes through)\b/,
  // "the field accepted the text", "accepts the input". Affirmative forms only:
  // the bare infinitive "accept" lives inside "did not accept input", which is
  // the claim itself.
  /\b(?:accepted|accepts|took|received)\s+(?:the\s+)?(?:text|input|value|credentials?|password|characters?)\b/,
];

const NEGATOR = /\b(?:not|never|no|none|nothing|failed|fails|failing|unable|without|n't)\b/;

function handSucceeded(clause: string): boolean {
  for (const re of HAND_SUCCESS) {
    const m = re.exec(clause);
    if (!m) continue;
    if (NEGATOR.test(clause.slice(0, m.index))) continue;
    return true;
  }
  return false;
}

// Read at clause level, because one sentence often carries both: run #159's
// finding said "the input attempt did not take … whereas the sign-in email
// field accepted input normally in the same run". Judging the whole text at
// once, the contrast would excuse the claim; judging the clause that makes the
// claim, it does not.
export function handsInText(raw: string): ClaimedHand[] {
  const text = raw.toLowerCase().replace(/[‘’ʼ]/g, "'");
  const claiming = text
    .split(CLAUSE_JOINS)
    .some((clause) => NULL_EFFECT_PHRASES.some((re) => re.test(clause)) && !handSucceeded(clause));
  if (!claiming) return [];
  const hands: ClaimedHand[] = [];
  if (FILL_WORDS.test(text)) hands.push("fill");
  if (CLICK_WORDS.test(text)) hands.push("click");
  return hands;
}

// One entry of Step.actions. Only the human-readable identity of a control is
// read: `label` (a fill's field label) and `name` (a click's accessible name).
// A CSS selector is our machinery — matching on it lets "input[type=text]"
// vouch for any finding that says "input" — and a URL is a place, not a
// control.
interface TrailEntry {
  kind?: unknown;
  label?: unknown;
  name?: unknown;
}

// What one hand did: how many times it acted, and the tokens of the controls it
// named. The count and the tokens answer different questions and conflating
// them cost run #159's journey summary a cut — journey 0 performed no fill at
// all, which is not the same as performing fills we cannot name.
export interface Hand {
  /** How many actions of this kind the trail recorded. */
  count: number;
  /** Distinctive tokens of their labels and accessible names. */
  tokens: Set<string>;
}

// The controls these steps actually drove. `recorded` is false when no step
// carried a parseable trail at all — runs from before CHE-129, and any run
// whose steps recorded nothing executable; then nothing here may speak.
export function drivenControls(steps: GateStep[]): {
  recorded: boolean;
  fill: Hand;
  click: Hand;
} {
  const fill: Hand = { count: 0, tokens: new Set() };
  const click: Hand = { count: 0, tokens: new Set() };
  let recorded = false;
  for (const s of steps) {
    if (!s.actions) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(s.actions);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) continue;
    recorded = true;
    for (const raw of parsed as TrailEntry[]) {
      if (!raw || typeof raw !== "object") continue;
      const into = raw.kind === "fill" ? fill : raw.kind === "click" ? click : null;
      if (!into) continue;
      into.count++;
      for (const field of [raw.label, raw.name]) {
        if (typeof field !== "string") continue;
        for (const t of distinctiveTokens(field)) into.tokens.add(t);
      }
    }
  }
  return { recorded, fill, click };
}

// Is a claim that this hand produced nothing supported by what the hand did?
// Three answers, and only the third is a denial:
//   - the hand never acted        → we are describing something we never did;
//   - it acted but named nothing  → silence (a button called "Save" carries no
//                                    token of its own), so the claim stands;
//   - it acted and named controls → the claim must name one of them, by the
//                                   same two-token rule the rest of this file
//                                   uses. One token is a coincidence, and on
//                                   this app a cheap one: our own primary page
//                                   is /check, so almost every locus carries
//                                   "check", and run #159's trail contains a
//                                   click on the link "Check your app →".
//                                   Anchoring on one token would let that nav
//                                   link vouch for "Password reset button does
//                                   nothing" at "/check — password reset",
//                                   which is this PR's own failure moved one
//                                   word to the left. Where a control's name
//                                   yields only one token, the set is small
//                                   enough that the whole of it must appear.
function handSupports(hand: Hand, locus: Set<string>): boolean {
  if (hand.count === 0) return false;
  if (hand.tokens.size === 0) return true;
  return sharedCount(locus, hand.tokens) >= Math.min(SHARED_TOKENS_MIN, hand.tokens.size);
}

// ─── CHE-219: the same evidence, one sentence at a time ──────────────────────
//
// CHE-215 removes run #159's finding. The same claim stayed published twice
// over: journey 0's summary ("…fails to accept input — the fill operation
// times out even though the field is present in the DOM") and the first half
// of the bottom line ("The credential/notes field … would not accept input
// this run"). Neither field had a gate that could see it. The phrase tables of
// CHE-82, CHE-180 and CHE-197 look for OUR words — browser, harness, oEmbed,
// the walker's "I" — and that sentence contains none; "fill" is our word, but
// it reads as ordinary product prose. So the answer is not a longer phrase
// table. It is the same evidence the findings gate uses, applied per sentence.
//
// A sentence that asserts one of our interactions produced nothing is held to
// what the run actually drove. Where the trail does not show it, the sentence
// goes and the rest of the text stays — the cut CHE-191 and CHE-197 already
// perform on these fields, driven by the machine trail instead of a word list.
// Same fail-open as the gate: no trail, or no nameable control of that hand,
// and nothing is touched.

export interface ClaimCut {
  /** The text with unsupported sentences removed; null when none survived. */
  text: string | null;
  /** The sentences that were cut, for the log. */
  cut: string[];
}

export function cutUndrivenClaims(
  text: string | null | undefined,
  journeys: GateJourney[],
): ClaimCut {
  if (!text || !text.trim()) return { text: text ?? null, cut: [] };
  const walked = journeys.flatMap((j) => j.steps).filter((s) => s.status !== "skipped");
  const trail = drivenControls(walked);
  if (!trail.recorded) return { text, cut: [] };

  const kept: string[] = [];
  const cut: string[] = [];
  for (const sentence of splitSentences(text)) {
    const hands = handsInText(sentence);
    const locus = distinctiveTokens(sentence);
    const unsupported = hands.some((hand) => !handSupports(trail[hand], locus));
    if (unsupported) cut.push(sentence.trim());
    else kept.push(sentence);
  }
  if (cut.length === 0) return { text, cut: [] };
  const out = kept.join(" ").replace(/\s+/g, " ").trim();
  return { text: out.length > 0 ? out : null, cut };
}

// The claim, cut at clause level, where our own failure is ALREADY established
// — tools.ts calls this only after a control we could not drive, so no trail
// comparison is needed: any clause saying our interaction produced nothing is,
// by construction, our incapacity. The hand is read from the whole sentence
// (a clause like "nothing happened" names no hand of its own) and only the
// clauses carrying the null-effect phrase are removed.
// Can this clause be published as a sentence of its own? A clause that opened
// its sentence begins with a capital; one that was a continuation ("the very
// field paying customers use to hand you test logins", "but the
// placeholder-targeted fill succeeded)") does not, and promoting it produces
// prose no one would sign. Unbalanced brackets are the same tell.
function standsAlone(clause: string): boolean {
  const text = clause.replace(/^["'“”‘’(\[\s]+/, "");
  if (!/^[A-Z0-9]/.test(text)) return false;
  const opens = (clause.match(/\(/g) ?? []).length;
  const closes = (clause.match(/\)/g) ?? []).length;
  return opens === closes;
}

export function cutNullEffectClauses(text: string | null | undefined): ClaimCut {
  if (!text || !text.trim()) return { text: text ?? null, cut: [] };
  const kept: string[] = [];
  const cut: string[] = [];
  for (const sentence of splitSentences(text)) {
    if (handsInText(sentence).length === 0) {
      kept.push(sentence.trim());
      continue;
    }
    const clauses = sentence.split(CLAUSE_JOINS).map((c) => c.trim()).filter(Boolean);
    const survivors: string[] = [];
    for (const clause of clauses) {
      const claim = NULL_EFFECT_PHRASES.some((re) => re.test(clause.toLowerCase().replace(/[‘’ʼ]/g, "'")));
      if (claim) {
        cut.push(clause);
      } else if (standsAlone(clause)) {
        survivors.push(clause.replace(/[.,;:\s]+$/, ""));
      } else {
        // A dependent continuation cannot be promoted to a sentence: run
        // #159's bottom line would have left "the very field paying customers
        // use to hand you test logins." on the verdict page. It goes with the
        // clause it belonged to.
        cut.push(clause);
      }
    }
    if (survivors.length) {
      const joined = survivors.join(", ");
      kept.push(/[.!?]$/.test(joined) ? joined : `${joined}.`);
    }
  }
  if (cut.length === 0) return { text, cut: [] };
  const out = kept.join(" ").replace(/\s+/g, " ").trim();
  return { text: out.length > 0 ? out : null, cut };
}

// CHE-372: the reason string for a finding in a run that never got past a
// password-protected store's own password page.
export const STORE_GATE_ONLY = "the run reached only the store's password page";

export function gateFindings(
  findings: SynthesizedFinding[],
  journeys: GateJourney[],
  opts: { targetUrl?: string | null } = {},
): GateResult {
  const kept: SynthesizedFinding[] = [];
  const dropped: GateResult["dropped"] = [];

  // CHE-372: when the machine trail shows every product page we asked for
  // ended on the store's /password page and nothing reached the store itself
  // (accessGate — the trail rule 1b of verdict-integrity.ts reads), there is
  // no evidence about the store in this run at all. Whatever synthesis made of
  // the gate — "the storefront only shows a password form" — is the store
  // being password-protected, not a defect. Every finding goes; rule 1b then
  // records Not verified and asks for the store password.
  const gate = opts.targetUrl ? accessGate(journeys as IntegrityJourney[], opts.targetUrl) : null;
  if (gate && gate.split(", ").includes(STORE_GATE_PATH)) {
    return { kept, dropped: findings.map((finding) => ({ finding, reason: STORE_GATE_ONLY })) };
  }

  const steps = journeys.flatMap((j) => j.steps);
  const skipped = steps.filter((s) => s.status === "skipped");
  const walked = steps.filter((s) => s.status !== "skipped");

  // CHE-420: what a walked step can vouch for. `attempted` counts alongside the
  // label and the observation — a finding that restates what was tried is
  // still resting on that step, and the wider the net the fewer true findings
  // this rule can cost.
  const walkedTokens = walked.map((s) => distinctiveTokens(`${stepText(s)} ${s.attempted ?? ""}`));
  // Run cmuvu9xhl published "Visitor Logs search count never reflects a
  // matching result" off the summary of a journey that recorded no step: no
  // stepRef, nothing walked behind it, and — because it claimed no null-effect
  // hand — nothing for the CHE-215 anchor to test. CHE-215 asks that every
  // published finding name a step whose recorded observation supports it;
  // until here that held only for the claims the anchor could read. A finding
  // that points at no step must at least be about one this run walked.
  //
  // A finding with an errorSignature is exempt: only our own code sets one (the
  // extension publication, from what the product's pages said or the balance
  // did), never the synthesis model, and its evidence is a measurement taken
  // outside the steps — `extension-charge-not-final` names no step and its
  // words need not overlap any walked one. Dropping it as unsupported would
  // lose a finding that rests on a recorded fact.
  const rootless = (f: SynthesizedFinding): boolean => {
    const ref = f.stepRef ? journeys[f.stepRef.journeyIndex]?.steps[f.stepRef.stepIndex] : undefined;
    if (ref) return false;
    if (f.errorSignature) return false;
    const tokens = distinctiveTokens(findingText(f));
    return !walkedTokens.some((t) => sharedCount(tokens, t) >= SHARED_TOKENS_MIN);
  };

  // CHE-215's anchor runs whether or not anything was skipped: run #159 had
  // skipped steps, but a run with none can publish the same unsupported claim.
  const trail = drivenControls(walked);
  const anchored = (f: SynthesizedFinding): { ok: true } | { ok: false; reason: string } => {
    const hands = claimedHands(f);
    if (hands.length === 0) return { ok: true };
    // No machine trail in this run ⇒ we cannot tell what we drove, so we do not
    // pretend to. Logged by the caller as a kept finding, nothing more.
    if (!trail.recorded) return { ok: true };
    const locus = distinctiveTokens(`${f.title} ${f.detail?.where ?? ""}`);
    for (const hand of hands) {
      const drove = trail[hand];
      if (handSupports(drove, locus)) continue;
      return {
        ok: false,
        reason:
          `${NO_INTERACTION_RECORDED} — the finding says a ${hand} of ours produced nothing at ` +
          `"${[...locus].join(" ")}", but ` +
          (drove.count === 0
            ? `this run performed no ${hand} at all`
            : `every ${hand} this run performed was elsewhere (${[...drove.tokens].join(" ")})`),
      };
    }
    return { ok: true };
  };

  // Nothing was skipped ⇒ CHE-188 has nothing to match, but the anchor still
  // does.
  if (skipped.length === 0) {
    for (const f of findings) {
      if (rootless(f)) {
        dropped.push({ finding: f, reason: NO_STEP_SUPPORTS });
        continue;
      }
      const a = anchored(f);
      if (a.ok) kept.push(f);
      else dropped.push({ finding: f, reason: a.reason });
    }
    return { kept, dropped };
  }

  const skippedTokens = skipped.map((s) => ({ step: s, tokens: distinctiveTokens(stepText(s)) }));

  for (const f of findings) {
    // Rule (a): the finding names its step, and that step was skipped. Any
    // unverifiedReason — our_capability, missing_access, not_applicable — is
    // a step where nothing was observed, and a finding needs an observation.
    // A stepRef to a broken/exposed/risky/confusing step is never dropped;
    // an out-of-range stepRef is no reference at all and falls to rule (b).
    const ref = f.stepRef ? journeys[f.stepRef.journeyIndex]?.steps[f.stepRef.stepIndex] : undefined;
    if (ref) {
      if (ref.status === "skipped") {
        dropped.push({
          finding: f,
          reason: `rests on skipped step "${ref.label}" (${ref.unverifiedReason ?? "no reason recorded"})`,
        });
      } else {
        // CHE-215: naming a walked step is not the same as that step showing
        // the interaction the finding claims failed. Run #159 named one.
        const a = anchored(f);
        if (a.ok) kept.push(f);
        else dropped.push({ finding: f, reason: a.reason });
      }
      continue;
    }

    // Rule (b): no step named. The finding is about a skipped step when its
    // words tie it to one and to no step we actually walked — i.e. the only
    // step it can be about is one where nothing was observed. A finding with
    // an errorSignature is a measurement of ours, not a reading of a step, so
    // a skipped step that shares its words does not make it a claim about
    // that step (see `rootless`).
    const tokens = distinctiveTokens(findingText(f));
    const match = skippedTokens.find((s) => sharedCount(tokens, s.tokens) >= SHARED_TOKENS_MIN);
    const alsoWalked = walkedTokens.some((t) => sharedCount(tokens, t) >= SHARED_TOKENS_MIN);
    if (match && !alsoWalked && !f.errorSignature) {
      dropped.push({
        finding: f,
        reason:
          f.category === "exposed"
            ? `${EXPOSED_NO_EVIDENCE} — matches only skipped step "${match.step.label}"`
            : `no stepRef; matches only skipped step "${match.step.label}" (${match.step.unverifiedReason ?? "no reason recorded"})`,
      });
      continue;
    }
    // CHE-420: no step named, and no walked step it is about either.
    if (!alsoWalked && rootless(f)) {
      dropped.push({ finding: f, reason: NO_STEP_SUPPORTS });
      continue;
    }
    const a = anchored(f);
    if (a.ok) kept.push(f);
    else dropped.push({ finding: f, reason: a.reason });
  }

  return { kept, dropped };
}
