// Agent worker runtime environment (CHE-14/15).
//
// The agent runs as a separate Cloudflare Worker from the web app (two-worker
// topology). Its dependencies — D1, R2, Browser Rendering, the Anthropic key —
// arrive as bindings/secrets on the Workflow env, not as module singletons.
// Phase functions receive an AgentEnv so the same logic is testable and the
// run is durable across Workflow steps.

import { getDb } from "@/lib/db";
import { putObject } from "@/lib/storage";
import type { ExtensionRunner } from "./extension-runner";

export interface AgentBindings {
  DB: D1Database;
  EVIDENCE: R2Bucket;
  MYBROWSER: Fetcher;
  EXTENSION_RUNNER?: DurableObjectNamespace<ExtensionRunner>;
  CHECK_RUN: Workflow;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_NAV_MODEL?: string;
  ANTHROPIC_SYNTH_MODEL?: string;
  // Cheap-model epic: models with a provider prefix ("z-ai/glm-5.2") route
  // through OpenRouter's Anthropic-compatible endpoint with this key.
  OPENROUTER_API_KEY?: string;
  // CHE-168: nav model routing without a deploy, so a candidate model can be
  // spiked in production by changing secrets. ANTHROPIC_NAV_VISION "on" sends
  // the nav model screenshots, "off" keeps them out of its context, unset →
  // the isVisionModel heuristic in llm.ts. ANTHROPIC_STRUCT_MODEL names the
  // model structured extraction runs on; unset → the text sibling of a vision
  // nav model, else the nav model itself.
  ANTHROPIC_NAV_VISION?: string;
  ANTHROPIC_STRUCT_MODEL?: string;
  // Linear OAuth app creds (CHE-68): freshLinearToken refreshes the owner's
  // 24h access tokens with these. Absent = tokens die a day after connect.
  LINEAR_CLIENT_ID?: string;
  LINEAR_CLIENT_SECRET?: string;
  // Verdict-ready notifications (Resend). All optional — absent = log-only.
  EMAIL_API_KEY?: string;
  EMAIL_FROM?: string;
  // CHE-226: where replies to our mail go (a routed, read mailbox).
  EMAIL_REPLY_TO?: string;
  // Public web origin for links in emails, e.g. https://checkmyapp.dev
  APP_URL?: string;
  // CHE-130: how many recent screenshots the walking loop keeps in the model's
  // context. Unset → 3. "off" → unlimited, the pre-CHE-130 behaviour, so an A/B
  // can be rolled back with a var change instead of a deploy. A positive
  // integer → that many. Anything else → the default 3.
  WALK_IMAGE_WINDOW?: string;
  // CHE-133: whether a full run of a watched app gives discovery the map from
  // the last full check. Unset → on. "off" → every full run maps from scratch,
  // the pre-CHE-133 behaviour — an A/B rollback without a deploy, the same
  // pattern as WALK_IMAGE_WINDOW (CHE-130). Anything else → on.
  DISCOVERY_MEMORY?: string;
  // CHE-135: whether discovery runs lean — adaptive thinking off and no
  // screenshot JPEG in the model's context. Unset → on. "off" → the pre-CHE-135
  // discovery (thinking on, every screenshot in context) — the A/B rollback
  // without a deploy, the same pattern as DISCOVERY_MEMORY (CHE-133) and
  // WALK_IMAGE_WINDOW (CHE-130). Anything else → on.
  DISCOVERY_LEAN?: string;
  // CHE-169: the smart harness tier. Unset or "off" → today's walk byte for
  // byte (every screenshot in context when the nav model can see, no second
  // opinion). "vision-on-demand" → the walk runs text-only and a screenshot
  // enters the model's context only at a moment of judgment (an inert click,
  // an error response, a media page, or the model asking to look).
  // "judge" → that, plus a second model call on every broken / exposed /
  // confusing step before it is written. Anything else → off: a typo must
  // not silently change what a customer is told.
  HARNESS_TIER?: string;
  // CHE-169: the model that gives the second opinion. Unset → the nav model
  // (no new provider, no new key). Set to a Claude id to judge on Anthropic
  // while navigating on OpenRouter.
  ANTHROPIC_JUDGE_MODEL?: string;
  // CHE-193: extra hosts that count as OURS, comma-separated (a preview or
  // staging deploy). checkmyapp.dev and its subdomains are always ours. A run
  // targeting one of these hosts announces itself with the
  // x-checkmyapp-checker header — on the mutating requests to that host only,
  // never on a page's subresources (CHE-212) — and is refused every
  // create/mark control —
  // the self-check of 2026-09-05 (run #146) created two real runs on a
  // stranger's app and graded a stranger's verdict. Unset → production only.
  SELF_CHECK_HOSTS?: string;
  // CHE-389: the session host — a browser a person signed in to, for products
  // whose sign-in we cannot perform (the Shopify admin's has a captcha). A run
  // of an app whose kind is "session" works there, through the host's session
  // server: its address, the Cloudflare Access service token that lets the
  // request reach it, and the server's own bearer token. All four or the kind
  // cannot run (session-browser.ts).
  SESSION_HOST_URL?: string;
  SESSION_ACCESS_CLIENT_ID?: string;
  SESSION_ACCESS_CLIENT_SECRET?: string;
  SESSION_SERVER_TOKEN?: string;
}

