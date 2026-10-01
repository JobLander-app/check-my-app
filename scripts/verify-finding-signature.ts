// CHE-354 verification: one problem keeps one identity across checks, even
// when its title is reworded, and recurrence is counted on that identity.
//
// The fixture is real: every finding and journey of meetbashar.com runs #241 …
// #275 as stored in prod D1 (scripts/fixtures/che-354-meetbashar.json). One dead
// YouTube video on the Holotope guide was reported in seven checks in a row
// under seven titles, severity flipping high ↔ medium, and was gone in #275.
// Required: ONE signature, "seen 7 times, gone since #275".
//
// The same assertions fail on today's ticket key. Run with CHE354_OLD_KEY=1 to
// put dedupKeyForFinding (src/lib/tracker/file.ts) in place of findingSignature
// and watch them fail; the first block below also asserts that failure, so the
// bug this exists for is pinned, not just remembered.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-finding-signature.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findingSignature, OUR_LEFTOVERS_WHERE, pageOf, signatureKind } from "@/lib/finding-signature";
import {
  recurrence,
  retiredSinceRun,
  type RecurrenceFinding,
  type RecurrenceLink,
  type RecurrenceRun,
  type RecurringIssue,
} from "@/lib/recurring";
import { dedupKeyForFinding } from "@/lib/tracker/file";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

interface Fixture {
  app: { id: string; appSlug: string };
  runs: Array<{
    runNumber: number;
    journeys: Array<{ id: string; key: string; carried: boolean; status: string }>;
    findings: Array<Omit<RecurrenceFinding, "signature"> & { number: number }>;
  }>;
}

const fixture: Fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/che-354-meetbashar.json", import.meta.url)), "utf8"),
);
const app = fixture.app;

function runsOf(f: Fixture, edit: (finding: RecurrenceFinding, runNumber: number) => RecurrenceFinding = (x) => x): RecurrenceRun[] {
  return f.runs.map((r) => ({
    runNumber: r.runNumber,
    journeys: r.journeys.map((j) => ({ identity: j.id, carried: j.carried, walked: !j.carried && j.status !== "skipped" })),
    findings: r.findings.map((x) => edit({ ...x, signature: null }, r.runNumber)),
  }));
}

const oldKey = (f: RecurrenceFinding, appSlug: string) => dedupKeyForFinding(f, { appSlug });
const signatureOf = process.env.CHE354_OLD_KEY ? oldKey : undefined;
if (signatureOf) console.log("CHE354_OLD_KEY set: grouping by today's dedupKeyForFinding\n");

const holotope = fixture.runs.flatMap((r) => r.findings.filter((f) => /holotope/i.test(f.title)).map((f) => ({ run: r.runNumber, f })));
const HOLOTOPE_RUNS = [241, 246, 249, 252, 255, 259, 267];

// ── 0. The fixture is the case the ticket names ───────────────────────────────
check(
  "fixture: the Holotope finding is in runs #241 #246 #249 #252 #255 #259 #267",
  JSON.stringify(holotope.map((h) => h.run)) === JSON.stringify(HOLOTOPE_RUNS),
  holotope.map((h) => `#${h.run}`).join(" "),
);
check("fixture: seven different titles", new Set(holotope.map((h) => h.f.title)).size === 7);
check("fixture: severity flips between high and medium", new Set(holotope.map((h) => h.f.severity)).size === 2);

// ── 1. Today's key: seven problems where there is one ─────────────────────────
const oldKeys = new Set(holotope.map((h) => oldKey({ ...h.f, signature: null }, app.appSlug)));
check("today's dedupKeyForFinding splits the one problem into 7 keys (the CHE-354 bug)", oldKeys.size === 7, `${oldKeys.size} keys`);
const underOldKey = recurrence(app, runsOf(fixture), [], { signatureOf: oldKey });
check(
  "today's key cannot say \"seen 7 times\": no issue reaches 7",
  underOldKey.every((r) => r.issue.timesSeen < 7),
  `max timesSeen ${Math.max(...underOldKey.map((r) => r.issue.timesSeen))}`,
);

// ── 2. The signature: one ─────────────────────────────────────────────────────
const sigs = new Set(holotope.map((h) => (signatureOf ?? ((f, s) => findingSignature({ appSlug: s, ...f })))({ ...h.f, signature: null }, app.appSlug)));
check("findingSignature gives the seven findings ONE signature", sigs.size === 1, [...sigs].join(", "));
const sig = [...sigs][0];
check("…keyed on the page (no request, no extension error behind it)", !signatureOf && signatureKind(sig) === "page", sig);

