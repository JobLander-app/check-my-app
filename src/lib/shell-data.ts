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
//      findings on it (a window function, one bound parameter — D1 caps a
//      statement at 100, so an IN list of app ids would break at 50 apps);
//   3. the window's priced runs, for the monthly figure.
//
// The month is appHealth's run rate (CHE-353), computed the same way: the last
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
import { teamOwned } from "@/lib/tenant-db";

export type ShellApp = { id: string; label: string; verdict: string | null };

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
const LATEST_WITH_OPEN = (teamId: string) => Prisma.sql`
  SELECT l.appId AS appId, l.verdict AS verdict,
    (SELECT COUNT(*) FROM "Finding" f WHERE f.runId = l.id AND f.mark IN ('none', 'watch')) AS open
  FROM (
    SELECT id, appId, verdict,
      ROW_NUMBER() OVER (PARTITION BY appId ORDER BY completedAt DESC) AS rn
    FROM "Run"
    WHERE teamId = ${teamId} AND appId IS NOT NULL
      AND status IN ('completed', 'partial') AND verdict IS NOT NULL AND priceUsd IS NOT NULL
  ) l
  WHERE l.rn = 1`;

export async function loadShellData(db: PrismaClient, teamId: string, now: Date = new Date()): Promise<ShellData> {
  const since = new Date(utcDayStart(now).getTime() - (WINDOW_DAYS - 1) * DAY_MS);
  const until = new Date(utcDayStart(now).getTime() + DAY_MS);
  const [apps, latest, runs] = await Promise.all([
    db.app.findMany({
      where: { ...teamOwned(teamId) },
      orderBy: { createdAt: "asc" },
      select: { id: true, appSlug: true, targetKind: true, targetUrl: true },
    }),
    db.$queryRaw<{ appId: string; verdict: string; open: number | bigint }[]>(LATEST_WITH_OPEN(teamId)),
    db.run.findMany({
      where: { ...teamOwned(teamId), createdAt: { gte: new Date(since.getTime() - DAY_MS), lte: new Date(until.getTime() - 1) } },
      select: { priceUsd: true, createdAt: true },
    }),
  ]);

  const verdictOf = new Map(latest.map((r) => [r.appId, r.verdict]));
  const totalCents = runs
    .filter((r) => r.createdAt >= since && r.createdAt < until)
    .reduce((sum, r) => sum + Math.round((r.priceUsd ?? 0) * 100), 0);

  return {
    apps: apps.map((a) => ({
      id: a.id,
      label: a.targetKind === "extension" ? extensionDisplayName(a.targetUrl) : a.appSlug,
      verdict: verdictOf.get(a.id) ?? null,
    })),
    openIssues: latest.reduce((n, r) => n + Number(r.open), 0),
    monthlyCostUsd: Math.round((totalCents / WINDOW_DAYS) * 30) / 100,
  };
}

// Once per request: the layout reads it, and a page that wants the same facts
// gets the layout's answer instead of asking again.
export const shellData = cache((db: PrismaClient, teamId: string) => loadShellData(db, teamId));
