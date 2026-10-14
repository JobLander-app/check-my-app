// CHE-454: a stopped check gives the session browser back.
//
// Stopping a check terminates its Workflow at once, so nothing inside the run
// reaches its own `releaseSession` — the catch block that frees the host never
// runs. Left alone, the lease of a stopped Shopify check would hold the one
// signed-in browser for the rest of SESSION_LEASE_SECONDS, and every check
// behind it would wait for a check nobody wants any more. The scheduler tick
// hands it back instead: every session run stopped within one lease is
// released. The release names the run, so it frees nothing another run holds,
// and asking twice is harmless.

import { releaseSession, runSessionSlot, sessionHost, SESSION_KIND, SESSION_LEASE_SECONDS, type SessionHost } from "./session-browser";
import type { AgentEnv } from "./env";
import type { PrismaClient } from "@/generated/prisma/client";
import { systemWide } from "@/lib/tenant-db";
import { zeroCanceledPrice } from "@/lib/run-cancel";

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
    select: { id: true, teamId: true, app: { select: { ownerId: true } } },
  });
  if (stopped.length === 0) return [];
  const released: string[] = [];
  // CHE-482: each run's lease is in the browser of its store's connector.
  for (const run of stopped) {
    const slot = runSessionSlot(run);
    if (!slot) continue;
    try {
      if (await release(sessionHost(env.bindings, slot), run.id)) released.push(run.id);
    } catch (error) {
      console.warn(`[cancel] could not release ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return released;
}

/**
 * The scheduler's half of a stopped check's refund (Codex on #329): every
 * stopped check whose price is not yet 0 — the stop's own zeroing failed, or a
 * priced step landed after it — is zeroed on the next tick, and the bought
 * balance it took goes back. Returns the runs it settled.
 */
export async function settleCanceledPrices(db: PrismaClient): Promise<string[]> {
  const rows = await db.run.findMany({
    ...systemWide("scheduler"),
    where: { status: "canceled", teamId: { not: null }, OR: [{ priceUsd: null }, { priceUsd: { not: 0 } }] },
    select: { id: true },
    take: 50,
  });
  const settled: string[] = [];
  for (const r of rows) {
    try {
      await zeroCanceledPrice(db, r.id);
      settled.push(r.id);
    } catch (e) {
      console.warn(`[cancel] settling ${r.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return settled;
}