// ── 3. Recurrence: seen 7 times, gone since #275 ──────────────────────────────
const result = recurrence(app, runsOf(fixture), [], { signatureOf });
const issue = result.find((r) => r.issue.timesSeen === 7 || r.issue.signature === sig);
check("one issue carries the Holotope signature", Boolean(issue));
check("seen 7 times", issue?.issue.timesSeen === 7, String(issue?.issue.timesSeen));
check("first seen #241, last seen #267", issue?.issue.firstSeenRunNumber === 241 && issue?.issue.lastSeenRunNumber === 267,
  `${issue?.issue.firstSeenRunNumber} → ${issue?.issue.lastSeenRunNumber}`);
check("gone since #275 (its journey walked again, finding absent)", issue?.goneSinceRunNumber === 275 && issue?.issue.state === "gone",
  `${issue?.issue.state}, since ${issue?.goneSinceRunNumber}`);
check("title is the latest wording (#267)", issue?.issue.title === "Dead YouTube source video cited twice on the Holotope guide", issue?.issue.title);

const CONTRACT: Array<keyof RecurringIssue> = [
  "signature", "appId", "title", "category", "severity", "firstSeenRunNumber", "lastSeenRunNumber", "timesSeen", "state", "issueLinkId",
];
check("RecurringIssue has exactly the contract's fields", JSON.stringify(Object.keys(issue?.issue ?? {}).sort()) === JSON.stringify([...CONTRACT].sort()));

