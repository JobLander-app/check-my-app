// CHE-315 verification: the remote MCP server at /mcp.
//
// The agent is meant to become CheckMyApp's primary interface, so this server
// holds the product's authority: it adds apps, stores test passwords, starts
// paid runs and switches recurring checks on. What must hold, driven through
// the real handler (src/lib/mcp/handler.ts) by a real MCP client over the
// Streamable HTTP transport — in-process, no network, a stub database that
// evaluates every `where` (scripts/fixtures/mcp-db.ts):
//
//   1. no key, a malformed key or an unknown key gets a 401 JSON-RPC error and
//      nothing else; GET and DELETE get 405 (stateless);
//   2. the tool list is exactly the twelve tools;
//   3. `instructions` name the team's apps with their latest verdict and the
//      count of new findings, say what to do about them, and stay under 1500
//      characters;
//   4. team scoping: a key of team B does not see, read, change, start or
//      watch team A's app or run — each answer is `not_found`, never a leak;
//   5. the stored password never comes back, is stored encrypted exactly as
//      onboarding stores it, and "" removes it from the app and its watch;
//   6. start_check {app_id} runs the saved app with its stored credentials and
//      scenarios (the dashboard's startSavedApp), binds deploy_sha, and a
//      second start while one runs returns that run marked already_running;
//   7. plan rules apply: a Free team whose credit is spent gets quota_free, a
//      reader key cannot start anything, resuming a paused watch past Free's
//      one is refused;
//   8. latest_results tells a new finding from one the previous run already had
//      (same signature, different run), and wait_for_run gives up inside its
//      budget with timed_out rather than holding the request;
//   9. the plan is said before it is spent (CHE-325, a balance since CHE-327):
//      a Free team's instructions name the plan, the balance left, the typical
//      price, the one watch and the trial, the top-up and upgrade links, and
//      the rule to warn before the balance runs out; list_apps and
//      latest_results carry the same `plan` block; every quota_free /
//      plan_limit refusal carries upgrade_url, and the balance refusals
//      buy_url too; turning back on a watch past its trial is refused rather
//      than answered "on"; and the numbers /guides/connect-your-agent shows
//      are PLAN_LIMITS'.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-mcp-remote.ts

process.env.CREDENTIALS_SECRET ??= "verify-mcp-remote-secret";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { hashApiKey } from "@/lib/apiKeys";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { handleMcpRequest, UNAUTHORIZED_MESSAGE } from "@/lib/mcp/handler";
import { MAX_INSTRUCTIONS_CHARS } from "@/lib/mcp/instructions";
import { WAIT_BUDGET_MS, type McpDeps } from "@/lib/mcp/tools";
import { PLAN_LIMITS, WATCH_TRIAL_DAYS, typicalPriceRange, usd } from "@/lib/plans";

const FREE_CREDIT = PLAN_LIMITS.free.creditUsd ?? 0;
const BUY = "https://checkmyapp.dev/settings/billing";
import type { UserPlan } from "@/lib/enums";
import ConnectAgentGuide from "@/app/guides/connect-your-agent/page";
import { createStubDb } from "./fixtures/mcp-db";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ORIGIN = "https://checkmyapp.dev";
const KEY_A = "cma_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY_A_READER = "cma_cccccccccccccccccccccccccccccccc";
const KEY_B = "cma_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const KEY_FREE = "cma_dddddddddddddddddddddddddddddddd";
const KEY_FREE_LAST = "cma_ffffffffffffffffffffffffffffffff";
const PRICING = `${ORIGIN}/pricing`;
const PASSWORD = "hunter2-very-secret";
const STORE_PASSWORD = "storefront-pw-5531";

const day = (n: number) => new Date(Date.UTC(2026, 8, n, 12));

