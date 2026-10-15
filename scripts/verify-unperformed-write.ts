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

const broken: ReportedStep = { ...production(), status: "broken", observed: "Adding a country was not performed because the page crashed." };
coerceUnperformedWrite(broken, { writeAllowed: false });
check("a problem step is never softened", broken.status === "broken");

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
