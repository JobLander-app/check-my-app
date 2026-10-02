// CHE-180 verification: step text and journey summaries describe the product
// only, and a walk the cap cut still gets a real summary.
//
// Two checker defects from production run #144:
//   1. Step.observed: "the 'Start Video' button resolves as 'element is not
//      visible' — it requires camera/mic access unavailable in our test
//      environment". verdict-language.ts guarded findings and the bottom line
//      (synthesis.ts) but not the step text the customer expands on the
//      verdict page. CLAUDE.md rule 1 calls this a hard failure.
//   2. Journey.summary: "Let me try the Reset to Defaults button". The walking
//      cap (CHE-134) ended the loop mid-action and the model's last thought
//      was written as "What we found".
//
// Pure: no browser, no network, no model. report_step runs through the real
// executeTool with a stub env whose onReportStep mirrors execution.ts — the
// real adjudicateStep with a scripted judge, then productizeStep, then the
// "row" — so the order is proven: the judge reads the model's words, the
// customer reads the product's. A scripted model drives runAgentLoop and
// summarizeWalk — the functions the walk itself calls — and counts its calls.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-step-language.ts

import type Anthropic from "@anthropic-ai/sdk";
import { runAgentLoop } from "@/agent/core";
import { adjudicateStep } from "@/agent/judge";
import type { LlmConfig } from "@/agent/llm";
import { emptyUsage } from "@/agent/llm";
import {
  cleanSummary,
  INTENT_OPENERS,
  looksLikeIntent,
  SUMMARY_INSTRUCTION,
  summarizeWalk,
} from "@/agent/summary";
import { executeTool, productizeStep, type ReportedStep, type ToolEnv } from "@/agent/tools";
import {
  hasEnvironmentLeak,
  MACHINERY_TERMS,
  NOT_DEFECT_FALLBACK,
  PROBLEM_FALLBACK,
  productProse,
  UNVERIFIABLE_FALLBACK,
} from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// No word from the list and no CHE-82 phrase: what "product only" means here.
function clean(text: string | null | undefined): boolean {
  return !!text && !MACHINERY_TERMS.test(text) && !hasEnvironmentLeak(text);
}

// A judge that answers "defect" to whatever it is shown and records the brief
// it was shown, so the test can read what the judge read.
function scriptedJudge() {
  const briefs: string[] = [];
  const create = async (params: { messages: Anthropic.MessageParam[] }): Promise<Anthropic.Message> => {
    const content = params.messages[0]?.content;
    const text = Array.isArray(content)
      ? content.map((b) => (b.type === "text" ? b.text : "")).join("\n")
      : String(content ?? "");
    briefs.push(text);
    return {
      id: "judge",
      type: "message",
      role: "assistant",
      model: "scripted-judge",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
      content: [{ type: "text", text: JSON.stringify({ verdict: "defect", reason: "as reported", userImpact: "as reported" }), citations: null }],
    } as Anthropic.Message;
  };
  const client = { messages: { create } } as unknown as Anthropic;
  const llm: LlmConfig = {
    navClient: client,
    synthClient: client,
    structClient: client,
    navModel: "scripted-judge",
    synthModel: "scripted-judge",
    structModel: "scripted-judge",
    navVision: false,
  };
  return { llm, briefs };
}

// Enough of a page for read_page, plus a report hook that does what
// execution.ts's onReportStep does, in the same order: judge → productize →
// row. `raw` is the step as executeTool handed it over; `written` is the row.
function stubEnv() {
  const raw: ReportedStep[] = [];
  const written: ReportedStep[] = [];
  const judge = scriptedJudge();
  const env = {
    page: {
      url: () => "https://target.test/",
      evaluate: async () => ({
        url: "https://target.test/",
        title: "Target",
        headings: ["h1: Target"],
        links: [],
        buttons: [],
        fields: [],
      }),
    },
    targetOrigin: "https://target.test",
    visionScreenshots: false,
    networkLog: [],
    consoleLog: [],
    credentials: { rejected: false },
    onReportStep: async (reported: ReportedStep) => {
      raw.push({ ...reported });
      const step = await adjudicateStep({
        llm: judge.llm,
        enabled: true,
        step: reported,
        page: null,
        networkLog: [],
        scrub: (s) => s,
        usage: emptyUsage(),
      });
      productizeStep(step);
      written.push({ ...step });
    },
  } as unknown as ToolEnv;
  return { env, raw, written, judgeBriefs: judge.briefs };
}

async function report(input: Record<string, unknown>) {
  const stub = stubEnv();
  await executeTool(stub.env, "report_step", input);
  if (stub.written.length !== 1) throw new Error(`report_step wrote ${stub.written.length} steps`);
  return { step: stub.written[0], raw: stub.raw[0], judgeBriefs: stub.judgeBriefs };
}

