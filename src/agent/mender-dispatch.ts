// Mender's reliable clock (CHE-445). GitHub fired the workflow's own schedule
// every 4–7 hours instead of every 30 minutes, so a labelled ticket waited half
// a day for its first tick. This worker's cron is on time, so each tick asks
// GitHub to start one Mender tick; an idle one ends at its `peek` step in
// seconds (scripts/mender/agent.mjs).
//
// The token is a fine-grained one that may only start workflows in this
// repository (actions: write). Without it this does nothing — the workflow's
// own schedule and its self-chaining still run.

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
      "User-Agent": "checkmyapp-scheduler",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  if (res.status !== 204) throw new Error(`GitHub answered ${res.status} to the Mender dispatch`);
  return "dispatched";
}
