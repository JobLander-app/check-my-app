// CHE-395 verification: a saved app is the team's to run, whoever added it.
//
// `startSavedApp` used to find the app by the person pressing Run, so a
// teammate the scope table allows (`run.start`: admin and member) was told
// "App not found" — on the dashboard and over MCP, which share the function.
//
// Driven through the real MCP handler against the stub database
// (scripts/fixtures/mcp-db.ts), one key per person:
//
//   1. a member starts an app a teammate added: the run is the member's (who
//      started it), the team's and the app's;
//   2. a teammate's in-flight check of that app is answered with that check,
//      not doubled;
//   3. a person of another team is told the app is not found;
//   4. a reader is refused by the scope gate, and nothing starts;
//   5. both doors ask the scope table before they reach the function, and the
//      function scopes both of its lookups to the team and to nothing narrower.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-run-teammates-app.ts

process.env.CREDENTIALS_SECRET ??= "verify-run-teammates-app-secret";

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashApiKey } from "@/lib/apiKeys";
import { handleMcpRequest } from "@/lib/mcp/handler";
import type { McpDeps } from "@/lib/mcp/tools";
import { can } from "@/lib/scopes";
import { createStubDb } from "./fixtures/mcp-db";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

const ORIGIN = "https://checkmyapp.dev";
const KEYS = {
  ann: "cma_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // admin of team A, added the apps
  bob: "cma_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", // member of team A
  rae: "cma_cccccccccccccccccccccccccccccccc", // reader of team A
  zed: "cma_dddddddddddddddddddddddddddddddd", // admin of team Z
};
const day = (n: number) => new Date(Date.UTC(2026, 9, n, 12));

