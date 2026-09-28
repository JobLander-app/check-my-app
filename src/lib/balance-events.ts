// CHE-327: the one call every door that refuses a check makes, so the refusal
// is counted the same way wherever it happened — the dashboard, the API, MCP,
// a re-check, a watch's tick. `capture` is injectable for the same reason as
// elsewhere: a verify script must never post to PostHog. Whom it belongs to:
// the person who pressed (or whose watch ticked); the team rides along as a
// property so exhausted → top-up / upgrade can be read per team.

import { captureServer, serverDistinctId, type ServerAnalyticsEvents } from "@/lib/analytics-server";

export async function captureBalanceExhausted(
  capture: typeof captureServer | undefined,
  e: { distinctId: string | null; teamId: string; plan: string; source: ServerAnalyticsEvents["balance_exhausted"]["source"] },
): Promise<void> {
  if (!capture) return;
  const who = serverDistinctId(null, e.distinctId, `team:${e.teamId}`);
  await capture("balance_exhausted", who.distinctId, { plan: e.plan, source: e.source, teamId: e.teamId, ...who.extra });
}

// A refusal code that means "the team's balance is used" — the two codes
// admitTeamCheck returns (src/lib/plans.ts).
export function isBalanceExhausted(code: string | undefined | null): boolean {
  return code === "quota_free" || code === "quota_balance";
}
