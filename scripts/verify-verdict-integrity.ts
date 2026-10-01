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
// D1 — status, unverifiedReason and the machine trail (Step.actions) per step,
// labels kept for the reader — and its synthesized bottom line verbatim.
//
// The counter-case is the one review raised: a SaaS walk that reads public
// pages and then meets the sign-in is ALSO partial with a missing_access
// skip, and it verified something. Only the trail tells the two apart.
//
// Pure: no database, no model. Every case is the exact shape the workflow
// hands judgeVerdictIntegrity.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-verdict-integrity.ts

import {
  judgeVerdictIntegrity,
  type IntegrityFinding,
  type IntegrityJourney,
  type IntegrityStep,
} from "@/agent/verdict-integrity";
import { hasEnvironmentLeak, hasHomework, hasNarration } from "@/lib/verdict-language";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

type Step = IntegrityStep & { label: string };
type Journey = IntegrityJourney & { title: string; steps: Step[] };

const trail = (...actions: unknown[]) => JSON.stringify(actions);
const nav = (url: string, urlAfter: string) => ({ kind: "navigate", url, outcome: { urlAfter, status: 200 } });
const click = (name: string, urlAfter: string) => ({
  kind: "click",
  role: "link",
  name,
  outcome: { urlAfter, navigated: true, requests: 1, mutations: 1 },
});
const fill = (label: string, urlAfter: string) => ({ kind: "fill", label, value: "x", outcome: { urlAfter } });

const ok = (label: string, actions: string | null = null): Step => ({ label, status: "ok", unverifiedReason: null, actions });
const gated = (label: string, actions: string | null = null): Step => ({
  label,
  status: "skipped",
  unverifiedReason: "missing_access",
  actions,
});

// ─── Run #281, as recorded ────────────────────────────────────────────────────

const SHOP = "https://securify-demo.myshopify.com";
const GATE = `${SHOP}/password`;

