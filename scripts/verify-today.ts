// Today (CHE-361): the briefing's sentence and the feed's small parts.
//
//   1. The sentence is a template over the latest check of each app in the last
//      24 hours — every shape it can take is a case below, and none of them is
//      written by a model or names our machinery (CLAUDE.md §1).
//   2. Days and times of the feed, in UTC, spelled without the runtime's
//      locale data.
//   3. The page: the sentence counts the team's apps only (a preview or a
//      one-off address is in the feed, not in "your apps"), queries are the
//      team's, prices only (§10), and the per-app controls the old dashboard
//      carried are on the app's settings.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-today.ts

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { briefing, dayLabel, daysAgo, hhmm, latestPerApp, longDate, type BriefingCheck } from "../src/lib/today";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, got === want, `${JSON.stringify(got)}${got === want ? "" : ` ≠ ${JSON.stringify(want)}`}`);

// ── 1. The sentence ─────────────────────────────────────────────────────────
const c = (name: string, verdict: string, said = ""): BriefingCheck => ({ name, verdict, publicId: `pub_${name}`, said });
const said = "The \"your dashboard\" link on Pricing leads to a missing page.";

eq("an empty team gets no sentence", briefing([], 0).lead, "");
eq("apps, none checked", briefing([], 3).lead, "No app was checked in the last 24 hours.");
eq("one app, fine", briefing([c("a.app", "all_good")], 1).lead, "In the last 24 hours 1 app was checked. It is fine.");
eq("two apps, fine", briefing([c("a.app", "all_good"), c("b.app", "mostly_ok")], 2).lead, "In the last 24 hours 2 apps were checked. Both are fine.");
eq("three apps, fine (the owner's night of 2 October)", briefing([c("checkmyapp.dev", "all_good"), c("meetbashar.com", "all_good"), c("joblander.app", "mostly_ok")], 4).lead,
  "In the last 24 hours 3 apps were checked. All 3 are fine.");
check("nothing needs the owner when all are fine", briefing([c("a.app", "all_good")], 1).attention === null);

const one = briefing([c("checkmyapp.dev", "needs_attention", said), c("meetbashar.com", "all_good"), c("joblander.app", "mostly_ok")], 4);
eq("one needs attention: the lead counts the fine ones", one.lead, "In the last 24 hours 3 apps were checked. 2 are fine.");
eq("…and the app is named with what its own check said", `${one.attention?.label} ${one.attention?.text}`, `checkmyapp.dev needs you: ${said}`);
eq("…linked to that check", one.attention?.publicId, "pub_checkmyapp.dev");

const broken = briefing([c("a.app", "needs_attention", "A."), c("b.app", "broken", "Sign-in returns 500.")], 2);
eq("broken outranks needs-attention, whatever the order", broken.attention?.label, "b.app and 1 more are in trouble:");
eq("…and quotes the broken app's check", broken.attention?.text, "Sign-in returns 500.");
eq("only trouble: no 'fine' clause is invented", broken.lead, "In the last 24 hours 2 apps were checked.");
eq("one broken app", briefing([c("b.app", "broken", "Sign-in returns 500.")], 1).attention?.label, "b.app is broken:");
eq("a troubled check that said nothing ends with a full stop, not a colon", briefing([c("b.app", "broken")], 1).attention?.label, "b.app is broken.");
eq("two need attention", briefing([c("a.app", "needs_attention", "A."), c("b.app", "needs_attention", "B.")], 2).attention?.label, "a.app and 1 more need you:");

eq("an unverified check is not 'fine' and is said by name", briefing([c("a.app", "all_good"), c("ext", "unverified")], 2).lead,
  "In the last 24 hours 2 apps were checked. 1 is fine. ext could not be verified.");
eq("several unverified", briefing([c("x", "unverified"), c("y", "unverified")], 2).lead, "In the last 24 hours 2 apps were checked. 2 could not be verified.");
check("no sentence claims 'fine' for an unverified check", !/fine/.test(briefing([c("x", "unverified")], 1).lead), briefing([c("x", "unverified")], 1).lead);
check("no shape of the sentence names our machinery",
  [briefing([], 3), one, broken, briefing([c("x", "unverified")], 1)].every((b) => !/\b(run|agent|smoke|walk|browser|replay)\b/i.test(`${b.lead} ${b.attention?.label ?? ""}`)));

