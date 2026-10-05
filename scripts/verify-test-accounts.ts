// CHE-322 verification: an app holds several NAMED test accounts, and a check
// signs in as the one a scenario names — without any password reaching the
// model, a reply, or a finished one-off run.
//
// Driven through the real entry points, in-process, with no network and no
// environment (AGENTS.md): the MCP handler with a stub database that evaluates
// every `where` (scripts/fixtures/mcp-db.ts), the agent's own fill/click tools
// with a stub page, the prompt builders, and the workflow's cleanup function.
//
//   1. create_app / update_app store named accounts encrypted, in the team's
//      rows, with the default account left on the App's own columns; labels
//      are checked (reserved "default", duplicates, shape) before anything is
//      written;
//   2. list_apps returns every account's label and email and never a password
//      in any form; the settings page's loader selects no password either;
//   3. team scoping: team B cannot see, change or remove team A's accounts;
//   4. a run of the app carries them (start_check {app_id}), still encrypted;
//   5. the prompt lists the LABELS and the placeholders — never a password, an
//      email or an encrypted blob;
//   6. {{TEST_PASSWORD:admin}} fills the admin's password and is recorded as the
//      placeholder; an account the run does not have is refused, not typed;
//   7. a rejection is per account: a stale admin password stops the admin and
//      not the default, the run records WHICH (Run.rejectedAccounts) and says so
//      in its live feed; a pre-CHE-322 rejection still means the default;
//   8. a one-off run's cleanup clears EVERY password it carried, and the
//      workflow's two cleanup paths both go through that one function.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-test-accounts.ts

process.env.CREDENTIALS_SECRET ??= "verify-test-accounts-secret";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { hashApiKey } from "@/lib/apiKeys";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { handleMcpRequest } from "@/lib/mcp/handler";
import type { McpDeps } from "@/lib/mcp/tools";
import { listTestAccounts } from "@/lib/app-settings";
import {
  clearedCredentials,
  describeAccounts,
  parseRunAccounts,
  planAccountEdits,
  rejectedAccountLabels,
  testAccountsFromForm,
  usableRunAccounts,
} from "@/lib/test-accounts";
import { discoverySystem, walkingSystem } from "@/agent/instructions";
import { executeTool, markAccountRejected, scrubSecrets, type RecordedAction, type ToolEnv } from "@/agent/tools";
import { credentialState, credentialToolEnv, recordCredentialRejection } from "@/agent/credentials";
import type { AgentEnv } from "@/agent/env";
import { sweepTestAccounts } from "@/agent/janitor";
import { createStubDb } from "./fixtures/mcp-db";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ORIGIN = "https://checkmyapp.dev";
const KEY_A = "cma_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY_B = "cma_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MAIN_PW = "main-login-pw-1";
const ADMIN_PW = "admin-pw-very-secret";
const FREE_PW = "free-user-pw-secret";
const ADMIN_NEW_PW = "admin-rotated-pw";
const STORE_PW = "store-front-pw-secret";

