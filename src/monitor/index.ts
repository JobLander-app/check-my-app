// The monitor (CHE-486 part 3): a Tail Worker on checkmyapp-web and
// checkmyapp-agent (their `tail_consumers`). Cloudflare hands it every
// invocation of those workers as it ends; it keeps the ones that went wrong —
// an exception, an invocation out of CPU or memory, a 5xx answer — turns them
// into one report per signature (src/lib/prod-error.ts) and passes them to the
// agent worker, which files them for Mender. No schedule: an error in
// production is the trigger (owner, 2026-10-15).
//
// It holds no secret and touches no database; everything after the hand-off is
// the agent's.

import { reportsFrom, type ProdErrorReport, type TraceLike } from "../lib/prod-error";

interface MonitorEnv {
  AGENT: { report(reports: ProdErrorReport[]): Promise<void> };
}

export default {
  async tail(events: TraceItem[], env: MonitorEnv): Promise<void> {
    const reports = reportsFrom(events as unknown as TraceLike[]);
    if (!reports.length) return;
    try {
      await env.AGENT.report(reports);
    } catch (err) {
      // Logged, not thrown: a monitor that throws is an exception nobody tails.
      console.warn(`[monitor] hand-off failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
