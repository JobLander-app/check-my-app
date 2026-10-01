// CHE-365 verification: a run that only reached the access gate in front of
// the product is not a pass.
//
// Run #281 (securify-demo.myshopify.com, publicId cmupqeqwg0003qx1tauyntveh)
// checked a password-protected Shopify store with no store password. Every
// storefront path redirected to /password. All three journeys ended `partial`,
// every skipped step was `missing_access`, there were zero findings — and the
// verdict was `all_good`, under a bottom line that itself said the storefront
// was unverified. The zero-coverage rule (CHE-42) only fired when no journey
// was walked at all; here three were, all of them on the gate.
//
// The fixture below is that run's journeys and steps as stored in production
// D1 (status and unverifiedReason per step; labels kept for the reader), and
// its synthesized bottom line verbatim.
//
// Pure: no database, no model. Every case is the exact shape the workflow
// hands judgeVerdictIntegrity.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-verdict-integrity.ts

import {
  judgeVerdictIntegrity,
  type IntegrityFinding,
  type IntegrityJourney,
} from "@/agent/verdict-integrity";
import { hasEnvironmentLeak, hasHomework, hasNarration } from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

type Labelled = IntegrityJourney & { title: string; steps: Array<IntegrityJourney["steps"][number] & { label: string }> };

const ok = (label: string) => ({ label, status: "ok", unverifiedReason: null });
const gated = (label: string) => ({ label, status: "skipped", unverifiedReason: "missing_access" });

// ─── Run #281, as recorded ────────────────────────────────────────────────────

const RUN_281: Labelled[] = [
  {
    title: "Enter store via password gate",
    status: "partial",
    steps: [ok("Navigate to store"), ok("Land on password gate"), gated("Enter store password")],
  },
  {
    title: "Navigate to Shopify admin login",
    status: "partial",
    steps: [
      ok("Load the password gate page at /password"),
      ok("Click the 'Log in here' link pointing to /admin"),
      ok("Redirect to admin.shopify.com"),
      gated("Sign in to the Shopify admin (expected 403 / no credentials)"),
      gated("Open the storefront as a shopper (home, product, cart)"),
    ],
  },
  {
    title: "Submit password via form with hidden fields",
    status: "partial",
    steps: [
      ok("Load the /password page"),
      ok("Inspect the password form fields"),
      ok("Type into the store password field"),
      gated('Click the "Enter" submit button'),
      gated("Confirm the submission POST carries the hidden field"),
      ok("Browse the storefront as a shopper (home, product, cart)"),
    ],
  },
];

const RUN_281_BOTTOM_LINE =
  "Nothing broke in what we could reach: the password gate renders cleanly and the owner 'Log in here' " +
  "link follows the full redirect chain into Shopify's account login without a single dead end. But the " +
  "store is fully locked and we had no store password or admin credentials, so everything behind the " +
  "gate — the storefront, cart, and the Securify experience itself — is unverified this run; to check " +
  "it, add a store password and a test admin account.";

console.log("\n— run #281: every journey stopped at the access gate —\n");

for (const verdict of ["all_good", "mostly_ok"] as const) {
  const out = judgeVerdictIntegrity(RUN_281, [], { verdict, bottomLine: RUN_281_BOTTOM_LINE });
  check(`synth ${verdict} → unverified`, out.verdict === "unverified", out.verdict);
  check(`synth ${verdict} → a note is recorded`, !!out.note, out.note ?? "(none)");
}

{
  const out = judgeVerdictIntegrity(RUN_281, [], { verdict: "all_good", bottomLine: RUN_281_BOTTOM_LINE });
  const line = out.bottomLine ?? "";
  check("the bottom line says this is not a clean bill of health", /not a clean bill of health/i.test(line), line);
  check("…names the access that is missing", /password/i.test(line) && /test login/i.test(line), line);
  check("…and keeps what was seen, as an outside observation",
    line.includes(`What we saw from the outside: ${RUN_281_BOTTOM_LINE}`), line);
  check("rule 1: no homework in the new text", !hasHomework(line), line);
  check("rule 1: no narration in the new text", !hasNarration(line), line);
  check("rule 1: no machinery in the new text", !hasEnvironmentLeak(line), line);

  const noLine = judgeVerdictIntegrity(RUN_281, [], { verdict: "all_good", bottomLine: null });
  check("without a model bottom line there is no dangling outside-observation clause",
    !/outside/i.test(noLine.bottomLine ?? ""), noLine.bottomLine ?? "(null)");
}

