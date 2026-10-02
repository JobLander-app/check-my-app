// CHE-7 — the agent core. A manual tool-use loop (not the SDK tool runner)
// because the harness needs per-iteration hooks: evidence capture, live-state
// updates, transcript audit, and budget enforcement.
//
// The core is a pure function of (instructions, tools, budget) → final text +
// transcript. No BullMQ, no Prisma — portable to Cloudflare Workflows as-is.

import Anthropic from "@anthropic-ai/sdk";
import {
  addUsage,
  costOf,
  emptyUsage,
  ignoresJsonSchema,
  isVisionModel,
  mergeUsage,
  type LlmConfig,
  type UsageTotals,
} from "./llm";
import { productName } from "@/lib/verdict-language";
import { ownWordsDeep, ownWordsInAnswer } from "@/lib/model-text";
import { browserToolsFor, executeTool, type ToolEnv } from "./tools";

export interface AgentLoopArgs {
  system: string;
  task: string;
  env: ToolEnv;
  llm: LlmConfig;
  maxIterations?: number;
  // Extended-thinking mode for this loop (CHE-58 E3). Walking is mechanical
  // (act/observe) and pays for adaptive thinking on every one of its ~24 calls;
  // discovery/synthesis keep adaptive. Default adaptive to preserve behavior.
  thinking?: "adaptive" | "off";
  // Called after each iteration with a short progress note (for the live feed).
  onProgress?: (note: string) => Promise<void>;
  // CHE-130: how many of the most recent screenshots stay in the conversation
  // as image blocks. Older ones are replaced with a text placeholder the moment
  // they fall out of the window. `undefined` = never trim (the pre-CHE-130
  // behaviour, which discovery keeps only under DISCOVERY_LEAN=off — by default
  // discovery runs image-free with a window of 0, CHE-135).
  imageWindow?: number;
  // CHE-134: once the model has called `tool` (for walking, write_e2e_test —
  // the spec is the last artefact a journey produces), the loop allows at most
  // `extraIterations` more turns and tells the model so by appending `note`
  // to that tool's result. Walks used to keep exploring or re-reading pages
  // after the spec until the cap, at 25–40 calls per journey (COSTS.md). The
  // extra turns execute tools normally: a create_cleanup walk still has to
  // delete what it created and call record_deleted (CHE-90).
  wrapUpAfter?: { tool: string; extraIterations: number; note: string };
}

export interface AgentLoopResult {
  finalText: string;
  iterations: number;
  // Audit artifact: every tool call + (truncated) result, in order.
  transcript: TranscriptEntry[];
  // Full conversation, for a follow-up finalize call if finalText didn't parse.
  messages: Anthropic.MessageParam[];
  // Rolled-up Anthropic cost of this loop (USD) — feeds Run.costUsd (CHE-16).
  costUsd: number;
  // Full token/cost breakdown of the loop — feeds the LlmUsage ledger.
  usage: UsageTotals;
  // CHE-180: "model" when the model stopped requesting tools; "cap" when the
  // iteration cap (CHE-134) ended the loop while the last response still asked
  // for tools. In the second case finalText is the model's last thought
  // mid-action ("Let me try the Reset to Defaults button", run #144), not a
  // summary, and the caller must not write it as one.
  endedBy: "model" | "cap";
}

export interface TranscriptEntry {
  at: string;
  kind: "tool_call" | "tool_result" | "text";
  name?: string;
  // Inputs are recorded as the model sent them — credential placeholders
  // ({{TEST_PASSWORD}}) stay placeholders, so transcripts are secret-free.
  detail: string;
}

const MAX_TOOL_RESULT_CHARS = 6_000;

// Harness-side billing failure (CHE-76): the LLM provider refused the call over
// OUR credit state (OpenRouter 402 "would exceed your available credits").
// Never a fact about the customer's app — callers must abort the run without
// publishing a verdict, findings, or email. Retrying is pointless until credits
// change, so createWithRetry throws this immediately.
export class LlmBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmBudgetError";
  }
}