async function seed() {
  const detail = (where: string, happened: string) => JSON.stringify({ where, whatHappened: happened, whatWeTried: [] });
  return createStubDb({
    user: [
      { id: "u_a", email: "a@team-a.test", name: "Ann" },
      { id: "u_b", email: "b@team-b.test", name: "Bob" },
      { id: "u_f", email: "f@free.test", name: "Fay" },
      { id: "u_g", email: "g@free-two.test", name: "Gus" },
    ],
    team: [
      { id: "team_a", name: "Team A", plan: "business", isPersonal: false },
      { id: "team_b", name: "Team B", plan: "business", isPersonal: false },
      { id: "team_f", name: "Free team", plan: "free", isPersonal: true },
      // CHE-325: a Free team with one check left and a watch past its trial.
      { id: "team_g", name: "Last-check team", plan: "free", isPersonal: true },
    ],
    apiKey: [
      { id: "k_a", ownerId: "u_a", teamId: "team_a", scope: "member", keyHash: await hashApiKey(KEY_A), lastUsedAt: null },
      { id: "k_r", ownerId: "u_a", teamId: "team_a", scope: "reader", keyHash: await hashApiKey(KEY_A_READER), lastUsedAt: null },
      { id: "k_b", ownerId: "u_b", teamId: "team_b", scope: "member", keyHash: await hashApiKey(KEY_B), lastUsedAt: null },
      { id: "k_f", ownerId: "u_f", teamId: "team_f", scope: "admin", keyHash: await hashApiKey(KEY_FREE), lastUsedAt: null },
      { id: "k_g", ownerId: "u_g", teamId: "team_g", scope: "admin", keyHash: await hashApiKey(KEY_FREE_LAST), lastUsedAt: null },
    ],
    app: [
      { id: "app_a", ownerId: "u_a", teamId: "team_a", appSlug: "shop-a.test", targetUrl: "https://shop-a.test",
        targetKind: "website", testEmail: "qa@shop-a.test", testPasswordEnc: encryptSecret(PASSWORD),
        focusAreas: "Checkout must never break.", scopeHints: "Do not touch /admin.", userNotes: "Keep the test account.",
        writeMode: "read_only", createdAt: day(1) },
      { id: "app_b", ownerId: "u_b", teamId: "team_b", appSlug: "secret-b.test", targetUrl: "https://secret-b.test",
        targetKind: "website", testEmail: null, testPasswordEnc: null, focusAreas: null, scopeHints: null,
        userNotes: null, writeMode: "read_only", createdAt: day(1) },
      { id: "app_f1", ownerId: "u_f", teamId: "team_f", appSlug: "free-one.test", targetUrl: "https://free-one.test",
        targetKind: "website", testEmail: null, testPasswordEnc: null, createdAt: day(1) },
      { id: "app_f2", ownerId: "u_f", teamId: "team_f", appSlug: "free-two.test", targetUrl: "https://free-two.test",
        targetKind: "website", testEmail: null, testPasswordEnc: null, createdAt: day(2) },
      { id: "app_g1", ownerId: "u_g", teamId: "team_g", appSlug: "last-one.test", targetUrl: "https://last-one.test",
        targetKind: "website", testEmail: null, testPasswordEnc: null, createdAt: day(1) },
    ],
    watch: [
      { id: "w_a", appId: "app_a", teamId: "team_a", ownerId: "u_a", appSlug: "shop-a.test", targetUrl: "https://shop-a.test",
        frequency: "daily", active: true, testEmail: "qa@shop-a.test", testPasswordEnc: encryptSecret(PASSWORD),
        nextRunAt: day(20), trialEndsAt: null },
      // Free team: one watch running (its trial ends 3 days after the clock
      // below), one paused — resuming it must not fit.
      { id: "w_f1", appId: "app_f1", teamId: "team_f", ownerId: "u_f", appSlug: "free-one.test", targetUrl: "https://free-one.test",
        frequency: "daily", active: true, trialEndsAt: day(23), createdAt: day(1) },
      { id: "w_f2", appId: "app_f2", teamId: "team_f", ownerId: "u_f", appSlug: "free-two.test", targetUrl: "https://free-two.test",
        frequency: "daily", active: false, trialEndsAt: null, createdAt: day(2) },
      // Still switched on, trial over: the scheduler skips it.
      { id: "w_g1", appId: "app_g1", teamId: "team_g", ownerId: "u_g", appSlug: "last-one.test", targetUrl: "https://last-one.test",
        frequency: "daily", active: true, trialEndsAt: day(15), createdAt: day(1) },
    ],
    ticketPolicy: [{ id: "p_a", appId: "app_a", pickupLabels: "[]", repoLabel: null, priorityRule: "{}" }],
    run: [
      { id: "r_a1", publicId: "pub_a1", runNumber: 1, appId: "app_a", teamId: "team_a", ownerId: "u_a", appSlug: "shop-a.test",
        targetUrl: "https://shop-a.test", targetKind: "website", status: "completed", verdict: "needs_attention",
        bottomLine: "Checkout fails.", startedAt: day(10), completedAt: day(10), createdAt: day(10) },
      { id: "r_a2", publicId: "pub_a2", runNumber: 2, appId: "app_a", teamId: "team_a", ownerId: "u_a", appSlug: "shop-a.test",
        targetUrl: "https://shop-a.test", targetKind: "website", status: "completed", verdict: "broken",
        bottomLine: "Checkout fails and sign-in is dead.", startedAt: day(11), completedAt: day(11), createdAt: day(11),
        deploySha: null, deployEnv: null, costUsd: 0.4 },
      { id: "r_b1", publicId: "pub_b1", runNumber: 3, appId: "app_b", teamId: "team_b", ownerId: "u_b", appSlug: "secret-b.test",
        targetUrl: "https://secret-b.test", targetKind: "website", status: "completed", verdict: "all_good",
        bottomLine: "All good.", startedAt: day(11), completedAt: day(11), createdAt: day(11) },
      // CHE-327: the Free team has spent its one-time credit — three checks
      // priced $1 each.
      ...[1, 2, 3].map((i) => ({ id: `r_f${i}`, publicId: `pub_f${i}`, runNumber: 10 + i, appId: "app_f1", teamId: "team_f",
        ownerId: "u_f", appSlug: "free-one.test", targetUrl: "https://free-one.test", targetKind: "website",
        status: "completed", verdict: "all_good", priceUsd: FREE_CREDIT / 3, startedAt: day(i), completedAt: day(i), createdAt: day(i) })),
      // The last-check team has $1.00 left: enough for one more check, which
      // on Free typically starts at typicalPriceRange("free").low.
      ...[1, 2].map((i) => ({ id: `r_g${i}`, publicId: `pub_g${i}`, runNumber: 20 + i,
        appId: "app_g1", teamId: "team_g", ownerId: "u_g", appSlug: "last-one.test", targetUrl: "https://last-one.test",
        targetKind: "website", status: "completed", verdict: "all_good", priceUsd: (FREE_CREDIT - 1) / 2, startedAt: day(i), completedAt: day(i),
        createdAt: day(i) })),
    ],
    finding: [
      // The same regression on both runs — worded differently, same failing request.
      { id: "f1", runId: "r_a1", number: 1, title: "Checkout returns an error", category: "broken", severity: "high",
        mark: "none", anchor: null, detail: detail("/checkout", "POST /api/orders answered 500.") },
      { id: "f2", runId: "r_a2", number: 1, title: "Paying fails at the last step", category: "broken", severity: "high",
        mark: "none", anchor: null, detail: detail("/checkout", "Pressing Pay sent POST /api/orders and got 500 back.") },
      { id: "f3", runId: "r_a2", number: 2, title: "Sign-in button does nothing", category: "broken", severity: "medium",
        mark: "none", anchor: null, detail: detail("/login", "The button stayed pressed and no request left the page.") },
    ],
    counter: [{ id: "counter", name: "runNumber", value: 100 }],
  });
}

