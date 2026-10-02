// CHE-197 verification: a journey summary is a statement about the product,
// never the walker's diary.
//
// Two watch runs on 2026-09-06 stored, as Journey.summary, the model's
// wrap-up envelope ("Journey complete. No records were created; nothing to
// clean up. Summary: …") and its first-person walk narration ("During the
// walkthrough, I signed in with the test credentials …", "I tested the full
// query flow (… POST /api/chat …) … all playable via oEmbed"). CHE-180 made
// the summary a finished statement; nothing keyed on the walker's own voice.
// CLAUDE.md rule 1: the customer reads the product, our machinery is
// invisible.
//
// Pure: no browser, no network, no database. The four summaries are fed
// verbatim (D1, 2026-09-07) through the exact function the walk runs
// (productProse, and summarizeWalk with a scripted model); the negatives are
// the product's own words that must come back untouched.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-summary-voice.ts

import type Anthropic from "@anthropic-ai/sdk";
import type { LlmConfig } from "@/agent/llm";
import { emptyUsage } from "@/agent/llm";
import { SUMMARY_INSTRUCTION, summarizeWalk } from "@/agent/summary";
import {
  hasNarration,
  HOMEWORK_FALLBACK,
  JOURNEY_OK_FALLBACK,
  JOURNEY_PROBLEM_FALLBACK,
  MACHINERY_TERMS,
  narrationIn,
  productProse,
  stripNarration,
  summaryFallback,
  walkerIn,
} from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// No walker in it: no first person outside the product's own words, no
// envelope, no tool of ours, no word from the machinery list.
function productOnly(text: string | null): boolean {
  return !!text && !hasNarration(text) && !MACHINERY_TERMS.test(text) && !/\bI\b/.test(text);
}

// ─── The four summaries, verbatim (D1, runs #153 joblander.app and #154 meetbashar.com) ───
const RUN_153_J0 =
  "Journey complete. No records were created; nothing to clean up. Summary: The signup journey and sign-in path both work — the Create account form accepts name/email/password input (with a password-strength meter), and signing in with the provided test credentials auto-redirects to the /dashboard, which correctly loads Available Minutes (120), the user's Your Stories library, and the More practice a…";
const RUN_153_J0_AFTER =
  "The signup journey and sign-in path both work — the Create account form accepts name/email/password input (with a password-strength meter), and signing in with the provided test credentials auto-redirects to the /dashboard, which correctly loads Available Minutes (120), the user's Your Stories library, and the More practice a…";

const RUN_153_J2 =
  "JobLander is an AI interview coach that lets you practice mock interviews with AI avatars. During the walkthrough, I signed in with the test credentials, selected the Aria coach on /practice, and started a live call session that greeted me by name.";
const RUN_153_J2_AFTER = "JobLander is an AI interview coach that lets you practice mock interviews with AI avatars.";

const RUN_154_J1 =
  'Journey complete. I created no records, so nothing to clean up. Summary: The Meditations page header and homepage nav both advertise "13 practices," but the archive actually renders 12 practice cards across the seven categories (Frequencies 2, Mind 1, Dreams 2, Contact 2, Being 2, Gazing 2, Place & Nature 1) — a minor content mismatch, not a functional break.';
const RUN_154_J1_AFTER =
  'The Meditations page header and homepage nav both advertise "13 practices," but the archive actually renders 12 practice cards across the seven categories (Frequencies 2, Mind 1, Dreams 2, Contact 2, Being 2, Gazing 2, Place & Nature 1) — a minor content mismatch, not a functional break.';

const RUN_154_J4 =
  "The product is a Bashar teachings chat/archive app where you ask questions and it generates sourced answers from his talks; I tested the full query flow (Free mode toggle, question submit → POST /api/chat answer) and verified 48 YouTube links across the Transmissions, Meditations, and Learn pages — none broken, all playable via oEmbed, with no embedded video players (videos are linked out to YouTu…";
const RUN_154_J4_AFTER =
  "The product is a Bashar teachings chat/archive app where you ask questions and it generates sourced answers from his talks.";

