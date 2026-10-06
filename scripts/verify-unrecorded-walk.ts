// CHE-420: a walk that recorded no step publishes no words of the model's, and
// is filed as a gap of ours.
//
// Run cmuvu9xhl0007ue1t8s8zn4ww (Securify inside the Shopify admin): journey
// "Review the Block Log" was walked, never called report_step (0 Step rows),
// and its prose summary — "the Visitor Logs search count never reflects a
// matching result" — grew a published finding with no step, no screenshot and
// no trail behind it.
//
// Through the real path: walkOneJourney (src/agent/execution.ts) on a real D1,
// a real Chromium, and a scripted model —
//   1. the model never reports a step and ends with a claim → the journey's
//      summary is the fixed coverage sentence, the model is never asked for a
//      summary, and the journey carries ONE skipped our_capability step of
//      class unrecorded_walk, which is what fileCapabilityGaps files;
//   2. the model reports one step → no such step, the summary is the model's;
//   3. the rule counts steps WRITTEN (stepOrder): one recorded step that the
//      roll-up leaves out (a self-check refusal, countsTowardJourney) is still
//      a recorded step (Codex on #293).
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-unrecorded-walk.ts

process.env.CREDENTIALS_SECRET ??= "verify-unrecorded-walk-secret";

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

const CLAIM = "The Visitor Logs search count never reflects a matching result.";

// A model that either reports one step and then stops, or never reports one.
function scriptedModel(reportOne: boolean) {
  let calls = 0;
  let summaryCalls = 0;
  const message = (content: Anthropic.ContentBlock[], stop: Anthropic.Message["stop_reason"]) =>
    ({ id: `m${calls}`, type: "message", role: "assistant", model: "scripted", stop_reason: stop, stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage, content }) as Anthropic.Message;
  const create = async (params: { tools?: unknown }): Promise<Anthropic.Message> => {
    calls += 1;
    if (!params.tools) {
      summaryCalls += 1;
      return message([{ type: "text", text: CLAIM, citations: null }], "end_turn");
    }
    if (reportOne && calls === 1) {
      return message([{ type: "tool_use", id: "tu_1", name: "report_step",
        input: { label: "Open the logs page", status: "ok", attempted: "Open the logs page.", observed: "The logs page lists the visitors." } }], "tool_use");
    }
    return message([{ type: "text", text: CLAIM, citations: null }], "end_turn");
  };
  const client = { messages: { create } } as unknown as Anthropic;
  const llm: LlmConfig = { navClient: client, synthClient: client, structClient: client, navModel: "scripted", synthModel: "scripted", structModel: "scripted", navVision: false };
  return { llm, summaryCalls: () => summaryCalls };
}

async function main() {
  const { walkOneJourney } = await import("@/agent/execution");
  const site = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><meta charset=utf-8><title>Logs</title><h1>Visitor Logs</h1><p>3 visitors</p>");
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

    const walk = async (runId: string, reportOne: boolean) => {
      await db.run.create({ data: { id: runId, runNumber: runId === "run_none" ? 1 : 2, ownerId: "ann", teamId: "team_a", targetUrl: target, appSlug: "127.0.0.1", status: "walking" } as never });
      const model = scriptedModel(reportOne);
      await walkOneJourney({
        env,
        llm: model.llm,
        browser: browser as never,
        run: { id: runId, runNumber: 1, appSlug: "127.0.0.1", targetUrl: target, testEmail: null, testPasswordEnc: null, scopeHints: null, userNotes: null, focusAreas: null },
        proposed: { title: "Review the Block Log", steps: ["Open the logs", "Search for an IP"] },
        index: 0,
      });
      const journey = await db.journey.findFirst({ where: { runId }, include: { steps: true } });
      return { journey, summaryCalls: model.summaryCalls() };
    };

    const none = await walk("run_none", false);
    const steps = none.journey?.steps ?? [];
    check("a walk that recorded no step: the summary is the fixed coverage sentence, not the model's claim",
      none.journey?.summary === HOMEWORK_FALLBACK && !String(none.journey?.summary).includes("Visitor Logs"), String(none.journey?.summary));
    check("…and the model is never asked for a summary", none.summaryCalls === 0, String(none.summaryCalls));
    check("…and the journey carries one skipped our_capability step of class unrecorded_walk (what fileCapabilityGaps files)",
      steps.length === 1 && steps[0].status === "skipped" && steps[0].unverifiedReason === "our_capability" && steps[0].gapClass === "unrecorded_walk",
      JSON.stringify(steps.map((s) => ({ status: s.status, reason: s.unverifiedReason, gap: s.gapClass }))));

    const one = await walk("run_one", true);
    const oneSteps = one.journey?.steps ?? [];
    check("a walk that recorded a step: no unrecorded_walk step, and the summary is written from the walk",
      oneSteps.length === 1 && oneSteps[0].gapClass !== "unrecorded_walk" && one.journey?.summary !== HOMEWORK_FALLBACK,
      JSON.stringify({ steps: oneSteps.map((s) => s.label), summary: one.journey?.summary }));

    check("the rule counts steps written: one recorded step the roll-up leaves out is still a recorded walk",
      unrecordedWalkSummary(1, "skipped") === null && unrecordedWalkSummary(0, "skipped") === HOMEWORK_FALLBACK);
  } finally {
    await real.close?.();
    await browser.close();
    site.close();
  }
  console.log(failures ? `\nverify-unrecorded-walk: ${failures} FAILED` : "\nverify-unrecorded-walk: all passed");
  process.exit(failures ? 1 : 0);
}

void main();
