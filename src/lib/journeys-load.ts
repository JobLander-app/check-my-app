// Product → Journeys (CHE-362, phase 1): each journey of an app with the
// screens of the walk that last went through it.
//
// "The walk" is the journey's latest row in a finished check whose report is
// published, and never a carried copy: a partial check copies a healthy journey
// forward without walking it (CHE-57), and a strip of screens under that
// check's number would say we saw them then. Nor a row that ended "skipped":
// that check listed the journey and did not walk it, which is what the catalog
// means by a walk too (src/agent/journey-catalog.ts — `walked` is "not
// skipped", and only then does walkCount move). It is found from the checks, not
// from AppJourney.lastWalkedRunId: on prod four live journeys name a check that
// failed or was canceled (#207, #301) — a check that publishes nothing (rule 4)
// — while an earlier check holds a walk that can be shown.
//
// Read flat, like releases and recurrence: the catalog, the walk of each
// journey (one statement, bound to the team), their checks, the steps — in
// portions under D1's 100 bound values, stitched here. The nested shape
// (journey → walks → steps) is the one that aborted the query engine on a real
// team's history (src/lib/recurring.ts, 2026-10-02).

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { portions } from "@/lib/issues-page";
import { evidenceKey, thumbKeyOf, thumbUrl } from "@/lib/storage";
import { teamOwned, teamRows } from "@/lib/tenant-db";

export interface JourneyFrame {
  id: string;
  label: string;
  status: string;
  // Null for a step with no picture of its own (a check of a response, an
  // extension step): the strip shows its status in a frame, not a broken image.
  shot: { thumb: string; full: string } | null;
}

export interface JourneyWalk {
  // The walk's own Journey row — what the numbers block is keyed by.
  journeyId: string;
  status: string;
  summary: string | null;
  runNumber: number;
  publicId: string;
  at: Date | null;
  frames: JourneyFrame[];
}

export interface JourneyCard {
  id: string;
  title: string;
  walkCount: number;
  failingSince: Date | null;
  consecutiveBad: number;
  walk: JourneyWalk | null;
}

// Only a content-addressed screenshot of ours is a frame: anything else has no
// small copy, and its address may not be one this page can show at all.
function shotOf(url: string | null): JourneyFrame["shot"] {
  const key = evidenceKey(url);
  return url && key && thumbKeyOf(key) ? { thumb: thumbUrl(url), full: url } : null;
}

// `appId` is an app the caller has already read as the team's; the checks are
// bound to the team here all the same, so a catalog row can never show another
// team's screens whatever it points at.
export async function journeysOfApp(db: PrismaClient, teamId: string, appId: string): Promise<JourneyCard[]> {
  const [catalog, walks] = await Promise.all([
    db.appJourney.findMany({
      where: { appId, retiredAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, title: true, walkCount: true, failingSince: true, consecutiveBad: true },
    }),
    // The newest walk of each live journey. A finished check is published
    // unless it is an extension's with no verdict (extensionReportPublished —
    // scripts/verify-journeys-page.ts holds this statement to that function).
    db.$queryRaw<{ id: string; runId: string; appJourneyId: string; status: string; summary: string | null }[]>(
      Prisma.sql`SELECT id, runId, appJourneyId, status, summary FROM (
          SELECT j.id, j.runId, j.appJourneyId, j.status, j.summary,
            ROW_NUMBER() OVER (PARTITION BY j.appJourneyId ORDER BY r.runNumber DESC) AS nth
          FROM "Journey" j
          JOIN "Run" r ON r.id = j.runId
          JOIN "AppJourney" aj ON aj.id = j.appJourneyId
          WHERE r.teamId = ${teamRows(teamId)} AND r.appId = ${appId} AND aj.appId = ${appId} AND aj.retiredAt IS NULL
            AND j.carriedFromRunId IS NULL AND j.status <> 'skipped'
            AND r.status IN ('completed', 'partial')
            AND (r.targetKind <> 'extension' OR (r.verdict IS NOT NULL AND r.verdict <> ''))
        ) WHERE nth = 1`,
    ),
  ]);
  const walkOf = new Map(walks.map((w) => [w.appJourneyId, w]));

  const [runs, steps] = await Promise.all([
    Promise.all(
      portions([...new Set(walks.map((w) => w.runId))]).map((ids) =>
        db.run.findMany({
          where: { ...teamOwned(teamId), id: { in: ids } },
          select: { id: true, runNumber: true, publicId: true, completedAt: true },
        }),
      ),
    ).then((parts) => parts.flat()),
    Promise.all(
      portions(walks.map((w) => w.id)).map((ids) =>
        db.step.findMany({
          where: { journeyId: { in: ids } },
          orderBy: [{ journeyId: "asc" }, { order: "asc" }],
          select: { id: true, journeyId: true, label: true, status: true, screenshotUrl: true },
        }),
      ),
    ).then((parts) => parts.flat()),
  ]);
  const runOf = new Map(runs.map((r) => [r.id, r]));
  const framesOf = new Map<string, JourneyFrame[]>();
  for (const s of steps) {
    const frame = { id: s.id, label: s.label, status: s.status, shot: shotOf(s.screenshotUrl) };
    const list = framesOf.get(s.journeyId);
    if (list) list.push(frame);
    else framesOf.set(s.journeyId, [frame]);
  }

  return catalog.map((j) => {
    const w = walkOf.get(j.id);
    const run = w ? runOf.get(w.runId) : undefined;
    return {
      ...j,
      walk:
        w && run
          ? {
              journeyId: w.id,
              status: w.status,
              summary: w.summary,
              runNumber: run.runNumber,
              publicId: run.publicId,
              at: run.completedAt,
              frames: framesOf.get(w.id) ?? [],
            }
          : null,
    };
  });
}