export async function runAgentLoop(args: AgentLoopArgs): Promise<AgentLoopResult> {
  const {
    system,
    task,
    env,
    llm,
    maxIterations = 40,
    thinking = "adaptive",
    onProgress,
    imageWindow,
    wrapUpAfter,
  } = args;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  const transcript: TranscriptEntry[] = [];
  let iterations = 0;
  let finalText = "";
  let costUsd = 0;
  const usage = emptyUsage();
  // CHE-134: the effective cap. Starts at maxIterations and only ever comes
  // down — a second call to the wrap-up tool must not hand the loop new turns.
  let cap = maxIterations;
  // CHE-180: only the model's own stop flips this; running out of turns does not.
  let endedBy: "model" | "cap" = "cap";
  // CHE-169: the screenshot tool carries `look` only under vision on demand;
  // with the harness off this is BROWSER_TOOLS, byte for byte.
  const tools = browserToolsFor(env);

  while (iterations < cap) {
    iterations += 1;

    // Prompt caching: breakpoint on the system block caches tools+system
    // (stable for the whole loop); the top-level marker auto-caches the last
    // block of the growing conversation, so each iteration re-reads the prior
    // transcript at ~0.1x instead of reprocessing it.
    // Retried on transient API errors so a 20-min run isn't lost to one 529 —
    // the messages array is intact, so resume is just re-issuing the call.
    const response = await createWithRetry(() =>
      llm.navClient.messages.create({
        // 16k keeps non-streaming under the SDK timeout while leaving room for
        // adaptive thinking + a long final JSON (discovery/synthesis emit the
        // whole app map at once — 8k truncated it and silently lost journeys).
        model: llm.navModel,
        max_tokens: 16_000,
        ...(thinking === "adaptive" ? { thinking: { type: "adaptive" as const } } : {}),
        cache_control: { type: "ephemeral" },
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools,
        messages,
      }),
    );

    const u = response.usage;
    costUsd += costOf(llm.navModel, u);
    addUsage(usage, llm.navModel, u);
    console.log(
      `[agent] iter ${iterations}: stop=${response.stop_reason} in=${u.input_tokens} cache_write=${u.cache_creation_input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens}`,
    );
    if (response.stop_reason === "max_tokens") {
      console.warn(`[agent] iter ${iterations} hit max_tokens — output may be truncated`);
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) {
        finalText = block.text;
        transcript.push({ at: now(), kind: "text", detail: block.text.slice(0, 2_000) });
      }
    }

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      endedBy = "model";
      break;
    }

    messages.push({ role: "assistant", content: response.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tool of toolUses) {
      const input = tool.input as Record<string, unknown>;
      transcript.push({
        at: now(),
        kind: "tool_call",
        name: tool.name,
        detail: JSON.stringify(redactForAudit(tool.name, input)).slice(0, 1_500),
      });

      const result = await executeTool(env, tool.name, input);
      transcript.push({
        at: now(),
        kind: "tool_result",
        name: tool.name,
        detail: result.slice(0, 800),
      });

      // CHE-134: the note rides after the truncation so it is never the part
      // that gets cut; the transcript above keeps the tool's own result only.
      let resultText = result.slice(0, MAX_TOOL_RESULT_CHARS);
      if (wrapUpAfter && tool.name === wrapUpAfter.tool) {
        resultText += `\n\n${wrapUpAfter.note}`;
        const wrapCap = Math.min(cap, iterations + Math.max(0, wrapUpAfter.extraIterations));
        if (wrapCap < cap) {
          cap = wrapCap;
          console.log(`[agent] wrap-up after ${tool.name}: ${cap - iterations} iterations left`);
        }
      }

      // Vision (CHE-70): the captured screenshot rides along as an image block so
      // the model judges what it actually photographed, not just the DOM.
      const capture = env.pendingScreenshotPngB64 ?? env.pendingScreenshotJpegB64;
      const mediaType = env.pendingScreenshotPngB64 ? "image/png" : "image/jpeg";
      env.pendingScreenshotPngB64 = undefined;
      env.pendingScreenshotJpegB64 = undefined;
      results.push({
        type: "tool_result",
        tool_use_id: tool.id,
        content: capture
          ? [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: capture },
              },
              { type: "text", text: resultText },
            ]
          : resultText,
      });

      if (tool.name === "report_step" && onProgress) {
        // CHE-180: the note is the live feed the owner watches; the label goes
        // through the same gate as the written step.
        const label = String(input.label ?? "");
        await onProgress(`${input.status}: ${productName(label) ?? label}`);
      }
    }

    messages.push({ role: "user", content: results });

    // CHE-130: every screenshot used to stay in context for the whole walk and
    // was re-read on every iteration — a full joblander walk cost $2.31 with
    // vision nav against $0.91 text-only (COSTS.md, runs #74 vs #67).
    if (imageWindow !== undefined && Number.isFinite(imageWindow) && imageWindow >= 0) {
      const trimmed = trimImageBlocks(messages, imageWindow);
      if (trimmed > 0) {
        console.log(`[agent] trimmed ${trimmed} screenshot(s) from context (window=${imageWindow})`);
      }
    }
  }

  return { finalText, iterations, transcript, messages, costUsd, usage, endedBy };
}

