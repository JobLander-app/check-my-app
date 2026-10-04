// What the sidebar shows about the team, in one place (CHE-351).
//
// Three facts — the team's apps with the colour of their latest verdict, how
// many problems are open, and what the apps cost a month — on every signed-in
// page. So the cost is fixed: three queries whatever the team's size (Codex
// P1 on #230: running the full appHealth report here cost ~5 queries per app
// on every page, settings included).
//
//   1. the apps;
//   2. one statement for each app's latest priced verdict and the open
//      findings on it (one bound parameter — D1 caps a statement at 100, so
//      an IN list of app ids would break at 50 apps);
//   3. the window's priced runs, for the monthly figure.
//
// The month is appHealth's `appsMonthlyUsd` (CHE-353), computed the same way: the last
// 30 UTC days to the midnight after now, runs placed by createdAt, one day of
// slack at the start because rows written before 2026-09-04 spell createdAt so
// that it sorts before the window's first midnight. scripts/verify-app-shell.ts
// holds the two to the same number. When Issues (CHE-360) owns "open", only
// this file changes.
//
// Prices only (CLAUDE.md §10): priceUsd, never what a check cost us.

import { cache } from "react";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { extensionDisplayName } from "@/lib/extension-target";
import { utcDayStart } from "@/lib/plans";
import { OUR_LEFTOVERS_WHERE } from "@/lib/finding-signature";
import { teamOwned, teamRows } from "@/lib/tenant-db";

// `latestRunNumber`: the check the dot's colour and the open count come from.
export type ShellApp = { id: string; appSlug: string; label: string; verdict: string | null; latestRunNumber: number | null };

