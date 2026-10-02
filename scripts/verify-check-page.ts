// A check opens inside the app (CHE-371): `/health/apps/{appId}/checks/{n}`
// keeps the sidebar; `/verdict/{id}` stays the link to share.
//
//   1. The line "what this check changed" — every shape, from recurrence as it
//      stood at that check (the real-database half is in
//      scripts/verify-recurring-load.ts). "Gone" is never read off a missing
//      row (CLAUDE.md §8).
//   2. One body for both routes: the permalink and the in-app page render
//      VerdictView and hold nothing of the run themselves.
//   3. The in-app page reads only the team's rows, by number, and names no cost.
//   4. Every link to a check from inside the app goes to the in-app page; a
//      check of no saved app goes to its permalink.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-check-page.ts

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkDelta, deltaLine } from "../src/lib/check-delta";
import { appPath, checkHref } from "../src/lib/app-shell";
import type { Recurrence } from "../src/lib/recurring";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, got === want, `${JSON.stringify(got)}${got === want ? "" : ` ≠ ${JSON.stringify(want)}`}`);

// ── 1. The line ─────────────────────────────────────────────────────────────
const rec = (first: number, seen: number[], gone: number | null = null, state: Recurrence["issue"]["state"] = "new"): Recurrence => ({
  issue: {
    signature: `sig-${first}-${seen.join("-")}`, appId: "a", title: "t", category: "broken", severity: "high",
    firstSeenRunNumber: first, lastSeenRunNumber: seen[seen.length - 1], timesSeen: seen.length, state, issueLinkId: null,
  },
  goneSinceRunNumber: gone,
  sightings: seen.map((runNumber) => ({ runNumber, findingId: `f${runNumber}`, title: "t" })),
});
const checks = [270, 280, 288, 290];
const line = (recs: Recurrence[], n: number, quick = false) => deltaLine(checkDelta(recs, checks, n), quick);

eq("the first check of an app", line([rec(270, [270])], 270), "The first check of this app.");
eq("two new, one gone (the owner's #290)", line([rec(290, [290]), rec(290, [290]), rec(280, [280], 290, "gone")], 290), "Since check #288: 2 new problems, 1 gone.");
eq("one new", line([rec(290, [290])], 290), "Since check #288: 1 new problem.");
eq("nothing new, one still there", line([rec(280, [280, 288, 290], null, "recurring")], 290), "Since check #288: nothing new, 1 still there.");
eq("new, still there and gone together", line([rec(290, [290]), rec(280, [280, 290], null, "recurring"), rec(270, [270], 290, "gone")], 290),
  "Since check #288: 1 new problem, 1 still there, 1 gone.");
eq("nothing at all", line([], 290), "Since check #288: nothing new.");
eq("a problem found earlier and not seen in this check is NOT gone unless a check looked again",
  line([rec(280, [280], null, "new")], 290), "Since check #288: nothing new.");
