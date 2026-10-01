// What the sidebar shows about the team, in one place (CHE-351).
//
// A thin adapter over appHealth (CHE-353): the shell needs three facts — the
// team's apps with the colour of their latest verdict, how many problems are
// open, and what the apps cost a month — and nothing about how they are
// computed. When Health → Issues (CHE-360) owns "open", only this file changes.
//
// Prices only (CLAUDE.md §10): the month is appHealth's run rate of what the
// team's checks were priced at, never what they cost us.

import type { PrismaClient } from "@/generated/prisma/client";
import { appHealth } from "@/lib/app-health";
import { extensionDisplayName } from "@/lib/extension-target";
import { teamOwned } from "@/lib/tenant-db";

export type ShellApp = { id: string; label: string; verdict: string | null };

export type ShellData = {
  apps: ShellApp[];
  openIssues: number;
  monthlyCostUsd: number;
};

// A finding is open until somebody answered it: "That's fine" (known), "Mark
// as fixed" and "Dispute" (false_positive) close it; "Watch it" keeps it open.
const OPEN_MARKS = ["none", "watch"];

export async function shellData(db: PrismaClient, teamId: string): Promise<ShellData> {
  const health = await appHealth(db, teamId);
  const latestIds = health.apps.flatMap((a) => (a.latest ? [a.latest.publicId] : []));
  const [targets, openIssues] = await Promise.all([
    db.app.findMany({
      where: { ...teamOwned(teamId), targetKind: "extension" },
      select: { id: true, targetUrl: true },
    }),
    latestIds.length === 0
      ? 0
      : db.finding.count({
          where: { run: { ...teamOwned(teamId), publicId: { in: latestIds } }, mark: { in: OPEN_MARKS } },
        }),
  ]);
  const extensionUrl = new Map(targets.map((t) => [t.id, t.targetUrl]));
  return {
    apps: health.apps.map((a) => ({
      id: a.appId,
      label: extensionUrl.has(a.appId) ? extensionDisplayName(extensionUrl.get(a.appId)!) : a.appSlug,
      verdict: a.latest?.verdict ?? null,
    })),
    openIssues,
    monthlyCostUsd: health.monthlyRunRateUsd,
  };
}