const OMITTED_SCREENSHOT: Anthropic.TextBlockParam = {
  type: "text",
  text: "[screenshot omitted — an earlier step; its evidence URL is in this result's text]",
};

// CHE-130: keep only the last `keep` image blocks in the conversation, in
// conversation order (top-level blocks and blocks nested inside tool_result
// content arrays alike), and replace every older one with a text placeholder.
// Returns how many blocks it replaced.
//
// Mutates `messages` IN PLACE on purpose. A screenshot is replaced once, at the
// moment it falls out of the window, and the conversation then carries the
// placeholder for good. Rebuilding a trimmed copy every iteration would work
// too, but the prompt-cache prefix would then differ from the previous call
// exactly where the cached bytes used to be — each iteration would re-derive the
// same substitution and pay to re-cache the prefix. Mutating means the prefix
// changes once per screenshot, not once per iteration. Idempotent: a placeholder
// is a text block, so it is neither counted nor touched on later passes; text
// blocks are never modified.
export function trimImageBlocks(messages: Anthropic.MessageParam[], keep: number): number {
  // Both a message's content array and a tool_result's content array accept a
  // text block, which is all the replacement needs to write.
  type ImageSite = { parent: Anthropic.TextBlockParam[]; index: number };
  const sites: ImageSite[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    m.content.forEach((block, i) => {
      if (block.type === "image") {
        sites.push({ parent: m.content as Anthropic.TextBlockParam[], index: i });
      } else if (block.type === "tool_result" && Array.isArray(block.content)) {
        const inner = block.content;
        inner.forEach((c, j) => {
          if (c.type === "image") sites.push({ parent: inner as Anthropic.TextBlockParam[], index: j });
        });
      }
    });
  }
  const toReplace = keep >= sites.length ? [] : sites.slice(0, sites.length - keep);
  for (const { parent, index } of toReplace) parent[index] = { ...OMITTED_SCREENSHOT };
  return toReplace.length;
}

// Append a closing instruction to a conversation in a role-valid way. The agent
// loop exits with the last turn being a `user` tool_result message; appending a
// second `user` message there breaks role alternation (400). Merge the
// instruction into that trailing user turn instead.
function appendInstruction(
  messages: Anthropic.MessageParam[],
  instruction: string,
): Anthropic.MessageParam[] {
  const convo = [...messages];
  const last = convo[convo.length - 1];
  if (last && last.role === "user") {
    const block: Anthropic.TextBlockParam = { type: "text", text: instruction };
    const content: Anthropic.ContentBlockParam[] = Array.isArray(last.content)
      ? [...last.content, block]
      : [{ type: "text", text: String(last.content) }, block];
    convo[convo.length - 1] = { role: "user", content };
  } else {
    convo.push({ role: "user", content: instruction });
  }
  return convo;
}