eq("gone is said once, in the check that looked again — not in the ones after", line([rec(270, [270], 280, "gone")], 290), "Since check #288: nothing new.");
eq("what the owner ruled not a bug is not counted as a problem", line([rec(290, [290], null, "not_a_bug")], 290), "Since check #288: nothing new.");
eq("a quick check walked nothing and says only that", line([rec(280, [280], null, "new")], 290, true), "Nothing had changed since check #288, so nothing was walked again.");
eq("a quick check that is the app's first is still the first", line([], 270, true), "The first check of this app.");
const delta = read("src/lib/check-delta.ts");
check("the line rests on recurrence alone: the module reads no finding list and no database", !/findings|PrismaClient|db\./.test(delta.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
check("no shape of the line names our machinery",
  [line([], 290), line([rec(290, [290])], 290), line([], 290, true), line([], 270)].every((l) => !/\b(run|agent|smoke|replay|browser|carried)\b/i.test(l)));

// ── 2. One body ─────────────────────────────────────────────────────────────
const permalink = read("src/app/verdict/[id]/page.tsx");
const inApp = read("src/app/(app)/health/apps/[appId]/checks/[runNumber]/page.tsx");
const view = read("src/components/verdict-view.tsx");
check("the permalink renders VerdictView", /<VerdictView id=\{\(await params\)\.id\} watchError=\{watchError\} recheck=\{recheck\} balance=\{balance\} \/>/.test(permalink));
check("…and loads nothing of the run for its body (metadata alone)", (permalink.match(/prisma\.run\./g) ?? []).length === 1 && !/journeys:|findings: \{|bottomLine/.test(permalink));
check("the in-app page renders the same component, by the check's public id", /<VerdictView\s+id=\{run\.publicId\}/.test(inApp) && /inApp=\{\{ checkHref: /.test(inApp));

// A refused re-check or a gated watch is read where the button was pressed
// (Codex P2 on #247): the in-app page sends its own address with the action,
// and the action takes it only if it is the app's check address — a bound
// argument travels through the browser.
const actions = read("src/app/verdict/actions.ts");
const backPattern = actions.match(/const IN_APP_CHECK = \/(.+)\/;/)?.[1];
const inAppCheck = backPattern ? new RegExp(backPattern) : null;
check("the way back is the app's own check address, or the permalink",
  /return typeof back === "string" && IN_APP_CHECK\.test\(back\) \? back : `\/verdict\/\$\{publicId\}`;/.test(actions) && inAppCheck !== null);
for (const [path, ok] of [
  ["/health/apps/cms0dumln00037z1tmlv80ijk/checks/290", true],
  ["https://evil.example/health/apps/a/checks/1", false],
  ["//evil.example/health/apps/a/checks/1", false],
  ["/health/apps/a/checks/1?next=https://evil.example", false],
  ["/health/apps/a/checks/1/../../../settings/billing", false],
  ["/health/apps/a/checks/1\n/evil", false],
  ["/sign-in", false],
] as const) {
  check(`way back ${JSON.stringify(path)} is ${ok ? "taken" : "refused"}`, inAppCheck?.test(path) === ok);
}
check("every refusal of the three actions goes to the way back — none is hard-wired to the permalink",
  (actions.match(/redirect\(`\/verdict\/\$\{publicId\}/g) ?? []).length === 0 && /doRecheck\(publicId, false, wayBack\(publicId, back\)\)/.test(actions) &&
    /doRecheck\(publicId, true, wayBack\(publicId, back\)\)/.test(actions) && /const here = wayBack\(publicId, back\);/.test(actions));
check("the in-app page sends its address and renders what comes back",
  /back: appPath\.check\(app\.id, run\.runNumber\)/.test(inApp) && /watchError=\{watchError\}\s+recheck=\{recheck\}\s+balance=\{balance\}/.test(inApp) &&
    (view.match(/back=\{inApp\?\.back\}/g) ?? []).length === 4);
check("the permalink sends none, so it behaves as before", !/back=/.test(permalink));
check("who may see and press what is decided in the body, for both routes", /viewerCapabilities\(\{/.test(view) && !/viewerCapabilities|caps\./.test(inApp));
check("the price explanation stays the paying team's alone", /viewerTeam\.team\.id === run\.teamId/.test(view));
check("inside the app, a newer check opens inside the app", /inApp \? inApp\.checkHref\(newerRun\) : `\/verdict\/\$\{newerRun\.publicId\}`/.test(view));

// Seen on the stand: a check the owner started by hand carries no watch, and
// the page offered "Enable Daily Watch" on an app already checked daily.
check("'watched' is the check's own watch or the viewer's app's — never an offer to enable what is on",
  /watch: \{ select: \{ active: true \} \} \},\s*\}\)\s*: null;/.test(view) && /const hasWatch = Boolean\(run\.watch\?\.active \|\| viewerApp\?\.watch\?\.active\);/.test(view));

// The page's own sentences (not the verdict's stored text) name no machinery
// of ours: the quick check's note used to say "the smoke check confirmed…".
const ownSentences = [...view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").matchAll(/"([^"\n]{25,})"/g)].map((m) => m[1]).filter((s) => !/^[a-z0-9:\/\[\]. -]+$/.test(s) || / [a-z]+ [a-z]+ [a-z]+ /.test(s));
const leaking = ownSentences.filter((s) => /\b(smoke|replay|headless|playwright|harness)\b/i.test(s));
check("the verdict page's own sentences name none of our machinery", ownSentences.length > 3 && leaking.length === 0, leaking.join(" | ") || `${ownSentences.length} sentences read`);

// ── 3. The in-app page ──────────────────────────────────────────────────────
const runQueries = inApp.match(/db\.run\.findFirst\(\{\s*where: \{[^\n]*/g) ?? [];
check("every read of a check is the team's, and this app's", runQueries.length === 3 && runQueries.every((q) => /\.\.\.teamOwned\(team\.id\), \.\.\.ofThisApp/.test(q)), `${runQueries.length} queries`);
check("the app is the team's", /db\.app\.findFirst\(\{\s*where: \{ \.\.\.teamOwned\(team\.id\), id: appId \}/.test(inApp));
check("which checks are the app's is the app page's rule (attached, or made before the only app of that address was saved)",
  /OR: \[\{ appId: app\.id \}, \.\.\.\(onlyOneWithSlug \? \[\{ appId: null, appSlug: app\.appSlug \}\] : \[\]\)\]/.test(inApp) &&
    /OR: \[\{ appId: app\.id \}, \.\.\.\(onlyOneWithSlug \? \[\{ appId: null, appSlug: app\.appSlug \}\] : \[\]\)\]/.test(read("src/app/(app)/health/apps/[appId]/page.tsx")));
check("a number that is not a number, or not this app's check, is not found", /if \(runNumber < 1\) notFound\(\)/.test(inApp) && /if \(!run\) notFound\(\)/.test(inApp));
check("the checks on either side are finished ones with a verdict", (inApp.match(/status: \{ in: FINISHED \}, verdict: \{ not: null \}/g) ?? []).length === 2);
check("the page offers the permalink for sharing", /href=\{`\/verdict\/\$\{run\.publicId\}`\}[\s\S]{0,120}Public link for sharing/.test(inApp));
check("prices only: the page names no cost, token or margin field", !/costUsd|cost_usd|tokens|multiplier|margin/i.test(inApp));

// ── 4. The links ────────────────────────────────────────────────────────────
eq("a saved app's check opens inside the app", checkHref({ appId: "app1", runNumber: 290, publicId: "pub" }), "/health/apps/app1/checks/290");
eq("a check of no saved app opens on its permalink", checkHref({ appId: null, runNumber: 295, publicId: "pub" }), "/verdict/pub");
eq("the address", appPath.check("app1", 7), "/health/apps/app1/checks/7");
function sources(dir: string): string[] {
  return readdirSync(path.join(repoRoot, dir), { withFileTypes: true }).flatMap((d) => {
    const p = `${dir}/${d.name}`;
    return d.isDirectory() ? sources(p) : /\.tsx?$/.test(d.name) ? [p] : [];
  });
}
// The only places inside the app that may name the permalink: the share link
// on the check's own page (and checkHref, for a check with no app).
const straight = sources("src/app/(app)").filter((f) => /\/verdict\/\$\{/.test(read(f)) && !f.endsWith("checks/[runNumber]/page.tsx"));
check("no page inside the app links a check straight to the permalink", straight.length === 0, straight.join(", "));
const linkers = ["src/app/(app)/home/page.tsx", "src/app/(app)/health/apps/page.tsx", "src/app/(app)/health/apps/[appId]/page.tsx", "src/app/(app)/settings/billing/page.tsx", "src/app/(app)/health/apps/[appId]/settings/[section]/page.tsx"];
const notLinking = linkers.filter((f) => !/appPath\.check\(|checkHref\(/.test(read(f)));
check("Today, All apps, the app's page, Billing and Schedule open checks inside the app", notLinking.length === 0, notLinking.join(", "));

// The same money under the same words everywhere: All apps' header is the sum
// of its own column — the apps' checks — not the team's total with previews.
const allApps = read("src/app/(app)/health/apps/page.tsx");
check("All apps' header is the apps' own spending, as the sidebar's figure is",
  /usd\(health\.apps\.reduce\(\(sum, a\) => sum \+ a\.spendUsd, 0\)\)\} in the last/.test(allApps) && !/usd\(health\.totalSpendUsd\)/.test(allApps));

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
