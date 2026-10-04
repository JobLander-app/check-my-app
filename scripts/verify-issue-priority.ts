// Every problem has a priority, P0–P3, computed — never asked of a model — and
// shown on one scale everywhere the customer meets it (CHE-413).
//
//   1. The rule (src/lib/issue-priority.ts), on fixtures: the owner's four
//      lines, the gaps they leave (unknown is never promoted; polish never
//      rises; the streak lifts only a defect), and the places that count as
//      money, sign-in or the user's data.
//   2. Who hit it (src/lib/audience.ts): the same answer from a step's actions
//      and from the one-word fill D1 reduces them to.
//   3. The three surfaces say the same label from the same inputs: the review
//      (get_review), the ticket we file (its first line), and Issues' row — and
//      the review and the ticket, which know one check only, never claim the
//      streak.
//   4. Customer-facing words: the legend and the ticket line name no machinery
//      and give nobody homework (CLAUDE.md §1); the ticket names no fix (§9).
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-issue-priority.ts

import { PRIORITIES, PRIORITY_META, issuePriority, priorityRank, sensitivePlace, type PriorityInput } from "../src/lib/issue-priority";
import { audienceAt, audienceOf, stepFill } from "../src/lib/audience";
import { buildReview, reviewPriority } from "../src/lib/review";
import { draftForFinding } from "../src/lib/tracker/file";
import { recurrence, type RecurrenceRun } from "../src/lib/recurring";
import { issuePriorityOf } from "../src/lib/issues-page";
import { MACHINERY_TERMS, hasEnvironmentLeak } from "../src/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, got === want, `${JSON.stringify(got)}${got === want ? "" : ` ≠ ${JSON.stringify(want)}`}`);

// ── 1. The rule ─────────────────────────────────────────────────────────────
const p = (o: Partial<PriorityInput>) => issuePriority({ category: "broken", severity: "high", where: "/about", timesSeen: 1, audience: "unknown", ...o });

eq("P0: broken for existing users at the checkout", p({ where: "/checkout → Pay", audience: "existing_users" }), "P0");
eq("P0: broken for existing users on sign-in (a request)", p({ where: "POST /api/auth/session → 500", audience: "existing_users" }), "P0");
eq("P0: broken for existing users on billing, path inside a sentence", p({ where: "Settings → Billing (/account/billing)", audience: "existing_users" }), "P0");
eq("P0: broken three checks in a row, wherever", p({ where: "/about", timesSeen: 3 }), "P0");
eq("P0: exposed three checks in a row", p({ category: "exposed", timesSeen: 3 }), "P0");
eq("P0: risky three checks in a row", p({ category: "risky", severity: "medium", timesSeen: 3 }), "P0");
eq("not P0: broken at the checkout, who hit it unknown → P1 (unknown is never promoted)", p({ where: "/checkout" }), "P1");
eq("not P0: broken at the checkout for new visitors → P1", p({ where: "/checkout", audience: "new_visitors" }), "P1");
eq("not P0: broken for existing users on a page that is none of money, sign-in, data → P1", p({ where: "/blog/launch", audience: "existing_users" }), "P1");
eq("P1: broken anywhere", p({ where: "/blog" }), "P1");
eq("P1: exposed anywhere", p({ category: "exposed", where: "/api/users" }), "P1");
eq("P1: risky for existing users", p({ category: "risky", severity: "medium", audience: "existing_users" }), "P1");
eq("P1: a critical confusing for new visitors is lifted one step, not two", p({ category: "confusing", severity: "critical", audience: "new_visitors" }), "P1");
eq("P2: risky for new visitors", p({ category: "risky", severity: "medium", audience: "new_visitors" }), "P2");
eq("P2: risky, who hit it unknown", p({ category: "risky", severity: "medium" }), "P2");
eq("P2: confusing for new visitors", p({ category: "confusing", severity: "medium", audience: "new_visitors" }), "P2");
eq("P2: confusing that keeps coming back (two checks), whoever hit it", p({ category: "confusing", severity: "medium", timesSeen: 2 }), "P2");
eq("P2: confusing that keeps coming back stays P2 at three — the streak lifts defects, not confusion", p({ category: "confusing", severity: "medium", timesSeen: 3 }), "P2");
eq("P3: confusing once, for existing users", p({ category: "confusing", severity: "medium", audience: "existing_users" }), "P3");
eq("P3: polish", p({ category: "polish", severity: "low" }), "P3");
eq("P3: polish seen ten times — polish never rises", p({ category: "polish", severity: "low", timesSeen: 10, audience: "existing_users", where: "/checkout" }), "P3");
eq("P3: polish rated critical is still polish", p({ category: "polish", severity: "critical" }), "P3");
eq("a category the scale does not know: by severity alone (critical → P1)", p({ category: "odd", severity: "critical" }), "P1");
eq("…medium → P2", p({ category: "odd", severity: "medium" }), "P2");
eq("…low → P3", p({ category: "odd", severity: "low" }), "P3");
eq("no place at all is not a sensitive place", p({ where: null, audience: "existing_users" }), "P1");
check("the four levels, in order", PRIORITIES.join(",") === "P0,P1,P2,P3" && PRIORITIES.every((x, i) => priorityRank(x) === i));

