// CHE-330 verification: a refused synthesis road does not lose the run.
//
// Runs #135, #197 and #258 walked every journey and then died in `writing`:
// api.anthropic.com answered every attempt with
//   403 {"error":{"type":"forbidden","message":"Request not allowed"}}
// and the Workflow retried the same road six times. This drives the real
// makeLlm → synthesizeVerdict path against a stubbed network: the direct
// Anthropic road refuses exactly as it did in production, and the verdict
// must come back written over OpenRouter, with the refusal recorded for us.
// It also pins the edges: our own credit (402) is not dressed up as a
// refusal, and when every road refuses the run still fails loudly rather than
// publishing something.
//
// Pure: no browser, no model, no database, no real network.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-synthesis-fallback.ts

import Anthropic from "@anthropic-ai/sdk";
import { makeLlm, openRouterTwin, refusalsOf, synthRoutesFor } from "@/agent/llm";
import { fileRouteRefusal } from "@/agent/capability-gaps";
import { synthesizeVerdict } from "@/agent/synthesis";
import type { AgentBindings, AgentEnv } from "@/agent/env";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const GEO_BLOCK = '{"error":{"type":"forbidden","message":"Request not allowed"}}';
const VERDICT = {
  oneLiner: "An interview coach.",
  whoFor: "Job seekers",
  coreValue: "Practice",
  businessModel: "Subscription",
  techSurface: "Next.js",
  criticalPaths: ["Sign in"],
  ifItBreaks: "Nobody can practise.",
  bottomLine: "Everything we walked works.",
  findings: [],
};

type Answer = { status: number; body: string; headers?: Record<string, string> };
interface Seen {
  host: string;
  path: string;
  model?: string;
}

// Installs a fetch that answers by host, and returns what it was asked.
// A list answers successive calls in order, and its last entry repeats.
function stubNetwork(byHost: Record<string, Answer | Answer[]>): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    let model: string | undefined;
    if (typeof init?.body === "string") {
      try {
        model = (JSON.parse(init.body) as { model?: string }).model;
      } catch {
        // not JSON
      }
    }
    seen.push({ host: url.host, path: url.pathname, model });
    if (url.pathname === "/cdn-cgi/trace") return new Response("colo=HKG\nloc=HK\n", { status: 200 });
    const entry = byHost[url.host];
    const a = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
    if (!a) return new Response('{"error":{"message":"unexpected host"}}', { status: 599 });
    return new Response(a.body, {
      status: a.status,
      headers: { "content-type": "application/json", ...(a.headers ?? {}) },
    });
  }) as typeof fetch;
  return seen;
}

function ok(model: string, text: string = JSON.stringify(VERDICT)): Answer {
  return {
    status: 200,
    body: JSON.stringify({
      id: "msg_stub",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50, cost: 0.02 },
    }),
  };
}

const refuse: Answer = { status: 403, body: GEO_BLOCK, headers: { "cf-ray": "8f00000000000000-HKG" } };

// Production's secrets as the ledger shows them: DeepSeek walks, Opus writes.
const bindings = {
  ANTHROPIC_API_KEY: "an-test",
  OPENROUTER_API_KEY: "or-test",
  ANTHROPIC_NAV_MODEL: "deepseek/deepseek-v4-flash-vision-exp",
  ANTHROPIC_SYNTH_MODEL: "claude-opus-4-8",
} as unknown as AgentBindings;

const env = {
  bindings,
  db: {
    run: {
      findUnique: async () => ({ focusAreas: null, credentialsRejected: false, rejectedAccounts: null, testAccounts: null }),
    },
    journey: {
      findMany: async () => [
        {
          title: "Sign in",
          status: "ok",
          summary: "Signed in.",
          carriedFromRunId: null,
          steps: [
            {
              label: "Open /login",
              status: "ok",
              attempted: "Opened the login page",
              observed: "The form rendered",
              consoleLog: null,
              networkLog: null,
              unverifiedReason: null,
              actions: null,
            },
          ],
        },
      ],
    },
  },
} as unknown as AgentEnv;

const anatomy = { pages: ["/login"], actions: [], services: [], tech: {} };

async function synth() {
  return synthesizeVerdict({ env, llm: makeLlm(bindings), runId: "run_stub", anatomy });
}

