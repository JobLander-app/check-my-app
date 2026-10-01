import Link from "next/link";
import { UpgradeCta } from "@/components/upgrade-cta";
import { PLAN_CATALOG, TOPUP_LINE, catalogPlan } from "@/lib/plan-catalog";
import { pageMetadata } from "@/lib/site-metadata";

const STARTER = catalogPlan("starter");

export const metadata = pageMetadata({
  title: "Pricing",
  description: `First check is free, no signup. From ${STARTER.price}${STARTER.priceNote ?? ""} of checks: your app checked every day, and you hear the moment something breaks.`,
  path: "/pricing",
});

// Pricing · /pricing (CHE-40 phases 2a + 3). Starter/Growth CTAs go through
// <UpgradeCta>: signed-out → /sign-in, signed-in → Stripe Checkout (or a quiet
// "launches soon" note until billing is configured). Business stays a mailto.
//
// CHE-137 (owner, 2026-09-06): what a paid plan sells is "confidence every
// morning that my app did not break overnight" plus "the answer right now,
// after a deploy". CHE-327 (owner, 2026-09-28): a plan is a monthly balance,
// spent on anything, and every check has its own price — the cards say the
// balance and the typical price, never what a check costs us.
//
// CHE-326: the cards are PLAN_CATALOG (src/lib/plan-catalog.ts), whose every
// number is read from PLAN_LIMITS — the same catalog renders the owner's Notion
// page. Nothing plan-shaped is typed on this page; verify-plan-catalog fails if
// a number appears here.

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
            Staying certain is <span className="text-accent">{STARTER.price}</span>.
          </h1>
          <p className="mx-auto max-w-xl text-sm text-fg-muted">
            An agent explores your app like a first-time user and returns an evidence-backed
            verdict. Daily Watch re-checks every day and alerts you the moment something breaks.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PLAN_CATALOG.map((plan) => (
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
            plan's own quota still bounds what a key can start. CHE-326: the
            same goes for scenarios — every plan names its own. */}
        <p className="mx-auto max-w-2xl text-center text-sm text-fg-muted">
          <span className="text-fg">Connect your coding agent (MCP) — every plan.</span> Run
          checks from Claude Code, CI or your own tooling with an API key; checks started that
          way spend the same balance as any other.
        </p>

        {/* CHE-327: the way out of an empty balance, next to the plans. The
            buttons themselves live on the balance card in Billing, where a
            signed-in admin can press them (src/lib/balance-links.ts). */}
        <p id="checks" className="mx-auto max-w-2xl text-center text-sm text-fg-muted">
          <span className="text-fg">{TOPUP_LINE}.</span> Spent after the plan&apos;s own balance
          — from{" "}
          <Link href="/settings/billing" className="text-accent hover:underline">
            Billing
          </Link>
          .
        </p>

        <p className="mx-auto max-w-2xl text-center text-sm text-fg-muted">
          <span className="text-fg">Your own scenarios — every plan.</span> Tell the agent
          which paths matter most and what to leave alone, and it checks those first.
        </p>

        <p className="mx-auto max-w-2xl text-center font-mono text-[13px] leading-6 text-fg-faint">
          Launch pricing. The first check is free so you can judge a verdict before paying for
          the daily one — the free tier is honest, not infinite.
        </p>
      </div>
    </main>
  );
}
