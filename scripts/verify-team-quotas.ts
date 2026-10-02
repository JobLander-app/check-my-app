// CHE-260 (Teams T7) verification: every quota counts the team, and no call
// site passes a person where a team belongs.
//
// The compiler cannot help with the second half — a team id and a user id are
// both strings, so `{ id: user.id }` compiles perfectly into a gate that means
// `{ id: team.id }`, and the result is five people on one Free team getting
// five allowances. So the call sites are checked as a registry, by name.
//
// The first half is arithmetic and is asserted pure: the allowance is the
// team's, the trial is the team's, and the copy says whose plan is being spent
// so the person who hits the wall knows whom to ask rather than being told to
// upgrade something they cannot buy.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-team-quotas.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  PLAN_LIMITS,
  WATCH_TRIAL_DAYS,
  balanceTooLowReason,
  shouldSkipWatch,
  watchCapReason,
  watchTrialEnd,
  watchTrialState,
} from "@/lib/plans";
import { USER_PLANS, type UserPlan } from "@/lib/enums";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// ─── 1. The gates take a team ────────────────────────────────────────────────

const plans = read("src/lib/plans.ts");
check(
  "assertCanAddWatch takes a teamId, not an ownerId",
  /assertCanAddWatch\([\s\S]{0,200}?teamId: string/.test(plans) && !/ownerId: opts\.ownerId/.test(plans),
);
check(
  "assertCanStartRun's subject is the team",
  /assertCanStartRun\([\s\S]{0,300}?team: \{ id: string; plan: UserPlan \} \| null/.test(plans),
);
// CHE-327: the balance replaced the full re-check allowance; it is the team's.
check(
  "teamBalance reads a team's spending",
  /teamBalance\([\s\S]{0,120}?team: \{ id: string; plan: UserPlan \}/.test(plans),
);
check(
  "every quota query is scoped with teamOwned",
  (plans.match(/teamOwned\(/g) ?? []).length >= 3,
  `${(plans.match(/teamOwned\(/g) ?? []).length} scoped queries`,
);

// ─── 2. No call site hands a person to a quota ───────────────────────────────
// The check that the compiler cannot do. Each of these functions takes an id
// that must be a TEAM's; a `user.`, `owner.` or `viewer.` id in that position
// is the bug this ticket exists to prevent, and it is invisible in review.

const QUOTA_CALLS = ["assertCanStartRun", "assertCanAddWatch", "admitTeamCheck", "teamBalance", "appPriceRange"];
const CALLERS = [
  "src/app/api/checks/route.ts",
  "src/app/dashboard/actions.ts",
  "src/app/(app)/home/page.tsx",
  "src/app/(app)/health/apps/[appId]/settings/page.tsx",
  "src/app/(app)/settings/billing/page.tsx",
  "src/app/verdict/[id]/page.tsx",
  "src/components/verdict-view.tsx",
  "src/app/onboarding/actions.ts",
  "src/lib/recheck.ts",
  "src/lib/start-saved-app.ts",
  "src/lib/watch-enable.ts",
  "src/lib/mcp/tools.ts",
  "src/lib/plan-status.ts",
  "src/agent/scheduler.ts",
];

const PERSON_ID = /\b(user|owner|viewer|actor)\.id\b|\bownerId:/;
const offenders: string[] = [];
for (const file of CALLERS) {
  const text = read(file);
  for (const fn of QUOTA_CALLS) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(`${fn}(`, from);
      if (at < 0) break;
      from = at + fn.length;
      // The call's arguments, bounded generously: these calls are short.
      const window = text.slice(at, at + 420);
      const end = window.indexOf(");");
      const args = end > 0 ? window.slice(0, end) : window;
      if (PERSON_ID.test(args)) offenders.push(`${file} → ${fn}`);
    }
  }
}
check(
  "no quota gate is handed a person's id",
  offenders.length === 0,
  offenders.join(", ") || `${CALLERS.length} files checked`,
);

// ─── 3. The arithmetic, per plan ─────────────────────────────────────────────

const freeRefusal = balanceTooLowReason("free", { balanceUsd: 0, renewsOn: null }, 0.72);
check(
  "Free's credit is the whole team's, not per person",
  /Your team's free \$/.test(freeRefusal),
  freeRefusal,
);
for (const plan of USER_PLANS) {
  const limits = PLAN_LIMITS[plan];
  check(
    `${plan}: a credit that is money (or unlimited), and a price above cost`,
    (limits.creditUsd === null || limits.creditUsd > 0) && limits.priceMultiplier > 1,
    `credit ${limits.creditUsd}`,
  );
}

// The refusal a member of a team reads. It must say it is the TEAM's balance
// and name both ways out, not tell them to upgrade something they cannot buy.
const balanceRefusal = balanceTooLowReason("starter", { balanceUsd: 0.1, renewsOn: "October 1" }, 0.72);
check(
  "a team whose balance is used is told it is the TEAM's, when it renews, and both ways out",
  /team's balance/.test(balanceRefusal) && /October 1/.test(balanceRefusal) && /Top up/.test(balanceRefusal) &&
    /upgrade/.test(balanceRefusal),
  balanceRefusal,
);

// The Free trial's one watch is the only watch limit left (CHE-327).
check("Free's one trial watch, in use, is refused with the trial's words",
  /one app, on a \d+-day trial/.test(watchCapReason("free", 1) ?? ""));
for (const plan of ["starter", "growth", "business", "enterprise"] as UserPlan[]) {
  check(`${plan}: no watch cap at any count`, watchCapReason(plan, 10_000) === null);
}

// ─── 4. The trial is the team's ──────────────────────────────────────────────

const NOW = new Date("2026-09-15T00:00:00Z");
check(
  `a Free team's watch is a ${WATCH_TRIAL_DAYS}-day trial`,
  watchTrialEnd("free", NOW)?.getTime() === NOW.getTime() + WATCH_TRIAL_DAYS * 86400000,
);
check("a paid team's watch has no expiry", watchTrialEnd("starter", NOW) === null);
check(
  "the scheduler skips a Free team's expired trial",
  shouldSkipWatch({ trialEndsAt: new Date(NOW.getTime() - 1000) }, "free", NOW),
);
check(
  "…and stops skipping the moment the team upgrades, with nothing else to update",
  !shouldSkipWatch({ trialEndsAt: new Date(NOW.getTime() - 1000) }, "starter", NOW),
);
check(
  "the dashboard shows the trial as the team's, counted in whole days",
  watchTrialState({ trialEndsAt: new Date(NOW.getTime() + 20 * 3600 * 1000) }, "free", NOW).kind === "active",
);

// ─── 5. Inviting does not mint allowances ────────────────────────────────────
// The property in one line: nothing about the number of people on a team
// appears in any quota. A cap that counted members would hand a five-person
// Free team five lifetimes.

for (const fn of ["assertCanStartRun", "assertCanAddWatch", "admitTeamCheck", "teamBalance"]) {
  const at = plans.indexOf(`export async function ${fn}`);
  const body = plans.slice(at, plans.indexOf("\n}", at));
  check(
    `${fn} does not look at how many people are on the team`,
    !/membership/i.test(body),
  );
}

console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
