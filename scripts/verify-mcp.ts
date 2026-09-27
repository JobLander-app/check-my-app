// CHE-315 verification: the stdio server (mcp/server.ts) is a bridge to the
// remote one, and nothing more.
//
// Until CHE-315 the stdio server had tools of its own, written over the public
// HTTP API (mcp/tools.ts, CHE-200/201/202). The remote server at /mcp replaced
// them; the stdio server now forwards to it, so there is one implementation of
// each tool. What this pins, with the remote handler itself on the far end of
// the bridge — in-process, stub database, fake clock, no network:
//
//   1. the bridge lists exactly the remote server's tools and passes its
//      instructions on;
//   2. a call and a refusal pass through untouched (isError and `code` intact),
//      and an argument the remote schema rejects is rejected;
//   3. the long wait: the remote wait_for_run answers `timed_out` every 45s;
//      the bridge calls again, sends a progress notification per round, and
//      returns the verdict when the run finishes — or gives up at 45 minutes
//      with timed_out, as the stdio server always did;
//   4. without a key the bridge does not start: the remote refusal is the
//      answer, not a server with no tools.
//
// The remote tools themselves are verified by scripts/verify-mcp-remote.ts.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-mcp.ts

process.env.CREDENTIALS_SECRET ??= "verify-mcp-secret";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { hashApiKey } from "@/lib/apiKeys";
import { handleMcpRequest } from "@/lib/mcp/handler";
import { WAIT_BUDGET_MS, type McpDeps } from "@/lib/mcp/tools";
import { createBridge, WAIT_CAP_MS } from "../mcp/server";
import { createStubDb } from "./fixtures/mcp-db";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const BASE = "https://checkmyapp.dev";
const KEY = "cma_0123456789abcdef0123456789abcdef";

function parse(result: unknown): Record<string, unknown> {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  return JSON.parse(r.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

async function main() {
  const t0 = Date.UTC(2026, 8, 20, 12);
  let clock = t0;
  // The run finishes when the clock passes this (null = never).
  let finishAt: number | null = null;

  const stub = createStubDb({
    user: [{ id: "u", email: "o@example.test", name: "O" }],
    team: [{ id: "team_o", name: "Owner team", plan: "business", isPersonal: true }],
    apiKey: [{ id: "k", ownerId: "u", teamId: "team_o", scope: "member", keyHash: await hashApiKey(KEY), lastUsedAt: null }],
    app: [{ id: "app_o", ownerId: "u", teamId: "team_o", appSlug: "own.test", targetUrl: "https://own.test", createdAt: new Date(t0) }],
    run: [
      { id: "r1", publicId: "pub_run", runNumber: 1, appId: "app_o", teamId: "team_o", ownerId: "u", appSlug: "own.test",
        targetUrl: "https://own.test", targetKind: "website", status: "walking", verdict: null, startedAt: new Date(t0),
        createdAt: new Date(t0), completedAt: null },
    ],
    finding: [],
  });
  const run = stub.table("run")[0];

  const deps: McpDeps = {
    db: stub.db,
    origin: BASE,
    trigger: async () => {},
    siteCap: () => 20,
    ephemeralTtlDays: () => 7,
    sleep: async (ms) => {
      clock += ms;
      if (finishAt !== null && clock >= finishAt && run.status !== "completed") {
        Object.assign(run, { status: "completed", verdict: "mostly_ok", bottomLine: "Works.", completedAt: new Date(clock) });
      }
    },
    now: () => clock,
  };
  const fetchIn = (url: string | URL, init?: RequestInit) => handleMcpRequest(new Request(url, init), deps);

  // What the remote lists, straight from it — the bridge must match it exactly.
  const direct = new Client({ name: "direct", version: "0" });
  await direct.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${KEY}` } },
    fetch: fetchIn,
  }));
  const remoteTools = (await direct.listTools()).tools.map((t) => t.name).sort();
  await direct.close();

  const { server } = await createBridge({ base: BASE, apiKey: KEY, fetch: fetchIn, now: () => clock });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "verify-mcp", version: "0" });
  await client.connect(clientSide);

  // 1 — tools and instructions.
  const bridged = (await client.listTools()).tools.map((t) => t.name).sort();
  check("bridge: lists exactly the remote server's tools",
    remoteTools.length === 12 && JSON.stringify(bridged) === JSON.stringify(remoteTools), bridged.join(", "));
  check("bridge: passes the remote instructions on",
    (client.getInstructions() ?? "").includes("own.test"), (client.getInstructions() ?? "").slice(0, 120));

  // 2 — calls and refusals pass through.
  {
    const listed = parse(await client.callTool({ name: "list_apps", arguments: {} }));
    check("bridge: a call reaches the remote tool", (listed.apps as unknown[])?.length === 1, JSON.stringify(listed).slice(0, 120));
    const refused = await client.callTool({ name: "get_review", arguments: { run_id: "someone-elses" } });
    check("bridge: a refusal arrives with isError and its code",
      refused.isError === true && parse(refused).code === "not_found", JSON.stringify(refused).slice(0, 160));
    const bad = await client.callTool({ name: "start_check", arguments: { url: "https://own.test", deploy_sha: "abc" } });
    check("bridge: an argument the remote schema rejects is rejected", bad.isError === true, JSON.stringify(bad).slice(0, 160));
  }

  // 3 — the long wait.
  {
    finishAt = t0 + 3 * 60_000; // three minutes in
    const notes: string[] = [];
    const waited = await client.callTool(
      { name: "wait_for_run", arguments: { run_id: "pub_run" } },
      undefined,
      { onprogress: (p) => { notes.push(`${p.progress}:${p.message ?? ""}`); }, resetTimeoutOnProgress: true },
    );
    const out = parse(waited);
    check("wait: the bridge keeps calling past each 45s remote answer and returns the verdict",
      out.verdict === "mostly_ok" && out.status === "completed" && out.timed_out === undefined, JSON.stringify(out).slice(0, 160));
    const expectedRounds = Math.ceil((3 * 60_000) / WAIT_BUDGET_MS) - 1;
    check("wait: one progress notification per remote round, carrying the status",
      notes.length >= expectedRounds && notes.length <= expectedRounds + 1 && notes[0].startsWith("1:walking"),
      JSON.stringify(notes));
  }
  {
    Object.assign(run, { status: "walking", verdict: null, completedAt: null });
    finishAt = null;
    const started = clock;
    const out = parse(await client.callTool({ name: "wait_for_review", arguments: { run_id: "pub_run" } }));
    check(`wait: never finishing → the bridge stops at ${WAIT_CAP_MS / 60_000} minutes with timed_out`,
      out.timed_out === true && clock - started >= WAIT_CAP_MS && clock - started <= WAIT_CAP_MS + WAIT_BUDGET_MS,
      JSON.stringify({ out, minutes: (clock - started) / 60_000 }));
  }
  await client.close();
  await server.close();

  // 4 — no key.
  {
    let refused: string | null = null;
    try {
      await createBridge({ base: BASE, fetch: fetchIn, now: () => clock });
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
    }
    check("no key: the bridge does not start, and says why", refused !== null && /401|API key/.test(refused), String(refused));
  }

  console.log(failures === 0 ? "\nverify-mcp: all checks passed" : `\nverify-mcp: ${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-mcp: crashed:", err);
  process.exit(1);
});
