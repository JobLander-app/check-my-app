// CHE-264 (Teams T11) verification: a change that nobody can trace is a change
// that did not get logged, and the log is kept by the code rather than by
// habit.
//
// The check is over the mutating exports themselves: every server action that
// changes membership, billing, credentials or an app must call
// `recordTeamEvent`. A log written by whoever remembers to call it is complete
// until the first person forgets — and the failure is invisible, because a
// missing line looks exactly like "nothing happened".
//
// Rule 8 calls this class **bookkeeping**: losing track of what we had done or
// been told. The precedent in this codebase is CHE-89/CHE-98 — a paused watch
// came back to life because an agent pressed resume while exploring. With one
// owner that was traceable by memory. With five people it is not.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-team-events.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describeEvent, memberEmailForLog } from "@/lib/team-events";
import type { PrismaClient } from "@/generated/prisma/client";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// The exports that change something a team would want traced, and the file
// each lives in. Adding a mutation means adding it here — which is the point:
// the list is the decision, and the check is that the code matches it.
const MUST_LOG: [string, string][] = [
  ["src/app/team/actions.ts", "inviteMemberAction"],
  ["src/app/team/actions.ts", "revokeInviteAction"],
  ["src/app/team/actions.ts", "changeScopeAction"],
  ["src/app/team/actions.ts", "removeMemberAction"],
  ["src/app/team/actions.ts", "leaveTeamAction"],
  ["src/app/invite/[token]/actions.ts", "acceptInviteAction"],
  ["src/app/dashboard/actions.ts", "createApiKey"],
  ["src/app/dashboard/actions.ts", "revokeApiKey"],
  ["src/app/dashboard/actions.ts", "updateAppSettings"],
  ["src/app/dashboard/actions.ts", "deleteApp"],
  ["src/app/dashboard/actions.ts", "setAppNotifiers"],
  // CHE-237: which project an app's numbers come from decides what every later
  // verdict claims a journey is worth. Changing it silently would make two
  // verdicts disagree with no record of why.
  ["src/app/dashboard/actions.ts", "setAppPosthogProject"],
  ["src/app/dashboard/actions.ts", "setTrackerTeam"],
  // CHE-236: ending the team's analytics access. "Why did the funnel numbers
  // stop" must have a name and a date behind it, not a reconstruction.
  ["src/app/dashboard/actions.ts", "disconnectPostHog"],
  // CHE-315: the app settings rules moved into a library function shared with
  // the MCP update_app tool — the audit line moved with them, so an agent's
  // change is traced exactly like one made on the settings page.
  ["src/lib/app-settings.ts", "updateAppForTeam"],
];

// An action that hands its whole change to a shared function logs through it.
// Declared rather than inferred: the delegate must itself be on MUST_LOG, and
// the action must actually call it.
const DELEGATES: Record<string, string> = {
  updateAppSettings: "updateAppForTeam",
};

function bodyOf(text: string, fn: string): string {
  const at = text.indexOf(`export async function ${fn}`);
  if (at < 0) return "";
  const next = text.indexOf("\nexport ", at + 1);
  return text.slice(at, next < 0 ? text.length : next);
}