async function main() {
  const apps = Array.from({ length: 3 }, (_, i) => ({
    id: `app_${i}`, ownerId: "u_ann", teamId: "team_a", appSlug: `app-${i}.test`, targetUrl: `https://app-${i}.test`,
    targetKind: "website", testEmail: null, testPasswordEnc: null, focusAreas: null, scopeHints: null, userNotes: null,
    writeMode: "read_only", createdAt: day(1),
  }));
  const stub = await createStubDb({
    user: [
      { id: "u_ann", email: "ann@team-a.test", name: "Ann" },
      { id: "u_bob", email: "bob@team-a.test", name: "Bob" },
      { id: "u_rae", email: "rae@team-a.test", name: "Rae" },
      { id: "u_zed", email: "zed@team-z.test", name: "Zed" },
    ],
    team: [
      { id: "team_a", name: "Team A", plan: "business", isPersonal: false },
      { id: "team_z", name: "Team Z", plan: "business", isPersonal: false },
    ],
    apiKey: [
      { id: "k_ann", ownerId: "u_ann", teamId: "team_a", scope: "admin", keyHash: await hashApiKey(KEYS.ann), lastUsedAt: null },
      { id: "k_bob", ownerId: "u_bob", teamId: "team_a", scope: "member", keyHash: await hashApiKey(KEYS.bob), lastUsedAt: null },
      { id: "k_rae", ownerId: "u_rae", teamId: "team_a", scope: "reader", keyHash: await hashApiKey(KEYS.rae), lastUsedAt: null },
      { id: "k_zed", ownerId: "u_zed", teamId: "team_z", scope: "admin", keyHash: await hashApiKey(KEYS.zed), lastUsedAt: null },
    ],
    app: apps,
    run: [],
    finding: [],
    counter: [{ id: "counter", name: "runNumber", value: 100 }],
  });
  const triggered: string[] = [];
  const deps: McpDeps = {
    db: stub.db,
    origin: ORIGIN,
    trigger: async (id) => void triggered.push(id),
    siteCap: () => 20,
    ephemeralTtlDays: () => 7,
    sleep: async () => {},
    now: () => day(2).getTime(),
  };

  let id = 0;
  async function startCheck(who: keyof typeof KEYS, appId: string) {
    const res = await handleMcpRequest(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${KEYS[who]}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "start_check", arguments: { app_id: appId } } }),
      }),
      deps,
    );
    const body = (await res.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
    const out = JSON.parse(body.result?.content?.[0]?.text ?? "{}") as { ok?: boolean; run_id?: string; already_running?: boolean; code?: string; error?: string };
    return { out, isError: body.result?.isError === true, run: stub.table("run").find((r) => r.publicId === out.run_id) };
  }

  // 1 — a member runs a teammate's app.
  const bob = await startCheck("bob", "app_0");
  check("a member starts an app a teammate added", bob.out.ok === true && bob.out.already_running === false && Boolean(bob.run), JSON.stringify(bob.out));
  check("…the check is the member's (who started it), the team's and the app's",
    bob.run?.ownerId === "u_bob" && bob.run?.teamId === "team_a" && bob.run?.appId === "app_0" && bob.run?.appSlug === "app-0.test",
    JSON.stringify({ ownerId: bob.run?.ownerId, teamId: bob.run?.teamId, appId: bob.run?.appId }));
  check("…and it was started once", triggered.length === 1, String(triggered.length));

  // 2 — one app, one check in flight, whoever pressed first.
  const ann = await startCheck("ann", "app_0");
  check("the teammate who added it, pressing Run while that check is going, gets that check — not a second one",
    ann.out.ok === true && ann.out.already_running === true && ann.out.run_id === bob.out.run_id && triggered.length === 1 &&
      stub.table("run").filter((r) => r.appId === "app_0").length === 1,
    JSON.stringify(ann.out));
  const annOwn = await startCheck("ann", "app_1");
  const bobAfter = await startCheck("bob", "app_1");
  check("…and the same the other way round", annOwn.out.already_running === false && bobAfter.out.already_running === true && bobAfter.out.run_id === annOwn.out.run_id,
    JSON.stringify([annOwn.out, bobAfter.out]));

  // 3 — the team clause is what is left, and it holds.
  const zed = await startCheck("zed", "app_2");
  check("a person of another team is told the app is not found, and nothing starts",
    zed.isError && zed.out.code === "not_found" && !stub.table("run").some((r) => r.appId === "app_2"), JSON.stringify(zed.out));

  // 4 — a reader spends nothing.
  const rae = await startCheck("rae", "app_2");
  check("a reader is refused, and nothing starts", rae.isError && rae.out.code === "forbidden" && !stub.table("run").some((r) => r.appId === "app_2"), JSON.stringify(rae.out));
  check("the scope table: admin and member may start a check, a reader may not", can("admin", "run.start") && can("member", "run.start") && !can("reader", "run.start"));

  // 5 — why dropping the owner filter is safe: the gate is before the function.
  const actions = read("src/app/dashboard/actions.ts");
  const runSavedApp = actions.slice(actions.indexOf("export async function runSavedApp"));
  check("the dashboard's Run asks the scope table before it reaches startSavedApp",
    runSavedApp.indexOf('requireActionScope("run.start")') > 0 && runSavedApp.indexOf('requireActionScope("run.start")') < runSavedApp.indexOf("startSavedApp("));
  const tools = read("src/lib/mcp/tools.ts");
  const startTool = tools.slice(tools.indexOf("async start_check("));
  check("MCP start_check asks the scope table before it reaches startSavedApp",
    startTool.indexOf('deny("run.start")') > 0 && startTool.indexOf('deny("run.start")') < startTool.indexOf("startSavedApp("));
  const lib = read("src/lib/start-saved-app.ts");
  check("startSavedApp finds the app as the team's, by id — not by who added it", /db\.app\.findFirst\(\{ where: \{ \.\.\.teamOwned\(owner\.teamId\), id: appId \} \}\)/.test(lib));
  check("…and the app's in-flight check as the team's, whoever started it", /where: \{ \.\.\.teamOwned\(owner\.teamId\), appId, status: \{ notIn: TERMINAL_RUN_STATUSES \} \}/.test(lib));
  check("the new check is attributed to the person who started it", /ownerId: owner\.id, teamId: owner\.teamId, appId: app\.id/.test(lib));

  console.log(failures === 0 ? "\nverify-run-teammates-app: all checks passed" : `\nverify-run-teammates-app: ${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-run-teammates-app: crashed:", err);
  process.exit(1);
});
