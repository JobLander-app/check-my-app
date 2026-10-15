// Pilot feedback on checkmyapp.dev finding #001 (run #387, 2026-10-13): the
// finding's "why this matters" read "Worth strengthening the crawler's journey
// inference (e.g. seeding from sitemap, nav links, or letting owners pin
// critical journeys) so each check covers meaningful paths, not a placeholder."
// The member: "A finding names the symptom and how to know it is gone, never
// the fix." CLAUDE.md rule 9. The prompt asked for a recommendation and nothing
// downstream looked at what the model recommended.
//
// Pure: no browser, no network, no model, no database. Runs the exact function
// synthesis runs on every finding (cleanFindingLanguage).
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-no-fix-in-finding.ts

import { cleanFindingLanguage, type SynthesizedFinding } from "@/agent/synthesis";
import { hasPrescription, stripPrescription } from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const CONSEQUENCE =
  "Since your core value is catching what real users hit, placeholder/thin discovery undermines trust in the verdict.";
const FIX =
  "Worth strengthening the crawler's journey inference (e.g. seeding from sitemap, nav links, or letting owners pin critical journeys) so each check covers meaningful paths, not a placeholder.";

const finding = (whyItMatters: string): SynthesizedFinding => ({
  title: "Discovery surfaced only placeholder journeys",
  category: "risky",
  severity: "medium",
  detail: { where: "Check detail", whatHappened: "Discovery returned two journeys.", whyItMatters },
});

// ─── The ticket's own finding ─────────────────────────────────────────────────
const cleaned = cleanFindingLanguage(finding(`${CONSEQUENCE} ${FIX}`));
check("the finding is kept", cleaned !== null);
check("the consequence stays as written", cleaned?.detail.whyItMatters === CONSEQUENCE, cleaned?.detail.whyItMatters);
check(
  "nothing of the fix is left — not even the half after \"e.g.\"",
  !/sitemap|seeding|strengthen|pin critical/i.test(cleaned?.detail.whyItMatters ?? ""),
);

// A why-this-matters that was only the fix is left out, not replaced by a sentence.
const only = cleanFindingLanguage(finding(FIX));
check("a finding whose why-it-matters was only the fix is kept without one", only !== null && only.detail.whyItMatters === undefined);

// ─── The family: each is a sentence that tells the builder what to do ─────────
const FIXES = [
  FIX,
  "Consider switching to a server-side session store.",
  "You should add retries to the importer.",
  "The team should implement rate limiting on the form.",
  "It would be better to replace the carousel with a static list.",
  "Recommended: debounce the search box.",
  "Add a loading state to the button.",
  "Users lose their draft — add autosave.",
  "The cart empties on refresh; fix the session handling.",
  "Try using a longer timeout.",
];
for (const s of FIXES) check(`prescription: ${s.slice(0, 60)}`, hasPrescription(s));

// The head of a sentence that carries both is kept; the clause that designs the fix goes.
check(
  "consequence before a dash stays, the clause after it goes",
  stripPrescription("Visitors who refresh lose their cart — consider switching to a server-side session store.") ===
    "Visitors who refresh lose their cart.",
);
check(
  "consequence before a semicolon stays",
  stripPrescription("Visitors who refresh lose their cart; fix the session handling.") === "Visitors who refresh lose their cart.",
);

// Codex, #346: the fixes our own verdicts already published
// (scripts/fixtures/che-354-meetbashar.json, findings 1, 2 and 2 of the later run).
const PUBLISHED = [
  {
    text: "The source citation is the credibility of this whole product; swap 4EjTHkgOgG8 for a live upload of the same talk (or hide the two entries) so the \"watch the source\" promise holds.",
    kept: "The source citation is the credibility of this whole product.",
  },
  {
    text: "These quotes are the proof that the answer is grounded; double-decode the excerpt text before rendering so readers see clean, quotable sentences.",
    kept: "These quotes are the proof that the answer is grounded.",
  },
  {
    text: "Citations are the trust mechanism of the whole product; a dead source makes the grounded answer look fabricated. Run a validation pass over the citation corpus to flag or drop video IDs that no longer resolve before they're served in answers.",
    kept: "Citations are the trust mechanism of the whole product; a dead source makes the grounded answer look fabricated.",
  },
  {
    text: "Because the whole product's credibility rests on 'every claim is watchable,' a visible dead source undermines trust — swap 4EjTHkgOgG8 for the correct clip (or remove both references).",
    kept: "Because the whole product's credibility rests on 'every claim is watchable,' a visible dead source undermines trust.",
  },
];
for (const { text, kept } of PUBLISHED) {
  const out = stripPrescription(text);
  check(`published fix is cut, consequence kept: ${kept.slice(0, 50)}`, hasPrescription(text) && out === kept, String(out));
}

// ─── What a user expects, and the product's own words, are not fixes ──────────
const NOT_FIXES = [
  CONSEQUENCE,
  "A visitor should see a confirmation after paying.",
  "Users should be able to add an item to the cart.",
  "Visitors could not add the item and the page stayed silent.",
  "The Add to cart button does nothing on the product page.",
  "Customers who cannot reach the dashboard stop trusting the verdict.",
  "The page needs a visible error when the payment is declined.",
  "Use of the coupon field is blocked for signed-out visitors.",
  // "Run" as our own noun is not an order.
  "Run #387 found the same dead link on both guides.",
  "Run 380 walked twelve journeys and all of them worked.",
  // Nor a word that only opens like a fix: a hyphenated noun, a noun, a label.
  "Drop-down menus close as soon as the page scrolls.",
  "Redirect loops send signed-in visitors back to the login page.",
  "Enable notifications toggle does nothing when pressed.",
];
for (const s of NOT_FIXES) check(`kept: ${s.slice(0, 60)}`, !hasPrescription(s) && stripPrescription(s) === s);

// A finding with nothing to cut comes back untouched.
const clean = finding(CONSEQUENCE);
check("a clean finding is unchanged", JSON.stringify(cleanFindingLanguage(clean)) === JSON.stringify(clean));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
