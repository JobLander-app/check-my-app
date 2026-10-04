// Filing one Finding into the owner's tracker (CHE-50).
//
// Two callers share this: the verdict page's "Create ticket" button
// (src/app/api/findings/[id]/ticket/route.ts) and the agent's auto-file pass on
// a Watch run (src/agent/autofile.ts). Both must produce the SAME ticket for the
// same finding and share one dedup namespace, so the draft shape and the dedup
// key live here rather than being written twice.
//
// Deliberately free of Next / server-only imports: this compiles into the agent
// worker (tsconfig.agent.json, workerd) as well as the web app.

import { buildTicketDraft } from "./ticket";
import { decideTicketAction } from "./decision";
import type { Tracker, TicketDraft } from "./types";
import { dedupKeyForFinding } from "./dedup-key";
import { audienceAt, type Audience } from "@/lib/audience";
import { PRIORITY_META, issuePriority, type Priority } from "@/lib/issue-priority";
import { parseJson } from "@/lib/json";
import { recurrencesAsOf } from "@/lib/recurring";
import type { FindingDetail } from "@/lib/types";
import type { PrismaClient } from "@/generated/prisma/client";
import { alreadyScoped } from "@/lib/tenant-db";

// The Finding columns a ticket is built from — a structural subset so either
// caller can pass its own query result.
export interface TicketFinding {
  anchor?: string | null;
  // CHE-413: the priority as the caller knows it. Absent, fileFindingTicket
  // reads it from the finding's own evidence (ticketPriority).
  priority?: Priority;
  // CHE-103: recorded on the link so the finding is found by pointer, not by
  // re-hashing prose that a later cleanup may rewrite. Optional because the
  // tickets we file against ourselves have no Finding row behind them.
  id?: string;
  runId: string;
  number: number;
  title: string;
  category: string;
  severity: string;
  detail: string | null;
  evidence: { storageUrl: string }[];
}

export interface TicketRun {
  runNumber: number;
  publicId: string;
  startedAt: Date;
  appSlug: string;
}

// TicketPolicy columns. Null = owner never configured one; every field then
// falls back to the schema default.
export interface TicketPolicyFields {
  priorityRule: string;
  pickupLabels: string;
  repoLabel: string | null;
  provenanceLabel: string;
  state: string;
  titleFormat: string;
  escalateAfterRuns: number;
}

// The dedup key lives in ./dedup-key.ts (recurrence reads it too); the callers
// that always imported it from here keep doing so.
export { dedupKeyForFinding };

// The priority on the ticket (CHE-413): the very answer Health → Issues gives,
// when the finding is one the app's history holds — recurrence as of this
// check says how many checks in a row have seen the problem and who hit it at
// its latest sighting. A finding outside any history (a ticket on our own
// board, an app not yet saved) is judged on its own: who hit it from the step
// its anchor names, seen once. A caller that already knows the priority is
// believed; nobody else guesses.
export async function ticketPriority(
  db: PrismaClient,
  finding: Pick<TicketFinding, "id" | "runId" | "category" | "severity" | "detail" | "anchor" | "priority">,
  // The app whose history to read, and the check to read it as of.
  history: { teamId: string; appId: string; runNumber: number } | null,
): Promise<Priority> {
  if (finding.priority) return finding.priority;
  const detail = parseJson<FindingDetail>(finding.detail) ?? {};
  if (finding.id && history) {
    const asOf = await recurrencesAsOf(db, history.teamId, history.appId, history.runNumber);
    const mine = asOf?.recurrences.find((r) => r.sightings.some((s) => s.findingId === finding.id));
    if (mine) {
      return issuePriority({
        category: finding.category,
        severity: finding.severity,
        where: detail.where,
        timesSeen: mine.issue.timesSeen,
        audience: mine.issue.audience,
      });
    }
  }
  const ref = parseJson<{ stepRef?: { journeyIndex?: number; stepIndex?: number } | null }>(finding.anchor ?? null)?.stepRef;
  let audience: Audience = "unknown";
  if (typeof ref?.journeyIndex === "number" && typeof ref?.stepIndex === "number") {
    // The anchor indexes the check's journeys and their steps in order —
    // Journey.order, Step.order — as every reader of it does
    // (src/lib/recurring.ts, src/lib/shell-data.ts).
    const journey = await db.journey.findFirst({
      where: { runId: finding.runId, order: ref.journeyIndex },
      select: { steps: { orderBy: { order: "asc" }, select: { status: true, actions: true } } },
    });
    if (journey) audience = audienceAt(journey.steps, ref.stepIndex);
  }
  return issuePriority({ category: finding.category, severity: finding.severity, where: detail.where, timesSeen: 1, audience });
}

