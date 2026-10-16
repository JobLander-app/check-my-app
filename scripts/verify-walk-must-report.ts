// A walk that stops talking before it has called report_step is asked once,
// before it ends, to report what it did — and the turn after that request is a
// forced report_step call, so repeating the prose is not an available answer.
//
// Run #337 (a signed-in journey on a preview app) and every run after it ended
// a journey in prose with zero steps, and each filed "Checker walks a journey
// without recording a single step". CHE-420 made the symptom honest (a fixed
// coverage sentence plus a gap ticket); this is the cause: the loop let the
// model end the walk on its own say-so while nothing was recorded.
//
// Through the real path (walkOneJourney, real D1, real Chromium, scripted model):
//   1. the model ends in prose, then reports a step when asked → the journey has
//      that step, no unrecorded_walk step, and the model was asked exactly once;
//   2. the model ends in prose and ignores the request (answers it with the
//      same prose) → the next request carries tool_choice report_step, so the
//      step is recorded anyway and the journey is not an unrecorded walk; the
//      model was asked once only (the nudge is bounded);
//   3. a model that reports on its own is never asked.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-walk-must-report.ts

process.env.CREDENTIALS_SECRET ??= "verify-walk-must-report-secret";

import "./fixtures/wasm-module-loader.mjs";
import http from "node:http";
import Module from "node:module";
import type Anthropic from "@anthropic-ai/sdk";
import { chromium } from "playwright";
import { realD1 } from "./fixtures/real-d1";
import type { LlmConfig } from "@/agent/llm";
import type { AgentEnv } from "@/agent/env";
import { unrecordedWalkSummary } from "@/agent/summary";
import { HOMEWORK_FALLBACK } from "@/lib/verdict-language";

// src/agent/execution.ts reaches @cloudflare/playwright, which requires the
// `cloudflare:workers` builtin at load time; the walk itself runs in the
// Playwright Chromium handed to it. Loaded after this, in main().
const moduleLoader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const realLoad = moduleLoader._load;
moduleLoader._load = function (request: string, ...rest: unknown[]) {
  if (request === "cloudflare:workers") return {};
  return realLoad.call(this, request, ...rest);
};

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const CLAIM = "The practice interview module did not open for the signed-in user.";

type Mode = "reports_when_asked" | "ignores_request" | "reports_first";

function scriptedModel(mode: Mode) {
  let calls = 0;
  let asked = 0;
  let forced = 0;
  const message = (content: Anthropic.ContentBlock[], stop: Anthropic.Message["stop_reason"]) =>
    ({ id: `m${calls}`, type: "message", role: "assistant", model: "scripted", stop_reason: stop, stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage, content }) as Anthropic.Message;
  const report = (id: string) =>
    message([{ type: "tool_use", id, name: "report_step",
      input: { label: "Open the module", status: "broken", attempted: "Open the practice interview module.", observed: "The module page stays empty." } }], "tool_use");
  const create = async (params: { tools?: unknown; messages?: Anthropic.MessageParam[]; tool_choice?: Anthropic.ToolChoice }): Promise<Anthropic.Message> => {
    calls += 1;
    if (!params.tools) return message([{ type: "text", text: CLAIM, citations: null }], "end_turn");
    const last = params.messages?.[params.messages.length - 1];
    const wasAsked = last?.role === "user" && typeof last.content === "string" && last.content.includes("report_step");
    if (wasAsked) {
      asked += 1;
      // The API's side of tool_choice: a named tool is the only thing it can return.
      if (params.tool_choice?.type === "tool" && params.tool_choice.name === "report_step") {
        forced += 1;
        return report("tu_forced");
      }
      return mode === "reports_when_asked" ? report("tu_asked") : message([{ type: "text", text: CLAIM, citations: null }], "end_turn");
    }
    if (mode === "reports_first" && calls === 1) return report("tu_first");
    return message([{ type: "text", text: CLAIM, citations: null }], "end_turn");
  };
  const client = { messages: { create } } as unknown as Anthropic;
  const llm: LlmConfig = { navClient: client, synthClient: client, structClient: client, navModel: "scripted", synthModel: "scripted", structModel: "scripted", navVision: false };
  return { llm, asked: () => asked, forced: () => forced };
}

async function main() {
  const { walkOneJourney } = await import("@/agent/execution");
  const site = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><meta charset=utf-8><title>Practice</title><h1>Practice</h1>");
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", () => resolve()));
  const target = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
  const browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
  const real = await realD1();
  try {
    const db = real.db;
    await db.user.create({ data: { id: "ann", clerkUserId: "ck_ann", email: "ann@a.test" } });
    await db.team.create({ data: { id: "team_a", name: "A", plan: "business" } });
    const env = { db, bindings: {} } as unknown as AgentEnv;

    let n = 0;
    const walk = async (mode: Mode) => {
      n += 1;
      const runId = `run_${mode}`;
      await db.run.create({ data: { id: runId, runNumber: n, ownerId: "ann", teamId: "team_a", targetUrl: target, appSlug: "127.0.0.1", status: "walking" } as never });
      const model = scriptedModel(mode);
      await walkOneJourney({
        env,
        llm: model.llm,
        browser: browser as never,
        run: { id: runId, runNumber: n, appSlug: "127.0.0.1", targetUrl: target, testEmail: null, testPasswordEnc: null, scopeHints: null, userNotes: null, focusAreas: null },
        proposed: { title: "Authenticated user accesses the practice module", steps: ["Open the module"] },
        index: 0,
      });
      const journey = await db.journey.findFirst({ where: { runId }, include: { steps: true } });
      return { steps: journey?.steps ?? [], summary: journey?.summary ?? null, asked: model.asked(), forced: model.forced() };
    };

    const asked = await walk("reports_when_asked");
    check("a walk that ended in prose is asked to report, and the step it reports is recorded",
      asked.asked === 1 && asked.steps.length === 1 && asked.steps[0].label === "Open the module" && asked.steps[0].status === "broken",
      JSON.stringify({ asked: asked.asked, steps: asked.steps.map((s) => [s.label, s.status, s.gapClass]) }));
    check("…and the journey is not filed as an unrecorded walk",
      !asked.steps.some((s) => s.gapClass === "unrecorded_walk") && asked.summary !== HOMEWORK_FALLBACK, String(asked.summary));

    const ignored = await walk("ignores_request");
    check("a walk that answers the request with the same prose is made to report: the next request forces report_step",
      ignored.asked === 1 && ignored.forced === 1 && ignored.steps.length === 1 && ignored.steps[0].label === "Open the module",
      JSON.stringify({ asked: ignored.asked, forced: ignored.forced, steps: ignored.steps.map((s) => [s.label, s.gapClass]) }));
    check("…and that journey is not filed as an unrecorded walk",
      !ignored.steps.some((s) => s.gapClass === "unrecorded_walk") && ignored.summary !== HOMEWORK_FALLBACK, String(ignored.summary));

    const first = await walk("reports_first");
    check("a walk that reports on its own is never asked", first.asked === 0 && first.steps.length === 1, String(first.asked));
  } finally {
    await real.close?.();
    await browser.close();
    site.close();
  }
  console.log(failures ? `\nverify-walk-must-report: ${failures} FAILED` : "\nverify-walk-must-report: all passed");
  process.exit(failures ? 1 : 0);
}

void main();
