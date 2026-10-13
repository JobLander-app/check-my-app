// An app's settings as sections (CHE-359).
//
//   1. The sections: which exist, which an extension has, what the tracker's
//      token line says.
//   2. Saving one section writes that section alone. Two halves: the action
//      reads only its section's fields (source), and the shared rule keeps
//      every field a patch does not name (a real D1: an app with everything
//      set, one section's patch at a time).
//   3. The checklist: every field the one long form had is in a section's form,
//      no form is nested in another, none reaches into another by `form=`.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-app-settings-sections.ts

import "./fixtures/wasm-module-loader.mjs";
import { realD1 } from "./fixtures/real-d1";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  JIRA_NO_PROJECT,
  SETTINGS_SECTIONS,
  TEAM_TRACKER_LINE,
  jiraAccountLine,
  jiraBlockedLine,
  sectionsFor,
  settingsSection,
  trackerHealth,
  trackerIdleLine,
  trackerSummary,
  trackerTeamIdleLine,
  trackerUnanswered,
  type TrackerHealth,
} from "../src/lib/app-settings-sections";
import { updateAppForTeam } from "../src/lib/app-settings";
import { appPath } from "../src/lib/app-shell";
import { MACHINERY_TERMS, hasEnvironmentLeak, hasHomework } from "../src/lib/verdict-language";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, got === want, `${JSON.stringify(got)}${got === want ? "" : ` ≠ ${JSON.stringify(want)}`}`);

// ── 1. The sections ─────────────────────────────────────────────────────────
eq("six sections, in the order of the sub-navigation", SETTINGS_SECTIONS.map((s) => s.key).join(","), "scope,accounts,schedule,notifications,integrations,remove");
eq("an extension has no schedule", sectionsFor({ targetKind: "extension" }).map((s) => s.key).join(","), "scope,accounts,notifications,integrations,remove");
eq("a website has all six", sectionsFor({ targetKind: "website" }).length, 6);
// CHE-468 (owner, 2026-10-13): "for shopify apps test accounts are test stores".
eq("a Shopify app's accounts section is its test stores", sectionsFor({ targetKind: "session" }).find((s) => s.key === "accounts")?.label, "Test stores");
eq("…at the same address, in the same place", sectionsFor({ targetKind: "session" }).map((s) => s.key).join(","), SETTINGS_SECTIONS.map((s) => s.key).join(","));
eq("…while a website's stays Test accounts", sectionsFor({ targetKind: "website" }).find((s) => s.key === "accounts")?.label, "Test accounts");
{
  const sectionPage = read("src/app/(app)/health/apps/[appId]/settings/[section]/page.tsx");
  check("the section's heading is the app's own name for it (sectionsFor), not the generic list's",
    /const meta = sectionsFor\(app\)\.find\(\(s\) => s\.key === section\)!;/.test(sectionPage));
  check("a Shopify app's accounts section lists its stores and shows no login form",
    /section === "accounts" && app\.targetKind === "session" && \(\s*<ShopifyStores/.test(sectionPage) &&
      /section === "accounts" && app\.targetKind !== "session" &&/.test(sectionPage) &&
      !/<ShopifyStores[\s\S]*?name="testEmail"[\s\S]*?\n}\n/.test(sectionPage.slice(sectionPage.indexOf("async function ShopifyStores"), sectionPage.indexOf("async function Accounts"))));
  check("…and saving its form leaves the test login it does not carry as it was",
    /testEmail: formData\.has\("testEmail"\) \? text\("testEmail"\) : undefined,/.test(read("src/app/dashboard/actions.ts")));
  // Codex on #342 (R18): the section's sentences come from STORES_COPY, which
  // verify-live-view runs through the language guards; the component writes none.
  const stores = sectionPage.slice(sectionPage.indexOf("async function ShopifyStores"), sectionPage.indexOf("async function Accounts"));
  const literal = [...stores.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)].map((m) => m[1].trim());
  check("…its words are all STORES_COPY's — the component writes no sentence of its own", literal.length === 0 && (stores.match(/STORES_COPY\./g) ?? []).length >= 15, literal.join(" | "));
  // Codex on #342: a Shopify app has no test login to create records as, so it
  // is not offered the choice the run would overrule (workflow hasTestAccount).
  check("a Shopify app is not offered record creation: What we check shows its read-only line instead",
    /app\.targetKind === "session" \? \(\s*<div className="card space-y-1 p-5">\s*<p className="text-sm font-medium text-fg">\{STORES_COPY\.readOnlyTitle\}<\/p>\s*<p className="text-xs text-fg-faint">\{STORES_COPY\.readOnly\}<\/p>/.test(sectionPage));
  const shopifySection = sectionsFor({ targetKind: "session" }).find((s) => s.key === "accounts");
  const sectionWords = [shopifySection?.label ?? "", shopifySection?.what ?? ""];
  check("the Test stores section's own label and line pass the language guards", sectionWords.every((s) => s && !MACHINERY_TERMS.test(s) && !hasEnvironmentLeak(s) && !hasHomework(s)), sectionWords.join(" | "));
  // Codex on #342: the promise above is kept by the run, not only by the page.
  check("…and a check of a Shopify app never writes, whatever the app's row says (the workflow's own gate)",
    /const writeAllowed = writeMode === "create_cleanup" && hasTestAccount && !isSession;/.test(read("src/agent/workflow.ts")));
}
eq("an address that is not a section is none", settingsSection("billing"), null);
eq("…nor one that only starts like one", settingsSection("scope/../remove"), null);
eq("the address of a section", appPath.section("app1", "integrations"), "/health/apps/app1/settings/integrations");

