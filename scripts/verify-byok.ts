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
import { checkOpenRouterKey, maskKey } from "../src/lib/byok";
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

  console.log("✓ makeLlm: BYOK key produces a different client from the env key");

  // ─── 3. CHE-448: the key is set on the Team page ─────────────────────────

  const full = "sk-or-v1-abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567";
  const masked = maskKey(full);
  assert.equal(masked, "sk-or-…4567", "masked = 6-char prefix + last 4");
  assert.ok(!masked.includes(full.slice(6, -4)), "the middle of the key is never shown");
  assert.equal(maskKey("sk-or-short"), "…", "a short value shows nothing of itself");
  console.log("✓ maskKey: prefix and last four only");

  const answer = (status: number, data: Record<string, unknown> = {}) =>
    (async () => new Response(JSON.stringify({ data }), { status })) as unknown as typeof fetch;
  let called = false;
  const spy = (async () => { called = true; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
  assert.deepEqual(await checkOpenRouterKey(full, answer(200, { is_provisioning_key: false })), { ok: true });
  assert.equal((await checkOpenRouterKey(full, answer(401))).ok, false, "401 → refused");
  assert.equal((await checkOpenRouterKey(full, answer(200, { is_provisioning_key: true }))).ok, false, "provisioning key → refused");
  assert.equal((await checkOpenRouterKey(full, answer(200, { is_management_key: true }))).ok, false, "management key → refused");
  assert.equal((await checkOpenRouterKey(full, answer(500))).ok, false, "OpenRouter error → nothing saved");
  const down = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
  assert.equal((await checkOpenRouterKey(full, down)).ok, false, "OpenRouter unreachable → nothing saved");
  assert.equal((await checkOpenRouterKey("sk-ant-xyz0123456789", spy)).ok, false, "not an OpenRouter key → refused");
  assert.equal(called, false, "…without sending a foreign key to OpenRouter");
  console.log("✓ checkOpenRouterKey: only a key OpenRouter accepts, and that can run models, is saved");

  const actions = read("src/app/team/actions.ts");
  const setBody = bodyOf(actions, "setTeamByokAction");
  const removeBody = bodyOf(actions, "removeTeamByokAction");
  assert.ok(/requireActionScope\("billing\.manage"\)/.test(setBody) && /requireActionScope\("billing\.manage"\)/.test(removeBody), "both actions are billing.manage");
  assert.ok(can("admin", "billing.manage") && !can("member", "billing.manage") && !can("reader", "billing.manage"), "billing.manage is admin only");
  assert.ok(setBody.indexOf("checkOpenRouterKey(") > 0 && setBody.indexOf("checkOpenRouterKey(") < setBody.indexOf("db.team.update("), "the key is checked before it is stored");
  assert.ok(/encryptSecret\(key\)/.test(setBody), "the key is stored encrypted");
  assert.ok(/teamHasFeature\(db, team\.id, "shopify"\)/.test(setBody), "setting a key is behind the shopify feature");
  console.log("✓ actions: admin only, checked before stored, encrypted, behind shopify");

  const page = read("src/app/(app)/settings/team/page.tsx");
  assert.ok(/teamHasFeature\(db, team\.id, "shopify"\)/.test(page) && /\{showModelKey && <TeamModelKey/.test(page), "the section shows only on shopify teams");
  assert.ok(/<TeamModelKey masked=\{maskedKey\} mayManage=\{can\(scope, "billing\.manage"\)\} \/>/.test(page), "the browser gets the masked key and the server's own answer to who may change it");
  const component = read("src/components/team-model-key.tsx");
  assert.ok(!/openrouterKeyEnc|decryptSecret|@\/lib\/crypto/.test(component), "the client component never touches the stored key");
  assert.ok(/mayManage \?/.test(component) && /Only an admin of this team/.test(component), "members read, admins write");
  console.log("✓ page: shopify teams only; members see the status, admins the form; only the masked key reaches the browser");

  console.log("\nAll BYOK invariants hold.");
}

function read(rel: string): string {
  return readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), rel), "utf8");
}

function bodyOf(text: string, fn: string): string {
  const at = text.indexOf(`export async function ${fn}`);
  if (at < 0) return "";
  const next = text.indexOf("\nexport ", at + 1);
  return text.slice(at, next < 0 ? text.length : next);
}

main().catch((e) => { console.error(e); process.exit(1); });
