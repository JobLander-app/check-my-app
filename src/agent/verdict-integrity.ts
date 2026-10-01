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
//      verified the gate, not the product, and gets "unverified".
//
//      "Partial with a missing_access skip" is not that evidence on its own:
//      a SaaS walk that reads the landing page and pricing and then meets the
//      sign-in is partial with a missing_access skip too, and it verified
//      real pages. So the rule rests on the machine trail (Step.actions,
//      written by the tools after the browser acted, never by the model): the
//      product redirected our navigations to one gate location, and nothing we
//      did on the product's own host landed anywhere else. Run #281's trail
//      is exactly that — /, /collections/all, /cart and /products/… all
//      ended on /password. No trail, two different redirect targets, or one
//      product page reached, and the rule stands aside.
//
//      A single redirect is not yet a lock: / → /en is a canonical redirect
//      to a public page (review, third round). So the place itself must show
//      it asks for access — we typed into a password or login field there
//      (run #281 filled "Enter store password" on /password three times), or
//      its address names sign-in (/password, /login, auth.example.com). The
//      bottom line calls it a password or sign-in page; this is what earns
//      that sentence.
//   2. "Broken" needs a body. Run #20 called an app broken off eight risky /
//      confusing / polish findings; without a broken/exposed finding or an
//      observed broken/exposed step, it downgrades to "needs attention".
//
// All of them rewrite bottomLine too — a corrected pill over uncorrected prose
// would just move the contradiction one line down.
//
// Pure: no database, no model. The workflow loads the run's journeys, findings
// and target and hands them here, so scripts/verify-verdict-integrity.ts tests
// exactly what runs.

import type { Verdict } from "@/lib/enums";
import type { RecordedAction } from "./tools";

export interface IntegrityStep {
  status: string;
  unverifiedReason: string | null;
  // JSON RecordedAction[] — what the browser actually executed for this step.
  // Optional so rule 1 and rule 2 can be exercised without a trail; absent
  // means rule 1b cannot speak.
  actions?: string | null;
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
  // Appended to the run feed, which the verdict page shows: product language
  // only. What synthesis had said before the correction is ours and goes to
  // the worker log (workflow.ts), never here.
  note: string | null;
}

// ─── Rule 1b: where the trail says the product sent us ──────────────────────

interface Place {
  /** www-folded hostname, so an apex target and a www redirect are one site. */
  site: string;
  /** origin + pathname, trailing slash folded; the query is not a place. */
  key: string;
  /** pathname, trailing slash folded. */
  path: string;
  /** What a reader would call it: the path on the product's own site, host + path elsewhere. */
  display: (productSite: string) => string;
}

function place(raw: unknown): Place | null {
  if (typeof raw !== "string") return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const site = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return {
    site,
    key: `${site}${path}`,
    path,
    display: (productSite) => (site === productSite ? path : `${site}${path}`),
  };
}

// Tolerant like every reader of this column: a malformed trail is no trail.
function trailOf(json: string | null | undefined): RecordedAction[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((a): a is RecordedAction => typeof a === "object" && a !== null && "kind" in a)
      : [];
  } catch {
    return [];
  }
}

// A field that takes a secret or a login name. "Email" is deliberately absent:
// a newsletter box on a public page takes one too.
const CREDENTIAL_FIELD = /\b(?:password|passcode|passphrase|pin|username|user name|log\s?-?in|sign\s?-?in)\b/i;

// A path segment that names sign-in, matched whole so /blog/login-tips is not
// a gate and /en is not one either.
const ACCESS_SEGMENT =
  /^(?:password|login|log-in|log_in|signin|sign-in|sign_in|auth|authenticate|sso|session|sessions|unlock|access)$/i;

// The first label of a host that exists to sign people in.
const ACCESS_HOST = /^(?:auth|login|signin|sso|accounts?|id|identity)\./i;

function namesAccess(gate: Place, targetSite: string): boolean {
  if (gate.path.split("/").some((seg) => ACCESS_SEGMENT.test(seg))) return true;
  return gate.site !== targetSite && ACCESS_HOST.test(gate.site);
}

// The one place the product redirected every walked journey to, shown the way
// the bottom line names it — or null when the trail does not prove a gate.
export function accessGate(walked: IntegrityJourney[], targetUrl: string | null | undefined): string | null {
  const target = place(targetUrl);
  if (!target) return null;

  const redirectedTo = new Map<string, Place>();
  const landings: Place[] = [];
  const credentialFillsAt = new Set<string>();
  for (const j of walked) {
    let landed = 0;
    for (const s of j.steps) {
      for (const a of trailOf(s.actions)) {
        const after = place(a.outcome?.urlAfter);
        if (!after) continue;
        landed++;
        landings.push(after);
        if (a.kind === "fill" && typeof a.label === "string" && CREDENTIAL_FIELD.test(a.label)) {
          credentialFillsAt.add(after.key);
        }
        if (a.kind !== "navigate") continue;
        const asked = place(a.url);
        if (asked && asked.site === target.site && asked.key !== after.key) {
          redirectedTo.set(after.key, after);
        }
      }
    }
    // A journey with no recorded landing tells us nothing about where it
    // stopped, so it cannot be counted as stopped at the gate.
    if (landed === 0) return null;
  }

  if (redirectedTo.size !== 1) return null;
  const [gate] = redirectedTo.values();
  if (!credentialFillsAt.has(gate.key) && !namesAccess(gate, target.site)) return null;
  // The product lives on the target's site AND on whatever site it sent us
  // to: example.com redirecting to app.example.com is the product moving
  // house, not a gate, and every page we then reached on app.example.com is
  // coverage (review of the first version of this rule). On either site the
  // gate is the only place we may have been. Landings on any other site are
  // the sign-in provider's later pages or an outbound link — not the product.
  const productSites = new Set([target.site, gate.site]);
  for (const p of landings) if (productSites.has(p.site) && p.key !== gate.key) return null;
  return gate.display(target.site);
}

export function judgeVerdictIntegrity(
  journeys: IntegrityJourney[],
  findings: IntegrityFinding[],
  synth: { verdict: Verdict; bottomLine: string | null },
  targetUrl?: string | null,
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
      note: "Zero journeys walked — recorded as Not verified",
    };
  }

  // Only a passing verdict is corrected: needs_attention or broken already
  // tells the owner not to relax, and a finding is evidence we saw something.
  // Every skip must be missing_access — access is theirs to grant, so the ask
  // is allowed (CLAUDE.md rule 2). A journey that also stopped on
  // our_capability or not_applicable did not stop only at the gate, and a
  // password would not have finished it.
  const passing = synth.verdict === "all_good" || synth.verdict === "mostly_ok";
  const stoppedOnlyForAccess =
    findings.length === 0 &&
    walked.every((j) => {
      const skipped = j.steps.filter((s) => s.status === "skipped");
      return (
        j.status === "partial" &&
        skipped.length > 0 &&
        skipped.every((s) => s.unverifiedReason === "missing_access")
      );
    });
  const gate = passing && stoppedOnlyForAccess ? accessGate(walked, targetUrl) : null;
  if (gate) {
    return {
      verdict: "unverified",
      bottomLine:
        `We couldn't get past the access gate this run — every journey ended at the same password ` +
        `or sign-in page (${gate}), so read this as no coverage of what is behind it, not a clean ` +
        "bill of health. A password or a test login for it is what would let us check the rest." +
        (synth.bottomLine ? ` What we saw from the outside: ${synth.bottomLine}` : ""),
      note: `Every journey stopped at the same sign-in page (${gate}) — recorded as Not verified`,
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
