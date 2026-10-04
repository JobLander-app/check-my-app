// The App page (CHE-358): what it decides before it draws.
//
//   1. A check's line in the timeline is the first sentence of what that check
//      told its owner — never rephrased — with the fixed coverage sentence of a
//      partial check set aside as a note (real bottom lines from prod below).
//   2. The small labels: test accounts, integrations, journeys, who started the
//      window's checks.
//   3. The page: team-scoped queries, prices only (CLAUDE.md §10), the status
//      line is the strip's own story, "Keeps coming back" lists recurring
//      problems only, and the Run button is the saved app's.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-app-page.ts

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { accountsLabel, costSplit, firstSentence, integrationsLabel, journeysLabel, splitBottomLine } from "../src/lib/app-page";
import { QUICK_COMPARISON, quickCheckWork } from "../src/lib/check-price";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, got === want, `${JSON.stringify(got)}${got === want ? "" : ` ≠ ${JSON.stringify(want)}`}`);

// ── 1. The timeline's line ──────────────────────────────────────────────────
eq("first sentence: stops at the first full stop before a capital",
  firstSentence("Nothing broke this run — sign-in and the live call work end-to-end. The German page still has an English title."),
  "Nothing broke this run — sign-in and the live call work end-to-end.");
eq("first sentence: a version number or a price does not end it",
  firstSentence("v2.1 is live and the $0.89 plan shows on pricing. Nothing else changed."), "v2.1 is live and the $0.89 plan shows on pricing.");
eq("first sentence: one sentence stays whole", firstSentence("All clear this run"), "All clear this run");
eq("first sentence: nothing said", firstSentence(null), "");
check("first sentence: longer than the limit is cut at a word and marked",
  (() => { const s = firstSentence(`${"word ".repeat(60)}end`, 80); return s.length <= 81 && s.endsWith("…") && !/\s…$/.test(s); })());

// Real bottom lines of joblander.app (prod #284, #278, #273), as stored.
const P284 = "Re-checked 5 of 8 journeys; 3 carried forward from Run #278 (last walked Sep 30). Sign-in works but its button lingers in a disabled state. The rest held.";
const P278 = "Re-checked 4 of 8 journeys (1 couldn't be re-walked this run); 3 carried forward from Run #274 (last walked Sep 29). The coach call connected.";
const P273 = "Re-checked 5 of 7 journeys; 2 carried forward from 2 earlier runs (last walked Sep 29). Everything walked today works.";
for (const [name, text, coverage, said] of [
  ["one source run", P284, "Re-checked 5 of 8 journeys", "Sign-in works but its button lingers in a disabled state. The rest held."],
  ["some could not be re-walked", P278, "Re-checked 4 of 8 journeys", "The coach call connected."],
  ["several source runs", P273, "Re-checked 5 of 7 journeys", "Everything walked today works."],
] as const) {
  const s = splitBottomLine(text);
  check(`partial check, ${name}: the coverage sentence is set aside and the row leads with what was said`,
    s.coverage === coverage && s.said === said && firstSentence(s.said) === said.split(". ")[0].replace(/\.?$/, "."), JSON.stringify(s));
}
const plain = splitBottomLine("Nothing broke this run.");
check("a full check has no coverage note", plain.coverage === null && plain.said === "Nothing broke this run.");
// The sentence is written by src/agent/partial.ts; if its shape changes, this
// must fail rather than let the preamble back into the timeline.
// (Pinned on the source: the agent module does not load outside the worker.)
const partial = read("src/agent/partial.ts");
const SHAPE = [
  "`Re-checked ${rewalked} of ${k + m} journey${k + m === 1 ? \"\" : \"s\"}` +",
  "(missed ? ` (${missed} couldn't be re-walked this run)` : \"\") +",
  "`; ${m} ${from} (last walked ${formatDay(oldestIso)}).`",
  "? `carried forward from Run #${[...sources][0]}`",
  ": `carried forward from ${sources.size} earlier runs`;",
];
check("the coverage sentence the agent writes today is the one the page sets aside",
  SHAPE.every((line) => partial.includes(line)), SHAPE.filter((line) => !partial.includes(line)).join(" | "));
const onlyCoverage = splitBottomLine("Re-checked 3 of 4 journeys; 1 carried forward from Run #1 (last walked Sep 30).");
check("a bottom line that is only the coverage sentence leaves nothing said", onlyCoverage.coverage !== null && onlyCoverage.said === "", JSON.stringify(onlyCoverage));

