// CHE-475: the sentence a step carries when a request of the product's own
// fails for the page and again when asked from outside (src/agent/tools.ts,
// coerceOwnRequestFailure). Pure and guarded (docs/CODE_STANDARDS.md R18): it
// speaks of the product only (CLAUDE.md §1), and it publishes the address
// without its query, which can carry a signed token (Codex, #344).
//
// scripts/verify-own-request-failure.ts runs every variant through the leak
// and homework guards.

/** How the second request went: the product's own error status, or no answer at all. */
export type FailedRequestAnswer = { kind: "status"; status: number } | { kind: "timeout" } | { kind: "unreachable" };

/** The address as published: origin and path, never the query or the fragment. */
export function publishedAddress(href: string): string {
  const u = new URL(href);
  return `${u.origin}${u.pathname}`;
}

export function failedRequestSentence(href: string, answer: FailedRequestAnswer): string {
  const says =
    answer.kind === "status"
      ? `it answers HTTP ${answer.status}`
      : answer.kind === "timeout"
        ? "it does not answer"
        : "the connection cannot be completed";
  return `The page requests ${publishedAddress(href)} and that request fails: ${says}. Whatever depends on it does not load.`;
}
