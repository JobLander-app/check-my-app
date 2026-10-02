// Phase 3 — Discovery (CF agent). The LLM explores the target through browser
// tools and returns proposed journeys + app anatomy as JSON. Client scope
// hints/notes are authoritative text in the system prompt (recursion guard).

import type { Browser } from "@cloudflare/playwright";
import type { AppAnatomy } from "@/lib/types";
import { runAgentLoop, finalizeStructured, type TranscriptEntry } from "./core";
import { accountRejected, knownUrlsFrom, prepareAgentPage, type ToolEnv } from "./tools";
import { newAgentContext, newAgentPage, closeAgentContext } from "./browser";
import { extensionBrowserFor } from "./extension-browser";
import { shapeExtensionDiscovery } from "./extension-discovery";
import {
  DISCOVERY_ITERATIONS,
  DISCOVERY_ITERATIONS_WITH_MEMORY,
  discoverySystem,
  type KnownMap,
} from "./instructions";
import { discoveryLeanEnabled, harnessMode, putScreenshot, type AgentEnv } from "./env";
import { discoveryLoopMode } from "./discovery-mode";
import type { AppKnowledge } from "./knowledge";
import type { RawMetric } from "./journey-metrics";
import { emptyUsage, mergeUsage, type LlmConfig, type UsageTotals } from "./llm";
import { credentialToolEnv } from "./credentials";
import { DEFAULT_ACCOUNT_LABEL } from "@/lib/test-accounts";
import { parseAllowedOrigins } from "@/lib/allowed-origins";

export interface RunInput {
  // CHE-100: present for every real run (the workflow spreads the Run row in).
  // Optional only because the type predates it and a couple of callers build a
  // bare input for probes; without it the credential state cannot be persisted.
  id?: string;
  targetUrl: string;
  testEmail: string | null;
  testPasswordEnc: string | null;
  // CHE-322: the named accounts snapshotted onto the run (Run.testAccounts).
  // Optional: a probe that builds a bare input has none.
  testAccounts?: string | null;
  // CHE-372: Run.storePasswordEnc — entered by code on a store's /password
  // page, never shown to the model. Optional for the same reason as above.
  storePasswordEnc?: string | null;
  scopeHints: string | null;
  userNotes: string | null;
  // CHE-81: owner's priority concerns, verbatim.
  focusAreas: string | null;
  // CHE-373: Run.allowedOrigins (JSON). Optional: a probe that builds a bare
  // input has none, and none is the target's origin only.
  allowedOrigins?: string | null;
  // CHE-90: CRUD lifecycle permission + the marker created records carry.
  writeAllowed?: boolean;
  testMarker?: string;
}

export interface ProposedJourney {
  title: string;
  steps: string[];
  extensionScenario?: "interview" | "practice" | "practice-extension";
  // CHE-235: "app" for a journey that crosses the product, or the page it
  // belongs to ("/settings"). A page holds several journeys, and identity is
  // matched within a surface, so this is part of what the journey IS rather
  // than decoration. Absent on a re-walk proposal — the catalog already knows.
  surface?: string | null;
  // CHE-235: what the model says this journey costs its user, before any of it
  // is believed (journey-metrics.ts decides what may be stored). Concrete types
  // rather than `unknown`: this object crosses a Workflow step boundary and has
  // to survive being serialised.
  metric?: ProposedMetric | null;
}

/** A price/conversion answer as it arrives from the model, coerced, not judged. */
export interface ProposedMetric {
  price: number | null;
  conversion: number | null;
  note: string;
}

// CHE-133: the map from the last full check of a watched app, and the two
// iteration budgets (55 from scratch, 20 when confirming). They live in
// instructions.ts because that module is pure and the verify script asserts on
// them from Node; re-exported here so discovery's contract stays in one place.
export { DISCOVERY_ITERATIONS, DISCOVERY_ITERATIONS_WITH_MEMORY, type KnownMap };

