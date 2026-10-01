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
// Run #282 (same store, publicId cmuprx4mb00030v1ovh5rlsft) is the live check
// of the first version of the rule, and it slipped past: synthesis said
// needs_attention with zero findings, one journey was `risky` (its risky step
// sits on Shopify's own sign-in host), one skip was `not_applicable`, and
// /admin redirected to accounts.shopify.com — a second gate. Every
// precondition that was not the trail failed, while the trail was as clear as
// #281's. `fixtures-run-282.json` is that run straight out of production D1.
//
// Run #272 (joblander.app) is the negative it must not touch:
// needs_attention with zero findings of its own, a re-check that carries
// journeys forward, with a real login redirect AND public pages reached.
// `fixtures-run-272.json` is that run from D1. Signed sign-in tokens in a
// URL's query are replaced with REDACTED: the rule reads no query, and a live
// login signature has no place in source control.
//
// Pure: no database, no model. Every case is the exact shape the workflow
// hands judgeVerdictIntegrity. To see what the rules would do to recent
// production runs, scripts/replay-verdict-integrity.ts reads them from D1.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-verdict-integrity.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Verdict } from "@/lib/enums";
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

interface RunFixture {
  runNumber: number;
  targetUrl: string;
  verdict: Verdict;
  findings: number;
  bottomLine: string;
  journeys: Array<Journey & { carriedFromRunId: string | null }>;
}

const fixture = (name: string): RunFixture =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8"));

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
            // Query redacted: it was a live signed Shopify login token, and
            // the rule never reads a query.
            "https://accounts.shopify.com/lookup?rid=REDACTED&verify=REDACTED",
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

// The note goes to the run feed, which the verdict page shows: no verdict
// enum, no word about synthesis correcting itself (review, second round).
const INTERNAL_WORDS = /\b(?:all_good|mostly_ok|needs_attention|unverified|broken_|synth\w*|model)\b/i;

