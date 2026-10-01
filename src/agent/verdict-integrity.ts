// ─── Verdict integrity (CHE-42) ──────────────────────────────────────────────
// Rules the synthesis prompt asks for and this code then enforces, because a
// prompt is a request and a verdict is a promise:
//
//   1. Zero coverage is never a pass. Run #19 walked nothing and still shipped
//      "all good" — a run that verified nothing gets "unverified", full stop.
//  1b. Walking only the gate is zero coverage too (CHE-365). Run #281 checked a
//      password-protected Shopify store with no store password: every path
//      redirected to /password, all three journeys ended partial with every
//      skip recorded missing_access, zero findings — and it shipped "all
//      good" under a bottom line that itself said the storefront was
//      unverified. Rule 1 counted three walked journeys and stood aside,
//      though all three had walked the same locked door. When every walked
//      journey stopped at an access gate and nothing was found, the run
//      verified the gate, not the product, and gets "unverified". A run where
//      at least one journey finished ok verified something real and is left
//      alone.
//   2. "Broken" needs a body. Run #20 called an app broken off eight risky /
//      confusing / polish findings; without a broken/exposed finding or an
//      observed broken/exposed step, it downgrades to "needs attention".
//
// All of them rewrite bottomLine too — a corrected pill over uncorrected prose would
// just move the contradiction one line down.
//
// Pure: no database, no model. The workflow loads the run's journeys and
// findings and hands them here, so scripts/verify-verdict-integrity.ts tests
// exactly what runs.

import type { Verdict } from "@/lib/enums";

export interface IntegrityStep {
  status: string;
  unverifiedReason: string | null;
}

export interface IntegrityJourney {
  status: string;
  steps: IntegrityStep[];
}

export interface IntegrityFinding {
  category: string;
  severity: string;
}

export interface IntegrityResult {
  verdict: Verdict;
  bottomLine: string | null;
  note: string | null;
}

export function judgeVerdictIntegrity(
  journeys: IntegrityJourney[],
  findings: IntegrityFinding[],
  synth: { verdict: Verdict; bottomLine: string | null },
): IntegrityResult {
  const walked = journeys.filter((j) => j.status !== "skipped");
  if (walked.length === 0) {
    // The model wrote its bottom line believing its verdict would stand, so it
    // is demoted to an outside observation rather than dropped or left to
    // contradict the coverage sentence.
    return {
      verdict: "unverified",
      bottomLine:
        "We couldn't verify anything this run — no user journey was walked, so read this as " +
        "zero coverage, not a clean bill of health." +
        (synth.bottomLine ? ` What we saw from the outside: ${synth.bottomLine}` : ""),
      note: `Zero journeys walked — verdict recorded as Not verified, not ${synth.verdict}`,
    };
  }

  // Only a passing verdict is corrected: needs_attention or broken already
  // tells the owner not to relax, and a finding is evidence we saw something.
  // The skip must be missing_access — access is theirs to grant, so the ask
  // is allowed (CLAUDE.md rule 2); our_capability is our own ticket and not
  // what this sentence describes.
  const passing = synth.verdict === "all_good" || synth.verdict === "mostly_ok";
  const gatedOnly =
    findings.length === 0 &&
    walked.every(
      (j) =>
        j.status === "partial" &&
        j.steps.some((s) => s.status === "skipped" && s.unverifiedReason === "missing_access"),
    );
  if (passing && gatedOnly) {
    return {
      verdict: "unverified",
      bottomLine:
        "We couldn't get past the access gate this run — every journey stopped at a password or " +
        "sign-in we had no access to, so read this as no coverage of what is behind it, not a clean " +
        "bill of health. A password or a test login for it is what would let us check the rest." +
        (synth.bottomLine ? ` What we saw from the outside: ${synth.bottomLine}` : ""),
      note: `Every journey stopped at an access gate — verdict recorded as Not verified, not ${synth.verdict}`,
    };
  }

  // Findings are the adjudicated evidence (synthesis re-reads every step with
  // full context); step labels alone don't qualify — run #28's background
  // analytics 401 was step-labeled broken while every user journey worked.
  // Security exposures need HIGH severity to carry a broken verdict (run #29's
  // by-design medium exposure painted a working product broken).
  if (synth.verdict === "broken") {
    const evidence = findings.some(
      (f) => f.category === "broken" || (f.category === "exposed" && f.severity === "high"),
    );
    if (!evidence) {
      return {
        verdict: "needs_attention",
        bottomLine:
          sentence(synth.bottomLine ?? "Nothing we walked failed outright") +
          " Downgraded from Broken: no direct breakage evidence was captured.",
        note: "Verdict downgraded from Broken — nothing we observed actually broke",
      };
    }
  }
  return { verdict: synth.verdict, bottomLine: synth.bottomLine, note: null };
}

// Close a model-written line so a clause can be appended after it.
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
