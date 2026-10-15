// CHE-480 verification: a step named for adding or creating that was not carried
// out is not "ok".
//
// Pilot feedback on Securify's "Use the Add country search field": the step was
// ok, its own observed text said "adding a country was deliberately not
// performed", and the journey read "Everything … works". The member answered
// "It was not really checked". The step is now written skipped/not_applicable in
// a run that may not create, so the journey rolls up to "partly verified".
//
// Pure: the real coerceUnperformedWrite, no browser, no model, no database.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-unperformed-write.ts

import { coerceUnperformedWrite, type ReportedStep } from "@/agent/tools";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// The production step, verbatim (run #324, journey "Block or Allow Countries").
function production(): ReportedStep {
  return {
    label: "Use the Add country search field",
    status: "ok",
    attempted:
      'Typed "Ger" into the "Add country" search field (placeholder "Search and add country") to confirm it accepts input and looks up countries.',
    observed:
      'The field accepted input and opened a "Countries" suggestion dropdown showing matching entries (Germany (DE) highlighted, Algeria (DZ), Niger (NE), Nigeria (NG)). Clearing the field restored the empty state. The lookup works; adding a country was deliberately not performed.',
  };
}

const readOnly = production();
coerceUnperformedWrite(readOnly, { writeAllowed: false });
check("read-only: the step that did not add is skipped", readOnly.status === "skipped", readOnly.status);
check("read-only: it is not_applicable, not a gap of ours", readOnly.unverifiedReason === "not_applicable", String(readOnly.unverifiedReason));
check("read-only: what was seen stays in the step", readOnly.observed.includes("suggestion dropdown"));

const allowed = production();
coerceUnperformedWrite(allowed, { writeAllowed: true });
check("a run that may create is left alone", allowed.status === "ok");

const performed = production();
performed.observed = "Germany was added and appears in the Current Restrictions list and on the map.";
coerceUnperformedWrite(performed, { writeAllowed: false });
check("a step that says nothing of not adding stays ok", performed.status === "ok");

const search: ReportedStep = {
  label: "Search the restrictions list",
  status: "ok",
  attempted: "Typed Canada into the list filter.",
  observed: "The list narrowed to one row; nothing was submitted.",
};
coerceUnperformedWrite(search, { writeAllowed: false });
check("a step that names no add/create act stays ok", search.status === "ok");

const duplicates = production();
duplicates.observed = "The field accepts input and the list does not add duplicate rows.";
coerceUnperformedWrite(duplicates, { writeAllowed: false });
check("'does not add' about the product is not 'we did not add'", duplicates.status === "ok");

// Codex, #354: the "not carried out" must be said of the act the step names.
const review: ReportedStep = {
  label: "Review order details",
  status: "ok",
  attempted: "Opened the order summary to check the totals.",
  observed: "The totals were correct; payment was not submitted.",
};
coerceUnperformedWrite(review, { writeAllowed: false });
check("a review whose label names an order stays ok when something else was not submitted", review.status === "ok", review.status);

const unplaced: ReportedStep = { ...review, label: "Place the order", observed: "The summary was correct. The order was deliberately not placed." };
coerceUnperformedWrite(unplaced, { writeAllowed: false });
check("…and is skipped when the order it names was the act not carried out", unplaced.status === "skipped", unplaced.status);

const otherSentence = production();
otherSentence.observed = "Adding works from the dropdown. The export was not performed.";
coerceUnperformedWrite(otherSentence, { writeAllowed: false });
check("the named act and the 'not carried out' must share a sentence", otherSentence.status === "ok", otherSentence.status);

// Codex, #354 round 2: passive wording of every named write is recognised…
for (const [label, observed] of [
  ["Place the order", "The summary was correct. The order was not placed."],
  ["Send invitation", "The form validated the address. The invitation was not sent."],
  ["Sign up", "The form accepted the details. Signing up was not performed."],
]) {
  const s: ReportedStep = { label, status: "ok", attempted: `Filled the form for: ${label}.`, observed };
  coerceUnperformedWrite(s, { writeAllowed: false });
  check(`passive "${observed.split(". ").at(-1)}" under "${label}" is skipped`, s.status === "skipped", s.status);
}
// …and a negative on the way to a write that did happen is not "not carried out".
for (const [label, observed] of [
  ["Save settings", "The invalid draft was not saved; after correction, the settings were saved successfully."],
  ["Add country", "The country was not added until the code was fixed, after which it was added."],
]) {
  const s: ReportedStep = { label, status: "ok", attempted: `${label}.`, observed };
  coerceUnperformedWrite(s, { writeAllowed: false });
  check(`"${label}" that ended performed stays ok`, s.status === "ok", s.status);
}

// Codex, #354 round 3: the negation must fall on the named act itself, an
// active refusal of any write counts, and only the refused act's own success
// cancels its refusal.
const totals: ReportedStep = { ...review, observed: "The order totals were correct and payment was not submitted." };
coerceUnperformedWrite(totals, { writeAllowed: false });
check("an order named in a sentence whose negation is about payment stays ok", totals.status === "ok", totals.status);
const activeSend: ReportedStep = { label: "Send invitation", status: "ok", attempted: "Filled the invite form.", observed: "The address was valid, but I did not send the invitation." };
coerceUnperformedWrite(activeSend, { writeAllowed: false });
check("an active refusal ('did not send') of a named write is skipped", activeSend.status === "skipped", activeSend.status);
const twoActs: ReportedStep = { label: "Create account and send invitation", status: "ok", attempted: "Created the account, then opened the invite form.", observed: "The account was created successfully. The invitation was not sent." };
coerceUnperformedWrite(twoActs, { writeAllowed: false });
check("one act done does not cancel another act refused", twoActs.status === "skipped", twoActs.status);

const broken: ReportedStep = { ...production(), status: "broken", observed: "Adding a country was not performed because the page crashed." };
coerceUnperformedWrite(broken, { writeAllowed: false });
check("a problem step is never softened", broken.status === "broken");

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
