// Loading what the verdict rules read (CHE-42, CHE-365, CHE-372).
//
// The rules — zero coverage is never a pass, walking only the access gate is
// zero coverage too, "broken" needs a body — live in ./verdict-integrity.ts,
// pure. This is the one read the workflow does for them. It lives outside
// workflow.ts so scripts/verify-store-password.ts can run it over a stub
// database: a rule fed the wrong facts by its loader is as wrong as a wrong
// rule, and only a test of the loader sees that.

import type { Verdict } from "@/lib/enums";
import type { AgentEnv } from "./env";
import { judgeVerdictIntegrity, type IntegrityResult } from "./verdict-integrity";

export async function checkVerdictIntegrity(
  env: AgentEnv,
  runId: string,
  synth: { verdict: Verdict; bottomLine: string | null },
): Promise<IntegrityResult> {
  const journeys = await env.db.journey.findMany({
    where: { runId },
    select: {
      status: true,
      steps: { select: { status: true, unverifiedReason: true, actions: true } },
    },
  });
  const findings = await env.db.finding.findMany({
    where: { runId },
    select: { category: true, severity: true },
  });
  // CHE-372: read before the cleanup step clears a one-off run's store
  // password, which runs after the verdict is written — so the bottom line
  // asks for the store password only when the run truly had none.
  const run = await env.db.run.findUnique({
    where: { id: runId },
    select: { targetUrl: true, storePasswordEnc: true, storePasswordState: true },
  });
  const checked = judgeVerdictIntegrity(journeys, findings, synth, run?.targetUrl, {
    storePassword: Boolean(run?.storePasswordEnc),
    storePasswordRejected: run?.storePasswordState === "rejected",
  });
  if (checked.verdict !== synth.verdict) {
    console.log(`[verdict] run ${runId}: synthesis said ${synth.verdict}, recorded ${checked.verdict}`);
  }
  return checked;
}
