// CHE-383 verification: a check our GitHub Action starts is recorded as
// started by the Action, and no client can write any other label.
//
// The Action (sorokinvj/checkmyapp-action) calls /mcp with
// `User-Agent: checkmyapp-action/1`. Driven through the real handler
// (src/lib/mcp/handler.ts) exactly as the Action sends it — a bare JSON-RPC
// `tools/call`, no `initialize` — against the stub database
// (scripts/fixtures/mcp-db.ts):
//
//   1. mcpDoor: the Action's agent, with a minor/patch version → "action";
//      no header, another client, and every near miss (a prefix, a suffix,
//      the bare word, another door's name) → "mcp";
//   2. start_check {url} records Run.startedVia from that: "action" for the
//      Action's agent, "mcp" for anything else;
//   3. start_check {app_id} (startSavedApp) records it the same way;
//   4. a spoofed agent outside the allow-list writes "mcp", never its own text.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-started-via.ts

process.env.CREDENTIALS_SECRET ??= "verify-started-via-secret";

import { hashApiKey } from "@/lib/apiKeys";
import { handleMcpRequest } from "@/lib/mcp/handler";
import type { McpDeps } from "@/lib/mcp/tools";
import { mcpDoor } from "@/lib/started-via";
import { createStubDb } from "./fixtures/mcp-db";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ORIGIN = "https://checkmyapp.dev";
const KEY = "cma_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACTION_UA = "checkmyapp-action/1";
const day = (n: number) => new Date(Date.UTC(2026, 9, n, 12));

const NEAR_MISSES = [
  "checkmyapp-action/1 evil",
  "Mozilla/5.0 checkmyapp-action/1",
  "checkmyapp-action",
  "checkmyapp-action/",
  "checkmyapp-action/one",
  "CheckMyApp-Action/1",
  "action",
  "github_app",
  "claude-code/2.0.14 (mcp)",
];

async function main() {
  // 1 — the allow-list itself.
  check("door: the Action's agent → action", mcpDoor(ACTION_UA) === "action");
  check("door: …with a minor and patch version → action", mcpDoor("checkmyapp-action/1.2") === "action" && mcpDoor("checkmyapp-action/2.0.1") === "action");
  check("door: no header → mcp", mcpDoor(null) === "mcp" && mcpDoor(undefined) === "mcp" && mcpDoor("") === "mcp");
  for (const ua of NEAR_MISSES) check(`door: "${ua}" → mcp`, mcpDoor(ua) === "mcp", mcpDoor(ua));

  // 2–4 — through the handler, into Run.startedVia.
  const apps = Array.from({ length: 3 }, (_, i) => ({
    id: `app_${i}`, ownerId: "u_a", teamId: "team_a", appSlug: `app-${i}.test`, targetUrl: `https://app-${i}.test`,
    targetKind: "website", testEmail: null, testPasswordEnc: null, focusAreas: null, scopeHints: null, userNotes: null,
    writeMode: "read_only", createdAt: day(1),
  }));
  const stub = await createStubDb({
    user: [{ id: "u_a", email: "a@team-a.test", name: "Ann" }],
    team: [{ id: "team_a", name: "Team A", plan: "business", isPersonal: false }],
    apiKey: [{ id: "k_a", ownerId: "u_a", teamId: "team_a", scope: "member", keyHash: await hashApiKey(KEY), lastUsedAt: null }],
    app: apps,
    run: [],
    finding: [],
    counter: [{ id: "counter", name: "runNumber", value: 100 }],
  });
  const deps: McpDeps = {
    db: stub.db,
    origin: ORIGIN,
    trigger: async () => {},
    siteCap: () => 20,
    ephemeralTtlDays: () => 7,
    sleep: async () => {},
    now: () => day(2).getTime(),
  };

  let id = 0;
  async function startCheck(args: Record<string, unknown>, userAgent: string | null) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (userAgent !== null) headers["user-agent"] = userAgent;
    const res = await handleMcpRequest(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "start_check", arguments: args } }),
      }),
      deps,
    );
    const body = (await res.json()) as { result?: { content?: Array<{ text?: string }> } };
    const out = JSON.parse(body.result?.content?.[0]?.text ?? "{}") as { ok?: boolean; run_id?: string };
    const run = stub.table("run").find((r) => r.publicId === out.run_id);
    return { out, startedVia: run?.startedVia };
  }

  let n = 0;
  const url = () => `https://one-off-${++n}.test`;

  const byAction = await startCheck({ url: url(), deploy_sha: "abc1234" }, ACTION_UA);
  check("url: the Action's agent → startedVia action", byAction.out.ok === true && byAction.startedVia === "action", JSON.stringify(byAction));
  const plain = await startCheck({ url: url() }, null);
  check("url: no user agent → startedVia mcp", plain.out.ok === true && plain.startedVia === "mcp", JSON.stringify(plain));
  const agent = await startCheck({ url: url() }, "claude-code/2.0.14 (mcp)");
  check("url: a coding agent's client → startedVia mcp", agent.startedVia === "mcp", JSON.stringify(agent));

  const savedByAction = await startCheck({ app_id: "app_0", deploy_sha: "abc1234", deploy_env: "production" }, ACTION_UA);
  check("app_id: the Action's agent → startedVia action", savedByAction.out.ok === true && savedByAction.startedVia === "action", JSON.stringify(savedByAction));
  const savedPlain = await startCheck({ app_id: "app_1" }, "claude-code/2.0.14 (mcp)");
  check("app_id: another client → startedVia mcp", savedPlain.out.ok === true && savedPlain.startedVia === "mcp", JSON.stringify(savedPlain));

  for (const ua of ["checkmyapp-action/1 evil", "github_app", "action"]) {
    const spoof = await startCheck({ url: url() }, ua);
    check(`spoof: "${ua}" → startedVia mcp`, spoof.out.ok === true && spoof.startedVia === "mcp", JSON.stringify(spoof));
  }
  const spoofSaved = await startCheck({ app_id: "app_2" }, "checkmyapp-action/1; startedVia=admin");
  check("spoof: app_id with a header outside the list → startedVia mcp", spoofSaved.startedVia === "mcp", JSON.stringify(spoofSaved));

  const labels = new Set(stub.table("run").map((r) => r.startedVia));
  check("every run carries one of our two labels", [...labels].every((l) => l === "mcp" || l === "action"), [...labels].join(", "));

  console.log(failures === 0 ? "\nverify-started-via: all checks passed" : `\nverify-started-via: ${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-started-via: crashed:", err);
  process.exit(1);
});