function parse(result: unknown): Record<string, unknown> {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  return JSON.parse(r.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

async function main() {
  const stub = createStubDb({
    user: [
      { id: "u_a", email: "a@team-a.test", name: "Ann" },
      { id: "u_b", email: "b@team-b.test", name: "Bob" },
    ],
    team: [
      { id: "team_a", name: "Team A", plan: "business", isPersonal: false },
      { id: "team_b", name: "Team B", plan: "business", isPersonal: false },
    ],
    apiKey: [
      // Admin keys: a login is an admin's to store (app.credentials.write,
      // CHE-417) — the scope rule itself is held by verify-team-scoped-app-writes.
      { id: "k_a", ownerId: "u_a", teamId: "team_a", scope: "admin", keyHash: await hashApiKey(KEY_A), lastUsedAt: null },
      { id: "k_b", ownerId: "u_b", teamId: "team_b", scope: "admin", keyHash: await hashApiKey(KEY_B), lastUsedAt: null },
    ],
    app: [],
    watch: [],
    run: [],
    counter: [{ id: "counter", name: "runNumber", value: 100 }],
  });
  const triggered: string[] = [];
  const deps: McpDeps = {
    db: stub.db,
    origin: ORIGIN,
    trigger: async (id) => {
      triggered.push(id);
    },
    siteCap: () => 20,
    ephemeralTtlDays: () => 7,
    sleep: async () => {},
    now: () => Date.UTC(2026, 8, 27, 12),
  };
  const connect = async (key: string) => {
    const client = new Client({ name: "verify-test-accounts", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
        fetch: (url: string | URL, init?: RequestInit) => handleMcpRequest(new Request(url, init), deps),
      }),
    );
    return client;
  };
  const a = await connect(KEY_A);
  const b = await connect(KEY_B);
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { out: parse(result), isError: result.isError === true, raw: JSON.stringify(result) };
  };
  const accounts = () => stub.table("testAccount");

  // ── 1 — storing them ──────────────────────────────────────────────────────
  const created = await call(a, "create_app", {
    url: "https://shop.test",
    scenarios: "As admin: refunds go through.\nAs free user: Export offers an upgrade.",
    test_email: "qa@shop.test",
    test_password: MAIN_PW,
    test_accounts: [
      { label: "admin", email: "boss@shop.test", password: ADMIN_PW },
      { label: "Free  User", email: "free@shop.test", password: FREE_PW },
    ],
  });
  const appId = created.out.app_id as string;
  const app = stub.table("app").find((x) => x.id === appId);
  check("create_app: accepted, the default account on the App's own columns",
    created.out.ok === true && app?.testEmail === "qa@shop.test" && decryptSecret(app?.testPasswordEnc as string) === MAIN_PW,
    JSON.stringify(created.out));
  const stored = accounts().filter((r) => r.appId === appId);
  check("create_app: two named accounts, labels normalized, stamped with the team",
    stored.length === 2 && JSON.stringify(stored.map((r) => r.label)) === JSON.stringify(["admin", "free user"]) &&
      stored.every((r) => r.teamId === "team_a"),
    JSON.stringify(stored.map((r) => [r.label, r.teamId])));
  check("create_app: each password is stored encrypted, not as typed",
    stored.every((r) => typeof r.passwordEnc === "string" && r.passwordEnc !== ADMIN_PW && r.passwordEnc !== FREE_PW) &&
      decryptSecret(stored[0].passwordEnc as string) === ADMIN_PW && decryptSecret(stored[1].passwordEnc as string) === FREE_PW);
  check("create_app: \"default\" is never a row — the App's columns are the only copy of it",
    !accounts().some((r) => r.label === "default"));
  check("create_app: its reply carries no password", ![MAIN_PW, ADMIN_PW, FREE_PW].some((p) => created.raw.includes(p)));

  const appsBefore = stub.table("app").length;
  const dupe = await call(a, "create_app", {
    url: "https://other.test",
    test_accounts: [
      { label: "Admin", email: "x@other.test", password: "p1" },
      { label: "admin", email: "y@other.test", password: "p2" },
    ],
  });
  check("create_app: two accounts with one name → invalid_input, and no app is created",
    dupe.isError && dupe.out.code === "invalid_input" && stub.table("app").length === appsBefore, JSON.stringify(dupe.out));
  const both = await call(a, "update_app", {
    app_id: appId,
    test_email: "x@shop.test",
    test_accounts: [{ label: "default", email: "y@shop.test", password: "p" }],
  });
  check("update_app: the default given twice (test_email AND a \"default\" entry) → invalid_input",
    both.isError && both.out.code === "invalid_input" && app?.testEmail === "qa@shop.test", JSON.stringify(both.out));
  const badLabel = await call(a, "update_app", { app_id: appId, test_accounts: [{ label: "{{evil}}", email: "e@shop.test", password: "p" }] });
  check("update_app: a label that could break a placeholder → invalid_input",
    badLabel.isError && badLabel.out.code === "invalid_input" && accounts().length === 2, JSON.stringify(badLabel.out));
  const noPw = await call(a, "update_app", { app_id: appId, test_accounts: [{ label: "support", email: "s@shop.test" }] });
  check("update_app: a NEW account without a password → invalid_input",
    noPw.isError && noPw.out.code === "invalid_input" && accounts().length === 2, JSON.stringify(noPw.out));

  // ── 2 — reading them back ────────────────────────────────────────────────
  const listed = await call(a, "list_apps");
  const listedApp = (listed.out.apps as Array<Record<string, unknown>>).find((x) => x.app_id === appId)!;
  const listedAccounts = listedApp.test_accounts as Array<Record<string, unknown>>;
  check("list_apps: every account by label and email, the default first",
    JSON.stringify(listedAccounts.map((x) => [x.label, x.email])) ===
      JSON.stringify([["default", "qa@shop.test"], ["admin", "boss@shop.test"], ["free user", "free@shop.test"]]),
    JSON.stringify(listedAccounts));
  const encrypted = stored.map((r) => r.passwordEnc as string).concat(app?.testPasswordEnc as string);
  check("list_apps: no password in any form — plain, encrypted, or a password field",
    ![MAIN_PW, ADMIN_PW, FREE_PW, ...encrypted].some((p) => listed.raw.includes(p)) &&
      !/"password(Enc)?"\s*:/.test(listed.out ? JSON.stringify(listed.out) : "") && !listed.raw.includes("passwordEnc"),
    listed.raw.slice(0, 160));
  const pageRows = await listTestAccounts(stub.db, "team_a", appId);
  check("settings page loader: label and email only",
    pageRows.length === 2 && pageRows.every((r) => Object.keys(r).sort().join() === "email,id,label"),
    JSON.stringify(pageRows));

  // ── 3 — team scoping ──────────────────────────────────────────────────────
  const listedB = await call(b, "list_apps");
  check("scope: team B's list_apps has none of team A's accounts",
    !listedB.raw.includes("boss@shop.test") && !listedB.raw.includes("admin"), listedB.raw.slice(0, 160));
  const snapshot = JSON.stringify(accounts());
  const hijack = await call(b, "update_app", {
    app_id: appId,
    test_accounts: [{ label: "admin", email: "attacker@evil.test", password: "mine" }],
    remove_test_accounts: ["free user"],
  });
  check("scope: team B's update_app on team A's app → not_found, and not one account row changed",
    hijack.isError && hijack.out.code === "not_found" && JSON.stringify(accounts()) === snapshot, JSON.stringify(hijack.out));
  check("scope: team B's settings loader sees nothing of team A's app", (await listTestAccounts(stub.db, "team_b", appId)).length === 0);

  // ── editing ───────────────────────────────────────────────────────────────
  const adminEncBefore = accounts().find((r) => r.label === "admin")?.passwordEnc;
  const emailOnly = await call(a, "update_app", { app_id: appId, test_accounts: [{ label: "admin", email: "chief@shop.test" }] });
  const adminAfter = accounts().find((r) => r.label === "admin");
  check("update_app: a new email with no password keeps the stored password (write-only)",
    emailOnly.out.ok === true && adminAfter?.email === "chief@shop.test" && adminAfter?.passwordEnc === adminEncBefore,
    JSON.stringify(emailOnly.out));
  await call(a, "update_app", { app_id: appId, test_accounts: [{ label: "ADMIN", password: ADMIN_NEW_PW }] });
  check("update_app: the label is matched case-insensitively and the password replaced, encrypted",
    accounts().filter((r) => r.appId === appId).length === 2 &&
      decryptSecret(accounts().find((r) => r.label === "admin")?.passwordEnc as string) === ADMIN_NEW_PW);
  const events = stub.table("teamEvent").map((e) => String(e.summary));
  check("team log: account changes are named by label, never by password",
    events.some((e) => e.includes('"admin"')) && ![MAIN_PW, ADMIN_PW, FREE_PW, ADMIN_NEW_PW].some((p) => events.join("|").includes(p)),
    events.filter((e) => e.includes("test account")).join(" | "));

  // The dashboard's one form, read back the way the action reads it.
  {
    const form = new FormData();
    const [admin, free] = accounts().filter((r) => r.appId === appId);
    form.set(`account:${admin.id}:label`, "Owner");
    form.set(`account:${admin.id}:email`, "chief@shop.test");
    form.set(`account:${admin.id}:password`, "");
    form.set(`account:${free.id}:label`, "free user");
    form.set(`account:${free.id}:email`, "free@shop.test");
    form.set(`account:${free.id}:remove`, "1");
    form.set("newAccount:label", "support");
    form.set("newAccount:email", "help@shop.test");
    form.set("newAccount:password", "support-pw");
    const patch = testAccountsFromForm(form);
    const plan = planAccountEdits(accounts().filter((r) => r.appId === appId) as { id: string; label: string; email: string }[], patch);
    check("settings form: rename + remove + add, with a blank password meaning keep",
      plan.ok && plan.updates.length === 1 && plan.updates[0].label === "owner" && !("password" in plan.updates[0]) &&
        plan.deletes.length === 1 && plan.deletes[0].label === "free user" && plan.creates.length === 1 && plan.creates[0].label === "support",
      JSON.stringify(plan));
    const swap = planAccountEdits(
      [{ id: "1", label: "admin", email: "a@x.test" }, { id: "2", label: "user", email: "u@x.test" }],
      { set: [{ match: { id: "1" }, label: "user" }, { match: { id: "2" }, label: "admin" }] },
    );
    check("settings form: swapping two names is allowed (no false duplicate)", swap.ok, JSON.stringify(swap));
    const reserved = planAccountEdits([], { set: [{ label: "Default", email: "d@x.test", password: "p" }] });
    check("labels: \"default\" is reserved for the main login", !reserved.ok);
  }

  // CHE-372: the store password is an access input like these — stored
  // encrypted, said to exist and never returned, carried by the run.
  const storeSet = await call(a, "update_app", { app_id: appId, store_password: STORE_PW });
  check("update_app: store_password stored encrypted, the reply never carries it",
    storeSet.out.ok === true && decryptSecret(app?.storePasswordEnc as string) === STORE_PW && app?.storePasswordEnc !== STORE_PW &&
      !storeSet.raw.includes(STORE_PW));
  const listedStore = await call(a, "list_apps");
  check("list_apps: has_store_password only — not the password, not its blob",
    (listedStore.out.apps as Array<Record<string, unknown>>).find((x) => x.app_id === appId)?.has_store_password === true &&
      !listedStore.raw.includes(STORE_PW) && !listedStore.raw.includes(app?.storePasswordEnc as string),
    listedStore.raw.slice(0, 160));

  // ── 4 — a run carries them ────────────────────────────────────────────────
  const started = await call(a, "start_check", { app_id: appId });
  const run = stub.table("run").find((r) => r.publicId === started.out.run_id)!;
  const carried = parseRunAccounts(run?.testAccounts as string);
  check("start_check {app_id}: the run carries every named account, passwords still encrypted",
    started.out.ok === true && JSON.stringify(carried.map((x) => x.label)) === JSON.stringify(["admin", "free user"]) &&
      !String(run.testAccounts).includes(ADMIN_NEW_PW) && decryptSecret(carried[0].passwordEnc!) === ADMIN_NEW_PW,
    JSON.stringify(started.out));
  check("start_check {app_id}: the run carries the store password, still encrypted",
    typeof run?.storePasswordEnc === "string" && run.storePasswordEnc !== STORE_PW && decryptSecret(run.storePasswordEnc as string) === STORE_PW,
    String(run?.storePasswordEnc).slice(0, 20));

  // ── 5 — the prompt ────────────────────────────────────────────────────────
  const promptRun = {
    targetUrl: "https://shop.test",
    scopeHints: null,
    userNotes: null,
    focusAreas: run.focusAreas as string,
    testEmail: run.testEmail as string,
    testPasswordEnc: run.testPasswordEnc as string,
    testAccounts: run.testAccounts as string,
    storePasswordEnc: run.storePasswordEnc as string,
  };
  for (const [phase, prompt] of [
    ["discovery", discoverySystem(promptRun)],
    ["walking", walkingSystem(promptRun, "As admin: refunds", ["Sign in as admin"])],
  ] as const) {
    check(`prompt (${phase}): names each account and how to sign in as it`,
      prompt.includes('"admin"') && prompt.includes("{{TEST_PASSWORD:admin}}") && prompt.includes("{{TEST_EMAIL:free user}}") &&
        prompt.includes("{{TEST_PASSWORD}}"));
    const leaked = [MAIN_PW, ADMIN_PW, ADMIN_NEW_PW, FREE_PW, "chief@shop.test", "free@shop.test", "qa@shop.test",
      run.testPasswordEnc as string, ...carried.map((x) => x.passwordEnc!),
      STORE_PW, run.storePasswordEnc as string].filter((s) => prompt.includes(s));
    check(`prompt (${phase}): no password, no email, no encrypted blob`, leaked.length === 0, leaked.join(", "));
    check(`prompt (${phase}): says a store password is held, as a fact only`, prompt.includes("STORE PASSWORD IS PROVIDED"));
  }

  // ── 6 — the fill tool picks the right account ────────────────────────────
  const toolAccounts = [
    { label: "admin", email: "chief@shop.test", password: ADMIN_NEW_PW },
    { label: "free user", email: "free@shop.test", password: FREE_PW },
  ];
  function fillingEnv(credentials: ToolEnv["credentials"] = { rejected: false }) {
    let filled: string | null = null;
    // A credential is written in the page by tools.ts WRITE_SECRET (CHE-373); here it lands.
    const locator = { first: () => locator, or: () => locator, fill: async (v: string) => { filled = v; },
      evaluate: async (_write: unknown, arg: { value: string }) => { filled = arg.value; return "ok"; }, inputValue: async () => filled };
    const page = {
      url: () => "https://shop.test/login", waitForLoadState: async () => {}, waitForTimeout: async () => {},
      evaluate: async () => 0, getByLabel: () => locator, getByPlaceholder: () => locator, getByRole: () => locator, locator: () => locator,
    };
    const env = {
      page, targetOrigin: "https://shop.test", testEmail: "qa@shop.test", testPassword: MAIN_PW, testAccounts: toolAccounts,
      networkLog: [], consoleLog: [], credentials, actionTrail: [],
    } as unknown as ToolEnv;
    return { env, received: () => filled, recorded: () => (env.actionTrail as RecordedAction[]).at(-1) };
  }
  for (const [value, expected, account] of [
    ["{{TEST_PASSWORD:admin}}", ADMIN_NEW_PW, "admin"],
    ["{{TEST_EMAIL:Free User}}", "free@shop.test", "free user"],
    [" {{TEST_PASSWORD:free user}}\n", FREE_PW, "free user"],
    ["{{TEST_PASSWORD}}", MAIN_PW, undefined],
  ] as const) {
    const { env, received, recorded } = fillingEnv();
    const result = await executeTool(env, "fill", { label: "Field", value });
    const action = recorded();
    check(`fill ${JSON.stringify(value)}: that account's value reaches the field`,
      result === "Filled (credential substituted server-side)." && received() === expected, `${result} / ${received()}`);
    check(`fill ${JSON.stringify(value)}: recorded as the placeholder, never the value`,
      action?.kind === "fill" && action.value.startsWith("{{TEST_") && !action.value.includes(expected),
      JSON.stringify(action));
    if (account) check(`fill ${JSON.stringify(value)}: the run now signs in as "${account}"`, env.activeAccount === account, String(env.activeAccount));
  }
  {
    const { env, received } = fillingEnv();
    const result = await executeTool(env, "fill", { label: "Password", value: "{{TEST_PASSWORD:ghost}}" });
    check("fill an account the run does not have: refused, names it, offers the real ones, types nothing",
      received() === null && result.includes('"ghost"') && result.includes("{{TEST_PASSWORD:admin}}") && result.includes("missing_access"),
      result.slice(0, 160));
  }
  {
    const env = { testEmail: "qa@shop.test", testPassword: MAIN_PW, testAccounts: toolAccounts } as unknown as ToolEnv;
    const scrubbed = scrubSecrets(env, `echo ${ADMIN_NEW_PW} and chief@shop.test and ${encodeURIComponent(FREE_PW)}`);
    check("scrubSecrets: a named account's password and email are redacted too",
      !scrubbed.includes(ADMIN_NEW_PW) && !scrubbed.includes("chief@shop.test") && !scrubbed.includes(FREE_PW), scrubbed);
  }

  // ── 7 — a rejection is per account, and named ────────────────────────────
  {
    const { env, received } = fillingEnv();
    markAccountRejected(env, "admin");
    const refused = await executeTool(env, "fill", { label: "Password", value: "{{TEST_PASSWORD:admin}}" });
    check("after admin is rejected: the admin password is refused, by name",
      refused.startsWith("Refused:") && refused.includes('"admin"') && received() === null, refused.slice(0, 120));
    const other = await executeTool(env, "fill", { label: "Password", value: "{{TEST_PASSWORD:free user}}" });
    check("after admin is rejected: another account still signs in", received() === FREE_PW, other);
    const main = await executeTool(env, "fill", { label: "Password", value: "{{TEST_PASSWORD}}" });
    check("after admin is rejected: the default still signs in", received() === MAIN_PW, main);
    env.activeAccount = "admin";
    const click = await executeTool(env, "click", { name: "Sign in" });
    check("after admin is rejected: a sign-in click while admin's details are in the form is refused",
      click.startsWith("Refused:") && click.includes('"admin"'), click.slice(0, 120));
  }
  {
    // A row from before named accounts: { rejected: true } and no list.
    const { env, received } = fillingEnv({ rejected: true });
    const dflt = await executeTool(env, "fill", { label: "Password", value: "{{TEST_PASSWORD}}" });
    check("legacy rejection: still refuses the default", dflt.startsWith("Refused:") && received() === null, dflt.slice(0, 80));
    await executeTool(env, "fill", { label: "Password", value: "{{TEST_PASSWORD:admin}}" });
    check("legacy rejection: does not stop a named account", received() === ADMIN_NEW_PW);
  }
  {
    const agentEnv = { db: stub.db } as unknown as AgentEnv;
    await recordCredentialRejection(agentEnv, run.id as string, "POST https://shop.test/api/login → 401", "admin");
    const row = stub.table("run").find((r) => r.id === run.id)!;
    check("rejection recorded: the run says WHICH account (Run.rejectedAccounts)",
      row.credentialsRejected === true && row.rejectedAccounts === JSON.stringify(["admin"]), String(row.rejectedAccounts));
    check("rejection recorded: the live feed names the account",
      String(row.events).includes('the \\"admin\\" test account'), String(row.events).slice(0, 200));
    const state = await credentialState(agentEnv, run.id as string);
    check("rejection recorded: the next phase starts knowing admin — and only admin — was turned away",
      state.rejected && JSON.stringify(state.accounts) === JSON.stringify(["admin"]));
    check("the verdict's wording names the account",
      describeAccounts(rejectedAccountLabels(row as { credentialsRejected: boolean; rejectedAccounts: string })) === 'the "admin" test account');
    const legacy = { id: "r_legacy", credentialsRejected: true, rejectedAccounts: null, events: null, status: "walking" };
    stub.table("run").push(legacy);
    await recordCredentialRejection(agentEnv, "r_legacy", "sig", "admin");
    check("rejection on a pre-CHE-322 row keeps the default it already meant",
      legacy.rejectedAccounts === JSON.stringify(["default", "admin"]), String(legacy.rejectedAccounts));
    const toolEnv = await credentialToolEnv(agentEnv, row as never);
    check("credentialToolEnv: decrypts the named accounts for the tools, in memory",
      toolEnv.testAccounts?.find((x) => x.label === "admin")?.password === ADMIN_NEW_PW &&
        JSON.stringify(toolEnv.credentials) === JSON.stringify({ rejected: true, accounts: ["admin"] }));
  }

  // ── 8 — a one-off run forgets every password ─────────────────────────────
  {
    const cleared = clearedCredentials({ testAccounts: run.testAccounts as string });
    const kept = parseRunAccounts(cleared.testAccounts);
    check("cleanup: the default password and EVERY named password are cleared",
      cleared.testPasswordEnc === null && kept.length === 2 && kept.every((x) => x.passwordEnc === null) &&
        usableRunAccounts(cleared.testAccounts).length === 0 && !cleared.testAccounts!.includes(carried[0].passwordEnc!),
      String(cleared.testAccounts));
    check("cleanup: the store password goes with them (CHE-372)", cleared.storePasswordEnc === null, JSON.stringify(cleared));
    check("cleanup: labels and emails stay, so a rejection can still be named afterwards",
      JSON.stringify(kept.map((x) => [x.label, x.email])) === JSON.stringify([["admin", "chief@shop.test"], ["free user", "free@shop.test"]]));
    const workflow = readFileSync(fileURLToPath(new URL("../src/agent/workflow.ts", import.meta.url)), "utf8");
    const uses = workflow.match(/clearedCredentials\(run\)/g)?.length ?? 0;
    // The ways a run ends: the success cleanup, the failure path, and every
    // early exit (`return;` at the run's own level) — the closed door after the
    // surface scan (CHE-390), the ended sign-in (CHE-389), whatever comes
    // next. Not a count of today's exits: the count was 3 and went red the day
    // a fourth exit was added that did clear, and would have stayed green for
    // one that did not if another use had moved. Each early exit must clear, or
    // be the one that says why it does not (a watch keeps them for its next run).
    const exits = workflow.split(/\n {8}return;\n/).slice(0, -1).map((before) => before.slice(-1600));
    const clearing = exits.filter((before) => /clearedCredentials\(run\)/.test(before));
    const keeping = exits.filter((before) => !/clearedCredentials\(run\)/.test(before));
    check("workflow: every way a run ends clears through clearedCredentials",
      exits.length >= 3 && keeping.every((before) => /Watch retains its credentials/.test(before)) && keeping.length <= 1 &&
        uses === clearing.length + 2 && !/testPasswordEnc:\s*null/.test(workflow),
      `${uses} uses; ${exits.length} early exits, ${clearing.length} clear, ${keeping.length} keep for a watch`);
  }

  // ── the janitor's sweep of a test-account app takes its credentials along ──
  {
    const nothing = { deleteMany: async () => ({ count: 0 }) };
    const removed: unknown[] = [];
    const db = {
      app: { findMany: async () => [{ id: "app_self", appSlug: "self.test" }], deleteMany: async () => ({ count: 1 }) },
      run: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
      watch: { count: async () => 0, deleteMany: async () => ({ count: 0 }) },
      createdResource: { updateMany: async () => ({ count: 0 }) },
      issueLink: nothing, appSnapshot: nothing, ticketPolicy: nothing, trackerIntegration: nothing, repoIntegration: nothing,
      testAccount: { deleteMany: async (args: unknown) => { removed.push(args); return { count: 2 }; } },
    };
    await sweepTestAccounts({ db } as unknown as AgentEnv, new Date());
    check("janitor: a swept app's named test accounts are deleted with it",
      JSON.stringify(removed) === JSON.stringify([{ where: { appId: { in: ["app_self"] } } }]), JSON.stringify(removed));
  }

  await Promise.all([a.close(), b.close()]);
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
