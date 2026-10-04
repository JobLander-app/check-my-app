// CHE-286 verification: a grant too narrow to answer says so.
//
// `PostHogIntegration.scope` records exactly what the consent screen returned.
// Nothing read that column. A grant missing `query:read` refuses every funnel
// query, for ever — and the verdict page said:
//
//   "No completion rate for this one yet — it will appear after the next check."
//
// It will not. Waiting is precisely what does not help, and the one person who
// could fix it was told to wait.
//
// This is the fifth instance in one day of the same shape — a fact the database
// holds that no code consults. The others: `funnelDriftAt` (CHE-281),
// `missing_access` on a skipped step (CHE-283), the rise sentence composed then
// dropped (CHE-284), and `JourneyMetricPoint.steps` before CHE-279.
//
// Two rules, and the second is the one that is easy to get wrong:
//
//   1. a narrowing is SAID, on both surfaces, naming what is missing and what
//      granting it changes;
//   2. SILENCE IS NOT A NARROWING. An empty or absent scope string means the
//      provider told us nothing, not that nothing was granted. Inventing a
//      warning from silence would be the same defect pointed the other way —
//      a confident screen that is wrong.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-narrowed-grant.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POSTHOG_SCOPES, SCOPE_REQUIRED_TO_MEASURE, canMeasure, missingScopes } from "@/lib/posthog/oauth";
import { noMeasurementLine } from "@/lib/journey-numbers";
import { hasHomework, hasNarration } from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

/** What production actually holds today. */
const FULL = "insight:read organization:read project:read query:read";

console.log("\n— silence is not a narrowing —\n");

check("no scope recorded is not evidence of anything", missingScopes(null).length === 0);
check("…nor is an empty string", missingScopes("").length === 0);
check("…nor whitespace", missingScopes("   ").length === 0);
check("…and none of those blocks measuring", canMeasure(null) && canMeasure(""));

console.log("\n— the real grant is complete —\n");

check("today's production scope is missing nothing",
  missingScopes(FULL).length === 0, missingScopes(FULL).join(" "));
check("…and can measure", canMeasure(FULL));

console.log("\n— a narrowed grant is detected —\n");

{
  const withoutQuery = "project:read organization:read insight:read";
  check("dropping query:read is noticed",
    missingScopes(withoutQuery).includes(SCOPE_REQUIRED_TO_MEASURE),
    missingScopes(withoutQuery).join(" "));
  check("…and it stops measurement", !canMeasure(withoutQuery));

  const withoutOrg = "project:read query:read insight:read";
  check("dropping organization:read is noticed",
    missingScopes(withoutOrg).includes("organization:read"));
  check("…but does NOT stop measurement — the consequence is cosmetic",
    canMeasure(withoutOrg),
    "conflating the two would refuse to measure a connection that can measure");

  check("every scope we ask for is checked", missingScopes("").length === 0 && POSTHOG_SCOPES.length === 4);
  check("a grant of nothing at all is fully missing",
    missingScopes("something:else").length === POSTHOG_SCOPES.length,
    missingScopes("something:else").join(" "));
}

console.log("\n— the sentence is its own, and never says 'yet' —\n");

{
  const s = noMeasurementLine("access_narrowed");
  const notYet = noMeasurementLine("not_measured_yet");

  check("it is a different sentence from 'not measured yet'", s !== notYet);
  check("…and never promises a number is coming",
    !/\byet\b|after the next check/i.test(s), s);
  check("it names what is missing in the owner's terms",
    /run queries/i.test(s), s);
  check("…and what changes when it is granted",
    /the next check will count it/i.test(s), s);
  check("it does not claim anything about their traffic",
    !/traffic|too few|nobody/i.test(s), s);
  check("no homework", !hasHomework(s), s);
  check("no narration", !hasNarration(s), s);
}

console.log("\n— both surfaces say it —\n");

{
  const load = readFileSync(join(import.meta.dirname, "..", "src/lib/journey-numbers-load.ts"), "utf8");
  const card = readFileSync(join(import.meta.dirname, "..", "src/components/analytics-connection.tsx"), "utf8");
  // CHE-351: the team's analytics connection is on Integrations now.
  const page = readFileSync(join(import.meta.dirname, "..", "src/app/(app)/settings/integrations/page.tsx"), "utf8");

  check("the verdict page reads the granted scope", /scope: true/.test(load));
  check("…and ranks the narrowing above the other absences",
    /narrowed\s*\n?\s*\? "access_narrowed"/.test(load) || /narrowed$/m.test(load),
    "it is the only permanent one and the only one the owner can fix");
  check("Integrations reads it too", /missingScopes\(row\.scope\)/.test(page));
  check("…and drops the unqualified tick",
    /stranded \|\| narrowed \? "!" : "✓"/.test(card),
    "a ✓ over a connection that can never answer is CHE-269 again");
  check("…and names the missing permissions", /missingScopes\?\.join/.test(card));
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