export interface DiscoveryResult {
  journeys: ProposedJourney[];
  anatomy: AppAnatomy;
  transcript: TranscriptEntry[];
  costUsd: number;
  usage: UsageTotals;
  // Extraction trouble, in plain English, for the run's live feed. Discovery
  // never touches the DB (it stays a pure function of the exploration), so the
  // workflow turns these into events — a silent extraction failure is how run
  // #19 shipped "all good" over zero journeys.
  notes: string[];
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export async function discoverApp(args: {
  env: AgentEnv;
  llm: LlmConfig;
  browser: Browser;
  run: RunInput;
  // CHE-133: when present, discovery confirms this map instead of redrawing
  // it — a shorter prompt-driven pass and a smaller iteration budget. The
  // extraction ladder below is unchanged: the model's output is validated the
  // same way whether it explored from zero or from memory.
  known?: KnownMap;
  // CHE-136: what earlier runs settled about this app, rendered into the
  // prompt after the client's instructions. Absent = the prompt as before.
  knowledge?: AppKnowledge | null;
  // CHE-171: addresses the run already knows the product publishes (the
  // survey's pages, CHE-132; the known map's, CHE-133). A 404 on an address
  // outside this set — and outside everything discovery reads on the way —
  // is not a defect.
  publishedUrls?: string[];
  onLiveScreenshot?: (url: string) => Promise<void>;
  onProgress?: (note: string) => Promise<void>;
}): Promise<DiscoveryResult> {
  const { env, llm, browser, run, known, knowledge, publishedUrls, onLiveScreenshot, onProgress } = args;
  const empty: DiscoveryResult = {
    journeys: [],
    anatomy: { pages: [], actions: [], services: [], tech: {} },
    transcript: [],
    costUsd: 0,
    usage: emptyUsage(),
    notes: [],
  };
  const notes: string[] = [];
  const note = (text: string) => {
    console.error(`[discovery] ${text}`);
    notes.push(text);
  };

  // CHE-135: discovery is exploration, not reasoning-critical — its output is
  // validated by the structured extraction below regardless of how the
  // exploration went. Lean mode drops adaptive thinking and keeps screenshot
  // JPEGs out of the context (E5 in COSTS.md, the discovery counterpart of E3
  // and CHE-130). DISCOVERY_LEAN=off restores the previous behaviour for the
  // A/B without a deploy.
  const mode = discoveryLoopMode(discoveryLeanEnabled(env.bindings), llm.navVision);
  if (mode.thinking === "off") {
    console.log("[discovery] lean mode: thinking off, no screenshots in context");
  }

  // CHE-169: under the judge tier, an extraction the struct model could not
  // produce is retried once on the judge model instead of falling to the
  // free-text scrape. Off by default — the ladder below is unchanged.
  const structOptions = { judgeFallback: harnessMode(env.bindings).judge };

  // CHE-193: on our own hosts the context announces itself on the requests the
  // web half guards, and on nothing else (CHE-212; self-hosts.ts).
  const context = await newAgentContext(browser, run.targetUrl, env.bindings);
  const page = await newAgentPage(browser, context);
  const extension = extensionBrowserFor(browser);

  const toolEnv: ToolEnv = {
    page,
    extension,
    targetOrigin: originOf(extension?.identity.targetUrl ?? run.targetUrl),
    // CHE-373: the origins the owner allowed besides the target's.
    allowedOrigins: parseAllowedOrigins(run.allowedOrigins, env.bindings.SELF_CHECK_HOSTS),
    // CHE-193: lets the click gate know which extra hosts are ours.
    selfCheckHosts: env.bindings.SELF_CHECK_HOSTS,
    visionScreenshots: mode.visionScreenshots,
    // Discovery only maps the app — creation belongs to the walk.
    writeAllowed: false,
    // Decrypted only here, in-memory; the LLM only ever sees {{TEST_PASSWORD}}
    // (and, CHE-322, {{TEST_PASSWORD:<label>}}).
    // CHE-100: discovery explores, and exploring reaches login forms. If the
    // credential we hold is turned away here, the walk must inherit that — the
    // one-attempt rule is per run, not per phase.
    ...(await credentialToolEnv(env, run)),
    networkLog: [],
    consoleLog: [],
    knownUrls: knownUrlsFrom(run.targetUrl, publishedUrls),
    onScreenshot: async (buffer) => {
      if (extension && !run.id) throw new Error("Extension evidence requires a run owner");
      const { storageUrl } = await putScreenshot(env, buffer, extension ? { privateRunId: run.id! } : "public");
      if (!extension) await onLiveScreenshot?.(storageUrl);
      return storageUrl;
    },
  };
  await prepareAgentPage(toolEnv);

  try {
    if (extension?.identity.extensionId === "hafhjepjihcimcljkdphpinannbdmnhf" && toolEnv.testEmail && toolEnv.testPassword && !accountRejected(toolEnv.credentials, DEFAULT_ACCOUNT_LABEL)) {
      await extension.tool(toolEnv, "extension_account_preflight", {});
    }
    const result = await runAgentLoop({
      system: discoverySystem(run, known, knowledge),
      task: extension
        ? `Target product: the installed extension ${extension.identity.name}. Begin with extension_open and explore its actual popup. The Store link is metadata. The target tab is ${extension.identity.targetUrl}; it may be a synthetic companion, whose content is not part of the product. Map both the extension controls and the behavior they add to its target page.`
        : `Target app: ${run.targetUrl}\nStart by navigating there, read the page, then explore.`,
      env: toolEnv,
      llm,
      maxIterations: known ? DISCOVERY_ITERATIONS_WITH_MEMORY : DISCOVERY_ITERATIONS,
      thinking: mode.thinking,
      imageWindow: mode.imageWindow,
      onProgress,
    });

    let costUsd = result.costUsd;
    const usage = result.usage;
    // The first native discovery promoted the audio fixture and guessed web
    // domains into product anatomy. Extraction receives only reads of product
    // surfaces, excluding fixture diagnostics and the model's own speculation.
    const extractionMessages = extension ? [{ role: "user" as const, content:
      `Installed product: ${extension.identity.name}. Observed product surfaces:\n${extension.discoveryObservations()}`,
    }] : result.messages;

    // Guaranteed structured extraction. The model frequently spends its whole
    // iteration budget exploring and never emits the closing JSON on its own —
    // so instead of hoping its final text parses, we always run a structured
    // pass over the exploration context that forces schema-valid journeys +
    // anatomy. This is what makes discovery reliable instead of coin-flip.
    // A failure in the extraction (bad schema, transient API) must NEVER throw
    // out of the discovery step — that would make Cloudflare retry the entire
    // ~10-min exploration from scratch. Catch and fall back to scraping the
    // model's free-text final answer instead.
    let parsed: ShapedDiscovery | null = null;
    try {
      const extracted = await finalizeStructured<RawDiscovery>(
        llm,
        extractionMessages,
        "Based ONLY on what you actually explored above, output the discovery result: " +
          "3-5 concrete user journeys (each a title + ordered steps) covering the app's core " +
          "flows (e.g. sign up / log in, the primary value action, account/settings), plus the " +
          "app anatomy (pages, actions, external services, tech as key/value pairs). Every app " +
          "has at least one core journey — never return an empty journeys array.",
        DISCOVERY_SCHEMA,
        structOptions,
      );
      costUsd += extracted.costUsd;
      mergeUsage(usage, extracted.usage);
      if (extracted.parsed) parsed = shapeDiscovery(extracted.parsed);
      else note(`structured extraction returned nothing — ${extracted.note}`);
    } catch (err) {
      note(`structured extraction failed: ${errText(err)}`);
    }
    if (!parsed) {
      parsed = extension ? null : parseDiscoveryJson(result.finalText);
      note(
        parsed
          ? "fell back to the JSON in the model's free-text answer"
          : "the model's free-text answer had no parseable JSON either",
      );
    }

    // Still no journeys → one focused structured retry dedicated to journeys.
    // This also runs when nothing parsed at all: gating it on a non-null
    // `parsed` is what let run #19 fall through every rung of this ladder and
    // still report a clean verdict over zero journeys.
    if (!parsed || parsed.journeys.length === 0) {
      try {
        const j = await finalizeStructured<{ journeys?: RawDiscovery["journeys"] }>(
          llm,
          extractionMessages,
          "You proposed no user journeys — that is wrong. Propose 3-5 user journeys a real " +
            "user would take, based only on what you saw. Each is a title plus ordered steps.",
          JOURNEYS_SCHEMA,
          structOptions,
        );
        costUsd += j.costUsd;
        mergeUsage(usage, j.usage);
        const recovered = shapeDiscovery({ journeys: j.parsed?.journeys ?? [] }).journeys;
        if (recovered.length > 0) {
          parsed = { anatomy: parsed?.anatomy ?? empty.anatomy, journeys: recovered };
        } else {
          note(`journeys retry recovered none — ${j.note ?? "the model returned an empty list"}`);
        }
      } catch (err) {
        note(`journeys retry failed: ${errText(err)}`);
      }
    }
    if (!parsed?.journeys.length) {
      note("no journeys could be extracted — this run walks nothing and verifies nothing");
    }
    const shaped = extension ? shapeExtensionDiscovery(extension.identity, extension.discoveryObservations(), parsed?.journeys ?? []) : parsed ?? empty;
    return { ...shaped, transcript: result.transcript, costUsd, usage, notes };
  } finally {
    await closeAgentContext(browser, context);
  }
}

interface RawDiscovery {
  journeys?: Array<{
    title?: string;
    steps?: string[];
    // CHE-235: where the journey lives, and what it costs its user.
    surface?: unknown;
    price?: unknown;
    conversion?: unknown;
    metricNote?: unknown;
  }>;
  anatomy?: {
    pages?: unknown;
    actions?: unknown;
    services?: unknown;
    // structured outputs can't express an open string map, so `tech` comes back
    // as an array of {key,value} pairs; free-text parses may send a record.
    tech?: Array<{ key?: string; value?: string }> | Record<string, string>;
  };
}

type ShapedDiscovery = Omit<DiscoveryResult, "transcript" | "costUsd" | "usage" | "notes">;

// A model may answer "6", 6 or nothing at all; anything else is nothing.
function numberOrNull(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
}

function techToRecord(tech: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(tech)) {
    for (const p of tech) {
      if (p && typeof p === "object" && typeof p.key === "string" && typeof p.value === "string") {
        out[p.key] = p.value;
      }
    }
  } else if (tech && typeof tech === "object") {
    for (const [k, v] of Object.entries(tech as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

// Normalize a raw (structured-output or hand-parsed) discovery object into the
// DiscoveryResult shape: at most 5 titled journeys, anatomy fields defaulted.
// normalizeAnatomy (workflow) re-coerces anatomy again before persistence, so
// loose shapes here are safe.
function shapeDiscovery(raw: RawDiscovery): ShapedDiscovery {
  const a = raw.anatomy ?? {};
  return {
    journeys: (raw.journeys ?? [])
      .filter((j) => j.title)
      .slice(0, 5)
      .map((j) => ({
        title: String(j.title),
        steps: (j.steps ?? []).map(String),
        // CHE-235: passed through as the model wrote them. Nothing is trusted
        // here — journey-metrics.ts decides what may be stored, against what
        // the catalog already holds.
        surface: typeof j.surface === "string" ? j.surface : null,
        metric: {
          price: numberOrNull(j.price),
          conversion: numberOrNull(j.conversion),
          note: typeof j.metricNote === "string" ? j.metricNote : "",
        },
      })),
    anatomy: {
      pages: (Array.isArray(a.pages) ? a.pages : []) as AppAnatomy["pages"],
      actions: (Array.isArray(a.actions) ? a.actions : []) as AppAnatomy["actions"],
      services: (Array.isArray(a.services) ? a.services : []) as AppAnatomy["services"],
      tech: techToRecord(a.tech),
    },
  };
}

// Fallback only — used when structured extraction returns nothing and we scrape
// the model's final free-text for a JSON object. The object usually arrives in
// a ```json fence and is often followed by prose, so try the fenced body and
// the first *balanced* {...} before the old first-brace-to-last-brace grab:
// that one swallows any trailing sign-off containing a brace and then fails to
// parse, throwing away journeys the model did emit.
function parseDiscoveryJson(text: string): ShapedDiscovery | null {
  const start = text.indexOf("{");
  const candidates = [
    text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1],
    start >= 0 ? balancedObject(text, start) : null,
    start >= 0 ? text.slice(start, text.lastIndexOf("}") + 1) : null,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return shapeDiscovery(JSON.parse(candidate) as RawDiscovery);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

// The first balanced {...} starting at `from`, ignoring braces inside strings.
function balancedObject(text: string, from: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth += 1;
    else if (c === "}" && (depth -= 1) === 0) return text.slice(from, i + 1);
  }
  return null;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Strict JSON schemas for structured outputs. additionalProperties:false and
// full required lists are mandatory for the json_schema output format.
const JOURNEY_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  // CHE-235: price/conversion/surface are required so the model answers for
  // every journey rather than for the easy ones. What it answers is then
  // policed by journey-metrics.ts — a changed number with no named change is
  // refused — so "required" costs nothing in trust.
  required: ["title", "steps", "surface", "price", "conversion", "metricNote"],
  properties: {
    title: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
    surface: { type: "string" },
    price: { type: "integer" },
    conversion: { type: "integer" },
    metricNote: { type: "string" },
  },
};

const JOURNEYS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["journeys"],
  properties: {
    journeys: { type: "array", items: JOURNEY_ITEM_SCHEMA },
  },
};

const DISCOVERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["journeys", "anatomy"],
  properties: {
    journeys: { type: "array", items: JOURNEY_ITEM_SCHEMA },
    anatomy: {
      type: "object",
      additionalProperties: false,
      required: ["pages", "actions", "services", "tech"],
      properties: {
        pages: { type: "array", items: { type: "string" } },
        actions: { type: "array", items: { type: "string" } },
        services: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "role"],
            properties: { name: { type: "string" }, role: { type: "string" } },
          },
        },
        tech: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["key", "value"],
            properties: { key: { type: "string" }, value: { type: "string" } },
          },
        },
      },
    },
  },
};
