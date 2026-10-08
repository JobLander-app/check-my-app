// Run trigger. Starts the durable CheckRunWorkflow (defined in the agent worker,
// bound here cross-worker as CHECK_RUN) for a run. Replaces the old BullMQ
// enqueueRun — no Redis on Workers.

import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function triggerRun(runId: string): Promise<void> {
  const { env } = getCloudflareContext();
  const e = env as unknown as { CHECK_RUN?: Workflow; AGENT_DEV_URL?: string };

  // Production / cf:dev: the cross-worker Workflow binding is present.
  if (e.CHECK_RUN) {
    // The instance carries the run's id (CHE-423): a second create for the same
    // run — the sweep in src/agent/orphan-runs.ts re-handing off a run whose
    // first hand-off looked failed — is refused by the platform, so two
    // instances can never run one run.
    await e.CHECK_RUN.create({ id: runId, params: { runId } });
    return;
  }

  // Local `next dev`: no cross-worker binding exists. Forward to the agent
  // worker's HTTP /trigger so runs actually execute locally. The agent shares
  // the same local D1 (same database_id), so it reads the queued run. Start it
  // with `npm run agent:dev` (default :8787); override port via AGENT_DEV_URL.
  const agentUrl = e.AGENT_DEV_URL ?? "http://localhost:8787";
  try {
    const res = await fetch(`${agentUrl}/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
    });
    if (!res.ok) throw new Error(`agent /trigger returned ${res.status}`);
  } catch (err) {
    console.warn(
      `[trigger] could not reach the agent worker at ${agentUrl} — run ${runId} left queued. ` +
        `Start it with \`npm run agent:dev\`. (${err instanceof Error ? err.message : err})`,
    );
  }
}
