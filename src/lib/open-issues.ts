// CHE-399: the number beside Issues in the menu and the Issues page count the
// same thing from one stored figure.
//
// Before this the sidebar's badge was a cheap SQL count of unanswered findings
// in each app's latest check (src/lib/shell-data.ts), and the Issues page's
// first filter counted problems — recurrence groups (src/lib/recurring.ts) —
// seen in that same check. Two findings of one problem were one row on the
// page and two in the badge; a problem answered in an earlier check of its
// streak was "answered" on the page while its latest finding carried no mark.
//
// Computing recurrence in the sidebar would read the team's whole history on
// every signed-in page. So the page's number is stored on the app
// (App.openIssues), written where it changes:
//
//   (a) when a check of the app finishes (src/agent/workflow.ts, after the
//       verdict is written, inside its own try/catch — a counter never fails
//       a run, rule 4);
//   (b) when a finding's mark changes (PATCH /api/findings/{id}, and the
//       Issues pages' markFinding action);
//   (c) when reconcile changes a ticket's state — reconcile runs only inside
//       the workflow (src/agent/reconcile.ts, called from workflow.ts before
//       the walk), so (a) at the end of that same run is the write.
//
// Each runs recurrence for that one app. The sidebar sums the column and
// falls back to its own SQL count for an app whose value is still null — no
// backfill: the first of (a)–(b) for each app fills it.
//
// Pure apart from the database: scripts/verify-open-issues.ts runs it on a
// real D1 and holds the three write sites.

import type { PrismaClient } from "@/generated/prisma/client";
import { alreadyScoped } from "./tenant-db";
import { teamRecurrences } from "./recurring";
import { inIssuesFilter, issueView } from "./issues-page";
import { latestChecks } from "./shell-data";

/**
 * What Issues' first filter ("In the latest checks") shows for one app: the
 * problems whose state is new or recurring and that the app's latest check
 * saw. The latest check is the sidebar's (latestChecks), so the two never
 * name different checks.
 */
export async function openIssuesOf(db: PrismaClient, teamId: string, appId: string): Promise<number> {
  const [byApp, latest] = await Promise.all([teamRecurrences(db, teamId, appId), latestChecks(db, teamId)]);
  const latestRunNumber = latest.find((r) => r.appId === appId)?.runNumber ?? null;
  return (byApp.get(appId) ?? []).filter((r) => inIssuesFilter("latest", issueView(r, latestRunNumber), r.issue.state)).length;
}

/**
 * Recount one app's open problems and store the number. Returns what was
 * stored, or null when the app is gone (a check of a deleted app finishing
 * is not an error). Throws on a database failure — the caller decides whether
 * that may fail what it is doing (the workflow's finish step says no).
 */
export async function refreshOpenIssues(db: PrismaClient, appId: string | null | undefined): Promise<number | null> {
  return recount(db, appId);
}

/**
 * The same, for a caller whose own write is already done — a mark, a finished
 * run. The count is derived; a hiccup in deriving it is logged and swallowed,
 * never reported as the write having failed (Codex on #276: the action
 * rejected after the mark was stored, and the page said "Not saved").
 */
export async function recountOpenIssues(db: PrismaClient, appId: string | null | undefined): Promise<number | null> {
  try {
    return await recount(db, appId);
  } catch (err) {
    console.warn(`[open-issues] recount failed for app ${appId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// Two recounts of one app can be in flight at once — a mark and a finishing
// check, two marks. Each reads several tables and then writes; without a
// guard the one that read the older state could write last (Codex on #276).
// So the write is a compare-and-set on the row's version: it lands only if no
// recount has written since this one read. A recount that lost the race reads
// again — the state it now sees is at least as new as the winner's — and tries
// once more; after a few losses it stops, and the winner's value stands.
const RECOUNT_ATTEMPTS = 3;

async function recount(db: PrismaClient, appId: string | null | undefined): Promise<number | null> {
  if (!appId) return null;
  for (let attempt = 0; attempt < RECOUNT_ATTEMPTS; attempt++) {
    const app = await db.app.findUnique({ ...alreadyScoped("the caller resolved this app"),
      where: { id: appId },
      select: { teamId: true, openIssuesVersion: true },
    });
    // Every App has a team (scripts/verify-team-backfill.ts); the column is
    // nullable only because SQLite could not add it NOT NULL.
    if (!app?.teamId) return null;
    const open = await openIssuesOf(db, app.teamId, appId);
    const landed = await db.app.updateMany({ ...alreadyScoped("already read in this request"),
      where: { id: appId, openIssuesVersion: app.openIssuesVersion },
      data: { openIssues: open, openIssuesVersion: { increment: 1 } },
    });
    if (landed.count === 1) return open;
  }
  console.warn(`[open-issues] app ${appId}: another recount landed every time; keeping its value`);
  return null;
}