// ── 2. The labels ───────────────────────────────────────────────────────────
eq("accounts: none", accountsLabel(false, 0), "None");
eq("accounts: the default login is one", accountsLabel(true, 0), "1 account");
eq("accounts: default and two named", accountsLabel(true, 2), "3 accounts");
eq("integrations: none", integrationsLabel({ tracker: false, analyticsProject: null, repo: false, webhook: false, slack: false }), "None");
eq("integrations: by name", integrationsLabel({ tracker: true, analyticsProject: "JobLander", repo: false, webhook: true, slack: false }), "Linear · PostHog · Webhook");
eq("journeys: none mapped", journeysLabel(0), "Not mapped yet");
eq("journeys: one", journeysLabel(1), "1 journey");
eq("journeys: several", journeysLabel(12), "12 journeys");
const usd = (n: number) => `$${n.toFixed(2)}`;
eq("cost: both sides", costSplit({ count: 30, usd: 13.63 }, { count: 1, usd: 1.09 }, usd), "30 scheduled checks $13.63, 1 on request $1.09.");
eq("cost: only on request", costSplit({ count: 0, usd: 0 }, { count: 17, usd: 0.38 }, usd), "17 on request $0.38.");
eq("cost: one scheduled check", costSplit({ count: 1, usd: 0.5 }, { count: 0, usd: 0 }, usd), "1 scheduled check $0.50.");
eq("cost: nothing in the window", costSplit({ count: 0, usd: 0 }, { count: 0, usd: 0 }, usd), "No checks in this window.");

// ── 3. The page ─────────────────────────────────────────────────────────────
const page = read("src/app/(app)/health/apps/[appId]/page.tsx");
check("the app and its checks are read for the team", /db\.app\.findFirst\(\{\s*where: \{ \.\.\.teamOwned\(team\.id\), id: appId \}/.test(page) &&
  /db\.run\.findMany\(\{(?:\s*\/\/[^\n]*)*\s*where: \{\s*\.\.\.teamOwned\(team\.id\),/.test(page));
// Codex round 3 on #241: one rule for which checks are the app's, and one
// app's worth of database work.
check("the timeline takes the app's checks by appHealth's rule: attached, or unattached with the team's only app of that address",
  /OR: \[\{ appId: app\.id \}, \.\.\.\(onlyOneWithSlug \? \[\{ appId: null, appSlug: app\.appSlug \}\] : \[\]\)\]/.test(page) &&
    /onlyOneWithSlug = \(await db\.app\.count\(\{ where: \{ \.\.\.teamOwned\(team\.id\), appSlug: app\.appSlug \} \}\)\) === 1/.test(page));
check("…and it is the rule appHealth itself applies", /OR: \[\{ appId: app\.id \}, \.\.\.\(unique \? \[\{ appId: null, appSlug: app\.appSlug \}\] : \[\]\)\]/.test(read("src/lib/app-health.ts")));
check("the page asks both report builders for this app alone",
  /appHealth\(db, team\.id, \{ only: app\.id \}\)/.test(page) && /recurringByApp\(db, team\.id, app\.id\)/.test(page));
check("the status line is the strip's own story, not a model's sentence", /stripStory\(\(mine\?\.verdicts \?\? \[\]\)\.map/.test(page));
check("'Keeps coming back' lists recurring problems only", /filter\(\(i\) => i\.state === "recurring"\)/.test(page));
check("prices only: the page names no cost, token or margin field", !/costUsd|cost_usd|tokens|multiplier|margin/i.test(page));
check("the timeline shows only finished checks with a verdict and a price — the header's rule — newest first by number",
  /status: \{ in: FINISHED \}, verdict: \{ not: null \}, priceUsd: \{ not: null \},\s*\},\s*orderBy: \{ runNumber: "desc" \}/.test(page));
check("the tracker offer is shown only to someone the connect flow will accept",
  /const mayConnectTracker =\s*can\(scope, "integration\.connect"\) && PLAN_LIMITS\[team\.plan as UserPlan\]\.trackerIntegration && app\.ownerId === user\.id;/.test(page) &&
    /app\.tracker === null && mayConnectTracker &&/.test(page));
const start = read("src/app/api/integrations/linear/start/route.ts");
check("…and those are the start route's own three conditions",
  /can\(scope, "integration\.connect"\)/.test(start) && /PLAN_LIMITS\[team\.plan as UserPlan\]\.trackerIntegration/.test(start) && /id: appId, ownerId: user\.id/.test(start));
check("the Run button is the saved app's, as the main action", /<RunSavedApp appId=\{app\.id\} primary \/>/.test(page));
// Codex P1 on #241: a button a reader may not press, or that answers "App not
// found" for a teammate's app, is not shown.
check("the Run button is shown only where pressing it starts a check: the scope allows it and the app is the viewer's own",
  /const mayRun = can\(scope, "run\.start"\) && app\.ownerId === user\.id;/.test(page) && /\{mayRun && <RunSavedApp appId=\{app\.id\} primary \/>\}/.test(page));
check("an extension's Schedule row is a statement, not a link to a schedule it cannot have",
  /isExtension \? \([\s\S]*?On request only[\s\S]*?\) : \(\s*<Row href=\{appPath\.schedule\(app\.id\)\}/.test(page));
check("a quick check's row is the price explanation's own line, never its stored bottom line",
  /run\.quickPagesOpened !== null\s*\? \{ coverage: null, said: `\$\{quickCheckWork\(run\.quickPagesOpened\)\}\.` \}/.test(page));
eq("quick check: the line", quickCheckWork(31), "Quick check — nothing had changed, 31 pages opened");
check("quick check: the line names none of our machinery", !/smoke|agent|replay|headless|browser/i.test(`${quickCheckWork(1)} ${QUICK_COMPARISON}`));
check("the cost card does not repeat a quick check's comparison", /comparison !== QUICK_COMPARISON/.test(page));

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
