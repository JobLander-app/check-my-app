// A problem's own page (CHE-412): /health/issues/{findingId}.
//
//   1. The loader on a real D1: the problem any of its sightings belongs to,
//      with the step it was seen on and that step's picture, the check that
//      walked it, its ticket, and the finding the answer is written to — read
//      as the team's, so another team's finding id is nothing.
//   2. The page: the title, the place for the priority, the step, the detail,
//      every check in its history, the four marks — and nothing of ours (the
//      anchor never leaves the loader; no cost, CLAUDE.md §10).
//   3. The Issues list opens a problem on its page; the check page keeps its
//      own findings list.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-issue-page.ts

import "./fixtures/wasm-module-loader.mjs";
import { realD1 } from "./fixtures/real-d1";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { issueOf } from "../src/lib/issue-load";
import { issueHref } from "../src/lib/issues-page";
import { THUMB_WIDTH } from "../src/lib/storage";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, got === want, `${JSON.stringify(got)}${got === want ? "" : ` ≠ ${JSON.stringify(want)}`}`);

// ── 1. The loader ───────────────────────────────────────────────────────────
async function loader() {
  const real = await realD1();
  try {
    const { db } = real;
    await db.user.createMany({ data: [{ id: "u", clerkUserId: "ck_u", email: "issue@example.test" }, { id: "v", clerkUserId: "ck_v", email: "other@example.test" }] });
    await db.team.createMany({ data: [{ id: "t", name: "T", plan: "business" }, { id: "o", name: "Other", plan: "business" }] });
    await db.app.createMany({
      data: [
        { id: "a", teamId: "t", ownerId: "u", appSlug: "a.test", targetUrl: "https://a.test", targetKind: "website" },
        // Two apps of one address: a check of that address with no app is nobody's.
        { id: "d1", teamId: "t", ownerId: "u", appSlug: "dup.test", targetUrl: "https://dup.test", targetKind: "website" },
        { id: "d2", teamId: "t", ownerId: "v", appSlug: "dup.test", targetUrl: "https://dup.test/2", targetKind: "website" },
        { id: "x", teamId: "o", ownerId: "v", appSlug: "x.test", targetUrl: "https://x.test", targetKind: "website" },
      ],
    });
    const at = (d: number) => new Date(Date.UTC(2026, 8, d, 10));
    const run = (id: string, n: number, appId: string | null, teamId: string, slug: string, d: number, over: object = {}) => ({
      id, publicId: `p_${id}`, runNumber: n, teamId, appId, appSlug: slug, targetUrl: `https://${slug}`, targetKind: "website",
      status: "completed", verdict: "needs_attention", priceUsd: 0.5, startedAt: at(d), createdAt: at(d), completedAt: at(d), ownerId: "u", ...over,
    });
    await db.run.createMany({
      data: [
        run("r1", 1, "a", "t", "a.test", 10),
        run("r2", 2, "a", "t", "a.test", 11),
        run("r3", 3, "a", "t", "a.test", 12), // walked "Sign in" again and found nothing; carries "Pay"
        run("r4", 4, null, "t", "a.test", 13), // made before the app was saved: the app's all the same
        run("r5", 5, null, "t", "dup.test", 13), // two apps of this address: nobody's
        run("y1", 6, "x", "o", "x.test", 14), // another team's
      ] as never,
    });
    const journey = (id: string, runId: string, order: number, title: string, status: string, over: object = {}) => ({ id, runId, order, title, status, journeyKey: title, ...over });
    await db.journey.createMany({
      data: [
        // Stored out of order: the anchor's journeyIndex is the position in
        // the check's own order, whatever the rows' order.
        journey("r1_pay", "r1", 1, "Pay", "ok"),
        journey("r1_signin", "r1", 0, "Sign in", "broken"),
        journey("r2_signin", "r2", 0, "Sign in", "broken"),
        journey("r2_pay", "r2", 1, "Pay", "broken"),
        journey("r3_signin", "r3", 0, "Sign in", "ok"),
        journey("r3_pay", "r3", 1, "Pay", "broken", { carriedFromRunId: "r2" }),
        journey("r4_signin", "r4", 0, "Sign in", "broken"),
        journey("y1_login", "y1", 0, "Their login", "broken"),
      ],
    });
    const shot = (c: string) => `/api/evidence/screenshots/${c.repeat(64)}.png`;
    const step = (journeyId: string, order: number, label: string, status: string, screenshotUrl: string | null, over: object = {}) => ({ id: `${journeyId}_s${order}`, journeyId, order, label, status, screenshotUrl, ...over });
    await db.step.createMany({
      data: [
        step("r1_signin", 1, "Press Sign in", "broken", shot("1")),
        step("r1_signin", 0, "Open the sign-in page", "ok", shot("0")),
        step("r2_signin", 1, "Press Sign in", "broken", shot("2"), { attempted: "Entered the test login and pressed Sign in", observed: "The button stayed disabled" }),
        step("r2_signin", 0, "Open the sign-in page", "ok", shot("0")),
        step("r2_pay", 0, "Pay by card", "broken", "/api/evidence/private/runs/r2/pay.png"),
        step("r3_signin", 0, "Open the sign-in page", "ok", shot("0")),
        step("r3_signin", 1, "Press Sign in", "ok", shot("3")),
        step("r3_pay", 0, "Pay by card", "broken", "/api/evidence/private/runs/r2/pay.png"),
        step("r4_signin", 0, "Open the sign-in page", "broken", null),
        step("y1_login", 0, "Their page", "broken", shot("5")),
      ],
    });
    const anchor = (journeyIndex: number, stepIndex: number | null) => JSON.stringify({ stepRef: { journeyIndex, ...(stepIndex === null ? {} : { stepIndex }) }, hands: [], trail: "present" });
    const detail = JSON.stringify({ where: "/login · Sign in", whatWeTried: ["Entered the test login", "Pressed Sign in"], whatHappened: "The button stayed disabled.", whyItMatters: "Nobody can sign in." });
    const finding = (id: string, runId: string, number: number, title: string, over: object = {}) => ({ id, runId, number, title, category: "broken", severity: "high", ...over });
    await db.finding.createMany({
      data: [
        finding("f1", "r1", 1, "Sign in button stays disabled", { signature: "text:v1:signin", anchor: anchor(0, 1) }),
        finding("f2", "r2", 1, "Sign-in button stays disabled after the press", { signature: "text:v1:signin", anchor: anchor(0, 1), detail, mark: "watch" }),
        // Seen in #2; #3 restates it on the carried journey (not a sighting).
        finding("f8", "r2", 2, "Paying by card fails", { signature: "text:v1:pay", anchor: anchor(1, 0), mark: "known" }),
        finding("f3", "r3", 1, "Paying by card still fails", { signature: "text:v1:pay", anchor: anchor(1, 0) }),
        // Seen in #1, gone by #2 (which walked the step again), back in #3: two
        // streaks, and only the latest is the problem's history.
        finding("f6", "r1", 2, "The sign-in page is slow to open", { signature: "text:v1:slow", anchor: anchor(0, 0) }),
        finding("f7", "r3", 2, "The sign-in page opens slowly", { signature: "text:v1:slow", anchor: anchor(0, 0) }),
        // No sighting anywhere: a restatement of something no check saw itself.
        finding("f9", "r3", 3, "Checkout is missing", { signature: "text:v1:checkout", anchor: anchor(1, 0) }),
        finding("f4", "r4", 1, "Sign-in page does not open", { signature: "text:v1:open", anchor: anchor(0, 0) }),
        finding("f5", "r5", 1, "Of no app", { signature: "text:v1:none" }),
        finding("fy", "y1", 1, "Their login is broken", { signature: "text:v1:theirs", anchor: anchor(0, 0) }),
      ],
    });
    await db.issueLink.create({ data: { id: "l1", appId: "a", dedupKey: "k1", externalIssueId: "JOB-7", status: "open", findingId: "f2" } });

    const page = await issueOf(db, "t", "f2");
    check("real D1: the latest sighting opens its problem", page !== null && page.recurrence !== null);
    eq("real D1: the problem's sightings, oldest first, and the check it was gone by", `${page?.recurrence?.sightings.map((s) => `#${s.runNumber} ${s.findingId}`).join(", ")} · gone by #${page?.recurrence?.goneSinceRunNumber}`, "#1 f1, #2 f2 · gone by #3");
    eq("real D1: the step it was seen on, by position in the check's own order", `${page?.step?.journeyTitle} / ${page?.step?.label} ${page?.step?.status} in #${page?.step?.walkedInRunNumber}`, "Sign in / Press Sign in broken in #2");
    eq("real D1: the step's words", `${page?.step?.attempted} | ${page?.step?.observed}`, "Entered the test login and pressed Sign in | The button stayed disabled");
    eq("real D1: its picture is the small copy, its link the full screenshot", JSON.stringify(page?.step?.shot), JSON.stringify({ thumb: `/api/evidence/thumbs/${THUMB_WIDTH}/${"2".repeat(64)}.webp`, full: shot("2") }));
    eq("real D1: the detail, parsed", `${page?.finding.detail.where} · ${page?.finding.detail.whatWeTried?.length} tried`, "/login · Sign in · 2 tried");
    eq("real D1: the ticket tied to it", `${page?.ticket?.externalIssueId} ${page?.ticket?.status}`, "JOB-7 open");
    eq("real D1: the answer is written to the latest sighting, by whoever ran that check", `${page?.answer.findingId} ${page?.answer.mark} ${page?.answer.ownerId}`, "f2 watch u");

    const older = await issueOf(db, "t", "f1");
    eq("real D1: an older sighting's id opens the same problem", older?.recurrence?.sightings.map((s) => s.findingId).join(","), "f1,f2");
    eq("real D1: …with its own words and step, and the answer still on the latest sighting", `${older?.finding.title} / #${older?.step?.walkedInRunNumber} / ${older?.answer.findingId} ${older?.answer.mark}`, "Sign in button stays disabled / #1 / f2 watch");

    const carried = await issueOf(db, "t", "f3");
    eq("real D1: a restatement on a carried journey opens the problem it restates; its step names the check that walked it; the answer stands on the sighting (Codex P2 on #265)",
      `${carried?.recurrence?.sightings.map((s) => `#${s.runNumber} ${s.findingId}`).join(",")} / ${carried?.step?.label} in #${carried?.step?.walkedInRunNumber} / ${carried?.answer.findingId} ${carried?.answer.mark}`, "#2 f8 / Pay by card in #2 / f8 known");
    eq("real D1: an address that is not a content-addressed screenshot is not shown as a picture", carried?.step?.shot, null);
    const earlier = await issueOf(db, "t", "f6");
    eq("real D1: a finding from before the problem went away and came back opens the problem's current streak (Codex P2 on #265)",
      `${earlier?.recurrence?.sightings.map((s) => `#${s.runNumber} ${s.findingId}`).join(",")} / ${earlier?.recurrence?.issue.state} by #${earlier?.recurrence?.goneSinceRunNumber} / ${earlier?.answer.findingId}`, "#3 f7 / gone by #4 / f7");
    eq("real D1: …while its own words and step are its own", `${earlier?.finding.title} / #${earlier?.step?.walkedInRunNumber}`, "The sign-in page is slow to open / #1");
    eq("real D1: a restatement of something no check saw itself has no problem to open; the finding stands alone", `${(await issueOf(db, "t", "f9"))?.recurrence} ${(await issueOf(db, "t", "f9"))?.answer.findingId}`, "null f9");

    const before = await issueOf(db, "t", "f4");
    eq("real D1: a check made before the app was saved is the app's (the only one of that address)", `${before?.appId} ${before?.recurrence?.issue.state}`, "a new");
    eq("real D1: a step with no picture has none", `${before?.step?.label} ${before?.step?.shot}`, "Open the sign-in page null");
    eq("real D1: a check of an address two apps share is nobody's — no page", await issueOf(db, "t", "f5"), null);
    eq("real D1: another team's finding is nothing here", await issueOf(db, "t", "fy"), null);
    eq("real D1: …and this team's is nothing there", await issueOf(db, "o", "f2"), null);
    eq("real D1: an id that is no finding", await issueOf(db, "t", "nope"), null);
    check("real D1: nothing of another team's is in a page", !JSON.stringify(page).includes("Their") && !JSON.stringify(page).includes("5".repeat(64)));
  } finally {
    await real.dispose();
  }
}

// ── 2. The page ─────────────────────────────────────────────────────────────
const lib = read("src/lib/issue-load.ts");
const page = read("src/app/(app)/health/issues/[findingId]/page.tsx");
check("the finding is read through its check, as the team's", /where: \{ id: findingId, run: \{ teamId \} \}/.test(lib));
check("the app is the team's, the ticket its app's, the walking check the team's",
  /\.\.\.teamOwned\(teamId\), appSlug: run\.appSlug/.test(lib) && /app: \{ teamId \} \}, select: \{ externalIssueId: true, status: true \}/.test(lib) && /\.\.\.teamOwned\(teamId\), id: journey\.carriedFromRunId/.test(lib));
check("the recurrences are the app's alone (CHE-358), through recurrence's own loader", /teamRecurrences\(db, teamId, appId\)/.test(lib));
check("the anchor is read in the loader and never leaves it", /parseJson<\{ stepRef\?/.test(lib) && !/anchor:/.test(lib.slice(lib.indexOf("return {"))) && !/anchor/.test(page));
check("the loader reads no cost (CLAUDE.md §10)", !/costUsd|cost_usd|tokens|multiplier|margin/i.test(lib));
check("the page names no cost, token or margin field", !/costUsd|cost_usd|tokens|multiplier|margin/i.test(page));
check("the page is drawn on the server, no effect", !/^"use client"/.test(page) && !/useEffect|useState/.test(page));
check("the title, then the line with the state, severity and category — and the place CHE-413 puts the priority",
  /<h1[^>]*>\{title\}<\/h1>/.test(page) && /CHE-413/.test(page) && page.indexOf("CHE-413") < page.indexOf("SEVERITY_META[severity]") && /<span>\{category\}<\/span>/.test(page));
check("the step with its picture: the small copy shown, the full one linked", /src=\{step\.shot\.thumb\}/.test(page) && /href=\{step\.shot\.full\}/.test(page) && !/src=\{step\.shot\.full\}/.test(page));
check("what was tried, what happened, why it matters", /detail\.whatWeTried\.map/.test(page) && /\{detail\.whatHappened\}/.test(page) && /\{detail\.whyItMatters\}/.test(page));
check("every check in its history opens inside the app", /r\.sightings\.map\(\(s\) => \(/.test(page) && /href=\{appPath\.check\(issue\.appId, s\.runNumber\)\}/.test(page) && /href=\{appPath\.check\(issue\.appId, r\.goneSinceRunNumber\)\}/.test(page));
check("the four answers are the list's own, written to the latest sighting", /<IssueMarks findingId=\{issue\.answer\.findingId\} mark=\{issue\.answer\.mark\} \/>/.test(page));
check("a mark is offered to whom the route would let set it", /issue\.answer\.ownerId === null \|\| issue\.answer\.ownerId === user\.id/.test(page));
check("the ticket, as the list names it", /ticketLabel\(issue\.ticket\)/.test(page));
check("not the team's: not found", /if \(!issue\) notFound\(\)/.test(page));

// ── 3. The way in ───────────────────────────────────────────────────────────
eq("a problem's address is its finding's", issueHref("f2"), "/health/issues/f2");
const issues = read("src/app/(app)/health/issues/page.tsx");
check("the Issues list opens a problem on its own page", /href: findingId \? issueHref\(findingId\) : appPath\.check\(i\.appId, i\.lastSeenRunNumber\)/.test(issues) && /<Link href=\{p\.href\}/.test(issues));
const checkPage = read("src/app/(app)/health/apps/[appId]/checks/[runNumber]/page.tsx");
check("the check page keeps its own findings list (the verdict's body)", /<VerdictView\s+id=\{run\.publicId\}/.test(checkPage));

loader().then(() => {
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
});
