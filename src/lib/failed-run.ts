// What a customer, or their agent, is told about a check that did not finish
// (CHE-329).
//
// Run #258 (joblander.app, 2026-09-27) died in synthesis on a provider refusal,
// and its public page printed the provider's body word for word —
// `403 {"error":{"type":"forbidden","message":"Request not allowed"}}` — under
// "We're looking at it. You'll get an email with a retry link." Nobody was
// looking (nothing reached our board), and no such email has ever existed.
// Rule 1: our plumbing is not their news. Rule 4: our failure publishes
// nothing degraded. The raw message stays on Run.errorMessage, for us.
//
// One sentence for every failed run, whoever's fault it was: the page cannot
// tell a customer's site that refused every connection from our own outage
// without the classification that lives on our board, and a sentence that
// guessed would be a claim resting on nothing (rule 3).
//
// Pure, no Next or workerd imports: the public loaders, the SSE route, the MCP
// tools and scripts/verify-failed-run.ts all read this.

export const FAILED_RUN_LINE = "This check didn't finish, so there is no verdict.";

// The only failure text that leaves through a public payload (GET
// /api/runs/{id}, the live stream, get_check_status / wait_for_run).
export function publicRunError(status: string): string | null {
  return status === "failed" ? FAILED_RUN_LINE : null;
}

// The status fields a public payload may carry, one rule for every door. A
// failed run publishes nothing (rule 4): no verdict, whatever its row holds,
// and no feed. The feed of a failed run is our
// own narration of how it died, and rows written before CHE-329 name our
// provider ("Internal error on our side (LLM provider budget)"); dropping the
// feed at the boundary covers those without a list of phrasings to keep up.
export function publicRunState<E>(run: { status: string; verdict: string | null; events: E[] | null }) {
  const failed = run.status === "failed";
  return {
    verdict: failed ? null : run.verdict,
    events: failed ? [] : run.events,
    errorMessage: publicRunError(run.status),
  };
}

// Whether we may say the check cost nothing. A failed run on a team's balance
// is priced 0 in the workflow's fail step (src/agent/pricing.ts priceRun, then
// voidRunPrice for one priced before a later step threw); a null price on a
// failed team run is the instant before that write. A run with no team was
// never on a balance — the free public check, or a $1 check paid through
// Stripe — so "it wasn't charged" would be either meaningless or untrue there,
// and is not said. The $1 check is made whole another way: its one re-check is
// on us (failedPaidCheck, CHE-335).
export function failedRunWasFree(run: { status: string; teamId: string | null; priceUsd: number | null }): boolean {
  return run.status === "failed" && run.teamId !== null && (run.priceUsd ?? 0) === 0;
}

// A $1 check that did not finish (CHE-335): the buyer paid for a verdict and
// got none, so one re-check is owed — src/lib/recheck.ts paidRetryOwed.
export function failedPaidCheck(run: { status: string; paidCheckoutSessionId: string | null }): boolean {
  return run.status === "failed" && run.paidCheckoutSessionId !== null;
}

export const PAID_RETRY_LINE = "You paid for this check, so running it again is on us.";
