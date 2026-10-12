// CHE-436: verify BYOK invariants.
//
// 1. priceRun returns 0 for a run with byokKeyEnc set, regardless of cost.
// 2. makeLlm with a byok key uses it instead of env.OPENROUTER_API_KEY.
// 3. A run created for a team with openrouterKeyEnc carries its byokKeyEnc.
//
// Runs against a stub database — no real D1, no real Cloudflare, no network.
//
// Make the guard fail first: run against the ORIGINAL code and confirm it fails,
// then run against the new code and confirm it passes.

process.env.CREDENTIALS_SECRET ??= "verify-byok-secret";

import assert from "node:assert/strict";
import { encryptSecret, decryptSecret } from "../src/lib/crypto";
import { priceRun } from "../src/agent/pricing";
import { makeLlm } from "../src/agent/llm";
import type { AgentBindings } from "../src/agent/env";
import { CHECK_TIMEOUT_MS, checkOpenRouterKey, maskKey, saveTeamKey, storedKeyView } from "../src/lib/byok";
import { ONLY_ADMINS, keyStatusLine } from "../src/lib/byok-copy";
import { hasEnvironmentLeak, hasHomework } from "../src/lib/verdict-language";
import ts from "typescript";
import { can } from "../src/lib/scopes";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function makeDb(run: Record<string, unknown>) {
  return {
    run: {
      findUnique: async () => run,
      updateMany: async () => ({ count: 1 }),
      aggregate: async () => ({ _sum: { priceUsd: 0, priceFromTopupUsd: 0 } }),
    },
    team: {
      findUnique: async () => ({ topupUsd: 10 }),
      update: async () => ({}),
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function main() {
  // ─── 1. priceRun ─ BYOK run is always free ────────────────────────────────

  const testKey = encryptSecret("sk-or-test-byok-key");

  // A BYOK run with a non-zero cost should still get price 0.
  const byokRun = {
    teamId: "team_test",
    costUsd: 0.85,
    status: "completed",
    priceUsd: null,
    byokKeyEnc: testKey,
    team: { plan: "business" },
  };
  const price1 = await priceRun(makeDb(byokRun) as Parameters<typeof priceRun>[0], "run1");
  assert.equal(price1, 0, "BYOK run must be priced 0 regardless of cost");

  // A non-BYOK run with the same cost should get a non-zero price.
  const normalRun = {
    teamId: "team_test",
    costUsd: 0.85,
    status: "completed",
    priceUsd: null,
    byokKeyEnc: null,
    team: { plan: "business" },
  };
  const price2 = await priceRun(makeDb(normalRun) as Parameters<typeof priceRun>[0], "run2");
  assert.ok(price2 !== null && price2 > 0, "non-BYOK run must get a non-zero price");

  console.log("✓ priceRun: BYOK run → $0, normal run → non-zero");

  // ─── 2. makeLlm ─ BYOK key overrides env.OPENROUTER_API_KEY ──────────────

  const fakeEnv = {
    ANTHROPIC_API_KEY: "sk-ant-fake",
    OPENROUTER_API_KEY: "sk-or-original",
    ANTHROPIC_NAV_MODEL: "deepseek/deepseek-v4-flash",
    ANTHROPIC_SYNTH_MODEL: "claude-sonnet-4-6",
  } as AgentBindings;

  const byokKey = decryptSecret(testKey);
  const llmNormal = makeLlm(fakeEnv);
  const llmByok = makeLlm(fakeEnv, byokKey);
  assert.ok(llmByok.navClient !== llmNormal.navClient, "BYOK creates a different client instance");

  // CHE-448: a BYOK run is priced $0, so not one call may reach a key of ours.
  // Synthesis is a direct Claude id in prod (claude-opus-4-8, LlmUsage since
  // 2026-10-08) — without its OpenRouter twin it would go to Anthropic on ours.
  const keyOf = (c: unknown) => (c as { apiKey: string }).apiKey;
  const urlOf = (c: unknown) => String((c as { baseURL: string }).baseURL);
  const byokClients = [
    llmByok.navClient,
    llmByok.synthClient,
    llmByok.structClient,
    llmByok.judgeClient,
    ...(llmByok.synthRoutes ?? []).map((r) => r.client),
  ];
  for (const c of byokClients) {
    assert.equal(keyOf(c), byokKey, "every BYOK client carries the team's key");
    assert.ok(urlOf(c).includes("openrouter.ai"), "every BYOK client talks to OpenRouter");
  }
  assert.ok(llmByok.synthModel.startsWith("anthropic/claude-"), `synthesis takes its OpenRouter twin (${llmByok.synthModel})`);
  assert.ok((llmByok.synthRoutes ?? []).every((r) => r.model.includes("/")), "no synthesis fallback goes to Anthropic directly");
  assert.equal(llmNormal.synthModel, "claude-sonnet-4-6", "a normal run keeps its model as configured");
  assert.equal(keyOf(llmNormal.synthClient), "sk-ant-fake", "…on our Anthropic key");
  const claudeNav = makeLlm({ ...fakeEnv, ANTHROPIC_NAV_MODEL: "claude-sonnet-4-6" } as AgentBindings, byokKey);
  assert.equal(claudeNav.navModel, "anthropic/claude-sonnet-4.6", "a Claude nav model is routed through OpenRouter too");
  assert.equal(claudeNav.navVision, true, "…and keeps seeing screenshots");
  assert.throws(
    () => makeLlm({ ...fakeEnv, ANTHROPIC_SYNTH_MODEL: "gpt-unrouted" } as AgentBindings, byokKey),
    /no OpenRouter route/,
    "a BYOK run with a model that has no OpenRouter route stops with that reason, never calls a provider with no key",
  );
  assert.equal(makeLlm({ ...fakeEnv, ANTHROPIC_SYNTH_MODEL: "gpt-unrouted" } as AgentBindings).synthModel, "gpt-unrouted", "…a normal run is not affected");

  console.log("✓ makeLlm: in a BYOK run every model goes through OpenRouter on the team's key; a normal run is unchanged");

  // ─── 3. CHE-448: the key is set on the Team page ─────────────────────────

  const full = "sk-or-v1-abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567";
  const masked = maskKey(full);
  assert.equal(masked, "sk-or-…4567", "masked = 6-char prefix + last 4");
  assert.ok(!masked.includes(full.slice(6, -4)), "the middle of the key is never shown");
  assert.equal(maskKey("sk-or-short"), "…", "a short value shows nothing of itself");
  console.log("✓ maskKey: prefix and last four only");

  const answer = (status: number, data: Record<string, unknown> = { usage: 0 }) =>
    (async () => new Response(JSON.stringify({ data }), { status })) as unknown as typeof fetch;
  let called = false;
  const spy = (async () => { called = true; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
  assert.deepEqual(await checkOpenRouterKey(full, answer(200, { usage: 0.5, is_provisioning_key: false })), { ok: true });
  assert.equal((await checkOpenRouterKey(full, answer(200, {}))).ok, false, "a 200 without the key's details proves nothing → refused");
  const notJson = (async () => new Response("<html>gateway</html>", { status: 200 })) as unknown as typeof fetch;
  assert.equal((await checkOpenRouterKey(full, notJson)).ok, false, "a 200 that is not JSON → refused");
  // An OpenRouter that never answers: the request is cut off at its deadline.
  const hanging = ((_u: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as unknown as typeof fetch;
  const t0 = Date.now();
  // AbortSignal.timeout's timer does not keep Node alive: without the interval
  // the process would exit mid-await, silently, with code 0. The watchdog
  // fails the check if the deadline never fires, instead of hanging forever.
  const keepAlive = setInterval(() => {}, 1_000);
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let timedOut: Awaited<ReturnType<typeof checkOpenRouterKey>> | "watchdog";
  try {
    timedOut = await Promise.race([
      checkOpenRouterKey(full, hanging, 30),
      new Promise<"watchdog">((resolve) => { watchdog = setTimeout(() => resolve("watchdog"), 2_000); }),
    ]);
  } finally {
    clearInterval(keepAlive);
    clearTimeout(watchdog);
  }
  assert.notEqual(timedOut, "watchdog", "the deadline cut the request off before the 2 s watchdog");
  assert.equal((timedOut as { ok: boolean }).ok, false, "an OpenRouter that never answers → nothing saved");
  assert.ok(Date.now() - t0 < 2_000, `…cut off at the deadline, not waited out (${Date.now() - t0} ms)`);
  assert.equal(CHECK_TIMEOUT_MS, 10_000, "the deadline in use is 10 s");
  assert.equal((await checkOpenRouterKey(full, answer(401))).ok, false, "401 → refused");
  assert.equal((await checkOpenRouterKey(full, answer(200, { is_provisioning_key: true }))).ok, false, "provisioning key → refused");
  assert.equal((await checkOpenRouterKey(full, answer(200, { is_management_key: true }))).ok, false, "management key → refused");
  assert.equal((await checkOpenRouterKey(full, answer(500))).ok, false, "OpenRouter error → nothing saved");
  const down = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
  assert.equal((await checkOpenRouterKey(full, down)).ok, false, "OpenRouter unreachable → nothing saved");
  assert.equal((await checkOpenRouterKey("sk-ant-xyz0123456789", spy)).ok, false, "not an OpenRouter key → refused");
  assert.equal(called, false, "…without sending a foreign key to OpenRouter");
  console.log("✓ checkOpenRouterKey: only a key OpenRouter accepts, and that can run models, is saved");

  // The actions, read as syntax: every call each one makes, with its arguments.
  const setCalls = callsIn("src/app/team/actions.ts", "setTeamByokAction");
  const removeCalls = callsIn("src/app/team/actions.ts", "removeTeamByokAction");
  const arg0 = (calls: Call[], name: string) => calls.find((c) => c.callee === name)?.args[0];
  assert.equal(arg0(setCalls, "requireActionScope"), '"billing.manage"', "setting a key is billing.manage");
  assert.equal(arg0(removeCalls, "requireActionScope"), '"billing.manage"', "removing a key is billing.manage");
  assert.ok(can("admin", "billing.manage") && !can("member", "billing.manage") && !can("reader", "billing.manage"), "billing.manage is admin only");
  const save = setCalls.find((c) => c.callee === "saveTeamKey");
  const deps = save?.node.arguments[3];
  const encrypt =
    deps && ts.isObjectLiteralExpression(deps)
      ? deps.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === "encrypt")
      : undefined;
  assert.ok(encrypt && ts.isIdentifier(encrypt.initializer) && encrypt.initializer.text === "encryptSecret", "the action stores through saveTeamKey, encrypted with encryptSecret");
  const WRITES = new Set(["update", "updateMany", "upsert", "create", "createMany", "delete", "deleteMany", "$executeRaw", "$executeRawUnsafe"]);
  const bypass = setCalls.filter((c) => ts.isPropertyAccessExpression(c.node.expression) && WRITES.has(c.node.expression.name.text));
  assert.deepEqual(bypass.map((c) => c.callee), [], "…and writes nothing itself: no store can bypass the check");
  assert.ok(setCalls.some((c) => c.callee === "teamHasFeature" && c.args[2] === '"shopify"'), "setting a key is behind the shopify feature");

  // saveTeamKey, called: the key is stored only when the check says ok.
  const writes: unknown[] = [];
  const keyDb = { team: { update: async (args: unknown) => { writes.push(args); return {}; } } } as never;
  const enc = (p: string) => `enc(${p.length})`;
  const refused = await saveTeamKey(keyDb, "t1", full, { encrypt: enc, check: async () => ({ ok: false, reason: "no" }) });
  assert.equal(refused.ok, false, "a refused key is not saved");
  assert.equal(writes.length, 0, "…nothing is written");
  assert.equal((await saveTeamKey(keyDb, "t1", "   ", { encrypt: enc, check: async () => ({ ok: true }) })).ok, false, "an empty key is not saved");
  assert.equal(writes.length, 0, "…nothing is written");
  const accepted = await saveTeamKey(keyDb, "t1", ` ${full} `, { encrypt: enc, check: async () => ({ ok: true }) });
  assert.deepEqual([accepted.ok, writes.length], [true, 1], "an accepted key is written once");
  assert.equal(JSON.stringify(writes[0]).includes(full), false, "…encrypted, never in the clear");
  console.log("✓ actions: admin only; a key is stored only after OpenRouter accepts it, encrypted; behind shopify");

  // A key under a rotated secret is unusable, and the page must say so.
  assert.deepEqual(storedKeyView(null, decryptSecret), null, "no key → nothing to show");
  assert.deepEqual(storedKeyView(testKey, decryptSecret), { masked: maskKey(decryptSecret(testKey)) }, "a readable key → its masked form");
  assert.deepEqual(storedKeyView("not.a.blob", decryptSecret), { unreadable: true }, "an unreadable key → unusable, never 'a key is set'");

  // The page, read as syntax: the one <TeamModelKey>, its guard and its props.
  const usage = jsxUsage("src/app/(app)/settings/team/page.tsx", "TeamModelKey");
  assert.equal(usage.length, 1, "the page renders the section once");
  assert.equal(usage[0].guard, "showModelKey", "…only when the team has the shopify feature");
  assert.ok(callsIn("src/app/(app)/settings/team/page.tsx", "TeamPage").some((c) => c.callee === "teamHasFeature" && c.args[2] === '"shopify"'), "…which is the shopify flag");
  assert.deepEqual(usage[0].props, { stored: "storedKey", mayManage: 'can(scope, "billing.manage")', noCredit: "byokPaused(keyRow)" }, "the browser gets the stored key's view, the server's own answer to who may change it, and whether the key can pay (CHE-458)");
  const component = read("src/components/team-model-key.tsx");
  assert.ok(!/openrouterKeyEnc|decryptSecret|@\/lib\/crypto/.test(component), "the client component never touches the stored key");

  // The words: status only, never homework or our machinery.
  const lines = [keyStatusLine(null).text, keyStatusLine({ masked: "sk-or-…4567" }).text, keyStatusLine({ unreadable: true }).text, ONLY_ADMINS];
  for (const line of lines) {
    assert.ok(!hasHomework(line) && !hasEnvironmentLeak(line), `no homework, no machinery: "${line.slice(0, 50)}…"`);
  }
  assert.equal(keyStatusLine({ unreadable: true }).tone, "broken", "an unusable key reads as broken");
  assert.ok(!/paste|replace|admin/i.test(keyStatusLine({ unreadable: true }).text), "…and states the status without telling anyone what to do");
  console.log("✓ page: shopify teams only; members see the status, admins the form; only the masked key reaches the browser; the words state a status");

  console.log("\nAll BYOK invariants hold.");
  finished = true;
}

// A guard that stops before its last line has proved nothing: make that a failure.
let finished = false;
process.on("exit", (code) => {
  if (code === 0 && !finished) {
    console.error("verify-byok stopped before its last check");
    process.exitCode = 1;
  }
});

function read(rel: string): string {
  return readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), rel), "utf8");
}

type Call = { callee: string; args: string[]; node: ts.CallExpression };

function source(rel: string): ts.SourceFile {
  return ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

// Every call expression inside the named function declaration.
function callsIn(rel: string, fn: string): Call[] {
  const sf = source(rel);
  const out: Call[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isCallExpression(n)) out.push({ callee: n.expression.getText(sf), args: n.arguments.map((a) => a.getText(sf)), node: n });
    n.forEachChild(walk);
  };
  sf.forEachChild((n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === fn && n.body) walk(n.body);
  });
  return out;
}

// Each <Tag …/> in the file: its props as source text, and the identifier it is
// rendered behind (`{guard && <Tag/>}`), if any.
function jsxUsage(rel: string, tag: string): { props: Record<string, string>; guard: string | null }[] {
  const sf = source(rel);
  const out: { props: Record<string, string>; guard: string | null }[] = [];
  const walk = (n: ts.Node) => {
    if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText(sf) === tag) {
      const props: Record<string, string> = {};
      for (const p of n.attributes.properties) {
        if (ts.isJsxAttribute(p) && p.initializer && ts.isJsxExpression(p.initializer) && p.initializer.expression) {
          props[p.name.getText(sf)] = p.initializer.expression.getText(sf);
        }
      }
      const parent = n.parent;
      const guard =
        parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
          ? parent.left.getText(sf)
          : null;
      out.push({ props, guard });
    }
    n.forEachChild(walk);
  };
  walk(sf);
  return out;
}

main().catch((e) => { console.error(e); process.exit(1); });
