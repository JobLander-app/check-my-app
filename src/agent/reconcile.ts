// Reverse sync with the owner's tracker (CHE-61) — the loop's second half.
//
// autofile.ts (CHE-50) is the forward half: a Watch finding becomes a tracker
// ticket, and whatever automation the owner runs picks it up by label. The
// ticket is the whole interface — nothing here knows or cares who does the
// fixing. This module reads the outcome back through that same interface.
// Contract v2: the ticket's workflow state IS the fixer's verdict —
// Done = fixed and shipped, Canceled = not-a-bug.
//
//   Done     → the link turns "fixed" and this run re-verifies that journey
//              with priority. Only a fresh walk where the signature does NOT
//              reappear earns the "verified fixed" comment and status
//              "resolved". A reappearance goes through the normal autofile
//              path, which files a non-open link as a fresh regression ticket.
//   Canceled → the link turns "suppressed": that signature never auto-files
//              again, and the original finding is marked false_positive
//              (Loop C). The JOB-904 class dies here — in CheckMyApp's own
//              noise model, not in the fixer's config.
//
// The split is the point: a builder never grades its own work. CheckMyApp
// found the problem from the outside, so CheckMyApp confirms the fix from the
// outside — with a walk, not by trusting the ticket.
//
// Failure contract matches autofile: every error becomes a warn note and is
// swallowed — a tracker outage must never cost the owner a verdict.

import { trackerCreds, trackerFor } from "@/lib/tracker/factory";
import { dedupKeyForFinding } from "@/lib/tracker/file";
import { classifyCheckerDefect, fileCheckerDefect } from "./capability-gaps";
import type { Tracker } from "@/lib/tracker/types";
import { parseJson } from "@/lib/json";
import type { FindingDetail } from "@/lib/types";
import type { AgentEnv } from "./env";

export interface ReconcileNote {
  icon: "ok" | "warn";
  text: string;
}

/** One Done ticket whose fix this run must specifically try to re-verify. */
export interface ReverifyTarget {
  identifier: string;
  /** Journey the original finding lived in (detail.where), when we still have it. */
  journeyTitle: string | null;
  /** The failing step — the original finding's title. */
  stepLabel: string | null;
}

export interface ReconcileResult {
  notes: ReconcileNote[];
  reverify: ReverifyTarget[];
}

const EMPTY: ReconcileResult = { notes: [], reverify: [] };

// ─── Pre-flight: fold tracker verdicts into link state ───────────────────────

