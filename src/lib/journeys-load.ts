// Product → Journeys (CHE-362, phase 1): each journey of an app with the
// screens of the walk that last went through it.
//
// Everything a card says comes from one history: the journey's own rows in the
// app's finished checks whose report is published. Its walk is the newest of
// them; how many times it was walked is how many there are; "failing since" is
// the run of unhealthy ones at the end of them.
//
// Not from the catalog row's counters (AppJourney.walkCount, failingSince,
// lastWalkedRunId, title): the walk loop writes those as it goes, so a check
// that walked a journey and then failed has already moved them — and a failed
// check publishes nothing (CLAUDE.md §4). On prod four live journeys name a
// failed or canceled check as their last walk (#207, #301), and the extension's
// counts are made of failed checks only. Read from the catalog, a card would
// put "failing since" and a count from an unpublished check beside an older
// walk that worked (Codex P1 on #256).
//
// A row is a walk when the check walked it itself: not a carried copy (a
// partial check copies a healthy journey forward, CHE-57), and not a row that
// ended "skipped" — the check listed the journey and did not walk it, which is
// what the catalog means by a walk too (src/agent/journey-catalog.ts).
//
// Read flat, like releases and recurrence: the catalog, the app's walks (one
// raw statement, bound to the team, two bound values whatever the app's size),
// then the shown walks' checks, words and steps. The nested shape (journey →
// walks → steps) is the one that aborted the query engine on a real team's
// history (src/lib/recurring.ts, 2026-10-02). The `in` lists below are model
// queries, which Prisma splits under D1's 100 bound values by itself, provided
// every column the query orders by is selected — a raw statement is not split
// at all (scripts/verify-journeys-page.ts shows each on a real D1, with 131
// journeys).

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
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
  // The walk's own title when there is one; the catalog's otherwise.
  title: string;
  // Walks in published checks.
  walkCount: number;
  // The unhealthy walks at the end of that history: how many, and the day of
  // the first of them. Zero and null when the last walk was healthy.
  failingWalks: number;
  failingSince: Date | null;
  walk: JourneyWalk | null;
}

// The catalog's own word for a walk that ended well (journey-catalog.ts HEALTHY).
const HEALTHY = new Set(["ok", "partial"]);

// Only a content-addressed screenshot of ours is a frame: anything else has no
// small copy, and its address may not be one this page can show at all.
function shotOf(url: string | null): JourneyFrame["shot"] {
  const key = evidenceKey(url);
  return url && key && thumbKeyOf(key) ? { thumb: thumbUrl(url), full: url } : null;
}

// The page passes an app it has already read as the team's. Both reads are
// bound to the team here all the same — the catalog through its app, the walks
// through their checks — so an app id from anywhere else gets nothing: not
// another team's screens, and not the names of its journeys either.
export async function journeysOfApp(db: PrismaClient, teamId: string, appId: string): Promise<JourneyCard[]> {
  const [catalog, history] = await Promise.all([
    db.appJourney.findMany({
      where: { appId, retiredAt: null, app: { ...teamOwned(teamId) } },
      orderBy: { createdAt: "asc" },
      select: { id: true, title: true },
    }),
    // Every walk of the app's live journeys, newest first. A finished check is
    // published unless it is an extension's with no verdict
    // (extensionReportPublished — scripts/verify-journeys-page.ts holds this
    // statement to that function).
    db.$queryRaw<{ id: string; runId: string; appJourneyId: string; status: string }[]>(
      Prisma.sql`SELECT j.id, j.runId, j.appJourneyId, j.status
        FROM "Journey" j
        JOIN "Run" r ON r.id = j.runId
        JOIN "AppJourney" aj ON aj.id = j.appJourneyId
        WHERE r.teamId = ${teamRows(teamId)} AND r.appId = ${appId} AND aj.appId = ${appId} AND aj.retiredAt IS NULL
          AND j.carriedFromRunId IS NULL AND j.status <> 'skipped'
          AND r.status IN ('completed', 'partial')
          AND (r.targetKind <> 'extension' OR (r.verdict IS NOT NULL AND r.verdict <> ''))
        ORDER BY r.runNumber DESC`,
    ),
  ]);
  const walksOf = new Map<string, typeof history>();
  for (const w of history) {
    const list = walksOf.get(w.appJourneyId);
    if (list) list.push(w);
    else walksOf.set(w.appJourneyId, [w]);
  }
  // Per journey: its newest walk, and the unhealthy walks that end its history.
  const told = new Map(
    [...walksOf].map(([id, walks]) => {
      const healthyAt = walks.findIndex((w) => HEALTHY.has(w.status));
      const failing = healthyAt === -1 ? walks : walks.slice(0, healthyAt);
      return [id, { walk: walks[0], count: walks.length, failing: failing.length, firstFailing: failing.at(-1) ?? null }] as const;
    }),
  );
  const shown = [...told.values()].map((t) => t.walk);
  const runIds = [...new Set([...told.values()].flatMap((t) => [t.walk.runId, ...(t.firstFailing ? [t.firstFailing.runId] : [])]))];

  const shownIds = shown.map((w) => w.id);
  const [runs, words, steps] = await Promise.all([
    db.run.findMany({
      where: { ...teamOwned(teamId), id: { in: runIds } },
      select: { id: true, runNumber: true, publicId: true, completedAt: true },
    }),
    db.journey.findMany({ where: { id: { in: shownIds } }, select: { id: true, title: true, summary: true } }),
    // `order` is selected because it is ordered by: over the cap Prisma splits
    // the list and merges the parts itself, and aborts the query engine when a
    // column it must merge on was not read (seen with 131 journeys).
    db.step.findMany({
      where: { journeyId: { in: shownIds } },
      orderBy: [{ journeyId: "asc" }, { order: "asc" }],
      select: { id: true, journeyId: true, order: true, label: true, status: true, screenshotUrl: true },
    }),
  ]);
  const runOf = new Map(runs.map((r) => [r.id, r]));
  const wordsOf = new Map(words.map((w) => [w.id, w]));
  const framesOf = new Map<string, JourneyFrame[]>();
  for (const s of steps) {
    const frame = { id: s.id, label: s.label, status: s.status, shot: shotOf(s.screenshotUrl) };
    const list = framesOf.get(s.journeyId);
    if (list) list.push(frame);
    else framesOf.set(s.journeyId, [frame]);
  }

  return catalog.map((j) => {
    const t = told.get(j.id);
    const run = t ? runOf.get(t.walk.runId) : undefined;
    if (!t || !run) return { id: j.id, title: j.title, walkCount: 0, failingWalks: 0, failingSince: null, walk: null };
    const said = wordsOf.get(t.walk.id);
    return {
      id: j.id,
      title: said?.title ?? j.title,
      walkCount: t.count,
      failingWalks: t.failing,
      failingSince: t.firstFailing ? runOf.get(t.firstFailing.runId)?.completedAt ?? null : null,
      walk: {
        journeyId: t.walk.id,
        status: t.walk.status,
        summary: said?.summary ?? null,
        runNumber: run.runNumber,
        publicId: run.publicId,
        at: run.completedAt,
        frames: framesOf.get(t.walk.id) ?? [],
      },
    };
  });
}
