// How urgent a problem is, P0–P3 (CHE-413): one scale on Health → Issues, in
// the review an agent reads (get_review) and on the first line of every
// ticket we file. Computed from what the check recorded — never asked of a
// model — so the same problem gets the same label wherever it is shown.
//
// The owner's rule, 2026-10-04:
//   P0 — broken for existing users on money, sign-in or their data; or a
//        problem seen in three checks in a row;
//   P1 — broken or exposed anywhere; risky for existing users;
//   P2 — risky or confusing for new visitors; confusing that keeps coming back;
//   P3 — polish.
// Two things fill the gaps the rule leaves. The streak lifts to P0 only what
// is already a defect (broken, exposed, risky): confusing that keeps coming
// back is P2 by the rule's own words, and polish is P3 however often it is
// seen. A severity of "critical" — the check's own reading of impact — lifts a
// P2 to P1; it never makes a P0.
//
// Who hits it is read the way the Release lens reads it (audienceAt,
// src/lib/audience.ts): a journey that filled a test credential before the
// step is an existing user's; one that recorded no actions at all is unknown,
// and unknown is never promoted.

import type { Audience } from "@/lib/audience";

export type Priority = "P0" | "P1" | "P2" | "P3";

export const PRIORITIES: Priority[] = ["P0", "P1", "P2", "P3"];

export interface PriorityInput {
  category: string;
  severity: string;
  // Finding.detail.where — the page or request the problem was seen on.
  where: string | null | undefined;
  // Checks in a row that saw it (1 for a problem seen once).
  timesSeen: number;
  audience: Audience;
}

// A place where money, a sign-in or the user's own data is at stake. `where`
// is the finding's own words for the place — a path ("/checkout → Pay", "POST
// /api/auth/session → 500", "Settings → Billing (/account/billing)") or a
// label with no path at all ("Checkout → Pay", "Sign-in form"). Both are read:
// a whole path segment, so "/payload" is not money and "/checkout-guide" is a
// page about it; and a whole word of the prose, so "accountant" and "paying
// attention" are not either. The prose list is the narrower one — "session",
// "data" or "settings" as words are everyday words of a product's copy.
const SENSITIVE_SEGMENT =
  /(?:^|[/?=&#])(sign-?in|log-?in|login|auth|session|password|checkout|cart|pay|payment|payments|billing|invoice|subscribe|subscription|account|accounts|settings|profile|data|export)(?=$|[/?=&#.\s)])/i;
const SENSITIVE_WORD = /(?:^|[^\w/-])(sign[- ]?in|log[- ]?in|checkout|cart|pay|payment|payments|billing|invoice|subscribe|subscription|account|password)(?=$|[^\w/-])/i;
const PATH_TOKEN = /(?:https?:\/\/[^\s/"'”’]+)?\/[A-Za-z0-9_\-.%/?=&#:[\]]*/g;

export function sensitivePlace(where: string | null | undefined): boolean {
  if (!where) return false;
  // Every path-shaped token in the sentence, not only the first: "/pricing →
  // /checkout" is about the checkout.
  const paths = where.match(PATH_TOKEN) ?? [];
  if (paths.some((p) => SENSITIVE_SEGMENT.test(p.replace(/^https?:\/\/[^/]+/, "")))) return true;
  // What is left once the paths are out: the words.
  return SENSITIVE_WORD.test(where.replace(PATH_TOKEN, " "));
}

const DEFECT = new Set(["broken", "exposed", "risky"]);

export function issuePriority(i: PriorityInput): Priority {
  const existing = i.audience === "existing_users";
  const defect = DEFECT.has(i.category);
  if (defect && i.timesSeen >= 3) return "P0";
  if (i.category === "broken" && existing && sensitivePlace(i.where)) return "P0";
  if (i.category === "broken" || i.category === "exposed") return "P1";
  if (i.category === "risky" && existing) return "P1";
  if (i.category === "polish") return "P3";
  // Risky elsewhere, or confusing.
  const confusing = i.category === "confusing";
  if (i.category === "risky" || (confusing && (i.audience === "new_visitors" || i.timesSeen >= 2))) {
    return i.severity === "critical" ? "P1" : "P2";
  }
  if (confusing) return i.severity === "critical" ? "P1" : "P3";
  // A category this scale does not know (none exists today): judged by severity alone.
  return i.severity === "critical" || i.severity === "high" ? "P1" : i.severity === "medium" ? "P2" : "P3";
}

// What each level means, in the words the legend on Issues shows and the
// ticket's first line repeats. One line each; nothing about how we check.
export const PRIORITY_META: Record<Priority, { meaning: string; className: string }> = {
  P0: {
    meaning: "Existing users cannot pay, sign in or reach their data — or the problem has been there for three checks in a row.",
    className: "border-status-broken/50 bg-status-broken/10 text-status-broken",
  },
  P1: {
    meaning: "Something is broken or exposed, or existing users are at risk.",
    className: "border-status-risky/50 bg-status-risky/10 text-status-risky",
  },
  P2: {
    meaning: "New visitors meet something risky or confusing, or a confusing thing keeps coming back.",
    className: "border-status-confusing/50 bg-status-confusing/10 text-status-confusing",
  },
  P3: {
    meaning: "Polish — worth fixing, nobody is blocked.",
    className: "border-ink-600 bg-ink-800 text-fg-muted",
  },
};

export function priorityRank(p: Priority): number {
  return PRIORITIES.indexOf(p);
}

export function isPriority(raw: string | undefined): raw is Priority {
  return PRIORITIES.includes(raw as Priority);
}
