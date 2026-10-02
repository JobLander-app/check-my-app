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
//     own navigation on it is the app answering, and the walk can read it;
//   - and, for an app we have looked at before, an address it is already
//     known to have is turned away too.
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

/** How many addresses the app is already known to have are tried behind a closed first page. */
export const DOOR_DEEP_TRIES = 2;

/**
 * Addresses of the app other than its first page, from what an earlier look at
 * it found (the survey's pages). An app we already know can have a closed
 * first page and an open product — its root an API or a bucket index — so a
 * known address is tried before the door is called closed (review of PR #238).
 * Same origin only; the first page itself is not "deeper".
 */
export function deepAddresses(targetUrl: string, known: Iterable<string>): string[] {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return [];
  }
  const path = (u: URL) => u.pathname.replace(/\/+$/, "") || "/";
  const out = new Set<string>();
  for (const raw of known) {
    try {
      const u = new URL(raw, target);
      if (u.origin !== target.origin || path(u) === path(target)) continue;
      u.hash = "";
      out.add(u.toString());
    } catch {
      /* not an address */
    }
  }
  return [...out];
}

/** A known address that opened: the product is there, whatever its first page said. */
export function opensBehindDoor(status: number | null): boolean {
  return status !== null && status >= 200 && status < 400;
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
    "and this check was not charged. An address that opens for a visitor who is not signed in to " +
    "anything is what would let us check it."
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
 * Idempotent for a retried Workflow step, write by write: the journey is
 * written once and so is its step. A retry after the journey was written and
 * the step was not still owes the step — the step is what carries the gap to
 * our board, and a journey without it would publish Not verified with nothing
 * filed (found on the signed-out exit modelled on this one, CHE-389).
 */
export async function completeClosedDoor(
  env: Pick<AgentEnv, "db">,
  run: { id: string; targetUrl: string },
  door: ClosedDoor,
): Promise<"unverified"> {
  const journey =
    (await env.db.journey.findFirst({ where: { runId: run.id, title: DOOR_JOURNEY_TITLE }, select: { id: true } })) ??
    (await env.db.journey.create({
      data: { runId: run.id, order: 0, title: DOOR_JOURNEY_TITLE, status: "skipped", summary: doorObserved(door) },
      select: { id: true },
    }));
  const step = await env.db.step.findFirst({ where: { journeyId: journey.id }, select: { id: true } });
  if (!step) {
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