for (const verdict of ["all_good", "mostly_ok"] as const) {
  const out = judgeVerdictIntegrity(RUN_281, [], { verdict, bottomLine: RUN_281_BOTTOM_LINE }, RUN_281_TARGET);
  check(`synth ${verdict} → unverified`, out.verdict === "unverified", out.verdict);
  check(`synth ${verdict} → a note is recorded`, !!out.note, out.note ?? "(none)");
  check(`synth ${verdict} → the note is in product language`, !INTERNAL_WORDS.test(out.note ?? ""), out.note ?? "");
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

{
  // The gate earns its name twice in run #281 — the path says /password and
  // we typed into "Enter store password" there. Either alone is enough.
  const noFills: Journey[] = RUN_281.map((j) => ({
    ...j,
    steps: j.steps.map((s) => ({
      ...s,
      actions: s.actions
        ? JSON.stringify((JSON.parse(s.actions) as Array<{ kind: string }>).filter((a) => a.kind !== "fill"))
        : null,
    })),
  }));
  const byPath = judgeVerdictIntegrity(noFills, [], { verdict: "all_good", bottomLine: null }, RUN_281_TARGET);
  check("run #281 without its fills → still a gate by its address", byPath.verdict === "unverified", byPath.verdict);

  const neutral = "https://shop.example.com";
  const lockedHome: Journey[] = [1, 2].map((n) => ({
    title: `Journey ${n}`,
    status: "partial",
    steps: [
      ok("Open the shop", trail(nav(`${neutral}/`, `${neutral}/en`), fill("Password", `${neutral}/en`))),
      gated("Enter the shop"),
    ],
  }));
  const byFill = judgeVerdictIntegrity(lockedHome, [], { verdict: "all_good", bottomLine: null }, `${neutral}/`);
  check("a neutral address where we typed into a password field → a gate", byFill.verdict === "unverified", byFill.verdict);
}

console.log("\n— run #282: the gate, whatever synthesis called it —\n");

const RUN_282 = fixture("fixtures-run-282.json");

{
  const out = judgeVerdictIntegrity(
    RUN_282.journeys,
    [],
    { verdict: RUN_282.verdict, bottomLine: RUN_282.bottomLine },
    RUN_282.targetUrl,
  );
  check(`run #282 as recorded (${RUN_282.verdict}, 0 findings) → unverified`, out.verdict === "unverified", out.verdict);
  const line = out.bottomLine ?? "";
  check("…names both gates: the store's own and Shopify's sign-in",
    line.includes("(/password, accounts.shopify.com/lookup)"), line);
  check("…keeps what was seen, as an outside observation",
    line.includes(`What we saw from the outside: ${RUN_282.bottomLine}`), line);
  check("…note in product language", !!out.note && !INTERNAL_WORDS.test(out.note), out.note ?? "(none)");
  check("…no homework, narration or machinery", !hasHomework(line) && !hasNarration(line) && !hasEnvironmentLeak(line), line);

  // Shopify's sign-in host is the provider, not the product: its later pages
  // are not "product reached".
  const providerOnward: RunFixture["journeys"] = RUN_282.journeys.map((j, i) =>
    i === 1
      ? {
          ...j,
          steps: [
            ...j.steps,
            ok("Continue to the password step", trail(click("Continue with email", "https://accounts.shopify.com/login"))),
          ],
        }
      : j,
  );
  const po = judgeVerdictIntegrity(providerOnward, [], { verdict: "needs_attention", bottomLine: null }, RUN_282.targetUrl);
  check("a later page on the sign-in provider's host is not the product → still unverified", po.verdict === "unverified", po.verdict);
}

for (const verdict of ["all_good", "mostly_ok", "needs_attention", "broken"] as const) {
  const out = judgeVerdictIntegrity(RUN_281, [], { verdict, bottomLine: null }, RUN_281_TARGET);
  check(`run #281's trail with synth ${verdict} and no findings → unverified`, out.verdict === "unverified", out.verdict);
}

console.log("\n— left alone: something behind or beside the gate was really verified —\n");

{
  const RUN_272 = fixture("fixtures-run-272.json");
  const out = judgeVerdictIntegrity(
    RUN_272.journeys,
    [],
    { verdict: RUN_272.verdict, bottomLine: RUN_272.bottomLine },
    RUN_272.targetUrl,
  );
  check(`run #272 as recorded (re-check, ${RUN_272.verdict}, 0 findings of its own) → stays ${RUN_272.verdict}`,
    out.verdict === RUN_272.verdict, out.verdict);
  check("…bottom line untouched", out.bottomLine === RUN_272.bottomLine, out.bottomLine ?? "(null)");

  // Only the fresh journeys, carried ones dropped: it still reached /, /pricing,
  // /roles — real pages beside the /login redirect.
  const fresh = RUN_272.journeys.filter((j) => j.carriedFromRunId === null);
  const f = judgeVerdictIntegrity(fresh, [], { verdict: "needs_attention", bottomLine: null }, RUN_272.targetUrl);
  check("…its fresh journeys alone still reached public pages → stays needs_attention", f.verdict === "needs_attention", f.verdict);
}

{
  // Review of this rule, round 1: id.example.com is the customer's own
  // sign-in, not a third party's. A page reached there is the product.
  const site = "https://example.com";
  const own = "https://id.example.com";
  const ownSignIn = (extra: Step[]): Journey[] =>
    [1, 2].map((n) => ({
      title: `Journey ${n}`,
      status: "partial",
      steps: [ok("Open the app", trail(nav(`${site}/app`, `${own}/sign-in`))), ...extra, gated("Sign in")],
    }));
  const pricing = judgeVerdictIntegrity(
    ownSignIn([ok("Read pricing", trail(click("Pricing", `${own}/pricing`)))]),
    [],
    { verdict: "all_good", bottomLine: null },
    `${site}/`,
  );
  check("a page reached on the customer's own id.* subdomain → stays all_good", pricing.verdict === "all_good", pricing.verdict);

  const onlyGate = judgeVerdictIntegrity(ownSignIn([]), [], { verdict: "all_good", bottomLine: null }, `${site}/`);
  check("…while only its sign-in page reached → unverified", onlyGate.verdict === "unverified", onlyGate.verdict);
}

{
  // Review of this rule, round 2.
  const app = "https://app.customer.com";
  const tenant = "https://tenant.auth0.com";
  const auth0: Journey[] = [1, 2].map((n) => ({
    title: `Journey ${n}`,
    status: "partial",
    steps: [
      ok("Open the dashboard", trail(nav(`${app}/dashboard`, `${tenant}/login`))),
      ok("Continue to the password step", trail(click("Continue", `${tenant}/u/login`))),
      gated("Sign in"),
    ],
  }));
  const a0 = judgeVerdictIntegrity(auth0, [], { verdict: "all_good", bottomLine: null }, `${app}/`);
  check("a tenant-named provider's later sign-in page is not the product → unverified", a0.verdict === "unverified", a0.verdict);

  const site = "https://example.com";
  const docs: Journey[] = [
    {
      title: "Dashboard",
      status: "partial",
      steps: [ok("Open the dashboard", trail(nav(`${site}/dashboard`, `${site}/login`))), gated("Sign in")],
    },
    {
      title: "Docs",
      status: "ok",
      steps: [ok("Read pricing in the docs", trail(click("Pricing", "https://docs.example.com/pricing")))],
    },
  ];
  const d = judgeVerdictIntegrity(docs, [], { verdict: "all_good", bottomLine: null }, `${site}/`);
  check("a page on a sibling subdomain it never redirected to is the product → stays all_good", d.verdict === "all_good", d.verdict);

  const moved: Journey[] = [1, 2].map((n) => ({
    title: `Journey ${n}`,
    status: "partial",
    steps: [
      ok("Open the app", trail(nav("https://brand.com/app", "https://brandapp.io/login"))),
      ok("Read pricing", trail(click("Pricing", "https://brandapp.io/pricing"))),
      gated("Sign in"),
    ],
  }));
  const m = judgeVerdictIntegrity(moved, [], { verdict: "all_good", bottomLine: null }, "https://brand.com/");
  check("the product moved to another domain and a page was read there → stays all_good", m.verdict === "all_good", m.verdict);
}

{
  // Review of this rule, round 3: "sessions" is a product word too.
  const site = "https://coach.example.com";
  const sessions: Journey[] = [
    {
      title: "Settings",
      status: "partial",
      steps: [ok("Open settings", trail(nav(`${site}/settings`, `${site}/login`))), gated("Sign in")],
    },
    {
      title: "Shared session",
      status: "ok",
      steps: [ok("Open a shared practice session", trail(nav(`${site}/sessions/123`, `${site}/sessions/123`)))],
    },
  ];
  const s = judgeVerdictIntegrity(sessions, [], { verdict: "all_good", bottomLine: null }, `${site}/`);
  check("a /login gate beside a product page at /sessions/123 → stays all_good", s.verdict === "all_good", s.verdict);
}

{
  // Fixtures come from production and land in source control.
  for (const name of ["fixtures-run-282.json", "fixtures-run-272.json"]) {
    const text = readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
    check(`${name} carries no live sign-in token`, !/verify=(?!REDACTED)/.test(text));
  }
}

{
  // A gate proven, and one product page reached on the side: not gate-only.
  const withPage: Journey[] = [
    ...RUN_281,
    {
      title: "Read the shipping policy",
      status: "ok",
      steps: [ok("Open the policy", trail(nav(`${SHOP}/policies/shipping-policy`, `${SHOP}/policies/shipping-policy`)))],
    },
  ];
  const out = judgeVerdictIntegrity(withPage, [], { verdict: "needs_attention", bottomLine: null }, RUN_281_TARGET);
  check("a proven gate plus one product page reached → stays needs_attention", out.verdict === "needs_attention", out.verdict);
}

{
  // Review, third round: a canonical redirect to a public page is one
  // redirect target too. Nothing about /en asks for access.
  const site = "https://brand.example.com";
  const canonical: Journey[] = [1, 2, 3].map((n) => ({
    title: `Journey ${n}`,
    status: "partial",
    steps: [
      ok("Open the home page", trail(nav(`${site}/`, `${site}/en`))),
      ok("Read the offer"),
      gated("Save it to an account"),
    ],
  }));
  const out = judgeVerdictIntegrity(canonical, [], { verdict: "all_good", bottomLine: null }, `${site}/`);
  check("canonical redirect / → /en, public page read, account step skipped → stays all_good",
    out.verdict === "all_good", out.verdict);

  const newsletter: Journey[] = canonical.map((j) => ({
    ...j,
    steps: [ok("Open the home page", trail(nav(`${site}/`, `${site}/en`), fill("Email", `${site}/en`))), ...j.steps.slice(1)],
  }));
  const nl = judgeVerdictIntegrity(newsletter, [], { verdict: "all_good", bottomLine: null }, `${site}/`);
  check("…an email box on that page does not make it a gate", nl.verdict === "all_good", nl.verdict);

  const tips: Journey[] = canonical.map((j) => ({
    ...j,
    steps: [ok("Open the home page", trail(nav(`${site}/`, `${site}/blog/login-tips`))), ...j.steps.slice(1)],
  }));
  const lt = judgeVerdictIntegrity(tips, [], { verdict: "all_good", bottomLine: null }, `${site}/`);
  check("…nor does a path that merely contains the word (/blog/login-tips)", lt.verdict === "all_good", lt.verdict);
}

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
  check("redirects to a sign-in AND to a page that asks for nothing → stays all_good", out.verdict === "all_good", out.verdict);
}

