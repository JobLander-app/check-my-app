// CHE-417 (the rest of CHE-404's "by app id" list): an app is the team's to
// configure, whoever added it.
//
// The settings pages open every app of the team (teamOwned), but the writes
// behind them added `ownerId: <the person acting>` — so a member the scope
// table allows was told "app not found" on an app a teammate added, and an
// admin could not remove one. Ownership is the team's since CHE-253; ownerId
// is attribution. The scope table decides who may act, before the lookup.
//
//   1. real D1: a member saves the settings of an app the admin added, enables
//      its watch, and is told "already have this app" when adding the same
//      address again; a person of another team is told the app is not found;
//   2. the MCP disable_watch door, through the real handler: a member pauses a
//      teammate's app's watch; another team's admin gets not_found; a reader is
//      refused by the gate;
//   3. source: no door in the registry below finds an app by the person acting
//      beside its team clause, and each asks the scope table first; the app
//      page offers Run and Connect by scope alone.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-team-scoped-app-writes.ts

process.env.CREDENTIALS_SECRET ??= "verify-team-scoped-app-writes-secret";

import "./fixtures/wasm-module-loader.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { realD1 } from "./fixtures/real-d1";
import { createStubDb } from "./fixtures/mcp-db";
import { hashApiKey } from "@/lib/apiKeys";
import { handleMcpRequest } from "@/lib/mcp/handler";
import type { McpDeps } from "@/lib/mcp/tools";
import { createAppForTeam, updateAppForTeam } from "@/lib/app-settings";
import { enableWatchForApp } from "@/lib/watch-enable";
import { can } from "@/lib/scopes";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

// ── 1. A real D1 ────────────────────────────────────────────────────────────
async function realRows() {
  const real = await realD1();
  try {
    await real.db.user.createMany({ data: [
      { id: "ann", clerkUserId: "ck_ann", email: "ann@team-a.test" },
      { id: "bob", clerkUserId: "ck_bob", email: "bob@team-a.test" },
      { id: "zed", clerkUserId: "ck_zed", email: "zed@team-z.test" },
    ] });
    await real.db.team.createMany({ data: [{ id: "team_a", name: "A", plan: "business" }, { id: "team_z", name: "Z", plan: "business" }] });
    await real.db.membership.createMany({ data: [
      { teamId: "team_a", userId: "ann", scope: "admin" },
      { teamId: "team_a", userId: "bob", scope: "member" },
      { teamId: "team_z", userId: "zed", scope: "admin" },
    ] as never });
    const ann = { userId: "ann", teamId: "team_a", plan: "business" as const };
    const bob = { userId: "bob", teamId: "team_a", plan: "business" as const };
    const zed = { userId: "zed", teamId: "team_z", plan: "business" as const };

    const created = await createAppForTeam(real.db, ann, { targetUrl: "https://shared.test", frequency: "daily" });
    const appId = "ok" in created ? created.app.id : "";
    check("real D1: the admin adds an app", "ok" in created, JSON.stringify(created));

    const byBob = await updateAppForTeam(real.db, bob, appId, { scopeHints: "Bob was here" });
    const after = await real.db.app.findUnique({ where: { id: appId }, select: { scopeHints: true, ownerId: true } });
    check("real D1: a member saves the settings of the app a teammate added", "ok" in byBob && after?.scopeHints === "Bob was here", JSON.stringify({ byBob, after }));
    check("…and the app stays attributed to who added it", after?.ownerId === "ann", String(after?.ownerId));

    await real.db.watch.update({ where: { appId }, data: { active: false } });
    const watched = await enableWatchForApp(real.db, { id: "bob", teamId: "team_a", plan: "business" }, appId, { frequency: "daily" });
    const watch = await real.db.watch.findUnique({ where: { appId }, select: { active: true, ownerId: true } });
    check("real D1: a member resumes the watch of a teammate's app", watched.kind === "ok" && watch?.active === true, JSON.stringify({ watched, watch }));

    const again = await createAppForTeam(real.db, bob, { targetUrl: "https://shared.test", frequency: "daily" });
    const rows = await real.db.app.count({ where: { teamId: "team_a", appSlug: "shared.test" } });
    check("real D1: a member adding an address the team already has is told so, and no second row appears", "error" in again && again.code === "duplicate" && rows === 1, JSON.stringify(again) + ` rows=${rows}`);

    const byZed = await updateAppForTeam(real.db, zed, appId, { scopeHints: "Zed was here" });
    const zedWatch = await enableWatchForApp(real.db, { id: "zed", teamId: "team_z", plan: "business" }, appId, { frequency: "daily" });
    const untouched = await real.db.app.findUnique({ where: { id: appId }, select: { scopeHints: true } });
    check("real D1: a person of another team is told the app is not found, on both doors, and nothing changes",
      "error" in byZed && byZed.code === "not_found" && zedWatch.kind === "not_found" && untouched?.scopeHints === "Bob was here", JSON.stringify({ byZed, zedWatch, untouched }));
  } finally {
    await real.dispose();
  }
}

