// checkmyapp-watch: Daily Watch results pushed into a running Claude Code
// session (CHE-319).
//
// The remote MCP server (https://checkmyapp.dev/mcp, CHE-315) answers when the
// agent asks. This is the other half: when a recurring check finishes, the
// session hears about it without anyone asking — no dispatcher, no inbox. It is
// a Claude Code *channel* (research preview): a stdio MCP server that declares
// `experimental['claude/channel']` and emits `notifications/claude/channel`.
//
//   claude mcp add checkmyapp-watch -e CHECKMYAPP_API_KEY=cma_… \
//     -- npx -y https://checkmyapp.dev/mcp/checkmyapp-watch.tgz
//   claude --dangerously-load-development-channels server:checkmyapp-watch
//
// One-way and outbound only. It opens no port — it polls `latest_results` over
// HTTPS every CHECKMYAPP_POLL_SECONDS (default 300, never under 60) — and it
// has no tools: fixing goes through the checkmyapp MCP server's get_review.
// What counts as news is decided in ./watch.ts.
//
// Shipped as a tarball on our own site, not the npm registry:
// `npm run build:channel` bundles this with the SDK into one dependency-free
// file (public/mcp/checkmyapp-watch.tgz), and scripts/verify-mcp-channel.ts
// fails when the committed tarball is not what the source builds.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import {
  CHANNEL_INSTRUCTIONS,
  CHANNEL_NAME,
  CHANNEL_VERSION,
  createWatcher,
  fetchLatestResults,
  KeyRefusedError,
  type ChannelEvent,
} from "./watch";

export const DEFAULT_POLL_SECONDS = 300;
export const MIN_POLL_SECONDS = 60;

export function pollSeconds(raw: string | undefined): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return DEFAULT_POLL_SECONDS;
  return Math.max(MIN_POLL_SECONDS, Math.round(n));
}

// The channel never asks the client for input, which is all the SDK's default
// JSON-schema validator is built for — same reasoning as src/lib/mcp/handler.ts.
const noElicitation: jsonSchemaValidator = {
  getValidator: () => () => ({ valid: false, data: undefined, errorMessage: "This server does not request input." }),
};

export function createChannelServer(): Server {
  return new Server(
    { name: CHANNEL_NAME, version: CHANNEL_VERSION },
    {
      // This key is what makes it a channel; no `tools` — it is one-way.
      capabilities: { experimental: { "claude/channel": {} } },
      instructions: CHANNEL_INSTRUCTIONS,
      jsonSchemaValidator: noElicitation,
    },
  );
}

export async function push(server: Server, event: ChannelEvent): Promise<void> {
  // A Claude Code extension method, not in the SDK's notification union.
  await server.notification({ method: "notifications/claude/channel", params: event } as unknown as Parameters<
    Server["notification"]
  >[0]);
}

const log = (msg: string) => process.stderr.write(`[${CHANNEL_NAME}] ${msg}\n`);

export async function main(): Promise<void> {
  const apiKey = process.env.CHECKMYAPP_API_KEY;
  const base = process.env.CHECKMYAPP_URL || "https://checkmyapp.dev";
  if (!apiKey) {
    log("CHECKMYAPP_API_KEY is not set — create one at https://checkmyapp.dev/dashboard (API keys).");
    process.exit(1);
  }
  const every = pollSeconds(process.env.CHECKMYAPP_POLL_SECONDS);
  const server = createChannelServer();
  const watcher = createWatcher({ now: () => Date.now() });

  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const apps = await fetchLatestResults({ base, apiKey: apiKey! });
      const first = !watcher.seeded;
      const events = watcher.observe(apps);
      // One line that says the key works and what the session starts with —
      // the only sign of life before the first result, in `claude --debug`.
      if (first) {
        const finished = apps.filter((a) => a.latest_run).length;
        log(`connected: ${apps.length} app(s), ${finished} with a finished check, ${events.length} waiting`);
      }
      for (const event of events) await push(server, event);
      if (events.length) log(`pushed ${events.length} result(s)`);
    } catch (err) {
      if (err instanceof KeyRefusedError) {
        log(`${base}/mcp refused the API key (${err.message}). Check CHECKMYAPP_API_KEY; not retrying.`);
        process.exit(1);
      }
      // Network trouble or a bad deploy on our side: the next tick tries again.
      log(`poll failed, retrying in ${every}s: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy = false;
    }
  }

  // Polling starts once the client has finished the handshake: a startup push
  // sent before `initialized` could reach a client not yet listening.
  let started = false;
  server.oninitialized = () => {
    if (started) return;
    started = true;
    log(`watching ${base} every ${every}s`);
    void tick();
    setInterval(() => void tick(), every * 1000);
  };

  // The stdio transport does not end the process when the client goes away;
  // the interval would keep an orphan polling forever.
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));

  await server.connect(new StdioServerTransport());
}