// A scripted model: `toolTurns` turns of read_page, then `finalText` with no
// tool call. A call made without tools is the summary call (finalizeJson
// sends none) and gets `summaryReply`. Counts every call.
function scriptedLlm(opts: { toolTurns: number; finalText: string; summaryReply: string }) {
  let calls = 0;
  let summaryCalls = 0;
  let lastSummaryInstruction = "";
  const message = (content: Anthropic.ContentBlock[], stop: Anthropic.Message["stop_reason"]): Anthropic.Message =>
    ({
      id: `msg_${calls}`,
      type: "message",
      role: "assistant",
      model: "scripted",
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
      content,
    }) as Anthropic.Message;
  const create = async (params: { messages: Anthropic.MessageParam[]; tools?: unknown }): Promise<Anthropic.Message> => {
    calls += 1;
    if (!params.tools) {
      summaryCalls += 1;
      const last = params.messages[params.messages.length - 1];
      const blocks = Array.isArray(last?.content) ? last.content : [];
      const tail = blocks[blocks.length - 1];
      lastSummaryInstruction = tail && tail.type === "text" ? tail.text : "";
      return message([{ type: "text", text: opts.summaryReply, citations: null }], "end_turn");
    }
    if (calls <= opts.toolTurns) {
      return message([{ type: "tool_use", id: `tu_${calls}`, name: "read_page", input: {} }], "tool_use");
    }
    return message([{ type: "text", text: opts.finalText, citations: null }], "end_turn");
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
  return {
    llm,
    calls: () => calls,
    summaryCalls: () => summaryCalls,
    lastSummaryInstruction: () => lastSummaryInstruction,
  };
}

async function walk(model: ReturnType<typeof scriptedLlm>, maxIterations: number) {
  const stub = stubEnv();
  const result = await runAgentLoop({
    system: "test",
    task: "walk",
    env: stub.env,
    llm: model.llm,
    thinking: "off",
    maxIterations,
  });
  const usage = emptyUsage();
  const summary = await summarizeWalk(model.llm, result, usage);
  return { result, summary, usage };
}

const RUN_144_OBSERVED =
  "The coaching page loaded with the session controls and the transcript panel visible. " +
  "The 'Start Video' button resolves as 'element is not visible' — it requires camera/mic access unavailable in our test environment.";

async function main() {
  // ── (a) the row is product prose; classification and the judge see the model's words ──
  {
    const { step: s, raw } = await report({
      label: "Begin live coaching session",
      status: "confusing",
      attempted: "Clicked Start Video to begin the session.",
      observed: RUN_144_OBSERVED,
    });
    check("run #144 step: executeTool hands the step over with the model's words intact",
      raw.observed === RUN_144_OBSERVED, raw.observed);
    check("run #144 step: classified our_capability BEFORE the strip (camera phrase still read)",
      s.status === "skipped" && s.unverifiedReason === "our_capability", `${s.status}/${s.unverifiedReason}`);
    check("run #144 step: the machinery sentence is gone, the product sentence stays",
      s.observed === "The coaching page loaded with the session controls and the transcript panel visible.", s.observed);
    check("run #144 step: no word from the list in observed", clean(s.observed), s.observed);
    check("run #144 step: attempted untouched when it never mentioned us",
      s.attempted === "Clicked Start Video to begin the session.", s.attempted);
    check("run #144 step: label untouched", s.label === "Begin live coaching session", s.label);
  }
  {
    const { step: s } = await report({
      label: "Join the video call",
      status: "skipped",
      unverifiedReason: "our_capability",
      attempted: "Tried to join the call.",
      observed: "Camera and microphone access is unavailable in our test environment.",
    });
    check("skipped step, observed all machinery: fixed coverage sentence", s.observed === UNVERIFIABLE_FALLBACK, s.observed);
    check("skipped step: unverifiedReason kept", s.unverifiedReason === "our_capability" && s.status === "skipped");
  }
  {
    const { step: s } = await report({
      label: "Open the export menu",
      status: "broken",
      attempted: "Clicked Export.",
      observed: "The button did nothing in our test browser.",
    });
    check("'our test browser' step: STILL classified our_capability (classification unaffected)",
      s.status === "skipped" && s.unverifiedReason === "our_capability", `${s.status}/${s.unverifiedReason}`);
    check("'our test browser' step: written without the word browser", s.observed === UNVERIFIABLE_FALLBACK && clean(s.observed), s.observed);
  }
  {
    const { step: s } = await report({
      label: "Save the profile",
      status: "ok",
      attempted: "Our headless browser filled the name field and clicked Save.",
      observed: "The harness saw the page update.",
    });
    check("ok step, attempted all machinery: falls back to the label", s.attempted === "Save the profile", s.attempted);
    check("ok step, observed all machinery: fixed product sentence", s.observed === NOT_DEFECT_FALLBACK, s.observed);
    check("ok step: status and reason untouched", s.status === "ok" && s.unverifiedReason === undefined);
  }
  {
    // Hard evidence keeps the step broken (classifyUnverified), so the judge
    // is called and must read the model's words; the sentence names our
    // side, so the row gets the clause cut rather than the evidence lost.
    const { step: s, judgeBriefs } = await report({
      label: "Start a session",
      status: "broken",
      attempted: "Clicked Start session.",
      observed: "POST /api/session returned 500 — our browser then showed a blank page.",
    });
    check("broken step: the judge was called once and read the raw text (\"our browser\")",
      judgeBriefs.length === 1 && judgeBriefs[0].includes("our browser then showed a blank page"), judgeBriefs[0]?.slice(0, 120));
    check("broken step with a 500 stays broken", s.status === "broken", s.status);
    check("broken step: first sentence kept with the machinery clause cut",
      s.observed === "POST /api/session returned 500.", s.observed);
    check("broken step: no word from the list", clean(s.observed), s.observed);
  }
  {
    const { step: s } = await report({
      label: "Open the report",
      status: "broken",
      attempted: "Clicked Open report.",
      observed: "Our browser got a 500 from the report endpoint.",
    });
    check("broken step with nothing but machinery: the problem sentence, status kept",
      s.status === "broken" && s.observed === PROBLEM_FALLBACK, `${s.status}: ${s.observed}`);
  }
  {
    const { step: s } = await report({
      label: "Sign in",
      status: "ok",
      attempted: "Clicked Sign in.",
      observed: "The dashboard opened with the account name shown.",
    });
    check("a clean short step is written exactly as reported (no length floor when nothing was dropped)",
      s.attempted === "Clicked Sign in." && s.observed === "The dashboard opened with the account name shown.");
  }
  {
    const s: ReportedStep = {
      label: "Upload a file. Done in our test browser.",
      status: "ok",
      attempted: "Chose a file and clicked Upload.",
      observed: "The file appeared in the list.",
    };
    productizeStep(s);
    check("label goes through the same strip", s.label === "Upload a file.", s.label);
  }
  check("productProse: one list — the judge's cases still hold",
    productProse("The checkout completed and the receipt page showed the order number. Our headless browser then lost the session.") ===
      "The checkout completed and the receipt page showed the order number." &&
      productProse("Our headless browser environment failed.") === null);
  check("productProse: 'agent' and 'test environment' are dropped",
    productProse("The pricing page lists three plans with prices. The agent could not click in the test environment.") ===
      "The pricing page lists three plans with prices.");

  // ── CHE-396: the product's own vocabulary ──
  // The word list was bare nouns — browser, environment, model, agent,
  // screenshot, automation, checker — and any sentence holding one was dropped.
  // Run cmuqfizeu… (our own guide page, 2026-10-02) showed five steps named
  // "Check this part of the product" and a journey called "A journey": the
  // product is about connecting an agent. The nouns are the product's in a
  // large share of apps; they are ours only when the sentence says so.
  const PRODUCT_VOCABULARY = [
    // the six from the ticket
    "Connect a coding agent for automated checks",
    "Open the Connect-your-agent guide",
    "Follow the Connect-Your-Agent guide and copy the integration snippets",
    "Choose a model for the assistant",
    "Install the browser extension",
    "Switch the environment to staging",
    // a store-protection app (CHE-333): its features are named in these words
    "Block visitors by browser and device",
    "Bot and automation protection is enabled for the storefront.",
    "The Blocked browsers list shows Chrome 90 and older.",
    // an AI product: its agent and its models are the product
    "The agent replied with a tracking link and offered a human handoff.",
    "The agent could not answer the billing question and showed 'Something went wrong'.",
    "The Models page lists 12 models with their context sizes.",
    "The model failed to load and the page showed 'Out of memory'.",
    // screenshots, environments, checkers and automation as features
    "Upload a screenshot of the receipt",
    "The Screenshots tab shows three uploaded screenshots.",
    "The environment switcher shows Production and Staging.",
    "The Environments page lists two environments with their variables.",
    "The spell checker underlined two words in the draft.",
    "The Automation rules page lists four rules, all enabled.",
    "Developer tooling is listed under Integrations.",
    // the counterparts of round 1's our-side cases (Codex on #246): the same
    // words, the product's
    "The page says \"This browser is not supported\" on the sign-in screen.",
    "Promote this environment to production from the Deployments page.",
    "The agent could not find your order and suggested contacting support.",
    "The screenshot did not upload and the form showed 'File too large'.",
  ];
  for (const s of PRODUCT_VOCABULARY) {
    check(`product vocabulary survives: ${JSON.stringify(s)}`, productProse(s, 0) === s && !MACHINERY_TERMS.test(s), productProse(s, 0) ?? "(null)");
  }
  // …and the sentences the list was written for still go, whole.
  const OUR_SIDE = [
    "It requires camera/mic access unavailable in our test environment.",
    "The button did nothing in our test browser.",
    "Our headless browser filled the name field and clicked Save.",
    "The harness saw the page update.",
    "Our browser got a 500 from the report endpoint.",
    "The agent could not click the Save button.",
    "The agent was unable to interact with the date picker.",
    "The agent clicked Continue and waited.",
    "Our agent signed in with the test account.",
    "The model decided to skip the optional fields.",
    "The navigation model chose the first result.",
    "The screenshot shows the dashboard with three charts.",
    "As seen in the screenshot, the banner overlaps the menu.",
    "A screenshot was taken after the click.",
    "The camera is unavailable in this environment.",
    "Clicking did nothing in this browser.",
    "The checker could not reach the settings page.",
    "The automation could not complete the card form.",
    "The browser could not play the embedded video.",
    "The browser did not grant camera access.",
    // round 1 of Codex on #246: each of these walked through the first version
    "This environment blocked camera access.",
    "This browser timed out before the page finished loading.",
    "The agent could not find the Save button.",
    "The checker could not locate the checkout button.",
    "The screenshot did not show the modal after Save was clicked.",
    "The screenshot failed to capture the open menu.",
    "Verified with Playwright against the live site.",
    "The first reader flagged the price as inconsistent.",
  ];
  for (const s of OUR_SIDE) {
    check(`our side still goes: ${JSON.stringify(s)}`, productProse(s) === null, productProse(s) ?? "(null)");
  }
  check(
    "a product label survives report_step as written",
    (() => {
      const s: ReportedStep = { label: "Connect a coding agent for automated checks", status: "ok", attempted: "Opened the Connect-your-agent guide.", observed: "The guide lists three steps and two code snippets." };
      productizeStep(s);
      return s.label === "Connect a coding agent for automated checks" && s.attempted === "Opened the Connect-your-agent guide.";
    })(),
  );

  // The live progress note carries the stripped label.
  {
    const notes: string[] = [];
    let call = 0;
    const create = async (): Promise<Anthropic.Message> => {
      call += 1;
      const content: Anthropic.ContentBlock[] =
        call === 1
          ? [{ type: "tool_use", id: "tu_1", name: "report_step", input: { label: "Sign in. Done in our test browser.", status: "ok", attempted: "Signed in.", observed: "The dashboard opened." } }]
          : [{ type: "text", text: "Sign-in works; the dashboard opens.", citations: null }];
      return { id: "m", type: "message", role: "assistant", model: "s", stop_reason: call === 1 ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content } as Anthropic.Message;
    };
    const client = { messages: { create } } as unknown as Anthropic;
    const llm: LlmConfig = { navClient: client, synthClient: client, structClient: client, navModel: "s", synthModel: "s", structModel: "s", navVision: false };
    await runAgentLoop({ system: "t", task: "walk", env: stubEnv().env, llm, thinking: "off", onProgress: async (n) => { notes.push(n); } });
    check("onProgress note: the label is product prose", notes.length === 1 && notes[0] === "ok: Sign in.", JSON.stringify(notes));
  }

  // ── (b) the summary: endedBy and the one extra call ──
  {
    const model = scriptedLlm({
      toolTurns: 100,
      finalText: "never reached",
      summaryReply: "Insight preferences can be changed and saved; the Reset to Defaults button restores the original values.",
    });
    const { result, summary, usage } = await walk(model, 3);
    check("cap: endedBy is 'cap' when the loop ran out while the model still called tools",
      result.endedBy === "cap" && result.iterations === 3, `${result.endedBy}/${result.iterations}`);
    check("cap: exactly one extra summary call", model.summaryCalls() === 1 && model.calls() === 4, `${model.calls()} calls`);
    check("cap: the summary call carries the instruction", model.lastSummaryInstruction() === SUMMARY_INSTRUCTION);
    check("cap: the summary is the reply, as product prose",
      summary === "Insight preferences can be changed and saved; the Reset to Defaults button restores the original values.", String(summary));
    check("cap: the summary call is billed to the walk's usage", usage.iterations === 1 && usage.outputTokens === 1, JSON.stringify(usage));
  }
  {
    const model = scriptedLlm({
      toolTurns: 2,
      finalText: "Let me try the Reset button",
      summaryReply: "The settings page saves changed preferences and shows them again after a reload.",
    });
    const { result, summary } = await walk(model, 10);
    check("intent: endedBy is 'model' when the model stopped on its own", result.endedBy === "model" && result.iterations === 3);
    check("intent: 'Let me try the Reset button' triggers the summary call", model.summaryCalls() === 1, `${model.summaryCalls()}`);
    check("intent: the reply becomes the summary",
      summary === "The settings page saves changed preferences and shows them again after a reload.", String(summary));
  }
  {
    const model = scriptedLlm({
      toolTurns: 2,
      finalText: "Sign-in works; the dashboard loads with the user's name.",
      summaryReply: "should not be asked",
    });
    const { result, summary } = await walk(model, 10);
    check("finished statement: no extra call", model.summaryCalls() === 0 && model.calls() === 3, `${model.calls()} calls`);
    check("finished statement: written as the summary",
      result.endedBy === "model" && summary === "Sign-in works; the dashboard loads with the user's name.", String(summary));
  }
  {
    const model = scriptedLlm({ toolTurns: 100, finalText: "", summaryReply: "Let me check the remaining controls…" });
    const { summary } = await walk(model, 2);
    check("summary reply that is still a plan → null", summary === null && model.summaryCalls() === 1, String(summary));
  }
  {
    const model = scriptedLlm({ toolTurns: 100, finalText: "", summaryReply: "" });
    const { summary } = await walk(model, 2);
    check("empty summary reply → null", summary === null, String(summary));
  }
  {
    const model = scriptedLlm({
      toolTurns: 100,
      finalText: "",
      summaryReply: "The checkout page lists the plan and the price before payment. Our headless browser could not complete the card form.",
    });
    const { summary } = await walk(model, 2);
    check("summary reply goes through productProse",
      summary === "The checkout page lists the plan and the price before payment.", String(summary));
  }
  {
    const model = scriptedLlm({
      toolTurns: 2,
      finalText: "## Summary\n\n**Sign in** works. The dashboard shows the user's projects.\n\n| step | status |\n|---|---|\n| Sign in | ok |",
      summaryReply: "should not be asked",
    });
    const { summary } = await walk(model, 10);
    check("cleanSummary keeps its behaviour: markdown stripped, no extra call",
      summary === "Sign in works. The dashboard shows the user's projects." && model.summaryCalls() === 0, String(summary));
  }
  check("cleanSummary: 'Summary:' lead-in dropped", cleanSummary("Summary: The login works.") === "The login works.");

  // ── (c) looksLikeIntent ──
  for (const opener of INTENT_OPENERS) {
    check(`looksLikeIntent: "${opener} …" is intent`, looksLikeIntent(`${opener} open the settings page and change a value.`));
  }
  check("looksLikeIntent: lower-case opener", looksLikeIntent("let me try the Reset button."));
  check("looksLikeIntent: curly apostrophe", looksLikeIntent("I’ll try the Reset button."));
  check("looksLikeIntent: empty", looksLikeIntent("") && looksLikeIntent("   ") && looksLikeIntent(null));
  check("looksLikeIntent: run #144 J3 — ends without punctuation",
    looksLikeIntent("The Settings page has the 'Insight Preferences' section with toggles. Let me interact with these controls"));
  check("looksLikeIntent: run #144 J4", looksLikeIntent("Let me try the Reset to Defaults button"));
  check("looksLikeIntent: a plan as the last sentence", looksLikeIntent("The settings page loaded. Now I need to save the form."));
  check("looksLikeIntent: tool-call fragment", looksLikeIntent("Recorded the step. report_step(label: \"Save\")."));
  check("looksLikeIntent: tool name in prose", looksLikeIntent("I have called write_e2e_test for this journey."));
  check("looksLikeIntent: a finished statement is not intent",
    !looksLikeIntent("Sign-in works; the dashboard loads with the user's name."));
  check("looksLikeIntent: a statement ending in a quote is not intent",
    !looksLikeIntent("The confirmation reads \"Your changes were saved.\""));
  check("looksLikeIntent: a statement with 'next' mid-sentence is not intent",
    !looksLikeIntent("The next-step button on the checkout page is disabled until an address is entered."));
  check("looksLikeIntent: cleanSummary's ellipsis cut counts as an ending",
    !looksLikeIntent("The dashboard lists every project with its owner and last activity…"));

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