// ── 2. MCP disable_watch, through the real handler ──────────────────────────
const ORIGIN = "https://checkmyapp.dev";
const KEYS = {
  ann: "cma_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // admin of team A, added the app
  bob: "cma_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", // member of team A
  rae: "cma_cccccccccccccccccccccccccccccccc", // reader of team A
  zed: "cma_dddddddddddddddddddddddddddddddd", // admin of team Z
};
async function mcpDoor() {
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
    app: [{
      id: "app_0", ownerId: "u_ann", teamId: "team_a", appSlug: "app-0.test", targetUrl: "https://app-0.test", targetKind: "website",
      testEmail: null, testPasswordEnc: null, focusAreas: null, scopeHints: null, userNotes: null, writeMode: "read_only", createdAt: new Date(Date.UTC(2026, 9, 1)),
    }],
    watch: [{ id: "w_0", appId: "app_0", ownerId: "u_ann", teamId: "team_a", appSlug: "app-0.test", targetUrl: "https://app-0.test", active: true, frequency: "daily", notifyOnChangeOnly: true, trialEndsAt: null, nextRunAt: null }],
    run: [],
    finding: [],
    counter: [{ id: "counter", name: "runNumber", value: 100 }],
  });
  const deps: McpDeps = { db: stub.db, origin: ORIGIN, trigger: async () => {}, siteCap: () => 20, ephemeralTtlDays: () => 7, sleep: async () => {}, now: () => Date.UTC(2026, 9, 2) };
  let id = 0;
  async function disable(who: keyof typeof KEYS) {
    const res = await handleMcpRequest(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${KEYS[who]}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "disable_watch", arguments: { app_id: "app_0" } } }),
      }),
      deps,
    );
    const body = (await res.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
    return { out: JSON.parse(body.result?.content?.[0]?.text ?? "{}") as { ok?: boolean; code?: string; watch?: { state: string } }, isError: body.result?.isError === true };
  }
  const active = () => stub.table("watch").find((w) => w.id === "w_0")?.active;

  const zed = await disable("zed");
  check("MCP disable_watch: another team's admin is told the app is not found, and the watch runs on", zed.isError && zed.out.code === "not_found" && active() === true, JSON.stringify(zed.out));
  const rae = await disable("rae");
  check("MCP disable_watch: a reader is refused by the gate, and the watch runs on", rae.isError && rae.out.code === "forbidden" && active() === true, JSON.stringify(rae.out));
  const bob = await disable("bob");
  check("MCP disable_watch: a member pauses the watch of an app a teammate added", bob.out.ok === true && bob.out.watch?.state === "paused" && active() === false, JSON.stringify(bob.out));
  check("the scope table: admin and member may configure a watch, a reader may not", can("admin", "watch.configure") && can("member", "watch.configure") && !can("reader", "watch.configure"));
}

