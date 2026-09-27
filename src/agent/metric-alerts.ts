// What moved, for the notification the Watch already sends (CHE-241).
//
// Not a second product. The same email, the same webhook, the same tracker
// path — a metric alert that arrives in its own channel is a channel nobody
// subscribes to, and the whole value of this is that it lands where the owner
// is already looking every morning.
//
// The judgement itself lives in src/lib/metric-movement.ts, which is pure and
// knows nothing about runs, verdicts or emails. That separation is the
// mechanism behind the ticket's last requirement: "a verdict of all good with a
// conversion that fell is not a contradiction and must not be smoothed into
// one." Nothing here consults the verdict, so nothing here can be overruled by
// it. The app works AND fewer people finish; both sentences stand.

import type { AgentEnv } from "./env";
import { isAlertable, movementOf, movementSentence, type MetricPoint } from "@/lib/metric-movement";
import { flowChanges, pairedSentence } from "@/lib/flow-changes";
import { namesAChangedPage } from "@/lib/funnel";
import { pathEndsOf as measuredPath } from "@/lib/posthog/measure";
import { parseJson } from "@/lib/json";

/** How much history to read. Enough for a baseline, not enough to be slow. */
const POINTS_TO_READ = 12;

/**
 * The pages this run's survey found different from the last comparable one
 * (CHE-285).
 *
 * The survey has always taken this diff and always stored it — `AppSnapshot.diff`,
 * reached from `Run.snapshotId` — and the pairing has always declined to speak
 * about it, on the grounds that it was "not joined here". So it is joined here.
 *
 * `changed === true` is the whole comparability test: the survey writes a diff
 * only when two snapshots were actually comparable, and `changed` stays NULL
 * otherwise (a first snapshot, a blocked homepage, a survey with too little in
 * common with the last one). A run with no answer contributes no paths, never
 * every path.
 *
 * Never throws: a diff we could not read costs one line of the pairing. It does
 * not cost the movement, which is the news.
 */
