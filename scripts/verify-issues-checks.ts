// Health → Issues and Health → Checks (CHE-360).
//
//   1. Issues: how a problem reads (in the latest check / not checked again /
//      answered / gone), which rows each filter shows, the sentences, the order.
//      A problem found earlier in a place no check has walked since is never
//      called open or new — nothing recent says it is there (CLAUDE.md §8).
//   2. Checks: what started a check, how it came out, the addresses, the line.
//      A check that did not finish never shows a verdict (§4).
//   3. The pages: the team's rows only, prices only (§10), one source for the
//      numbers other pages show, a mark written the way the check's page
//      writes it.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-issues-checks.ts

import "./fixtures/wasm-module-loader.mjs";
import { realD1 } from "./fixtures/real-d1";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ISSUES_FILTERS, ISSUE_MARKS, VIEW_LABEL, inIssuesFilter, issuePriorityOf, issueView, issuesFilter, issuesHref, issuesLine, markLabel, portions,
  priorityFilter, seenLine, sortIssues, ticketLabel,
  type IssueView,
} from "../src/lib/issues-page";
import type { Priority } from "../src/lib/issue-priority";
import { CHECKS_PAGE, checksHref, checksLine, outcome, runNumberParam, startedFilter, startedLabel, whenLine } from "../src/lib/checks-page";
import { BY_SCHEDULE, ON_REQUEST, startedBySchedule } from "../src/lib/started-via";
import type { RecurringIssue } from "../src/lib/recurring";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, got === want, `${JSON.stringify(got)}${got === want ? "" : ` ≠ ${JSON.stringify(want)}`}`);

// ── 1. Issues ───────────────────────────────────────────────────────────────
type State = RecurringIssue["state"];
const row = (state: State, seen: number[], gone: number | null = null, severity = "medium") => ({
  issue: { state, severity, timesSeen: seen.length, firstSeenRunNumber: seen[0], lastSeenRunNumber: seen[seen.length - 1] },
  goneSinceRunNumber: gone,
  sightings: seen.map((runNumber) => ({ runNumber, findingId: `f${runNumber}`, title: "t" })),
});
const LATEST = 294;
eq("seen in the app's latest check, first time: new", issueView(row("new", [294]), LATEST), "fresh_new");
eq("seen in the latest check and the one before: keeps coming back", issueView(row("recurring", [290, 294]), LATEST), "fresh_recurring");
eq("found in #280, the latest check is #294 and did not see it: NOT 'new' — not checked again", issueView(row("new", [280]), LATEST), "stale");
eq("the same for one that had kept coming back", issueView(row("recurring", [276, 280]), LATEST), "stale");
eq("an app with no latest check has nothing fresh", issueView(row("new", [280]), null), "stale");
eq("answered stays answered wherever it was seen", issueView(row("known", [294]), LATEST), "known");
eq("not a bug", issueView(row("not_a_bug", [294]), LATEST), "not_a_bug");
eq("gone", issueView(row("gone", [280], 288), LATEST), "gone");

const rows = [row("new", [294]), row("recurring", [290, 294]), row("new", [280]), row("recurring", [276, 280]), row("known", [294]), row("not_a_bug", [270]), row("gone", [260], 264)]
  .map((r) => ({ ...r, view: issueView(r, LATEST) }));
const shown = (f: Parameters<typeof inIssuesFilter>[0]) => rows.filter((r) => inIssuesFilter(f, r.view, r.issue.state)).length;
eq("filter: in the latest checks — the sidebar's number", shown("latest"), 2);
eq("filter: not checked again", shown("stale"), 2);
eq("filter: keep coming back — recurrence's own state, whichever check saw it last (All apps' Recurring column)", shown("recurring"), 2);
eq("filter: answered", shown("answered"), 2);
eq("filter: gone", shown("gone"), 1);
eq("filter: all", shown("all"), 7);
check("every row is in exactly one of latest / stale / answered / gone", shown("latest") + shown("stale") + shown("answered") + shown("gone") === rows.length);
eq("the default filter is the latest checks", issuesFilter(undefined), "latest");
eq("an unknown filter is the default", issuesFilter("open; drop"), "latest");
check("every filter has a label and no label names our machinery", ISSUES_FILTERS.length === 6 && [...ISSUES_FILTERS.map((f) => f.label), ...Object.values(VIEW_LABEL)].every((l) => !/\b(run|agent|walk|signature|streak)\b/i.test(l)));

