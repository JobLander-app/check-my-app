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
// the app retired (AppJourney.retiredAt) will never be walked again and stops
// being waited for from the first check after its retirement. A quick check
// lists no journeys and says nothing either way.
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
// Its marks and tickets still count: the owner may have triaged the copy.
//
// States, first match wins:
//   not_a_bug — marked false_positive, or its ticket was Canceled (IssueLink
//               "suppressed", tied to the issue by IssueLink.findingId, or for
//               a pre-CHE-103 customer ticket by pointLegacyLinks — a link no
//               finding produces is our own ticket and is never listed);
//   gone      — walked again and absent;
//   known     — marked known ("that's fine"), or marked fixed on its latest
//               sighting while no check has looked again yet;
//   recurring — seen in two or more checks and still there at the latest look;
//   new       — seen once and still there.
//
// recurrence() is pure so scripts/verify-finding-signature.ts can feed it the
// real meetbashar fixture; recurringByApp() loads a team's apps into it.

import type { PrismaClient } from "@/generated/prisma/client";
import { dedupKey } from "@/lib/dedup";
import { findingSignature, signatureKind, targetOf } from "@/lib/finding-signature";
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
  findingId: string | null;
  // For a link with no findingId: its CHE-59 key and the check it was first
  // seen in, so a pre-CHE-103 customer ticket can be tied to its finding.
  dedupKey?: string;
  firstSeenRunNumber?: number | null;
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
  opts: {
    signatureOf?: SignatureOf;
    // Journey identity → the first check of this app that started after the
    // journey was retired (AppJourney.retiredAt). From that check on it is no
    // longer waited for.
    retiredSince?: Map<string, number>;
  } = {},
): Recurrence[] {
  const signatureOf = opts.signatureOf ?? storedOrComputed;
  const retiredSince = opts.retiredSince ?? new Map<string, number>();
  const ordered = [...runs].sort((a, b) => a.runNumber - b.runNumber);
  const walkedIn = new Map(ordered.map((r) => [r, new Set(r.journeys.filter((j) => j.walked).map((j) => j.identity))]));

  const groups = new Map<string, Sighting[]>();
  // Restatements: not sightings, but the owner may have triaged them (a mark,
  // a ticket), and that triage is about the problem — Codex round 3.
  const restated = new Map<string, Sighting[]>();
  for (const run of ordered) {
    for (const finding of run.findings) {
      const ref = parseJson<{ stepRef?: { journeyIndex?: number } | null }>(finding.anchor)?.stepRef;
      const journey = typeof ref?.journeyIndex === "number" ? run.journeys[ref.journeyIndex] ?? null : null;
      const signature = signatureOf(finding, app.appSlug);
      if (signatureKind(signature) === "ours") continue;
      const into = journey?.carried ? restated : groups;
      into.set(signature, [...(into.get(signature) ?? []), { run, finding, journey: journey?.identity ?? null }]);
    }
  }
  const resolvedLinks = pointLegacyLinks(app, ordered, links);

  // One check does not normally report one problem twice, so a signature that
  // one check saw twice is proven too coarse for this app: on joblander.app
  // #11, "Continue with Google stuck", "Send reset link does nothing" and
  // "Sign in fires no request" were all /login + broken. Such a group is split
  // by what on the page each finding names (targetOf). Only then: that text
  // drifts, and splitting every group by it would cut meetbashar's one dead
  // link into three. The split can still leave one problem in two pieces
  // (#242 filed one problem twice under two wordings) — it under-counts, it
  // never claims a streak that is a mix.
  for (const [signature, sightings] of [...groups]) {
    const perRun = new Map<RecurrenceRun, number>();
    for (const s of sightings) perRun.set(s.run, (perRun.get(s.run) ?? 0) + 1);
    if ([...perRun.values()].every((n) => n < 2)) continue;
    groups.delete(signature);
    const splitOf = (s: Sighting) =>
      `${signature}~${dedupKey({ journeyTitle: signature, stepLabel: targetOf(s.finding.detail), failureSignature: "target" }).slice(0, 12)}`;
    for (const s of sightings) groups.set(splitOf(s), [...(groups.get(splitOf(s)) ?? []), s]);
    for (const s of restated.get(signature) ?? []) restated.set(splitOf(s), [...(restated.get(splitOf(s)) ?? []), s]);
    restated.delete(signature);
  }

  // The first check after `seen` (and before `until`) by which every journey
  // the sighting could have come from had been walked again. A journey stops
  // being waited for when a check walks it, or once the app retired it — from
  // the first check after its retirement, never judged by today's catalog (a
  // journey carried in #2 and retired before #3 was not looked at in #2).
  // A journey merely missing from a check's list is NOT released: until CHE-331
  // a full or on-demand check listed only the journeys it walked
  // (src/agent/partial.ts knownJourneysToList), so absence says nothing.
  const lookedAgain = (seen: Sighting, until = Infinity): RecurrenceRun | undefined => {
    const waitingFor = new Set(seen.journey ? [seen.journey] : walkedIn.get(seen.run)!);
    for (const r of ordered) {
      if (r.runNumber <= seen.run.runNumber) continue;
      if (r.runNumber >= until) return undefined;
      // A check with no journeys (a smoke pass, replay-complete) walked nothing,
      // but a retirement still takes effect at it — Codex round 3.
      let released = false;
      for (const j of [...waitingFor]) {
        if (walkedIn.get(r)!.has(j) || (retiredSince.get(j) ?? Infinity) <= r.runNumber) released = waitingFor.delete(j);
      }
      if (waitingFor.size === 0 && (released || r.journeys.length > 0)) return r;
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
    // Restatements of it count here (not in timesSeen).
    const triaged = [...sightings, ...(restated.get(signature) ?? [])].sort((a, b) => a.run.runNumber - b.run.runNumber);
    let mark: { mark: string; runNumber: number } | null = null;
    for (const s of triaged) {
      if (["known", "fixed", "false_positive"].includes(s.finding.mark)) mark = { mark: s.finding.mark, runNumber: s.run.runNumber };
    }
    // A ticket belongs to an issue only through IssueLink.findingId. Links
    // without one are our own [Checker gap] / [Checker defect] tickets (rules
    // 2 and 8 — on checkmyapp.dev CHE-249 counts 58 occurrences), never a
    // problem of the customer's app; and matching by the old prose-hashed
    // dedupKey would tie a ticket to whatever the hash happens to equal.
    // Customer tickets filed before CHE-103 have no findingId either; their
    // finding is recovered by pointLegacyLinks (and persisted by
    // scripts/backfill-finding-signature.ts: CHE-79, CHE-87 … on prod).
    //
    // A signature can fold several reworded findings that each got a ticket:
    // any Canceled one settles it as not a bug, and the link shown is the one
    // on the latest sighting that has a link — never whichever the database
    // happened to return first.
    const linked = triaged
      .map((s) => resolvedLinks.find((l) => l.findingId !== null && l.findingId === s.finding.id))
      .filter((l): l is RecurrenceLink => Boolean(l));
    const link = linked[linked.length - 1] ?? null;

    // A "fixed" mark is someone's word, and reconcile sets it the moment a
    // ticket moves to Done, before any re-walk. It takes the issue out of
    // "recurring" (the ticket's rule) but does not make it gone: until a check
    // has looked again it is acknowledged — "known".
    const state: RecurringIssue["state"] =
      mark?.mark === "false_positive" || linked.some((l) => l.status === "suppressed")
        ? "not_a_bug"
        : again
          ? "gone"
          : mark?.mark === "known" || (mark?.mark === "fixed" && mark.runNumber >= last.run.runNumber)
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
      const [runs, links, retired] = await Promise.all([
        db.run.findMany({
          ...alreadyScoped("the caller resolved this app"),
          where: { appId: app.id, status: { in: FINISHED } },
          orderBy: { runNumber: "asc" },
          select: {
            id: true,
            runNumber: true,
            startedAt: true,
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
          select: { id: true, status: true, findingId: true, dedupKey: true, firstSeenRunId: true },
        }),
        db.appJourney.findMany({
          where: { appId: app.id, retiredAt: { not: null } },
          select: { id: true, retiredAt: true },
        }),
      ]);
      const published = runs.filter((r) => extensionReportPublished(r));
      const retiredSince = retiredSinceRun(retired, published);
      const runNumberOf = new Map(runs.map((r) => [r.id, r.runNumber]));
      const recurrenceLinks = links.map((l) => ({
        id: l.id,
        status: l.status,
        findingId: l.findingId,
        dedupKey: l.dedupKey,
        firstSeenRunNumber: l.firstSeenRunId ? runNumberOf.get(l.firstSeenRunId) ?? null : null,
      }));
      return [app.id, recurrence(app, published.map(toRecurrenceRun), recurrenceLinks, { retiredSince }).map((r) => r.issue)];
    }),
  );
  return new Map(entries);
}

