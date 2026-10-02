// A target whose own first page turns us away (CHE-390).
//
// Run #292: a new account pointed its first check at an address that answered
// 403 on every path, the first page included. Discovery still proposed a
// journey, the walk "found" the same 403 three times, synthesis wrote a
// finding, and the customer read "Broken — Entire origin returns 403 Forbidden
// … a server access restriction blocking our origin", priced $0.28. Nothing of
// their product had been seen. That is rule 8 in one run: a claim about the
// customer's product resting on our not getting in.
//
// So the door is decided where it is first met — by the surface scan, in code,
// before a model sees anything — and a closed door ends the run there:
// Not verified, nothing spent, nothing charged, no finding possible, and the
// gap on our own board (rule 2). What counts as closed:
//   - the first page answers 401 or 403;
//   - a second try a few seconds later answers the same — a bot challenge that
//     lets a browser through once its script has run is not a closed door;
//   - the page carries no link into the product — a 403 page with the app's
//     own navigation on it is the app answering, and the walk can read it.
// A 5xx is not this: a site that is down is a legitimate "broken".
//
// No Playwright and no `cloudflare:workers` here, so
// scripts/verify-closed-door.ts drives these exact functions.

import type { AgentEnv } from "./env";

export type ClosedDoor = "unauthorized" | "forbidden";

/** How long the first page gets before it is asked a second time. */
export const DOOR_RETRY_WAIT_MS = 4_000;

const turnedAway = (status: number | null): boolean => status === 401 || status === 403;

/** Is the first page a closed door? Null = no; the run goes on as it always did. */
export function closedDoor(first: number | null, second: number | null, internalLinks: number): ClosedDoor | null {
  if (internalLinks > 0) return null;
  if (!turnedAway(first) || !turnedAway(second)) return null;
  return second === 401 ? "unauthorized" : "forbidden";
}

const ANSWER: Record<ClosedDoor, string> = {
  forbidden: 'answered "403 Forbidden"',
  unauthorized: 'asked for a sign-in at the address itself ("401 Unauthorized")',
};

// Customer-facing. What happened at their address, that it is not a verdict,
// that it cost nothing, and the one thing rule 2 lets us ask for — an address
// we can open. Nothing about how we check.
export function doorBottomLine(door: ClosedDoor): string {
  return (
    `We could not open your app this run: its first page ${ANSWER[door]} before anything loaded, ` +
    "and did the same on a second try. Nothing was checked, so this is not a verdict on your app, " +
    "and this check was not charged. An address that opens without that is what would let us check it."
  );
}

export function doorObserved(door: ClosedDoor): string {
  return `The first page ${ANSWER[door]} before anything loaded, twice. Nothing behind it was checked this run.`;
}

export const DOOR_JOURNEY_TITLE = "Open the app";
export const DOOR_STEP_LABEL = "Open the first page";

/**
 * End the run at the closed door: one journey with one skipped step that
 * carries our gap, verdict Not verified, cost 0 (so priceRun prices it 0).
 * Idempotent for a retried Workflow step: the journey is written once.
 */
export async function completeClosedDoor(
  env: Pick<AgentEnv, "db">,
  run: { id: string; targetUrl: string },
  door: ClosedDoor,
): Promise<"unverified"> {
  const existing = await env.db.journey.findFirst({ where: { runId: run.id, title: DOOR_JOURNEY_TITLE }, select: { id: true } });
  if (!existing) {
    const journey = await env.db.journey.create({
      data: { runId: run.id, order: 0, title: DOOR_JOURNEY_TITLE, status: "skipped", summary: doorObserved(door) },
    });
    await env.db.step.create({
      data: {
        journeyId: journey.id,
        order: 0,
        label: DOOR_STEP_LABEL,
        status: "skipped",
        attempted: `Opened ${run.targetUrl}`,
        observed: doorObserved(door),
        unverifiedReason: "our_capability",
        gapClass: "target_door",
      },
    });
  }
  await env.db.run.update({
    where: { id: run.id },
    data: {
      status: "partial",
      verdict: "unverified",
      bottomLine: doorBottomLine(door),
      errorMessage: null,
      currentAction: null,
      completedAt: new Date(),
      costUsd: 0,
    },
  });
  return "unverified";
}