eq("line: both kinds", issuesLine(2, 8), "2 problems in the latest checks of your apps. 8 more were found earlier, in a place no check has walked since.");
eq("line: one of each", issuesLine(1, 1), "1 problem in the latest checks of your apps. 1 more was found earlier, in a place no check has walked since.");
eq("line: nothing fresh, something stale — not 'all clear'", issuesLine(0, 3), "No open problems in the latest checks of your apps. 3 more were found earlier, in a place no check has walked since.");
eq("line: nothing", issuesLine(0, 0), "No open problems in the latest checks of your apps.");
check("no line calls an unchecked problem open or still there", !/still|open problems? (were|was)/.test(issuesLine(0, 3)) && !/\b8 open\b/.test(issuesLine(2, 8)));

eq("seen once", seenLine(row("new", [290])), "Seen in check #290");
eq("seen in a row", seenLine(row("recurring", [278, 284])), "Seen in 2 checks in a row, #278 to #284");
eq("gone, with the check that looked again", seenLine(row("gone", [267], 275)), "Seen in check #267. Gone by check #275");

const P = (priority: Priority, view: IssueView, severity: string, lastSeenRunNumber: number) => ({ priority, view, issue: { severity, lastSeenRunNumber } });
const order = sortIssues([
  P("P2", "gone", "high", 300),
  P("P2", "stale", "high", 280),
  P("P2", "fresh_new", "low", 294),
  P("P2", "fresh_new", "high", 290),
  P("P2", "fresh_recurring", "low", 284),
]).map((r) => `${r.view}/${r.issue.severity}`).join(" ");
eq("order at one priority: what keeps coming back, then new by severity, then not checked again, gone last", order, "fresh_recurring/low fresh_new/high fresh_new/low stale/high gone/high");
const byPriority = sortIssues([P("P3", "fresh_recurring", "high", 300), P("P1", "known", "low", 200), P("P0", "stale", "low", 100), P("P2", "fresh_new", "high", 290)])
  .map((r) => r.priority).join(" ");
eq("order: the most urgent first among what is still there — a P0 not checked again stands above a P3 that keeps coming back", byPriority, "P0 P1 P2 P3");
const settledLast = sortIssues([P("P0", "gone", "high", 300), P("P0", "not_a_bug", "high", 299), P("P3", "fresh_new", "low", 100), P("P1", "gone", "low", 200), P("P2", "stale", "low", 150)])
  .map((r) => `${r.priority}/${r.view}`).join(" ");
eq("order: what is gone or ruled not a bug sits below everything still there, however urgent it was", settledLast, "P2/stale P3/fresh_new P0/not_a_bug P0/gone P1/gone");

// The priority of a row, from what recurrence recorded of the latest sighting (src/lib/issue-priority.ts has the rule itself).
const pri = (o: Partial<Parameters<typeof issuePriorityOf>[0]>) => issuePriorityOf({ category: "broken", severity: "high", where: "/", timesSeen: 1, audience: "unknown", ...o });
eq("a row: broken for existing users at the checkout → P0", pri({ where: "/checkout → Pay", audience: "existing_users" }), "P0");
eq("a row: the same place, who hit it unknown → P1 (unknown is never promoted)", pri({ where: "/checkout → Pay" }), "P1");
eq("a row: broken three checks in a row, anywhere → P0", pri({ where: "/about", timesSeen: 3 }), "P0");
eq("a row: polish seen ten times → P3", pri({ category: "polish", severity: "low", timesSeen: 10 }), "P3");
eq("a row: confusing for new visitors → P2", pri({ category: "confusing", severity: "medium", audience: "new_visitors" }), "P2");
eq("a row: confusing once, for whom unknown → P3", pri({ category: "confusing", severity: "medium" }), "P3");
eq("a row: confusing that keeps coming back → P2", pri({ category: "confusing", severity: "medium", timesSeen: 2 }), "P2");
eq("priority filter: a level", priorityFilter("P1"), "P1");
eq("priority filter: anything else is none", priorityFilter("p1; drop"), null);
eq("priority filter: absent is none", priorityFilter(undefined), null);