// One extra non-tool call to coax clean JSON out of a conversation whose final
// turn didn't parse (truncation, trailing prose). Cheap recovery for the
// discovery/synthesis hand-off — the messages already carry all the context.
export async function finalizeJson(
  llm: LlmConfig,
  messages: Anthropic.MessageParam[],
  instruction: string,
  // When provided, this call's tokens/cost are added to the caller's totals —
  // finalizeJson used to be a blind spot in the cost ledger.
  usage?: UsageTotals,
): Promise<string> {
  const response = await createWithRetry(() =>
    llm.navClient.messages.create({
      model: llm.navModel,
      max_tokens: 16_000,
      messages: appendInstruction(messages, instruction),
    }),
  );
  if (usage) addUsage(usage, llm.navModel, response.usage);
  const text = response.content.find((b) => b.type === "text");
  return text && text.type === "text" ? text.text : "";
}

// Reliable structured extraction: structured outputs force the model to emit
// schema-valid JSON regardless of how the exploration ended, so we never depend
// on the model remembering to emit JSON before its iteration budget runs out
// (the dominant cause of "No journeys mapped"). Thinking is omitted — this is a
// pure extraction over context the model already gathered.
//
// A null `parsed` is NOT always an exception: `output_config` is an Anthropic
// param, and OpenRouter's Anthropic-compatible endpoint sometimes answers a
// structured request with a well-formed but empty message (no content blocks,
// zero tokens billed) instead of an error — that is exactly how prod run #19
// lost its journeys without a single line in the logs. `note` says which of the
// no-result shapes we got so the caller can surface it instead of guessing.
export interface StructuredResult<T> {
  parsed: T | null;
  note: string | null;
  costUsd: number;
  usage: UsageTotals;
}

// Replace image blocks with a text placeholder for text-only struct models —
// the extraction only needs the textual trail of the exploration.
function stripImageBlocks(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    return {
      ...m,
      content: m.content.map((block) => {
        if (block.type === "image") return { type: "text" as const, text: "[screenshot omitted]" };
        if (block.type === "tool_result" && Array.isArray(block.content)) {
          return {
            ...block,
            content: block.content.map((c) =>
              c.type === "image" ? { type: "text" as const, text: "[screenshot omitted]" } : c,
            ),
          };
        }
        return block;
      }),
    };
  });
}

export interface StructuredOptions {
  // CHE-169: when the struct model returns nothing parseable, retry once on
  // the judge model — a stronger model at the one moment the cheap one failed.
  // On only under HARNESS_TIER=judge; the cost lands in the returned usage.
  judgeFallback?: boolean;
}

export async function finalizeStructured<T>(
  llm: LlmConfig,
  messages: Anthropic.MessageParam[],
  instruction: string,
  schema: Record<string, unknown>,
  options: StructuredOptions = {},
): Promise<StructuredResult<T>> {
  const first = await structuredCall<T>(
    llm.structClient,
    llm.structModel,
    messages,
    instruction,
    schema,
  );
  if (first.parsed || !options.judgeFallback) return first;
  // A judge that is the struct model itself, or one of the GLM vision variants
  // that ignore json_schema (run #73), would only repeat the failure.
  const { judgeClient, judgeModel } = llm;
  if (!judgeClient || !judgeModel || judgeModel === llm.structModel || ignoresJsonSchema(judgeModel)) {
    return first;
  }
  console.warn(`[agent] structured extraction on ${llm.structModel} returned nothing — retrying on ${judgeModel}`);
  const second = await structuredCall<T>(judgeClient, judgeModel, messages, instruction, schema);
  const usage = emptyUsage();
  mergeUsage(usage, first.usage);
  mergeUsage(usage, second.usage);
  return {
    parsed: second.parsed,
    note: second.parsed ? null : `${first.note}; then ${second.note}`,
    costUsd: first.costUsd + second.costUsd,
    usage,
  };
}