export async function reconcileIssueLinks(
  env: AgentEnv,
  run: { watchId: string | null; appId: string | null; appSlug: string },
): Promise<ReconcileResult> {
  // Same gate as autofile: only a recurring watch on an attributable app.
  if (!run.watchId || !run.appId) return EMPTY;
  const app = await env.db.app.findUnique({
    where: { id: run.appId },
    include: { tracker: true },
  });
  if (!app?.tracker?.teamId) return EMPTY;

  // "fixed" links are re-read too: a reopened ticket withdraws the fix claim.
  const links = await env.db.issueLink.findMany({
    where: { appId: app.id, status: { in: ["open", "fixed"] } },
  });
  if (links.length === 0) return EMPTY;

  // CHE-438: Linear or Jira, as the app connected it.
  const tracker: Tracker | null = await trackerFor(env.db, app.tracker, trackerCreds(env.bindings as unknown as Record<string, unknown>));
  if (!tracker) return EMPTY;

  const notes: ReconcileNote[] = [];
  const reverify: ReverifyTarget[] = [];

  for (const link of links) {
    let outcome;
    try {
      outcome = await tracker.getIssueOutcome(link.externalIssueId);
    } catch (err) {
      notes.push({
        icon: "warn",
        text: `Couldn't read ${link.externalIssueId} from the tracker: ${message(err)}`,
      });
      continue;
    }

    if (outcome === "missing") {
      // A vanished ticket is nobody's verdict. Suppressing on it would let an
      // accidental delete bury a real bug, so the link just stays open.
      notes.push({
        icon: "warn",
        text: `${link.externalIssueId} no longer exists in the tracker — leaving its link open`,
      });
      continue;
    }

    const original = await originalFinding(env, link.firstSeenRunId, link.dedupKey, run.appSlug, link.findingId);

    if (outcome === "done") {
      if (link.status !== "fixed") {
        await env.db.issueLink.update({ where: { id: link.id }, data: { status: "fixed" } });
        await markOriginal(env, original, "fixed");
        notes.push({
          icon: "ok",
          text: `${link.externalIssueId} is Done in the tracker — re-verifying the fix this run`,
        });
      }
      // Already-"fixed" links re-queue silently: a run that couldn't verify
      // (journey not walked) leaves them for the next one.
      reverify.push({
        identifier: link.externalIssueId,
        journeyTitle: journeyTitleOf(original),
        stepLabel: original?.title ?? null,
      });
      continue;
    }

    if (outcome === "canceled") {
      // Suppressing the signature is only half of it (CHE-99). Being told we
      // were wrong is the most valuable signal we ever get, and it used to stop
      // here — silently, inside our own noise model. By rule §2 our defects
      // become tickets on our own board; this is our defect.
      // CHE-100: if the run that made the claim had its credential turned away,
      // the cause is settled — our own configuration, not a judgement call.
      const originRun = link.firstSeenRunId
        ? await env.db.run.findUnique({
            where: { id: link.firstSeenRunId },
            select: { credentialsRejected: true },
          })
        : null;
      const defectClass = await classifyCheckerDefect(env, {
        originRunId: link.firstSeenRunId,
        journeyTitle: journeyTitleOf(original),
        claimText: [original?.title, parseJson<FindingDetail>(original?.detail ?? null)?.whatHappened]
          .filter(Boolean)
          .join(" "),
        configurationFault: originRun?.credentialsRejected ?? false,
      });
      await env.db.issueLink.update({
        where: { id: link.id },
        data: { status: "suppressed", defectClass },
      });
      // CHE-101: settle it against the OWNER, not the app row. Deleting and
      // re-adding an app must not re-arm a claim they already rejected.
      await env.db.settledSignature.create({
        data: {
          ownerId: app.ownerId,
          // CHE-256: the settlement is the TEAM's knowledge — a colleague must
          // not re-file what the team already had rejected. Written here, not
          // left for a later reader to find null.
          teamId: app.teamId,
          appSlug: run.appSlug,
          dedupKey: link.dedupKey,
          externalIssueId: link.externalIssueId,
          outcome: "suppressed",
          defectClass,
        },
      });
      await markOriginal(env, original, "false_positive");
      notes.push({
        icon: "ok",
        text: `${link.externalIssueId} was canceled (not a bug) — suppressing that signature from future filing`,
      });
      notes.push(
        await fileCheckerDefect(env, {
          defectClass,
          rejectedIssueId: link.externalIssueId,
          customerAppSlug: run.appSlug,
          claimTitle: original?.title ?? null,
          originRunId: link.firstSeenRunId,
        }),
      );
      continue;
    }

    // Still open in the tracker. A link we'd moved to "fixed" earlier means the
    // ticket was reopened — back to plain open, nothing to verify.
    if (link.status === "fixed") {
      await env.db.issueLink.update({ where: { id: link.id }, data: { status: "open" } });
      notes.push({
        icon: "warn",
        text: `${link.externalIssueId} was reopened — watching it as an open issue again`,
      });
    }
  }

  return { notes, reverify };
}

// The priority block handed to the walker, alongside the owner's own notes —
// same mechanism as Loop C "watch" marks. Null when there is nothing to chase.
export function reverifyInstructions(targets: ReverifyTarget[]): string | null {
  if (targets.length === 0) return null;
  const lines = targets.map(
    (t) =>
      `- ${t.stepLabel ?? t.identifier}${t.journeyTitle ? ` (journey: ${t.journeyTitle})` : ""}`,
  );
  return (
    "PRIORITY — the owner's tracker says these earlier failures were FIXED. " +
    "Re-walk each one specifically this run and pay close attention to whether " +
    `the failure is really gone:\n${lines.join("\n")}`
  );
}

// ─── Post-run: verify absence, close the loop on the ticket ──────────────────