eq("address: the default", issuesHref("latest"), "/health/issues");
eq("address: a filter and an app", issuesHref("gone", "app1"), "/health/issues?show=gone&app=app1");
eq("address: a priority", issuesHref("latest", null, "P0"), "/health/issues?p=P0");
eq("address: all three", issuesHref("all", "app1", "P2"), "/health/issues?show=all&app=app1&p=P2");
check("the four answers, under the words the row shows", ISSUE_MARKS.map((m) => m.mark).join(",") === "known,watch,fixed,false_positive" && markLabel("known") === "That's fine" && markLabel("none") === null && markLabel("x") === null);
eq("ticket: a tracker key", ticketLabel({ externalIssueId: "JOB-1037", status: "open" }), "JOB-1037 · open");
eq("ticket: done in the tracker, not yet confirmed by a check", ticketLabel({ externalIssueId: "CHE-79", status: "fixed" }), "CHE-79 · marked done");
eq("ticket: an opaque id is not shown as a key", ticketLabel({ externalIssueId: "3f2a9c1e-77aa-4c0e-9f43-1b2d3e4f5a6b", status: "suppressed" }), "Ticket · closed as not a bug");
check("ids go to D1 in portions under its cap of a hundred", portions(Array.from({ length: 211 }, (_, i) => i)).map((p) => p.length).join(",") === "80,80,51" && portions([]).length === 0);

// ── 2. Checks ───────────────────────────────────────────────────────────────
// Codex P1 on #249: the watch a run carries is not what started it.
eq("started: the scheduler's own check", startedLabel({ watchId: "w", startedVia: "watch" }), "Scheduled");
eq("started: a re-check by hand copies its predecessor's watch and is still on request", startedLabel({ watchId: "w", startedVia: "ui" }), "From the app");
eq("started: a scheduled check stays scheduled after its watch was removed", startedLabel({ watchId: null, startedVia: "watch" }), "Scheduled");
eq("started: a row from before the door was recorded is judged by its watch", startedLabel({ watchId: "w", startedVia: null }), "Scheduled");
check("one rule: scheduled", startedBySchedule({ watchId: null, startedVia: "watch" }) && startedBySchedule({ watchId: "w", startedVia: null }) && startedBySchedule({ watchId: "w" }));
check("one rule: on request", !startedBySchedule({ watchId: "w", startedVia: "mcp" }) && !startedBySchedule({ watchId: null, startedVia: null }) && !startedBySchedule({ watchId: null }));
eq("started: the owner's agent", startedLabel({ watchId: null, startedVia: "mcp" }), "Your agent");
eq("started: the GitHub Action", startedLabel({ watchId: null, startedVia: "action" }), "GitHub Action");
eq("started: the app's own button", startedLabel({ watchId: null, startedVia: "ui" }), "From the app");
eq("started: the API", startedLabel({ watchId: null, startedVia: "api" }), "API");
eq("started: the public form", startedLabel({ watchId: null, startedVia: "anon" }), "Public form");
eq("started: a row from before the door was recorded says only that somebody asked", startedLabel({ watchId: null, startedVia: null }), "On request");
eq("started: a door this page does not know is not printed raw", startedLabel({ watchId: null, startedVia: "x_internal_probe" }), "On request");

const LIVE = ["queued", "walking", "writing"];
eq("outcome: a verdict", JSON.stringify(outcome({ status: "completed", verdict: "all_good" }, LIVE)), '{"kind":"verdict","verdict":"all_good"}');
eq("outcome: partial with a verdict", outcome({ status: "partial", verdict: "mostly_ok" }, LIVE).kind, "verdict");
eq("outcome: running", outcome({ status: "walking", verdict: null }, LIVE).kind, "running");
eq("outcome: a check that did not finish shows no verdict, even if a row holds one", outcome({ status: "failed", verdict: "broken" }, LIVE).kind, "unfinished");
eq("outcome: finished without a verdict", outcome({ status: "completed", verdict: null }, LIVE).kind, "unfinished");

