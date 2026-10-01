// Which problems keep coming back on an app, and which are gone (CHE-354).
//
// The owner's question: "how many problems keep recurring because nobody fixes
// them?" Findings are grouped across an app's finished checks by their
// signature (src/lib/finding-signature.ts), which survives rewording.
//
// "Absent from the latest check" does not mean fixed: a partial check walks
// some journeys and carries the rest (#280 walked 4 of 12). So a problem is
// gone only once the checks after its latest sighting have walked again every
// journey it could have come from, and none of them saw it:
//   - anchored (Finding.anchor.stepRef): the journey of its latest sighting;
//   - not anchored (rows from before CHE-215): every journey its latest
//     sighting's check walked, since it came from one of them — re-walked
//     across any number of later checks, not necessarily in one.
// A check "walked" a journey when the journey was not carried forward and not
// skipped — the same test reconcile uses before it verifies a fix. A journey
// the app no longer has (absent from the latest check that listed journeys)
// will never be walked again and is not waited for; when none is left, the
// next check that listed journeys is the one that looked.
//
// A problem that was gone and then seen again starts a new streak; first seen
// and times seen describe the latest streak only.
//
// The one finding that is about us — test records our own check left behind
// (signature kind "ours") — is not the customer's problem and is left out.
//
// A finding anchored to a journey its own check carried rather than walked is
// a restatement of an earlier walk ("from an earlier walk, not re-verified
// today" — meetbashar #246, #255, #259). It is not a sighting: counting it would
// make "seen 7 times" rest on our own copy, not on the product (CLAUDE.md §8).
//
// States, first match wins:
//   not_a_bug — marked false_positive, or its ticket was Canceled (IssueLink
//               "suppressed");
//   gone      — marked fixed on its latest sighting, or walked again and absent;
//   known     — marked known ("that's fine");
//   recurring — seen in two or more checks and still there at the latest look;
//   new       — seen once and still there.
//
// recurrence() is pure so scripts/verify-finding-signature.ts can feed it the
// real meetbashar fixture; recurringByApp() loads a team's apps into it.

import type { PrismaClient } from "@/generated/prisma/client";
import { findingSignature, signatureKind } from "@/lib/finding-signature";
import { extensionReportPublished } from "@/lib/extension-target";
import { parseJson } from "@/lib/json";
import { dedupKeyForFinding } from "@/lib/tracker/file";
import { alreadyScoped, teamOwned } from "@/lib/tenant-db";

export interface RecurringIssue {
  signature: string;
  appId: string;
  title: string; // latest wording
  category: string;
  severity: string;
  firstSeenRunNumber: number;
  lastSeenRunNumber: number;
  timesSeen: number;
  state: "new" | "recurring" | "gone" | "known" | "not_a_bug";
  issueLinkId: string | null;
}

export interface RecurrenceFinding {
  id: string;
  title: string;
  category: string;
  severity: string;
  mark: string;
  detail: string | null;
  anchor: string | null;
  signature: string | null;
}

export interface RecurrenceRun {
  runNumber: number;
  // In journey order — Finding.anchor.stepRef.journeyIndex indexes this, as it
  // indexed the journeys persistFindings loaded.
  // carried: copied forward from an earlier check. walked: not carried and not
  // skipped — this check looked at it.
  journeys: Array<{ identity: string; carried: boolean; walked: boolean }>;
  findings: RecurrenceFinding[];
}

export interface RecurrenceLink {
  id: string;
  status: string;
  dedupKey: string;
  findingId: string | null;
}

export interface Recurrence {
  issue: RecurringIssue;
  // The first check after the latest sighting that walked where it was seen.
  // Null while nothing has looked again.
  goneSinceRunNumber: number | null;
}

type SignatureOf = (f: RecurrenceFinding, appSlug: string) => string;

const storedOrComputed: SignatureOf = (f, appSlug) => f.signature ?? findingSignature({ appSlug, ...f });

interface Sighting {
  run: RecurrenceRun;
  finding: RecurrenceFinding;
  journey: string | null;
}

