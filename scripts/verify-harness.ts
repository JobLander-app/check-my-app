// CHE-169 verification: the smart harness — a walk that navigates on text and
// is shown the page only at a moment of judgment, and a second opinion on
// every negative step before it is written — both behind HARNESS_TIER, and
// with the tier unset the walk is today's, byte for byte.
//
// Vision nav (CHE-70) killed two false-broken classes and cost 2.7× per
// journey (COSTS.md, CHE-131), because every screenshot went into the context.
// The owner's rule (2026-09-04): do not lower quality, and spend on the
// expensive thing only when the expensive thing is needed. Mechanism, not
// prompt (AGENTS.md): the triggers and the judge are code paths a scripted
// model cannot talk its way around.
//
// Pure: no browser, no network, no model, no database. A scripted model and
// a scripted judge drive runAgentLoop and adjudicateStep — the same functions
// the walk calls — against a stub page. What only production proves (the A/B
// on a LiveKit app and a link-heavy app, the judge's cost in cost:trend) is
// named in the PR, not claimed here.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-harness.ts

import type Anthropic from "@anthropic-ai/sdk";
import { ExtensionBrowser } from "@/agent/extension-browser";
import { finalizeStructured, LlmBudgetError, runAgentLoop } from "@/agent/core";
import { harnessMode } from "@/agent/env";
import { walkingVision } from "@/agent/harness";
import { adjudicateStep, applyJudgeAnswer, needsJudge, parseJudgeAnswer } from "@/agent/judge";
import { emptyUsage, isVisionModel, navVisionFor, type LlmConfig } from "@/agent/llm";
import { BROWSER_TOOLS, browserToolsFor, errorResponseIn, type ReportedStep, type ToolEnv } from "@/agent/tools";
// CHE-180: the judge's prose gate and fallback sentences moved to the shared
// language module so report_step writes with the same words.
import { NOT_DEFECT_FALLBACK, productProse, UNVERIFIABLE_FALLBACK } from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// The words the judge may never put in front of a customer.
const MACHINERY = /\b(browser|headless|environment|model|harness)\b/i;

// ─── stubs ──────────────────────────────────────────────────────────────────

// Every image block's payload in a conversation, in order (top-level and
// nested inside tool_result content).
function imageCount(msgs: Anthropic.MessageParam[]): number {
  let n = 0;
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "image") n++;
      if (b.type === "tool_result" && Array.isArray(b.content)) {
        for (const c of b.content) if (c.type === "image") n++;
      }
    }
  }
  return n;
}

// Whether the tool_result for a given tool_use id carries an image block.
function resultHasImage(msgs: Anthropic.MessageParam[], toolUseId: string): boolean {
  for (const m of msgs) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type !== "tool_result" || b.tool_use_id !== toolUseId) continue;
      return Array.isArray(b.content) && b.content.some((c) => c.type === "image");
    }
  }
  return false;
}

function resultText(msgs: Anthropic.MessageParam[], toolUseId: string): string {
  for (const m of msgs) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type !== "tool_result" || b.tool_use_id !== toolUseId) continue;
      if (typeof b.content === "string") return b.content;
      return (b.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
    }
  }
  return "";
}

type Turn = { name: string; input: Record<string, unknown> };