async function changedPagesOf(env: AgentEnv, runId: string): Promise<string[]> {
  try {
    const run = await env.db.run.findUnique({ where: { id: runId }, select: { snapshotId: true } });
    if (!run?.snapshotId) return [];
    const snap = await env.db.appSnapshot.findUnique({
      where: { id: run.snapshotId },
      select: { changed: true, diff: true },
    });
    if (snap?.changed !== true) return [];
    const diff = parseJson<{ changedPaths?: string[]; addedPaths?: string[] }>(snap.diff);
    // Changed AND appeared, the same union the prompts read (knowledge.ts). A
    // page that was not there last time is not the page it was either. Removed
    // paths are deliberately absent: a stage whose page is gone is a broken
    // journey, which the walk says far better than this sentence could.
    return [...(diff?.changedPaths ?? []), ...(diff?.addedPaths ?? [])];
  } catch (err) {
    console.warn(
      `[metric-alert] could not read the page diff: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * The status the previous walk of this journey came back with (CHE-321).
 *
 * The pairing used to read the "before" status from the catalog row. But
 * `recordWalk` writes this run's status into that row the moment the walk
 * ends, long before the mail is composed, so the pairing compared the walk
 * with itself and a status change could never be said — while the sentence
 * went on to state "Nothing changed in this flow". The previous walk's own
 * Journey row is the before that is still there.
 *
 * Only walks of this journey that really happened and came before this run:
 * a carried copy is not a walk, and an all-skipped one saw nothing. Null when
 * there is none, and then no status change is claimed.
 *
 * Status only. The catalog's `plan` has the same flaw, and the previous walk's
 * step labels are NOT the fix: each walk words its steps afresh ("Sign in with
 * test account" / "Log in with test credentials" for the same click on
 * joblander.app, runs #251 and #254), so diffing them would announce steps
 * that appeared and vanished in a flow nobody changed. Comparing steps needs a
 * stable identity for a step, which is journey work, and journey work is
 * paused (owner, 2026-09-27). Filed as CHE-323.
 */
async function previousStatusOf(
  env: AgentEnv,
  appJourneyId: string,
  runId: string,
  before: Date,
): Promise<string | null> {
  const prev = await env.db.journey.findFirst({
    where: {
      appJourneyId,
      runId: { not: runId },
      carriedFromRunId: null,
      status: { not: "skipped" },
      run: { createdAt: { lt: before } },
    },
    orderBy: { run: { createdAt: "desc" } },
    select: { status: true },
  });
  return prev?.status ?? null;
}

export interface MetricAlert {
  journeyTitle: string;
  /** The sentence the owner reads. Already rule-1 clean. */
  sentence: string;
}

/**
 * Journeys of this run whose measured conversion moved enough to say so.
 *
 * Returns only falls: a rise is good news and good news does not need a siren
 * (the sentence for it still exists, and belongs on the page rather than in
 * someone's inbox).
 *
 * Never throws. A movement we could not compute is one the owner does not hear
 * about — it is not a reason for a verdict email to fail.
 */
export async function metricAlertsForRun(env: AgentEnv, runId: string): Promise<MetricAlert[]> {
  try {
    const journeys = await env.db.journey.findMany({
      where: { runId, appJourneyId: { not: null } },
      select: {
        // CHE-242: this run's own view of the flow, for the half PostHog
        // cannot have. Read beside the numbers rather than in a second query,
        // because the two belong in one message.
        order: true,
        status: true,
        appJourneyId: true,
        steps: { orderBy: { order: "asc" }, select: { label: true } },
        appJourney: {
          select: {
            title: true,
            price: true,
            prevPrice: true,
            plan: true,
            // The pages this journey runs on, as the app holds them rather than
            // as this run happened to walk them (CHE-285).
            funnelStages: true,
            metricPoints: {
              orderBy: { measuredAt: "desc" },
              take: POINTS_TO_READ,
              // `steps` names the two pages the newest count was taken between.
              // The alert sentence says what moved along that path rather than
              // that fewer people finished, so it cannot be written without
              // them (CHE-279).
              select: { conversion: true, sampleSize: true, measuredAt: true, steps: true },
            },
          },
        },
      },
    });

    // A finding belongs to the run and points at its journey through `anchor`
    // — our own internal record of what it was allowed to rest on (CHE-215).
    // Only the finding's TITLE crosses into the message; the anchor never does.
    const findings = await env.db.finding.findMany({
      where: { runId, mark: { not: "false_positive" } },
      select: { title: true, anchor: true },
    });
    const titlesByJourneyIndex = new Map<number, string[]>();
    for (const f of findings) {
      const ref = parseJson<{ stepRef?: { journeyIndex?: number } }>(f.anchor)?.stepRef;
      if (typeof ref?.journeyIndex !== "number" || !f.title) continue;
      const list = titlesByJourneyIndex.get(ref.journeyIndex) ?? [];
      list.push(f.title);
      titlesByJourneyIndex.set(ref.journeyIndex, list);
    }

    // Read once for the whole run: the survey's diff is the app's, not any one
    // journey's.
    const changedPages = await changedPagesOf(env, runId);
    // "Before" means before this run, whatever has been walked since.
    const runCreatedAt =
      (await env.db.run.findUnique({ where: { id: runId }, select: { createdAt: true } }))?.createdAt ??
      new Date();

    const alerts: MetricAlert[] = [];
    const seen = new Set<string>();
    for (const j of journeys) {
      const aj = j.appJourney;
      if (!aj || seen.has(aj.title)) continue;
      seen.add(aj.title);

      const movement = movementOf(aj.metricPoints as MetricPoint[]);
      if (!isAlertable(movement)) continue;
      // No path, no alert. The movement may well be real, but a sentence that
      // cannot say which two pages it counted between gets read as "fewer
      // people finish this journey" — which is not what was counted (CHE-279).
      const path = measuredPath(aj.metricPoints[0]?.steps ?? null);
      if (!path) continue;
      const sentence = movementSentence(aj.title, movement, path);
      if (!sentence) continue;

      // CHE-242: the pairing. The number moved AND this is what changed in the
      // flow — or, said outright, that nothing did. The stored plan is what the
      // journey looked like before this walk; this run's step labels are what
      // it looks like now. The status before is the previous walk's own
      // (CHE-321: not the catalog row, which this walk has already overwritten).
      const changes = flowChanges({
        price: aj.price,
        prevPrice: aj.prevPrice,
        plan: j.steps.map((s) => s.label).filter(Boolean),
        prevPlan: parseJson<string[]>(aj.plan) ?? [],
        status: j.status,
        prevStatus: j.appJourneyId
          ? await previousStatusOf(env, j.appJourneyId, runId, runCreatedAt)
          : null,
        newFindings: (titlesByJourneyIndex.get(j.order) ?? []).slice(0, 2),
        // CHE-285: the survey's snapshot diff (CHE-132), asked about THIS
        // journey's pages. True only when we actually compared two snapshots
        // and one of the pages this funnel names came back different — a
        // journey with no funnel names no pages and says nothing.
        pageChanged: namesAChangedPage(parseJson<string[]>(aj.funnelStages) ?? [], changedPages),
      });
      alerts.push({ journeyTitle: aj.title, sentence: pairedSentence(sentence, changes) });
    }
    return alerts;
  } catch (err) {
    console.warn(`[metric-alert] could not compute movements: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