const RUN_281_TARGET = `${SHOP}/`;
const RUN_281: Journey[] = [
  {
    title: "Enter store via password gate",
    status: "partial",
    steps: [
      ok("Navigate to store", trail(nav(`${SHOP}/`, GATE))),
      ok("Land on password gate"),
      gated("Enter store password", trail(fill("Enter store password", GATE))),
    ],
  },
  {
    title: "Navigate to Shopify admin login",
    status: "partial",
    steps: [
      ok("Load the password gate page at /password", trail(nav(`${SHOP}/`, GATE))),
      ok(
        "Click the 'Log in here' link pointing to /admin",
        trail(
          click(
            "Log in here",
            "https://accounts.shopify.com/lookup?rid=0c358f68-68e8-4816-9c10-27f531c84aad&verify=1790871311-bnLkLuIdRSxeQ6eir93XzYPzrp9vo%2BaLJ9ECl6ilQGs%3D",
          ),
        ),
      ),
      ok("Redirect to admin.shopify.com"),
      gated("Sign in to the Shopify admin (expected 403 / no credentials)"),
      gated(
        "Open the storefront as a shopper (home, product, cart)",
        trail(nav(`${SHOP}/collections/all`, GATE), nav(`${SHOP}/cart`, GATE), fill("Enter store password", GATE)),
      ),
    ],
  },
  {
    title: "Submit password via form with hidden fields",
    status: "partial",
    steps: [
      ok(
        "Load the /password page",
        trail(
          nav(`${SHOP}/`, GATE),
          fill("Enter store password", GATE),
          nav(`${SHOP}/collections/all`, GATE),
          nav(`${SHOP}/cart`, GATE),
          nav(`${SHOP}/products/example-product`, GATE),
        ),
      ),
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
  const out = judgeVerdictIntegrity(RUN_281, [], { verdict, bottomLine: RUN_281_BOTTOM_LINE }, RUN_281_TARGET);
  check(`synth ${verdict} → unverified`, out.verdict === "unverified", out.verdict);
  check(`synth ${verdict} → a note is recorded`, !!out.note, out.note ?? "(none)");
}

{
  const out = judgeVerdictIntegrity(
    RUN_281,
    [],
    { verdict: "all_good", bottomLine: RUN_281_BOTTOM_LINE },
    RUN_281_TARGET,
  );
  const line = out.bottomLine ?? "";
  check("the bottom line says this is not a clean bill of health", /not a clean bill of health/i.test(line), line);
  check("…names the gate the product sent us to", line.includes("(/password)"), line);
  check("…names the access that is missing", /password/i.test(line) && /test login/i.test(line), line);
  check("…and keeps what was seen, as an outside observation",
    line.includes(`What we saw from the outside: ${RUN_281_BOTTOM_LINE}`), line);
  check("rule 1: no homework in the new text", !hasHomework(line), line);
  check("rule 1: no narration in the new text", !hasNarration(line), line);
  check("rule 1: no machinery in the new text", !hasEnvironmentLeak(line), line);

  const noLine = judgeVerdictIntegrity(RUN_281, [], { verdict: "all_good", bottomLine: null }, RUN_281_TARGET);
  check("without a model bottom line there is no dangling outside-observation clause",
    noLine.verdict === "unverified" && !/outside/i.test(noLine.bottomLine ?? ""), noLine.bottomLine ?? "(null)");

  const www = judgeVerdictIntegrity(RUN_281, [], { verdict: "all_good", bottomLine: null }, "https://www.securify-demo.myshopify.com");
  check("a www target is the same site", www.verdict === "unverified", www.verdict);
}

{
  // The gate on another host: the app sends everything to its sign-in provider.
  const app = "https://app.example.com";
  const login = "https://auth.example.com/sign-in";
  const offsite: Journey[] = [1, 2].map((n) => ({
    title: `Journey ${n}`,
    status: "partial",
    steps: [
      ok("Open the dashboard", trail(nav(`${app}/dashboard`, login))),
      gated("Sign in", trail(fill("Email", login))),
    ],
  }));
  const out = judgeVerdictIntegrity(offsite, [], { verdict: "all_good", bottomLine: null }, `${app}/`);
  check("every path redirected to an off-site sign-in → unverified", out.verdict === "unverified", out.verdict);
  check("…names the off-site gate with its host", (out.bottomLine ?? "").includes("(auth.example.com/sign-in)"),
    out.bottomLine ?? "");
}

console.log("\n— left alone: something behind or beside the gate was really verified —\n");

const SAAS = "https://saas.example.com";

{
  // Review's counter-case: public pages walked, then the sign-in. Partial,
  // missing_access, zero findings — and real coverage.
  const publicThenLogin: Journey[] = [1, 2, 3].map((n) => ({
    title: `Journey ${n}`,
    status: "partial",
    steps: [
      ok("Open the landing page", trail(nav(`${SAAS}/`, `${SAAS}/`))),
      ok("Read pricing", trail(click("Pricing", `${SAAS}/pricing`))),
      ok("Open sign-in", trail(click("Sign in", `${SAAS}/login`))),
      gated("Sign in with a test account"),
    ],
  }));
  const out = judgeVerdictIntegrity(publicThenLogin, [], { verdict: "all_good", bottomLine: "Public pages work." }, `${SAAS}/`);
  check("public pages walked before a sign-in skip → stays all_good", out.verdict === "all_good", out.verdict);
  check("…bottom line untouched", out.bottomLine === "Public pages work.", out.bottomLine ?? "(null)");
}

{
  // Redirected to the login from a deep link, but the landing page is public
  // and was reached in another step.
  const mostlyGated: Journey[] = [
    {
      title: "Dashboard",
      status: "partial",
      steps: [ok("Open dashboard", trail(nav(`${SAAS}/dashboard`, `${SAAS}/login`))), gated("Sign in")],
    },
    {
      title: "Landing",
      status: "partial",
      steps: [ok("Open landing", trail(nav(`${SAAS}/`, `${SAAS}/`))), gated("Start a trial")],
    },
  ];
  const out = judgeVerdictIntegrity(mostlyGated, [], { verdict: "all_good", bottomLine: null }, `${SAAS}/`);
  check("one product page reached beside the redirect → stays all_good", out.verdict === "all_good", out.verdict);
}

{
  const twoGates: Journey[] = [
    {
      title: "A",
      status: "partial",
      steps: [ok("Open A", trail(nav(`${SAAS}/a`, `${SAAS}/login`))), gated("Sign in")],
    },
    {
      title: "B",
      status: "partial",
      steps: [ok("Open B", trail(nav(`${SAAS}/b`, `${SAAS}/maintenance`))), gated("Sign in")],
    },
  ];
  const out = judgeVerdictIntegrity(twoGates, [], { verdict: "all_good", bottomLine: null }, `${SAAS}/`);
  check("redirects to two different places → not one gate → stays all_good", out.verdict === "all_good", out.verdict);
}

{
  // Same statuses and reasons as run #281, no trail: we cannot tell where the
  // walk stopped, so the rule does not speak.
  const blind: Journey[] = RUN_281.map((j) => ({ ...j, steps: j.steps.map((s) => ({ ...s, actions: null })) }));
  const out = judgeVerdictIntegrity(blind, [], { verdict: "all_good", bottomLine: null }, RUN_281_TARGET);
  check("run #281's shape without a trail → stays all_good", out.verdict === "all_good", out.verdict);

  const noTarget = judgeVerdictIntegrity(RUN_281, [], { verdict: "all_good", bottomLine: null }, null);
  check("no target URL → stays all_good", noTarget.verdict === "all_good", noTarget.verdict);
}

{
  // One journey of run #281 with no landing in its trail at all.
  const oneBlind: Journey[] = [
    RUN_281[0],
    { ...RUN_281[1], steps: RUN_281[1].steps.map((s) => ({ ...s, actions: null })) },
  ];
  const out = judgeVerdictIntegrity(oneBlind, [], { verdict: "all_good", bottomLine: null }, RUN_281_TARGET);
  check("a walked journey without a recorded landing → stays all_good", out.verdict === "all_good", out.verdict);
}

{
  const pricing: Journey = {
    title: "Read the pricing page",
    status: "ok",
    steps: [ok("Open /pricing", trail(nav(`${SHOP}/pricing`, `${SHOP}/pricing`))), ok("Compare plans")],
  };
  const out = judgeVerdictIntegrity([pricing, RUN_281[0]], [], { verdict: "all_good", bottomLine: "Pricing reads cleanly." }, RUN_281_TARGET);
  check("one fully ok journey + one gated partial → stays all_good", out.verdict === "all_good", out.verdict);
  check("…bottom line untouched", out.bottomLine === "Pricing reads cleanly.", out.bottomLine ?? "(null)");
  check("…no note", out.note === null, out.note ?? "");
}

{
  // A gated journey that ALSO stopped for our own reason: a password would
  // not have finished it, and our_capability is our ticket (CLAUDE.md rule 2).
  const alsoOurs: Journey[] = [
    {
      ...RUN_281[0],
      steps: [
        ...RUN_281[0].steps,
        { label: "Move the slider", status: "skipped", unverifiedReason: "our_capability", actions: null },
      ],
    },
    RUN_281[1],
    RUN_281[2],
  ];
  const out = judgeVerdictIntegrity(alsoOurs, [], { verdict: "all_good", bottomLine: null }, RUN_281_TARGET);
  check("a gated journey with an our_capability skip too → stays all_good", out.verdict === "all_good", out.verdict);

  const notApplicable: Journey[] = [
    { ...RUN_281[0], steps: RUN_281[0].steps.map((s) => (s.status === "skipped" ? { ...s, unverifiedReason: "not_applicable" } : s)) },
    RUN_281[1],
    RUN_281[2],
  ];
  const na = judgeVerdictIntegrity(notApplicable, [], { verdict: "all_good", bottomLine: null }, RUN_281_TARGET);
  check("a journey skipped as not_applicable → stays all_good", na.verdict === "all_good", na.verdict);
}

console.log("\n— left alone: a verdict that already says something is wrong —\n");

{
  const findings: IntegrityFinding[] = [{ category: "confusing", severity: "medium" }];
  const out = judgeVerdictIntegrity(
    RUN_281,
    findings,
    { verdict: "needs_attention", bottomLine: "The gate's error message is unclear." },
    RUN_281_TARGET,
  );
  check("needs_attention with findings → untouched", out.verdict === "needs_attention", out.verdict);
  check("…bottom line untouched", out.bottomLine === "The gate's error message is unclear.", out.bottomLine ?? "");
}

{
  // Findings are evidence we saw something, so this rule does not claim the
  // run saw nothing.
  const findings: IntegrityFinding[] = [{ category: "polish", severity: "low" }];
  const out = judgeVerdictIntegrity(RUN_281, findings, { verdict: "all_good", bottomLine: "Fine." }, RUN_281_TARGET);
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
