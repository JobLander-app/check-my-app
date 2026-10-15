// CHE-453: a check inside a signed-in session whose walk reached nothing is our
// outage, not a verdict.
//
// Run #373 (Securify, 2026-10-12): the session host's residential proxy ran out
// of traffic mid-run (the upstream answered 402). The scan had loaded the app,
// discovery planned five journeys, and then every step of the walk failed with
// no page and no request — 20 steps "our_capability", 0 journeys walked — and
// the run published "Not verified" to the customer, with sentences about "our
// accessing side". Rule 4: an outage on our side fails the run with an
// internal reason and publishes nothing.
//
// The rule, decided from the rows, before synthesis: in a session run, when the
// walk itself walked no journey and every step it left unchecked was left for
// our own incapacity — none for missing access, none stopped on purpose — the
// run did not meet the customer's app at all. A walk that met a sign-in, a
// store password or a read-only stop is a run about the app, and keeps its
// verdict.

export interface WalkedStep {
  status: string;
  unverifiedReason: string | null;
}

export interface WalkedJourney {
  status: string;
  carriedFromRunId: string | null;
  steps: WalkedStep[];
}

export function sessionWalkReachedNothing(journeys: readonly WalkedJourney[]): boolean {
  const own = journeys.filter((j) => j.carriedFromRunId === null);
  if (own.length === 0) return false;
  if (own.some((j) => j.status !== "skipped")) return false;
  const steps = own.flatMap((j) => j.steps);
  if (steps.length === 0) return false;
  return steps.every((s) => s.status === "skipped" && s.unverifiedReason === "our_capability");
}

export const SESSION_OUTAGE_MESSAGE =
  "internal: the session browser reached nothing during the walk (every step our_capability, no journey walked) — " +
  "an outage of our session host or its egress; no verdict may be published (CHE-453)";
