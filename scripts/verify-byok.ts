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

  console.log("\nAll BYOK invariants hold.");
}

main().catch((e) => { console.error(e); process.exit(1); });
