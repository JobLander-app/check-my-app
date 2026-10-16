// CHE-486 part 3: the monitor worker's way in (service binding AGENT →
// checkmyapp-agent, entrypoint ProdErrorIntake in wrangler-monitor.jsonc). An
// entrypoint rather than a route, so nothing on the internet can post errors
// here: only a worker this account binds to it can call it. The work is in
// prod-errors.ts, which plain Node can load for its acceptance script.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { ProdErrorReport } from "@/lib/prod-error";
import { makeAgentEnv, type AgentBindings } from "./env";
import { intakeProdErrors } from "./prod-errors";

export class ProdErrorIntake extends WorkerEntrypoint<AgentBindings> {
  async report(reports: ProdErrorReport[]): Promise<void> {
    try {
      const { filed, told } = await intakeProdErrors(makeAgentEnv(this.env), reports);
      if (filed.length || told.length) console.log(`[prod-error] filed ${filed.join(", ") || "none"}, told ${told.join(", ") || "none"}`);
    } catch (err) {
      // Never an exception: the monitor would hand it straight back.
      console.warn(`[prod-error] intake failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
