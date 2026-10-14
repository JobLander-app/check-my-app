// CHE-261 (Teams T8) verification: the active team is chosen, never inferred.
//
// Two halves, and the second is the one with teeth:
//
//   1. The choosing rule, as a pure function — a cookie is a request, not an
//      authority, so a team the person is not a member of falls back to their
//      own. Asserted without a request or a database.
//   2. **No handler takes a team id from the URL.** A `?team=` or `/[teamId]/`
//      that decides which team you are acting as is a tenancy anyone can type,
//      and it is how a check gets started against the wrong team's budget with
//      nobody able to say why afterwards. Checked over the files, so the first
//      one written that way fails rather than the hundredth.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-team-context.ts

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { ACTIVE_TEAM_COOKIE, chooseTeam, personalTeamId } from "@/lib/teams";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// ─── 1. Choosing ─────────────────────────────────────────────────────────────

const PERSONAL = personalTeamId("u1");
const memberships = [
  { teamId: PERSONAL },
  { teamId: "team_acme" },
  { teamId: "team_client" },
];

check(
  "with no preference, a person acts as their own team",
  chooseTeam(memberships, PERSONAL, null)?.teamId === PERSONAL,
);
check(
  "a preference they are a member of is honoured",
  chooseTeam(memberships, PERSONAL, "team_acme")?.teamId === "team_acme",
);
check(
  "a preference they are NOT a member of falls back to their own team — a cookie is a request, not an authority",
  chooseTeam(memberships, PERSONAL, "team_somebody_else")?.teamId === PERSONAL,
  String(chooseTeam(memberships, PERSONAL, "team_somebody_else")?.teamId),
);
check(
  "an empty preference is the same as none",
  chooseTeam(memberships, PERSONAL, "")?.teamId === PERSONAL,
);
check(
  "someone with no personal team (invited-only, one day) gets their oldest membership",
  chooseTeam([{ teamId: "team_acme" }, { teamId: "team_client" }], PERSONAL, null)?.teamId === "team_acme",
);
check(
  "…and their preference still wins when it is real",
  chooseTeam([{ teamId: "team_acme" }, { teamId: "team_client" }], PERSONAL, "team_client")?.teamId === "team_client",
);
check("no memberships at all resolves to nothing, for the caller to handle", chooseTeam([], PERSONAL, null) === null);
// CHE-481: someone who signed up to accept an invitation, on a new browser.
const invitee = [{ teamId: PERSONAL, apps: 0 }, { teamId: "team_acme", apps: 3 }, { teamId: "team_client", apps: 1 }];
check(
  "an empty personal team gives way to the oldest team they joined — signing in elsewhere opens the team, not an empty one",
  chooseTeam(invitee, PERSONAL, null)?.teamId === "team_acme",
  String(chooseTeam(invitee, PERSONAL, null)?.teamId),
);
check("…their own choice still wins, the empty team included", chooseTeam(invitee, PERSONAL, PERSONAL)?.teamId === PERSONAL);
check(
  "a personal team with apps in it stays the default, whatever else they joined",
  chooseTeam([{ teamId: PERSONAL, apps: 2 }, { teamId: "team_acme", apps: 3 }], PERSONAL, null)?.teamId === PERSONAL,
);
check("an empty personal team and nothing else is still theirs", chooseTeam([{ teamId: PERSONAL, apps: 0 }], PERSONAL, null)?.teamId === PERSONAL);
const teamsSource = readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), "src/lib/teams.ts"), "utf8");
check(
  "activeTeamContext tells the rule how many apps each team holds",
  /_count:\s*\{\s*select:\s*\{\s*apps:\s*true\s*\}\s*\}/.test(teamsSource) && /apps:\s*m\.team\._count\.apps/.test(teamsSource),
);
check("the cookie has a name that says whose it is", ACTIVE_TEAM_COOKIE.startsWith("cma_"), ACTIVE_TEAM_COOKIE);