export function draftForFinding(
  finding: TicketFinding & { priority: Priority },
  run: TicketRun,
  policy: TicketPolicyFields | null,
  verdictUrl: string,
): TicketDraft {
  const detail = parseJson<FindingDetail>(finding.detail) ?? {};
  const urgent = parseJson<{ urgent?: string[] }>(policy?.priorityRule ?? null)?.urgent ?? [];
  const isCritical = urgent.some((j) => finding.title.toLowerCase().includes(j.toLowerCase()));

  return buildTicketDraft(
    {
      priority: finding.priority,
      journeyTitle: detail.where ?? run.appSlug,
      failingStep: finding.title,
      failureSignature: `${finding.category}/${finding.severity}: ${finding.title}`,
      isCriticalJourney: isCritical,
      baselineDiff: detail.whatHappened ?? "(one-off finding, no baseline diff)",
      repro: (detail.whatWeTried ?? []).join("\n") || "See verdict page evidence.",
      evidenceUrls: finding.evidence.map((e) => e.storageUrl),
    },
    {
      runNumber: run.runNumber,
      runPublicId: run.publicId,
      startedAtIso: run.startedAt.toISOString(),
      appSlug: run.appSlug,
      verdictUrl,
      pickupLabels: parseJson<string[]>(policy?.pickupLabels ?? null) ?? [],
      repoLabel: policy?.repoLabel ?? null,
      provenanceLabel: policy?.provenanceLabel ?? "checkmyapp",
      state: policy?.state ?? "Backlog",
      titleFormat: policy?.titleFormat ?? "[Monitor] {verdict}",
    },
  );
}

export type FilingOutcome =
  | { kind: "created"; identifier: string; url: string; title: string }
  | { kind: "commented"; identifier: string; occurrences: number; escalated: boolean }
  | { kind: "suppressed"; identifier: string };

