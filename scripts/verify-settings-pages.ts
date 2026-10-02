// The team-level settings pages, each in its own place (CHE-356): the
// checklist of what the old pages held, pinned to where it lives now.
//
//   /settings/api-keys      the agent panel + the team's keys
//   /settings/team          plan in one line, people, invitations, the log, leave
//   /settings/integrations  the team's analytics connection; every app one
//                           click from its own Integrations section
//   /settings/account       which apps mail you, which team you act as
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-settings-pages.ts

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MOVED_ROUTES } from "../src/lib/moved-routes.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const keys = read("src/app/(app)/settings/api-keys/page.tsx");
check("Agent and API keys: the agent panel, from the team's keys' lastUsedAt, above the keys",
  /<ConnectAgent keys=\{apiKeys\.map\(\(k\) => \(\{ lastUsedAt:/.test(keys) && keys.indexOf("<ConnectAgent") < keys.indexOf("<ApiKeys") && keys.indexOf("<ApiKeys") > 0);
check("…the keys are the team's", /db\.apiKey\.findMany\(\{\s*where: \{ \.\.\.teamOwned\(team\.id\) \}/.test(keys));

const team = read("src/app/(app)/settings/team/page.tsx");
check("Team: the plan in Billing's own sentence, with the way to Billing",
  /balanceLine\(\{ plan: team\.plan, creditUsd: balance\.creditUsd, renewsOn: balance\.renewsOn, topupUsd: balance\.topupUsd, usd \}\)/.test(team) && /href="\/settings\/billing"/.test(team));
check("…no money action on it: top-ups and the portal stay on Billing, for those who may bill", !/TopUpCta|ManageBillingButton/.test(team));
for (const [what, action] of [["change of access", "changeScopeAction"], ["removal", "removeMemberAction"], ["invitation", "inviteMemberAction"], ["cancelling an invitation", "revokeInviteAction"], ["leaving", "leaveTeamAction"]] as const) {
  check(`Team: ${what}`, team.includes(action));
}
check("Team: the log of what happened", /db\.teamEvent\.findMany\(/.test(team) && /describeEvent\(/.test(team));
check("Team: the seats line", /seatSummary\(/.test(team));
check("Team: controls only for those the server would honour", /const mayManage = can\(scope, "member\.scope\.change"\)/.test(team) && /const mayInvite = can\(scope, "member\.invite"\)/.test(team));

const integrations = read("src/app/(app)/settings/integrations/page.tsx");
check("Integrations: the team's analytics connection", /<AnalyticsConnection connection=\{posthog\} \/>/.test(integrations));
check("…and every app, connected or not, one click from its own Integrations section",
  /href=\{appPath\.section\(app\.id, "integrations"\)\}/.test(integrations) && !/appPath\.settings\(app\.id\)/.test(integrations));
check("…described in the app page's own words", /integrationsLabel\(\{/.test(integrations) && /integrationsLabel\(\{/.test(read("src/app/(app)/health/apps/[appId]/page.tsx")));
check("…no token leaves the loader", !/accessTokenEnc|refreshTokenEnc: row/.test(integrations.slice(integrations.indexOf("return {"))));

const account = read("src/app/(app)/settings/account/page.tsx");
check("Account: which apps mail you", /toggleOwnNotifications\.bind\(null, app\.id\)/.test(account));
check("Account: which team you act as", /<TeamSwitcher teams=\{teams\} activeTeamId=\{team\.id\} \/>/.test(account));
check("each of the two pages names the other", /\/settings\/team/.test(account) && /\/settings\/account/.test(team));

check("the old /team address lands on the team's page", MOVED_ROUTES.some((r) => r.from === "/team" && r.to === "/settings/team"));
check("nothing in these pages still says it is to be redrawn", ![keys, team, integrations, account].some((s) => /redraws it/.test(s)));

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
