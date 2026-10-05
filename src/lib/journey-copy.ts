// What a check's journey disclosures say (CHE-418). Pure, so every sentence a
// reader or a screen reader gets from the journey strip is asserted in
// scripts/verify-check-page.ts and run through the leak guards
// (src/lib/verdict-language.ts) — R18: customer-read strings come from a
// module with no React in it.

// The word beside a journey row that says which way it goes. A journey with
// no steps (carried without its walk, or stopped before one) has its summary
// and numbers to show, not "0 steps".
export function disclosureWord(open: boolean, steps: number): string {
  if (steps === 0) return open ? "Hide details" : "Show details";
  return open ? "Hide steps" : `Show ${steps} step${steps === 1 ? "" : "s"}`;
}

// The name of the panel a journey row opens.
export function stepsRegionLabel(journeyTitle: string): string {
  return `Steps of ${journeyTitle}`;
}

// What a step card is, for whoever cannot see the picture: its place, how it
// went, what it was, and whether its evidence is open.
export function stepCardLabel(input: { index: number; statusLabel: string; stepLabel: string; open: boolean }): string {
  return `Step ${input.index + 1}, ${input.statusLabel}: ${input.stepLabel}. ${input.open ? "Hide" : "Show"} what we tried and what happened`;
}
