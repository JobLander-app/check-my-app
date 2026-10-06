// Who would have hit a problem seen on a given step: someone we saw signed in,
// or someone we saw as a visitor. The owner's question, from the Goran call
// (2026-10-01, 24:45): «it's kinda tricky that it doesn't break for the
// existing customers». It is our vantage on the walk, not a claim about the
// customer's user base — "seen signed in", never "breaks for existing
// customers" (CHE-393).
//
// Read from what the walk recorded, not from what the model named the journey:
// on checkmyapp.dev the walker signs in during "signup" and "start-free-land"
// journeys too (#261, #264, #266), and AppJourney.surface is free text.
//
// Two sources, the fact first (CHE-393):
//   Step.signedIn — written by the walk when the step was reported, from where
//                   it stood: a person's signed-in session, a test account it
//                   signed in as and was not turned away, a sign-out control on
//                   the page (src/agent/tools.ts signedInNow). A session the
//                   browser carried in, a magic link, SSO all read as signed in
//                   here, where the inference below reads them as a visitor.
//   the inference — for rows written before the column (signedIn null): each
//                   journey runs in a fresh browser (src/agent/workflow.ts), so a
//                   session is signed in only if this journey filled a test
//                   credential, and the walk records that fill as the
//                   {{TEST_EMAIL}} / {{TEST_EMAIL:<label>}} placeholder in
//                   Step.actions (CHE-129).
//   seen_signed_in  — the step says so, or a non-skipped step up to and
//                     including this one filled a credential;
//   seen_as_visitor — the step says not, or none filled and the journey
//                     recorded its actions;
//   unknown         — no step says, and the journey recorded no actions at all
//                     (before CHE-129), so a sign-in could have happened unrecorded.
//
// One rule for the Release lens (src/lib/releases.ts), the Issues page
// (src/lib/recurring.ts) and the review (src/lib/review.ts). No imports: the
// review's API route is bundled on its own, with no database client in it.

export type Audience = "seen_signed_in" | "seen_as_visitor" | "unknown";

// What a step's recorded actions say about the session: it filled a test
// credential, it recorded actions and filled none, or it recorded nothing.
// Issues reads the whole team's history and has D1 reduce each step to this
// word rather than ship every step's actions, so the rule here and the one
// there are the same rule over the same three answers.
export type StepFill = "credential" | "none" | "unrecorded";

export function stepFill(actions: string | null): StepFill {
  if (actions === null) return "unrecorded";
  return /\{\{TEST_(EMAIL|PASSWORD)(:[^}]*)?\}\}/.test(actions) ? "credential" : "none";
}

export interface AudienceStep {
  status: string;
  fill: StepFill;
  // CHE-393: the recorded fact; null or absent on rows before the column.
  signedIn?: boolean | null;
}

export function audienceOf(steps: AudienceStep[], index: number): Audience {
  const at = steps[index];
  // The fact, when the walk wrote one.
  if (at && typeof at.signedIn === "boolean") return at.signedIn ? "seen_signed_in" : "seen_as_visitor";
  // Rows before the column: the inference from the trail.
  const upTo = steps.slice(0, index + 1);
  if (upTo.some((s) => s.status !== "skipped" && s.fill === "credential")) return "seen_signed_in";
  return steps.some((s) => s.fill !== "unrecorded") ? "seen_as_visitor" : "unknown";
}

export function audienceAt(
  steps: Array<{ status: string; actions: string | null; signedIn?: boolean | null }>,
  index: number,
): Audience {
  return audienceOf(
    steps.map((s) => ({ status: s.status, fill: stepFill(s.actions), signedIn: s.signedIn ?? null })),
    index,
  );
}