eq("when", whenLine(new Date("2026-10-02T01:02:08Z")), "2 Oct, 01:02");
eq("when: a hand-written prod date read as UTC elsewhere prints the same way", whenLine(new Date("2026-09-14T23:30:00Z")), "14 Sep, 23:30");
eq("address: nothing chosen", checksHref({}), "/health/checks");
eq("address: an app, scheduled, an earlier page", checksHref({ app: "app1", started: "scheduled", before: 236 }), "/health/checks?app=app1&started=scheduled&before=236");
eq("filter: default", startedFilter(undefined), "all");
eq("filter: unknown is the default", startedFilter("mine"), "all");
eq("number from the address", runNumberParam("290"), 290);
check("…never a negative, a fraction or text", [undefined, "", "0", "-3", "2.5", "290abc", "1e9", "99999999999"].every((v) => runNumberParam(v) === null));
eq("line: an app, with who started its checks", checksLine({ windowDays: 30, checks: 46, usd: "$27.54", scheduled: 30, onRequest: 16 }), "46 checks in the last 30 days, $27.54. 30 scheduled, 16 on request.");
eq("line: the team", checksLine({ windowDays: 30, checks: 142, usd: "$65.32" }), "142 checks in the last 30 days, $65.32.");
eq("line: none", checksLine({ windowDays: 30, checks: 0, usd: "$0.00" }), "No checks in the last 30 days.");
check("a page is fifty checks", CHECKS_PAGE === 50);

// ── 3. The pages ────────────────────────────────────────────────────────────
const issues = read("src/app/(app)/health/issues/page.tsx");
const checks = read("src/app/(app)/health/checks/page.tsx");
const marks = read("src/components/issue-marks.tsx");
const actions = read("src/components/issue-actions.tsx");
check("Issues reads recurrence — the source of All apps' Recurring column and each app's 'Keeps coming back'", /teamRecurrences\(db, team\.id\)/.test(issues));
// CHE-413: the priority, first in the row, sorted and filtered, with its legend.
check("every row gets its priority from the one rule, and the row and the card lead with it — before the title",
  /priority: issuePriorityOf\(r\.issue\)/.test(issues) && (issues.match(/<PriorityBadge priority=\{p\.priority\} \/>\s*<div className="min-w-0">\s*<Link href=\{p\.href\}/g) ?? []).length === 2);
check("the priority filter reads ?p and the chips carry it along with the kind and the app",
  /priorityFilter\(p\)/.test(issues) && /issuesHref\(f\.key, appId, priority\)/.test(issues) && /issuesHref\(filter, a\.id, priority\)/.test(issues) && /issuesHref\(filter, appId, pr\)/.test(issues));
