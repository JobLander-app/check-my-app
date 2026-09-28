// Customer-facing language guard (CHE-82).
//
// The verdict is a product deliverable. Our own machinery — the headless
// browser, its quirks, our tooling — is OUR problem and must never appear in
// it. Two failures kept shipping:
//   1. leaking the environment: "didn't fire in our test browser (0 requests)";
//   2. worse, handing the job back: "verify in a real browser before treating
//      it as broken" — the customer pays us precisely so they don't have to.
// Prompt rules alone failed three times (CHE-37, CHE-70, and again here), so
// this is a deterministic gate on every customer-facing string, applied after
// the model has spoken.
//
// The honest alternative is coverage language: "we could not verify X this
// run" — a fact about our coverage, with no instruction for the owner.
//
// CHE-191 added the soft imperative ("worth confirming …") — the same
// hand-off without any of the words the first gate keyed on.
//
// CHE-197 added the walker's own voice: the wrap-up envelope ("Journey
// complete. Nothing to clean up. Summary: …") and the first person narrating
// the walk ("During the walkthrough, I signed in …") — see the narration
// section below.

// Phrases that name our machinery.
const ENVIRONMENT_TERMS = [
  // Deliberately broad: any mention at all. A narrower rule ("in a real
  // browser") missed "with a real browser" / "works in real browsers" and left
  // 40 published findings leaking after the first cleanup pass.
  /\btest browser\b/i,
  /\breal browsers?\b/i,
  /\bheadless\b/i,
  /\bplaywright\b/i,
  /\bbrowser\s+rendering\b/i,
  /\bour\s+(browser|environment|harness|agent'?s?\s+browser|crawler|tooling|automation)\b/i,
  /\bin\s+our\s+environment\b/i,
  /\bautomation\s+(context|environment)\b/i,
  /\b0\s+(network\s+)?requests?,\s*0\s+(dom\s+)?mutations?\b/i,
  /\b(?:audio|microphone|account|session) preflight\b/i,
  /\b(?:applicationStopObserved|ownerRunId|targetTabId|runtimeFailed|billingCleanup)\b/i,
  /\bowned (?:expiry|deadline|lease|confirmation sequence|session tools)\b/i,
  // How the executor died. A run that loses its container now says so in its
  // internal error (src/agent/extension-exit.ts); "container" on its own is a
  // customer's word — a logistics app, a Docker product — so these name the
  // machinery phrasings, not the noun.
  /\bthe container (?:is not running|just exited|crashed)\b/i,
  /\bthe executor (?:stopped|exited|crashed|killed|disconnected)\b/i,
  /\b(?:sigkill|sigsegv|sigterm)\b/i,
];

// Phrases that hand the verification back to the customer.
const DELEGATION_TERMS = [
  /\b(check|test|try|confirm|verify)\s+[^.]{0,60}\b(real|normal|regular|actual)\s+browsers?\b/i,
  /\bneeds?\s+(a\s+)?(real|manual|human)[- ]browser\s+check\b/i,
  /\bspot-?check\s+[^.]{0,40}\b(yourself|manually|in\s+a\s+real\s+browser)\b/i,
  /\bbefore\s+treating\s+it\s+as\s+broken\b/i,
  /\bmanual(ly)?\s+verif(y|ication)\s+(is\s+)?(needed|required|recommended)\b/i,
];

const ALL_TERMS = [...ENVIRONMENT_TERMS, ...DELEGATION_TERMS];

// ─── Homework (CHE-191) ──────────────────────────────────────────────────────
//
// The delegation terms above key on the words of the first leak: "verify in a
// real browser", "spot-check yourself", "confirm manually". Run #147
// (theins.ru, 2026-09-05) published, in a finding's whyItMatters: "Worth
// confirming both share flows open a working dialog and, if they're
// regionally unreliable, considering their placement." Same hand-off, none of
// those words. The family is the soft imperative — worth / consider / you may
// want to / make sure / double-check / please / we recommend / it would be
// worth — followed by a verification verb, plus the bare imperative aimed at
// the reader ("test this yourself", "try it in another browser").
//
// Two things must keep passing, or the gate eats evidence:
//   - what WE did, in the past tense: "we confirmed the link resolves",
//     "we checked both flows" — every pattern below asks for the base or -ing
//     form after a hand-off opener, and \b keeps "check" from matching
//     "checked";
//   - the product's own words: "users must confirm their email", the page
//     that says "please confirm your email", copy quoted from the site
//     ("worth $29") — see isReportedSpeech below.
const VERIFY_VERBS =
  "(?:confirm(?:ing)?|check(?:ing)?|verify(?:ing)?|test(?:ing)?|validat(?:e|ing)|" +
  "double[- ]check(?:ing)?|re-?check(?:ing)?|re-?test(?:ing)?|re-?verify(?:ing)?|" +
  "spot-?check(?:ing)?|mak(?:e|ing)\\s+sure|ensur(?:e|ing))";
// The adverbs the model puts between the opener and the verb.
const HEDGE = "(?:\\s+(?:also|quickly|briefly|just|manually|independently|separately|periodically|regularly|still))*\\s+";
// CHE-218: the ask arrives as a noun as often as a verb, and the adjective in
// front of it is a productive family. Run #159's bottom line, published
// 2026-09-08: "… the very field paying customers use to hand you test logins,
// so it's worth a close look before anyone relies on checks behind a sign-in."
// The old pattern enumerated one adjective — `a (quick )?(check|look|test|try)`
// — so "close", "careful", "second", "closer", "proper" and "thorough" all
// walked through. What makes the phrase homework is the NOUN it lands on, not
// the word "worth": "worth $29", "worth the upgrade", "worth every penny" are
// the product's copy and must pass. So the noun is a closed list and the
// modifiers in front of it are open.
const VERIFY_NOUNS =
  "(?:once-?over|look-?over|run-?through|walk-?through|sanity[- ]check|spot-?check|double[- ]check|" +
  "re-?check|re-?test|check|look|glance|pass|review|test|try|audit|inspection|examination|" +
  "verification|confirmation|validation)";
// One modifier between the opener and the noun or verb: any word, because the
// family is open ("close", "careful", "second", "proper", "thorough", "closer",
// and "taking" in "worth taking a second look"). A preposition, a connector or
// an article ends the noun phrase rather than continuing it, so it stops the
// run — that is what keeps "worth the price of a login" or "worth every penny
// according to the copy" out.
const MOD_STOP =
  "(?:an?|another|the|of|in|on|at|to|for|from|with|by|and|or|but|nor|as|than|that|this|these|those|" +
  "it|its|is|are|was|were|be|been|so|because|if|when|while)";
const MODIFIERS = `(?:(?!${MOD_STOP}\\b)[A-Za-z][A-Za-z'’-]*\\s+){0,2}`;
const ARTICLE = "(?:an?|another|the)\\s+";

// "check it yourself", "verify on your end", "try it in another browser".
const READER_SIDE =
  "(?:yourself|yourselves|manually|by\\s+hand|in\\s+person|on\\s+your\\s+(?:side|end|own)|from\\s+your\\s+(?:side|end)|" +
  "in\\s+(?:your\\s+own|another|a\\s+different|a\\s+(?:real|normal|regular|actual))\\s+browsers?|" +
  "on\\s+(?:your\\s+own|a\\s+real|a\\s+physical|an\\s+actual|another)\\s+(?:device|phone|machine|computer))";

export const HOMEWORK_PATTERNS: RegExp[] = [
  // "worth confirming …", "it's worth a quick check", "would be worth testing",
  // and (CHE-218) "worth a close look", "worth a second pass", "worth a
  // careful review", "worth taking a closer look", "worth carefully verifying".
  // The "it would be / it's" opener is part of the ask, so it is matched with
  // it: cutHomework cuts from where the match starts, and run #159's clause
  // ("…, so it's worth a close look") only comes away cleanly — leaving the
  // statement about the product in front of it — when the cut begins at "it's".
  new RegExp(
    `\\b(?:it(?:\\s+(?:would|might|may|could|is)|['’]s)\\s+(?:be\\s+)?)?worth${HEDGE}${MODIFIERS}(?:${ARTICLE}${MODIFIERS})?` +
      `(?:${VERIFY_NOUNS}\\b|${VERIFY_VERBS})`,
    "i",
  ),
  // "consider verifying …" (not "considering their placement").
  new RegExp(`\\bconsider${HEDGE}${VERIFY_VERBS}`, "i"),
  // "you may want to check …", "you should verify …", "you'll want to confirm …".
  new RegExp(
    `\\byou(?:\\s+(?:may|might|could|should|will|would|can|ought\\s+to|need\\s+to|want\\s+to)|['’](?:ll|d))` +
      `(?:\\s+(?:also|probably|still|then))?(?:\\s+want\\s+to)?${HEDGE}${VERIFY_VERBS}`,
    "i",
  ),
  // "be sure to check …", "remember to verify …", "don't forget to test …".
  new RegExp(`\\b(?:be\\s+sure|remember|don['’]?t\\s+forget)\\s+to${HEDGE}${VERIFY_VERBS}`, "i"),
  // "double-check that …" on its own; "double-checked" stays (past tense).
  /\bdouble[- ]check(?:ing)?\b/i,
  // "make sure the dialog opens" / "ensure the flow works": verification of an
  // outcome. "Make sure the copy is translated" is a fix, and passes.
  new RegExp(
    `\\b(?:make\\s+sure|be\\s+sure|ensure)\\b(?:\\s+that)?(?:\\s+[\\w'’-]+){0,8}?\\s+` +
      `(?:opens?|works?|loads?|renders?|responds?|resolves?|succeeds?|behaves?|functions?|fires?|completes?|` +
      `goes\\s+through|(?:is|are|stays?|remains?)\\s+(?:working|reachable|visible|clickable|responsive|functional|up))\\b`,
    "i",
  ),
  // "we recommend verifying …", "recommend that you confirm …", "Recommended: check …".
  new RegExp(`\\brecommend(?:ed|s|ation)?:?(?:\\s+that)?(?:\\s+you)?${HEDGE}${VERIFY_VERBS}`, "i"),
  // "please confirm …", "please verify …", "please try it in …". Not "please
  // try again": that is what an error banner says, and it is quoted as evidence.
  new RegExp(`\\bplease${HEDGE}(?:${VERIFY_VERBS}|try\\s+(?:it|this|that|them|these)\\b)`, "i"),
  // "it would be worth / wise / a good idea to check …", "it's worthwhile to test …".
  new RegExp(
    `\\bit\\s+(?:would|might|may|could|is|'s|’s)\\s+(?:be\\s+)?(?:worth|wise|prudent|advisable|sensible|a\\s+good\\s+idea|worthwhile)(?:\\s+to)?${HEDGE}${VERIFY_VERBS}`,
    "i",
  ),
  // The bare imperative aimed at the reader: "test this yourself", "check it
  // manually", "verify on your end", "try it in another browser".
  new RegExp(`\\b(?:check|verify|confirm|test|validate|try|re-?check|re-?test|spot-?check)\\b(?:\\s+[\\w'’-]+){0,5}?\\s+${READER_SIDE}\\b`, "i"),
];

// The words of the product's users, not ours. A sentence that hands something
// to "users", "the user", "customers", "visitors", "readers" ("customers should
// double-check their order before paying") describes the product's UI, and a
// sentence that quotes or reports the page ("the page says please confirm your
// email") is evidence. Both must survive the gate. Preceded-by is judged inside
// the clause: "Readers can share, worth confirming the dialog opens" is still
// homework — the audience is in the other clause.
const AUDIENCE = /\b(?:users?|customers?|visitors?|readers?|subscribers?|members?|shoppers?|applicants?|the\s+user|a\s+user)\b/i;
// The one ask we may make (CLAUDE.md rule 2): inputs we need. Run #62 wrote
// "please confirm the credentials are active, or supply working ones" — that
// is access, not verification work, and it stays. Narrow on purpose: the
// sentence must ask for the input or ask whether it is still good. "Needs a
// real-browser check to confirm credentials work" (run #63) is not an access
// request and stays caught.
const ACCESS_INPUT = "(?:credentials?|passwords?|test\\s+account|login\\s+details|sign-?in\\s+details|staging\\s+url|api\\s+key|invite(?:\\s+link)?)";
const ACCESS_REQUEST = new RegExp(
  `\\b(?:supply|provide|share|send|give\\s+us|we\\s+need|we\\s+would\\s+need|we'?d\\s+need)\\b[^.]{0,40}\\b${ACCESS_INPUT}\\b` +
    `|\\b${ACCESS_INPUT}\\b[^.]{0,30}\\b(?:is|are|remains?|still)\\s+(?:active|valid|current|correct|up\\s+to\\s+date|expired|stale|revoked)\\b`,
  "i",
);
const REPORTING_VERB = /\b(?:says?|said|reads?|tells?|told|asks?|asked|prompts?|prompted|states?|stated|instructs?|instructed|warns?|warned|labell?ed|titled|reading)\b(?:\s+[\w'’-]+){0,4}\s*[:,]?\s*$/i;

// One notion of a clause for the whole file: a dash, semicolon, colon or
// comma, with or without a connector. cutHomework cuts the ask at exactly
// this boundary, and the exemptions below are judged inside exactly this
// boundary — PR #57 review: with the comma missing here, "Readers can share,
// worth confirming the dialog opens" was exempted by the audience word in the
// clause before, and an access request anywhere in the sentence ("…, and
// please share a working test account") exempted an unrelated ask in front.
const CLAUSE_SEP_SOURCE = "(?:\\s+[—–-]+\\s+|;\\s+|:\\s+|,\\s+)(?:(?:so|and|but|then|hence|thus|therefore|which\\s+is\\s+why)\\s+)?";
const CLAUSE_SEP = new RegExp(CLAUSE_SEP_SOURCE, "i");
const TAIL_BREAK = new RegExp(`${CLAUSE_SEP_SOURCE}$`, "i");

const lastClause = (text: string) => text.split(CLAUSE_SEP).pop() ?? "";
const firstClause = (text: string) => text.split(CLAUSE_SEP)[0] ?? "";

function isReportedSpeech(sentence: string, matchIndex: number): boolean {
  const before = sentence.slice(0, matchIndex);
  if (insideQuotes(before)) return true;
  // The clause the match sits in: what precedes it up to the last break, and
  // what follows it up to the next.
  const lead = lastClause(before);
  const local = lead + firstClause(sentence.slice(matchIndex));
  // A reporting verb introduces the quote across the break itself ("the page
  // says, please confirm your email"), so when the match opens a clause the
  // introduction is the clause before.
  const intro = lead.trim() ? lead : lastClause(before.replace(TAIL_BREAK, ""));
  return AUDIENCE.test(lead) || REPORTING_VERB.test(intro) || ACCESS_REQUEST.test(local);
}

// Inside an open quotation? Double quotes count by parity; single quotes are
// apostrophes unless they open a word (start or after space/bracket) or close
// one (before space/punctuation).
function insideQuotes(before: string): boolean {
  const dq = (before.match(/"/g) ?? []).length;
  if (dq % 2 === 1) return true;
  const curlyOpen = (before.match(/[“«]/g) ?? []).length;
  const curlyClose = (before.match(/[”»]/g) ?? []).length;
  if (curlyOpen > curlyClose) return true;
  const singleOpen = (before.match(/(?:^|[\s(\[])[‘']/g) ?? []).length;
  const singleClose = (before.match(/[’'](?=[\s.,;:!?)\]]|$)/g) ?? []).length;
  return singleOpen > singleClose;
}

// The earliest homework in one sentence, if any — the pattern and where it
// starts — skipping matches that are the product's own words.
export function homeworkIn(sentence: string): { pattern: RegExp; index: number } | null {
  let best: { pattern: RegExp; index: number } | null = null;
  for (const re of HOMEWORK_PATTERNS) {
    const m = re.exec(sentence);
    if (!m || isReportedSpeech(sentence, m.index)) continue;
    if (!best || m.index < best.index) best = { pattern: re, index: m.index };
  }
  return best;
}

export function isHomework(sentence: string): boolean {
  return homeworkIn(sentence) !== null;
}

export function hasHomework(text: string | null | undefined): boolean {
  if (!text) return false;
  return splitSentences(text).some(isHomework);
}

// What stands in when a text was nothing but homework. Coverage, not an
// instruction: the same shape as the step fallback (CHE-180).
export const HOMEWORK_FALLBACK = "We could not confirm this in this run.";

// The ask usually arrives as the tail of a sentence about the product: "…
// repeated 401s add noise to monitoring — worth confirming you're not losing
// top-of-funnel analytics" (run #12), "… may find buttons unresponsive; worth
// confirming the header doesn't shadow the CTA" (run #15). Cutting the whole
// sentence there throws the consequence away with the ask. So: when the
// homework opens a clause after a dash, semicolon, colon or comma (with or
// without a connector), the clause goes and the sentence before it stays,
// closed with a full stop; when the homework IS the sentence, the sentence
// goes. Never a fragment: a prefix under 20 characters is not kept. The
// boundary is CLAUSE_SEP / TAIL_BREAK above, shared with isReportedSpeech.
function cutHomework(sentences: string[]): { sentences: string[]; changed: boolean } {
  let changed = false;
  const out: string[] = [];
  for (const s of sentences) {
    const hw = homeworkIn(s);
    if (!hw) {
      out.push(s);
      continue;
    }
    changed = true;
    const prefix = s.slice(0, hw.index);
    if (!TAIL_BREAK.test(prefix)) continue;
    const head = prefix.replace(TAIL_BREAK, "").trim();
    if (head.length < 20 || isHomework(head)) continue;
    out.push(/[.!?]$/.test(head) ? head : `${head}.`);
  }
  return { sentences: out, changed };
}

// The homework goes, the rest stays as written. Text that never asked
// anything of the reader comes back unchanged; text that was only the ask
// becomes the fallback — never an empty string, never a mangled fragment.
// Machinery is stripEnvironmentLeak's job and productProse runs both; this
// exists for the two fields synthesis handles on its own (a finding's
// whyItMatters, the bottom line) and for the retro sweep.
export function stripHomework(text: string, fallback = HOMEWORK_FALLBACK): string {
  const cut = cutHomework(splitSentences(text));
  if (!cut.changed) return text;
  const out = cut.sentences.join(" ").replace(/\s+/g, " ").trim();
  return out.length > 0 ? out : fallback;
}

// ─── Walk narration (CHE-197) ────────────────────────────────────────────────
//
// Runs #153 (joblander.app) and #154 (meetbashar.com), 2026-09-06, stored as
// Journey.summary: "Journey complete. No records were created; nothing to
// clean up. Summary: The signup journey and sign-in path both work — …" and
// "… During the walkthrough, I signed in with the test credentials, selected
// the Aria coach on /practice, and started a live call session that greeted
// me by name." Neither the phrase tables above nor MACHINERY_TERMS key on the
// walker's own voice: the wrap-up envelope the model writes for itself
// (journey complete, nothing to clean up, "Summary:") and the first person
// singular narrating the walk. The customer reads a statement about the
// product, not the walker's diary (CLAUDE.md rule 1).
//
// Two shapes, both cut deterministically, sentence by sentence:
//   1. the envelope — lead-ins stripped from the front of a sentence until
//      none is left ("Journey complete.", "Here's what I found:", "Summary:",
//      "Perfect!", "During the walkthrough,"), and a sentence that is only
//      bookkeeping dropped ("No records were created; nothing to clean up.",
//      "This was a read-only run — …");
//   2. the first person — I / me / my / myself as the walker: the clause it
//      sits in goes, and everything after it; what stood before it stays
//      (cutHomework's rule, the same CLAUSE_SEP). "We" is the house voice
//      ("we could not confirm X this run") and stays; CHE-191 kept "we
//      confirmed …" as evidence for the same reason.
// The product's own "I" survives: quoted copy ('Tell me about yourself'), a
// reported label (the placeholder reads Tell me about yourself), a
// label-shaped phrase (Show me my app, Notify me, Prepare my stories, My
// Stories), a question the page asks (How do I transfer to another
// registrar?). Prod data, 2026-09-07: 559 stored summaries and 2,651 stored
// steps were read against these rules before they were written down.

// Stripped from the front of a sentence, repeatedly, until none applies.
const LEAD_INS: RegExp[] = [
  // "Journey complete.", "The journey is complete!", "Journey completed
  // successfully —", "Journey walked.", 'Journey complete — "Read the About
  // / pricing overview".' Only when the sentence ends or breaks right there:
  // "Journey completed with partial verification." is a statement and stays.
  /^(?:the\s+)?(?:full\s+|entire\s+|whole\s+)?journey\s+(?:is\s+|was\s+|has\s+been\s+)?(?:complete|completed|done|finished|over|walked)(?:\s+(?:successfully|cleanly|fully))?(?:\s*[—–-]+\s*["“][^"”]*["”])?(?=\s*(?:$|[.!:;,—–-]|✅|✓))/i,
  // The summary marker: "Summary:", "Journey Summary:", "Here's the summary:",
  // "Here's what I found:", "What I found:", "Summary of findings —", "Let me
  // provide a summary of findings:", "Key findings:".
  /^(?:here(?:['’]s|\s+is)\s+(?:the|my|a|an)\s+(?:brief\s+|quick\s+|short\s+|final\s+)?summary(?:\s+of\s+(?:what\s+i\s+found|(?:the\s+|my\s+)?findings|the\s+journey|the\s+walk))?|here(?:['’]s|\s+is)\s+what\s+i\s+found|what\s+i\s+found|(?:journey\s+|final\s+|walk\s+|overall\s+)?summary(?:\s+of\s+(?:(?:the\s+|my\s+)?findings|what\s+i\s+found|the\s+journey))?|in\s+summary|(?:key\s+)?findings|let\s+me\s+(?:provide|give|summari[sz]e|write|share|report)\b[^:]{0,40})\s*[:.—–-]/i,
  // An interjection: "Perfect!", "Good —", "Interesting!". Not one that
  // closes a quotation (the page's own "… before it's finished. Nice.").
  /^(?:perfect|great|excellent|interesting|good|done|okay|ok|nice|alright)\s*[!.,:—–-](?!\s*["”'’)\]])/i,
  // Narration as a lead-in: "During the walkthrough, …" — the rest is the
  // statement, capitalised below.
  /^(?:during|in|throughout|over|across)\s+(?:the|this|my|our)\s+(?:walk-?through|walk|session|run|test(?:ing)?|check|exploration|visit)\s*[,:—–-](?=\s|$)/i,
];
// What is left in front once a lead-in is gone: the punctuation that closed
// it, a tick, a bullet.
const LEAD_JUNK = /^[\s✅✓✔•*\-—–:!.]+/;

// A sentence that is the walker's bookkeeping, wherever the phrase sits.
const BOOKKEEPING =
  /\b(?:nothing\s+(?:to\s+clean\s*up|needs?\s+clean(?:ing)?\s*up|to\s+(?:delete|remove|undo|revert|roll\s+back))|no\s+clean-?up\s+(?:is\s+|was\s+)?(?:needed|required|necessary)|clean-?up\s+(?:is\s+|was\s+)?(?:complete|done|finished|not\s+(?:needed|required)|unnecessary)|(?:were|was|been)\s+cleaned\s+up|read-only\s+run)\b/i;
// "No records were created." on its own is bookkeeping; inside a longer
// sentence ("the form submitted but no records were created in the list") it
// may be the customer's defect, so only the bare sentence goes.
const RECORDS_ONLY = /^(?:no\s+(?:new\s+)?(?:test\s+)?records?\s+(?:were|was)\s+(?:created|left(?:\s+behind)?)|nothing\s+was\s+created)\s*[.!]?$/i;

function unwrapEnvelope(sentences: string[]): { sentences: string[]; changed: boolean } {
  let changed = false;
  const out: string[] = [];
  for (const raw of sentences) {
    // A tick or a bullet in front is looked past to find the lead-in, but a
    // sentence with no lead-in is pushed exactly as it came.
    const trimmed = raw.replace(LEAD_JUNK, "");
    let s = trimmed;
    for (let stripped = true; stripped; ) {
      stripped = false;
      for (const re of LEAD_INS) {
        const next = s.replace(re, "").replace(LEAD_JUNK, "");
        if (next !== s) {
          s = next;
          stripped = true;
        }
      }
    }
    if (s === trimmed) s = raw;
    else {
      changed = true;
      s = s.charAt(0).toUpperCase() + s.slice(1);
    }
    if (!s || BOOKKEEPING.test(s) || RECORDS_ONLY.test(s)) {
      changed = true;
      continue;
    }
    out.push(s);
  }
  return { sentences: out, changed };
}

// The walker's pronoun. "I" only in upper case ("what should i ask you about
// it" is the page's copy); a token joined by a hyphen or slash (my-stories)
// is a path, not a person.
const WALKER = /(?<![\w/-])(?:I(?:['’](?:m|ve|d|ll))?|[Mm]e|[Mm]y|[Mm]yself)(?![\w/-])/g;
// The walk's tools, named in a customer sentence (run #154: "all playable via
// oEmbed"). oEmbed is how verify_links resolves a YouTube link; the rest are
// the loop's tool names. Cut at the clause like the pronoun — but the
// commonest shape is a tag on a product statement ("every link returns HTTP
// 200 via the YouTube oEmbed API", "(OK via oEmbed API)"), and the statement
// is the owner's answer, so that tag is scrubbed first and the sentence kept.
const TOOL_NAMES = /\b(?:oembed|verify_links|read_page|report_step|write_e2e_test|record_created|record_deleted|get_network_log)\b/i;
const TOOL_TAGS = [
  /\s*\([^()]*\boembed\b[^()]*\)/gi,
  /\s*(?:via|through|using|with|by)\s+(?:the\s+)?(?:youtube(?:['’]s)?\s+)?oembed(?:\s+(?:api|verification|check|lookup|endpoint|response|call))?/gi,
];
function scrubTools(sentence: string): string {
  if (!TOOL_NAMES.test(sentence)) return sentence;
  return TOOL_TAGS.reduce((s, re) => s.replace(re, ""), sentence).replace(/\s{2,}/g, " ");
}
// A capitalised word right before the pronoun makes a label ("Show me",
// "Notify me", "Prepare my stories", "Type I") — unless it is a sentence
// opener or connector, or a past-tense verb ("Selected my coach").
const NOT_A_LABEL_WORD =
  /^(?:Let|Then|Now|Next|Also|Here|Finally|First|Second|Third|Lastly|So|But|And|Yet|Still|Later|Afterwards|Meanwhile|However|Instead|Otherwise|Therefore|Thus|Hence|Since|Because|Although|Though|While|When|After|Before|Once|If|Unless|Until|As|Per|For|With|Without|Despite|Given|Following|Overall|Additionally|Note|Notes|Result|Results|Observed|Attempted|Expected|Actual|Summary|Update|Status|Interesting|Perfect|Great|Good|Excellent|Done|OK|Okay|What|Which|Where|Why|How|Who|That|This|These|Those|There|It|In|On|At|To|From|By|Of|Or|Nor|Than|Everything|Something|Nothing|Anything|All|Both|Neither|Either|Each|Every|Any|Some|No|None|Not|Only|Just|Even|Again|Thankfully|Unfortunately|Sadly|Luckily|Please|Yes|Ah|Oh|Hmm|Well|Today|Yesterday)$/;
const QUESTION_END = /\?["'”’)\]]*\s*$/;

// Is this pronoun the product's, not the walker's?
function isProductVoice(sentence: string, index: number, length: number, prevExemptEnd: number): boolean {
  const before = sentence.slice(0, index);
  const token = sentence.slice(index, index + length);
  const after = sentence.slice(index + length);
  // A quote that opens right before the pronoun ("a 'My favourite top 10'
  // section") is an opening, not a closing — the letter appended keeps
  // insideQuotes from reading it as the end of a word.
  if (insideQuotes(`${before}x`)) return true;
  const lead = lastClause(before);
  const intro = lead.trim() ? lead : lastClause(before.replace(TAIL_BREAK, ""));
  if (REPORTING_VERB.test(intro)) return true;
  // "Show me my app": the second pronoun rides on the first.
  if (prevExemptEnd >= 0 && /^\s+$/.test(sentence.slice(prevExemptEnd, index))) return true;
  const word = before.match(/([A-Z][\w'’]*)\s+$/)?.[1];
  if (word && !NOT_A_LABEL_WORD.test(word) && !/(?:ed|ing)$/.test(word)) return true;
  // "My Stories", "my Account"; "I AM" (a title in capitals).
  if (/^[Mm]y$/.test(token) && /^\s+[A-Z]/.test(after)) return true;
  if (/^\s+[A-Z]{2,}\b/.test(after)) return true;
  // A capital "My" that does not open the sentence is a page's name ("the My
  // account page"); the walker's own "my" is lower case there.
  if (/^M/.test(token) && before.trim().length > 0) return true;
  // A list is the page's: "(Currently Reading, Music is life, I run
  // sometimes)", "live insights → mirror mode → my stories → …". The walker's
  // own aside "(which I did not click)" has no list in it.
  if (/→/.test(lead + firstClause(after))) return true;
  const open = before.lastIndexOf("(");
  if (open >= 0 && before.indexOf(")", open) < 0) {
    const close = sentence.indexOf(")", index);
    const inside = sentence.slice(open + 1, close < 0 ? undefined : close);
    if (/→|\s\/\s/.test(inside) || (inside.match(/,/g) ?? []).length >= 2) return true;
  }
  // A question is the page's: "How do I transfer to another registrar?"
  return QUESTION_END.test(firstClause(after));
}

// Where the walker first speaks in a sentence — a pronoun that is not the
// product's, or a tool of ours by name — or null.
export function walkerIn(sentence: string): number | null {
  let at: number | null = null;
  let prevExemptEnd = -1;
  for (const m of sentence.matchAll(WALKER)) {
    if (isProductVoice(sentence, m.index, m[0].length, prevExemptEnd)) {
      prevExemptEnd = m.index + m[0].length;
      continue;
    }
    at = m.index;
    break;
  }
  const tool = TOOL_NAMES.exec(sentence);
  if (tool && (at === null || tool.index < at)) at = tool.index;
  return at;
}

const CLAUSE_SPLIT = new RegExp(`(${CLAUSE_SEP_SOURCE})`, "i");
// A head that opens with a subordinator was leading up to the walker's clause
// ("Per the no-wandering rule on third-party sites, I stayed …") and cannot
// stand on its own.
const DANGLING_HEAD = /^(?:per|since|because|although|though|while|when|whenever|after|before|if|unless|until|as|despite|given|without|due\s+to|owing\s+to|so|once|whereas|even\s+though)\b/i;
// A single clause that opens with a preposition was the setting for what
// followed ("From the example.com home page, I located …") — with more than
// one clause it is a statement ("On mobile, the header covers the CTA").
const SETTING_HEAD = /^(?:from|on|at|in|into|with|via|through|inside|within|under|over|across|starting|using)\b/i;

// The clause the walker speaks in goes, with everything after it; the clauses
// before it stay, closed with a full stop — never a fragment (20 characters,
// as cutHomework), never a head that still speaks or that only led up to it.
function cutNarration(sentences: string[]): { sentences: string[]; changed: boolean } {
  let changed = false;
  const out: string[] = [];
  for (const raw of sentences) {
    const s = scrubTools(raw);
    if (s !== raw) changed = true;
    const at = walkerIn(s);
    if (at === null) {
      out.push(s);
      continue;
    }
    changed = true;
    const parts = s.slice(0, at).split(CLAUSE_SPLIT);
    parts.pop(); // the clause the pronoun opens or sits in
    parts.pop(); // the break before it (undefined when the pronoun is in the first clause)
    // A bracket the cut left open, and the punctuation that led on, go too.
    const head = parts.join("").replace(/\s*\([^)]*$/, "").replace(/[\s,;:—–-]+$/, "").trim();
    if (head.length < 20 || DANGLING_HEAD.test(head) || walkerIn(head) !== null) continue;
    if (SETTING_HEAD.test(head) && !CLAUSE_SEP.test(head)) continue;
    out.push(/[.!?]$/.test(head) ? head : `${head}.`);
  }
  return { sentences: out, changed };
}

// The sentences of a text that carry the walker's voice — for the retro
// sweep's report and the verify script; what productProse acts on.
export function narrationIn(text: string | null | undefined): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const raw of splitSentences(text)) {
    const unwrapped = unwrapEnvelope([raw]);
    if (unwrapped.changed || cutNarration(unwrapped.sentences).changed) found.push(raw);
  }
  return found;
}

export function hasNarration(text: string | null | undefined): boolean {
  return narrationIn(text).length > 0;
}

// The envelope unwrapped and the walker cut, nothing else — the retro sweep
// and summarizeWalk apply this on its own; productProse runs it with the
// machinery and homework gates. Text without the walker's voice comes back
// as written; text that was only the walker's voice becomes the fallback.
export function stripNarration(text: string, fallback = HOMEWORK_FALLBACK): string {
  const unwrapped = unwrapEnvelope(splitSentences(text));
  const cut = cutNarration(unwrapped.sentences);
  if (!unwrapped.changed && !cut.changed) return text;
  const out = cut.sentences.join(" ").replace(/\s+/g, " ").trim();
  return out.length > 0 ? out : fallback;
}

// What a journey summary becomes when the walker's words were all it had.
// The step fallbacks below are for one step; a journey rolls its steps up,
// so the sentence names the journey and follows the roll-up (execution.ts
// journeyStatus): coverage when part or all of it went unverified, the
// no-defect sentence when it was ok, the problem sentence otherwise.
export const JOURNEY_OK_FALLBACK = "This journey behaved as a user would expect; nothing failed.";
export const JOURNEY_PROBLEM_FALLBACK = "This journey did not behave as a user would expect.";
export function summaryFallback(status?: string | null): string {
  if (status === "ok") return JOURNEY_OK_FALLBACK;
  if (!status || status === "skipped" || status === "partial") return HOMEWORK_FALLBACK;
  return JOURNEY_PROBLEM_FALLBACK;
}

// ─── Our own guard, and a summary that is about this walk (CHE-334) ─────────
//
// Owner, 2026-09-28, during a live demo: checkmyapp.dev's own verdict showed
// "strange reasons why it's broken". Run #260 said "'Show me my app' returns
// 403 for this account" and, in the bottom line, that the core promise "was
// refused at the bot-check gate (403)". The 403 was our own self-check guard
// (src/lib/self-check.ts) refusing our own checker — rule 8, a claim resting
// on our own state. Run #261's summaries opened with "CheckMyApp is a
// link-verification tool that …" and said "the previously reported OAuth
// redirect bug appears fixed": a product brochure and our own history, where
// the reader expects what happened on this walk.

// What a step our own guard refused says instead of the model's words. Fixed,
// so the verdict reads one sentence for one situation, and so a later reader
// (synthesis, below) can recognise the step from the row alone.
export const SELF_CHECK_REFUSED_OBSERVED =
  "Stopped here on purpose: checks of this product never create, start or change anything in it.";

export function isSelfCheckRefusalStep(step: { unverifiedReason?: string | null; observed?: string | null }): boolean {
  return step.unverifiedReason === "not_applicable" && step.observed === SELF_CHECK_REFUSED_OBSERVED;
}

// A sentence that retells the refusal as a fact about the product. Applied
// only where a refusal of our own guard is known to have happened (the walk
// that met it, the run whose steps carry it) — never as a general rule, where
// "403" and "refused" are exactly the evidence a real user hits.
const SELF_CHECK_REFUSAL_CLAIM =
  /\b403\b|\bforbidden\b|\brefus(?:ed|es|al|ing)\b|\brejected\b|\bdenied\b|\bblocked\b|\bbot[- ]?(?:check|gate|protection)\b|\bnot available to (?:this|the|our) account\b|\bout of reach\b|\bself_check=read_only\b|\bread-only\b/i;

// A step as the refusal gates see it: the row, or the walk's copy of it.
export type RefusalContextStep = {
  label?: string | null;
  attempted?: string | null;
  observed?: string | null;
  status?: string | null;
  unverifiedReason?: string | null;
};

// What a sentence points at: the paths and quoted names it cites, and its
// content words. Codex review of #205: a keyword alone cannot tell our refusal
// from a real 403 elsewhere in the same run ("Settings are blocked by a 403"),
// so a claim sentence is matched to the steps it talks about.
const REF_PATH = /(?:^|[\s"'`(])(\/[a-z0-9][\w\-./]*)/gi;
const REF_QUOTED = /["'“‘]([^"'”’]{3,60})["'”’]/g;
const CLAIM_WORDS = new Set([
  "403", "forbidden", "refused", "refuses", "refusal", "refusing", "rejected", "denied", "blocked", "check",
  "gate", "bot-check", "account", "this", "that", "with", "from", "returns", "returned", "reach", "when",
  "were", "was", "the", "and", "for", "but", "not", "available", "only", "read-only", "page", "button",
]);
function refsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(REF_PATH)) out.add(`path:${m[1].toLowerCase().replace(/[.,;:]+$/, "")}`);
  for (const m of text.matchAll(REF_QUOTED)) out.add(`name:${m[1].trim().toLowerCase()}`);
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []) if (!CLAIM_WORDS.has(w)) out.add(`word:${w}`);
  return out;
}
function overlap(a: Set<string>, b: Set<string>): number {
  let score = 0;
  for (const r of a) if (b.has(r)) score += r.startsWith("word:") ? 1 : 3;
  return score;
}

// Does this claim sentence rest on a step that stands — a real problem the
// run saw somewhere our guard did not answer — more than on a refused one?
// Only then is it the product's words and kept. With no step context, or no
// standing problem step at all, every claim sentence is the refusal retold.
function restsOnStandingStep(sentence: string, steps: readonly RefusalContextStep[]): boolean {
  const refs = refsOf(sentence);
  let refused = 0;
  let standing = 0;
  for (const s of steps) {
    const text = [s.label, s.attempted, s.observed].filter(Boolean).join(" ");
    if (isSelfCheckRefusalStep(s)) refused = Math.max(refused, overlap(refs, refsOf(`${s.label ?? ""} ${s.attempted ?? ""}`)));
    else if (s.status && s.status !== "ok" && SELF_CHECK_REFUSAL_CLAIM.test(text)) standing = Math.max(standing, overlap(refs, refsOf(text)));
  }
  return standing > 0 && standing > refused;
}

// The sentences that retell our own refusal go; the rest stays as written.
// Null when nothing survives, so the caller writes its fixed sentence. With
// `steps`, a claim sentence that points at a standing problem step more than
// at a refused one is the product's own evidence and stays.
export function cutSelfCheckRefusalClaims(
  text: string | null | undefined,
  steps: readonly RefusalContextStep[] = [],
): { text: string | null; cut: string[] } {
  if (!text) return { text: text ?? null, cut: [] };
  const cut: string[] = [];
  const kept = splitSentences(text).filter((s) => {
    if (!SELF_CHECK_REFUSAL_CLAIM.test(s) || restsOnStandingStep(s, steps)) return true;
    cut.push(s);
    return false;
  });
  if (cut.length === 0) return { text, cut };
  const out = kept.join(" ").replace(/\s+/g, " ").trim();
  return { text: out || null, cut };
}

// The names a summary would call the product by: the target's registrable
// label ("checkmyapp" for checkmyapp.dev, "joblander" for app.joblander.app).
// Compared with every non-letter removed, so "CheckMyApp", "Check My App" and
// "checkmyapp.dev" are all the same name.
function productNamesOf(targetUrl: string): string[] {
  try {
    const labels = new URL(targetUrl).hostname.toLowerCase().replace(/^www\./, "").split(".");
    const names = new Set<string>([labels.join("")]);
    if (labels.length >= 2) names.add(labels[labels.length - 2]);
    return [...names].filter(Boolean);
  } catch {
    return [];
  }
}
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// "<Product> is a/an …", "This app is a …". The subject is the product's own
// name or a generic word for the product, never a part of it ("The sign-in
// page is a two-step form" is about this walk and stays).
const DESCRIPTION_OPENER =
  /^\s*["'“]?((?:[A-Za-z0-9][\w.'’-]*)(?:\s+[A-Za-z0-9][\w.'’-]*){0,2})["'”]?\s+is\s+(?:an?|the)\s+/;
const GENERIC_PRODUCT_SUBJECT = /^(?:the|this)\s+(?:app|application|product|site|website|service|platform|tool|web\s*app)$/i;
// The description ends where an independent clause starts: after a semicolon
// or a dash, what follows is its own statement ("…; its sign-in works"), and
// so after a comma with a conjunction ("…, but the practice call crashed with
// a 500" — Codex review of #205). Not ", and": inside a description that is
// the last item of a list ("…, ticket params, and test-record permissions"),
// run #261's own shape. A colon or a bare comma only continues it.
const DESCRIPTION_END = /;\s+|\s+[—–]\s+|,\s+(?:but|yet|so|while|though|although|however)\s+/i;

function cutDescription(sentence: string, names: string[]): string | null {
  const m = DESCRIPTION_OPENER.exec(sentence);
  if (!m) return sentence;
  const subject = m[1].trim();
  if (!GENERIC_PRODUCT_SUBJECT.test(subject) && !names.includes(squash(subject))) return sentence;
  const end = DESCRIPTION_END.exec(sentence);
  if (!end) return null;
  const rest = sentence.slice(end.index + end[0].length).trim();
  if (rest.length < 20) return null;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

// Our own history, retold: an earlier report, a bug that "appears fixed", the
// old behaviour that "is gone". A summary says what this walk saw; whether a
// ticket of ours is settled is decided elsewhere (src/agent/reconcile.ts).
const HISTORY_CLAIM = new RegExp(
  [
    String.raw`\b(?:previously|earlier|formerly|last\s+time|before)\s+(?:\w+\s+){0,2}(?:reported|flagged|noted|found|seen|filed|observed|identified|described)\b`,
    // "in the last check", "since the previous run" — the noun alone is not
    // history: "The Previous Runs table loaded" is this walk's page.
    String.raw`\b(?:in|from|on|since|than|as\s+in|during|after)\s+(?:the\s+|a\s+|an\s+|our\s+|your\s+)?(?:previous|prior|earlier|last|past|older)\s+(?:runs?|checks?|reports?|verdicts?|walks?|visits?)\b`,
    String.raw`\b(?:bug|issue|problem|defect|error|regression|finding|detour)\b[^.;:]{0,40}\b(?:(?:is|was|are|were|has\s+been|have\s+been|appears?|seems?)\s+(?:now\s+)?(?:to\s+be\s+)?(?:fixed|resolved|gone)|no\s+longer\s+(?:occurs?|happens?|appears?|reproduces?))\b`,
    String.raw`\bthe\s+old\b[^.;:]{0,60}\b(?:is|are|was|were)\s+(?:now\s+)?gone\b`,
    String.raw`\bas\s+(?:previously|before|last\s+time)\s+(?:reported|noted|seen)\b`,
  ].join("|"),
  "i",
);

// The clause that retells history goes, with everything after it in the
// sentence; the clauses before it stay (the cut cutNarration makes). A
// parenthesis the cut left open goes too.
function cutHistory(sentence: string): string | null {
  const m = HISTORY_CLAIM.exec(sentence);
  if (!m) return sentence;
  const before = sentence.slice(0, m.index);
  // An aside in brackets ("works end-to-end (the previously reported bug is
  // fixed), but the layout …") goes on its own; the sentence around it stands.
  const open = before.lastIndexOf("(");
  const close = sentence.indexOf(")", m.index);
  if (open >= 0 && before.indexOf(")", open) < 0 && close > 0) {
    const rest = `${sentence.slice(0, open).trimEnd()}${sentence.slice(close + 1)}`.replace(/\s+([,.;:!?])/g, "$1");
    return cutHistory(rest.replace(/\s{2,}/g, " ").trim());
  }
  const parts = before.split(CLAUSE_SPLIT);
  parts.pop();
  parts.pop();
  const head = parts.join("").replace(/\s*\([^)]*$/, "").replace(/[\s,;:—–(-]+$/, "").trim();
  if (head.length < 20 || DANGLING_HEAD.test(head)) return null;
  return /[.!?]$/.test(head) ? head : `${head}.`;
}

// A journey summary as the reader expects it: what happened on this walk.
// Product descriptions and our own history are cut deterministically; what is
// left stays as written. Null when nothing is left — the caller writes the
// journey's fixed sentence (summaryFallback).
export function walkSummaryOnly(
  text: string | null | undefined,
  targetUrl: string,
): { text: string | null; cut: string[] } {
  if (!text) return { text: text ?? null, cut: [] };
  const names = productNamesOf(targetUrl);
  const cut: string[] = [];
  const out: string[] = [];
  for (const raw of splitSentences(text)) {
    const described = cutDescription(raw, names);
    const kept = described === null ? null : cutHistory(described);
    if (kept !== raw) cut.push(raw);
    if (kept) out.push(kept);
  }
  if (cut.length === 0) return { text, cut };
  const joined = out.join(" ").replace(/\s+/g, " ").trim();
  return { text: joined || null, cut };
}

// A sentence that names our machinery (the CHE-82 tables). Homework is judged
// separately, because it is cut at the clause rather than the sentence.
function leaksMachinery(sentence: string): boolean {
  return ALL_TERMS.some((re) => re.test(sentence));
}

// The phrase table plus the homework family (CHE-191): "environment leak" has
// meant both halves of CLAUDE.md rule 1 since CHE-82, and every caller that
// drops or strips on it — synthesis, productizeStep's clause filter, the
// retro scripts — wants the homework caught the same way.
export function environmentLeaks(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = ALL_TERMS.filter((re) => re.test(text)).map((re) => re.source);
  for (const s of splitSentences(text)) {
    const hw = homeworkIn(s);
    if (hw && !found.includes(hw.pattern.source)) found.push(hw.pattern.source);
  }
  return found;
}

export function hasEnvironmentLeak(text: string | null | undefined): boolean {
  return environmentLeaks(text).length > 0;
}

export function productStepLabel(text: string): string {
  const label = text.replace(/\b(?:pre-session\s+)?account preflight\b/gi, "Session balance")
    .replace(/\b(?:audio|microphone) preflight\b/gi, "Prepare the session");
  return productProse(label, 0) ?? "Check this part of the product";
}

// Last-resort scrub: drop the sentences that name our machinery, cut the
// homework (CHE-191), keep the rest. Returns null when nothing survives — the
// caller then omits the text entirely rather than shipping a mangled
// half-sentence.
export function stripEnvironmentLeak(text: string | null | undefined): string | null {
  if (!text) return null;
  const kept = splitSentences(text).filter((s) => !leaksMachinery(s));
  const out = cutHomework(kept).sentences.join(" ").replace(/\s+/g, " ").trim();
  return out.length >= 20 ? out : null;
}

export function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/);
}

// Words that name our side, on top of the phrase gate above. Written for the
// judge (CHE-169) and shared since CHE-180: run #144 wrote "requires
// camera/mic access unavailable in our test environment" into Step.observed,
// which the phrase gate did not catch and which the customer read on the
// verdict page. One list, used by every producer of customer-facing prose
// (judge, step text, journey summary, the live progress note).
//
// CHE-197 added the walk's own tools: oEmbed is how verify_links resolves a
// YouTube link (run #154: "all playable via oEmbed"), and the tool names are
// the loop's vocabulary, never the product's.
export const MACHINERY_TERMS =
  /\b(browsers?|headless|environments?|models?|harness(es)?|playwright|screenshots?|checkers?|first reader|tooling|automation|agents?|test environment|our test|oembed|verify_links|read_page|report_step|write_e2e_test|record_created|record_deleted|get_network_log)\b/i;

// Product-facing prose: the walker's envelope unwrapped and the walker's
// first person cut at the clause (CHE-197, before the sentence gate so that
// "The product is a chat app; I tested the flow via oEmbed" keeps its
// product half), the CHE-82 phrase gate and the words above sentence by
// sentence, then the homework cut (CHE-191) — so a step, a journey summary
// or the judge's sentence ending in "worth checking …" loses that clause
// here, whichever producer wrote it. Null when nothing survives, so the
// caller falls back to a fixed product sentence rather than a mangled
// half-line.
//
// The floor (20 characters) applies only when something was actually
// dropped: a short step text that never mentioned us ("Clicked Sign in.") is
// intact and must stay as written — the floor exists to catch fragments left
// by the strip, not to reject brevity. A step label is a few words by design,
// so its caller sets the floor to 0.
export function productProse(text: string | null | undefined, floor = 20): string | null {
  if (!text) return null;
  const unwrapped = unwrapEnvelope(splitSentences(text));
  const voiced = cutNarration(unwrapped.sentences);
  const kept = voiced.sentences.filter((s) => !leaksMachinery(s) && !MACHINERY_TERMS.test(s));
  const cut = cutHomework(kept);
  const out = cut.sentences.join(" ").replace(/\s+/g, " ").trim();
  if (!out) return null;
  const untouched = !unwrapped.changed && !voiced.changed && kept.length === voiced.sentences.length && !cut.changed;
  if (untouched) return out;
  return out.length >= floor ? out : null;
}

// What is written when the model's own words did not survive the scrub. Used
// by the judge (CHE-169) and by report_step (CHE-180) alike, so the customer
// meets one sentence for one situation.
export const NOT_DEFECT_FALLBACK = "This step behaved as a user would expect; nothing failed.";
export const UNVERIFIABLE_FALLBACK = "We could not confirm this step this run.";
// A step reported as a problem whose every word was about us (CHE-180). The
// status still stands — classifyUnverified already turned a problem justified
// only by our inability into a skipped step, so what reaches here carries
// hard evidence the model phrased badly.
export const PROBLEM_FALLBACK = "This step did not behave as a user would expect.";

// The instruction block shared by every prompt that produces customer-facing
// prose, so the rule is written once.
export const CUSTOMER_LANGUAGE_RULES = `LANGUAGE OF EVERYTHING THE CUSTOMER READS (absolute):
- NEVER mention our machinery: our test browser, headless, Playwright, our
  agent's environment, request/mutation counts. The customer bought a verdict,
  not a tour of our infrastructure. How we check is our business.
- NEVER hand verification back: no "verify in a real browser", "spot-check this
  yourself", "confirm manually" — and no soft version of it either: "worth
  confirming …", "consider checking …", "you may want to verify …", "make sure
  X opens", "we recommend testing …". They pay us to do exactly that. If we
  could not verify something, the honest sentence is "we could not verify X
  this run" — a statement about our coverage, with no homework for them.
- An interaction that produced no effect for US, with no error and no failure
  evidence, is NOT a finding and NOT a problem. It is an unverified step. Say
  so as coverage ("we could not confirm X"), never as a defect, and never with
  an explanation of why our side struggled.
- Asking the owner for INPUTS we genuinely need (test credentials, a staging
  URL) is allowed and welcome — that is not verification work, that is access.`;