const TICKET: Array<[string, string, string]> = [
  ["#153 J0 (envelope)", RUN_153_J0, RUN_153_J0_AFTER],
  ["#153 J2 (first person)", RUN_153_J2, RUN_153_J2_AFTER],
  ["#154 J1 (envelope)", RUN_154_J1, RUN_154_J1_AFTER],
  ["#154 J4 (first person + tools)", RUN_154_J4, RUN_154_J4_AFTER],
];

// ─── The envelope, in every shape stored so far ───────────────────────────────
const PRODUCT = "The login works and the dashboard loads.";
const ENVELOPES = [
  `Journey complete. Summary: ${PRODUCT}`,
  `Journey complete! ✅ Summary: ${PRODUCT}`,
  `Journey Complete - Summary: ${PRODUCT}`,
  `Journey complete: ${PRODUCT}`,
  `Journey completed successfully. ${PRODUCT}`,
  `Journey walked. Summary: ${PRODUCT}`,
  `The journey is complete. Here's a summary of what I found: Summary: ${PRODUCT}`,
  `The full journey is complete. Here's the summary: ${PRODUCT}`,
  `The journey is complete. Let me provide a summary of findings: Summary: ${PRODUCT}`,
  `Journey Summary: ${PRODUCT}`,
  `Journey summary — ${PRODUCT}`,
  `Journey complete — summary: ${PRODUCT}`,
  `Summary of findings: ${PRODUCT}`,
  `Summary of what I found: ${PRODUCT}`,
  `Here's what I found: ${PRODUCT}`,
  `What I found: ${PRODUCT}`,
  `In summary: ${PRODUCT}`,
  `Key findings: - ${PRODUCT}`,
  `Perfect! ${PRODUCT}`,
  `I've completed the journey and written the e2e test. Here's my summary: ${PRODUCT}`,
  `I walked the sign-in journey end to end. ${PRODUCT}`,
  `No records were created; nothing to clean up. ${PRODUCT}`,
  `No records were created, so nothing needs cleanup. ${PRODUCT}`,
  `I created no records, so nothing to clean up. Summary: ${PRODUCT}`,
  `I did not create any records, so nothing to clean up. ${PRODUCT}`,
  `This was a read-only run — I did not create any records, so no cleanup is needed. ${PRODUCT}`,
  `Journey complete — "Read the About / pricing overview". Summary of findings: ${PRODUCT}`,
  `Journey complete. No records were created, so nothing to clean up. Summary: ${PRODUCT}`,
];
// The envelope with nothing inside it.
const ENVELOPE_ONLY = [
  "Journey complete.",
  "The full journey is complete.",
  "Journey complete. No records were created; nothing to clean up.",
  'The journey is complete. I did not create any records (I stopped at the "Start call" button without pressing it, per the read-only run), so there is nothing to clean up.',
  "Now let me report each step of the journey:",
  "Let me try the Reset to Defaults button",
];
// Statements that happen to say "journey" or "complete" and stay as written.
const NOT_ENVELOPE = [
  "Journey completed with partial verification.",
  'The "Read the Landing Page" journey completed successfully with all steps working as expected.',
  "The login journey completed successfully — all steps passed.",
  "All 4 steps completed successfully with no issues.",
  "Submitting the form succeeded but no records were created in the admin list.",
];

// ─── The first person, cut at the clause ──────────────────────────────────────
const NARRATION: Array<[string, string | null]> = [
  ["The dashboard lists every project. I signed in with the test credentials and clicked around.", "The dashboard lists every project."],
  [
    "The gate works: a wrong password redirects to /login?errore=1; I couldn't gain access because the real password wasn't provided.",
    "The gate works: a wrong password redirects to /login?errore=1.",
  ],
  ["During the walkthrough, I signed in and selected the Aria coach.", null],
  ["During the walkthrough, the coach greeted the visitor by name.", "The coach greeted the visitor by name."],
  ["The five share buttons encode the article URL — though I did not click them.", "The five share buttons encode the article URL."],
  ["Per the no-wandering rule on third-party sites, I stayed on the landing page.", null],
  ["From the example.com home page, I located and clicked the link.", null],
  ["The form accepted my input but the auth endpoint rejected the credentials.", null],
  ["The live call session greeted me by name.", null],
  ["My first attempt at the form failed.", null],
  ["I'm not logged in, so the dashboard is gated.", null],
  ["Zero network requests — let me retry the click once:", "Zero network requests."],
  ["The tutorials hub and the two guides I walked load correctly.", null],
  ["The settings form is filled with my data and the Save button is enabled.", null],
];

