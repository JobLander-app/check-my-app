// Canonical status → label/color/emoji mappings. Keep these in one place so the
// live feed, journey strips, and findings list never drift from the brand palette.

import type { StepStatus, Verdict, Severity, FindingCategory } from "@/lib/enums";

// Keyed by string (not the union) so the DB's String columns index these
// directly without casts — values are still authored against the unions below.
export const STEP_STATUS_META: Record<
  string,
  { emoji: string; label: string; className: string; dotClassName: string }
> = {
  ok: { emoji: "✓", label: "Works", className: "text-status-ok", dotClassName: "bg-status-ok" },
  risky: {
    emoji: "⚠",
    label: "Risky",
    className: "text-status-risky",
    dotClassName: "bg-status-risky",
  },
  confusing: {
    emoji: "?",
    label: "Confusing",
    className: "text-status-confusing",
    dotClassName: "bg-status-confusing",
  },
  broken: {
    emoji: "✕",
    label: "Broken",
    className: "text-status-broken",
    dotClassName: "bg-status-broken",
  },
  exposed: {
    emoji: "⚠",
    label: "Exposed",
    className: "text-status-exposed",
    dotClassName: "bg-status-exposed",
  },
  skipped: { emoji: "—", label: "Skipped", className: "text-fg-faint", dotClassName: "bg-ink-600" },
  // Journey-level only: every attempted step worked, some steps went unverified
  // (out of scope / untestable here). Honest middle ground between ✓ and —.
  partial: {
    emoji: "✓",
    label: "Works · partly verified",
    className: "text-status-ok",
    dotClassName: "bg-status-ok",
  },
};

export const VERDICT_META: Record<
  string,
  { emoji: string; label: string; pillClassName: string; textClassName: string; dotClassName: string }
> = {
  all_good: {
    emoji: "🟢",
    label: "All good",
    pillClassName: "border-status-ok/40 bg-status-ok/10 text-status-ok",
    textClassName: "text-status-ok",
    dotClassName: "bg-status-ok",
  },
  mostly_ok: {
    emoji: "🟡",
    label: "Mostly OK",
    pillClassName: "border-status-confusing/40 bg-status-confusing/10 text-status-confusing",
    textClassName: "text-status-confusing",
    dotClassName: "bg-status-confusing",
  },
  needs_attention: {
    emoji: "🟠",
    label: "Needs attention",
    pillClassName: "border-status-risky/40 bg-status-risky/10 text-status-risky",
    textClassName: "text-status-risky",
    dotClassName: "bg-status-risky",
  },
  broken: {
    emoji: "🔴",
    label: "Broken",
    pillClassName: "border-status-broken/40 bg-status-broken/10 text-status-broken",
    textClassName: "text-status-broken",
    dotClassName: "bg-status-broken",
  },
  // Zero coverage — the run walked nothing, so there is no verdict to give.
  // Deliberately colourless: it must not read as either a pass or a failure.
  unverified: {
    emoji: "◌",
    label: "Not verified",
    pillClassName: "border-ink-600 bg-ink-800 text-fg-faint",
    textClassName: "text-fg-faint",
    dotClassName: "bg-ink-600",
  },
};

export const SEVERITY_META: Record<string, { label: string; className: string }> = {
  high: { label: "HIGH", className: "text-status-broken" },
  medium: { label: "MED", className: "text-status-risky" },
  low: { label: "LOW", className: "text-fg-faint" },
};

export const CATEGORY_META: Record<
  string,
  { emoji: string; label: string; className: string }
> = {
  broken: { emoji: "🔴", label: "Broken", className: "text-status-broken" },
  risky: { emoji: "🟠", label: "Risky", className: "text-status-risky" },
  confusing: { emoji: "🟡", label: "Confusing", className: "text-status-confusing" },
  polish: { emoji: "🔵", label: "Polish", className: "text-accent" },
  exposed: { emoji: "⚠", label: "Exposed", className: "text-status-exposed" },
};

export const CATEGORY_ORDER: FindingCategory[] = [
  "broken",
  "risky",
  "confusing",
  "polish",
  "exposed",
];

// Maps the persisted run status to the in-progress phase banner index (1–6).
export const RUN_STATUS_PHASE: Partial<Record<string, number>> = {
  connecting: 1,
  surface_scan: 2,
  discovery: 3,
  walking: 4,
  anatomy: 5,
  writing: 6,
};

export function isTerminal(status: string): boolean {
  return (
    status === "completed" || status === "partial" || status === "failed" || status === "canceled"
  );
}