// A customer ticket filed before CHE-103 has no findingId. Its finding is
// recovered the way reconcile.originalFinding recovers it: the finding of the
// first-seen check whose CHE-59 key equals the link's, else the earliest such
// finding. A link no finding produces is our own [Checker gap] / [Checker
// defect] ticket (19 of 29 null pointers on prod, 2026-10-01) and stays
// unattached. scripts/backfill-finding-signature.ts persists the same answer,
// so after the backfill this finds nothing left to do.
export function pointLegacyLinks<L extends RecurrenceLink>(
  app: { appSlug: string },
  runs: RecurrenceRun[],
  links: L[],
): L[] {
  if (links.every((l) => l.findingId !== null || !l.dedupKey)) return links;
  const byKey = new Map<string, Array<{ runNumber: number; id: string }>>();
  for (const run of [...runs].sort((a, b) => a.runNumber - b.runNumber)) {
    for (const f of run.findings) {
      const key = dedupKeyForFinding(f, app);
      byKey.set(key, [...(byKey.get(key) ?? []), { runNumber: run.runNumber, id: f.id }]);
    }
  }
  return links.map((l) => {
    if (l.findingId !== null || !l.dedupKey) return l;
    const candidates = byKey.get(l.dedupKey) ?? [];
    const pick = candidates.find((c) => c.runNumber === l.firstSeenRunNumber) ?? candidates[0];
    return pick ? { ...l, findingId: pick.id } : l;
  });
}

// AppJourney.id → the first of these checks that started at or after the
// journey's retirement. A journey retired after the last check is not in it.
export function retiredSinceRun(
  retired: Array<{ id: string; retiredAt: Date | string | null }>,
  runs: Array<{ runNumber: number; startedAt: Date | string }>,
): Map<string, number> {
  const ordered = [...runs].sort((a, b) => a.runNumber - b.runNumber);
  const out = new Map<string, number>();
  for (const j of retired) {
    if (!j.retiredAt) continue;
    const at = new Date(j.retiredAt).getTime();
    const first = ordered.find((r) => new Date(r.startedAt).getTime() >= at);
    if (first) out.set(j.id, first.runNumber);
  }
  return out;
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