// ─── The product's own words, untouched ──────────────────────────────────────
const PRODUCT_VOICE = [
  // quoted copy
  'Typed "Tell me about yourself" into the interview question field.',
  "The 'Show me my app' button became enabled.",
  "The greeting reads 'Hi Vladislav, I'm Gabriel. Ready to jump in?'",
  "The hero says \"Ask, and I will answer — in any language you speak.\"",
  "The 'My favourite top 10' section is present above the roles list.",
  "Clicked 'My own question' in the Create Story modal.",
  "The blog index lists 'My first post' as a link.",
  // a reported label
  "The placeholder reads Tell me about yourself.",
  "The page says, tell me what's broken.",
  // a label-shaped phrase, unquoted
  "Fill URL field and confirm Show me my app enables",
  "Verify Show me my app button enables after URL entry",
  "Users see a Remember me checkbox under the password field.",
  "The nav lists Learn, My Stories and Settings.",
  "Navigate to My account / payment plan login page",
  "The tutorial index goes live insights → mirror mode → my stories → safe practice.",
  "The categories are Being (I AM, Two Images) and Gazing (The Holotope).",
  "All three sections on the About page (Currently Reading, Music is life, I run sometimes) fail to load.",
  // a question the page asks
  "Click FAQ: How do I transfer to another registrar?",
  "The FAQ answers How do I keep my personal information private?",
  // a path, not a person
  "The Up next link points to /tutorials/my-stories.",
  // the house voice
  "We could not confirm the VK share dialog this run.",
  "We confirmed the link resolves.",
  "Users must confirm their email before posting; the confirmation arrived in four seconds.",
  // run #62 as published (the one ask we may make, CLAUDE.md rule 2)
  "Note this may be an invalid test account rather than a defect in the endpoint; please confirm the credentials are active, or supply working ones so we can verify the flow end to end.",
  // no first person at all
  "Sign-in works; the dashboard opens with the account name shown.",
  "The Meditations page lists 13 practices across 7 categories.",
];

// ─── Our tools, named ─────────────────────────────────────────────────────────
const TOOLS: Array<[string, string | null]> = [
  [
    "All 21 YouTube video links on the meditations page are verified working — every one returns HTTP 200 via the YouTube oEmbed API with no private videos found.",
    "All 21 YouTube video links on the meditations page are verified working — every one returns HTTP 200 with no private videos found.",
  ],
  [
    "All 4 unique YouTube video links verified as existing and playable (OK via oEmbed API), and the Keep exploring links work.",
    "All 4 unique YouTube video links verified as existing and playable, and the Keep exploring links work.",
  ],
  [
    "Every one of the 21 links is valid and playable (all return HTTP 200 via YouTube oEmbed API).",
    "Every one of the 21 links is valid and playable.",
  ],
  [
    "All 38 checked links are confirmed working — every YouTube video link returns a valid oEmbed response proving the video is playable.",
    "All 38 checked links are confirmed working.",
  ],
  ["The link check ran through verify_links and every link resolved.", null],
];

// ─── Our click, speaking (CHE-392) ────────────────────────────────────────────
// Since CHE-392 a click tells the model what text became visible after it, and
// the model began to say where it had heard that. Run cmuqei9b… on our own
// site, 2026-10-02, the first run after that change, published the first
// sentence below in a step's `observed`. The clause goes; what the product did
// stays.
const CLICK_VOICE: Array<[string, string | null]> = [
  [
    "The disclosure expanded and revealed Test email, Test password, a free-text notes box and a 'Where to email the result?' field; the click reported the newly visible text.",
    "The disclosure expanded and revealed Test email, Test password, a free-text notes box and a 'Where to email the result?' field.",
  ],
  [
    "The button's label changed to \"copied ✓\" for a moment, as the click's result listed.",
    "The button's label changed to \"copied ✓\" for a moment.",
  ],
  [
    "The label switched to 'Saved' — the click itself returned that text, and it was gone by the next read.",
    "The label switched to 'Saved'.",
  ],
  ["The click reported the text 'Saved'.", null],
];
// The product's own clicks are not ours.
const CLICK_PRODUCT = [
  "Clicking 'copy' changes the button's label to 'copied ✓' for about a second.",
  "The click-through report lists 12 campaigns and the click count updates on refresh.",
  "A click on the row opens the detail panel, which showed the order's status.",
  "The dashboard's 'Next read' badge shows the article queued after this one.",
];

