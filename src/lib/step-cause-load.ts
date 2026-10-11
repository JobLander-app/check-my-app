// A run's unchecked steps, read and grouped by cause (CHE-443). The one reader
// behind the admin's "Needs your attention" card, the mail the admin gets once
// per cause, and the unchecked share a daily digest counts — so the three can
// never disagree about what a run left unchecked.

import type { PrismaClient } from "@/generated/prisma/client";
import { causeOfStep, summarizeCauses, type CauseSummary, type StepCause } from "@/lib/step-cause";
import { teamOwned } from "@/lib/tenant-db";

export interface CauseGroup {
  cause: StepCause;
  /** How many steps of the run it kept unchecked. */
  steps: number;
  /** A few of them, by name, in walk order. */
  labels: string[];
}

export interface RunCauses {
  summary: CauseSummary;
  /** Every cause the run's steps carry, most steps first. Our defects are not here: they have no cause. */
  groups: CauseGroup[];
}

const LABELS_PER_GROUP = 3;

/**
 * The causes of one run's unchecked steps. `walkedOnly` leaves out journeys the
 * run carried forward from an earlier one — what the run itself walked, which
 * is what a mail about "this run" and a share "per run" count; the app's page
 * wants them all, since a carried step is still what the app looks like now.
 */
export async function causesOfRun(db: PrismaClient, runId: string, opts: { walkedOnly: boolean }): Promise<RunCauses> {
  const steps = await db.step.findMany({
    where: { journey: { runId, ...(opts.walkedOnly ? { carriedFromRunId: null } : {}) } },
    select: { label: true, status: true, unverifiedReason: true, gapClass: true, observed: true, attempted: true },
    orderBy: [{ journey: { order: "asc" } }, { order: "asc" }],
  });
  const byCause = new Map<StepCause, CauseGroup>();
  for (const step of steps) {
    const outcome = causeOfStep(step);
    if (!outcome || !("cause" in outcome)) continue;
    const group = byCause.get(outcome.cause) ?? { cause: outcome.cause, steps: 0, labels: [] };
    group.steps++;
    if (group.labels.length < LABELS_PER_GROUP && !group.labels.includes(step.label)) group.labels.push(step.label);
    byCause.set(outcome.cause, group);
  }
  return { summary: summarizeCauses(steps), groups: [...byCause.values()].sort((a, b) => b.steps - a.steps || a.cause.localeCompare(b.cause)) };
}

/** The causes of the app's latest finished check, or null when it has none yet. */
export async function causesOfAppsLatestRun(db: PrismaClient, teamId: string, appId: string): Promise<(RunCauses & { runNumber: number }) | null> {
  const run = await db.run.findFirst({
    where: { ...teamOwned(teamId), appId, status: { in: ["completed", "partial"] }, verdict: { not: null } },
    orderBy: { runNumber: "desc" },
    select: { id: true, runNumber: true },
  });
  if (!run) return null;
  return { ...(await causesOfRun(db, run.id, { walkedOnly: false })), runNumber: run.runNumber };
}