async function main() {
  // (1) The production refusal, verbatim, on the first road. First, so that
  // on code without the fallback this is what fails, not a missing helper.
  {
    const seen = stubNetwork({ "api.anthropic.com": refuse, "openrouter.ai": ok("anthropic/claude-opus-4.8") });
    let result: Awaited<ReturnType<typeof synth>> | null = null;
    let error = "";
    try {
      result = await synth();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    check("403 on the direct road: the verdict is still written", result?.bottomLine === VERDICT.bottomLine, error || undefined);
    const asked = seen.filter((s) => s.path.endsWith("/messages")).map((s) => `${s.host}:${s.model}`);
    check(
      "the fallback asked OpenRouter for the same model",
      asked.join(" | ") === "api.anthropic.com:claude-opus-4-8 | openrouter.ai:anthropic/claude-opus-4.8",
      asked.join(" | "),
    );
    const r = result as (typeof result & { model?: string; refusals?: { status: number; colo: string | null; loc: string | null; error: string }[] }) | null;
    check("the result names the model that wrote it", r?.model === "anthropic/claude-opus-4.8", String(r?.model));
    const refusal = r?.refusals?.[0];
    check(
      "the refusal is recorded with its status, words and location",
      r?.refusals?.length === 1 &&
        refusal?.status === 403 &&
        refusal.error.includes("Request not allowed") &&
        refusal.colo === "HKG" &&
        refusal.loc === "HK",
      JSON.stringify(r?.refusals),
    );
    check(
      "nothing about the road reaches what the customer reads",
      !JSON.stringify({ b: result?.bottomLine, f: result?.findings, l: result?.appLens }).match(/claude|openrouter|anthropic|forbidden/i),
    );
  }

  // (2) The road names: the fallback asks OpenRouter for the same model.
  check("twin: claude-opus-4-8 → anthropic/claude-opus-4.8", openRouterTwin("claude-opus-4-8") === "anthropic/claude-opus-4.8");
  check("twin: claude-sonnet-4-6 → anthropic/claude-sonnet-4.6", openRouterTwin("claude-sonnet-4-6") === "anthropic/claude-sonnet-4.6");
  check("twin: an OpenRouter id has none", openRouterTwin("deepseek/deepseek-v4-flash") === null);

  // (3) Our own credit is not a refusal: 402 stays loud and no second road is tried.
  {
    const seen = stubNetwork({
      "api.anthropic.com": { status: 402, body: '{"type":"error","error":{"type":"billing_error","message":"credit"}}' },
      "openrouter.ai": ok("anthropic/claude-opus-4.8"),
    });
    let threw = false;
    try {
      await synth();
    } catch {
      threw = true;
    }
    check("402 throws and never reaches the second road", threw && !seen.some((s) => s.host === "openrouter.ai"));
  }

  // (4) Every road refuses: the run fails as before — nothing is invented.
  {
    stubNetwork({ "api.anthropic.com": refuse, "openrouter.ai": { status: 403, body: '{"error":{"message":"no","code":403}}' } });
    let caught: unknown = null;
    try {
      await synth();
    } catch (err) {
      caught = err;
    }
    check(
      "every road refused: synthesis throws the last road's own error",
      caught instanceof Error && caught.message.startsWith("403 ") && caught.message.includes('"code":403'),
      String(caught),
    );
    const refused = refusalsOf(caught).map((r) => `${r.model}:${r.status}`);
    check(
      "every road refused: both refusals travel with the error, for our board",
      refused.join(" | ") === "claude-opus-4-8:403 | anthropic/claude-opus-4.8:403",
      refused.join(" | "),
    );
  }

  // (4a) The fallback fails some other way (a 500): the first road's refusal
  // still travels with whatever error ends the run.
  {
    stubNetwork({ "api.anthropic.com": refuse, "openrouter.ai": { status: 500, body: '{"error":{"message":"upstream","code":500}}' } });
    let caught: unknown = null;
    try {
      await synth();
    } catch (err) {
      caught = err;
    }
    const refused = refusalsOf(caught).map((r) => `${r.model}:${r.status}`);
    check("fallback 500: the first road's 403 is still attached to the error", refused.join(" | ") === "claude-opus-4-8:403", refused.join(" | ") || String(caught));
  }

  // (4c) The bottom-line rewrite rides the same roads: its refusal is kept too.
  {
    const leaky = JSON.stringify({ ...VERDICT, bottomLine: "The signup button did nothing in our test browser." });
    stubNetwork({
      "api.anthropic.com": refuse,
      "openrouter.ai": [ok("anthropic/claude-opus-4.8", leaky), ok("anthropic/claude-opus-4.8", "Sign-up could not be confirmed this run.")],
    });
    const r = (await synth()) as Awaited<ReturnType<typeof synth>> & { refusals?: unknown[] };
    check(
      "rewrite on the fallback: both refusals (synthesis and rewrite) are returned",
      r.refusals?.length === 2 && r.bottomLine === "Sign-up could not be confirmed this run.",
      `${r.refusals?.length} refusals, bottom line: ${r.bottomLine}`,
    );
  }

  // (4b) Filing the refusal cannot fail the step that just wrote a verdict.
  {
    const broken = { ...env, db: { run: { findUnique: async () => { throw new Error("D1 unavailable"); } } } } as unknown as AgentEnv;
    let threw = false;
    let said = "";
    try {
      said = await fileRouteRefusal(broken, "run_stub", { refusals: [], answeredBy: "anthropic/claude-opus-4.8" });
    } catch {
      threw = true;
    }
    check("a database outage while filing is reported, not thrown", !threw && said.includes("D1 unavailable"), said);
  }

  // (5) A road needs its key: without OpenRouter there is only the primary.
  {
    const primary = new Anthropic({ apiKey: "an-test" });
    check(
      "no OpenRouter key → one road",
      synthRoutesFor("claude-opus-4-8", { ...bindings, OPENROUTER_API_KEY: undefined }, primary).length === 1,
    );
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