// A scripted model: any call is the summary call (finalizeJson sends no
// tools); counts them and answers `reply`.
function scriptedLlm(reply: string) {
  let calls = 0;
  let lastInstruction = "";
  const create = async (params: { messages: Anthropic.MessageParam[] }): Promise<Anthropic.Message> => {
    calls += 1;
    const last = params.messages[params.messages.length - 1];
    const blocks = Array.isArray(last?.content) ? last.content : [];
    const tail = blocks[blocks.length - 1];
    lastInstruction = tail && tail.type === "text" ? tail.text : typeof last?.content === "string" ? last.content : "";
    return {
      id: "m",
      type: "message",
      role: "assistant",
      model: "scripted",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
      content: [{ type: "text", text: reply, citations: null }],
    } as Anthropic.Message;
  };
  const client = { messages: { create } } as unknown as Anthropic;
  const llm: LlmConfig = {
    navClient: client,
    synthClient: client,
    structClient: client,
    navModel: "scripted",
    synthModel: "scripted",
    structModel: "scripted",
    navVision: false,
  };
  return { llm, calls: () => calls, lastInstruction: () => lastInstruction };
}

async function walk(finalText: string, reply: string, endedBy: "model" | "cap" = "model", status?: string) {
  const model = scriptedLlm(reply);
  const summary = await summarizeWalk(model.llm, { finalText, messages: [], endedBy }, emptyUsage(), status);
  return { summary, calls: model.calls(), instruction: model.lastInstruction() };
}

