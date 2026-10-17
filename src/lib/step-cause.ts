// Why a step was not checked: one named cause per unchecked step (CHE-443).
//
// The owner, 2026-10-07, about the Securify pilot: runs keep saying "we could
// not check this" and nobody can say why. Run cmuy23f79000btg1r7x3x0j6g had
// five steps our checker could not do, nine stopped on purpose, and one
// judgement filed under the wrong class — and all of it read the same.
//
// A cause is derived from what the step row already carries (status,
// unverifiedReason, gapClass, and the words of a refusal our own guard wrote),
// never from a prompt: every writer of a step, the walk, the signed-out and
// closed-door endings, the extension publication, gets the same answer, and a
// row written last week gets it too. The closed list:
//
//   our_capability:<gap class>   ours. One "[Checker gap]" ticket per class;
//                                the ticket goes to Mender (capability-gaps.ts).
//   missing_access:<what>        theirs to give. Goes to the team's admin.
//   read_only                    stopped on purpose: checks never change
//                                settings. Goes to the team's admin.
//   not_applicable               outside what the check covers. Shown to the
//                                admin; asks nothing.
//
// "unclassified" is not a cause. It is our defect: a step we could not
// explain. causeOfStep says so out loud (a `defect`, never a cause), and
// scripts/verify-step-causes.ts fails on it.
//
// This module sits in src/lib and is read by the web app and the agent: it
// imports nothing Next-only and, of the agent's modules, only a type.

import type { GapClass } from "@/agent/gap-classes";
import { SELF_CHECK_REFUSED_OBSERVED } from "@/lib/verdict-language";

export type CapabilityClass = Exclude<GapClass, "unclassified">;

export const ACCESS_KINDS = ["store_password", "sign_in_ended", "sign_in_rejected", "staff_access", "test_account", "other"] as const;
export type AccessKind = (typeof ACCESS_KINDS)[number];

export type StepCause =
  | `our_capability:${CapabilityClass}`
  | `missing_access:${AccessKind}`
  | "read_only"
  | "not_applicable";

// A step that is unchecked and has no cause. Ours, always.
export type CauseDefect = "no_reason" | "unclassified";

export type CauseOutcome = { cause: StepCause } | { defect: CauseDefect };

export interface CauseStep {
  status: string;
  unverifiedReason?: string | null;
  gapClass?: string | null;
  label?: string | null;
  attempted?: string | null;
  observed?: string | null;
}

/** Where a cause goes: our own board (Mender) or the team's admin. */
export type CauseRoute = "mender" | "admin";

export function causeRoute(cause: StepCause): CauseRoute {
  return cause.startsWith("our_capability:") ? "mender" : "admin";
}

/** The causes the admin is also told about by mail, once per app (the rest are shown, not mailed). */
export function isMailedToAdmin(cause: StepCause): boolean {
  return cause.startsWith("missing_access:") || cause === "read_only";
}

// ─── What access is missing ──────────────────────────────────────────────────
//
// The words come from the step's own text, read in this order: the more
// specific want first. Code paths that know exactly what they lacked (the
// store-password gate, the rejected-credential gate, the signed-out ending)
// already write a sentence that says it; this reads the sentence back, so the
// cause survives every route a step takes to its row.
const ACCESS_RULES: { match: RegExp; kind: AccessKind }[] = [
  { match: /store password|password[- ]protected|enter store password|password page/i, kind: "store_password" },
  {
    match: /sign-?in (?:this check uses )?(?:has |had )?ended|session (?:has |had )?(?:ended|expired)|signed out|led to [^\s]+ instead of the app/i,
    kind: "sign_in_ended",
  },
  {
    match: /no longer work|(?:rejected|not accepted|was refused|were refused|invalid|wrong|stale) (?:the )?(?:credentials?|password|sign-?in)|(?:credentials?|password|sign-?in details?) (?:was|were|is|are)? ?(?:rejected|not accepted|invalid|wrong|stale)/i,
    kind: "sign_in_rejected",
  },
  { match: /\bstaff\b|collaborator|permissions? (?:to|for) (?:the )?(?:store|admin)|access to the (?:store|admin)/i, kind: "staff_access" },
  { match: /test (?:credentials?|account|login|user)|no credentials|sign-?in details|log-?in details|credentials/i, kind: "test_account" },
];

export function accessKindOf(text: string): AccessKind {
  return ACCESS_RULES.find((r) => r.match.test(text))?.kind ?? "other";
}

// ─── The cause of one step ───────────────────────────────────────────────────

/** Null for a step that was checked: only an unchecked (skipped) step has a cause. */
export function causeOfStep(step: CauseStep): CauseOutcome | null {
  if (step.status !== "skipped") return null;
  switch (step.unverifiedReason) {
    case "our_capability": {
      const gap = step.gapClass;
      // A class we have never named is the bucket nobody learns from (CHE-86):
      // the step is ours and so is the fact that we cannot say why.
      if (!gap || gap === "unclassified" || !(gap in CAPABILITY_PHRASE)) return { defect: "unclassified" };
      return { cause: `our_capability:${gap as CapabilityClass}` };
    }
    case "missing_access":
      return { cause: `missing_access:${accessKindOf([step.observed, step.attempted, step.label].filter(Boolean).join(" "))}` };
    case "not_applicable":
      // Our own guard's refusal is written with one fixed sentence
      // (verdict-language.ts), so the row alone says it was stopped on purpose.
      return step.observed === SELF_CHECK_REFUSED_OBSERVED ? { cause: "read_only" } : { cause: "not_applicable" };
    default:
      return { defect: "no_reason" };
  }
}

