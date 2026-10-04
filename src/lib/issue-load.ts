// A problem's own page (CHE-412): one problem of one app, with everything the
// Issues list knows about it and what the list has no room for — where it
// happens, what was tried and what happened, the step it was seen on with its
// picture, every check that saw it.
//
// A problem has no row of its own. It is computed from the app's history by
// recurrence (src/lib/recurring.ts), and the Issues list keys each one by the
// finding of its latest sighting — the finding the owner's answer is written
// to. So the address is a finding id, and the page is the problem that finding
// is a sighting of: an older sighting's id opens the same page.
//
// Read flat, like the journeys page: the finding through its check (the
// team's), the app the check belongs to (appHealth's rule: attached, or the
// team's only app of that address), the app's recurrences, then the one
// check's journeys and the one journey's steps. The anchor is read here and
// never leaves: it names the journey and step by position in the check's own
// lists (CHE-215), and what the page shows is the step — its words and its
// picture — not our record of what the finding was allowed to rest on.

import type { PrismaClient } from "@/generated/prisma/client";
import { parseJson } from "@/lib/json";
import { teamRecurrences, type Recurrence } from "@/lib/recurring";
import { evidenceKey, thumbKeyOf, thumbUrl } from "@/lib/storage";
import { teamOwned } from "@/lib/tenant-db";
import type { FindingDetail } from "@/lib/types";

export interface IssueStep {
  journeyTitle: string;
  // The check that walked the journey; a carried journey names the earlier one.
  walkedInRunNumber: number;
  label: string;
  status: string;
  attempted: string | null;
  observed: string | null;
  // Null for a step with no picture of its own, or one that is not a
  // content-addressed screenshot of ours (which has no small copy).
  shot: { thumb: string; full: string } | null;
}

export interface IssuePage {
  appId: string;
  finding: {
    id: string;
    title: string;
    category: string;
    severity: string;
    mark: string;
    detail: FindingDetail;
    runNumber: number;
  };
  // Null when the finding is no sighting of a problem: a restatement on a
  // carried journey, or the one finding that is about us (recurrence leaves
  // both out). The page then shows the finding alone, as the check saw it.
  recurrence: Recurrence | null;
  // The owner's answer is written to the problem's latest sighting, as the
  // Issues list writes it (PATCH /api/findings/{id}) — whichever sighting's
  // address the page was opened by. `ownerId` is whose check found it: the
  // route lets that person answer, and nobody else.
  answer: { findingId: string; mark: string; ownerId: string | null };
  ticket: { externalIssueId: string; status: string } | null;
  step: IssueStep | null;
}

function shotOf(url: string | null): IssueStep["shot"] {
  const key = evidenceKey(url);
  return url && key && thumbKeyOf(key) ? { thumb: thumbUrl(url), full: url } : null;
}

export async function issueOf(db: PrismaClient, teamId: string, findingId: string): Promise<IssuePage | null> {
  const finding = await db.finding.findFirst({
    where: { id: findingId, run: { teamId } },
    select: {
      id: true, title: true, category: true, severity: true, mark: true, detail: true, anchor: true,
      run: { select: { id: true, appId: true, appSlug: true, runNumber: true, ownerId: true } },
    },
  });
  if (!finding) return null;
  const { run } = finding;

  // Which app the check is: attached to one, or — when it carries none — the
  // team's only app with its address (src/lib/app-health.ts). A check of no
  // saved app has no problem page: its findings live on its verdict alone.
  let appId = run.appId;
  if (appId === null) {
    const ofSlug = await db.app.findMany({ where: { ...teamOwned(teamId), appSlug: run.appSlug }, select: { id: true } });
    appId = ofSlug.length === 1 ? ofSlug[0].id : null;
  }
  if (appId === null) return null;

  const [recurrences, journeys] = await Promise.all([
    teamRecurrences(db, teamId, appId).then((byApp) => byApp.get(appId) ?? []),
    // The check's journeys in their order — what the anchor's journeyIndex
    // indexes, as persistFindings loaded them (src/lib/recurring.ts).
    db.journey.findMany({
      where: { runId: run.id },
      orderBy: { order: "asc" },
      select: { id: true, title: true, carriedFromRunId: true },
    }),
  ]);
  const recurrence = recurrences.find((r) => r.sightings.some((s) => s.findingId === finding.id)) ?? null;
  const latestId = recurrence?.sightings.at(-1)?.findingId ?? finding.id;

  const ref = parseJson<{ stepRef?: { journeyIndex?: number; stepIndex?: number } | null }>(finding.anchor)?.stepRef;
  const journey = typeof ref?.journeyIndex === "number" ? journeys[ref.journeyIndex] ?? null : null;
  const [steps, link, carriedFrom, latest] = await Promise.all([
    journey && typeof ref?.stepIndex === "number"
      ? db.step.findMany({
          where: { journeyId: journey.id },
          orderBy: { order: "asc" },
          select: { label: true, status: true, attempted: true, observed: true, screenshotUrl: true },
        })
      : [],
    recurrence?.issue.issueLinkId
      ? db.issueLink.findFirst({ where: { id: recurrence.issue.issueLinkId, app: { teamId } }, select: { externalIssueId: true, status: true } })
      : null,
    // A carried journey was walked by an earlier check: the step and its
    // picture are that check's, and the page says so.
    journey?.carriedFromRunId
      ? db.run.findFirst({ where: { ...teamOwned(teamId), id: journey.carriedFromRunId }, select: { runNumber: true } })
      : null,
    // Opened by an older sighting: the answer stands on the latest one.
    latestId === finding.id
      ? { mark: finding.mark, run: { ownerId: run.ownerId } }
      : db.finding.findFirst({ where: { id: latestId, run: { teamId } }, select: { mark: true, run: { select: { ownerId: true } } } }),
  ]);
  const step = journey && typeof ref?.stepIndex === "number" ? steps[ref.stepIndex] ?? null : null;

  return {
    appId,
    finding: {
      id: finding.id,
      title: finding.title,
      category: finding.category,
      severity: finding.severity,
      mark: finding.mark,
      detail: parseJson<FindingDetail>(finding.detail) ?? {},
      runNumber: run.runNumber,
    },
    recurrence,
    answer: { findingId: latestId, mark: latest?.mark ?? "none", ownerId: latest?.run.ownerId ?? null },
    ticket: link,
    step:
      journey && step
        ? {
            journeyTitle: journey.title,
            walkedInRunNumber: carriedFrom?.runNumber ?? run.runNumber,
            label: step.label,
            status: step.status,
            attempted: step.attempted,
            observed: step.observed,
            shot: shotOf(step.screenshotUrl),
          }
        : null,
  };
}
