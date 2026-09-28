// CHE-200 live smoke: drive mcp/server.ts over stdio, as an MCP client would,
// against production — one real run of our own app, nothing else.
//
// NOT part of scripts/verify-*: it spends real money (one full check, roughly
// a dollar) and takes 20–40 minutes. Run it by hand after a change to the MCP
// server or to the API it mirrors, and paste the summary it prints into the
// PR. The contract itself is verified without a network by
// scripts/verify-mcp.ts.
//
// Owner rules this script encodes:
//   - the target is https://checkmyapp.dev and cannot be overridden — a smoke
//     never spends a run on a third party's site;
//   - exactly one run: a refusal (quota, key rejected) is printed and the
//     script exits non-zero; it never retries;
//   - the run is owner-attributed: CHECKMYAPP_API_KEY must be set (from .env,
//     which is gitignored). The key is passed to the server's environment and
//     never printed.
//
// Usage:
//   npm run mcp:smoke                       # deploy_sha = origin/main short sha
//   npm run mcp:smoke -- --sha <build-id>   # bind the run to another build
//   npm run mcp:smoke -- --run <run-id>     # attach to a run already started
//                                           # (no start_check; nothing new is
//                                           # created) — e.g. after the shell
//                                           # that started the smoke was cut
//   CHECKMYAPP_URL=http://localhost:3000 npm run mcp:smoke   # a local stack

import "dotenv/config";
import { execSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const TARGET = "https://checkmyapp.dev";
const STATUS_POLLS = 3;
const STATUS_POLL_GAP_MS = 20_000;
const WAIT_TIMEOUT_MS = 50 * 60_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function textOf(result: unknown): Record<string, unknown> {
  const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const item = r.content?.find((c) => c.type === "text");
  const parsed = item?.text ? (JSON.parse(item.text) as Record<string, unknown>) : {};
  return { ...parsed, __isError: r.isError === true };
}

async function main() {
  const apiKey = process.env.CHECKMYAPP_API_KEY;
  if (!apiKey) {
    console.error("mcp-smoke: CHECKMYAPP_API_KEY is not set — the smoke is owner-attributed by design.");
    process.exit(2);
  }
  const base = process.env.CHECKMYAPP_URL ?? TARGET;
  const sha =
    arg("--sha") ??
    execSync("git rev-parse --short origin/main", { encoding: "utf8" }).trim();

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "mcp/server.ts"],
    env: { ...getDefaultEnvironment(), CHECKMYAPP_API_KEY: apiKey, CHECKMYAPP_URL: base },
    stderr: "inherit",
  });
  const client = new Client({ name: "mcp-smoke", version: "1.0.0" });
  await client.connect(transport);

  const tools = (await client.listTools()).tools.map((t) => t.name);
  console.log(`tools: ${tools.join(", ")}`);

  const t0 = Date.now();
  const attach = arg("--run");
  const started = attach
    ? { run_id: attach, __isError: false }
    : textOf(
        await client.callTool({
          name: "start_check",
          arguments: {
            url: TARGET,
            notes: "CHE-200 MCP smoke: read-only walk, do not create anything",
            scope_hints: "Do not sign up, do not submit forms, do not press buttons that create records.",
            deploy_sha: sha,
            deploy_env: "production",
          },
        }),
      );
  console.log(attach ? `attached to run ${attach}` : `start_check → ${JSON.stringify(started)}`);
  if (started.__isError || typeof started.run_id !== "string") {
    console.error("mcp-smoke: start_check was refused; not retrying.");
    await client.close();
    process.exit(1);
  }
  const runId = started.run_id;

  for (let i = 0; i < STATUS_POLLS; i++) {
    await new Promise((r) => setTimeout(r, STATUS_POLL_GAP_MS));
    const status = textOf(await client.callTool({ name: "get_check_status", arguments: { run_id: runId } }));
    console.log(`get_check_status #${i + 1} (+${Math.round((Date.now() - t0) / 1000)}s) → ${JSON.stringify(status)}`);
    if (status.terminal === true) break;
  }

  const waited = textOf(
    await client.callTool(
      { name: "wait_for_run", arguments: { run_id: runId } },
      undefined,
      {
        timeout: 5 * 60_000,
        resetTimeoutOnProgress: true,
        maxTotalTimeout: WAIT_TIMEOUT_MS,
        onprogress: (p) => console.log(`  progress ${p.progress}: ${p.message ?? ""}`),
      },
    ),
  );
  const elapsedS = Math.round((Date.now() - t0) / 1000);
  console.log(`wait_for_run (+${elapsedS}s) → ${JSON.stringify(waited)}`);

  const verdict = textOf(await client.callTool({ name: "get_verdict", arguments: { domain_or_run_id: runId } }));
  console.log(`get_verdict → ${JSON.stringify(verdict)}`);

  await client.close();

  console.log("\n--- smoke summary ---");
  console.log(`run_id:      ${runId}`);
  console.log(`deploy:      ${JSON.stringify(waited.deploy)}`);
  console.log(`status:      ${String(waited.status)}`);
  console.log(`verdict:     ${String(waited.verdict)}`);
  console.log(`findings:    ${JSON.stringify(waited.findings_by_severity)}`);
  console.log(`duration:    ${Math.floor(elapsedS / 60)}m${elapsedS % 60}s (client-side, start_check → wait_for_run)`);
  console.log(`verdict_url: ${String(waited.verdict_url)}`);
  process.exit(waited.__isError || waited.timed_out === true ? 1 : 0);
}

main().catch((err) => {
  console.error("mcp-smoke: crashed:", err);
  process.exit(1);
});
