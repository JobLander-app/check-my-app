// A run whose hand-off to the agent never landed (CHE-423).
//
// Every door inserts the Run as `queued` and THEN asks the CHECK_RUN binding to
// start a Workflow instance for it (src/lib/trigger.ts, the scheduler, POST
// /trigger). If that second call throws, the row is a fact with nothing behind
// it: no instance will ever move it, and every reader that asks "is anything
// still running" — the saved app's `alreadyRunning`, the watch's in-flight
// count — sees a live run for ever. Nothing had picked such a row up.
//
// This is the pick-up, run on every scheduler tick. For each run that has been
// `queued` longer than a healthy hand-off takes:
//
//   1. hand it off again — under the run's own id. Instances are created with
//      `id: runId` everywhere, so a second create for a run that already has
//      one is refused by the platform, and two instances can never run one run;
//   2. if the platform refuses because the instance exists, there is nothing to
//      do: the hand-off did land and the workflow owns the row (a run waiting
//      for the extension session host is also `queued` for a long time, and
//      must not be touched). Only an instance that is over — errored or
//      terminated before it could write anything — leaves the run orphaned;
//   3. if the hand-off keeps failing past GIVE_UP_AFTER_MINUTES, end the run.
//
// Ending is `failed` with an "internal:" reason, priced 0, passwords cleared —
// exactly what the workflow's own fail step does (rule 4: our failure reaches
// the customer as "this check didn't finish", never as a degraded verdict, and
// costs them nothing). It is not `canceled`: a canceled run renders as an
// empty verdict page and counts against an anonymous visitor's daily checks,
// where a failed one gets the "didn't finish" page, is not counted
// (src/lib/checks-today.ts) and owes a paid check its re-check (CHE-335).

import type { PrismaClient } from "@/generated/prisma/client";
import { priceRun, voidRunPrice } from "./pricing";
import { clearedCredentials } from "@/lib/test-accounts";
import { answerGitHub, getGitHubAppEnv } from "@/lib/github-app";
import { fileRunFailure } from "./run-failures";
import type { AgentEnv } from "./env";

// A hand-off is one binding call; a queued run older than this has not had one.
// The cron fires every 15 minutes, so the real wait is this plus up to a tick.
export const REHAND_AFTER_MINUTES = 5;
// Past this the binding is not coming back soon enough to be worth a customer's
// wait: the run ends instead of staying a live run that blocks its app.
export const GIVE_UP_AFTER_MINUTES = 30;
// Bounded work per tick, oldest first; the rest wait for the next one.
const SWEEP_LIMIT = 20;
// A watch whose run died before it began tries again soon, as it does after
// our budget runs out (src/agent/workflow.ts), not after a whole interval.
const WATCH_RETRY_HOURS = 2;

export const ORPHAN_RUN_MESSAGE = "internal: the hand-off to the agent did not land — nothing was run";

// What the sweep needs of the CHECK_RUN binding, so a script can fail it.
export interface HandOff {
  create(options: { id: string; params: { runId: string } }): Promise<unknown>;
  get(id: string): Promise<{ status(): Promise<{ status: string }> }>;
}

export interface OrphanSweepDeps {
  workflow?: HandOff;
  // The two things that follow a run ending for our reasons; injectable only
  // for the acceptance script, which has no board and no GitHub.
  file?: typeof fileRunFailure;
  answer?: (runId: string) => Promise<unknown>;
}

export interface OrphanSweepResult {
  handedOff: string[];
  ended: string[];
}

// An instance in one of these states will never move the row again.
const OVER = new Set(["errored", "terminated", "complete"]);

