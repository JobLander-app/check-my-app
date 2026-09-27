#!/usr/bin/env npx tsx
// CheckMyApp MCP server over stdio — a thin bridge to the remote server.
//
// The server is https://checkmyapp.dev/mcp (src/lib/mcp/, CHE-315), and a
// client that speaks Streamable HTTP should use it directly:
//
//   claude mcp add --transport http checkmyapp https://checkmyapp.dev/mcp \
//     --header "Authorization: Bearer cma_…"
//
// This file is for a client that only speaks stdio, or for a local stack:
//
//   claude mcp add checkmyapp -e CHECKMYAPP_API_KEY=cma_… -- npx tsx mcp/server.ts
//   CHECKMYAPP_URL=https://checkmyapp.dev   # default; http://localhost:3000 for a local stack
//
// It has no tools of its own. It lists whatever the remote server lists and
// forwards every call, so there is one implementation of each tool — until
// CHE-315 this file carried a second one over the public HTTP API, and two
// copies of a tool are two answers to one question.
//
// The one thing it adds is the long wait. A remote wait_for_run answers within
// 45 seconds (a Worker request is no place to hold a 40-minute call) and says
// `timed_out: true`; over stdio a client can hold a call for as long as it
// likes, so this bridge calls again until the run finishes or WAIT_CAP_MS
// passes, and turns each round into an MCP progress notification — a client
// that resets its timeout on progress can block for the whole run, as it could
// before.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

export const SERVER_VERSION = "2.0.0";
export const WAIT_CAP_MS = 45 * 60_000;
const WAIT_TOOLS = new Set(["wait_for_run", "wait_for_review"]);

export interface BridgeOptions {
  base: string;
  apiKey?: string;
  // Injected so scripts/verify-mcp.ts can put the remote handler itself on the
  // other end, in-process, and a fake clock under the wait.
  fetch?: FetchLike;
  now?: () => number;
}

function payloadOf(result: CallToolResult): Record<string, unknown> | null {
  const item = result.content?.[0];
  if (!item || item.type !== "text") return null;
  try {
    return JSON.parse(item.text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Connects to the remote server (which is where a missing or wrong key is
// refused) and returns a stdio-ready Server that forwards to it.
export async function createBridge(opts: BridgeOptions): Promise<{ server: Server; client: Client }> {
  const now = opts.now ?? (() => Date.now());
  const client = new Client({ name: "checkmyapp-stdio-bridge", version: SERVER_VERSION });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${opts.base.replace(/\/+$/, "")}/mcp`), {
      requestInit: { headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {} },
      fetch: opts.fetch,
    }),
  );

  const server = new Server(
    { name: "checkmyapp", version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: client.getInstructions() },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request) => client.listTools(request.params));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const call = { name: request.params.name, arguments: request.params.arguments };
    const startedAt = now();
    const first = (await client.callTool(call, undefined, { signal: extra.signal })) as CallToolResult;
    if (!WAIT_TOOLS.has(call.name)) return first;

    let result = first;
    let rounds = 0;
    while (payloadOf(result)?.timed_out === true && now() - startedAt < WAIT_CAP_MS && !extra.signal.aborted) {
      rounds++;
      const progressToken = request.params._meta?.progressToken;
      if (progressToken !== undefined) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: rounds,
            message: `${String(payloadOf(result)?.status ?? "running")} · ${Math.round((now() - startedAt) / 1000)}s elapsed`,
          },
        });
      }
      result = (await client.callTool(call, undefined, { signal: extra.signal })) as CallToolResult;
    }
    return result;
  });

  return { server, client };
}

// Entry point only when run directly (tsx transpiles this file as CJS — repo
// tsconfig — so `require.main` is the test). Importing it connects nothing.
if (require.main === module) {
  const base = process.env.CHECKMYAPP_URL ?? "https://checkmyapp.dev";
  createBridge({ base, apiKey: process.env.CHECKMYAPP_API_KEY || undefined })
    .then(({ server }) => server.connect(new StdioServerTransport()))
    .catch((err) => {
      console.error(
        `[checkmyapp-mcp] could not connect to ${base}/mcp: ${err instanceof Error ? err.message : String(err)}` +
          (process.env.CHECKMYAPP_API_KEY ? "" : " — set CHECKMYAPP_API_KEY (dashboard → API keys)"),
      );
      process.exit(1);
    });
}