export type ShellData = {
  apps: ShellApp[];
  openIssues: number;
  monthlyCostUsd: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;

// A finding is open until somebody answered it: "That's fine" (known), "Mark
// as fixed" and "Dispute" (false_positive) close it; "Watch it" keeps it open.
// The latest check is the newest finished one with a verdict and a price, as
// appHealth's `latest` is.
//
// Per app, two candidates and the newer wins: the latest check attached to the
// app, and — when the app is the team's only one with that slug, as appHealth
// decides it — the latest check of that slug that predates the app and so has
// no appId. Each is one seek on Run(teamId, appId, completedAt), newest first:
// the cost follows the number of apps, not the length of the history (Codex P2
// on #230: a window over every finished run of the team, on every page).
//
// "Newest" is by time, not by text. D1 compares completedAt as text, and prod
// holds two spellings of it ("2026-09-14 23:30:00", written by hand, sorts
// before "2026-09-14T22:00:00.000+00:00"). Across days the text order is right,
// so the seek finds the newest day; within that day the candidates are ordered
// with the two spellings made one — what appHealth does with parsed dates
// (CHE-382), so the sidebar's dot and All apps never name different checks.
//
// Open findings are the app's own. The one finding that is about US — test
// records our check left behind (finding-signature.ts, OUR_LEFTOVERS_WHERE) —
// is on the check's page for the owner to act on, and is not counted as a
// problem of their product here or on Issues (CHE-360). Nor is a finding the
// check only restated: one anchored to a journey it carried forward and did
// not walk. Recurrence does not count that as seeing the problem again
// (src/lib/recurring.ts), so Issues does not list it under the latest checks,
// and the number beside Issues must not either (Codex on #249).
const OUR_LEFTOVERS = `%"where":"${OUR_LEFTOVERS_WHERE}"%`;
const LATEST_WITH_OPEN = (teamId: string) => Prisma.sql`
  SELECT appId, verdict, runNumber, open FROM (
    SELECT a.id AS appId, r.verdict AS verdict, r.runNumber AS runNumber,
      (SELECT COUNT(*) FROM "Finding" f WHERE f.runId = r.id AND f.mark IN ('none', 'watch')
        AND (f.detail IS NULL OR f.detail NOT LIKE ${OUR_LEFTOVERS})
        AND NOT EXISTS (SELECT 1 FROM "Journey" cj WHERE cj.runId = r.id AND cj.carriedFromRunId IS NOT NULL
          AND cj."order" = json_extract(f.anchor, '$.stepRef.journeyIndex'))) AS open,
      ROW_NUMBER() OVER (PARTITION BY a.id ORDER BY replace(r.completedAt, ' ', 'T') DESC) AS rn
    FROM "App" a
    JOIN "Run" r ON r.id IN (
      (SELECT o.id FROM "Run" o
        WHERE o.teamId = a.teamId AND o.appId = a.id
          AND o.status IN ('completed', 'partial') AND o.verdict IS NOT NULL AND o.priceUsd IS NOT NULL
          AND o.completedAt >= (SELECT substr(d.completedAt, 1, 10) FROM "Run" d
            WHERE d.teamId = a.teamId AND d.appId = a.id
              AND d.status IN ('completed', 'partial') AND d.verdict IS NOT NULL AND d.priceUsd IS NOT NULL
            ORDER BY d.completedAt DESC LIMIT 1)
        ORDER BY replace(o.completedAt, ' ', 'T') DESC LIMIT 1),
      (SELECT l.id FROM "Run" l
        WHERE l.teamId = a.teamId AND l.appId IS NULL AND l.appSlug = a.appSlug
          AND l.status IN ('completed', 'partial') AND l.verdict IS NOT NULL AND l.priceUsd IS NOT NULL
          AND (SELECT COUNT(*) FROM "App" b WHERE b.teamId = a.teamId AND b.appSlug = a.appSlug) = 1
          AND l.completedAt >= (SELECT substr(e.completedAt, 1, 10) FROM "Run" e
            WHERE e.teamId = a.teamId AND e.appId IS NULL AND e.appSlug = a.appSlug
              AND e.status IN ('completed', 'partial') AND e.verdict IS NOT NULL AND e.priceUsd IS NOT NULL
            ORDER BY e.completedAt DESC LIMIT 1)
        ORDER BY replace(l.completedAt, ' ', 'T') DESC LIMIT 1)
    )
    WHERE a.teamId = ${teamId}
  )
  WHERE rn = 1`;

export async function loadShellData(db: PrismaClient, teamId: string, now: Date = new Date()): Promise<ShellData> {
  const since = new Date(utcDayStart(now).getTime() - (WINDOW_DAYS - 1) * DAY_MS);
  const until = new Date(utcDayStart(now).getTime() + DAY_MS);
  const [apps, latest, runs] = await Promise.all([
    db.app.findMany({
      where: { ...teamOwned(teamId) },
      orderBy: { createdAt: "asc" },
      select: { id: true, appSlug: true, targetKind: true, targetUrl: true },
    }),
    db.$queryRaw<{ appId: string; verdict: string; runNumber: number | bigint; open: number | bigint }[]>(LATEST_WITH_OPEN(teamRows(teamId))),
    db.run.findMany({
      where: { ...teamOwned(teamId), createdAt: { gte: new Date(since.getTime() - DAY_MS), lte: new Date(until.getTime() - 1) } },
      select: { appId: true, appSlug: true, priceUsd: true, createdAt: true },
    }),
  ]);

  const verdictOf = new Map(latest.map((r) => [r.appId, r.verdict]));
  const latestRunOf = new Map(latest.map((r) => [r.appId, Number(r.runNumber)]));
  // "Your apps cost": the checks that belong to a saved app, by appHealth's
  // rule — attached to it, or made before the team's only app with that
  // address was saved. A preview or a one-off address is the team's spending
  // (Billing lists it), not what an app costs.
  const ids = new Set(apps.map((a) => a.id));
  const slugCount = new Map<string, number>();
  for (const a of apps) slugCount.set(a.appSlug, (slugCount.get(a.appSlug) ?? 0) + 1);
  const ofAnApp = (r: { appId: string | null; appSlug: string }) => (r.appId ? ids.has(r.appId) : slugCount.get(r.appSlug) === 1);
  const totalCents = runs
    .filter((r) => r.createdAt >= since && r.createdAt < until && ofAnApp(r))
    .reduce((sum, r) => sum + Math.round((r.priceUsd ?? 0) * 100), 0);

  return {
    apps: apps.map((a) => ({
      id: a.id,
      appSlug: a.appSlug,
      label: a.targetKind === "extension" ? extensionDisplayName(a.targetUrl) : a.appSlug,
      verdict: verdictOf.get(a.id) ?? null,
      latestRunNumber: latestRunOf.get(a.id) ?? null,
    })),
    openIssues: latest.reduce((n, r) => n + Number(r.open), 0),
    monthlyCostUsd: Math.round((totalCents / WINDOW_DAYS) * 30) / 100,
  };
}

// Once per request: the layout reads it, and a page that wants the same facts
// gets the layout's answer instead of asking again.
export const shellData = cache((db: PrismaClient, teamId: string) => loadShellData(db, teamId));
