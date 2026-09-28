// Pricing a finished check onto its team's balance (CHE-327). The rules —
// price = cost × the plan's multiplier, the plan's credit before the bought
// balance, our failure is free — are in src/lib/plans.ts; this is the write,
// done by the workflow (and nobody else) when a run ends.
//
// No `cloudflare:workers` import, so scripts/verify-balance.ts drives these
// exact functions against a stub database.

import type { PrismaClient } from "@/generated/prisma/client";
import type { UserPlan } from "@/lib/enums";
import { priceForCost, splitPrice, teamBalance } from "@/lib/plans";

// Price a finished run and take it off the balance. Idempotent: the price is
// written only onto a row that has none (the claim), and only the caller that
// won the claim touches the team's bought balance — a Workflow step that
// retries finds the row priced and does nothing. A failed or canceled run is
// priced 0. An anonymous run belongs to no balance and stays unpriced.
export async function priceRun(db: PrismaClient, runId: string, now: Date = new Date()): Promise<number | null> {
  const run = await db.run.findUnique({
    where: { id: runId },
    select: { teamId: true, costUsd: true, status: true, priceUsd: true, team: { select: { plan: true } } },
  });
  if (!run?.teamId || run.priceUsd !== null) return run?.priceUsd ?? null;
  const plan = (run.team?.plan ?? "free") as UserPlan;
  const price = run.status === "failed" || run.status === "canceled" ? 0 : priceForCost(plan, run.costUsd ?? 0);
  const balance = await teamBalance(db, { id: run.teamId, plan }, now);
  const creditLeft = balance.creditUsd === null ? null : balance.creditUsd - balance.planSpentUsd;
  const { fromTopupUsd } = splitPrice(price, creditLeft);
  const claimed = await db.run.updateMany({
    where: { id: runId, priceUsd: null },
    data: { priceUsd: price, priceFromTopupUsd: fromTopupUsd },
  });
  if (claimed.count === 1 && fromTopupUsd > 0) {
    await db.team.update({ where: { id: run.teamId }, data: { topupUsd: { decrement: fromTopupUsd } } });
  }
  return price;
}

// A run that failed after it was priced (a later step threw) costs nothing
// after all: price 0, and the part that came off the bought balance goes back.
// Claimed on the exact values read, so two callers cannot both give it back.
export async function voidRunPrice(db: PrismaClient, runId: string): Promise<void> {
  const run = await db.run.findUnique({
    where: { id: runId },
    select: { teamId: true, priceUsd: true, priceFromTopupUsd: true },
  });
  if (!run?.teamId || run.priceUsd === 0) return;
  const claimed = await db.run.updateMany({
    where: { id: runId, priceUsd: run.priceUsd, priceFromTopupUsd: run.priceFromTopupUsd },
    data: { priceUsd: 0, priceFromTopupUsd: 0 },
  });
  if (claimed.count === 1 && run.priceFromTopupUsd > 0) {
    await db.team.update({ where: { id: run.teamId }, data: { topupUsd: { increment: run.priceFromTopupUsd } } });
  }
}