// Money, sign-in, the user's data — and what is not.
for (const where of ["/checkout", "/cart", "/billing", "/pay", "/payment/confirm", "/account", "/accounts/42", "/settings/profile", "/login", "/sign-in", "/signin", "/auth/callback", "/api/session", "/password/reset", "/subscribe", "/export"]) {
  check(`sensitive: ${where}`, sensitivePlace(where), where);
}
for (const where of ["/payload", "/accountant-jobs", "/authors", "/blog/paying-attention", "/about", "/pricing", "/", "Pricing page → Compare plans"]) {
  check(`not sensitive: ${where}`, !sensitivePlace(where), where);
}
check("the whole sentence counts, not its first path", sensitivePlace("/pricing → /checkout fails") && !sensitivePlace("/checkout-guide → /pricing"));

// ── 2. Who hit it ───────────────────────────────────────────────────────────
const signed = (actions: string | null, status = "ok") => ({ status, actions });
eq("fill: a credential", stepFill('[{"type":"fill","value":"{{TEST_EMAIL}}"}]'), "credential");
eq("fill: a labelled credential", stepFill('[{"fill":"{{TEST_PASSWORD:admin}}"}]'), "credential");
eq("fill: actions, none a credential", stepFill('[{"type":"click"}]'), "none");
eq("fill: no actions recorded", stepFill(null), "unrecorded");
eq("audience: a credential filled before the step → existing users", audienceAt([signed("{{TEST_EMAIL}}"), signed("[]"), signed("[]")], 2), "existing_users");
eq("audience: filled on a skipped step does not count", audienceAt([signed("{{TEST_EMAIL}}", "skipped"), signed("[]")], 1), "new_visitors");
eq("audience: filled after the step does not count", audienceAt([signed("[]"), signed("{{TEST_EMAIL}}")], 0), "new_visitors");
eq("audience: nothing recorded at all → unknown", audienceAt([signed(null), signed(null)], 1), "unknown");
check("one rule over actions and over the one-word fill D1 reduces them to",
  audienceOf([{ status: "ok", fill: "credential" }, { status: "ok", fill: "none" }], 1) === "existing_users" &&
    audienceOf([{ status: "ok", fill: "none" }], 0) === "new_visitors" &&
    audienceOf([{ status: "ok", fill: "unrecorded" }], 0) === "unknown");

// ── 3. One scale on three surfaces ──────────────────────────────────────────
const detail = JSON.stringify({ where: "/checkout → Pay", whatHappened: "The Pay button did nothing.", whyItMatters: "Nobody can pay." });
const anchor = JSON.stringify({ stepRef: { journeyIndex: 0, stepIndex: 1 } });
const finding = { id: "f1", runId: "r1", number: 1, title: "Pay does nothing at the checkout", category: "broken", severity: "high", mark: "none", detail, anchor, signature: null, evidence: [] };
const journeys = [{ title: "Buy", status: "broken", summary: null, carriedFromRunId: null, steps: [
  { order: 0, label: "Sign in", status: "ok", attempted: null, observed: null, unverifiedReason: null, networkLog: null, actions: '[{"fill":"{{TEST_EMAIL}}"}]' },
  { order: 1, label: "Pay", status: "broken", attempted: null, observed: null, unverifiedReason: null, networkLog: null, actions: "[]" },
] }];
const source = { publicId: "p", appSlug: "shop.test", status: "completed", verdict: "broken", bottomLine: null, anatomy: null, deploySha: null, deployEnv: null, startedAt: new Date(), completedAt: new Date(), journeys, findings: [finding] };

