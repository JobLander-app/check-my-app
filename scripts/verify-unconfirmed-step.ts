// CLAUDE.md rule 8: a step the walker marked as our own incapacity
// (unverifiedReason "our_capability") is not evidence about the product, so
// the model that writes the verdict must not be handed its observed text.
//
// Securify's daily run on 2026-10-06 (run cmuxar8l60007x50np0ulabt5) skipped
// "Apply visit filters" as our_capability, and its observed text described the
// filter chips as misbehaving. The bottom line then published that as a fact
// about the merchant's app — with no finding behind it. This drives the real
// synthesizeVerdict against a stubbed network and reads what the model was
// sent: that step's words must not be in it, what was tried must be.
//
// Pure: no browser, no model, no database, no real network.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-unconfirmed-step.ts

import { makeLlm } from "@/agent/llm";
import { UNCONFIRMED_STEP, synthesizeVerdict } from "@/agent/synthesis";
import type { AgentBindings, AgentEnv } from "@/agent/env";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// The production step, verbatim.
// Model-written too, so it can carry the claim (Codex on #294).
const ATTEMPTED = 'Clicked each filter chip, but "All visits" never cleared "VPN Only".';
const LABEL = "Apply visit filters (All visits / Blocked / Allowed / VPN Only / Grouped)";
const OBSERVED =
  'Blocked/Allowed fire /api/logs with status=… and return 200; VPN Only adds vpn=true; "Grouped" toggles to "Group by IP". ' +
  'But the chips behave as an additive set, not one choice: with "VPN Only" on, clicking "All visits" issues no request and ' +
  'leaves the chip on, so the feed stays "No recent activity to display" even though the store has visits — two chips look ' +
  'selected at once and the only way out is toggling "VPN Only" off.';
const OK_OBSERVED = 'Page shows h1 "IP Management" and the Recent Activity feed with real rows.';

const bindings = {
  ANTHROPIC_API_KEY: "an-test",
  ANTHROPIC_NAV_MODEL: "claude-sonnet-4-6",
  ANTHROPIC_SYNTH_MODEL: "claude-opus-4-8",
} as unknown as AgentBindings;

function step(order: number, status: string, attempted: string, observed: string, unverifiedReason: string | null) {
  return {
    label: unverifiedReason === "our_capability" ? LABEL : `Step ${order}`,
    status,
    attempted,
    observed,
    consoleLog: unverifiedReason === "our_capability" ? "[error] chip handler" : null,
    networkLog: unverifiedReason === "our_capability" ? "GET /api/logs?vpn=true 200" : null,
    unverifiedReason,
    actions: null,
  };
}

const env = {
  bindings,
  db: {
    run: {
      findUnique: async () => ({ focusAreas: null, credentialsRejected: false, rejectedAccounts: null, testAccounts: null }),
    },
    journey: {
      findMany: async () => [
        {
          title: "Manage Blocked and Allowed IP Addresses",
          status: "partial",
          // Written from the same walk, the summary repeats the step's claim
          // (Codex on #294).
          summary: "The IP page loads, but the visit filters behave as additive toggles and the feed goes blank.",
          carriedFromRunId: null,
          steps: [
            step(0, "ok", "Opened Block IPs", OK_OBSERVED, null),
            step(1, "skipped", ATTEMPTED, OBSERVED, "our_capability"),
            step(2, "skipped", "Add a blocked IP", "Stopped here on purpose.", "not_applicable"),
          ],
        },
        {
          title: "Review Dashboard",
          status: "ok",
          summary: "The Protection Dashboard loads with live data.",
          carriedFromRunId: null,
          steps: [step(0, "ok", "Opened the dashboard", "The dashboard rendered.", null)],
        },
      ],
    },
  },
} as unknown as AgentEnv;

const anatomy = { pages: ["/ips"], actions: [], services: [], tech: {} };

async function main() {
  const sent: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/cdn-cgi/trace") return new Response("colo=FRA\nloc=DE\n", { status: 200 });
    if (typeof init?.body === "string") sent.push(init.body);
    return new Response(
      JSON.stringify({
        id: "msg_stub",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: JSON.stringify({ bottomLine: "The IP page loads.", findings: [] }) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  await synthesizeVerdict({ env, llm: makeLlm(bindings), runId: "run_stub", anatomy });

  const body = sent[0] ?? "";
  const observation = (() => {
    try {
      const parsed = JSON.parse(body) as { messages?: { content?: unknown }[] };
      const content = parsed.messages?.[0]?.content;
      return typeof content === "string" ? content : JSON.stringify(content ?? "");
    } catch {
      return "";
    }
  })();
  check("the model was asked once", sent.length >= 1 && observation.length > 0, `${sent.length} request(s)`);
  check(
    "our_capability: the observed text never reaches the model",
    !observation.includes("additive set") && !observation.includes("No recent activity to display"),
  );
  check("our_capability: its console and network logs never reach the model", !observation.includes("chip handler") && !observation.includes("vpn=true"));
  check("our_capability: what the walker wrote it tried never reaches the model", !observation.includes("never cleared"));
  check("our_capability: its label still does (for a coverage clause)", observation.includes("Apply visit filters"));
  check("our_capability: the model reads that it went unconfirmed", observation.includes(UNCONFIRMED_STEP));
  check("our_capability: the journey summary that repeats the claim never reaches the model", !observation.includes("additive toggles"));
  check("a journey without one keeps its summary", observation.includes("The Protection Dashboard loads with live data."));
  check("a confirmed step is passed as observed", observation.includes("Recent Activity feed with real rows"));
  check("a deliberate stop is passed as observed", observation.includes("Stopped here on purpose."));
  check("the reason itself stays ours", !observation.includes("our_capability") && !observation.includes("not_applicable"));

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