console.log("\n— left alone: public pages were really verified —\n");

{
  const mixed: Labelled[] = [
    {
      title: "Read the pricing page",
      status: "ok",
      steps: [ok("Open /pricing"), ok("Compare plans")],
    },
    RUN_281[0],
  ];
  const out = judgeVerdictIntegrity(mixed, [], { verdict: "all_good", bottomLine: "Pricing reads cleanly." });
  check("one fully ok journey + one gated partial → stays all_good", out.verdict === "all_good", out.verdict);
  check("…bottom line untouched", out.bottomLine === "Pricing reads cleanly.", out.bottomLine ?? "(null)");
  check("…no note", out.note === null, out.note ?? "");
}

{
  // A partial journey whose skip is ours, not a gate: rule 2 of CLAUDE.md files
  // that as our own ticket; it is not the access case this rule speaks for.
  const ours: Labelled[] = [
    {
      title: "Change preferences",
      status: "partial",
      steps: [ok("Open settings"), { label: "Move the slider", status: "skipped", unverifiedReason: "our_capability" }],
    },
  ];
  const out = judgeVerdictIntegrity(ours, [], { verdict: "all_good", bottomLine: "Settings work." });
  check("a partial journey skipped for our own capability → not this rule", out.verdict === "all_good", out.verdict);
}

{
  // One gated journey beside one partial for our own reason: not every walked
  // journey stopped at the gate.
  const mixedReasons: Labelled[] = [
    RUN_281[0],
    {
      title: "Change preferences",
      status: "partial",
      steps: [ok("Open settings"), { label: "Move the slider", status: "skipped", unverifiedReason: "our_capability" }],
    },
  ];
  const out = judgeVerdictIntegrity(mixedReasons, [], { verdict: "all_good", bottomLine: "Settings work." });
  check("gated + our-capability partial → not this rule", out.verdict === "all_good", out.verdict);
}

console.log("\n— left alone: a verdict that already says something is wrong —\n");

{
  const findings: IntegrityFinding[] = [{ category: "confusing", severity: "medium" }];
  const out = judgeVerdictIntegrity(RUN_281, findings, {
    verdict: "needs_attention",
    bottomLine: "The gate's error message is unclear.",
  });
  check("needs_attention with findings → untouched", out.verdict === "needs_attention", out.verdict);
  check("…bottom line untouched", out.bottomLine === "The gate's error message is unclear.", out.bottomLine ?? "");
}

{
  // Findings exist but synthesis still said all_good: findings are evidence we
  // saw something, so this rule does not claim the run saw nothing.
  const findings: IntegrityFinding[] = [{ category: "polish", severity: "low" }];
  const out = judgeVerdictIntegrity(RUN_281, findings, { verdict: "all_good", bottomLine: "Fine." });
  check("gated run with a finding → not this rule", out.verdict === "all_good", out.verdict);
}

console.log("\n— the CHE-42 rules this sits beside still hold —\n");

{
  const none = judgeVerdictIntegrity(
    [{ status: "skipped", steps: [] }],
    [],
    { verdict: "all_good", bottomLine: "Looks fine." },
  );
  check("zero walked → unverified", none.verdict === "unverified", none.verdict);
  check("…zero-coverage wording", /zero coverage/.test(none.bottomLine ?? ""), none.bottomLine ?? "");

  const broken = judgeVerdictIntegrity(
    [{ status: "ok", steps: [ok("Open home")] }],
    [{ category: "risky", severity: "medium" }],
    { verdict: "broken", bottomLine: "It is broken" },
  );
  check("broken without a body → needs_attention", broken.verdict === "needs_attention", broken.verdict);
  check("…bottom line says it was downgraded",
    broken.bottomLine === "It is broken. Downgraded from Broken: no direct breakage evidence was captured.",
    broken.bottomLine ?? "");

  const realBroken = judgeVerdictIntegrity(
    [{ status: "broken", steps: [{ status: "broken", unverifiedReason: null }] }],
    [{ category: "broken", severity: "high" }],
    { verdict: "broken", bottomLine: "Checkout fails." },
  );
  check("broken with a broken finding → stays broken", realBroken.verdict === "broken", realBroken.verdict);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
