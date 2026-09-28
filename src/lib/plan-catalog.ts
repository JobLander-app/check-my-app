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

import type { UserPlan, WatchFrequency } from "./enums";
import {
  ANON_RUNS_PER_DAY,
  FREE_RUNS_LIFETIME,
  PLAN_LIMITS,
  WATCH_TRIAL_DAYS,
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

// What a watch's cadence reads as on the page.
function cadenceLine(freq: WatchFrequency | null): string | null {
  if (freq === "every_6h") {
    return "Checks every 6h — uptime and page health each cycle, one deep journey walk a day per app";
  }
  if (freq === "daily") return "Daily Watch — a full journey check every 24h";
  return null;
}

function appsLine(plan: CatalogPlanId): string | null {
  const n = PLAN_LIMITS[plan].maxWatches;
  return n > 1 ? `Up to ${n} apps` : null;
}

function recheckLine(plan: CatalogPlanId): string | null {
  const n = PLAN_LIMITS[plan].fullRechecksPerMonth;
  if (n === null) return "Re-check after a deploy, any time — unlimited full re-checks";
  if (n === 0) return null;
  return `Re-check after a deploy, any time — up to ${n} full re-checks a month`;
}

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

const FREE_WATCHES = PLAN_LIMITS.free.maxWatches;

export const PLAN_CATALOG: CatalogPlan[] = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    blurb: "See what the agent sees. No card, no signup.",
    features: lines(
      `${ANON_RUNS_PER_DAY} check/day without signup`,
      `${FREE_RUNS_LIFETIME} checks total with a free account`,
      `${WATCH_TRIAL_DAYS}-day Daily Watch trial on ${FREE_WATCHES === 1 ? "one app" : `${FREE_WATCHES} apps`} — no card`,
      seatsLine("free"),
      "Evidence on every verdict — screenshots, network logs",
      "Agent-written Playwright specs",
    ),
    cta: { label: "Check your app", href: "/" },
  },
  {
    id: "starter",
    name: "Starter",
    price: "$29",
    priceNote: "/mo per app",
    blurb: "Your app, watched every day.",
    features: lines(
      appsLine("starter"),
      cadenceLine(PLAN_LIMITS.starter.maxFrequency),
      recheckLine("starter"),
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
    price: "$99",
    priceNote: "/mo",
    blurb: "For teams shipping more than one thing.",
    features: lines(
      appsLine("growth"),
      cadenceLine(PLAN_LIMITS.growth.maxFrequency),
      recheckLine("growth"),
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
    price: "from $499",
    priceNote: "/mo",
    blurb: "Compliance-grade checking, on your terms.",
    features: lines(
      appsLine("business"),
      cadenceLine(PLAN_LIMITS.business.maxFrequency),
      recheckLine("business"),
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