// A scripted nav model: plays the given turns, then ends. Records how many
// image blocks each call carried and which tools each request offered.
function scriptedNav(turns: Turn[]) {
  let call = 0;
  const imagesSeen: number[] = [];
  const toolsSeen: Anthropic.Tool[][] = [];
  const create = async (params: Anthropic.MessageCreateParams): Promise<Anthropic.Message> => {
    call += 1;
    imagesSeen.push(imageCount(params.messages));
    toolsSeen.push((params.tools ?? []) as Anthropic.Tool[]);
    const turn = turns[call - 1];
    return {
      id: `msg_${call}`,
      type: "message",
      role: "assistant",
      model: "scripted",
      stop_reason: turn ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
      content: turn
        ? [{ type: "tool_use", id: `tu_${call}`, name: turn.name, input: turn.input }]
        : [{ type: "text", text: "Journey walked.", citations: null }],
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
  return { llm, imagesSeen, toolsSeen };
}

// Enough of a page for navigate, read_page, click and screenshot. Clicks are
// scripted by accessible name: "Dead" reacts with nothing (the CHE-37 inert
// case), "Fail" makes one request that the target answers 500, "Fine" makes
// one request that answers 200. Navigating to /media makes the media probe
// answer true; /err answers HTTP 500.
function stubPage(vision: { visionScreenshots: boolean; visionTriggers: boolean }) {
  let currentUrl = "https://target.test/";
  let media = false;
  const env = {
    page: null as unknown,
    targetOrigin: "https://target.test",
    visionScreenshots: vision.visionScreenshots,
    ...(vision.visionTriggers ? { visionTriggers: true } : {}),
    networkLog: [] as string[],
    consoleLog: [] as string[],
    credentials: { rejected: false },
    actionTrail: [],
  } as unknown as ToolEnv;
  const locatorFor = (name: string) => {
    const locator = {
      first: () => locator,
      count: async () => 1,
      click: async () => {
        if (name === "Fail") env.networkLog.push("GET https://target.test/api/save → 500");
        if (name === "Fine") env.networkLog.push("GET https://target.test/api/list → 200");
        if (name === "Limited") env.networkLog.push("GET https://cdn.example.com/x → 429");
      },
      elementHandle: async () => null,
    };
    return locator;
  };
  const page = {
    url: () => currentUrl,
    goto: async (url: string) => {
      currentUrl = url;
      media = url.endsWith("/media");
      return { status: () => (url.endsWith("/err") ? 500 : 200) };
    },
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
    getByRole: (_role: string, opts?: { name?: string }) => locatorFor(opts?.name ?? ""),
    locator: (selector: string) => locatorFor(selector),
    getByText: (name: string) => locatorFor(name),
    evaluate: async (arg: unknown) => {
      const s = String(arg);
      if (s.includes("__cmaMutations")) return 0;
      if (s.includes("RTCPeerConnection")) return media;
      if (s.includes("h1,h2,h3")) {
        return { url: currentUrl, title: "Target", headings: [], links: [], buttons: [], fields: [] };
      }
      return undefined;
    },
    screenshot: async () => Buffer.from("not-really-an-image"),
  };
  env.page = page as unknown as ToolEnv["page"];
  return env;
}

// A scripted judge: answers from a queue (a JSON answer, raw text, or a
// thrown error), records every call and whether it carried an image.
function scriptedJudge(model: string) {
  const queue: Array<string | Error> = [];
  const calls: Array<{ hadImage: boolean; params: Anthropic.MessageCreateParams }> = [];
  const create = async (params: Anthropic.MessageCreateParams): Promise<Anthropic.Message> => {
    const first = params.messages[0];
    const hadImage = Array.isArray(first.content) && first.content.some((b) => b.type === "image");
    calls.push({ hadImage, params });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return {
      id: `judge_${calls.length}`,
      type: "message",
      role: "assistant",
      model,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 } as Anthropic.Usage,
      content: [{ type: "text", text: next ?? "", citations: null }],
    } as Anthropic.Message;
  };
  const client = { messages: { create } } as unknown as Anthropic;
  return { client, model, queue, calls };
}

function llmWithJudge(judge: ReturnType<typeof scriptedJudge>, navModel = "scripted"): LlmConfig {
  const nav = { messages: { create: async () => { throw new Error("nav must not be called"); } } } as unknown as Anthropic;
  return {
    navClient: nav,
    synthClient: nav,
    structClient: nav,
    navModel,
    synthModel: navModel,
    structModel: navModel,
    navVision: false,
    judgeClient: judge.client,
    judgeModel: judge.model,
  };
}

const brokenStep: ReportedStep = {
  label: "Submit the sign-in form",
  status: "broken",
  attempted: "Filled the email and password and pressed Sign in",
  observed: "The button did nothing; no request was made and the page stayed on /login",
};

// A step whose text says nothing about credentials, so classifyUnverified has
// no positive rule to apply and the judge's default (our_capability) lands.
const archiveStep: ReportedStep = {
  label: "Open the archive",
  status: "broken",
  attempted: "Pressed the Archive link in the footer",
  observed: "Nothing opened and the page did not change",
};

async function main() {
  for (const popup of [true, false]) for (const vision of ['always', 'requested', 'off'] as const) {
    const png = Buffer.from('verified-redacted-png');
    const panel = { count: async () => 1, isVisible: async () => true, screenshot: async () => png, locator: () => panel };
    const extension = Object.assign(Object.create(ExtensionBrowser.prototype), {
      popup, identity: { extensionId: 'hafhjepjihcimcljkdphpinannbdmnhf', targetUrl: 'http://127.0.0.1:9091/' },
      browser: { isConnected: () => true }, page: { locator: () => panel },
      runner: { fetch: async (request: Request) => {
        check('native vision uses only the cropped popup', new URL(request.url).pathname === '/popup.png');
        return new Response(png);
      } },
    }) as ExtensionBrowser;
    const env = { extension, page: extension.page, networkLog: [], consoleLog: [], visionScreenshots: vision === 'always', visionTriggers: vision === 'requested' } as unknown as ToolEnv;
    const nav = scriptedNav([{ name: popup ? 'extension_screenshot' : 'screenshot', input: { look: vision === 'requested' } }]);
    const result = await runAgentLoop({ system: 't', task: 'inspect', env, llm: nav.llm, thinking: 'off' });
    check(`native vision ${popup ? 'popup' : 'panel'} ${vision}: expected image in actual model input`, resultHasImage(result.messages, 'tu_1') === (vision !== 'off'));
    const encoded = JSON.stringify(result.messages);
    check('native vision preserves PNG media type', vision === 'off' || encoded.includes('"media_type":"image/png"') && encoded.includes(png.toString('base64')));
    check('native vision consumes the image once', env.pendingScreenshotPngB64 === undefined);
  }
  // 1 — HARNESS_TIER parsing: only the two exact tier names turn anything on.
  const mode = (v: string | undefined) => JSON.stringify(harnessMode({ HARNESS_TIER: v }));
  const off = JSON.stringify({ visionOnDemand: false, judge: false });
  check("tier unset → off", mode(undefined) === off, mode(undefined));
  check('tier "" → off', mode("") === off);
  check('tier "off" → off', mode("off") === off);
  check('tier "garbage" → off', mode("garbage") === off);
  check('tier "on" → off (no such tier)', mode("on") === off);
  check(
    'tier "vision-on-demand" → vision only',
    mode("vision-on-demand") === JSON.stringify({ visionOnDemand: true, judge: false }),
    mode("vision-on-demand"),
  );
  check(
    'tier "judge" → both',
    mode("judge") === JSON.stringify({ visionOnDemand: true, judge: true }),
    mode("judge"),
  );
  check('tier " Judge " → both (trimmed, case-insensitive)', mode(" Judge ") === mode("judge"));

  // 2 — how the walking ToolEnv sees, per tier and per nav model. The input
  // is llm.navVision (CHE-168: the ANTHROPIC_NAV_VISION override, else the
  // isVisionModel heuristic), exactly as execution.ts passes it.
  const offMode = harnessMode({});
  const vodMode = harnessMode({ HARNESS_TIER: "vision-on-demand" });
  const judgeMode = harnessMode({ HARNESS_TIER: "judge" });
  for (const nav of ["z-ai/glm-5v-turbo", "claude-sonnet-4-6", "z-ai/glm-5.2", "scripted"]) {
    const sees = navVisionFor(nav, undefined);
    check(`navVision for ${nav} without override is the heuristic`, sees === isVisionModel(nav));
    const v = walkingVision(offMode, sees);
    check(
      `tier unset, nav ${nav}: visionScreenshots === isVisionModel(nav) (${sees}), no triggers`,
      v.visionScreenshots === sees && v.visionTriggers === false,
      JSON.stringify(v),
    );
    const d = walkingVision(vodMode, sees);
    check(
      `vision-on-demand, nav ${nav}: no JPEG by default, triggers only if the model can see`,
      d.visionScreenshots === false && d.visionTriggers === sees,
      JSON.stringify(d),
    );
    check(`judge tier, nav ${nav}: sees like vision-on-demand`, JSON.stringify(walkingVision(judgeMode, sees)) === JSON.stringify(d));
  }
  // CHE-168's override is upstream of the tier: a vision model forced text-only
  // gets no image under any tier, and a text model forced "on" is treated as
  // seeing (the override's promise, the tier does not second-guess it).
  check(
    "ANTHROPIC_NAV_VISION=off on a vision model: no images under any tier",
    JSON.stringify(walkingVision(vodMode, navVisionFor("z-ai/glm-5v-turbo", "off"))) ===
      JSON.stringify({ visionScreenshots: false, visionTriggers: false }),
  );
  check(
    "ANTHROPIC_NAV_VISION=on on a text model: triggers under vision-on-demand",
    walkingVision(vodMode, navVisionFor("deepseek/deepseek-v4-flash", "on")).visionTriggers === true,
  );

  // 3 — the tools the model is offered: identical with the harness off.
  check("tools with harness off are BROWSER_TOOLS itself", browserToolsFor({}) === BROWSER_TOOLS);
  check("tools with triggers off are BROWSER_TOOLS itself", browserToolsFor({ visionTriggers: false }) === BROWSER_TOOLS);
  const onTools = browserToolsFor({ visionTriggers: true });
  const shot = onTools.find((t) => t.name === "screenshot");
  const shotProps = (shot?.input_schema as { properties?: Record<string, unknown> })?.properties ?? {};
  check("tools with triggers on: screenshot has `look`", "look" in shotProps, JSON.stringify(shotProps));
  check("tools with triggers on: same tools, same order otherwise", onTools.map((t) => t.name).join() === BROWSER_TOOLS.map((t) => t.name).join());
  const offShot = BROWSER_TOOLS.find((t) => t.name === "screenshot");
  check("BROWSER_TOOLS' screenshot has no `look`", !("look" in ((offShot?.input_schema as { properties?: Record<string, unknown> })?.properties ?? {})));

  // 4 — the loop under vision on demand: six ordinary turns attach nothing;
  // an inert click, a 500 in the last action, screenshot{look:true} and a
  // media page each attach exactly one image, to that tool's own result.
  const script: Turn[] = [
    { name: "read_page", input: {} }, // tu_1
    { name: "screenshot", input: {} }, // tu_2  — stored, not shown
    { name: "navigate", input: { url: "/pricing" } }, // tu_3 — 200, no media
    { name: "click", input: { role: "button", name: "Fine" } }, // tu_4 — one 200
    { name: "screenshot", input: { look: false } }, // tu_5
    { name: "read_page", input: {} }, // tu_6
    { name: "click", input: { role: "button", name: "Dead" } }, // tu_7 — inert
    { name: "click", input: { role: "button", name: "Fail" } }, // tu_8 — 500 from the target
    { name: "screenshot", input: { look: true } }, // tu_9 — the model asks
    { name: "navigate", input: { url: "/media" } }, // tu_10 — <video> on the page
    { name: "click", input: { role: "button", name: "Limited" } }, // tu_11 — 429 from a CDN
  ];
  {
    const nav = scriptedNav(script);
    const env = stubPage(walkingVision(vodMode, true));
    const r = await runAgentLoop({ system: "t", task: "walk", env, llm: nav.llm, thinking: "off" });
    check("vod loop: ran every turn", r.iterations === script.length + 1, String(r.iterations));
    check(
      "vod loop: no image at any of the first 7 calls (six ordinary turns)",
      nav.imagesSeen.slice(0, 7).every((n) => n === 0),
      nav.imagesSeen.join(","),
    );
    for (const id of ["tu_1", "tu_2", "tu_3", "tu_4", "tu_5", "tu_6"]) {
      check(`vod loop: ${id} result carries no image`, !resultHasImage(r.messages, id));
    }
    check("vod loop: inert click (tu_7) result carries an image", resultHasImage(r.messages, "tu_7"));
    check(
      "vod loop: inert click result tells the model the page is attached",
      resultText(r.messages, "tu_7").includes("did not react AT ALL") &&
        resultText(r.messages, "tu_7").includes("attached to this result"),
    );
    check("vod loop: 500 from the target (tu_8) result carries an image", resultHasImage(r.messages, "tu_8"));
    check("vod loop: screenshot look=true (tu_9) result carries an image", resultHasImage(r.messages, "tu_9"));
    check("vod loop: media page navigate (tu_10) result carries an image", resultHasImage(r.messages, "tu_10"));
    check("vod loop: 429 from anywhere (tu_11) result carries an image", resultHasImage(r.messages, "tu_11"));
    check(
      "vod loop: image count grows by one per trigger (0×7, then 1,2,3,4,5)",
      nav.imagesSeen.join(",") === "0,0,0,0,0,0,0,1,2,3,4,5",
      nav.imagesSeen.join(","),
    );
    check(
      "vod loop: every request offered the screenshot tool with `look`",
      nav.toolsSeen.every((tools) => "look" in ((tools.find((t) => t.name === "screenshot")?.input_schema as { properties?: Record<string, unknown> })?.properties ?? {})),
    );
  }
  // The control: the same script with the harness off on a vision nav — the
  // CHE-70 walk. Every screenshot attaches, no trigger does.
  {
    const nav = scriptedNav(script);
    const env = stubPage(walkingVision(offMode, true));
    const r = await runAgentLoop({ system: "t", task: "walk", env, llm: nav.llm, thinking: "off" });
    check("off loop: ordinary screenshot (tu_2) attaches, as today", resultHasImage(r.messages, "tu_2"));
    check("off loop: screenshot look=false (tu_5) attaches, as today", resultHasImage(r.messages, "tu_5"));
    check("off loop: inert click (tu_7) attaches nothing", !resultHasImage(r.messages, "tu_7"));
    check("off loop: 500 click (tu_8) attaches nothing", !resultHasImage(r.messages, "tu_8"));
    check("off loop: media navigate (tu_10) attaches nothing", !resultHasImage(r.messages, "tu_10"));
    check("off loop: inert click text is today's, without the attachment line", !resultText(r.messages, "tu_7").includes("attached to this result"));
    check("off loop: every request offered BROWSER_TOOLS itself", nav.toolsSeen.every((tools) => tools === BROWSER_TOOLS));
    check("off loop: three images total (two screenshots + look=true)", imageCount(r.messages) === 3, String(imageCount(r.messages)));
  }
  // A text-only nav model under the tier: nothing ever attaches.
  {
    const nav = scriptedNav(script);
    const env = stubPage(walkingVision(vodMode, false));
    const r = await runAgentLoop({ system: "t", task: "walk", env, llm: nav.llm, thinking: "off" });
    check("vod, text nav: no image anywhere", imageCount(r.messages) === 0 && nav.imagesSeen.every((n) => n === 0));
    check("vod, text nav: BROWSER_TOOLS itself", nav.toolsSeen.every((tools) => tools === BROWSER_TOOLS));
  }

  // 5 — the error-response reading behind trigger (b).
  check("errorResponseIn: 500 from the target", errorResponseIn(["GET https://target.test/api → 500"], "https://target.test") !== null);
  check("errorResponseIn: 404 from the target", errorResponseIn(["GET https://target.test/x → 404"], "https://target.test") !== null);
  check("errorResponseIn: 429 from anywhere", errorResponseIn(["GET https://cdn.other.com/x → 429"], "https://target.test") !== null);
  check("errorResponseIn: 500 from a third party is not ours to look at", errorResponseIn(["GET https://analytics.other.com/x → 500"], "https://target.test") === null);
  check("errorResponseIn: 200s are nothing", errorResponseIn(["GET https://target.test/x → 200", "POST https://target.test/y → 302"], "https://target.test") === null);
  check(
    "errorResponseIn: the CHE-100 credential rejection is excluded",
    errorResponseIn(["POST https://target.test/api/auth/login → 401"], "https://target.test") === null,
  );

  // 6 — the judge, off: no call on any status.
  {
    const judge = scriptedJudge("claude-judge-test");
    const llm = llmWithJudge(judge);
    for (const status of ["ok", "risky", "confusing", "broken", "exposed", "skipped"] as const) {
      const step = { ...brokenStep, status };
      const written = await adjudicateStep({ llm, enabled: false, step, page: null, networkLog: [], scrub: (s) => s, usage: emptyUsage() });
      check(`judge off, ${status}: step returned untouched`, written === step);
    }
    check("judge off: the judge client was never invoked", judge.calls.length === 0, String(judge.calls.length));
  }

  // 7 — the judge, on.
  {
    const judge = scriptedJudge("claude-judge-test");
    const llm = llmWithJudge(judge);
    const usage = emptyUsage();
    const page = stubPage(walkingVision(judgeMode, true)).page;
    const networkLog = Array.from({ length: 30 }, (_, i) => `GET https://target.test/r${i} → 200`);
    networkLog.push("POST https://target.test/api/auth/login → 200 secret-hunter2");

    // ok never invokes the judge.
    const okStep: ReportedStep = { ...brokenStep, status: "ok" };
    const okWritten = await adjudicateStep({ llm, enabled: true, step: okStep, page, networkLog, scrub: (s) => s, usage });
    check("judge on, ok: not invoked, step untouched", judge.calls.length === 0 && okWritten === okStep);
    check("needsJudge: broken/exposed/confusing only", needsJudge("broken") && needsJudge("exposed") && needsJudge("confusing") && !needsJudge("ok") && !needsJudge("risky") && !needsJudge("skipped"));

    // broken → not_defect, with machinery in the judge's own words.
    judge.queue.push(
      JSON.stringify({
        verdict: "not_defect",
        reason:
          "The sign-in form accepted the details and the account page loaded with the user's name shown. " +
          "In our headless browser the model saw no request because the harness environment blocked it.",
        userImpact: "A user signing in reaches their account as expected.",
      }),
    );
    const written = await adjudicateStep({ llm, enabled: true, step: brokenStep, page, networkLog, scrub: (s) => s.replace("hunter2", "[redacted]"), usage });
    check("judge on, broken: invoked exactly once", judge.calls.length === 1, String(judge.calls.length));
    check("judge on, broken → not_defect: status ok", written.status === "ok", written.status);
    check("judge on, not_defect: unverifiedReason cleared", written.unverifiedReason === undefined);
    check(
      "judge on, not_defect: observed is the judge's product-facing reason",
      written.observed.startsWith("The sign-in form accepted the details") && written.observed.includes("reaches their account"),
      written.observed,
    );
    check("judge on, not_defect: observed carries no machinery word", !MACHINERY.test(written.observed), written.observed);
    check("judge on: label and attempted untouched", written.label === brokenStep.label && written.attempted === brokenStep.attempted);
    check("judge on: the original step object is not mutated", brokenStep.status === "broken");
    const call = judge.calls[0];
    check("judge on, vision judge model: the call carries a screenshot", call.hadImage);
    check("judge on: the call is one user turn with the step's evidence", call.params.messages.length === 1 && JSON.stringify(call.params.messages[0].content).includes("Submit the sign-in form"));
    check("judge on: only the last 20 request lines are sent", JSON.stringify(call.params).includes("Last 20 requests") && !JSON.stringify(call.params).includes("/r10 →") && JSON.stringify(call.params).includes("/r11 →"));
    check("judge on: the request tail is scrubbed", !JSON.stringify(call.params).includes("hunter2") && JSON.stringify(call.params).includes("[redacted]"));
    check("judge on: asks for JSON by schema, with adaptive thinking", JSON.stringify(call.params).includes('"json_schema"') && JSON.stringify(call.params).includes('"adaptive"'));
    check("judge on: max_tokens ~1,500", call.params.max_tokens === 1_500, String(call.params.max_tokens));
    check("judge on: the judge's tokens accumulate in its own usage", usage.iterations === 1 && usage.inputTokens === 100 && usage.outputTokens === 50 && usage.costUsd > 0, JSON.stringify(usage));

    // broken → unverifiable → skipped + our_capability.
    judge.queue.push(
      JSON.stringify({
        verdict: "unverifiable",
        reason: "Whether the archive opens could not be established from what the page showed after the press.",
        userImpact: "Unknown.",
      }),
    );
    const unverified = await adjudicateStep({ llm, enabled: true, step: archiveStep, page, networkLog, scrub: (s) => s, usage });
    check("judge on, unverifiable: status skipped", unverified.status === "skipped", unverified.status);
    check("judge on, unverifiable: unverifiedReason defaults to our_capability", unverified.unverifiedReason === "our_capability", String(unverified.unverifiedReason));
    check("judge on, unverifiable: observed rewritten, machinery-free", unverified.observed.startsWith("Whether the archive opens") && !MACHINERY.test(unverified.observed), unverified.observed);
    check("judge on: two calls so far, usage follows", judge.calls.length === 2 && usage.iterations === 2);

    // unverifiable about credentials → missing_access (the classifyUnverified rule).
    judge.queue.push(JSON.stringify({ verdict: "unverifiable", reason: "The sign-in details on file were not accepted, so nothing behind the login could be checked.", userImpact: "" }));
    const cred = await adjudicateStep({ llm, enabled: true, step: brokenStep, page, networkLog, scrub: (s) => s, usage });
    check("judge on, unverifiable on a credential step: missing_access (the classifyUnverified rule)", cred.status === "skipped" && cred.unverifiedReason === "missing_access", String(cred.unverifiedReason));

    // exposed → defect: written exactly as reported.
    const exposed: ReportedStep = { ...brokenStep, status: "exposed", observed: "The API returned another user's email in the response body" };
    judge.queue.push(JSON.stringify({ verdict: "defect", reason: "Another user's data is returned.", userImpact: "Data exposure." }));
    const kept = await adjudicateStep({ llm, enabled: true, step: exposed, page, networkLog, scrub: (s) => s, usage });
    check("judge on, defect: the step is written exactly as reported", JSON.stringify(kept) === JSON.stringify(exposed), JSON.stringify(kept));

    // confusing → judge answers in prose around JSON (provider ignored the schema).
    const confusing: ReportedStep = { ...brokenStep, status: "confusing" };
    judge.queue.push('Sure, here is my answer:\n```json\n{"verdict":"not_defect","reason":"The form explains each field clearly and the next step is obvious to a first-time user.","userImpact":"None."}\n```\nHope that helps.');
    const prose = await adjudicateStep({ llm, enabled: true, step: confusing, page, networkLog, scrub: (s) => s, usage });
    check("judge on, JSON inside prose: still parsed (not_defect → ok)", prose.status === "ok", prose.status);

    // a throwing judge → the original step, unchanged, no throw.
    judge.queue.push(new Error("upstream 503"));
    const thrown = await adjudicateStep({ llm, enabled: true, step: brokenStep, page, networkLog, scrub: (s) => s, usage });
    check("judge throws: the step is written exactly as the model reported it", thrown === brokenStep);

    // an unparseable judge → the original step.
    judge.queue.push("I cannot decide.");
    const garbage = await adjudicateStep({ llm, enabled: true, step: brokenStep, page, networkLog, scrub: (s) => s, usage });
    check("judge unparseable: the step is written exactly as reported", garbage === brokenStep);

    // a wrong verdict value → the original step.
    judge.queue.push(JSON.stringify({ verdict: "maybe", reason: "x", userImpact: "y" }));
    const wrong = await adjudicateStep({ llm, enabled: true, step: brokenStep, page, networkLog, scrub: (s) => s, usage });
    check("judge with an unknown verdict: the step is written exactly as reported", wrong === brokenStep);

    // our own budget dying propagates (CLAUDE.md rule 4), never swallowed.
    judge.queue.push(new LlmBudgetError("402 would exceed your available credits"));
    let budgetThrown = false;
    try {
      await adjudicateStep({ llm, enabled: true, step: brokenStep, page, networkLog, scrub: (s) => s, usage });
    } catch (err) {
      budgetThrown = err instanceof LlmBudgetError;
    }
    check("judge on an LlmBudgetError: propagates", budgetThrown);

    // a text-only judge model gets no image.
    const textJudge = scriptedJudge("z-ai/glm-5.2");
    textJudge.queue.push(JSON.stringify({ verdict: "defect", reason: "x", userImpact: "y" }));
    await adjudicateStep({ llm: llmWithJudge(textJudge), enabled: true, step: brokenStep, page, networkLog, scrub: (s) => s, usage: emptyUsage() });
    check("judge on, text-only judge model: no image in the call", textJudge.calls.length === 1 && !textJudge.calls[0].hadImage);

    // no page → text only, still judged.
    const noPage = scriptedJudge("claude-judge-test");
    noPage.queue.push(JSON.stringify({ verdict: "defect", reason: "x", userImpact: "y" }));
    await adjudicateStep({ llm: llmWithJudge(noPage), enabled: true, step: brokenStep, page: null, networkLog, scrub: (s) => s, usage: emptyUsage() });
    check("judge on, no page: judged on text alone", noPage.calls.length === 1 && !noPage.calls[0].hadImage);
  }

  // 8 — the pure pieces of the judge (productProse is the shared gate since CHE-180).
  check("productProse: drops the sentence naming our side, keeps the product", productProse("The checkout completed and the receipt page showed the order number. Our headless browser then lost the session.") === "The checkout completed and the receipt page showed the order number.");
  check("productProse: 'model' and 'harness' are dropped too", productProse("The page loaded with the pricing table visible to a visitor. The model in the harness could not click.") === "The page loaded with the pricing table visible to a visitor.");
  check("productProse: nothing product-facing → null", productProse("Our headless browser environment failed.") === null);
  check("productProse: empty → null", productProse("") === null && productProse(null) === null);
  const fallbackNd = applyJudgeAnswer(brokenStep, { verdict: "not_defect", reason: "The browser did it.", userImpact: "The model says fine." });
  check("applyJudgeAnswer: not_defect with nothing left → fixed product sentence", fallbackNd.status === "ok" && fallbackNd.observed === NOT_DEFECT_FALLBACK && !MACHINERY.test(fallbackNd.observed));
  const fallbackUv = applyJudgeAnswer(archiveStep, { verdict: "unverifiable", reason: "headless", userImpact: "" });
  check("applyJudgeAnswer: unverifiable with nothing left → coverage sentence, our_capability", fallbackUv.status === "skipped" && fallbackUv.observed === UNVERIFIABLE_FALLBACK && fallbackUv.unverifiedReason === "our_capability");
  check("parseJudgeAnswer: plain JSON", parseJudgeAnswer('{"verdict":"defect","reason":"r","userImpact":"u"}')?.verdict === "defect");
  check("parseJudgeAnswer: fenced JSON", parseJudgeAnswer('```json\n{"verdict":"unverifiable","reason":"r","userImpact":"u"}\n```')?.verdict === "unverifiable");
  check("parseJudgeAnswer: prose only → null", parseJudgeAnswer("no idea") === null);
  check("parseJudgeAnswer: missing reason tolerated", parseJudgeAnswer('{"verdict":"not_defect"}')?.reason === "");

  // 9 — the struct fallback: with the judge on, a struct model that returns
  // nothing parseable is retried once on the judge model; otherwise not.
  {
    const structCalls: string[] = [];
    const structClient = {
      messages: {
        create: async (params: Anthropic.MessageCreateParams) => {
          structCalls.push(params.model);
          return {
            id: "s", type: "message", role: "assistant", model: params.model, stop_reason: "end_turn", stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
            content: [{ type: "text", text: "I explored the site and found several pages.", citations: null }],
          } as Anthropic.Message;
        },
      },
    } as unknown as Anthropic;
    const judge = scriptedJudge("claude-judge-test");
    const llm: LlmConfig = {
      navClient: structClient, synthClient: structClient, structClient,
      navModel: "z-ai/glm-5.2", synthModel: "claude-opus-4-8", structModel: "z-ai/glm-5.2", navVision: false,
      judgeClient: judge.client, judgeModel: judge.model,
    };
    const schema = { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" } } };
    const msgs: Anthropic.MessageParam[] = [{ role: "user", content: "explore" }, { role: "assistant", content: "done" }];

    const plain = await finalizeStructured<{ a: string }>(llm, msgs, "emit", schema);
    check("struct, judge off: no parse, no retry", plain.parsed === null && judge.calls.length === 0 && structCalls.length === 1, plain.note ?? "");

    judge.queue.push('{"a":"from the judge"}');
    const retried = await finalizeStructured<{ a: string }>(llm, msgs, "emit", schema, { judgeFallback: true });
    check("struct, judge on: retried once on the judge model and parsed", retried.parsed?.a === "from the judge" && judge.calls.length === 1, JSON.stringify(retried.parsed));
    check("struct, judge on: both calls' usage returned", retried.usage.iterations === 2 && retried.usage.inputTokens === 110 && retried.costUsd > 0, JSON.stringify(retried.usage));

    judge.queue.push("still prose");
    const twice = await finalizeStructured<{ a: string }>(llm, msgs, "emit", schema, { judgeFallback: true });
    check("struct, judge on, judge also fails: null with both notes", twice.parsed === null && (twice.note ?? "").includes("; then "), twice.note ?? "");

    const same: LlmConfig = { ...llm, judgeClient: judge.client, judgeModel: "z-ai/glm-5.2" };
    const before = judge.calls.length;
    await finalizeStructured<{ a: string }>(same, msgs, "emit", schema, { judgeFallback: true });
    check("struct, judge === struct model: no retry", judge.calls.length === before);

    const glmv: LlmConfig = { ...llm, judgeClient: judge.client, judgeModel: "z-ai/glm-5v-turbo" };
    await finalizeStructured<{ a: string }>(glmv, msgs, "emit", schema, { judgeFallback: true });
    check("struct, judge is a GLM vision variant (ignores json_schema): no retry", judge.calls.length === before);

    const noJudge: LlmConfig = { ...llm, judgeClient: undefined, judgeModel: undefined };
    await finalizeStructured<{ a: string }>(noJudge, msgs, "emit", schema, { judgeFallback: true });
    check("struct, no judge configured: no retry", judge.calls.length === before);
  }

  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
