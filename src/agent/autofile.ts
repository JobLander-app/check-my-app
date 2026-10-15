// Auto-file regression tickets (CHE-50).
//
// A Daily Watch that finds a real problem and then waits for someone to open
// the verdict page and click "Create ticket" is a watch nobody is watching. So
// on a Watch run — never a one-off check — the findings that describe actual
// breakage get filed into the owner's tracker as soon as the verdict is written,
// through the same draft → decide → file path as the manual button.
//
// Three things keep this from becoming a spam cannon:
//   - only qualifying findings (broken / exposed, or high severity) are filed;
//   - IssueLink dedup comments on the open ticket instead of refiling, and says
//     so once when the recurrence count passes the owner's threshold;
//   - at most MAX_TICKETS_PER_RUN findings are touched per run, worst first.
//
// Every failure here is reported as a run event and swallowed: a tracker outage
// must never fail a run whose verdict is already written.

import { fileFindingTicket } from "@/lib/tracker/file";
import { trackerCreds, trackerFor } from "@/lib/tracker/factory";
import type { AgentEnv } from "./env";

const MAX_TICKETS_PER_RUN = 5;

// Worst first, so a capped run files the breakage and not the polish.
const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

export interface AutoFileNote {
  icon: "ok" | "warn";
  text: string;
}

// A finding worth a tracker ticket: something is broken or exposed, or it is
// severe enough that the owner would want it in their queue regardless.
function qualifies(f: { category: string; severity: string }): boolean {
  return f.category === "broken" || f.category === "exposed" || f.severity === "high";
}

export async function autoFileFindings(env: AgentEnv, runId: string): Promise<AutoFileNote[]> {
  const run = await env.db.run.findUnique({
    where: { id: runId },
    select: {
      id: true,
      runNumber: true,
      publicId: true,
      startedAt: true,
      appSlug: true,
      watchId: true,
      appId: true,
    },
  });
  // Manual one-off checks keep the manual button; only a recurring watch files
  // on its own, and only for an app we can attribute the tickets to.
  if (!run?.watchId || !run.appId) return [];

  const app = await env.db.app.findUnique({
    where: { id: run.appId },
    include: { tracker: true, policy: true },
  });
  if (!app?.tracker?.teamId || !app.policy) return [];

  const findings = await env.db.finding.findMany({
    where: { runId },
    include: { evidence: true },
    orderBy: { number: "asc" },
  });
  const qualifying = findings
    .filter(qualifies)
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3));
  if (qualifying.length === 0) return [];

  const notes: AutoFileNote[] = [];
  const selected = qualifying.slice(0, MAX_TICKETS_PER_RUN);

  // CHE-438: Linear or Jira, as the app connected it.
  const tracker = await trackerFor(env.db, app.tracker, trackerCreds(env.bindings as unknown as Record<string, unknown>));
  if (!tracker) return [];
  const baseUrl = env.bindings.APP_URL ?? "https://checkmyapp.dev";

  for (const finding of selected) {
    try {
      const outcome = await fileFindingTicket({
        db: env.db,
        tracker,
        appId: app.id,
        finding,
        run,
        policy: app.policy,
        verdictUrl: `${baseUrl}/verdict/${run.publicId}`,
        // CHE-101: settlements belong to the owner, not to a deletable app row.
        ownerId: app.ownerId,
      });
      if (outcome.kind === "created") {
        notes.push({ icon: "ok", text: `Filed ${outcome.identifier}: ${outcome.title}` });
      } else if (outcome.kind === "suppressed") {
        // Ruled not-a-bug via the canceled ticket (CHE-61) — said once per run
        // so the feed explains why no ticket appeared for a visible finding.
        notes.push({
          icon: "ok",
          text: `Skipped "${finding.title}" — ruled not-a-bug in ${outcome.identifier}`,
        });
      } else {
        notes.push({
          icon: "ok",
          text: `Commented on existing ${outcome.identifier} (${ordinal(outcome.occurrences)} occurrence)`,
        });
        if (outcome.escalated) {
          notes.push({ icon: "warn", text: `Escalated ${outcome.identifier}` });
        }
      }
    } catch (err) {
      notes.push({
        icon: "warn",
        text: `Couldn't file a ticket for "${finding.title}": ${message(err)}`,
      });
    }
  }

  const held = qualifying.length - selected.length;
  if (held > 0) {
    notes.push({
      icon: "warn",
      text: `${held} more finding${held === 1 ? "" : "s"} qualified but weren't filed (cap ${MAX_TICKETS_PER_RUN} per run)`,
    });
  }
  return notes;
}

function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