{
  // Review, second round: the target redirects to the real product on another
  // host, and the walk then reads real pages there before meeting a step that
  // needs access. The product moved house; it did not lock the door.
  const marketing = "https://example.com";
  const app = "https://app.example.com";
  const movedHouse: Journey[] = [1, 2].map((n) => ({
    title: `Journey ${n}`,
    status: "partial",
    steps: [
      ok("Open the app", trail(nav(`${marketing}/`, `${app}/`))),
      ok("Open the public templates", trail(click("Templates", `${app}/templates`))),
      gated("Save a template to an account"),
    ],
  }));
  const out = judgeVerdictIntegrity(movedHouse, [], { verdict: "all_good", bottomLine: null }, `${marketing}/`);
  check("target redirects to the product on another host, pages read there → stays all_good",
    out.verdict === "all_good", out.verdict);
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
  // Run #282 showed the skip reasons are not the evidence: one of its skips
  // was not_applicable ("checkout" — never reachable behind the gate). The
  // trail is what says nothing behind the gate was reached, so an extra
  // our_capability or not_applicable skip does not rescue the pass.
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
  check("a proven gate with an our_capability skip too → unverified", out.verdict === "unverified", out.verdict);

  // But some skip must be missing_access: that is what makes "a password or
  // a test login" the honest ask. A gate whose every skip is ours is our
  // ticket (CLAUDE.md rule 2), not their access to grant.
  const noneAccess: Journey[] = RUN_281.map((j) => ({
    ...j,
    steps: j.steps.map((s) => (s.status === "skipped" ? { ...s, unverifiedReason: "our_capability" } : s)),
  }));
  const na = judgeVerdictIntegrity(noneAccess, [], { verdict: "all_good", bottomLine: null }, RUN_281_TARGET);
  check("a proven gate with no missing_access skip anywhere → stays all_good", na.verdict === "all_good", na.verdict);
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
  check("…the note is in product language", !INTERNAL_WORDS.test(none.note ?? ""), none.note ?? "");
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