function parse(result: unknown): Record<string, unknown> {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const item = r.content?.[0];
  if (!item || item.type !== "text" || !item.text) throw new Error(`tool result has no text: ${JSON.stringify(result)}`);
  return JSON.parse(item.text) as Record<string, unknown>;
}

async function main() {
  const stub = await seed();
  let clock = day(20).getTime();
  const triggered: string[] = [];
  const deps: McpDeps = {
    db: stub.db,
    origin: ORIGIN,
    trigger: async (id) => {
      triggered.push(id);
    },
    siteCap: () => 20,
    ephemeralTtlDays: () => 7,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  const fetchIn = (url: string | URL, init?: RequestInit) => handleMcpRequest(new Request(url, init), deps);

  async function connect(key: string) {
    const client = new Client({ name: "verify-mcp-remote", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
        fetch: fetchIn,
      }),
    );
    return client;
  }
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { result, out: parse(result), isError: result.isError === true };
  };

  // 1 — authentication, before anything is read.
  {
    const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    for (const [label, auth] of [
      ["no Authorization header", undefined],
      ["a malformed key", "Bearer not-a-key"],
      ["a well-formed key nobody issued", "Bearer cma_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"],
    ] as const) {
      const before = stub.calls.length;
      const res = await handleMcpRequest(
        new Request(`${ORIGIN}/mcp`, { method: "POST", headers: auth ? { ...headers, authorization: auth } : headers, body: init }),
        deps,
      );
      const body = (await res.json()) as { error?: { code?: number; message?: string } };
      const touched = stub.calls.slice(before).filter((c) => !c.startsWith("apiKey."));
      check(`auth: ${label} → 401 JSON-RPC error, nothing but the key table read`,
        res.status === 401 && body.error?.message === UNAUTHORIZED_MESSAGE && touched.length === 0 &&
          (res.headers.get("www-authenticate") ?? "").startsWith("Bearer"),
        `${res.status} ${JSON.stringify(body)} ${touched.join(",")}`);
    }
    for (const method of ["GET", "DELETE"]) {
      const res = await handleMcpRequest(new Request(`${ORIGIN}/mcp`, { method, headers: { authorization: `Bearer ${KEY_A}` } }), deps);
      check(`stateless: ${method} → 405`, res.status === 405 && res.headers.get("allow") === "POST", String(res.status));
    }
  }

  const a = await connect(KEY_A);
  const b = await connect(KEY_B);
  const reader = await connect(KEY_A_READER);
  const free = await connect(KEY_FREE);
  const last = await connect(KEY_FREE_LAST);

  check("auth: the key's lastUsedAt is stamped",
    stub.table("apiKey").find((k) => k.id === "k_a")?.lastUsedAt instanceof Date);

  // 2 — the tool list.
  {
    const names = (await a.listTools()).tools.map((t) => t.name).sort();
    const expected = ["create_app", "disable_watch", "enable_watch", "get_check_status", "get_review", "get_verdict",
      "latest_results", "list_apps", "start_check", "update_app", "wait_for_review", "wait_for_run"];
    check("tools: exactly the twelve", JSON.stringify(names) === JSON.stringify(expected), names.join(", "));
  }

  // 3 — instructions, computed from the key's team.
  {
    const text = a.getInstructions() ?? "";
    check("instructions: name the team's app with its latest verdict and new-finding count",
      text.includes("shop-a.test: broken, 1 new finding"), text);
    check("instructions: never mention another team's app", !text.includes("secret-b.test"));
    check("instructions: tell the agent to raise new findings at the start and offer get_review",
      /start of this session/.test(text) && text.includes("get_review"), text.slice(0, 200));
    check("instructions: the user should not need the dashboard", /should not need to open its dashboard/.test(text));
    check(`instructions: under ${MAX_INSTRUCTIONS_CHARS} characters`, text.length <= MAX_INSTRUCTIONS_CHARS, String(text.length));
    const quiet = b.getInstructions() ?? "";
    check("instructions: team B hears only about its own app, and that nothing is new",
      quiet.includes("secret-b.test") && !quiet.includes("shop-a.test") && /Nothing new/.test(quiet), quiet);
  }

  // 4 — team scoping.
  {
    const listA = await call(a, "list_apps");
    const appsA = listA.out.apps as Array<Record<string, unknown>>;
    check("scope: team A lists its app and only its app",
      appsA.length === 1 && appsA[0].app_id === "app_a", JSON.stringify(appsA.map((x) => x.app)));
    const listB = await call(b, "list_apps");
    const appsB = listB.out.apps as Array<Record<string, unknown>>;
    check("scope: team B lists only its own", appsB.length === 1 && appsB[0].app_id === "app_b",
      JSON.stringify(appsB.map((x) => x.app)));

    for (const [tool, args] of [
      ["get_review", { run_id: "pub_a2" }],
      ["get_verdict", { domain_or_run_id: "pub_a2" }],
      ["get_verdict", { domain_or_run_id: "shop-a.test" }],
      ["get_check_status", { run_id: "pub_a2" }],
      ["wait_for_run", { run_id: "pub_a2" }],
      ["update_app", { app_id: "app_a", notes: "pwned" }],
      ["start_check", { app_id: "app_a" }],
      ["enable_watch", { app_id: "app_a", frequency: "every_6h" }],
      ["disable_watch", { app_id: "app_a" }],
    ] as const) {
      const before = triggered.length;
      const r = await call(b, tool, args);
      check(`scope: team B's key → ${tool}(team A's ${"run_id" in args ? "run" : "app"}) is not_found`,
        r.isError && r.out.code === "not_found" && triggered.length === before, JSON.stringify(r.out).slice(0, 160));
    }
    const appA = stub.table("app").find((x) => x.id === "app_a")!;
    const watchA = stub.table("watch").find((x) => x.id === "w_a")!;
    check("scope: …and team A's app and watch are exactly as they were",
      appA.userNotes === "Keep the test account." && watchA.active === true && watchA.frequency === "daily");
    const latestB = await call(b, "latest_results");
    check("scope: team B's latest_results carries nothing of team A",
      !JSON.stringify(latestB.out).includes("shop-a.test"), JSON.stringify(latestB.out).slice(0, 160));
  }

  // 5 — the password.
  {
    const listed = JSON.stringify((await call(a, "list_apps")).out);
    check("password: list_apps says a test account is stored and never returns it",
      listed.includes('"has_test_account":true') && !listed.includes(PASSWORD) && !listed.includes("testPasswordEnc"),
      listed.slice(0, 200));

    const created = await call(a, "create_app", {
      url: "https://new-app.test", scenarios: "Sign-up must work.", test_email: "qa@new-app.test", test_password: PASSWORD,
    });
    const row = stub.table("app").find((x) => x.id === created.out.app_id);
    check("create_app: the app is the key's team's, added by the key's owner",
      created.out.ok === true && row?.teamId === "team_a" && row?.ownerId === "u_a" && row?.focusAreas === "Sign-up must work.",
      JSON.stringify(created.out));
    check("create_app: the password is stored encrypted, the way onboarding stores it",
      typeof row?.testPasswordEnc === "string" && row.testPasswordEnc !== PASSWORD &&
        decryptSecret(row.testPasswordEnc as string) === PASSWORD);
    const watch = stub.table("watch").find((w) => w.appId === row?.id);
    check("create_app: its recurring check belongs to the team and carries the same credentials",
      watch?.teamId === "team_a" && watch?.active === true && decryptSecret(watch.testPasswordEnc as string) === PASSWORD,
      JSON.stringify({ teamId: watch?.teamId, active: watch?.active }));
    check("create_app: nothing it returns carries the password", !JSON.stringify(created.out).includes(PASSWORD));

    const dupe = await call(a, "create_app", { url: "https://new-app.test/" });
    check("create_app: the same app twice → invalid_input pointing at update_app",
      dupe.isError && dupe.out.code === "invalid_input" && String(dupe.out.hint).includes("update_app"), JSON.stringify(dupe.out));

    const cleared = await call(a, "update_app", { app_id: row!.id, test_password: "" });
    const after = stub.table("app").find((x) => x.id === row!.id)!;
    const watchAfter = stub.table("watch").find((w) => w.appId === row!.id)!;
    check("update_app: test_password \"\" removes it from the app and its watch",
      cleared.out.ok === true && after.testPasswordEnc === null && watchAfter.testPasswordEnc === null);
    // CHE-372: the store password of a password-protected store, the same way.
    const storeCreated = await call(a, "create_app", { url: "https://locked-store.test", store_password: STORE_PASSWORD });
    const store = stub.table("app").find((x) => x.id === storeCreated.out.app_id);
    const storeWatch = stub.table("watch").find((w) => w.appId === store?.id);
    check("create_app: store_password is stored encrypted on the app and its watch",
      storeCreated.out.ok === true && typeof store?.storePasswordEnc === "string" && store.storePasswordEnc !== STORE_PASSWORD &&
        decryptSecret(store.storePasswordEnc as string) === STORE_PASSWORD &&
        decryptSecret(storeWatch?.storePasswordEnc as string) === STORE_PASSWORD,
      JSON.stringify(storeCreated.out));
    const storeListed = JSON.stringify((await call(a, "list_apps")).out);
    const storeEntry = ((JSON.parse(storeListed) as { apps: Array<Record<string, unknown>> }).apps).find((x) => x.app_id === store?.id);
    check("list_apps: has_store_password says one is stored, and neither it nor its blob is returned",
      storeEntry?.has_store_password === true && !storeListed.includes(STORE_PASSWORD) &&
        !storeListed.includes(store?.storePasswordEnc as string) && !storeListed.includes("storePasswordEnc"),
      JSON.stringify(storeEntry));
    check("create_app: its reply carries no store password", !JSON.stringify(storeCreated.out).includes(STORE_PASSWORD));
    const storeCleared = await call(a, "update_app", { app_id: store!.id, store_password: "" });
    const storeAfter = stub.table("app").find((x) => x.id === store!.id)!;
    const storeWatchAfter = stub.table("watch").find((w) => w.appId === store!.id)!;
    check("update_app: store_password \"\" removes it from the app and its watch",
      storeCleared.out.ok === true && storeAfter.storePasswordEnc === null && storeWatchAfter.storePasswordEnc === null,
      JSON.stringify({ app: storeAfter.storePasswordEnc, watch: storeWatchAfter.storePasswordEnc }));
    const storeLog = stub.table("teamEvent").map((e) => String(e.summary)).join(" | ");
    check("team log: the store password change is named, never the password",
      storeLog.includes("removed the store password for locked-store.test") && !storeLog.includes(STORE_PASSWORD), storeLog.slice(-200));

    const kept = await call(a, "update_app", { app_id: "app_a", notes: "Never delete the test account." });
    const appA = stub.table("app").find((x) => x.id === "app_a")!;
    check("update_app: fields not passed are untouched — the password stays",
      kept.out.ok === true && appA.userNotes === "Never delete the test account." &&
        decryptSecret(appA.testPasswordEnc as string) === PASSWORD && appA.focusAreas === "Checkout must never break.");
  }

  // 6 — start_check by app.
  {
    const started = await call(a, "start_check", { app_id: "app_a", deploy_sha: "abc1234", deploy_env: "production",
      notes: "PR #9 changed checkout" });
    const run = stub.table("run").find((r) => r.publicId === started.out.run_id);
    check("start_check {app_id}: a run of that app, the team's, handed to the agent",
      started.out.ok === true && run?.appId === "app_a" && run?.teamId === "team_a" && triggered.includes(run?.id as string),
      JSON.stringify(started.out));
    check("start_check {app_id}: it carries the app's stored credentials and scenarios",
      run?.testEmail === "qa@shop-a.test" && decryptSecret(run?.testPasswordEnc as string) === PASSWORD &&
        run?.focusAreas === "Checkout must never break." && run?.scopeHints === "Do not touch /admin.");
    check("start_check {app_id}: bound to the build, this run's note after the app's own",
      run?.deploySha === "abc1234" && run?.deployEnv === "production" &&
        run?.userNotes === "Never delete the test account.\n\nPR #9 changed checkout",
      JSON.stringify({ sha: run?.deploySha, notes: run?.userNotes }));
    const again = await call(a, "start_check", { app_id: "app_a", deploy_sha: "def5678" });
    check("start_check {app_id}: while it runs, a second start returns that run, marked, not bound to the new sha",
      again.out.run_id === started.out.run_id && again.out.already_running === true && again.out.deploy === null,
      JSON.stringify(again.out));
    const both = await call(a, "start_check", { app_id: "app_a", url: "https://shop-a.test" });
    check("start_check: app_id and url together → invalid_input", both.isError && both.out.code === "invalid_input");

    // wait_for_run on a run that is still going: answers inside its budget.
    const t0 = clock;
    const waited = await call(a, "wait_for_run", { run_id: started.out.run_id as string });
    check(`wait_for_run: a running check → timed_out within ${WAIT_BUDGET_MS / 1000}s, not a held request`,
      waited.out.timed_out === true && clock - t0 <= WAIT_BUDGET_MS && waited.out.status === "queued",
      JSON.stringify({ out: waited.out, waitedMs: clock - t0 }));
    const done = await call(a, "wait_for_run", { run_id: "pub_a2" });
    check("wait_for_run: a finished check → its verdict, findings by severity, verdict URL",
      done.out.verdict === "broken" && JSON.stringify(done.out.findings_by_severity) === JSON.stringify({ high: 1, medium: 1 }) &&
        done.out.verdict_url === `${ORIGIN}/verdict/pub_a2`, JSON.stringify(done.out).slice(0, 200));
  }

  // 7 — plan rules and scopes.
  {
    const before = triggered.length;
    const quota = await call(free, "start_check", { url: "https://free-one.test" });
    check("quota: a Free team whose credit is spent → quota_free, nothing started",
      quota.isError && quota.out.code === "quota_free" && triggered.length === before, JSON.stringify(quota.out));
    const byApp = await call(free, "start_check", { app_id: "app_f1" });
    check("quota: the same by app_id → quota_free (the dashboard's gate)",
      byApp.isError && byApp.out.code === "quota_free" && triggered.length === before, JSON.stringify(byApp.out));

    const denied = await call(reader, "start_check", { app_id: "app_a" });
    check("scope: a reader key cannot start a check",
      denied.isError && denied.out.code === "forbidden" && triggered.length === before, JSON.stringify(denied.out));
    const readerCreate = await call(reader, "create_app", { url: "https://reader.test" });
    check("scope: a reader key cannot add an app", readerCreate.isError && readerCreate.out.code === "forbidden");
    const readerList = await call(reader, "list_apps");
    check("scope: a reader key reads", readerList.out.ok === true);

    const resume = await call(free, "enable_watch", { app_id: "app_f2", frequency: "daily" });
    check("watch cap: resuming a paused watch when the plan's one is in use → plan_limit",
      resume.isError && resume.out.code === "plan_limit" &&
        stub.table("watch").find((w) => w.id === "w_f2")?.active === false, JSON.stringify(resume.out));
    const fast = await call(free, "enable_watch", { app_id: "app_f1", frequency: "every_6h" });
    check("watch cap: a cadence the plan does not allow → plan_limit", fast.isError && fast.out.code === "plan_limit");

    const off = await call(a, "disable_watch", { app_id: "app_a" });
    check("disable_watch: pauses it", off.out.ok === true && stub.table("watch").find((w) => w.id === "w_a")?.active === false);
    const on = await call(a, "enable_watch", { app_id: "app_a", frequency: "every_6h" });
    const w = stub.table("watch").find((x) => x.id === "w_a")!;
    check("enable_watch: resumes it at the new cadence inside the plan",
      on.out.ok === true && w.active === true && w.frequency === "every_6h" && w.nextRunAt instanceof Date,
      JSON.stringify(on.out));
  }

  // 8 — latest results.
  {
    const latest = await call(a, "latest_results");
    const app = (latest.out.apps as Array<Record<string, unknown>>).find((x) => x.app_id === "app_a")!;
    const fresh = (app.new_findings as Array<{ title: string }>).map((f) => f.title);
    check("latest_results: the regression the previous run had is not new; the other one is",
      JSON.stringify(fresh) === JSON.stringify(["Sign-in button does nothing"]) && app.previous_run_id === "pub_a1",
      JSON.stringify({ fresh, prev: app.previous_run_id }));
    check("latest_results: latest verdict and findings by severity",
      (app.latest_run as Record<string, unknown>).verdict === "broken" &&
        JSON.stringify(app.findings_by_severity) === JSON.stringify({ high: 1, medium: 1 }));
    const inflight = latest.out.in_flight as Array<{ app_id: string }>;
    check("latest_results: the check started above is listed as in flight",
      inflight.length === 1 && inflight[0].app_id === "app_a", JSON.stringify(inflight));

    const review = await call(a, "get_review", { run_id: "pub_a2" });
    check("get_review: the review a fix is made from, with next actions",
      review.out.ok === true && (review.out.findings as unknown[]).length === 2 &&
        (review.out.next_actions as unknown[]).length === 2, JSON.stringify(review.out).slice(0, 160));
  }

  // 9 — the plan, said before it is spent (CHE-325).
  {
    // CHE-327: the plan is a balance; the agent is told it, and the typical
    // price, before it spends.
    const t = free.getInstructions() ?? "";
    const freeRange = typicalPriceRange("free");
    check("plan: a Free team's instructions name the plan and the balance left",
      t.includes("Plan: Free.") && t.includes("Balance: $0.00 (the free credit does not renew)."), t);
    check("plan: …what a check typically costs, as a price",
      t.includes(`typically ${usd(freeRange.low)}–${usd(freeRange.high)}`), t);
    check("plan: …the one watch in use and the trial's days left",
      t.includes("Watched apps: 1 of 1 (free-one.test: trial, 3 days left)."), t);
    check("plan: …the top-up and upgrade links, built from the request origin",
      t.includes(`Top up: ${BUY}`) && t.includes(`Upgrade: ${PRICING}`), t);
    check("plan: …and the rule: warn before the balance runs out, never surprise",
      /Before starting a check the balance may not cover/.test(t) && /never let a limit surprise them/.test(t), t);
    check(`plan: a Free team's instructions stay under ${MAX_INSTRUCTIONS_CHARS} characters`,
      t.length <= MAX_INSTRUCTIONS_CHARS, String(t.length));

    const l = last.getInstructions() ?? "";
    check("plan: what is left is said as dollars, and a watch past its trial as not running",
      l.includes("Balance: $1.00") && l.includes("(last-one.test: trial ended, not running)"), l);

    const paid = a.getInstructions() ?? "";
    check("plan: a paid team hears its plan, its balance and when the credit renews",
      paid.includes("Plan: Business.") &&
        paid.includes(`the plan adds ${usd(PLAN_LIMITS.business.creditUsd ?? 0)} on`) &&
        !/full re-check/i.test(paid), paid);

    for (const tool of ["list_apps", "latest_results"]) {
      const r = await call(free, tool);
      const p = r.out.plan as Record<string, Record<string, unknown> | string> | undefined;
      const bal = p?.balance as Record<string, unknown> | undefined;
      const w = p?.watches as Record<string, unknown> | undefined;
      const trial = p?.watch_trial as Record<string, unknown> | undefined;
      check(`plan: ${tool} carries the plan block — balance, watches, trial, buy_url, upgrade_url`,
        p?.plan === "free" && bal?.usd === 0 && bal?.plan_credit_usd === FREE_CREDIT && w?.active === 1 &&
          w?.limit === 1 && trial?.days_left === 3 && p?.upgrade_url === PRICING && p?.buy_url === BUY,
        JSON.stringify(p));
    }

    const refusals: Array<[string, Awaited<ReturnType<typeof call>>]> = [
      ["start_check {url} past the Free credit (quota_free)", await call(free, "start_check", { url: "https://free-one.test" })],
      ["start_check {app_id} past the Free credit (quota_free)", await call(free, "start_check", { app_id: "app_f1" })],
      ["enable_watch past the watch cap (plan_limit)", await call(free, "enable_watch", { app_id: "app_f2", frequency: "daily" })],
      ["enable_watch at a cadence the plan lacks (plan_limit)", await call(free, "enable_watch", { app_id: "app_f1", frequency: "every_6h" })],
    ];
    const ended = await call(last, "enable_watch", { app_id: "app_g1", frequency: "daily" });
    refusals.push(["enable_watch on a watch past its trial (plan_limit)", ended]);
    for (const [label, r] of refusals) {
      check(`upgrade: ${label} carries upgrade_url`,
        r.isError && (r.out.code === "quota_free" || r.out.code === "plan_limit") && r.out.upgrade_url === PRICING,
        JSON.stringify(r.out));
      // CHE-327: a balance refusal also carries the top-up link; a plan
      // refusal a top-up cannot answer does not.
      check(`top-up: ${label} ${r.out.code === "quota_free" ? "carries" : "carries no"} buy_url`,
        r.out.code === "quota_free" ? r.out.buy_url === BUY : !("buy_url" in r.out), JSON.stringify(r.out));
    }
    check("trial: turning back on a watch past its trial is refused, not answered \"on\"",
      ended.isError && /trial on this app has ended/.test(String(ended.out.error)) &&
        stub.table("watch").find((w) => w.id === "w_g1")?.trialEndsAt instanceof Date,
      JSON.stringify(ended.out));
    const notFound = await call(free, "start_check", { app_id: "nope" });
    check("upgrade: a refusal no upgrade answers carries no upgrade_url",
      notFound.out.code === "not_found" && !("upgrade_url" in notFound.out), JSON.stringify(notFound.out));

    // The guide renders its plan list from PLAN_LIMITS; read the numbers back
    // out of the rendered page, row by row.
    const html = renderToStaticMarkup(createElement(ConnectAgentGuide));
    const row = (plan: string) =>
      (html.match(new RegExp(`<li[^>]*data-plan="${plan}"[^>]*>([\\s\\S]*?)</li>`))?.[1] ?? "").replace(/<[^>]+>/g, " ");
    const num = (s: string, re: RegExp) => Number(s.match(re)?.[1] ?? NaN);
    const freeRow = row("free");
    check("guide: Free's credit and trial are PLAN_LIMITS.free.creditUsd and WATCH_TRIAL_DAYS",
      num(freeRow, /\$(\d+(?:\.\d+)?) of checks, once/) === FREE_CREDIT &&
        num(freeRow, /(\d+)-day trial/) === WATCH_TRIAL_DAYS, freeRow);
    for (const plan of ["starter", "growth", "business"] as UserPlan[]) {
      const r = row(plan);
      const range = typicalPriceRange(plan);
      check(`guide: ${plan}'s monthly balance and typical price are PLAN_LIMITS.${plan}'s`,
        num(r, /\$(\d+(?:\.\d+)?) of checks every month/) === PLAN_LIMITS[plan].creditUsd &&
          r.includes(`${usd(range.low)}–${usd(range.high)}`) && !/full re-check|watched apps? a/i.test(r), r);
    }
    check("guide: says every tool works on every plan, and links /pricing",
      /Every tool above works on every plan/.test(html) && html.includes('href="/pricing"'));
  }

  // 10 — create_app on a balance that cannot pay does not promise a check
  // (seen live 2026-09-28: $0 left, "the first one is scheduled automatically").
  // Last, because it frees the Free team's one watch slot the sections above rely on.
  {
    await call(free, "disable_watch", { app_id: "app_f1" });
    const zero = await call(free, "create_app", { url: "https://zero-balance.test" });
    const hint = String(zero.out.hint ?? "");
    check("create_app on an empty balance: saved, says it waits for a top-up, carries buy_url and upgrade_url",
      // Free's credit never renews, so the hint must not promise a next credit.
      zero.out.ok === true && /waits until a top-up\./.test(hint) && !/next credit/.test(hint) &&
        !/scheduled automatically/.test(hint) &&
        zero.out.buy_url === `${ORIGIN}/settings/billing` && zero.out.upgrade_url === `${ORIGIN}/pricing`,
      JSON.stringify(zero.out));
    const paid = await call(a, "create_app", { url: "https://paid-team.test" });
    check("create_app on a balance that covers a check: the scheduled-automatically hint, no top-up links",
      paid.out.ok === true && /scheduled automatically/.test(String(paid.out.hint)) && !("buy_url" in paid.out),
      JSON.stringify(paid.out));
  }

  for (const c of [a, b, reader, free, last]) await c.close();
  console.log(failures === 0 ? "\nverify-mcp-remote: all checks passed" : `\nverify-mcp-remote: ${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-mcp-remote: crashed:", err);
  process.exit(1);
});
