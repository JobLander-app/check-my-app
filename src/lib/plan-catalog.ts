// The plans as a customer reads them (CHE-326): names, prices, blurbs and
// feature lines. One source for two readers — /pricing renders it, and
// scripts/sync-plans-notion.ts renders the owner's Notion page from it on every
// deploy — so the site, the page and the gates cannot drift apart.
//
// Every number in a feature line is read from src/lib/plans.ts, never typed
// here: a plan decision is a change to PLAN_LIMITS, and the copy follows. What
// is a feature of which plan follows the code too: the tracker line appears on
// exactly the plans whose `trackerIntegration` is on. Scenarios are not a plan
// feature — every plan sets its own (the Notion page's "not gated" list) — so no line may
// suggest one plan gets "the paths you nominate" and another does not.
// scripts/verify-plan-catalog.ts holds all of that.
//
// CHE-327: a plan is a monthly balance (Free: once), and every check has its
// own price. The cards say the balance and the typical price range on that
// plan — prices only; what a check costs us and the multiplier between the
// two never appear here (scripts/verify-balance.ts).

import type { UserPlan } from "./enums";
import {
  ANON_RUNS_PER_DAY,
  PLAN_LIMITS,
  TOPUP_AMOUNTS_USD,
  WATCH_TRIAL_DAYS,
  typicalPriceRange,
  usd,
} from "./plans";

// The plans /pricing sells. Enterprise exists in PLAN_LIMITS but is a
// conversation, not a card.
export type CatalogPlanId = Exclude<UserPlan, "enterprise">;

export type CatalogPlan = {
  id: CatalogPlanId;
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

// The line every plan with a tracker carries, word for word, so a check can
// find it.
export const TRACKER_LINE =
  "Findings auto-filed to your tracker — Linear now, GitHub next — with dedup & escalation";

// What the plan puts on the balance, as the card says it.
export function balanceLine(plan: CatalogPlanId): string {
  const credit = PLAN_LIMITS[plan].creditUsd ?? 0;
  return plan === "free"
    ? `${usd(credit)} of checks with a free account`
    : `${usd(credit)} of checks every month — daily watches, your agent, re-checks after a deploy`;
}

// What a check typically costs on the plan.
export function priceRangeLine(plan: CatalogPlanId): string {
  const r = typicalPriceRange(plan);
  return `Every check has its own price, typically ${usd(r.low)}–${usd(r.high)}; a check that finds nothing changed costs a few cents`;
}

export const TOPUP_LINE = `Top up any time from $${TOPUP_AMOUNTS_USD[0]} — bought balance never expires`;
export const WATCHES_LINE = "Any number of apps, checked daily or every 6 hours";

function seatsLine(plan: CatalogPlanId): string | null {
  const n = PLAN_LIMITS[plan].includedSeats;
  if (n === null) return null;
  return `${n} ${n === 1 ? "person" : "people"} who can run checks — readers free`;
}

function trackerLine(plan: CatalogPlanId): string | null {
  return PLAN_LIMITS[plan].trackerIntegration ? TRACKER_LINE : null;
}

function lines(...items: (string | null)[]): string[] {
  return items.filter((l): l is string => l !== null);
}

const planPrice = (plan: CatalogPlanId) => `$${PLAN_LIMITS[plan].creditUsd}`;

export const PLAN_CATALOG: CatalogPlan[] = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    blurb: "See what the agent sees. No card, no signup.",
    features: lines(
      `${ANON_RUNS_PER_DAY} check/day without signup`,
      balanceLine("free"),
      `${WATCH_TRIAL_DAYS}-day Daily Watch trial on one app — no card`,
      seatsLine("free"),
      "Evidence on every verdict — screenshots, network logs",
      "Agent-written Playwright specs",
    ),
    cta: { label: "Check your app", href: "/" },
  },
  {
    id: "starter",
    name: "Starter",
    // The subscription price IS the monthly balance, by design: what you pay
    // is what you can spend.
    price: planPrice("starter"),
    priceNote: "/mo",
    blurb: "Your app, watched every day.",
    features: lines(
      balanceLine("starter"),
      priceRangeLine("starter"),
      WATCHES_LINE,
      "Regression alerts by email",
      trackerLine("starter"),
      seatsLine("starter"),
      "Every verdict kept, with its evidence — nothing expires",
      "Export Playwright specs to GitHub as a PR",
    ),
    cta: { label: "Start free", href: "/sign-in" },
    checkoutPlan: "starter",
    recommended: true,
  },
  {
    id: "growth",
    name: "Growth",
    price: planPrice("growth"),
    priceNote: "/mo",
    blurb: "For teams shipping more than one thing.",
    features: lines(
      balanceLine("growth"),
      priceRangeLine("growth"),
      WATCHES_LINE,
      trackerLine("growth"),
      seatsLine("growth"),
      "Fixes verified from the outside: close a ticket and the next run confirms it",
    ),
    cta: { label: "Start free", href: "/sign-in" },
    checkoutPlan: "growth",
  },
  {
    id: "business",
    name: "Business",
    price: `from ${planPrice("business")}`,
    priceNote: "/mo",
    blurb: "Compliance-grade checking, on your terms.",
    features: lines(
      balanceLine("business"),
      priceRangeLine("business"),
      WATCHES_LINE,
      trackerLine("business"),
      seatsLine("business"),
      "SSO",
      "SLA",
      "Priority support from the person who builds it",
    ),
    cta: { label: "Talk to us", href: "mailto:sorokinvj@gmail.com" },
  },
];

export function catalogPlan(id: CatalogPlanId): CatalogPlan {
  const plan = PLAN_CATALOG.find((p) => p.id === id);
  if (!plan) throw new Error(`plan-catalog: no plan ${id}`);
  return plan;
}