export function recurrence(
  app: { id: string; appSlug: string },
  runs: RecurrenceRun[],
  links: RecurrenceLink[],
  signatureOf: SignatureOf = storedOrComputed,
): Recurrence[] {
  const ordered = [...runs].sort((a, b) => a.runNumber - b.runNumber);
  const walkedIn = new Map(ordered.map((r) => [r, new Set(r.journeys.filter((j) => j.walked).map((j) => j.identity))]));
  // The app's journeys as the latest check that listed any knew them. A quick
  // check lists none and says nothing about which journeys exist.
  const listing = [...ordered].reverse().find((r) => r.journeys.length > 0);
  const current = new Set(listing?.journeys.map((j) => j.identity) ?? []);

  const groups = new Map<string, Sighting[]>();
  for (const run of ordered) {
    for (const finding of run.findings) {
      const ref = parseJson<{ stepRef?: { journeyIndex?: number } | null }>(finding.anchor)?.stepRef;
      const journey = typeof ref?.journeyIndex === "number" ? run.journeys[ref.journeyIndex] ?? null : null;
      if (journey?.carried) continue; // a restatement, not a sighting
      const signature = signatureOf(finding, app.appSlug);
      if (signatureKind(signature) === "ours") continue;
      const list = groups.get(signature) ?? [];
      list.push({ run, finding, journey: journey?.identity ?? null });
      groups.set(signature, list);
    }
  }

  // The first check after `seen` (and before `until`) by which every journey
  // the sighting could have come from had been walked again.
  const lookedAgain = (seen: Sighting, until = Infinity): RecurrenceRun | undefined => {
    const waitingFor = new Set(
      (seen.journey ? [seen.journey] : [...walkedIn.get(seen.run)!]).filter((j) => current.has(j)),
    );
    for (const r of ordered) {
      if (r.runNumber <= seen.run.runNumber || r.journeys.length === 0) continue;
      if (r.runNumber >= until) return undefined;
      for (const j of walkedIn.get(r)!) waitingFor.delete(j);
      if (waitingFor.size === 0) return r;
    }
    return undefined;
  };

  const out: Recurrence[] = [];
  for (const [signature, sightings] of groups) {
    // A problem that went away and came back is a new streak, and only the
    // latest one is reported: "seen 6 times" must mean six checks in a row
    // that found it, not six over a history with fixes in between. This also
    // bounds what the page key can merge — on joblander.app/settings a "Save
    // Changes stays disabled" streak ended in August, and a different problem
    // on that page in #278 is not its seventh sighting.
    let start = 0;
    for (let i = 1; i < sightings.length; i++) {
      if (lookedAgain(sightings[i - 1], sightings[i].run.runNumber)) start = i;
    }
    const streak = sightings.slice(start);
    const checks = [...new Set(streak.map((s) => s.run))];
    const last = streak[streak.length - 1];
    const again = lookedAgain(last);

    // Marks from the whole history: "not a bug" and "known" are about the
    // problem, and persistFindings carries them onto later findings anyway.
    let mark: { mark: string; runNumber: number } | null = null;
    for (const s of sightings) {
      if (["known", "fixed", "false_positive"].includes(s.finding.mark)) mark = { mark: s.finding.mark, runNumber: s.run.runNumber };
    }
    const ids = new Set(sightings.map((s) => s.finding.id));
    const link =
      links.find((l) => l.findingId && ids.has(l.findingId)) ??
      links.find((l) => sightings.some((s) => dedupKeyForFinding(s.finding, app) === l.dedupKey)) ??
      null;

    const state: RecurringIssue["state"] =
      mark?.mark === "false_positive" || link?.status === "suppressed"
        ? "not_a_bug"
        : (mark?.mark === "fixed" && mark.runNumber >= last.run.runNumber) || again
          ? "gone"
          : mark?.mark === "known"
            ? "known"
            : checks.length >= 2
              ? "recurring"
              : "new";

    out.push({
      issue: {
        signature,
        appId: app.id,
        title: last.finding.title,
        category: last.finding.category,
        severity: last.finding.severity,
        firstSeenRunNumber: streak[0].run.runNumber,
        lastSeenRunNumber: last.run.runNumber,
        timesSeen: checks.length,
        state,
        issueLinkId: link?.id ?? null,
      },
      goneSinceRunNumber: again?.runNumber ?? null,
    });
  }
  return out.sort((a, b) => b.issue.lastSeenRunNumber - a.issue.lastSeenRunNumber);
}

// A run that finished with a verdict. `failed` is CheckMyApp not finishing, not
// a statement about the app (CLAUDE.md §4) — and it walked nothing to compare.
const FINISHED = ["completed", "partial"];

export async function recurringByApp(db: PrismaClient, teamId: string): Promise<Map<string, RecurringIssue[]>> {
  const apps = await db.app.findMany({
    where: { ...teamOwned(teamId) },
    select: { id: true, appSlug: true },
  });
  const entries = await Promise.all(
    apps.map(async (app): Promise<[string, RecurringIssue[]]> => {
      const [runs, links] = await Promise.all([
        db.run.findMany({
          ...alreadyScoped("the caller resolved this app"),
          where: { appId: app.id, status: { in: FINISHED } },
          orderBy: { runNumber: "asc" },
          select: {
            runNumber: true,
            status: true,
            verdict: true,
            targetKind: true,
            journeys: {
              orderBy: { order: "asc" },
              select: { appJourneyId: true, journeyKey: true, title: true, carriedFromRunId: true, status: true },
            },
            findings: {
              orderBy: { number: "asc" },
              select: {
                id: true,
                title: true,
                category: true,
                severity: true,
                mark: true,
                detail: true,
                anchor: true,
                signature: true,
              },
            },
          },
        }),
        db.issueLink.findMany({
          where: { appId: app.id },
          select: { id: true, status: true, dedupKey: true, findingId: true },
        }),
      ]);
      const published = runs.filter((r) => extensionReportPublished(r)).map(toRecurrenceRun);
      return [app.id, recurrence(app, published, links).map((r) => r.issue)];
    }),
  );
  return new Map(entries);
}

export function toRecurrenceRun(run: {
  runNumber: number;
  journeys: Array<{ appJourneyId: string | null; journeyKey: string | null; title: string; carriedFromRunId: string | null; status: string }>;
  findings: RecurrenceFinding[];
}): RecurrenceRun {
  return {
    runNumber: run.runNumber,
    journeys: run.journeys.map((j) => ({
      identity: j.appJourneyId ?? j.journeyKey ?? j.title,
      carried: j.carriedFromRunId !== null,
      walked: j.carriedFromRunId === null && j.status !== "skipped",
    })),
    findings: run.findings,
  };
}