async function main() {
  // 1 — the four summaries, through the function the walk runs.
  for (const [name, before, after] of TICKET) {
    check(`${name}: hasNarration sees it`, hasNarration(before));
    const out = productProse(before);
    check(`${name}: productProse → the product sentence, exactly`, out === after, out ?? "(null)");
    check(`${name}: nothing of the walker survives`, productOnly(out), out ?? "(null)");
    check(`${name}: narrationIn names the offending sentence(s)`, narrationIn(before).length > 0);
  }
  // … and through summarizeWalk, with the model never asked: the closing
  // text is a finished statement once the envelope is off.
  for (const [name, before, after] of TICKET) {
    const { summary, calls } = await walk(before, "should not be asked");
    check(`${name}: summarizeWalk writes the product sentence without a second call`, summary === after && calls === 0, `${calls} call(s): ${summary}`);
  }

  // 2 — the envelope in every stored shape: what is inside it is what remains.
  for (const s of ENVELOPES) {
    const out = stripNarration(s);
    check(`envelope: ${JSON.stringify(s)}`, out === PRODUCT, out);
    check(`  … productProse agrees`, productProse(s) === PRODUCT, productProse(s) ?? "(null)");
  }
  for (const s of ENVELOPE_ONLY) {
    check(`envelope only: ${JSON.stringify(s)} → nothing (the caller's fallback stands in)`, stripNarration(s, "") === "", stripNarration(s, ""));
    check(`  … hasNarration sees it`, hasNarration(s));
  }
  for (const s of NOT_ENVELOPE) {
    check(`not an envelope: ${JSON.stringify(s)}`, stripNarration(s) === s && !hasNarration(s), stripNarration(s));
  }

  // 3 — the first person: the clause goes, the product statement stays.
  for (const [s, after] of NARRATION) {
    const out = stripNarration(s, "");
    check(`first person: ${JSON.stringify(s)}`, out === (after ?? ""), out);
    check(`  … hasNarration sees it`, hasNarration(s));
    check(`  … productProse agrees`, productProse(s) === after, productProse(s) ?? "(null)");
  }
  check("walkerIn: the walker's pronoun, by index", walkerIn("The dashboard lists every project; I signed in.") === 35);
  check("walkerIn: the tool's name, by index", walkerIn("The links resolved via verify_links.") === 23);
  check("walkerIn: nothing in a product sentence", walkerIn("The 'Show me my app' button became enabled.") === null);

  // 4 — the product's own "I", "me", "my": untouched, by stripNarration and by productProse.
  for (const s of PRODUCT_VOICE) {
    check(`product voice: ${JSON.stringify(s)}`, stripNarration(s) === s && !hasNarration(s), stripNarration(s));
    check(`  … productProse returns it unchanged`, productProse(s, 0) === s, productProse(s, 0) ?? "(null)");
  }

  // 5 — our tools by name: the tag on a product statement is scrubbed, a
  // clause about the tool is cut, a sentence that was only the tool goes.
  for (const [s, after] of TOOLS) {
    const out = stripNarration(s, "");
    check(`tools: ${JSON.stringify(s)}`, out === (after ?? ""), out);
    check(`  … no tool named in what remains`, !MACHINERY_TERMS.test(out), out);
  }

  // 5b — our click, speaking: the clause it speaks in is cut, the product's
  // half of the sentence stays; the product's own "click" is untouched.
  for (const [s, after] of CLICK_VOICE) {
    const out = productProse(s);
    check(`click voice: ${JSON.stringify(s)}`, out === after, out ?? "(null)");
    check(`  … hasNarration sees it`, hasNarration(s));
  }
  for (const s of CLICK_PRODUCT) {
    check(`the product's click: ${JSON.stringify(s)}`, productProse(s, 0) === s && !hasNarration(s), productProse(s, 0) ?? "(null)");
  }

  // 6 — summarizeWalk: the envelope alone is not a summary, so the walk asks
  // once more, exactly as it does for a plan; the reply is unwrapped too.
  {
    const r = await walk("Journey complete. No records were created; nothing to clean up.", "Summary: The signup form accepts input and the dashboard loads.");
    check("envelope-only closing text: one summary call", r.calls === 1 && r.instruction === SUMMARY_INSTRUCTION, `${r.calls} call(s)`);
    check("envelope-only closing text: the reply, unwrapped, is the summary", r.summary === "The signup form accepts input and the dashboard loads.", String(r.summary));
  }
  {
    const r = await walk("", "Journey complete. Summary: The login works and the dashboard loads.", "cap");
    check("cap: the reply is unwrapped", r.summary === "The login works and the dashboard loads." && r.calls === 1, String(r.summary));
  }
  {
    const r = await walk("The settings page saves changes.", "should not be asked");
    check("a finished product statement: written as is, no call", r.summary === "The settings page saves changes." && r.calls === 0, String(r.summary));
  }
  {
    const r = await walk("Let me try the Reset button", "Let me check the remaining controls…");
    check("a plan, then a plan again: no summary (CHE-180 unchanged)", r.summary === null && r.calls === 1, String(r.summary));
  }
  // A finished reply with nothing left once the walker's words are gone is
  // not a plan: the journey's fixed sentence stands in, never an empty summary.
  for (const [status, expected] of [
    ["ok", JOURNEY_OK_FALLBACK],
    ["partial", HOMEWORK_FALLBACK],
    ["skipped", HOMEWORK_FALLBACK],
    ["broken", JOURNEY_PROBLEM_FALLBACK],
    ["confusing", JOURNEY_PROBLEM_FALLBACK],
    [undefined, HOMEWORK_FALLBACK],
  ] as Array<[string | undefined, string]>) {
    const r = await walk("", "I signed in with the test credentials and clicked around the dashboard.", "cap", status);
    check(`reply all narration, status ${status ?? "unknown"}: the fixed sentence`, r.summary === expected, String(r.summary));
    check(`  … summaryFallback agrees`, summaryFallback(status) === expected);
  }
  {
    const r = await walk("The dashboard greeted me by name.", "The dashboard shows the account name after sign-in.");
    check("closing text all narration: asked once more, the reply is the summary", r.summary === "The dashboard shows the account name after sign-in." && r.calls === 1, `${r.calls}: ${r.summary}`);
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main();