const now = new Date("2026-10-02T07:00:00Z");
eq("tracker: not connected", trackerHealth(null, now), null);
eq("tracker: a token that renews", trackerHealth({ refreshTokenEnc: "x", tokenExpiresAt: new Date("2026-10-02T08:00:00Z") }, now)?.text, "connected · token renews by itself");
eq("tracker: expired, no way to renew", JSON.stringify(trackerHealth({ refreshTokenEnc: null, tokenExpiresAt: new Date("2026-10-01T08:00:00Z") }, now)),
  '{"tone":"bad","text":"token expired — reconnect to restore ticket filing"}');
eq("tracker: will expire, with the day", trackerHealth({ refreshTokenEnc: null, tokenExpiresAt: new Date("2026-10-03T08:00:00Z") }, now)?.text,
  "token expires on 2026-10-03 — reconnect so it renews by itself");
eq("tracker: no expiry on record", trackerHealth({ refreshTokenEnc: null, tokenExpiresAt: null }, now)?.tone, "warn");

// ── 2. One section, one write ───────────────────────────────────────────────
const actions = read("src/app/dashboard/actions.ts");
const action = actions.slice(actions.indexOf("export async function updateAppSettings"), actions.indexOf("\nexport ", actions.indexOf("export async function updateAppSettings") + 1));
// "Who hears about it" has no field of the app: its one form is
// setAppNotifiers (CHE-413 removed the escalation address).
const SECTION_FIELDS: Record<string, string[]> = {
  scope: ["focusAreas", "writeMode", "scopeHints", "userNotes", "extension"],
  accounts: ["testEmail", "testPassword", "testAccounts"],
  integrations: ["pickupLabels", "repoLabel", "urgentJourneys"],
};
for (const [section, fields] of Object.entries(SECTION_FIELDS)) {
  // The branch of the patch for this section: from its test to the next
  // section's test, or to the end of the expression.
  const at = action.indexOf(`section === "${section}"`);
  const next = action.indexOf("section ===", at + 1);
  const own = action.slice(at, next === -1 ? action.indexOf("if (!patch)") : next);
  const read_ = Object.values(SECTION_FIELDS).flat().filter((f) => new RegExp(`\\b${f}:`).test(own));
  eq(`the action, for "${section}", reads its own fields and no other section's`, read_.sort().join(","), [...fields].sort().join(","));
}
check("the section comes bound from the page, never from the form", /export async function updateAppSettings\(appId: string, section: string, formData: FormData\)/.test(action) && !/formData\.get\("section"\)/.test(action));
check("an unknown section writes nothing", /if \(!patch\) throw new Error\("unknown settings section"\)/.test(action));
check("the action reads no escalation address: 'Who hears about it' is the team's list alone", !/notif/i.test(action));
check("a refusal goes back to the section as a sentence; a save says so",
  /if \("error" in result\) redirect\(`\$\{back\}\?error=\$\{encodeURIComponent\(result\.error\)\}`\)/.test(action) && /redirect\(`\$\{back\}\?saved=1`\)/.test(action) && !/throw new Error\(result\.error\)/.test(action));