for (const [file, fn] of MUST_LOG) {
  const body = bodyOf(read(file), fn);
  const delegate = DELEGATES[fn];
  const delegated =
    delegate !== undefined &&
    MUST_LOG.some(([, name]) => name === delegate) &&
    new RegExp(`\\b${delegate}\\(`).test(body);
  check(`${fn} exists`, body.length > 0, file);
  check(
    `${fn} writes an audit line`,
    /recordTeamEvent\(/.test(body) || delegated,
    body.length ? (delegated ? `through ${delegate}` : "") : "function not found",
  );
}

// A mutating export that nobody listed is the case this check cannot see, so
// the list is compared against reality in the other direction too: every
// server action in these files is either on the list or explicitly not a
// change worth tracing.
const NOT_TRACED = new Set([
  // Starting a check is traced by the run itself — it has an owner, a team and
  // a verdict page. A second record would be a second answer.
  "runSavedApp",
  // Reading and toggling your own notifications is yours alone; an audit line
  // for "I ticked a box for myself" is noise that buries the lines that matter.
  "toggleOwnNotifications",
  // Endpoints are covered by the settings line in updateAppSettings.
  "setIntegrationEndpoints",
]);
for (const file of ["src/app/team/actions.ts", "src/app/dashboard/actions.ts"]) {
  const text = read(file);
  for (const m of text.matchAll(/export async function (\w+)/g)) {
    const fn = m[1];
    const listed = MUST_LOG.some(([f, name]) => f === file && name === fn);
    check(
      `${fn} is either logged or deliberately not`,
      listed || NOT_TRACED.has(fn),
      listed ? "logged" : NOT_TRACED.has(fn) ? "deliberately not" : "UNDECIDED — add it to one list or the other",
    );
  }
}

// ─── The log itself ──────────────────────────────────────────────────────────

const lib = read("src/lib/team-events.ts");
check(
  "an audit line never fails the change it describes",
  /try \{[\s\S]*teamEvent\.create[\s\S]*catch/.test(lib),
);
check(
  "…and says so loudly instead of silently dropping it",
  /console\.warn/.test(lib),
);
// The closed list is about what may be WRITTEN. describeEvent reads a row back
// from the database, where the column is a string like every other — checking
// that too would be asserting SQLite's type system rather than our rule.
check(
  "the action list is closed — a new kind of change is a decision, not a string",
  /export type TeamEventAction =/.test(lib) &&
    /export type TeamEventInput = \{[\s\S]*?action: TeamEventAction;/.test(lib),
);
check(
  "a system change is attributed to the system rather than to nobody",
  describeEvent({ action: "billing.plan_changed", subject: null, summary: "plan changed to starter", actorEmail: null, createdAt: new Date() }) ===
    "CheckMyApp — plan changed to starter",
  describeEvent({ action: "billing.plan_changed", subject: null, summary: "plan changed to starter", actorEmail: null, createdAt: new Date() }),
);
check(
  "a person's change names the person",
  describeEvent({ action: "member.invited", subject: "a@b.test", summary: "invited a@b.test as reader", actorEmail: "boss@team.test", createdAt: new Date() }) ===
    "boss@team.test — invited a@b.test as reader",
);

// ─── Naming the member never fails the change (CHE-350) ─────────────────────
// A scope change or a removal names the person by email. The lookup is ours,
// and a database blip there must not turn a change that happened into an error
// page that skips revalidation: the name is taken before the mutation, by a
// function that cannot throw, and after the mutation the action awaits only
// the seat sync (the change itself) and recordTeamEvent (which cannot throw)
// before it revalidates.

const userLookup = (findUnique: () => Promise<{ email: string } | null>) =>
  ({ user: { findUnique } }) as unknown as PrismaClient;

async function checkMemberNaming() {
  const warn = console.warn;
  console.warn = () => {};
  const named = await memberEmailForLog(userLookup(async () => ({ email: "sam@acme.test" })), "u1");
  const gone = await memberEmailForLog(userLookup(async () => null), "u1");
  let threw = false;
  let fallback = "";
  try {
    fallback = await memberEmailForLog(
      userLookup(async () => {
        throw new Error("D1_ERROR: network connection lost");
      }),
      "u1",
    );
  } catch {
    threw = true;
  }
  console.warn = warn;
  check("a member is named by email", named === "sam@acme.test", named);
  check("a member whose row is gone is still named, not by id", gone === "a former member", gone);
  check("a lookup that throws does not throw", !threw && fallback === "a team member", threw ? "threw" : fallback);
}

const teamActions = read("src/app/team/actions.ts");
for (const [fn, mutation] of [
  ["changeScopeAction", "db.membership.updateMany("],
  ["removeMemberAction", "db.membership.deleteMany("],
] as const) {
  const body = bodyOf(teamActions, fn);
  const at = body.indexOf(mutation);
  const lookupAt = body.indexOf("memberEmailForLog(");
  check(`${fn} names the member before changing anything`, at > 0 && lookupAt > 0 && lookupAt < at, `lookup @${lookupAt}, mutation @${at}`);
  const after = body.slice(at + mutation.length);
  const awaited = [...after.matchAll(/await\s+([\w.]+)\(/g)].map((m) => m[1]);
  check(
    `${fn} awaits only the seat sync and the audit line between the change and revalidation`,
    // CHE-351: the team's page lives at /settings/team.
    awaited.every((f) => f === "syncTeamSeats" || f === "recordTeamEvent") && /revalidatePath\("\/settings\/team"\)/.test(after),
    awaited.join(", "),
  );
}

// Rule 1: this is an account log. Nothing here may leak into what a customer
// reads about their own product, so the summaries must not describe our
// machinery.
const OUR_MACHINERY = /headless|playwright|our (test )?browser|in our environment/i;
for (const [file] of MUST_LOG) {
  const text = read(file);
  for (const m of text.matchAll(/summary: `([^`]*)`/g)) {
    check(`summary says nothing about our machinery: "${m[1].slice(0, 48)}"`, !OUR_MACHINERY.test(m[1]));
  }
}

checkMemberNaming().then(() => {
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
});