// ─── 2. Nothing takes tenancy from a URL ─────────────────────────────────────

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(join(ROOT, "src/app")).map((f) => relative(ROOT, f));

// A route segment named for a team would make tenancy part of the address.
const teamSegment = files.filter((f) => /\[(teamId|team)\]/.test(f));
check(
  "no route segment is a team id",
  teamSegment.length === 0,
  teamSegment.join(", ") || "clean",
);

// Reading `team` out of the query string and using it to scope a query is the
// same mistake with a different spelling. The switcher's own redirect carries
// `?team=` as a *message* ("you were switched"), never as a scope, so the
// check is specifically about feeding it to the database.
const FROM_URL = /(searchParams|nextUrl\.searchParams)[\s\S]{0,200}?\bteamId?\b[\s\S]{0,200}?(teamOwned|where)/;
const suspects = files.filter((f) => {
  const text = readFileSync(join(ROOT, f), "utf8");
  return FROM_URL.test(text);
});
check(
  "no page or handler scopes a query by a team id from the URL",
  suspects.length === 0,
  suspects.join(", ") || "clean",
);

// The active team changes in exactly two places — the switch, and pressing
// "Join" on an invitation — and both go through rememberActiveTeam. Each must
// establish membership before it writes, rather than trusting what it is handed.
const switchAction = readFileSync(join(ROOT, "src/app/team/switch-actions.ts"), "utf8");
check(
  "switching verifies membership before it changes anything",
  /db\.membership\.findFirst/.test(switchAction) &&
    switchAction.indexOf("db.membership.findFirst") < switchAction.indexOf("rememberActiveTeam("),
);
const joinAction = readFileSync(join(ROOT, "src/app/invite/[token]/actions.ts"), "utf8");
check(
  "joining makes the person a member before it makes the team their active one",
  joinAction.indexOf("db.membership.upsert") > 0 &&
    joinAction.indexOf("db.membership.upsert") < joinAction.lastIndexOf("rememberActiveTeam(") &&
    // The early exit is the already-a-member branch: membership is the reason it exists.
    joinAction.indexOf('decision.kind === "already_member"') < joinAction.indexOf("rememberActiveTeam("),
);
const writers = walk(join(ROOT, "src"))
  .map((f) => relative(ROOT, f))
  .filter((f) => f !== "src/lib/auth.ts" && /rememberActiveTeam\(/.test(readFileSync(join(ROOT, f), "utf8")))
  .sort();
check(
  "nothing else changes the active team",
  JSON.stringify(writers) === JSON.stringify(["src/app/invite/[token]/actions.ts", "src/app/team/switch-actions.ts"]),
  writers.join(", "),
);
// …and nothing goes around rememberActiveTeam to the cookie itself: the cookie
// is named in exactly two files — where it is defined, and auth.ts, which reads
// and writes it (CodeRabbit on #350).
const cookieFiles = walk(join(ROOT, "src"))
  .map((f) => relative(ROOT, f))
  .filter((f) => !f.startsWith("src/generated/"))
  .filter((f) => {
    const text = readFileSync(join(ROOT, f), "utf8");
    return text.includes("ACTIVE_TEAM_COOKIE") || text.includes(`"${ACTIVE_TEAM_COOKIE}"`);
  })
  .sort();
check(
  "only auth.ts touches the active-team cookie",
  JSON.stringify(cookieFiles) === JSON.stringify(["src/lib/auth.ts", "src/lib/teams.ts"]),
  cookieFiles.join(", "),
);
const authLib = readFileSync(join(ROOT, "src/lib/auth.ts"), "utf8");
check(
  "the cookie is httpOnly — the active team is not a thing page scripts set",
  /export async function rememberActiveTeam[\s\S]{0,200}httpOnly:\s*true/.test(authLib),
);
check(
  "a redirect target from the caller must be a local path",
  /to\.startsWith\("\/"\)/.test(switchAction),
);

console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
