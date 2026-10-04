// Who would have hit a problem seen on a given step: an existing, signed-in
// user, or a new visitor. The owner's question, from the Goran call
// (2026-10-01, 24:45): «it's kinda tricky that it doesn't break for the
// existing customers». Read from what the walk DID, not from what the model
// named the journey: on checkmyapp.dev the walker signs in during "signup" and
// "start-free-land" journeys too (#261, #264, #266), and AppJourney.surface is
// free text ("/public", "/authenticated", "app", "/both") or empty (every
// meetbashar.com journey but two). Each journey runs in a fresh browser
// (src/agent/workflow.ts), so a session is signed in only if this journey
// filled a test credential — and the walk records that fill as the
// {{TEST_EMAIL}} / {{TEST_EMAIL:<label>}} placeholder in Step.actions (CHE-129).
//   existing_users — a non-skipped step up to and including this one filled it;
//   new_visitors   — none did, and the journey recorded its actions;
//   unknown        — the journey recorded no actions at all (before CHE-129),
//                    so a sign-in could have happened unrecorded.
//
// One rule for the Release lens (src/lib/releases.ts), the Issues page
// (src/lib/recurring.ts) and the review (src/lib/review.ts). No imports: the
// review's API route is bundled on its own, with no database client in it.

export type Audience = "existing_users" | "new_visitors" | "unknown";

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

export function audienceOf(steps: Array<{ status: string; fill: StepFill }>, index: number): Audience {
  const upTo = steps.slice(0, index + 1);
  if (upTo.some((s) => s.status !== "skipped" && s.fill === "credential")) return "existing_users";
  return steps.some((s) => s.fill !== "unrecorded") ? "new_visitors" : "unknown";
}

export function audienceAt(steps: Array<{ status: string; actions: string | null }>, index: number): Audience {
  return audienceOf(steps.map((s) => ({ status: s.status, fill: stepFill(s.actions) })), index);
}
