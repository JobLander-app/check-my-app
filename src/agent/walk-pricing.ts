// A journey the walk reached with no numbers is priced by the walk (CHE-490).
//
// Pricing used to happen in exactly one place: discovery, where the model
// proposes a journey together with its price and conversion. But a journey
// reaches the walk by two other roads that never ask discovery anything - the
// catalog's rotation slots on a full run, and every journey of a partial
// re-check (partial.ts) - and both hand the walker a title and a plan, nothing
// else. A journey whose catalog row had no price (never priced, or cleared by
// clearUnsupportablePrices) and that only ever arrived by one of those roads
// was therefore walked, left unpriced, and filed as "[Checker gap] Checker
// cannot say what a journey costs its user" on every run after: run #410 left
// three journeys that way, and the gap had been closed before for the
// extension's scripted journeys only.
//
// The walker has just done the journey, so it is the one that can say what it
// cost a person. The answer goes through the same rules every other price does
// (journeyMetric -> decideMetric): the guide's floor, the ceiling the journey's
// own walks support, a note that says what the flow is. A refused answer leaves
// the journey unpriced, and the gap keeps being filed - it is still true.
//
// Asked only for a journey with no stored price. Once one is stored, only a
// discovery that names a change may move it, so this costs one call per journey
// until it is priced and none after.

import type Anthropic from "@anthropic-ai/sdk";
import { finalizeJson, LlmBudgetError } from "./core";
import type { ProposedMetric } from "./discovery";
import type { AgentEnv } from "./env";
import { journeyMetric } from "./journey-catalog";
import { JOURNEY_METRICS_GUIDE, type JourneyMetric } from "./journey-metrics";
import type { LlmConfig, UsageTotals } from "./llm";

export const PRICE_WALK_INSTRUCTION =
  `The walk is over. Now price the journey you just walked, by this guide.\n\n` +
  `${JOURNEY_METRICS_GUIDE}\n\n` +
  `This journey has no numbers yet, so assign both. Count what a person has to do on the ` +
  `shortest path the product offers - never our own detours.\n` +
  `Reply with ONLY a JSON object, no prose: ` +
  `{"price":6,"conversion":65,"metricNote":"one sentence on what the flow is, from the user's side"}`;

function numberOrNull(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** What the model answered, coerced and not yet judged; null when it is no object. */
export function parseWalkPrice(reply: string): ProposedMetric | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const raw = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
    return {
      price: numberOrNull(raw.price),
      conversion: numberOrNull(raw.conversion),
      note: typeof raw.metricNote === "string" ? raw.metricNote : "",
    };
  } catch {
    return null;
  }
}

/**
 * The numbers for a journey this walk found unpriced, or null when there is
 * nothing to write: no catalog row, nothing walked, a price already stored, or
 * an answer the rules refuse. Never throws except for our own budget dying.
 */
export async function priceUnpricedWalk(args: {
  env: AgentEnv;
  llm: LlmConfig;
  messages: Anthropic.MessageParam[];
  usage: UsageTotals;
  appJourneyId: string | null;
  /** Steps this walk recorded; a walk that saw nothing cannot say what it cost. */
  recordedSteps: number;
}): Promise<JourneyMetric | null> {
  const { env, appJourneyId } = args;
  if (!appJourneyId || args.recordedSteps <= 0) return null;
  try {
    const row = await env.db.appJourney.findUnique({ where: { id: appJourneyId }, select: { price: true } });
    if (!row || row.price !== null) return null;

    const reply = await finalizeJson(args.llm, args.messages, PRICE_WALK_INSTRUCTION, args.usage);
    const raw = parseWalkPrice(reply);
    if (!raw) {
      console.warn(`[journey] walk pricing: no numbers in the reply: ${JSON.stringify(reply.slice(0, 80))}`);
      return null;
    }
    return await journeyMetric(env, appJourneyId, raw);
  } catch (err) {
    if (err instanceof LlmBudgetError) throw err;
    console.warn(`[journey] walk pricing skipped: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