// Draft → decide → file. Never files a second ticket for a finding that already
// has an open one: it comments and counts, and once the recurrence count passes
// the owner's threshold it says so on the issue, once.
export async function fileFindingTicket(opts: {
  db: PrismaClient;
  tracker: Tracker;
  appId: string;
  finding: TicketFinding;
  run: TicketRun;
  policy: TicketPolicyFields | null;
  verdictUrl: string;
  // CHE-101: who the settlement belongs to. The App row can be deleted and
  // re-created; the owner's answer about a signature must survive that.
  ownerId?: string | null;
  // CHE-329: what this occurrence adds, appended to the recurrence comment —
  // a failed run's link and its own message, so the count on our board comes
  // with the runs behind it rather than a bare "still present in run #N".
  recurrenceDetail?: string;
}): Promise<FilingOutcome> {
  const { db, tracker, appId, finding, run, policy, ownerId } = opts;
  const key = dedupKeyForFinding(finding, run);
  // CHE-256: which team's settlements these are. A settlement outlives the App
  // row it came from (CHE-101), so it is stored with both — the team because
  // that is whose knowledge it is, the owner because rows written before teams
  // existed have only that.
  const app = await db.app.findUnique({ ...alreadyScoped("the caller resolved this app"),
    where: { id: appId },
    select: { teamId: true },
  });
  const settledScope = app?.teamId ? { teamId: app.teamId } : { ownerId: ownerId ?? undefined };

  const existing = await db.issueLink.findUnique({
    where: { appId_dedupKey: { appId, dedupKey: key } },
  });

  // CHE-101: a signature the owner already ruled not-a-bug stays ruled that way
  // even if the app row behind it is gone. Without this, removing and re-adding
  // an app silently re-arms every claim they had already rejected — the fastest
  // possible way to be filtered out.
  if (!existing) {
    const settled = await db.settledSignature.findFirst({ ...alreadyScoped("settled signatures outlive the app they describe"),
      where: { ...settledScope, appSlug: run.appSlug, dedupKey: key, outcome: "suppressed" },
      orderBy: { settledAt: "desc" },
    });
    if (settled) return { kind: "suppressed", identifier: settled.externalIssueId };
  }

  const action = decideTicketAction(
    existing
      ? { status: existing.status, occurrences: existing.occurrences, escalatedAt: existing.escalatedAt }
      : null,
    policy?.escalateAfterRuns ?? 3,
  );

  // Canceled upstream = not-a-bug (CHE-61). The signature is settled noise;
  // the auto-filer leaves it alone forever.
  if (action.kind === "skip" && existing) {
    return { kind: "suppressed", identifier: existing.externalIssueId };
  }

  // CHE-413: the priority as Issues computes it, from the app's history as of
  // this check — a problem seen three checks in a row is P0 on the ticket too.
  const priority = await ticketPriority(db, finding, app?.teamId ? { teamId: app.teamId, appId, runNumber: run.runNumber } : null);
  const draft = draftForFinding({ ...finding, priority }, run, policy, opts.verdictUrl);

  if (action.kind === "comment" && existing) {
    const occurrences = existing.occurrences + 1;
    const body = [
      `Re-filed from CheckMyApp — still present in run #${run.runNumber} (${draft.title}).`,
      `\n**Priority:** ${priority} — ${PRIORITY_META[priority].meaning}`,
      action.escalate
        ? `\nEscalating: this is occurrence ${occurrences} and the issue is still open — ` +
          `past the ${policy?.escalateAfterRuns ?? 3}-run threshold this app was configured with.`
        : "",
      opts.recurrenceDetail ? `\n\n${opts.recurrenceDetail}` : "",
    ]
      .join("")
      .trim();
    await tracker.addComment(existing.externalIssueId, body);
    await db.issueLink.update({
      where: { id: existing.id },
      data: {
        occurrences: { increment: 1 },
        lastSeenAt: new Date(),
        ...(action.escalate ? { escalatedAt: new Date() } : {}),
      },
    });
    return {
      kind: "commented",
      identifier: existing.externalIssueId,
      occurrences,
      escalated: action.escalate,
    };
  }

  const issue = await tracker.createIssue(draft);

  // CHE-101: the update branch below re-points the link at the new ticket, and
  // the ticket it replaces used to vanish from the ledger entirely — which is
  // how JOB-905 and JOB-908 became invisible, one of them carrying a rejection
  // we never received. Keep the outgoing identity before overwriting it.
  if (existing) {
    await db.settledSignature.create({ ...alreadyScoped("settled signatures outlive the app they describe"),
      data: {
        ownerId: ownerId ?? null,
        teamId: app?.teamId ?? null,
        appSlug: run.appSlug,
        dedupKey: key,
        externalIssueId: existing.externalIssueId,
        outcome: "superseded",
        defectClass: existing.defectClass,
      },
    });
  }

  const link = await db.issueLink.upsert({
    where: { appId_dedupKey: { appId, dedupKey: key } },
    create: {
      appId,
      dedupKey: key,
      externalIssueId: issue.identifier,
      firstSeenRunId: finding.runId,
      findingId: finding.id ?? null,
    },
    update: {
      externalIssueId: issue.identifier,
      status: "open",
      lastSeenAt: new Date(),
      findingId: finding.id ?? null,
    },
  });
  // A ticket that exists on someone's board with no row on ours is a ticket
  // whose verdict can never reach us. Loud, not silent (CHE-101).
  if (!link) {
    throw new Error(
      `Filed ${issue.identifier} but its ledger row was not written — its outcome could never be read back.`,
    );
  }
  return { kind: "created", identifier: issue.identifier, url: issue.url, title: draft.title };
}