async function structuredCall<T>(
  client: Anthropic,
  model: string,
  messages: Anthropic.MessageParam[],
  instruction: string,
  schema: Record<string, unknown>,
): Promise<StructuredResult<T>> {
  // The struct model may be text-only while the exploration ran on a vision
  // nav model (CHE-70) — image blocks in the transcript would error the call.
  const safeMessages = isVisionModel(model) ? messages : stripImageBlocks(messages);
  const response = await createWithRetry(() =>
    client.messages.create({
      model,
      max_tokens: 16_000,
      output_config: { format: { type: "json_schema", schema } },
      messages: appendInstruction(safeMessages, instruction),
    }),
  );
  const costUsd = costOf(model, response.usage);
  const usage = emptyUsage();
  addUsage(usage, model, response.usage);
  const nothing = (note: string): StructuredResult<T> => ({ parsed: null, note, costUsd, usage });

  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") {
    const u = response.usage;
    return nothing(
      `${model} returned no text block (stop=${response.stop_reason ?? "?"}, ` +
        `in=${u?.input_tokens ?? 0} out=${u?.output_tokens ?? 0} tokens)`,
    );
  }
  try {
    return { parsed: JSON.parse(text.text) as T, note: null, costUsd, usage };
  } catch {
    const m = text.text.match(/\{[\s\S]*\}/);
    if (!m) return nothing(`${model} answered with prose, not JSON`);
    try {
      return { parsed: JSON.parse(m[0]) as T, note: null, costUsd, usage };
    } catch {
      return nothing(`${model} emitted unparseable JSON (${text.text.length} chars)`);
    }
  }
}

// Resilient create: the SDK already retries twice, but a sustained overload
// mid-run would still throw and lose the whole journey. Retry transient errors
// (429/500/529) up to 5 times with capped exponential backoff, honoring
// retry-after when present. Non-transient errors (400/401) rethrow immediately.
// Exported for the judge (CHE-169), which makes its one call the same way.
export async function createWithRetry(
  fn: () => Promise<Anthropic.Message>,
  attempts = 5,
): Promise<Anthropic.Message> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      // CHE-402: every answer of every model comes back through here, so this
      // is where the model's own "&amp;" comes off — before a tool acts on the
      // words and before any of them is stored.
      return inOwnWords(await fn());
    } catch (err) {
      lastErr = err;
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      if (status === 402) {
        throw new LlmBudgetError(err instanceof Error ? err.message : String(err));
      }
      const transient = status === 429 || status === 529 || (status ?? 0) >= 500;
      if (!transient || attempt === attempts - 1) throw err;
      const retryAfter = headerSeconds(err);
      const backoff = retryAfter ?? Math.min(2 ** attempt * 2_000, 30_000);
      console.warn(`[agent] transient API error (${status}); retrying in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

/**
 * A model's answer with its own escaping taken off (src/lib/model-text.ts): the
 * input of each tool call and each text block. Thinking blocks are left exactly
 * as they came — they are signed, and they are sent back.
 */
export function inOwnWords(message: Anthropic.Message): Anthropic.Message {
  if (!Array.isArray(message?.content)) return message;
  let changed = false;
  const content = message.content.map((block) => {
    if (block.type === "tool_use") {
      const input = ownWordsDeep(block.input);
      if (JSON.stringify(input) === JSON.stringify(block.input)) return block;
      changed = true;
      return { ...block, input };
    }
    if (block.type === "text") {
      const text = ownWordsInAnswer(block.text);
      if (text === block.text) return block;
      changed = true;
      return { ...block, text };
    }
    return block;
  });
  return changed ? { ...message, content } : message;
}

function headerSeconds(err: unknown): number | null {
  if (err instanceof Anthropic.APIError) {
    const h = err.headers?.get?.("retry-after");
    const n = h ? Number(h) : NaN;
    if (Number.isFinite(n)) return n * 1_000;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function now(): string {
  return new Date().toISOString();
}

// Transcripts are audit artifacts — keep them free of anything that even looks
// like a secret. fill values containing placeholders are already safe; raw fill
// values are masked anyway, defence in depth.
function redactForAudit(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName !== "fill") return input;
  const value = String(input.value ?? "");
  const isPlaceholder = /\{\{TEST_(EMAIL|PASSWORD)\}\}/.test(value);
  return { ...input, value: isPlaceholder ? value : "[masked]" };
}
