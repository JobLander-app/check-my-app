// A finding's priority from the database (CHE-413): one rule, called from
// every surface that shows one — the ticket we file (src/lib/tracker/file.ts),
// the review an agent reads (src/lib/review.ts), the problem's own page.
//
// The answer is Health → Issues' own when the finding is one the app's history
// holds: recurrence as of the finding's check says how many checks in a row
// have seen the problem and who hit it at its latest sighting. A finding
// outside any history — a ticket on our own board, an app not yet saved, a
// check nobody attached — is judged on its own: who hit it from the step its
// anchor names, seen once. Nobody guesses.

import type { PrismaClient } from "@/generated/prisma/client";
import { audienceAt, type Audience } from "@/lib/audience";
import { issuePriority, type Priority } from "@/lib/issue-priority";
import { parseJson } from "@/lib/json";
import { recurrencesAsOf, type Recurrence } from "@/lib/recurring";
import type { FindingDetail } from "@/lib/types";

export interface PriorityFinding {
  id?: string;
  runId: string;
  category: string;
  severity: string;
  detail: string | null;
  anchor?: string | null;
}

// The app whose history to read, and the check to read it as of.
export interface PriorityHistory {
  teamId: string;
  appId: string;
  runNumber: number;
}

/** The app's problems as they stood at that check — read once for every finding of the check. */
export async function historyAsOf(db: PrismaClient, history: PriorityHistory | null): Promise<Recurrence[]> {
  if (!history) return [];
  return (await recurrencesAsOf(db, history.teamId, history.appId, history.runNumber))?.recurrences ?? [];
}

/** The priority from a history that holds the finding; null when none does. */
export function priorityFromHistory(finding: Omit<PriorityFinding, "runId">, recurrences: Recurrence[]): Priority | null {
  if (!finding.id) return null;
  const mine = recurrences.find((r) => r.sightings.some((s) => s.findingId === finding.id));
  if (!mine) return null;
  const detail = parseJson<FindingDetail>(finding.detail) ?? {};
  return issuePriority({
    category: finding.category,
    severity: finding.severity,
    where: detail.where,
    timesSeen: mine.issue.timesSeen,
    audience: mine.issue.audience,
  });
}

type StepRows = Array<{ status: string; actions: string | null; signedIn?: boolean | null }>;

const stepRef = (finding: Pick<PriorityFinding, "anchor">) =>
  parseJson<{ stepRef?: { journeyIndex?: number; stepIndex?: number } | null }>(finding.anchor ?? null)?.stepRef;

/**
 * The priority from the finding's own check, seen once: who hit it from the
 * journey its anchor names — `journeys` in the check's order, each with its
 * steps in order (Journey.order, Step.order — as every reader of an anchor
 * indexes them: src/lib/recurring.ts, src/lib/shell-data.ts). A caller that
 * has the check's rows loaded passes them; priorityFromCheck loads the one
 * journey it needs.
 */
export function priorityOfCheckAlone(finding: Omit<PriorityFinding, "runId">, journeys: Array<{ steps: StepRows } | undefined>): Priority {
  const detail = parseJson<FindingDetail>(finding.detail) ?? {};
  const ref = stepRef(finding);
  const journey = typeof ref?.journeyIndex === "number" ? journeys[ref.journeyIndex] : undefined;
  const audience: Audience = journey && typeof ref?.stepIndex === "number" ? audienceAt(journey.steps, ref.stepIndex) : "unknown";
  return issuePriority({ category: finding.category, severity: finding.severity, where: detail.where, timesSeen: 1, audience });
}

export async function priorityFromCheck(db: PrismaClient, finding: PriorityFinding): Promise<Priority> {
  const ref = stepRef(finding);
  const journeys: Array<{ steps: StepRows } | undefined> = [];
  if (typeof ref?.journeyIndex === "number") {
    const journey = await db.journey.findFirst({
      where: { runId: finding.runId, order: ref.journeyIndex },
      select: { steps: { orderBy: { order: "asc" }, select: { status: true, actions: true, signedIn: true } } },
    });
    if (journey) journeys[ref.journeyIndex] = journey;
  }
  return priorityOfCheckAlone(finding, journeys);
}

/**
 * One finding: from the history when it holds it, from its own check
 * otherwise. A finding with no row of its own (a ticket on our own board) is
 * in no history, and none is read for it.
 */
export async function findingPriority(db: PrismaClient, finding: PriorityFinding, history: PriorityHistory | null): Promise<Priority> {
  const recurrences = finding.id ? await historyAsOf(db, history) : [];
  return priorityFromHistory(finding, recurrences) ?? priorityFromCheck(db, finding);
}