// ─── What the customer reads ─────────────────────────────────────────────────
//
// Product and consequence only (CLAUDE.md §1): never our browser, our model or
// our cost, and never homework. Where we ask for something it is access, the
// one thing rule 2 allows us to ask for.

// What our checker could not do, as a clause that follows "we could not".
export const CAPABILITY_PHRASE: Record<CapabilityClass, string> = {
  new_tab: "follow a link that opens in a new tab",
  oauth: "complete a sign-in through another provider",
  passwordless: "complete a sign-in by emailed link",
  verification_code: "complete a step that asks for an emailed or texted code",
  media_devices: "use a camera or microphone",
  captcha: "get past a bot check",
  test_records: "clean up the test records this check made",
  file_transfer: "upload or download a file",
  range_input: "drag a slider",
  third_party_block: "open a page on another site that turned the check away",
  egress_unreachable: "reach an address this step points to",
  outside_product: "review a page that belongs to another product",
  rate_limited: "get past the limit this app puts on repeated requests",
  undriven_control: "operate a control on the page",
  extension_runtime: "finish checking the installed extension",
  extension_session_cleanup: "confirm the extension's session ended",
  extension_minute_accounting: "confirm the extension's session minutes",
  unpriced_journey: "work out what this journey costs a user",
  unfunnelled_journey: "turn this journey into a measurable path",
  journey_rotation: "reach every journey of this app within one check",
  shopify_admin: "open the app inside the Shopify admin",
  target_door: "open the app's first page",
  unrecorded_walk: "record this walk",
};

export const ACCESS_PHRASE: Record<AccessKind, string> = {
  store_password: "the store's password is missing or was not accepted",
  sign_in_ended: "the sign-in this check uses has ended",
  sign_in_rejected: "the sign-in details we hold were not accepted",
  staff_access: "the test account has no staff access to this store",
  test_account: "there is no test account to sign in with",
  other: "access this step needs was not given",
};

// What the admin can do about it. `to` names where, resolved to an address by
// the page that shows it; null when nothing on the page does it.
export type CauseAction = { text: string; to: "accounts" | "sign_in" | null };

export const ACCESS_ACTION: Record<AccessKind, CauseAction> = {
  store_password: { text: "Add the store password", to: "accounts" },
  sign_in_ended: { text: "Sign in to the store again", to: "sign_in" },
  sign_in_rejected: { text: "Update the sign-in details", to: "accounts" },
  staff_access: { text: "Give the test account staff access to the store", to: null },
  test_account: { text: "Add a test account", to: "accounts" },
  other: { text: "Give the access this step needs", to: null },
};

/** The sentence on the step: "Not checked: <cause>", in the team's words. */
export function causeText(cause: StepCause): string {
  if (cause.startsWith("our_capability:")) {
    const gap = cause.slice("our_capability:".length) as CapabilityClass;
    return `Not checked: we could not ${CAPABILITY_PHRASE[gap]}. This is on our side; the next check after the fix walks this step.`;
  }
  if (cause.startsWith("missing_access:")) {
    const kind = cause.slice("missing_access:".length) as AccessKind;
    return `Not checked: ${ACCESS_PHRASE[kind]}.`;
  }
  if (cause === "read_only") return "Not checked: stopped on purpose. Checks never change settings.";
  return "Not checked: this step is outside what this check covers.";
}

// A step with no cause is ours (see CauseDefect) and is shown as ours: it is
// never left unexplained on the page while the board learns of it.
export const DEFECT_TEXT =
  "Not checked: we could not complete this step. This is on our side; the next check after the fix walks this step.";

/** The sentence a step shows, or null for a step that was checked. */
export function causeLine(step: CauseStep): string | null {
  const outcome = causeOfStep(step);
  if (!outcome) return null;
  return "cause" in outcome ? causeText(outcome.cause) : DEFECT_TEXT;
}

/** What an admin does about it, or null where the cause asks nothing of them. */
export function causeAction(cause: StepCause): CauseAction | null {
  if (cause.startsWith("missing_access:")) return ACCESS_ACTION[cause.slice("missing_access:".length) as AccessKind];
  return null;
}

// ─── A run's unchecked share (what the digest counts) ────────────────────────

export interface CauseSummary {
  /** Steps the run reports on. */
  total: number;
  unchecked: number;
  /** unchecked / total; 0 for a run with no steps. */
  share: number;
  /** Unchecked steps by cause. */
  byCause: Partial<Record<StepCause, number>>;
  /** Unchecked steps with no cause: our defect, and what a guard fails on. */
  defects: { step: CauseStep; defect: CauseDefect }[];
}

export function summarizeCauses(steps: readonly CauseStep[]): CauseSummary {
  const byCause: Partial<Record<StepCause, number>> = {};
  const defects: CauseSummary["defects"] = [];
  let unchecked = 0;
  for (const step of steps) {
    const outcome = causeOfStep(step);
    if (!outcome) continue;
    unchecked++;
    if ("cause" in outcome) byCause[outcome.cause] = (byCause[outcome.cause] ?? 0) + 1;
    else defects.push({ step, defect: outcome.defect });
  }
  return { total: steps.length, unchecked, share: steps.length ? unchecked / steps.length : 0, byCause, defects };
}