export async function sweepOrphanedRuns(
  env: AgentEnv,
  now: Date = new Date(),
  deps: OrphanSweepDeps = {},
): Promise<OrphanSweepResult> {
  const workflow = deps.workflow ?? (env.bindings.CHECK_RUN as unknown as HandOff);
  const stale = await env.db.run.findMany({
    where: { status: "queued", createdAt: { lt: new Date(now.getTime() - REHAND_AFTER_MINUTES * 60_000) } },
    orderBy: { createdAt: "asc" },
    take: SWEEP_LIMIT,
    select: { id: true, createdAt: true },
  });

  const result: OrphanSweepResult = { handedOff: [], ended: [] };
  for (const run of stale) {
    try {
      const outcome = await recover(workflow, run.id, ageMinutes(run.createdAt, now));
      if (outcome === "handed-off") {
        result.handedOff.push(run.id);
        console.warn(`[orphan-runs] run ${run.id} had no instance — handed off again`);
      } else if (outcome === "end") {
        if (await endOrphan(env, run.id, now, deps)) result.ended.push(run.id);
      }
    } catch (err) {
      // One run must not keep the others from being looked at.
      console.warn(`[orphan-runs] run ${run.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

const ageMinutes = (since: Date, now: Date) => (now.getTime() - since.getTime()) / 60_000;

async function recover(workflow: HandOff, runId: string, age: number): Promise<"handed-off" | "leave" | "end"> {
  try {
    await workflow.create({ id: runId, params: { runId } });
    return "handed-off";
  } catch (createErr) {
    // Refused, or failed: only the instance can tell which.
    let state: string | null;
    try {
      state = (await (await workflow.get(runId)).status()).status;
    } catch {
      // No instance, and the create did not make one: the hand-off is failing.
      console.warn(`[orphan-runs] run ${runId} hand-off failed: ${createErr instanceof Error ? createErr.message : String(createErr)}`);
      return age >= GIVE_UP_AFTER_MINUTES ? "end" : "leave";
    }
    return OVER.has(state) && age >= GIVE_UP_AFTER_MINUTES ? "end" : "leave";
  }
}

// Returns whether this call ended the run: the update is conditional on the row
// still being queued, so a workflow that started in the meantime wins.
async function endOrphan(env: AgentEnv, runId: string, now: Date, deps: OrphanSweepDeps): Promise<boolean> {
  const run = await env.db.run.findUnique({
    where: { id: runId },
    select: { watchId: true, testAccounts: true },
  });
  if (!run) return false;
  const ended = await env.db.run.updateMany({
    where: { id: runId, status: "queued" },
    data: {
      status: "failed",
      errorMessage: ORPHAN_RUN_MESSAGE,
      completedAt: now,
      // A watch run keeps its login for the next tick; a one-off loses it.
      ...(run.watchId ? {} : clearedCredentials(run)),
    },
  });
  if (ended.count !== 1) return false;
  console.error(`[orphan-runs] run ${runId} ended: ${ORPHAN_RUN_MESSAGE}`);

  // Nothing ran, so nothing is charged — priced 0 (never throws the sweep).
  await priceRun(env.db, runId)
    .then(() => voidRunPrice(env.db, runId))
    .catch((e) => console.warn(`[orphan-runs] zeroing run ${runId} did not happen: ${e instanceof Error ? e.message : String(e)}`));
  if (run.watchId) {
    await env.db.watch
      .update({ where: { id: run.watchId }, data: { nextRunAt: new Date(now.getTime() + WATCH_RETRY_HOURS * 3_600_000) } })
      .catch(() => {});
  }
  // A deploy the GitHub App started must not stay "in progress" on the commit.
  await (deps.answer ?? ((id: string) => answerGitHubFor(env, id)))(runId).catch((e) =>
    console.warn(`[orphan-runs] run ${runId}: GitHub check run not completed: ${e instanceof Error ? e.message : String(e)}`),
  );
  // And on our own board: a hand-off that fails is ours (rule 8, bookkeeping).
  await (deps.file ?? fileRunFailure)(env, runId, { message: ORPHAN_RUN_MESSAGE, budget: false, phase: "queued" });
  return true;
}

function answerGitHubFor(env: AgentEnv, runId: string): Promise<unknown> {
  return answerGitHub(env.db as PrismaClient, getGitHubAppEnv(env.bindings as unknown as Record<string, unknown>), runId, {
    baseUrl: env.bindings.APP_URL ?? "https://checkmyapp.dev",
    fetch: (url, init) => fetch(url, init),
  });
}