export interface AgentEnv {
  bindings: AgentBindings;
  db: ReturnType<typeof getDb>;
}

export function makeAgentEnv(bindings: AgentBindings): AgentEnv {
  return { bindings, db: getDb(bindings) };
}

const DEFAULT_WALK_IMAGE_WINDOW = 3;

// CHE-130: parse WALK_IMAGE_WINDOW. `undefined` means "do not trim" and is
// returned only for an explicit "off" — a typo must not silently switch the
// walk back to the $2.31 behaviour, so it falls to the default instead.
export function walkImageWindow(bindings: Pick<AgentBindings, "WALK_IMAGE_WINDOW">): number | undefined {
  const raw = bindings.WALK_IMAGE_WINDOW?.trim();
  if (!raw) return DEFAULT_WALK_IMAGE_WINDOW;
  if (raw.toLowerCase() === "off") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_WALK_IMAGE_WINDOW;
}

// CHE-133: parse DISCOVERY_MEMORY. Only an explicit "off" disables memory —
// a typo must not silently put every watch back on the 55-iteration map.
export function discoveryMemoryEnabled(bindings: Pick<AgentBindings, "DISCOVERY_MEMORY">): boolean {
  return bindings.DISCOVERY_MEMORY?.trim().toLowerCase() !== "off";
}

// CHE-135: parse DISCOVERY_LEAN. Only an explicit "off" restores the heavier
// discovery — a typo must not silently put thinking and screenshots back into
// every discovery call.
export function discoveryLeanEnabled(bindings: Pick<AgentBindings, "DISCOVERY_LEAN">): boolean {
  return bindings.DISCOVERY_LEAN?.trim().toLowerCase() !== "off";
}

// CHE-169: what the harness spends on. Two independent switches, ordered as
// tiers because the second only makes sense on top of the first: a judge that
// never gets to see the page is a judge with one eye closed.
export interface HarnessMode {
  // Screenshots enter the model's context on demand, not on every capture.
  visionOnDemand: boolean;
  // A second model call adjudicates every negative step before it is written.
  judge: boolean;
}

// CHE-169: parse HARNESS_TIER. Only the two exact tier names turn anything on
// — the default is the walk as it runs today, so an unset var, a typo or a
// stray value all leave the product exactly as it was (the WALK_IMAGE_WINDOW
// pattern, CHE-130, applied to a switch that changes what the customer reads).
export function harnessMode(bindings: Pick<AgentBindings, "HARNESS_TIER">): HarnessMode {
  const raw = bindings.HARNESS_TIER?.trim().toLowerCase() ?? "";
  if (raw === "vision-on-demand") return { visionOnDemand: true, judge: false };
  if (raw === "judge") return { visionOnDemand: true, judge: true };
  return { visionOnDemand: false, judge: false };
}

// Store a screenshot in R2, content-addressed. Returns the web evidence URL.
export async function putScreenshot(
  env: AgentEnv,
  buffer: Uint8Array,
  visibility: "public" | { privateRunId: string } = "public",
): Promise<{ storageUrl: string; sha256: string }> {
  const hash = await crypto.subtle.digest("SHA-256", buffer as BufferSource);
  const sha256 = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const prefix = visibility === "public" ? "" : `private/runs/${visibility.privateRunId}/`;
  const storageUrl = await putObject(env.bindings.EVIDENCE, `${prefix}screenshots/${sha256}.png`, buffer);
  return { storageUrl, sha256 };
}

// Store a text artifact (transcript, generated spec) in R2.
export async function putText(
  env: AgentEnv,
  key: string,
  content: string,
): Promise<string> {
  return putObject(env.bindings.EVIDENCE, key, content);
}