// ── 3. Source: the registry of doors ────────────────────────────────────────
// Each door: the file, the function, the scope it must ask for before the
// lookup, and the lookup it must make (the team's app by id or slug).
const DOORS: Array<{ file: string; fn: string; gate: RegExp; lookup: RegExp }> = [
  { file: "src/lib/app-settings.ts", fn: "updateAppForTeam", gate: /^/, lookup: /where: \{ \.\.\.teamOwned\(actor\.teamId\), id: appId \}/ },
  { file: "src/lib/watch-enable.ts", fn: "enableWatchForApp", gate: /^/, lookup: /where: \{ \.\.\.teamOwned\(user\.teamId\), id: appId \}/ },
  { file: "src/app/dashboard/actions.ts", fn: "setTrackerTeam", gate: /requireActionScope\("integration\.connect"\)/, lookup: /where: \{ \.\.\.teamOwned\(team\.id\), id: appId \}/ },
  { file: "src/app/dashboard/actions.ts", fn: "setIntegrationEndpoints", gate: /requireActionScope\("integration\.connect"\)/, lookup: /where: \{ \.\.\.teamOwned\(team\.id\), id: appId \}/ },
  { file: "src/app/dashboard/actions.ts", fn: "deleteApp", gate: /requireActionScope\("app\.delete"\)/, lookup: /where: \{ \.\.\.teamOwned\(team\.id\), id: appId \}/ },
  { file: "src/app/api/integrations/linear/start/route.ts", fn: "GET", gate: /can\(scope, "integration\.connect"\)/, lookup: /where: \{ \.\.\.teamOwned\(team\.id\), id: appId \}/ },
  { file: "src/app/api/integrations/linear/callback/route.ts", fn: "GET", gate: /can\(scope, "integration\.connect"\)/, lookup: /where: \{ \.\.\.teamOwned\(ours\.id\), id: appId \}/ },
  { file: "src/app/api/watch/[slug]/route.ts", fn: "ownWatch", gate: /requireScope\(db, req, "watch\.configure"\)/, lookup: /where: \{ \.\.\.teamOwned\(team\.id\), appSlug: slug \}/ },
  { file: "src/app/api/status/[slug]/route.ts", fn: "GET", gate: /^/, lookup: /where: \{ \.\.\.teamOwned\(context\.team\.id\), appSlug: \(await params\)\.slug \}/ },
  { file: "src/lib/mcp/tools.ts", fn: "disable_watch", gate: /deny\("watch\.configure"\)/, lookup: /where: \{ \.\.\.teamOwned\(team\.id\), id: args\.app_id \}/ },
];

function fnBody(source: string, fn: string): string {
  const head = source.search(new RegExp(`(export\\s+)?(async\\s+)?function\\s+${fn}\\s*\\(|async ${fn}\\(`));
  if (head < 0) return "";
  // Up to the next top-level function of the same shape, or the end.
  const rest = source.slice(head + 1);
  const next = rest.search(/\n(export\s+)?(async\s+)?function\s+\w+\s*\(|\n {4}async \w+\(/);
  return next < 0 ? source.slice(head) : source.slice(head, head + 1 + next);
}

function sourceChecks() {
  for (const door of DOORS) {
    const body = fnBody(read(door.file), door.fn);
    const gateAt = body.search(door.gate);
    const lookupAt = body.search(door.lookup);
    check(`${door.file}#${door.fn}: asks the scope table, then finds the app as the team's — not by who added it`,
      body.length > 0 && gateAt >= 0 && lookupAt > gateAt && !/ownerId: (user\.id|actor\.userId|caller\.user\.id)|ownerId_appSlug/.test(body),
      body.length === 0 ? "function not found" : `gate@${gateAt} lookup@${lookupAt}`);
  }
  const page = read("src/app/(app)/health/apps/[appId]/page.tsx");
  check("the app page offers Run and Connect by scope alone", /const mayRun = can\(scope, "run\.start"\);/.test(page) && !/app\.ownerId === user\.id/.test(page));
  // The dupe check at create time is the team's, so no second row for an address the team has.
  const settings = read("src/lib/app-settings.ts");
  check("createAppForTeam refuses an address the team already has, whoever added it", /const dupe = await db\.app\.findFirst\(\{\s*where: \{ \.\.\.teamOwned\(actor\.teamId\), appSlug \}/.test(settings));
}

realRows()
  .then(mcpDoor)
  .then(() => {
    sourceChecks();
    console.log(failures ? `\n${failures} FAILED` : "\nall passed");
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.error("verify-team-scoped-app-writes: crashed:", err);
    process.exit(1);
  });
