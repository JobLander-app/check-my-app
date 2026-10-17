// A journey the walk reached with no numbers is priced by the walk (CHE-490).
//
// Run #410 (checkmyapp.dev) re-walked five of twelve journeys and left three of
// them unpriced, so "[Checker gap] Checker cannot say what a journey costs its
// user" was filed again. Those journeys came through the partial re-check, which
// hands the walker a title and a plan and no price; the only place that ever
// priced a journey was discovery, which a partial run (and a rotation slot on a
// full run) never consults. This holds the mechanism that closes that road:
// priceUnpricedWalk, wired into walkOneJourney.
//
// Run: npx tsx --tsconfig tsconfig.json scripts/verify-walk-pricing.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentEnv } from "../src/agent/env";
import { emptyUsage, type LlmConfig } from "../src/agent/llm";
import { JOURNEY_METRICS_GUIDE } from "../src/agent/journey-metrics";
import { PRICE_WALK_INSTRUCTION, parseWalkPrice, priceUnpricedWalk } from "../src/agent/walk-pricing";

let failures = 0;
function check(what: string, ok: boolean, detail = "") {
  if (ok) console.log(`PASS  ${what}`);
  else {
    failures += 1;
    console.log(`FAIL  ${what}${detail ? `  ->  ${detail}` : ""}`);
  }
}

function scriptedLlm(reply: string) {
  let calls = 0;
  let instruction = "";
  const create = async (params: { messages: Anthropic.MessageParam[] }): Promise<Anthropic.Message> => {
    calls += 1;
    const last = params.messages[params.messages.length - 1];
    const blocks = Array.isArray(last?.content) ? last.content : [];
    const tail = blocks[blocks.length - 1];
    instruction = tail && tail.type === "text" ? tail.text : "";
    return {
      id: "m",
      type: "message",
      role: "assistant",
      model: "scripted",
      content: [{ type: "text", text: reply, citations: null }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as Anthropic.Message;
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
  return { llm, calls: () => calls, instruction: () => instruction };
}

// A catalog holding `stored` for the journey, and walks of `pastSteps` steps.
function envWith(stored: { price: number | null; conversion: number | null; metricNote: string | null }, pastSteps = 4): AgentEnv {
  return {
    db: {
      appJourney: { findUnique: async () => stored },
      journey: { findMany: async () => [{ _count: { steps: pastSteps } }] },
    },
  } as unknown as AgentEnv;
}

const unpriced = { price: null, conversion: null, metricNote: null };
const walked: Anthropic.MessageParam[] = [{ role: "user", content: "Walk the journey now." }];

async function ask(reply: string, env: AgentEnv, over: { appJourneyId?: string | null; recordedSteps?: number } = {}) {
  const model = scriptedLlm(reply);
  const metric = await priceUnpricedWalk({
    env,
    llm: model.llm,
    messages: walked,
    usage: emptyUsage(),
    appJourneyId: over.appJourneyId === undefined ? "aj1" : over.appJourneyId,
    recordedSteps: over.recordedSteps ?? 3,
  });
  return { metric, model };
}

async function main() {
  // The reply is read, whatever wraps it.
  const bare = parseWalkPrice('{"price":4,"conversion":80,"metricNote":"Open the page, fill two fields, submit."}');
  check("a bare JSON answer is read", bare?.price === 4 && bare?.conversion === 80 && bare?.note.startsWith("Open"));
  const fenced = parseWalkPrice('```json\n{"price":"6","conversion":"65","metricNote":"A real form."}\n```');
  check("a fenced answer with numbers as strings is read", fenced?.price === 6 && fenced?.conversion === 65);
  check("prose with no object is no answer", parseWalkPrice("It costs about five actions.") === null);
  check("a broken object is no answer", parseWalkPrice("{price: 4,") === null);

  // The instruction carries the contract, not a paraphrase of it.
  check("the question carries the whole pricing guide", PRICE_WALK_INSTRUCTION.includes(JOURNEY_METRICS_GUIDE));

  // An unpriced journey is priced from the walk, under the usual rules.
  const priced = await ask(
    '{"price":5,"conversion":85,"metricNote":"Open sign-in, type the email and the password, submit."}',
    envWith(unpriced),
  );
  check("an unpriced journey takes the walker's numbers", priced.metric?.price === 5 && priced.metric?.conversion === 85, JSON.stringify(priced.metric));
  check("it costs one model call", priced.model.calls() === 1, String(priced.model.calls()));
  check("the call asked for the numbers", priced.model.instruction().includes("price") && priced.model.instruction().includes("conversion"));

  // A journey that already has a price is left to discovery: no call, no write.
  const stored = await ask(
    '{"price":9,"conversion":10,"metricNote":"Something else entirely, said with confidence."}',
    envWith({ price: 5, conversion: 85, metricNote: "Open sign-in, type the email and the password, submit." }),
  );
  check("a stored price is never asked for again", stored.metric === null && stored.model.calls() === 0, `${JSON.stringify(stored.metric)} / ${stored.model.calls()} calls`);

  // Nothing to price: no catalog row, or a walk that recorded nothing.
  const noRow = await ask('{"price":5,"conversion":85,"metricNote":"Open sign-in and submit."}', envWith(unpriced), { appJourneyId: null });
  check("a run with no catalog row asks nothing", noRow.metric === null && noRow.model.calls() === 0);
  const noSteps = await ask('{"price":5,"conversion":85,"metricNote":"Open sign-in and submit."}', envWith(unpriced), { recordedSteps: 0 });
  check("a walk that recorded no step asks nothing", noSteps.metric === null && noSteps.model.calls() === 0);

  // What no journey can cost is refused, and the journey stays unpriced - the
  // gap is then still true and still filed.
  const zero = await ask('{"price":0,"conversion":0,"metricNote":"Not tracked - no events in the UI."}', envWith(unpriced));
  check("zero actions is refused", zero.metric === null, JSON.stringify(zero.metric));
  const absurd = await ask('{"price":100,"conversion":50,"metricNote":"A very long flow indeed, apparently."}', envWith(unpriced, 3));
  check("a price its own walks cannot support is refused", absurd.metric === null, JSON.stringify(absurd.metric));
  const noObject = await ask("About five actions, I would say.", envWith(unpriced));
  check("an answer with no numbers prices nothing", noObject.metric === null);

  // The wiring: the walk asks, and what it is told is stored on the run's row.
  const execution = readFileSync(join(__dirname, "../src/agent/execution.ts"), "utf8");
  check("walkOneJourney asks for a price when the journey arrived with none", /priceUnpricedWalk\(/.test(execution) && /if \(!metric\)/.test(execution));
  check("the price lands on the run's journey row too", /walkPrice\.price/.test(execution) && /walkPrice\.conversion/.test(execution));

  if (failures) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nWalk pricing: a journey that reaches the walk unpriced is priced by it, and only until a price is stored");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
