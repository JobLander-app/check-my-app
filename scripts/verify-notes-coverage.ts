// CHE-476: the places the owner's notes name are counted as coverage.
//
// Run #387 (checkmyapp.dev, 2026-10-13) was given notes naming three things —
// the Issue tracker card on an app's settings → Integrations, the tracker card
// on the app's own page, and the tracker answer on /faq. It never opened
// settings → Integrations or /faq, and its coverage line named nine old
// verdict pages that discovery had mapped instead. The verdict read as if the
// change had been checked.
//
// What this holds, over the real coverage helpers and buildReview:
//   1. "/faq" and "settings → Integrations" in the notes are places to look for;
//   2. a place the notes name that a step reached is not listed;
//   3. a place the notes name that no step reached is said first, in the
//      bottom line's coverage sentence and in review.coverage.pages_not_opened,
//      ahead of the pages discovery mapped, and even when discovery mapped none;
//   4. a path in a clause that forbids it ("don't touch /admin"), a URL's own
//      path, and scope hints are never an ask;
//   5. notes that name no place add nothing — the sentence is what it was.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-notes-coverage.ts

import { coverageSentence, notePaths, unreachedAsked, unreachedPages } from "@/lib/coverage";
import { buildReview, type ReviewSource } from "@/lib/review";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const NOTES =
  "Check the Issue tracker card on an app's settings → Integrations, the tracker card on the app's own page, " +
  "and the tracker answer on /faq.";
const paths = (n: string) => notePaths(n).map((p) => p.path);

check("notes name /faq and settings → Integrations", JSON.stringify(paths(NOTES)) === JSON.stringify(["/faq", "/settings/integrations"]), JSON.stringify(paths(NOTES)));
check("backticks, parentheses, trailing punctuation", JSON.stringify(paths("Open `/roles` (and /ru/about). Then /pricing.")) === JSON.stringify(["/roles", "/ru/about", "/pricing"]), JSON.stringify(paths("Open `/roles` (and /ru/about). Then /pricing.")));
check("a forbidden path is not an ask", paths("Don't touch /admin. Check /faq.").join() === "/faq", paths("Don't touch /admin. Check /faq.").join());
check("a URL's own path and words with a slash are not asks", paths("see https://example.com/faq and/or 10/13 user@x.com/y").length === 0, paths("see https://example.com/faq and/or 10/13").join());
check("no notes, no asks", paths("").length === 0 && notePaths(null).length === 0);

const walked = ["GET https://checkmyapp.dev/health/apps/a1/settings/integrations 200"];
check("a reached place is not listed", unreachedAsked(NOTES, walked).map((p) => p.path).join() === "/faq", unreachedAsked(NOTES, walked).map((p) => p.path).join());

const mapped = ["Old verdict (`/verdict/cmusv2ctt0003sa0nrln3804k`)", "Pricing (`/pricing`)"];
const evidence = ["GET https://checkmyapp.dev/pricing 200"];
const sentence = coverageSentence(unreachedPages(mapped, evidence), mapped.length, unreachedAsked(NOTES, evidence));
check(
  "the asked-for places are said first, then the mapped ones",
  sentence !== null &&
    sentence.startsWith("Asked for in your notes and not opened this run: /faq, /settings/integrations") &&
    sentence.includes("Not opened this run: /verdict/cmusv2ctt0003sa0nrln3804k"),
  sentence ?? "null",
);
check(
  "with no mapped pages the asked-for places are still said",
  (coverageSentence([], 0, unreachedAsked(NOTES, evidence)) ?? "").startsWith("Asked for in your notes"),
);
check("notes naming nothing leave the sentence as it was", coverageSentence(unreachedPages(mapped, evidence), mapped.length, unreachedAsked("Be gentle with the test account.", evidence)) === "Not opened this run: /verdict/cmusv2ctt0003sa0nrln3804k — so nothing here speaks to it.");
check("nothing unreached, nothing said", coverageSentence([], 2, []) === null);

const source: ReviewSource = {
  publicId: "notes-fixture",
  appSlug: "checkmyapp.dev",
  status: "completed",
  verdict: "mostly_ok",
  bottomLine: null,
  anatomy: JSON.stringify({ pages: mapped }),
  userNotes: NOTES,
  deploySha: null,
  deployEnv: null,
  startedAt: new Date("2026-10-13T14:52:00Z"),
  completedAt: new Date("2026-10-13T15:11:00Z"),
  journeys: [
    { title: "Pricing", status: "works", summary: null, steps: [{ order: 1, label: "Open pricing", status: "works", attempted: "Open", observed: "Pricing page", unverifiedReason: null, networkLog: evidence[0] }] },
  ],
  findings: [],
};
const review = buildReview(source, "https://checkmyapp.dev");
check(
  "review.coverage lists the asked-for places before the mapped ones",
  JSON.stringify(review.coverage.pages_not_opened) === JSON.stringify(["/faq", "/settings/integrations", "/verdict/cmusv2ctt0003sa0nrln3804k"]),
  JSON.stringify(review.coverage.pages_not_opened),
);
check("without notes the review is as before", JSON.stringify(buildReview({ ...source, userNotes: null }, "https://checkmyapp.dev").coverage.pages_not_opened) === JSON.stringify(["/verdict/cmusv2ctt0003sa0nrln3804k"]));

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