// Runs AFTER autofile on purpose: a reappeared signature is refiled there
// first (create path — the link is non-open), flipping the link back to
// "open" so it never reaches the verified branch below.
export async function verifyFixedLinks(env: AgentEnv, runId: string): Promise<ReconcileNote[]> {
  const run = await env.db.run.findUnique({
    where: { id: runId },
    select: {
      runNumber: true,
      publicId: true,
      appSlug: true,
      watchId: true,
      appId: true,
    },
  });
  if (!run?.watchId || !run.appId) return [];
  const app = await env.db.app.findUnique({
    where: { id: run.appId },
    include: { tracker: true },
  });
  if (!app?.tracker?.teamId) return [];

  const links = await env.db.issueLink.findMany({
    where: { appId: app.id, status: "fixed" },
  });
  if (links.length === 0) return [];

  // Fresh coverage only. Carried journeys are an earlier run's evidence and
  // can't confirm a fix that shipped since.
  const walked = await env.db.journey.findMany({
    where: { runId, carriedFromRunId: null, status: { not: "skipped" } },
    select: { title: true },
  });
  if (walked.length === 0) {
    const n = links.length;
    return [
      {
        icon: "warn",
        text: `${n} fixed ticket${n === 1 ? "" : "s"} await verification, but no journey was freshly walked this run`,
      },
    ];
  }
  // No carried rows = everything was walked fresh, so absence anywhere in the
  // run is conclusive. On a partial run only a re-walked journey can vouch.
  const carried = await env.db.journey.count({
    where: { runId, carriedFromRunId: { not: null } },
  });
  const fullWalk = carried === 0;
  const walkedTitles = new Set(walked.map((j) => norm(j.title)));

  const findings = await env.db.finding.findMany({
    where: { runId },
    select: { title: true, category: true, severity: true, detail: true, anchor: true },
  });
  const presentKeys = new Set(findings.map((f) => dedupKeyForFinding(f, run)));

  const tracker: Tracker | null = await trackerFor(env.db, app.tracker, trackerCreds(env.bindings as unknown as Record<string, unknown>));
  if (!tracker) return [];
  const baseUrl = env.bindings.APP_URL ?? "https://checkmyapp.dev";
  const notes: ReconcileNote[] = [];

  for (const link of links) {
    if (presentKeys.has(link.dedupKey)) {
      // Reappeared but the link is still "fixed": the regression fell under
      // autofile's per-run cap or below its filing bar. Say so; don't verify.
      notes.push({
        icon: "warn",
        text: `${link.externalIssueId}: the failure reappeared in run #${run.runNumber} — fix NOT verified`,
      });
      continue;
    }

    const original = await originalFinding(env, link.firstSeenRunId, link.dedupKey, run.appSlug, link.findingId);
    const journeyTitle = journeyTitleOf(original);
    const covered = fullWalk || (journeyTitle !== null && walkedTitles.has(norm(journeyTitle)));
    if (!covered) {
      notes.push({
        icon: "warn",
        text: `Couldn't verify ${link.externalIssueId} — "${journeyTitle ?? "its journey"}" wasn't re-walked this run`,
      });
      continue;
    }

    const where = journeyTitle ? `re-walked "${journeyTitle}"` : "re-checked the app end to end";
    try {
      await tracker.addComment(
        link.externalIssueId,
        `Verified fixed in prod — CheckMyApp run #${run.runNumber} ${where} and the failure did not reappear.\n` +
          `Verdict: ${baseUrl}/verdict/${run.publicId}`,
      );
      // Resolved only after the comment lands: a failed comment leaves the link
      // "fixed" so the next run retries the whole verification.
      await env.db.issueLink.update({ where: { id: link.id }, data: { status: "resolved" } });
      // CHE-101: a closed loop is the product's own evidence. It outlives the
      // app row for the same reason a rejection does.
      await env.db.settledSignature.create({
        data: {
          ownerId: app.ownerId,
          teamId: app.teamId,
          appSlug: run.appSlug,
          dedupKey: link.dedupKey,
          externalIssueId: link.externalIssueId,
          outcome: "resolved",
        },
      });
      notes.push({
        icon: "ok",
        text: `Verified ${link.externalIssueId} fixed in prod — commented on the ticket`,
      });
    } catch (err) {
      notes.push({
        icon: "warn",
        text: `Verified ${link.externalIssueId} fixed, but couldn't comment on it: ${message(err)}`,
      });
    }
  }

  return notes;
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

interface OriginalFinding {
  id: string;
  title: string;
  category: string;
  severity: string;
  detail: string | null;
  mark: string;
}

// The finding that created this link, recovered by re-hashing the first-seen
// run's findings against the stored dedupKey (the key is a one-way hash, so
// this is the only way back to the journey/step it described).
async function originalFinding(
  env: AgentEnv,
  firstSeenRunId: string | null,
  dedupKey: string,
  appSlug: string,
  findingId?: string | null,
): Promise<OriginalFinding | null> {
  // CHE-103: the pointer first. Re-hashing only ever worked while the prose
  // stayed put, and our own cleanup of leaking verdict language rewrote it.
  if (findingId) {
    const row = await env.db.finding.findUnique({
      where: { id: findingId },
      select: { id: true, title: true, category: true, severity: true, detail: true, mark: true },
    });
    if (row) return row;
  }
  if (!firstSeenRunId) return null;
  const rows = await env.db.finding.findMany({
    where: { runId: firstSeenRunId },
    select: { id: true, title: true, category: true, severity: true, detail: true, anchor: true, mark: true },
  });
  return rows.find((f) => dedupKeyForFinding(f, { appSlug }) === dedupKey) ?? null;
}

function journeyTitleOf(original: OriginalFinding | null): string | null {
  return parseJson<FindingDetail>(original?.detail ?? null)?.where ?? null;
}

// Loop C write-back, but never over the owner's own triage: a hand-set mark
// outranks anything the tracker implies.
async function markOriginal(
  env: AgentEnv,
  original: OriginalFinding | null,
  mark: "fixed" | "false_positive",
): Promise<void> {
  if (!original || original.mark !== "none") return;
  await env.db.finding.update({ where: { id: original.id }, data: { mark } });
}

// Same normalization the dedup key uses, so title matching survives the same
// cosmetic drift the key was built to survive.
function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