check("the schedule is not a field of any form: its controls apply at once", !/frequency/.test(action));

async function keeps() {
  const real = await realD1();
  try {
    await real.db.user.create({ data: { id: "u", clerkUserId: "ck_u", email: "s@example.test" } });
    await real.db.team.create({ data: { id: "t", name: "T", plan: "business" } });
    await real.db.app.create({
      data: {
        id: "a", teamId: "t", ownerId: "u", appSlug: "a.test", targetUrl: "https://a.test", targetKind: "website",
        focusAreas: "Checkout must never break.", writeMode: "create_cleanup", scopeHints: "Not /admin", userNotes: "note",
        testEmail: "t@a.test", testPasswordEnc: "enc",
        watch: { create: { appSlug: "a.test", targetUrl: "https://a.test", teamId: "t", ownerId: "u", frequency: "every_6h", testEmail: "t@a.test", testPasswordEnc: "enc" } },
        policy: { create: { pickupLabels: JSON.stringify(["monitor"]), repoLabel: "repo: a", priorityRule: JSON.stringify({ urgent: ["login"] }) } },
      } as never,
    });
    const actor = { userId: "u", teamId: "t", plan: "business" as const };
    const state = async () => {
      const a = await real.db.app.findUniqueOrThrow({ where: { id: "a" }, include: { watch: true, policy: true } });
      return [a.focusAreas, a.writeMode, a.scopeHints, a.userNotes, a.testEmail, a.testPasswordEnc, a.watch?.frequency, a.policy?.pickupLabels, a.policy?.repoLabel, a.policy?.priorityRule].join(" | ");
    };
    const before = await state();

    // "What we check", saved with one field changed and the rest as they were.
    await updateAppForTeam(real.db, actor, "a", { focusAreas: "Sign-in must work.", writeMode: "create_cleanup", scopeHints: "Not /admin", userNotes: "note" });
    eq("real D1: saving What we check changes its field and leaves accounts, schedule and the contract as they were",
      await state(), before.replace("Checkout must never break.", "Sign-in must work."));
    // "Test accounts", with the password box left blank.
    await updateAppForTeam(real.db, actor, "a", { testEmail: "new@a.test", testPassword: undefined, testAccounts: { set: [], remove: [] } });
    const afterAccounts = await state();
    check("real D1: saving Test accounts with a blank password keeps the password, the worries and write mode",
      afterAccounts.includes("new@a.test | enc") && afterAccounts.includes("Sign-in must work. | create_cleanup") && afterAccounts.includes("| every_6h |"), afterAccounts);
    // "Integrations": the ticket contract.
    await updateAppForTeam(real.db, actor, "a", { pickupLabels: ["monitor", "p1"], repoLabel: "repo: a", urgentJourneys: [] });
    const afterContract = await state();
    check("real D1: saving the ticket contract changes the contract and nothing else",
      afterContract.includes('["monitor","p1"] | repo: a | {"urgent":[]}') && afterContract.includes("Sign-in must work. | create_cleanup | Not /admin | note | new@a.test | enc | every_6h"), afterContract);
  } finally {
    await real.dispose();
  }
}

