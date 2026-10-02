// Health → All apps (CHE-357): what the page decides before it draws.
//
//   1. The view: the address wins, then the viewer's cookie, then cards — and a
//      value that is neither view is ignored wherever it comes from.
//   2. The filter: "Need attention" is the latest verdict, not the history;
//      "On a schedule" is a watch that will start a check by itself.
//   3. The line under the strip says what the strip shows — every sentence here
//      is derived from the same verdicts, so each case below is a strip and the
//      sentence it must produce.
//   4. The page itself: the view toggle writes the cookie in its click handler
//      (no effect), the table scrolls inside its card, and the page shows prices
//      only (CLAUDE.md §10).
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-all-apps.ts

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  allAppsHref, appsFilter, appsView, checkedWhen, inFilter, isScheduled, recurringCount, recurringLine, scheduleLabel, stripStory,
} from "../src/lib/all-apps";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, got === want, `${JSON.stringify(got)}${got === want ? "" : ` ≠ ${JSON.stringify(want)}`}`);

// ── 1. The view ─────────────────────────────────────────────────────────────
eq("view: nothing said → cards", appsView(undefined, undefined), "cards");
eq("view: the cookie remembers list", appsView(undefined, "list"), "list");
eq("view: the address outranks the cookie", appsView("cards", "list"), "cards");
eq("view: an unknown value in the address falls back to the cookie", appsView("grid", "list"), "list");
eq("view: an unknown cookie is ignored", appsView(undefined, "<script>"), "cards");

// ── 2. The filter ───────────────────────────────────────────────────────────
eq("filter: nothing said → all", appsFilter(undefined), "all");
eq("filter: an unknown value → all", appsFilter("everything"), "all");
eq("filter: attention", appsFilter("attention"), "attention");
const daily = { active: true, frequency: "daily", trialEnded: false };
const paused = { active: false, frequency: "daily", trialEnded: false };
const manual = { active: true, frequency: "manual", trialEnded: false };
// Codex P1 on #233: a Free team's watch stays active after its trial, and the
// scheduler (shouldSkipWatch) never starts it again.
const expired = { active: true, frequency: "daily", trialEnded: true };
check("scheduled: a watch past its trial is not on a schedule, and says so", !isScheduled(expired) && scheduleLabel(expired) === "Trial ended" && !inFilter("scheduled", { latestVerdict: null, watch: expired }));
check("attention: broken and needs_attention are in", ["broken", "needs_attention"].every((v) => inFilter("attention", { latestVerdict: v, watch: undefined })));
check("attention: all_good, mostly_ok, unverified and never-checked are out",
  ["all_good", "mostly_ok", "unverified", null].every((v) => !inFilter("attention", { latestVerdict: v, watch: daily })));
check("scheduled: an active daily watch is in; paused, manual and no watch are out",
  isScheduled(daily) && !isScheduled(paused) && !isScheduled(manual) && !isScheduled(undefined));
check("all: everything is in", inFilter("all", { latestVerdict: null, watch: undefined }));
eq("schedule: daily", scheduleLabel(daily), "Daily");
eq("schedule: every 6 hours", scheduleLabel({ active: true, frequency: "every_6h", trialEnded: false }), "Every 6 hours");
eq("schedule: paused", scheduleLabel(paused), "Paused");
eq("schedule: manual is not a schedule", scheduleLabel(manual), "Not scheduled");
eq("schedule: no watch", scheduleLabel(undefined), "Not scheduled");
eq("href: the default filter is left out", allAppsHref("list", "all"), "/health/apps?view=list");
eq("href: view and filter travel together", allAppsHref("cards", "attention"), "/health/apps?view=cards&show=attention");

// ── 3. The strip in one line ────────────────────────────────────────────────
const s = (spec: string) => spec.split(",").filter(Boolean).map((v) => ({ g: "all_good", m: "mostly_ok", n: "needs_attention", b: "broken", u: "unverified" })[v]!);
eq("story: never checked", stripStory([]), "Not checked yet.");
eq("story: one good check", stripStory(s("g")), "All good in its first check.");
eq("story: one broken check", stripStory(s("b")), "Broken in its first check.");
eq("story: all fine", stripStory(s("g,m,m,g,m")), "Steady: nothing broken in the last 5 checks.");
eq("story: a check that verified nothing is not counted as clean (Codex P1 on #233)", stripStory(s("u,g,m")),
  "Nothing broken in the 2 checks that verified something; 1 of the last 3 verified nothing.");
check("story: 'Steady' is never said over a strip holding an unverified check",
  ["u,g", "g,u,g", "u,u,m,g", "g,m,u,m"].every((spec) => !/^Steady/.test(stripStory(s(spec)))));
