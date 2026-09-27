import Link from "next/link";
import { UpgradeCta } from "@/components/upgrade-cta";
import { pageMetadata } from "@/lib/site-metadata";

export const metadata = pageMetadata({
  title: "Pricing",
  description:
    "First check is free, no signup. Daily Watch from $29/mo per app: your app checked every day, and you hear the moment something breaks.",
  path: "/pricing",
});

// Pricing · /pricing (CHE-40 phases 2a + 3). Starter/Growth CTAs go through
// <UpgradeCta>: signed-out → /sign-in, signed-in → Stripe Checkout (or a quiet
// "launches soon" note until billing is configured). Business stays a mailto.
//
// CHE-137 (owner, 2026-09-06): what a paid plan sells is "confidence every
// morning that my app did not break overnight" plus "the answer right now,
// after a deploy". The re-check after a deploy is unlimited on every paid
// plan; only the FULL re-check (every journey from scratch) is metered, and
// the numbers here are PLAN_LIMITS[plan].fullRechecksPerMonth in
// src/lib/plans.ts — change them together. No per-month run count is promised
// anywhere else on the site, by the same decision.

type Plan = {
  name: string;
  price: string;
  priceNote?: string;
  blurb: string;
  features: string[];
  cta: { label: string; href: string };
  // Set → the CTA starts Stripe Checkout for this plan when signed in.
  checkoutPlan?: "starter" | "growth";
  recommended?: boolean;
};

const PLANS: Plan[] = [
  {
    name: "Free",
    price: "$0",
    blurb: "See what the agent sees. No card, no signup.",
    features: [
      "1 check/day without signup",
      "3 checks total with a free account",
      "7-day Daily Watch trial on one app — no card",
      "Evidence on every verdict — screenshots, network logs",
      "Agent-written Playwright specs",
    ],
    cta: { label: "Check your app", href: "/" },
  },
  {
    name: "Starter",
    price: "$29",
    priceNote: "/mo per app",
    blurb: "Your app, watched every day.",
    features: [
      "Daily Watch — a full journey check every 24h",
      "Re-check after a deploy, any time — up to 5 full re-checks a month",
      "Regression alerts by email",
      "Every verdict kept, with its evidence — nothing expires",
      "Export Playwright specs to GitHub as a PR",
    ],
    cta: { label: "Start free", href: "/sign-in" },
    checkoutPlan: "starter",
    recommended: true,
  },
  {
    name: "Growth",
    price: "$99",
    priceNote: "/mo",
    blurb: "For teams shipping more than one thing.",
    features: [
      "Up to 5 apps",
      "Checks every 6h — uptime and page health each cycle, one deep journey walk a day per app",
      "Re-check after a deploy, any time — up to 20 full re-checks a month",
      "Findings auto-filed to your tracker — Linear now, GitHub next — with dedup & escalation",
      "Fixes verified from the outside: close a ticket and the next run confirms it",
    ],
    cta: { label: "Start free", href: "/sign-in" },
    checkoutPlan: "growth",
  },
  {
    name: "Business",
    price: "from $499",
    priceNote: "/mo",
    blurb: "Compliance-grade checking, on your terms.",
    features: [
      "Checks every 6h, on the paths you nominate",
      "Re-check after a deploy, any time — 100 full re-checks a month",
      "SSO",
      "SLA",
      "Priority support from the person who builds it",
    ],
    cta: { label: "Talk to us", href: "mailto:sorokinvj@gmail.com" },
  },
];

// Link styled like Button's primary / outline variants — CTAs here are
// navigations, not actions, so <a> is the right element.
const CTA_BASE =
  "inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm transition-colors";
const CTA_PRIMARY = "bg-accent font-semibold text-ink-950 hover:bg-accent-hover";
const CTA_OUTLINE = "border border-ink-600 bg-ink-850 text-fg hover:border-ink-700 hover:bg-ink-800";

export default function PricingPage() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-16">
      <div className="stagger space-y-10">
        <div className="space-y-3 text-center">
          <p className="section-label">pricing · launch</p>
          <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-[2.75rem] sm:leading-[1.1]">
            First check is free.
            <br />
            Staying certain is <span className="text-accent">$29</span>.
          </h1>
          <p className="mx-auto max-w-xl text-sm text-fg-muted">
            An agent explores your app like a first-time user and returns an evidence-backed
            verdict. Daily Watch re-checks every day and alerts you the moment something breaks.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className={`card relative flex flex-col p-5 ${plan.recommended ? "border-accent/50" : ""}`}
            >
              {plan.recommended && (
                <span className="absolute -top-2.5 left-5 rounded-full border border-accent/50 bg-ink-850 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-accent">
                  recommended
                </span>
              )}
              <p className="section-label">{plan.name}</p>
              <p className="mt-3 text-2xl font-semibold tracking-tight text-fg">
                {plan.price}
                {plan.priceNote && (
                  <span className="ml-1 font-mono text-xs font-normal text-fg-faint">
                    {plan.priceNote}
                  </span>
                )}
              </p>
              <p className="mt-2 text-sm text-fg-muted">{plan.blurb}</p>
              <ul className="mt-4 flex-1 space-y-2.5">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex gap-2 text-sm leading-5 text-fg-muted">
                    <span className="font-mono text-fg-faint">→</span>
                    {feature}
                  </li>
                ))}
              </ul>
              <div className="mt-5">
                {plan.checkoutPlan ? (
                  <UpgradeCta
                    plan={plan.checkoutPlan}
                    label={plan.cta.label}
                    className={`${CTA_BASE} ${plan.recommended ? CTA_PRIMARY : CTA_OUTLINE}`}
                  />
                ) : (
                  <Link
                    href={plan.cta.href}
                    className={`${CTA_BASE} ${plan.recommended ? CTA_PRIMARY : CTA_OUTLINE}`}
                  >
                    {plan.cta.label}
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* CHE-316 (owner, 2026-09-27): the coding agent is the primary
            interface, so an API key and MCP come with every plan, Free
            included — one shared line rather than a Business-only bullet. The
            plan's own quota still bounds what a key can start. */}
        <p className="mx-auto max-w-2xl text-center text-sm text-fg-muted">
          <span className="text-fg">Connect your coding agent (MCP) — every plan.</span> Run
          checks from Claude Code, CI or your own tooling with an API key; checks started that
          way count against your plan like any other.
        </p>

        <p className="mx-auto max-w-2xl text-center font-mono text-[13px] leading-6 text-fg-faint">
          Launch pricing. The first check is free so you can judge a verdict before paying for
          the daily one — the free tier is honest, not infinite.
        </p>
      </div>
    </main>
  );
}
