// CHE-454: a stopped check gives the session host back.
//
// Stopping a check terminates its Workflow at once, so nothing inside the run
// reaches its own `releaseSession` — the catch block that frees the host never
// runs. Left alone, the lease of a stopped Shopify check would hold the one
// signed-in browser for the rest of SESSION_LEASE_SECONDS, and every check
// behind it would wait for a check nobody wants any more. The scheduler tick
// hands it back instead: every session run stopped within one lease is
// released. The release names the run, so it frees nothing another run holds,
// and asking twice is harmless.

import { releaseSession, sessionHost, SESSION_KIND, SESSION_LEASE_SECONDS, type SessionHost } from "./session-browser";
import type { AgentEnv } from "./env";

export async function releaseCanceledLeases(
  env: AgentEnv,
  now: Date,
  release: (host: SessionHost, runId: string) => Promise<boolean> = releaseSession,
): Promise<string[]> {
  const stopped = await env.db.run.findMany({
    where: {
      status: "canceled",
      targetKind: SESSION_KIND,
      completedAt: { gte: new Date(now.getTime() - SESSION_LEASE_SECONDS * 1000) },
    },
    select: { id: true },
  });
  if (stopped.length === 0) return [];
  const host = sessionHost(env.bindings);
  const released: string[] = [];
  for (const run of stopped) {
    if (await release(host, run.id)) released.push(run.id);
  }
  return released;
}
