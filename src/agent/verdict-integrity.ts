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
//
//      Run #282 (same store, the live check of the version above) slipped
//      past every precondition that was NOT the trail. Synthesis said
//      needs_attention, not all_good — with zero findings, so the yellow pill
//      rested on nothing but the lock. One journey was `risky` because its
//      risky step sat on Shopify's own sign-in page, off the product. One skip
//      was `not_applicable` (checkout, unreachable behind the lock). And
//      /admin redirected to accounts.shopify.com, a second gate beside
//      /password. Its trail was as clear as #281's: every product page we
//      asked for ended at a sign-in. So the trail is now the precondition and
//      the rest is dropped — any synthesized verdict, any journey status, any
//      mix of skip reasons, as long as there are no findings and some skip is
//      missing_access (that is what makes asking for a password honest,
//      CLAUDE.md rule 2). Every redirect target must ask for access, and a
//      sign-in provider's own host is not the product, so its later pages do
//      not count as product reached. "needs_attention requires a finding" is
//      NOT the rule: runs #272, #266 and #229 are honest needs_attention with
//      no findings of their own (re-checks carrying earlier findings), and
//      their trails reach real pages.
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

// The last two labels of a host. Not a public-suffix lookup: under a suffix
// like co.uk (or myshopify.com) it treats unrelated hosts as one owner, which
// only makes the rule below count more pages as the product and fire less
// often — the safe direction for a rule that withdraws a verdict.
function owner(site: string): string {
  return site.split(".").slice(-2).join(".");
}

function accessPath(p: Place): boolean {
  return p.path.split("/").some((seg) => ACCESS_SEGMENT.test(seg));
}

function namesAccess(gate: Place, targetSite: string): boolean {
  return accessPath(gate) || (gate.site !== targetSite && ACCESS_HOST.test(gate.site));
}

// The places the product redirected us to, shown the way the bottom line names
// them (the target's own gate first) — or null when the trail does not prove
// that every product page we asked for ended at a sign-in.
export function accessGate(journeys: IntegrityJourney[], targetUrl: string | null | undefined): string | null {
  const target = place(targetUrl);
  if (!target) return null;

  const redirectedTo = new Map<string, Place>();
  const landings: Place[] = [];
  const credentialFillsAt = new Set<string>();
  // Skipped journeys are read too: a page a skipped journey reached is still
  // a page reached. Only walked ones must show where they stopped.
  for (const j of journeys) {
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
    // A walked journey with no recorded landing tells us nothing about where
    // it stopped — a carried-forward journey from an earlier run is the usual
    // one — so it cannot be counted as stopped at the gate.
    if (j.status !== "skipped" && landed === 0) return null;
  }

  if (redirectedTo.size === 0) return null;
  const gates = [...redirectedTo.values()];
  // Every place the product sent us must ask for access. One redirect to a
  // page that asks for nothing (/en, /maintenance) means a page reached.
  if (gates.some((g) => !credentialFillsAt.has(g.key) && !namesAccess(g, target.site))) return null;

  // Was this landing a page of the product? Decided per landing, not per
  // host, because review found a hole in every per-host version:
  //   - a gate, or any page whose path names sign-in (/login, /u/login,
  //     /account/login), is the lock, not the product — wherever it is;
  //   - a host with the target's owner is the product: the target itself,
  //     its own id.example.com sign-in (review of this rule, round 1) and a
  //     sibling it never redirected to, docs.example.com (round 2);
  //   - a host the product REDIRECTED us to, with another owner, is the
  //     product moved house (brand.com → brandapp.io) unless it is a sign-in
  //     provider: its name says so (accounts.shopify.com, run #282's admin
  //     login) — or, for a tenant-named one like tenant.auth0.com (round
  //     2), its pages name sign-in, which the first case already caught;
  //   - any other host is an outbound link, not the product.
  const gateKeys = new Set(gates.map((g) => g.key));
  const gateSites = new Set(gates.map((g) => g.site));
  const targetOwner = owner(target.site);
  const reachedProduct = (p: Place): boolean => {
    if (gateKeys.has(p.key) || accessPath(p)) return false;
    if (owner(p.site) === targetOwner) return true;
    if (gateSites.has(p.site)) return !ACCESS_HOST.test(p.site);
    return false;
  };
  if (landings.some(reachedProduct)) return null;

  return gates
    .sort((a, b) => Number(b.site === target.site) - Number(a.site === target.site))
    .map((g) => g.display(target.site))
    .join(", ");
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

  // A finding is evidence we saw something behind or beside the gate, so the
  // rule needs none. Whatever synthesis called it — all_good, mostly_ok,
  // needs_attention or broken — a verdict over a run that reached only the
  // lock is not about the product (run #282). Placed before rule 2 so a
  // body-less "broken" over a lock reads Not verified, not Needs attention.
  const askedForAccess = journeys.some((j) =>
    j.steps.some((s) => s.status === "skipped" && s.unverifiedReason === "missing_access"),
  );
  const gate = findings.length === 0 && askedForAccess ? accessGate(journeys, targetUrl) : null;
  if (gate) {
    return {
      verdict: "unverified",
      bottomLine:
        `We couldn't get past the access gate this run — every page of the product we asked for led ` +
        `to a password or sign-in page (${gate}), so read this as no coverage of what is behind it, ` +
        "not a clean bill of health. A password or a test login for it is what would let us check the rest." +
        (synth.bottomLine ? ` What we saw from the outside: ${synth.bottomLine}` : ""),
      note: `Every page we asked for led to a sign-in page (${gate}) — recorded as Not verified`,
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