eq("story: broken before, fine since (the dead link that went away)", stripStory(s("b,m,m,b,b,b,g,g")), "Broken in 4 of the 6 checks before; fine for the last 2.");
eq("story: needed attention before, never broken", stripStory(s("n,g,n,g,g,g")), "Needed attention in 2 of the 3 checks before; fine for the last 3.");
eq("story: one check before", stripStory(s("b,g")), "Broken in the check before; fine in the latest check.");
eq("story: broken and needing attention are counted apart", stripStory(s("b,n,n,g")), "Broken in 1 and needed attention in 2 of the 3 checks before; fine in the latest check.");
check("story: the counts in the sentence never exceed the checks before", (() => {
  const m = stripStory(s("b,b,n,m,g,b,n,g,g")).match(/Broken in (\d+) and needed attention in (\d+) of the (\d+) checks before/);
  return m !== null && Number(m[1]) === 3 && Number(m[2]) === 2 && Number(m[3]) === 7;
})(), stripStory(s("b,b,n,m,g,b,n,g,g")));
eq("story: trouble only in the latest check", stripStory(s("g,g,n")), "Needs attention in the latest check; it was not in the one before.");
eq("story: trouble right after a check that verified nothing claims nothing about that check (Codex P1 r2 on #233)",
  stripStory(s("g,u,b")), "Broken in the latest check; the check before verified nothing.");
check("story: no sentence says a problem was absent from an unverified check",
  ["u,b", "u,n", "g,u,b", "b,u,n"].every((spec) => !/was not in the one before/.test(stripStory(s(spec)))));
eq("story: broken three in a row", stripStory(s("g,b,b,b")), "Broken 3 checks in a row.");
eq("story: a mixed bad streak is not called broken", stripStory(s("g,n,b,n")), "Needs attention or broken 3 checks in a row.");
eq("story: nothing verified, ever", stripStory(s("u")), "Nothing verified yet.");
eq("story: nothing verified lately", stripStory(s("g,u,u")), "Nothing verified in the last 2 checks.");
check("story: every sentence ends with a full stop and names no machinery",
  [[], s("g"), s("b,g"), s("g,b,b"), s("u")].every((v) => /\.$/.test(stripStory(v)) && !/run|agent|smoke|walk/i.test(stripStory(v))));

const now = new Date("2026-10-02T12:00:00Z");
eq("when: minutes", checkedWhen(new Date("2026-10-02T11:48:00Z"), now), "12 min ago");
eq("when: hours", checkedWhen(new Date("2026-10-02T08:10:00Z"), now), "3 h ago");
eq("when: days", checkedWhen(new Date("2026-09-29T12:00:00Z"), now), "3 days ago");
eq("when: a date after a week", checkedWhen(new Date("2026-09-12T23:30:00Z"), now), "12 Sep");

// ── 3b. Recurring ───────────────────────────────────────────────────────────
eq("recurring: only problems seen check after check and still there are counted",
  recurringCount([{ state: "recurring" }, { state: "new" }, { state: "gone" }, { state: "known" }, { state: "not_a_bug" }, { state: "recurring" }]), 2);
eq("recurring: none", recurringLine(0), "nothing keeps coming back");
eq("recurring: one", recurringLine(1), "problem seen check after check");
eq("recurring: several", recurringLine(3), "problems seen check after check");

// ── 4. The page ─────────────────────────────────────────────────────────────
const page = read("src/app/(app)/health/apps/page.tsx");
const toggle = read("src/components/apps-view-toggle.tsx");
check("the toggle writes the cookie in its click handler, with no effect",
  /onClick=\{\(\) => \{\s*document\.cookie = `\$\{APPS_VIEW_COOKIE\}=/.test(toggle) && !/use(Layout)?Effect/.test(toggle));
check("the page reads the same cookie on the server", /jar\.get\(APPS_VIEW_COOKIE\)/.test(page));
check("the table scrolls inside its card", /className="card overflow-x-auto"/.test(page));
check("both views show the strip of checks", (page.match(/<VerdictStrip verdicts=\{app\.verdicts\}/g) ?? []).length === 2);
check("'Need attention' follows the strip's newest verdict, not the latest priced check (Codex P1 r2 on #233)",
  /newestVerdict: a\.verdicts\.at\(-1\)\?\.verdict \?\? null/.test(page) && !/latestVerdict: a\.latest/.test(page));
check("the latest check's price opens its reason — in the cards and in the list (§10: never a bare price)",
  (page.match(/<CheckPrice explanation=\{app\.latest\.price\}/g) ?? []).length === 2 && !/usd\(app\.latest\.priceUsd\)/.test(page));
check("the schedule is the scheduler's rule: the page asks shouldSkipWatch with the team's plan",
  /trialEnded: shouldSkipWatch\(w, team\.plan as UserPlan\)/.test(page) && /trialEndsAt: true/.test(page));
check("prices only: the page names no cost, token or margin field", !/costUsd|cost_usd|tokens|multiplier|margin/i.test(page));
check("the watches it reads are the team's", /db\.watch\.findMany\(\{\s*where: \{ \.\.\.teamOwned\(team\.id\) \}/.test(page));

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
