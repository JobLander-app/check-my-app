// What changed since the last time anyone looked — per app of a team (CHE-315).
//
// The MCP server opens every agent session with this (its `instructions`) and
// serves it whole as the `latest_results` tool: for each app, its latest
// finished run, that run's verdict, its findings by severity, and the findings
// that are NEW against the app's previous finished run; plus whatever is still
// running. The agent is the product's primary interface; this is what lets it
// say "two new problems on joblander.app since yesterday" without the person
// opening a dashboard.
//
// "New" uses the identity a ticket uses — dedupKeyForFinding
// (src/lib/tracker/file.ts, CHE-32/59): the same regression on two days is one
// signature however its prose drifted, so it is not announced twice. A finding
// is new when no finding of the previous finished run of the same app has its
// signature. An app with one finished run has nothing to compare against, and
// every finding of it is new.

import type { PrismaClient } from "@/generated/prisma/client";
import { LIVE_RUN_STATUSES } from "@/lib/enums";
import { extensionReportPublished } from "@/lib/extension-target";
import { dedupKeyForFinding } from "@/lib/tracker/file";
import { alreadyScoped, teamOwned } from "@/lib/tenant-db";

// A run that finished with a verdict. `failed` is excluded on purpose: it is
// CheckMyApp not finishing, not a statement about the app (CLAUDE.md §4), and
// comparing against it would announce every finding as new.
const FINISHED = ["completed", "partial"];

const FINDING_SELECT = {
  number: true,
  title: true,
  category: true,
  severity: true,
  mark: true,
  detail: true,
  anchor: true,
} as const;

export interface AppLatest {
  app_id: string;
  app: string;
  url: string;
  latest_run: {
    run_id: string;
    status: string;
    verdict: string | null;
    bottom_line: string | null;
    completed_at: Date | null;
    deploy: { sha: string; env: string | null } | null;
  } | null;
  previous_run_id: string | null;
  findings_by_severity: Record<string, number>;
  new_findings: Array<{ number: number; title: string; category: string; severity: string }>;
}

export interface LatestResults {
  apps: AppLatest[];
  in_flight: Array<{ run_id: string; app_id: string | null; app: string; status: string; started_at: Date }>;
}

export async function latestResults(db: PrismaClient, teamId: string): Promise<LatestResults> {
  const apps = await db.app.findMany({
    where: { ...teamOwned(teamId) },
    orderBy: { createdAt: "desc" },
    select: { id: true, appSlug: true, targetUrl: true },
  });

  const perApp = await Promise.all(
    apps.map(async (app): Promise<AppLatest> => {
      const runs = await db.run.findMany({
        ...alreadyScoped("the caller resolved this app"),
        where: { appId: app.id, status: { in: FINISHED } },
        orderBy: { completedAt: "desc" },
        take: 4,
        select: {
          publicId: true,
          status: true,
          verdict: true,
          bottomLine: true,
          completedAt: true,
          targetKind: true,
          deploySha: true,
          deployEnv: true,
          findings: { orderBy: { number: "asc" }, select: FINDING_SELECT },
        },
      });
      // An extension report that has not been published has nothing to say
      // yet (src/lib/extension-target.ts) — it is neither latest nor previous.
      const [latest, previous] = runs.filter((r) => extensionReportPublished(r));
      const bySeverity: Record<string, number> = {};
      for (const f of latest?.findings ?? []) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
      const seen = new Set((previous?.findings ?? []).map((f) => dedupKeyForFinding(f, app)));
      const fresh = (latest?.findings ?? []).filter((f) => !seen.has(dedupKeyForFinding(f, app)));
      return {
        app_id: app.id,
        app: app.appSlug,
        url: app.targetUrl,
        latest_run: latest
          ? {
              run_id: latest.publicId,
              status: latest.status,
              verdict: latest.verdict,
              bottom_line: latest.bottomLine,
              completed_at: latest.completedAt,
              deploy: latest.deploySha ? { sha: latest.deploySha, env: latest.deployEnv } : null,
            }
          : null,
        previous_run_id: previous?.publicId ?? null,
        findings_by_severity: bySeverity,
        new_findings: fresh.map((f) => ({ number: f.number, title: f.title, category: f.category, severity: f.severity })),
      };
    }),
  );

  const live = await db.run.findMany({
    where: { ...teamOwned(teamId), status: { in: LIVE_RUN_STATUSES } },
    orderBy: { startedAt: "desc" },
    take: 20,
    select: { publicId: true, appId: true, appSlug: true, status: true, startedAt: true },
  });

  return {
    apps: perApp,
    in_flight: live.map((r) => ({ run_id: r.publicId, app_id: r.appId, app: r.appSlug, status: r.status, started_at: r.startedAt })),
  };
}