// ── 2. Days and times ───────────────────────────────────────────────────────
const now = new Date("2026-10-02T03:56:00Z");
eq("date line", longDate(now), "Friday, 2 October");
eq("today", dayLabel(new Date("2026-10-02T01:02:00Z"), now), "Today");
eq("yesterday, an hour before midnight", dayLabel(new Date("2026-10-01T23:46:00Z"), now), "Yesterday");
eq("earlier days by date", dayLabel(new Date("2026-09-30T12:00:00Z"), now), "30 September");
eq("days ago across a month edge", daysAgo(new Date("2026-09-30T23:59:00Z"), now), 2);
eq("time", hhmm(new Date("2026-10-02T00:04:09Z")), "00:04");

const at = (iso: string) => new Date(iso);
const checks = [
  { appKey: "cma", completedAt: at("2026-10-02T01:02:00Z"), n: 294 },
  { appKey: "cma", completedAt: at("2026-10-02T00:33:00Z"), n: 290 },
  { appKey: "mb", completedAt: at("2026-10-01T23:46:00Z"), n: 287 },
  { appKey: "jl", completedAt: at("2026-10-01T03:55:00Z"), n: 270 }, // 24 h and 1 min ago
];
eq("the latest check of each app within 24 hours, newest first", latestPerApp(checks, now).map((x) => x.n).join(","), "294,287");

// ── 3. The page ─────────────────────────────────────────────────────────────
const page = read("src/app/(app)/home/page.tsx");
check("the sentence counts the team's apps only — a check with no app is in the feed, not in the sentence",
  /briefing\(latestPerApp\(feed\.filter\(\(r\) => r\.appId !== null\), now\), shell\.apps\.length\)/.test(page));
check("a check with no app is the team's only app of that address, as appHealth decides it",
  /const appId = r\.appId \?\? onlyAppOf\.get\(r\.appSlug\) \?\? null;/.test(page) && /slugCount\.get\(a\.appSlug\) === 1/.test(page));
check("the feed and the sentence go by when a check finished, not by its number (a long check can finish after a later quick one)",
  /\.sort\(\(a, b\) => b\.completedAt\.getTime\(\) - a\.completedAt\.getTime\(\)\);\s*const days = /.test(page));
check("the feed is the team's finished, priced checks", /db\.run\.findMany\(\{\s*where: \{ \.\.\.teamOwned\(team\.id\), status: \{ in: FINISHED \}, verdict: \{ not: null \}, priceUsd: \{ not: null \}/.test(page));
// Codex P2 on #245: a row limit taken before the latest-per-app reduction
// drops a quiet app's check behind a busy app's, and the sentence then says
// that app was not checked.
const feedQuery = page.slice(page.indexOf("db.run.findMany({"), page.indexOf("const nameOf"));
check("the feed's query has no row limit — the window bounds it", !/\btake:/.test(feedQuery) && /createdAt: \{ gte: since \}/.test(feedQuery));
check("'Your apps cost' is the apps' own checks, the sidebar's number; the pace counts everything the balance pays for and the plan's next amount",
  /usd\(health\.appsMonthlyUsd\)/.test(page) && /monthlyUsd: health\.monthlyRunRateUsd/.test(page) && /daysToRenewal: balance\.renewsOn !== null \? daysToNextMonth\(now\) : null/.test(page));
check("a quick check's row is the price explanation's own line", /r\.quickPagesOpened !== null \? `\$\{quickCheckWork\(r\.quickPagesOpened\)\}\.`/.test(page));
check("prices only: the page names no cost, token or margin field", !/costUsd|cost_usd|tokens|multiplier|margin/i.test(page));
check("the agent panel is still the first thing on the page", /<ConnectAgent keys=/.test(page));
check("an empty team is told how to start, not shown empty cards", /Nothing is being checked yet/.test(page) && /\{!empty && \(\s*<aside/.test(page));
check("the per-app controls left this page", !/TeamSelect|AppPostHogProject|setIntegrationEndpoints|webhookUrl/.test(page));
// CHE-359: the settings are sections; these three are in Integrations.
const settings = read("src/app/(app)/health/apps/[appId]/settings/[section]/page.tsx");
check("…and the app's settings carry them: tracker team, analytics project, webhooks",
  /<TeamSelect appId=\{app\.id\}/.test(settings) && /AnalyticsProject/.test(settings) && /setIntegrationEndpoints\.bind\(null, app\.id\)/.test(settings));
check("a paused schedule is said with the way out (balance or trial)", /paused, the balance is used/.test(page) && /trial ended — daily watch paused/.test(page));

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