check("the legend says what each level means, one line each, from the same table the badge reads",
  /aria-label="What the priorities mean"/.test(issues) && /PRIORITIES\.map\(\(pr\) =>/.test(issues) && /PRIORITY_META\[pr\]\.meaning/.test(issues));
check("the owner's answers sit under one Actions button on the row and on the card, the answer given as text",
  /aria-haspopup="menu"/.test(actions) && /role="menuitemradio"/.test(actions) && /markLabel\(mark\)/.test(actions) &&
    (issues.match(/<IssueActions findingId=\{p\.marks\.findingId\} mark=\{p\.marks\.mark\} \/>/g) ?? []).length === 2 && !/IssueMarks/.test(issues));
check("the menu closes on a click anywhere else (a backdrop), on Escape and on a wheel turn — no effect, no document listener",
  /aria-label="Close menu"/.test(actions) && /onWheel=\{close\}/.test(actions) && /e\.key === "Escape" && close\(\)/.test(actions) && !/addEventListener/.test(actions) && !/useEffect/.test(actions));
check("the menu writes the mark through the same hook as the problem's own page — one PATCH, one refresh", /useIssueMark\(findingId, initial\)/.test(actions) && /export function useIssueMark/.test(marks) && !/fetch\(/.test(actions));
check("a reader who may not answer still sees the answer given", /<AnswerText mark=\{p\.mark\} \/>/.test(issues) && /markLabel\(mark\)/.test(issues));
check("…and takes the app's latest check from the sidebar's own data, so 'in the latest checks' is one check on both",
  /latestOf = new Map\(shell\.apps\.map\(\(a\) => \[a\.id, a\.latestRunNumber\]\)\)/.test(issues));
check("the findings and tickets read by id are read among the team's rows only",
  /where: \{ id: \{ in: ids \}, run: \{ teamId: team\.id \} \}/.test(issues) && /where: \{ id: \{ in: ids \}, app: \{ teamId: team\.id \} \}/.test(issues));
check("an app from the address that is not the team's is no filter", /appParam && nameOf\.has\(appParam\) \? appParam : null/.test(issues) && /const app = shell\.apps\.find\(\(a\) => a\.id === sp\.app\) \?\? null;/.test(checks));
check("a problem opens its own page (CHE-412), or — with no sighting to key it by — the check that last saw it, inside the app",
  /href: findingId \? issueHref\(findingId\) : appPath\.check\(i\.appId, i\.lastSeenRunNumber\)/.test(issues));
check("a mark is offered to whom the route would let set it", /finding\.run\.ownerId === null \|\| finding\.run\.ownerId === user\.id/.test(issues));
// R5 (Codex on #263): the write is a server action in a transition, not a
// fetch to our own route — the control is live from the first HTML.
const markAction = read("src/app/(app)/health/issues/actions.ts");
check("a mark is written by the markFinding server action, in a transition, with no fetch of our own route",
  /startTransition\(async \(\) => \{\s*const result = await markFinding\(findingId, next\)/.test(marks) && !/fetch\(/.test(marks) &&
    /^"use server";/.test(markAction) && /export async function markFinding\(findingId: string, mark: string\)/.test(markAction));
check("…the action refuses our own checker first, then asks the scope table, then writes the team's finding only",
  /await refuseSelfCheck\("\/health\/issues"\);\s*const \{ user, db, team \} = await requireActionScope\("finding\.mark"\)/.test(markAction) &&
    /run: \{ OR: \[\{ teamId: team\.id \}, \{ ownerId: user\.id \}\] \}/.test(markAction) && /markFindingSchema\.safeParse/.test(markAction) &&
    /"src\/app\/\(app\)\/health\/issues\/actions\.ts#markFinding": \{ kind: "team", action: "finding\.mark" \}/.test(read("src/lib/route-scopes.ts")));
check("…the four marks the check's page has, no fifth — one list, read by the links and by the menu", ISSUE_MARKS.length === 4 && /ISSUE_MARKS\.map\(/.test(marks) && /ISSUE_MARKS\.map\(/.test(actions) && !/\{ mark: "/.test(marks) && !/\{ mark: "/.test(actions));
check("the mark buttons hold no effect: they act on the click", !/useEffect/.test(marks));

check("Checks reads the team's rows, newest first by number, a page and one more",
  /where: \{ \.\.\.teamOwned\(team\.id\), AND: \[ofApp, byStart\],/.test(checks) && /orderBy: \{ runNumber: "desc" \}/.test(checks) && /take: CHECKS_PAGE \+ 1/.test(checks));
check("its scheduled / on request filter is the label's rule, and appHealth's split is the same one",
  /started === "scheduled" \? BY_SCHEDULE : started === "request" \? ON_REQUEST : \{\}/.test(checks) &&
    /const side = startedBySchedule\(r\) \? t\.scheduled : t\.onRequest;/.test(read("src/lib/app-health.ts")) && !/r\.watchId \? t\.scheduled/.test(read("src/lib/app-health.ts")));
check("its header's numbers are appHealth's — the ones All apps and Billing show: one app's entry, or the team's totals alone",
  /app \? null : teamSpend\(db, team\.id\)/.test(checks) && /app \? appHealth\(db, team\.id, \{ only: app\.id \}\) : null/.test(checks) && !/appHealth\(db, team\.id\)[,)]/.test(checks));
check("the sidebar's count leaves out a finding the latest check only restated on a carried journey",
  /cj\.carriedFromRunId IS NOT NULL\s+AND cj\."order" = json_extract\(f\.anchor, '\$\.stepRef\.journeyIndex'\)/.test(read("src/lib/shell-data.ts")));
// CHE-411: a row's price is the modal's button with the check's public id; the
// reason is loaded when it is pressed (GET /api/runs/{id}/price), not for
// fifty rows on every page view.
check("no price's reason is loaded with the page — the modal loads the one asked for", !/explainPrice\(/.test(checks) && /<CheckPrice\s+publicId=\{run\.publicId\}/.test(checks));
check("a finished check opens inside the app, one that is running or did not finish on its own page",
  /result\.kind === "verdict" \? checkHref\(\{ appId: ownApp, runNumber: run\.runNumber, publicId: run\.publicId \}\) : `\/run\/\$\{run\.publicId\}`/.test(checks));
check("a check that did not finish says it was not charged", /result\.kind === "unfinished" \? "not charged" : "—"/.test(checks));
for (const [name, src] of [["Issues", issues], ["Checks", checks]] as const) {
  check(`${name}: prices only — no cost, token or margin field`, !/costUsd|cost_usd|tokens|multiplier|margin/i.test(src));
  // CHE-412: no table scrolls; the rows fold to cards (scripts/verify-table-fold.ts).
  check(`${name}: the table never scrolls inside its card`, !/overflow-x-auto/.test(src) && /FOLD\.tableClassName/.test(src));
}
const shellSrc = read("src/lib/shell-data.ts");
check("the sidebar's count leaves out the one finding that is about us", /f\.detail NOT LIKE \$\{OUR_LEFTOVERS\}/.test(shellSrc) && /OUR_LEFTOVERS = `%"where":"\$\{OUR_LEFTOVERS_WHERE\}"%`/.test(shellSrc));

// ── 4. The filter, in a real D1 ─────────────────────────────────────────────
// The rule in code and the rule as a database filter must put every row on the
// same side — and SQL's NULL <> 'watch' is where the two part ways.
async function filterChecks() {
  const real = await realD1();
  try {
    await real.db.team.create({ data: { id: "t", name: "T", plan: "business" } });
    const rowsIn: Array<{ startedVia: string | null; watchId: string | null }> = [
      { startedVia: "watch", watchId: "w" }, // the scheduler's
      { startedVia: "watch", watchId: null }, // …after its watch was removed
      { startedVia: "ui", watchId: "w" }, // a re-check by hand of a scheduled check
      { startedVia: "mcp", watchId: null },
      { startedVia: "action", watchId: null },
      { startedVia: null, watchId: "w" }, // before the door was recorded: a watch's
      { startedVia: null, watchId: null }, // …and somebody's
    ];
    await real.db.watch.create({ data: { id: "w", teamId: "t", appSlug: "a.test", targetUrl: "https://a.test" } });
    for (const [i, r] of rowsIn.entries()) {
      await real.db.run.create({
        data: {
          id: `r${i}`, publicId: `p${i}`, runNumber: i + 1, teamId: "t", appSlug: "a.test", targetUrl: "https://a.test", targetKind: "website",
          status: "completed", startedVia: r.startedVia, watchId: r.watchId,
        } as never,
      });
    }
    const numbers = async (where: object) => (await real.db.run.findMany({ where: { teamId: "t", ...where }, orderBy: { runNumber: "asc" }, select: { runNumber: true } })).map((r) => r.runNumber).join(",");
    const byRule = (want: boolean) => rowsIn.map((r, i) => (startedBySchedule(r) === want ? i + 1 : 0)).filter(Boolean).join(",");
    eq("real D1: 'Scheduled' holds exactly the rows the rule calls scheduled", await numbers(BY_SCHEDULE), byRule(true));
    eq("real D1: 'On request' holds exactly the rest — the rows with no door recorded included", await numbers(ON_REQUEST), byRule(false));
    eq("real D1: the two filters share no row and leave none out", `${byRule(true)}|${byRule(false)}`, "1,2,6|3,4,5,7");
  } finally {
    await real.dispose();
  }
}

filterChecks().then(() => {
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
});
