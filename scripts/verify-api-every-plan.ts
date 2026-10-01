// CHE-316 verification: an API key on every plan, and the plan still counts.
//
// Owner decision, 2026-09-27 (launch epic CHE-313): the coding agent is the
// primary interface, so every plan — Free included — can mint a key and connect
// MCP. What keeps that from being an open tap is not a gate on the key; it is
// the same balance the UI is held to (CHE-327). This script asserts both
// halves, and the second one behaviourally: a Free team's key that has spent
// its one-time credit is refused with `quota_free`, exactly like the dashboard
// form.
//
// The second half had a hole before this ticket. POST /api/checks answered "which
// team" for a key caller from the minter's PERSONAL team (no cookie → personal),
// not from the key's own team. While only Business teams could mint keys that
// was over-strict; with keys on Free it would let a Free team's key spend a
// paid personal team's allowance instead of its own.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-api-every-plan.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PLAN_LIMITS, assertCanStartRun } from "@/lib/plans";

const FREE_CREDIT = PLAN_LIMITS.free.creditUsd ?? 0;
import { USER_PLANS, type UserPlan } from "@/lib/enums";
import { generateApiKey } from "@/lib/apiKeys";
import { personalTeamId } from "@/lib/teams";
import type { PrismaClient } from "@/generated/prisma/client";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// ─── 1. Every plan can mint a key ────────────────────────────────────────────
// No plan flag, and no plan check in the action that mints. A flag that is true
// everywhere is a flag somebody will flip back without knowing why it exists.

for (const plan of USER_PLANS) {
  check(
    `${plan}: no plan limit stands between the team and an API key`,
    !("apiAccess" in PLAN_LIMITS[plan]),
    `apiAccess: ${String((PLAN_LIMITS[plan] as unknown as Record<string, unknown>).apiAccess)}`,
  );
}

const actions = read("src/app/dashboard/actions.ts");
const mintAt = actions.indexOf("export async function createApiKey");
const mintBody = actions.slice(mintAt, actions.indexOf("\n}", mintAt));
check(
  "createApiKey asks the caller's scope, never the team's plan",
  mintAt >= 0 && !/PLAN_LIMITS|\.plan\b/.test(mintBody) && /mintRefusal/.test(mintBody),
);

const copyFiles = [
  "src/app/pricing/page.tsx",
  "src/app/faq/page.tsx",
  "src/components/api-keys.tsx",
  "src/app/(app)/home/page.tsx",
  "src/app/(app)/settings/api-keys/page.tsx",
  "src/lib/plans.ts",
];
const stale = copyFiles.filter((f) => /Business[ -](plan|tier)|Business\+|API access is available on the Business/i.test(read(f)));
check("no copy still says the API is a Business feature", stale.length === 0, stale.join(", ") || `${copyFiles.length} files`);

const pricing = read("src/app/pricing/page.tsx");
check(
  "pricing says the coding agent connects on every plan",
  /every plan/i.test(pricing) && /MCP/.test(pricing),
);

// ─── 2. A key caller spends ITS team's plan ──────────────────────────────────

const route = read("src/app/api/checks/route.ts");
check(
  "POST /api/checks resolves a key caller's team from the key",
  /callerTeamContext\(prisma, req, auth\)/.test(route) && !/optionalTeamContext\(prisma, owner\)/.test(route),
);

// Behaviour, over a stub database: Ada's personal team is on Business, and she
// minted a key on a Free team that has already used its three lifetime runs.
// Before CHE-316 the key's run would have been counted against her personal
// Business team and waved through.
const ada = { id: "user_ada", email: "ada@example.com", name: "Ada" };
const FREE_TEAM = { id: "team_shared_free", plan: "free", name: "Shared", isPersonal: false };
const PERSONAL = { id: personalTeamId(ada.id), plan: "business", name: "Ada", isPersonal: true };
const rawKey = generateApiKey();

const db = {
  apiKey: {
    findUnique: async () => ({ id: "key_1", owner: ada, team: FREE_TEAM, scope: "member" }),
    update: async () => ({}),
  },
  membership: {
    findMany: async () => [
      { teamId: PERSONAL.id, team: PERSONAL, scope: "admin", createdAt: new Date(0) },
      { teamId: FREE_TEAM.id, team: FREE_TEAM, scope: "member", createdAt: new Date(1) },
    ],
  },
  // CHE-327: the Free team has spent its one-time credit.
  run: {
    aggregate: async ({ where }: { where: { teamId?: string } }) => ({
      _sum: { priceUsd: where.teamId === FREE_TEAM.id ? FREE_CREDIT : 0, priceFromTopupUsd: 0 },
    }),
    findMany: async () => [],
  },
  team: { findUnique: async () => ({ topupUsd: 0 }) },
} as unknown as PrismaClient;

const req = new Request("https://checkmyapp.dev/api/checks", {
  method: "POST",
  headers: { authorization: `Bearer ${rawKey}` },
});

type ResolveTeam = (
  db: PrismaClient,
  req: Request,
  auth: { user: typeof ada; via: "clerk" | "api_key" } | null,
) => Promise<{ team: { id: string; plan: string } } | null>;

// Loaded dynamically so the script reports a FAIL line, rather than a crash,
// on code that predates the resolver.
async function main() {
  let resolveTeam: ResolveTeam | undefined;
  try {
    const mod = (await import("@/lib/team-auth")) as Record<string, unknown>;
    resolveTeam = mod.callerTeamContext as ResolveTeam | undefined;
  } catch (err) {
    console.log(`(team-auth failed to load: ${err instanceof Error ? err.message : String(err)})`);
  }

  // A Free key under its allowance still runs: the key is available, not decorative.
  const fresh = await assertCanStartRun(
    {
      run: { aggregate: async () => ({ _sum: { priceUsd: 0, priceFromTopupUsd: 0 } }), findMany: async () => [] },
      team: { findUnique: async () => ({ topupUsd: 0 }) },
    } as unknown as PrismaClient,
    { id: FREE_TEAM.id, plan: "free" },
    null,
  );
  check("a Free team's key with credit left is let through", fresh.ok);

  if (typeof resolveTeam !== "function") {
    check("a key caller's team is the key's team", false, "callerTeamContext does not exist");
    return;
  }
  const context = await resolveTeam(db, req, { user: ada, via: "api_key" });
  check(
    "a key caller's team is the key's team, not the minter's personal one",
    context?.team.id === FREE_TEAM.id,
    String(context?.team.id),
  );
  const gate = await assertCanStartRun(
    db,
    context ? { id: context.team.id, plan: context.team.plan as UserPlan } : null,
    null,
  );
  check(
    "a Free team's key is refused with quota_free once its credit is spent, like the dashboard form",
    !gate.ok && gate.code === "quota_free",
    gate.ok ? "allowed" : gate.code,
  );

  // The same gate for the same team through a browser: the answer is identical.
  const viaUi = await assertCanStartRun(db, { id: FREE_TEAM.id, plan: "free" }, null);
  check(
    "…and the dashboard caller on that team gets the very same refusal",
    !viaUi.ok && !gate.ok && viaUi.code === gate.code && viaUi.reason === gate.reason,
  );

  // Nobody at all is anonymous; the route's anonymous branch is untouched.
  check("no caller → no team", (await resolveTeam(db, req, null)) === null);
}

main().then(
  () => {
    console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
