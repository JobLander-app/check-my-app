// LLM clients + model tiering for the agent (CHE-16, cheap-model epic).
//
// Navigation (the long tool-use loop) and synthesis (one shot) are separately
// tiered. Model routing by id: an id containing "/" (e.g. "z-ai/glm-5.2",
// "moonshotai/kimi-k3") goes through OpenRouter's Anthropic-compatible
// /v1/messages endpoint (spike-verified: tool_use, thinking, cache_control all
// work) — the agent loop code is provider-agnostic. Plain "claude-*" ids hit
// Anthropic directly. Cost per call: OpenRouter returns the exact billed cost
// in usage; Anthropic is priced from the table below.

import Anthropic from "@anthropic-ai/sdk";
import type { AgentBindings } from "./env";
import RECOMMENDED_TIER from "./model-tier.recommended.json";

export interface LlmConfig {
  navClient: Anthropic;
  synthClient: Anthropic;
  navModel: string;
  synthModel: string;
  // Structured extraction (finalizeStructured). The GLM vision variants ignore
  // output_config json_schema (run #73: discovery extraction came back as
  // prose), so structured calls route to the text sibling instead.
  structClient: Anthropic;
  structModel: string;
  // CHE-168: whether the nav model is sent screenshots. Decided once in makeLlm
  // — the ANTHROPIC_NAV_VISION override, else the isVisionModel heuristic — so
  // a spike can flip a candidate between vision and text with a secret change
  // instead of a deploy. Every reader of "does nav see images" uses this field.
  navVision: boolean;
  // CHE-169: the second opinion. The judge sees one step — its evidence, the
  // request tail, a screenshot — and answers defect / not defect / cannot
  // tell, so the expensive model is paid for at the moment of judgment and
  // nowhere else. Unset → the nav model itself, on the nav client: a second
  // look from the same model with a focused prompt, no new provider. Optional
  // in the type so every LlmConfig built before this field existed still
  // type-checks; makeLlm always fills both.
  judgeClient?: Anthropic;
  judgeModel?: string;
  // CHE-330: where synthesis may go when its first route refuses it. The first
  // entry is always { synthClient, synthModel }; the rest are other ways to
  // reach a model of the same standing. Optional for the same reason as the
  // judge fields; synthRoutes() below reads it with that first entry as the
  // default, so an LlmConfig without it behaves exactly as before.
  synthRoutes?: ModelRoute[];
}

// One way to reach a model: the client that carries the request, and the id
// that client knows the model by.
export interface ModelRoute {
  client: Anthropic;
  model: string;
}