if (signatureOf) {
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED (expected under CHE354_OLD_KEY)`);
  process.exit(failures === 0 ? 0 : 1);
}

// ── 4. "Absent from the latest check" is not "fixed" ──────────────────────────
const without275 = fixture.runs.filter((r) => r.runNumber !== 275);
const partial276 = {
  runNumber: 276,
  // Walks two other journeys, carries the meditation journey forward.
  journeys: fixture.runs[fixture.runs.length - 1].journeys.map((j) => ({
    ...j,
    carried: !["ajmu1nd2gyaigav23o", "ajmu1nd2gy9ttv7e9x"].includes(j.id),
  })),
  findings: [],
};
const stillThere = recurrence(app, runsOf({ ...fixture, runs: without275 }), []).find((r) => r.issue.signature === sig);
check("without #275 it is recurring: nothing has looked again", stillThere?.issue.state === "recurring" && stillThere.goneSinceRunNumber === null,
  `${stillThere?.issue.state}`);
const afterPartial = recurrence(app, runsOf({ ...fixture, runs: [...without275, partial276] }), []).find((r) => r.issue.signature === sig);
check("a later partial check that did not walk its journey leaves it recurring", afterPartial?.issue.state === "recurring",
  `${afterPartial?.issue.state}`);

// An unanchored finding (rows before CHE-215) could have come from any journey
// its check walked; it is gone once later checks — between them — walked all
// of those again. #267 walked five; two partial checks cover them.
const unanchored = (f: RecurrenceFinding) => (f.id === holotope[6].f.id ? { ...f, anchor: null } : f);
const walks = (runNumber: number, ids: string[]) => ({
  runNumber,
  journeys: fixture.runs[6].journeys.map((j) => ({ ...j, carried: !ids.includes(j.id), status: "ok" })),
  findings: [],
});
const firstHalf = walks(270, ["ajmu1nd2h1ey1orc03", "ajmu1nd2gy5a6yowih", "ajmu1nd2gy0xcc6ets"]);
const secondHalf = walks(271, ["ajmu1nd2h27vzxpfze", "ajmu1nd2gy1q4sw7dg"]);
const split = (runs: typeof without275) =>
  recurrence(app, runsOf({ ...fixture, runs }, unanchored), []).find((r) => r.issue.signature === sig);
check("unanchored: one partial check covering 3 of the 5 journeys #267 walked → still recurring",
  split([...without275, firstHalf])?.issue.state === "recurring", split([...without275, firstHalf])?.issue.state);
check("unanchored: the next check walks the other 2 → gone since #271",
  split([...without275, firstHalf, secondHalf])?.goneSinceRunNumber === 271, String(split([...without275, firstHalf, secondHalf])?.goneSinceRunNumber));

// A check whose list lacks the journey. Before CHE-331 a full or on-demand
// check listed only what it walked (src/agent/partial.ts), so absence alone
// proves nothing (Codex round 2, P1) — only the app retiring the journey does.
const MEDITATION = "ajmu1nd2h1ey1orc03";
const notListed = {
  runNumber: 276,
  journeys: fixture.runs[7].journeys.filter((j) => j.id !== MEDITATION),
  findings: [],
};
const afterNotListed = recurrence(app, runsOf({ ...fixture, runs: [...without275, notListed] }), []).find((r) => r.issue.signature === sig);
check("a later check that simply does not list its journey → still recurring (a legacy list is not a retirement)",
  afterNotListed?.issue.state === "recurring", afterNotListed?.issue.state);
const afterRetire = recurrence(app, runsOf({ ...fixture, runs: [...without275, notListed] }), [], {
  retiredSince: new Map([[MEDITATION, 276]]),
}).find((r) => r.issue.signature === sig);
check("its journey retired before #276 → gone since #276",
  afterRetire?.issue.state === "gone" && afterRetire.goneSinceRunNumber === 276, `${afterRetire?.issue.state} ${afterRetire?.goneSinceRunNumber}`);
// Codex round 1: carried in one check, retired before a later one. The
// carrying check did not look; the release is dated to the check after the retirement.
const carriedThenRetired = recurrence(app, runsOf({ ...fixture, runs: [...without275, partial276, { ...notListed, runNumber: 277 }] }), [], {
  retiredSince: new Map([[MEDITATION, 277]]),
}).find((r) => r.issue.signature === sig);
check("carried in #276, retired before #277 → gone since #277, not #276",
  carriedThenRetired?.goneSinceRunNumber === 277, String(carriedThenRetired?.goneSinceRunNumber));
check("retiredSinceRun dates a retirement to the first check that started after it",
  retiredSinceRun([{ id: "j", retiredAt: "2026-09-02T00:00:00Z" }], [
    { runNumber: 1, startedAt: "2026-09-01T00:00:00Z" },
    { runNumber: 2, startedAt: "2026-09-03T00:00:00Z" },
  ]).get("j") === 2);
const quick = { runNumber: 276, journeys: [], findings: [] };
const afterQuick = recurrence(app, runsOf({ ...fixture, runs: [...without275, quick] }), []).find((r) => r.issue.signature === sig);
check("a quick check that lists no journeys says nothing → still recurring", afterQuick?.issue.state === "recurring", afterQuick?.issue.state);

// Gone, then seen again: a new streak. A problem that was fixed and came back
// (or a different problem the page key cannot tell apart) is not "seen N times".
const back = {
  runNumber: 280,
  journeys: fixture.runs[7].journeys,
  findings: [{ ...holotope[6].f, id: "back", title: "Holotope guide source video is dead again" }],
};
const regressed = recurrence(app, runsOf({ ...fixture, runs: [...fixture.runs, back] }), []).find((r) => r.issue.signature === sig);
check("gone since #275, seen again in #280 → a new streak: new, seen 1×, first seen #280",
  regressed?.issue.state === "new" && regressed.issue.timesSeen === 1 && regressed.issue.firstSeenRunNumber === 280,
  `${regressed?.issue.state} ${regressed?.issue.timesSeen}× from #${regressed?.issue.firstSeenRunNumber}`);

// Test records our own check left behind are our defect, not the app's.
const leftovers = {
  id: "leftovers", number: 9, title: "Test records we created are still in your meetbashar.com", category: "risky", severity: "medium",
  mark: "none", anchor: null, detail: JSON.stringify({ where: OUR_LEFTOVERS_WHERE, whatHappened: "1 record was not removed again." }),
};
const withLeftovers = recurrence(app, runsOf({
  ...fixture,
  runs: fixture.runs.map((r) => (r.runNumber >= 255 ? { ...r, findings: [...r.findings, leftovers] } : r)),
}), []);
check("our own leftover test records are not counted as the app's recurring issue",
  withLeftovers.every((r) => signatureKind(r.issue.signature) !== "ours") && withLeftovers.length === result.length,
  `${withLeftovers.length} issues, as without them`);

// ── 5. A restatement of an earlier walk is not a sighting ─────────────────────
// #246 #2, #255 #2 and #259 #2 point at journeys their own check carried ("from
// an earlier walk, not re-verified today").
const restated = ["cmueq4eq90048uc0nii6zynco", "cmuj0dmr5003xw30nvh2zuoju", "cmukg76yi003xvn0nhdalwud3"];
const restatedSigs = new Set(fixture.runs.flatMap((r) => r.findings.filter((f) => restated.includes(f.id)))
  .map((f) => findingSignature({ appSlug: app.appSlug, ...f })));
check("findings anchored to a carried journey count as no sighting", result.every((r) => !restatedSigs.has(r.issue.signature)),
  `${restatedSigs.size} signatures, none in the result`);

// ── 6. Marks and tickets ──────────────────────────────────────────────────────
const marked = (mark: string, onRun: number) =>
  recurrence(app, runsOf(fixture, (f, n) => (f.id === holotope.find((h) => h.run === onRun)!.f.id ? { ...f, mark } : f)), [])
    .find((r) => r.issue.signature === sig)!.issue.state;
check("marked false_positive → not_a_bug", marked("false_positive", 252) === "not_a_bug");
const knownOpen = recurrence(
  app,
  runsOf({ ...fixture, runs: without275 }, (f) => (f.id === holotope[3].f.id ? { ...f, mark: "known" } : f)),
  [],
).find((r) => r.issue.signature === sig)!.issue.state;
check("marked known (and still there) → known", knownOpen === "known", knownOpen);
const fixedLast = recurrence(
  app,
  runsOf({ ...fixture, runs: without275 }, (f) => (f.id === holotope[6].f.id ? { ...f, mark: "fixed" } : f)),
  [],
).find((r) => r.issue.signature === sig)!.issue.state;
check("marked fixed on its latest sighting, nothing has looked again → known, not gone (Codex round 2)", fixedLast === "known", fixedLast);
const fixedAndLooked = recurrence(
  app,
  runsOf(fixture, (f) => (f.id === holotope[6].f.id ? { ...f, mark: "fixed" } : f)),
  [],
).find((r) => r.issue.signature === sig)!.issue.state;
check("marked fixed and #275 walked its journey without it → gone", fixedAndLooked === "gone", fixedAndLooked);
const fixedEarlier = recurrence(
  app,
  runsOf({ ...fixture, runs: without275 }, (f) => (f.id === holotope[2].f.id ? { ...f, mark: "fixed" } : f)),
  [],
).find((r) => r.issue.signature === sig)!.issue.state;
check("marked fixed on #249 but seen again after → recurring (it came back)", fixedEarlier === "recurring", fixedEarlier);
const link: RecurrenceLink = { id: "link-1", status: "suppressed", findingId: holotope[2].f.id };
const suppressed = recurrence(app, runsOf(fixture), [link]).find((r) => r.issue.signature === sig)!.issue;
check("a Canceled ticket (IssueLink suppressed) pointing at one of its findings → not_a_bug with the link id",
  suppressed.state === "not_a_bug" && suppressed.issueLinkId === "link-1", `${suppressed.state} ${suppressed.issueLinkId}`);

// Our own [Checker gap] / [Checker defect] tickets have no findingId (on
// checkmyapp.dev CHE-249 counts 58 occurrences). They are never an issue of
// the app and never attach to one — not even when their dedupKey is a hash
// one of the app's findings also produces.
const ourTicket = {
  id: "che-249",
  status: "open",
  findingId: null,
  occurrences: 58,
  dedupKey: dedupKeyForFinding(holotope[6].f, { appSlug: app.appSlug }),
};
const withOurTicket = recurrence(app, runsOf(fixture), [ourTicket]);
check("an IssueLink with findingId NULL (×58) yields no issue and attaches to none",
  withOurTicket.length === result.length && withOurTicket.every((r) => r.issue.issueLinkId === null),
  `${withOurTicket.length} issues (as without it), linked: ${withOurTicket.filter((r) => r.issue.issueLinkId).length}`);

// Codex round 2: one signature folds reworded findings that each got a ticket.
// Any Canceled one settles it, whatever order the links come in, and the link
// shown is the latest sighting's.
const openEarly: RecurrenceLink = { id: "open-241", status: "open", findingId: holotope[0].f.id };
const canceledLate: RecurrenceLink = { id: "canceled-259", status: "suppressed", findingId: holotope[5].f.id };
for (const order of [[openEarly, canceledLate], [canceledLate, openEarly]]) {
  const r = recurrence(app, runsOf(fixture), order).find((x) => x.issue.signature === sig)!.issue;
  check(`two tickets on one signature (${order.map((l) => l.id).join(", ")}) → not_a_bug, link of the latest sighting`,
    r.state === "not_a_bug" && r.issueLinkId === "canceled-259", `${r.state} ${r.issueLinkId}`);
}

// ── 7. One check, two problems, one page signature: split ─────────────────────
// joblander.app #11 as stored (where + title): three different broken things
// on /login, one page signature. Seen again together in a second check.
const login = (id: string, title: string, where: string): RecurrenceFinding => ({
  id, title, category: "broken", severity: "high", mark: "none", anchor: null, signature: null,
  detail: JSON.stringify({ where, whatHappened: "Nothing happened." }),
});
const LOGIN = [
  ["Google OAuth button gets stuck in permanent 'Loading' state", "/login — 'Continue with Google' button"],
  ["'Send reset link' does nothing — no request, no feedback", "/login — password-reset view"],
  ["Email/password 'Sign in' produces no network call and no feedback", "/login — Sign in button"],
];
const loginRuns: RecurrenceRun[] = [11, 12].map((runNumber) => ({
  runNumber,
  journeys: [{ identity: "login", carried: false, walked: true }],
  findings: LOGIN.map(([title, where], i) => login(`${runNumber}-${i}`, title, where)),
}));
const loginSigs = new Set(LOGIN.map(([title, where]) => findingSignature({ appSlug: "joblander.app", ...login("x", title, where) })));
check("the three /login findings of one check share one page signature (the merge to undo)", loginSigs.size === 1);
const loginIssues = recurrence({ id: "jl", appSlug: "joblander.app" }, loginRuns, []);
check("…recurrence splits them: three issues, each seen 2×, each under its own wording",
  loginIssues.length === 3 && loginIssues.every((r) => r.issue.timesSeen === 2 && r.issue.state === "recurring") &&
    new Set(loginIssues.map((r) => r.issue.title)).size === 3,
  loginIssues.map((r) => `${r.issue.timesSeen}× ${r.issue.title.slice(0, 28)}`).join(" | "));
check("…while the meetbashar seven, never two in one check, stay one", result.filter((r) => r.issue.signature.startsWith(sig)).length === 1);

// ── 8. What the signature is made of ──────────────────────────────────────────
const base = { appSlug: "app.example", title: "Pricing link 404s", category: "broken", anchor: null };
const at = (where: string, extra: Partial<typeof base> = {}) =>
  findingSignature({ ...base, ...extra, detail: JSON.stringify({ where, whatHappened: "The link leads nowhere." }) });
check("a reworded title keeps the signature", at("/pricing — footnote") === at("/pricing — footnote", { title: "Footnote link on Pricing is dead" }));
const withSeverity = (severity: string) =>
  findingSignature({ ...base, severity, detail: JSON.stringify({ where: "/pricing" }) } as Parameters<typeof findingSignature>[0]);
check("a flipped severity keeps the signature", withSeverity("high") === withSeverity("medium"));
check("a different page is a different signature", at("/pricing") !== at("/docs"));
check("a different category on the same page is a different signature", at("/pricing") !== at("/pricing", { category: "polish" }));
check("a named failing request outranks the page", signatureKind(findingSignature({
  ...base,
  detail: JSON.stringify({ where: "/checkout", whatHappened: "POST /api/orders returned 500" }),
})) === "req");
check("no page and no request: the wording is the key", signatureKind(at("The chat Sources panel")) === "text" &&
  at("The chat Sources panel") !== at("The chat Sources panel", { title: "Something else" }));
check("an extension error signature is its own identity", signatureKind(findingSignature({
  ...base,
  appSlug: "extension:abc",
  anchor: JSON.stringify({ errorSignature: "a".repeat(64) }),
  detail: null,
})) === "ext");

const PAGES: Array<[string, string | null]> = [
  ["/learn/holotope-meditation — \"In his own words\" list", "/learn/holotope-meditation"],
  ["Settings → General (/en/settings/general)", "/settings/general"],
  ["https://app.example.com/pricing/", "/pricing"],
  ["Verdict page /verdict/cmudb4z5e000bx10nt4zorpts (signed-in run)", "/verdict/:id"],
  ["Homepage 'Try it now' live-insights section (/)", "/"],
  ["Sign in / sign up modal", null],
  ["Chat answer → \"Sources\" panel", null],
];
for (const [where, want] of PAGES) check(`pageOf(${JSON.stringify(where)}) = ${want}`, pageOf(where) === want, String(pageOf(where)));

console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