// ── 3. The checklist ────────────────────────────────────────────────────────
const page = read("src/app/(app)/health/apps/[appId]/settings/[section]/page.tsx");
const root = read("src/app/(app)/health/apps/[appId]/settings/page.tsx");
const layout = read("src/app/(app)/health/apps/[appId]/settings/layout.tsx");
// Every field name the one long form carried (settings page before CHE-359),
// plus the two it reached by other actions — less the escalation address,
// which CHE-413 removed outright.
const OLD_FIELDS = [
  "focusAreas", "testEmail", "testPassword", "writeMode", "scopeHints", "userNotes",
  "pickupLabels", "repoLabel", "urgentJourneys", "newAccount:label", "newAccount:email", "newAccount:password",
  "webhookUrl", "webhookSecret", "slackWebhookUrl", "notifier",
];
const missing = OLD_FIELDS.filter((f) => !page.includes(`name="${f}"`));
check("every field of the old form is in a section", missing.length === 0, missing.join(", "));
check("…and the escalation address is gone from it", !page.includes("notifyEmail") && !/scalation/.test(page));
check("…the named accounts' rows too", ["label", "email", "password", "remove"].every((f) => page.includes("name={`account:${account.id}:" + f + "`}")));
check("…the frequency, pause and cancel are the schedule's own controls", /<WatchSettings\s+slug=\{watch\.appSlug\}/.test(page) && /frequency: watch\.frequency/.test(page));
check("…and the pieces with their own actions: tracker team, analytics project, extension options, removal",
  /<TeamSelect appId=\{app\.id\}/.test(page) && /<AnalyticsProject/.test(page) && /<ExtensionSettings/.test(page) && /<DeleteAppSection/.test(page) &&
    /`\/api\/integrations\/\$\{kind\}\/start\?appId=\$\{appId\}`/.test(page) && /connectHref\("linear", app\.id, /.test(page) && /connectHref\("jira", app\.id, /.test(page));
// CHE-469: a tracker the team connected is the team's. Its row offers the
// choice of team or project from the team's grant, and Connect only when the
// team has none of that kind, or its token needs a new consent.
check("a team's tracker offers no second Connect: only where none is connected, or the token is bad",
  /return !team \|\| \(health && health\.tone !== "ok"\) \? `\/api\/integrations/.test(page) && /\{href && \(/.test(page));
check("…the pickers read the team's grant, not the app's row",
  /freshLinearToken\(db, connectionGrant\(teamTrackers\.linear\)/.test(page) && /jiraChoices\(db, connectionGrant\(teamTrackers\.jira\)/.test(page) &&
    /const teamTrackers = await teamConnections\(db, teamId\)/.test(page));
// Codex P2 on #347: a grant revoked on the provider's side still looks ok
// here. A tracker that gave nothing for it turns the row to Reconnect.
check("a team tracker that gave no teams or projects is offered Reconnect, whatever the stored token says",
  /teamTrackers\.linear && linearTeams\.length === 0 && trackerHealth\(teamTrackers\.linear, now\)\?\.tone === "ok"\s*\?\s*trackerUnanswered\("Linear"\)/.test(page) &&
    /teamTrackers\.jira && jiraProjects\.length === 0 && trackerHealth\(teamTrackers\.jira, now\)\?\.tone === "ok"\s*\?\s*trackerUnanswered\("Jira"\)/.test(page) &&
    /health=\{tracker \|\| \(health && health\.tone !== "ok"\) \? health : null\}/.test(page) &&
    trackerUnanswered("Jira").tone !== "ok");
check("…and are shown whenever the team has that tracker, for an app that files elsewhere too",
  /\{teamTrackers\.linear && linearTeams\.length > 0 && \(/.test(page) && /current=\{tracker\?\.teamId \?\? null\}/.test(page) &&
    /\{teamTrackers\.jira && jiraProjects\.length > 0 && \(/.test(page));
// CHE-438: Linear and Jira are the same job, so they are drawn the same way.
// The owner, 2026-10-13: "why should Jira be different?" — Jira had grown its
// own card without the contract, and Linear's card said problems stay on the
// check's page even while Jira was filing them.
const linearRow = page.search(/<TrackerRow\s+name="Linear"/);
const jiraRow = page.search(/<TrackerRow\s+name="Jira"/);
check("Linear and Jira are rows of one frame, and no tracker has a card of its own",
  linearRow !== -1 && jiraRow !== -1 && /function TrackerRow\(/.test(page) && !/· issue tracker/.test(page));
const contract = page.indexOf('name="pickupLabels"');
const lastRowEnd = page.lastIndexOf("</TrackerRow>");
check("the ticket contract sits under both trackers, in neither row",
  contract > jiraRow && contract > linearRow && lastRowEnd !== -1 && lastRowEnd < contract && /<form action=\{save\}/.test(page.slice(lastRowEnd, contract)));
// The card's sentences come from one pure module, so every variant can be
// checked — Codex P1 on #337: sentences assembled in JSX escaped the gate.
check("the card's sentences are the module's: the page types none of them",
  /trackerSummary\(app\.tracker, jira \? jiraHealth : health, jiraBlockers, Boolean\(teamTrackers\.linear \|\| teamTrackers\.jira\)\)/.test(page) &&
    /trackerTeamIdleLine\("Linear", "team", /.test(page) && /trackerIdleLine\("Linear", /.test(page) &&
    /trackerTeamIdleLine\("Jira", "project", /.test(page) && /trackerIdleLine\("Jira", /.test(page) &&
    /\{TEAM_TRACKER_LINE\}/.test(page) &&
    /\{jiraAccountLine\(teamTrackers\.jira !== null\)\}/.test(page) && /\{JIRA_NO_PROJECT\}/.test(page) && /jiraBlockedLine\(jira\.teamId, jiraBlockers\)/.test(page) &&
    !/Problems stay on the check|become tickets in|Not connected\.|Connected for your team|uses the Atlassian account|No project chosen|can&apos;t be filed/.test(page));
// What the first line says, case by case — never a promise the rows below
// contradict (Codex P2 on #337: an expired token or a blocked project).
const ok: TrackerHealth = { tone: "ok", text: "" }, bad: TrackerHealth = { tone: "bad", text: "" };
eq("summary: nothing connected", trackerSummary(null, null, []), "Not connected — problems stay on the check's page instead of becoming tickets.");
eq("summary: Jira filing", trackerSummary({ type: "jira", teamId: "SEC" }, ok, []), "Problems found on this app become tickets in Jira.");
eq("summary: Linear filing", trackerSummary({ type: "linear", teamId: "t" }, ok, []), "Problems found on this app become tickets in Linear.");
eq("summary: Jira without a project", trackerSummary({ type: "jira", teamId: null }, ok, []), "Problems stay on the check's page until a project is chosen below.");
eq("summary: an expired token files nothing", trackerSummary({ type: "linear", teamId: "t" }, bad, []), "Problems stay on the check's page until Linear is reconnected.");
eq("summary: a project that refuses our tickets files nothing", trackerSummary({ type: "jira", teamId: "SEC" }, ok, ["Team"]), "Problems stay on the check's page until another project is chosen below.");
eq("idle: the other tracker is named", trackerIdleLine("Linear", "Jira"), "Not connected. Connecting Linear connects it for your whole team and moves this app's tickets from Jira to Linear.");
// CHE-469: connected once, for the team; an app then only chooses.
eq("summary: the team has a tracker this app does not file into yet", trackerSummary(null, null, [], true), "Problems stay on the check's page until this app picks where its tickets go below.");
eq("idle: nothing connected says it serves the whole team", trackerIdleLine("Jira", null), "Not connected. Connected once, it serves every app of your team; each app picks where its tickets go.");
eq("team idle: the team's Jira, this app nowhere yet", trackerTeamIdleLine("Jira", "project", null), "Connected for your team. Choose a project below and this app's problems become tickets in Jira.");
eq("team idle: the team's Linear, this app on Jira", trackerTeamIdleLine("Linear", "team", "Jira"), "Connected for your team. Choosing a team below moves this app's tickets from Jira to Linear.");
// Codex P2 on #337: Reconnect starts the same consent as Connect.
check("the Atlassian account is named before Reconnect too", /^Reconnect uses the Atlassian account/.test(jiraAccountLine(true)) && /^Connect uses/.test(jiraAccountLine(false)));
// Every sentence the card can show describes the customer's tools only
// (CLAUDE.md §1). Codex P1 on #337: the first wording said "this browser".
const healths = [null, ok, { tone: "warn", text: "" } as TrackerHealth, bad];
const trackers = [null, ...["linear", "jira"].flatMap((type) => [{ type, teamId: null }, { type, teamId: "SEC" }])];
const everySentence = [
  ...trackers.flatMap((t) => healths.flatMap((h) => [[], ["Team", "Sprint"]].flatMap((b) => [false, true].map((team) => trackerSummary(t, h, b, team))))),
  ...["Linear", "Jira"].flatMap((name) => [null, name === "Linear" ? "Jira" : "Linear"].map((other) => trackerIdleLine(name, other))),
  ...(["team", "project"] as const).flatMap((where) => ["Linear", "Jira"].flatMap((name) => [null, name === "Linear" ? "Jira" : "Linear"].map((other) => trackerTeamIdleLine(name, where, other)))),
  TEAM_TRACKER_LINE,
  trackerUnanswered("Linear").text, trackerUnanswered("Jira").text,
  jiraAccountLine(false), jiraAccountLine(true), JIRA_NO_PROJECT, jiraBlockedLine("SEC", ["Team", "Sprint"]),
  "Linear or Jira, one at a time",
];
const leaky = [...new Set(everySentence)].filter((s) => MACHINERY_TERMS.test(s) || hasEnvironmentLeak(s));
check(`every sentence the tracker card can show names none of our machinery (${new Set(everySentence).size} sentences)`, leaky.length === 0, leaky.join(" | "));
check("…the fixed one is on the page as written", page.includes("Linear or Jira, one at a time"));
check("…and the gate catches the wording it replaced", MACHINERY_TERMS.test("Connect uses the Atlassian account this browser is signed in to"));
// Everywhere else a tracker is offered: scripts/verify-tracker-copy.ts.
check("no field reaches into another form", !/\bform="/.test(page));
// A <form> opened while another is open.
let depth = 0;
let nested = false;
for (const m of page.matchAll(/<form\b|<\/form>/g)) {
  depth += m[0] === "</form>" ? -1 : 1;
  if (depth > 1) nested = true;
}
check("no form is nested in another", !nested && depth === 0 && (page.match(/<form\b/g) ?? []).length >= 5, `${(page.match(/<form\b/g) ?? []).length} forms`);
// Four forms for three sections: the accounts section is one form for a
// website or an extension and another for a Shopify app (CHE-468: its store
// password alone), never both on one page.
check("each section's form is saved by the action bound to that section (three sections write a field of the app — accounts in one of two forms by the app's kind; who hears about it and webhooks have their own actions)",
  /const save = updateAppSettings\.bind\(null, app\.id, section\);/.test(page) && (page.match(/<form action=\{save\}/g) ?? []).length === 4 && /<form action=\{setAppNotifiers\.bind\(null, appId\)\}/.test(page));
check("a section the app does not have opens the first one; an address that is no section is not found",
  /if \(!sectionsFor\(app\)\.some\(\(s\) => s\.key === section\)\) redirect\(appPath\.section\(app\.id, "scope"\)\)/.test(page) && /if \(!section\) notFound\(\)/.test(page));
// CHE-412: the other-team state is an ordinary page of the app (breadcrumb,
// title, the card with the switch), one component for the settings, the
// check and the app's page.
const otherTeam = read("src/components/other-team-app.tsx");
check("the settings address opens the first section, and still answers for an app of another team of yours",
  /if \(app\) redirect\(appPath\.section\(app\.id, "scope"\)\)/.test(root) && /memberOfRows\(user\.id\)/.test(root) && /<OtherTeamApp/.test(root) && /switchTeamAction\.bind\(null, app\.teamId, to\)/.test(otherTeam));
check("…as do the check page and the app's page, each landing back on itself after the switch",
  /<OtherTeamApp[^>]*to=\{appPath\.check\(appId, runNumber\)\}/.test(read("src/app/(app)/health/apps/[appId]/checks/[runNumber]/page.tsx")) &&
    /<OtherTeamApp[^>]*to=\{appPath\.page\(appId\)\}/.test(read("src/app/(app)/health/apps/[appId]/page.tsx")) &&
    /<OtherTeamApp[^>]*to=\{appPath\.settings\(appId\)\}/.test(root));
check("…with the breadcrumb and the app's name as the title", /aria-label="Breadcrumb"/.test(otherTeam) && /All apps/.test(otherTeam) && /<h1[^>]*>\{name\}<\/h1>/.test(otherTeam));
check("the frame reads the team's app and steps aside when it is not the team's", /where: \{ \.\.\.teamOwned\(team\.id\), id: appId \}/.test(layout) && /if \(!app\) return <>\{children\}<\/>/.test(layout));
check("what a save bounced back is shown: saved, or the sentence it was refused with", /role="status"/.test(page) && /Not saved: \{error\}/.test(page));
check("the sub-navigation holds no effect", !/useEffect/.test(read("src/components/app-settings/settings-nav.tsx")));
const appPage = read("src/app/(app)/health/apps/[appId]/page.tsx");
check("the app's page opens each part of the settings at its own section",
  ["scope", "accounts", "integrations"].every((s) => appPage.includes(`appPath.section(app.id, "${s}")`)) && /appPath\.schedule\(app\.id\)/.test(appPage));

keeps().then(() => {
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
});
