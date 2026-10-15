// Waking Mender (CHE-445, CHE-486). It used to be a clock: GitHub's own
// schedule fired every 4–7 hours, so this worker's cron asked GitHub to start a
// tick every few minutes. Owner, 2026-10-15: «главное чтобы не было кронов, а
// триггерами монитора были ошибки в проде». Now Mender is woken by the event
// itself — a ticket filed for it — at the place that files it (wakeMender).
// Its reviews, its gate and its self-chaining are events too.
//
// The token is a fine-grained one that may only start workflows in this
// repository (actions: write). Without it this does nothing.

export const MENDER_REPO = "JobLander-app/check-my-app";
export const MENDER_WORKFLOW = "mender-agent.yml";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export async function dispatchMender(
  bindings: { MENDER_DISPATCH_TOKEN?: string },
  doFetch: Fetch = (url, init) => fetch(url, init),
): Promise<"dispatched" | "no-token"> {
  const token = bindings.MENDER_DISPATCH_TOKEN;
  if (!token) return "no-token";
  const res = await doFetch(`https://api.github.com/repos/${MENDER_REPO}/actions/workflows/${MENDER_WORKFLOW}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "checkmyapp-agent",
    },
    body: JSON.stringify({ ref: "main" }),
    // A stalled GitHub must not hold whatever filed the ticket (CodeRabbit, #307).
    signal: AbortSignal.timeout(5_000),
  });
  if (res.status !== 204) throw new Error(`GitHub answered ${res.status} to the Mender dispatch`);
  return "dispatched";
}

/**
 * Wake Mender because something was just filed for it. Never throws: a ticket
 * that exists is not undone by a GitHub that did not answer — the next event
 * wakes Mender again, and every tick takes the oldest work first.
 */
export async function wakeMender(
  bindings: { MENDER_DISPATCH_TOKEN?: string },
  why: string,
  doFetch?: Fetch,
): Promise<"dispatched" | "no-token" | "failed"> {
  try {
    const result = await dispatchMender(bindings, doFetch);
    if (result === "dispatched") console.log(`[mender] woken: ${why}`);
    return result;
  } catch (err) {
    console.warn(`[mender] could not be woken (${why}): ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
}