function clientFor(model: string, env: AgentBindings): Anthropic {
  if (model.includes("/")) {
    if (!env.OPENROUTER_API_KEY) {
      throw new Error(`Model ${model} needs OPENROUTER_API_KEY (not set on this worker)`);
    }
    return new Anthropic({
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api",
    });
  }
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

// Which models can accept image blocks (CHE-70). Claude models all can; on
// OpenRouter the GLM vision variants (glm-5v-*, glm-4.6v, glm-4.5v) and the
// DeepSeek V4 Flash vision variant (deepseek-v4-flash-vision*, CHE-168) do —
// sending an image to a text-only model errors the request.
export function isVisionModel(model: string): boolean {
  return model.startsWith("claude") || /glm-5v|glm-4\.[56]v|deepseek-v4-flash-vision/.test(model);
}

// CHE-168: the nav vision decision. "on"/"off" override the heuristic in either
// direction — a spike can run a vision-capable candidate text-only to price the
// two modes against each other, or force images onto a model the heuristic does
// not know yet. Anything else (unset, a typo) falls to the heuristic, so a
// misspelt secret cannot silently send images to a text-only model.
export function navVisionFor(navModel: string, override: string | undefined): boolean {
  const raw = override?.trim().toLowerCase();
  if (raw === "on") return true;
  if (raw === "off") return false;
  return isVisionModel(navModel);
}

// Structured extraction routing (finalizeStructured). The GLM vision variants
// ignore output_config json_schema (run #73), so a vision nav model routes
// structured calls to its text sibling; the DeepSeek vision variant is routed
// the same way on the same assumption until a run shows otherwise (CHE-168).
// ANTHROPIC_STRUCT_MODEL names the sibling explicitly and wins when set.
export function structModelFor(navModel: string, override: string | undefined): string {
  const explicit = override?.trim();
  if (explicit) return explicit;
  if (/glm-5v|glm-4\.[56]v/.test(navModel)) return "z-ai/glm-5.2";
  if (/deepseek-v4-flash-vision/.test(navModel)) return "deepseek/deepseek-v4-flash";
  return navModel;
}

// The GLM vision variants ignore output_config json_schema (run #73). Any call
// that needs schema-valid JSON must not be routed to one of them.
export function ignoresJsonSchema(model: string): boolean {
  return /glm-5v|glm-4\.[56]v/.test(model);
}

// An unset ANTHROPIC_NAV_MODEL/ANTHROPIC_SYNTH_MODEL used to silently fall
// back to a literal frozen in this file — the extensions branch (PR #81)
// validated an entire feature against Sonnet/Opus while production had moved
// to DeepSeek weeks earlier, and nothing printed a line about it. The
// fallback now reads model-tier.recommended.json (kept in sync with
// COSTS.md's "Recommended tier config" — see scripts/verify-model-config.mjs)
// and always logs when it fires, so a stale local .dev.vars is loud instead
// of silently wrong.
function warnFallback(envVar: string, value: string): string {
  console.warn(
    `[llm] ${envVar} not set — falling back to recommended tier default "${value}". ` +
      `This may not match production; see COSTS.md "Recommended tier config".`,
  );
  return value;
}

// ─── Synthesis routes (CHE-330) ─────────────────────────────────────────────
//
// Runs #135, #197 and #258 walked every journey, paid for it, and then lost
// the whole run in `writing`: six attempts in five minutes, each refused in
// about a second with
//   403 {"error":{"type":"forbidden","message":"Request not allowed"}}
// The synthesis model is a plain "claude-*" id, so that call goes straight to
// api.anthropic.com — OpenRouter's activity for those days carries no Claude
// model at all, and OpenRouter's own refusals read {"error":{"message","code"}}.
// The body above has neither Anthropic's {"type":"error"} envelope nor a
// request_id: it is the edge refusing the request before the API sees it,
// which is what api.anthropic.com answers a caller in a region it does not
// serve. A Workflow's fetch leaves from whichever Cloudflare location runs it,
// so the same code that passes at 17:54 is refused at 20:03 and passes again
// at 23:26 (runs #257, #258, #259). Retrying from the same place cannot help;
// asking by another road can. OpenRouter carries the same model and calls
// Anthropic from its own servers.

// "claude-opus-4-8" → "anthropic/claude-opus-4.8": the id OpenRouter lists the
// same model under. Null for anything that is not a direct Claude id.
export function openRouterTwin(model: string): string | null {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(model);
  if (!m) return null;
  return `anthropic/claude-${m[1]}-${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

// The roads to a synthesis model, first choice first. A direct Claude id falls
// back to the same model through OpenRouter; an OpenRouter id falls back to
// the recommended synthesis model on Anthropic directly. A road needs its key:
// with no key there is no road, and the list is just the primary, as before.
export function synthRoutesFor(synthModel: string, env: AgentBindings, primary: Anthropic): ModelRoute[] {
  const routes: ModelRoute[] = [{ client: primary, model: synthModel }];
  const twin = openRouterTwin(synthModel);
  if (twin && env.OPENROUTER_API_KEY) {
    routes.push({ client: clientFor(twin, env), model: twin });
  } else if (synthModel.includes("/") && env.ANTHROPIC_API_KEY) {
    const direct = RECOMMENDED_TIER.synthModel;
    if (direct !== synthModel && !direct.includes("/")) routes.push({ client: clientFor(direct, env), model: direct });
  }
  return routes;
}

export function synthRoutes(llm: LlmConfig): ModelRoute[] {
  return llm.synthRoutes?.length ? llm.synthRoutes : [{ client: llm.synthClient, model: llm.synthModel }];
}

// What a refusing road said, kept for our own board and never for a customer.
export interface RouteRefusal {
  model: string;
  status: number;
  error: string;
  // The Cloudflare location the refused request left from, when the refusing
  // host is behind Cloudflare: the cf-ray suffix, and the country its trace
  // reports. This is the fact that names a region block for what it is.
  colo: string | null;
  loc: string | null;
  // The road that answered this call after the refusal; null when none did.
  // Per call, because one run's synthesis and bottom-line rewrite can each
  // end on a different road.
  answeredBy: string | null;
}

// A 4xx that says "not from here, not like this" — the same request to the
// same road will be refused again, so the next road is the only move left.
// 402 is our credit (LlmBudgetError, CLAUDE.md rule 4) and must stay loud;
// 408/409/429 are transient and the SDK and Workflow retries own them.
export function isRouteRefusal(err: unknown): err is InstanceType<typeof Anthropic.APIError> {
  if (!(err instanceof Anthropic.APIError)) return false;
  return isRefusalStatus(err.status ?? 0);
}

// The status half of the rule above, on its own so run-failures.ts (CHE-329)
// can tell from a failed run's stored message that the refusal was already
// filed by fileRouteRefusal — the error object itself does not survive the
// step boundary.
export function isRefusalStatus(status: number): boolean {
  return status >= 400 && status < 500 && ![402, 408, 409, 429].includes(status);
}

async function refusalFacts(route: ModelRoute, err: InstanceType<typeof Anthropic.APIError>): Promise<RouteRefusal> {
  const ray = err.headers?.get?.("cf-ray") ?? null;
  const colo = ray?.split("-").pop() ?? null;
  let loc: string | null = null;
  try {
    const res = await fetch(new URL("/cdn-cgi/trace", route.client.baseURL), { signal: AbortSignal.timeout(3_000) });
    loc = /^loc=(\w+)$/m.exec(await res.text())?.[1] ?? null;
  } catch {
    // Best effort: the refusal is recorded whether or not the trace answers.
  }
  return { model: route.model, status: err.status ?? 0, error: err.message, colo, loc, answeredBy: null };
}

// When every road refused, the error that fails the run is still the
// provider's own (its message is what the run records), and the refusals
// travel beside it here so the caller can put them on our board.
const refusedBy = new WeakMap<object, RouteRefusal[]>();

export function refusalsOf(err: unknown): RouteRefusal[] {
  return typeof err === "object" && err !== null ? (refusedBy.get(err) ?? []) : [];
}

// messages.create over the roads in order. A refusal moves to the next road;
// anything else — and a refusal on the last road — throws as it always did,
// with the refusals so far attached (refusalsOf).
export async function createOnRoutes(
  routes: ModelRoute[],
  params: Omit<Anthropic.MessageCreateParamsNonStreaming, "model">,
): Promise<{ message: Anthropic.Message; model: string; refusals: RouteRefusal[] }> {
  const refusals: RouteRefusal[] = [];
  for (let i = 0; i < routes.length; i += 1) {
    const route = routes[i];
    try {
      const message = await route.client.messages.create({ ...params, model: route.model });
      for (const r of refusals) r.answeredBy = route.model;
      return { message, model: route.model, refusals };
    } catch (err) {
      // Whatever ends the ladder carries the refusals seen before it: a 500 on
      // the fallback does not make the first road's 403 any less real.
      const terminal = (): never => {
        if (refusals.length && typeof err === "object" && err !== null) refusedBy.set(err, refusals);
        throw err;
      };
      if (!isRouteRefusal(err)) return terminal();
      const facts = await refusalFacts(route, err);
      refusals.push(facts);
      if (i === routes.length - 1) return terminal();
      console.warn(
        `[llm] ${route.model} refused (${facts.status}, colo=${facts.colo ?? "?"}, loc=${facts.loc ?? "?"}): ` +
          `${facts.error} — trying ${routes[i + 1].model}`,
      );
    }
  }
  throw new Error("createOnRoutes: no routes");
}

export function makeLlm(env: AgentBindings): LlmConfig {
  const navModel = env.ANTHROPIC_NAV_MODEL ?? warnFallback("ANTHROPIC_NAV_MODEL", RECOMMENDED_TIER.navModel);
  const synthModel =
    env.ANTHROPIC_SYNTH_MODEL ?? warnFallback("ANTHROPIC_SYNTH_MODEL", RECOMMENDED_TIER.synthModel);
  const structModel = structModelFor(navModel, env.ANTHROPIC_STRUCT_MODEL);
  const navClient = clientFor(navModel, env);
  // CHE-169: the judge defaults to the nav model on the nav client, so with
  // ANTHROPIC_JUDGE_MODEL unset no second provider or key is involved.
  const judgeModel = env.ANTHROPIC_JUDGE_MODEL?.trim() || navModel;
  const synthClient = clientFor(synthModel, env);
  return {
    navClient,
    synthClient,
    synthRoutes: synthRoutesFor(synthModel, env, synthClient),
    navModel,
    synthModel,
    structClient: clientFor(structModel, env),
    structModel,
    navVision: navVisionFor(navModel, env.ANTHROPIC_NAV_VISION),
    judgeClient: judgeModel === navModel ? navClient : clientFor(judgeModel, env),
    judgeModel,
  };
}

// Per-1M-token prices (USD): [input, output]. cache write ×1.25, read ×0.1.
const PRICING: Record<string, [number, number]> = {
  "claude-opus-4-8": [5, 25],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5],
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  // OpenRouter reports the exact billed USD in the response — always prefer it.
  cost?: number | null;
}

// Accumulated tokens+cost for one unit of work (a loop, a phase). Feeds the
// LlmUsage ledger — tokens-model-money is the primary product metric.
export interface UsageTotals {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  iterations: number;
  costUsd: number;
}

export function emptyUsage(): UsageTotals {
  return {
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    iterations: 0,
    costUsd: 0,
  };
}

export function addUsage(t: UsageTotals, model: string, u: Usage): void {
  t.inputTokens += u.input_tokens;
  t.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
  t.cacheReadTokens += u.cache_read_input_tokens ?? 0;
  t.outputTokens += u.output_tokens;
  t.iterations += 1;
  t.costUsd += costOf(model, u);
}

export function mergeUsage(into: UsageTotals, from: UsageTotals): void {
  into.inputTokens += from.inputTokens;
  into.cacheWriteTokens += from.cacheWriteTokens;
  into.cacheReadTokens += from.cacheReadTokens;
  into.outputTokens += from.outputTokens;
  into.iterations += from.iterations;
  into.costUsd += from.costUsd;
}

export function costOf(model: string, u: Usage): number {
  if (typeof u.cost === "number") return u.cost;
  const [inP, outP] = PRICING[model] ?? PRICING["claude-sonnet-4-6"];
  return (
    (u.input_tokens * inP +
      (u.cache_creation_input_tokens ?? 0) * inP * 1.25 +
      (u.cache_read_input_tokens ?? 0) * inP * 0.1 +
      u.output_tokens * outP) /
    1e6
  );
}