eq("the review: broken at the checkout, signed in → P0 from this check alone", buildReview(source, "https://checkmyapp.dev").findings[0].priority, "P0");
eq("the review: the same finding with no anchor knows no audience → P1", reviewPriority({ journeys }, { ...finding, anchor: null }), "P1");
eq("the review: anchored to a journey that recorded no actions → P1", reviewPriority({ journeys: [{ ...journeys[0], steps: journeys[0].steps.map((s) => ({ ...s, actions: null })) }] }, finding), "P1");
check("the review carries the priority beside the severity", /"severity":"high","priority":"P0"/.test(JSON.stringify(buildReview(source, "https://checkmyapp.dev").findings[0])));

const ticket = draftForFinding(finding, { runNumber: 7, publicId: "p", startedAt: new Date("2026-10-04T10:00:00Z"), appSlug: "shop.test" }, null, "https://checkmyapp.dev/verdict/p");
const firstLine = ticket.description.split("\n")[0];
eq("the ticket we file opens with the priority — from the finding alone, who hit it unknown → P1", firstLine, `**Priority:** P1 — ${PRIORITY_META.P1.meaning}`);
const told = draftForFinding({ ...finding, priority: "P0" }, { runNumber: 7, publicId: "p", startedAt: new Date(), appSlug: "shop.test" }, null, "https://checkmyapp.dev/verdict/p");
check("…and says what a caller who knows more tells it", told.description.startsWith("**Priority:** P0 — "));

// Issues: recurrence carries where and who, and three checks in a row lift it.
const run = (runNumber: number, fills: boolean): RecurrenceRun => ({
  runNumber,
  journeys: [{ identity: "buy", carried: false, steps: ["ok", "broken"], ...(fills ? { fills: ["credential", "none"] } : {}) }],
  findings: [{ id: `f${runNumber}`, title: finding.title, category: "broken", severity: "high", mark: "none", detail, anchor, signature: null }],
});
const app = { id: "a", appSlug: "shop.test" };
const once = recurrence(app, [run(1, true)], [])[0];
eq("Issues: the latest sighting's place", once.issue.where, "/checkout → Pay");
eq("Issues: who hit it, from the fills the loader carried", once.issue.audience, "existing_users");
eq("Issues: one sighting, signed in, at the checkout → P0", issuePriorityOf(once.issue), "P0");
const noFills = recurrence(app, [run(1, false)], [])[0];
eq("Issues: without fills the audience is unknown and the row is P1 — the same answer the review gives", `${noFills.issue.audience}/${issuePriorityOf(noFills.issue)}`, "unknown/P1");
const streak = recurrence(app, [run(1, false), run(2, false), run(3, false)], [])[0];
eq("Issues: the same problem three checks in a row → P0, which one check can never say", `${streak.issue.timesSeen}/${issuePriorityOf(streak.issue)}`, "3/P0");

// ── 4. The words ────────────────────────────────────────────────────────────
for (const level of PRIORITIES) {
  const meaning = PRIORITY_META[level].meaning;
  check(`${level}'s line names no machinery and gives no homework`, !MACHINERY_TERMS.test(meaning) && !hasEnvironmentLeak(meaning), meaning);
  check(`${level}'s line is one sentence`, (meaning.match(/[.!?](\s|$)/g) ?? []).length === 1, meaning);
}
check("the ticket's first line names no fix, file or cause (§9)", !/\b(fix|patch|because|cause|src\/|\.tsx?)\b/i.test(firstLine), firstLine);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
