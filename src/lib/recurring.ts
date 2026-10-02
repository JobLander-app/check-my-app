// Which problems keep coming back on an app, and which are gone (CHE-354).
//
// The owner's question: "how many problems keep recurring because nobody fixes
// them?" Findings are grouped across an app's finished checks by their
// signature (src/lib/finding-signature.ts), which survives rewording. A "page"
// or "req" signature is only a bucket — one page holds many problems, one
// failing request is cited by many findings — so inside it a finding joins the
// group whose latest finding its title says the same thing as (sameProblem),
// and otherwise starts its own.
//
// "Absent from the latest check" does not mean fixed: a partial check walks
// some journeys and carries the rest (#280 walked 4 of 12), and a walked
// journey can still skip the very step a problem was on. So a problem is gone
// only once the checks after its latest sighting have looked again where it
// was seen, and none of them saw it:
//   - anchored (Finding.anchor.stepRef): its journey, walked again through the
//     steps its own walk executed up to the anchored one — none of them
//     carried, none skipped. Positions, because step labels are reworded from
//     walk to walk (lookedAgainAt);
//   - not anchored, in a check from before anchors existed (CHE-215): every
//     journey its check walked, each looked at again — any step executed —
//     across any number of later checks. We never knew which step it came
//     from, and journeys that old have changed shape since;
//   - not anchored, in a check from the time findings are anchored (some still
//     are not): every journey its check walked, each executed again through
//     everything that walk executed — a walk that ran step 0 and skipped the
//     rest has not looked;
//   - a sighting whose check walked nothing gives no journey to wait for; the
//     first later check that walked anything is its second look, and a check
//     that carried or skipped everything is none.
// A journey the app retired (AppJourney.retiredAt) will never be walked again
// and stops being waited for from the first check after its retirement. So
// does a journey that is not in the app's catalog at all any more (checks from
// before CHE-231 named journeys by title, a new set every run), from the first
// later check that does not list it. A journey that IS in the catalog and is
// merely missing from a check's list is NOT released: until CHE-331 a full or
// on-demand check listed only the journeys it walked (src/agent/partial.ts
// knownJourneysToList).
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
//   not_a_bug — marked false_positive, or a ticket of it Canceled (IssueLink
//               "suppressed"), anywhere in its history: a ruling about the
//               problem, not about one streak. A ticket is tied to it through
//               IssueLink.findingId, or for a pre-CHE-103 customer ticket by
//               pointLegacyLinks; a link no finding produces is our own ticket
//               and is never listed;
//   gone      — looked at again (above) and absent;
//   known     — in the current streak: marked known ("that's fine"), or marked
//               fixed on its latest sighting while nothing has looked again;
//   recurring — seen in two or more checks of the current streak, still there;
//   new       — seen once and still there.
//
// recurrence() is pure so scripts/verify-finding-signature.ts can feed it the
// real meetbashar fixture through toRecurrenceRun; recurringByApp() loads a
// team's apps into it.

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { findingSignature, sameProblem, signatureKind, titleSimilarity, SAME_PROBLEM } from "@/lib/finding-signature";
import { extensionReportPublished } from "@/lib/extension-target";
import { parseJson } from "@/lib/json";
import { dedupKeyForFinding } from "@/lib/tracker/file";
import { teamOwned, teamRows } from "@/lib/tenant-db";

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

export interface RecurrenceJourney {
  identity: string;
  // Copied forward from an earlier check: this check did not look at it.
  carried: boolean;
  // Step statuses in step order ("ok", "broken", "skipped", …).
  steps: string[];
}

export interface RecurrenceRun {
  runNumber: number;
  // In journey order — Finding.anchor.stepRef.journeyIndex indexes this, as it
  // indexed the journeys persistFindings loaded.
  journeys: RecurrenceJourney[];
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
  // The first check by which everything the latest sighting could have come
  // from had been looked at again. Null while it has not.
  goneSinceRunNumber: number | null;
  // The findings of the current streak, oldest first — what "seen N times"
  // counts, so a page can link each one and a reader can check the grouping.
  sightings: Array<{ runNumber: number; findingId: string; title: string }>;
}

type SignatureOf = (f: RecurrenceFinding, appSlug: string) => string;

const storedOrComputed: SignatureOf = (f, appSlug) => f.signature ?? findingSignature({ appSlug, ...f });

// The step positions a walk executed (not skipped), up to `upTo` when given.
function executed(j: RecurrenceJourney, upTo?: number): number[] {
  const out: number[] = [];
  j.steps.forEach((s, i) => {
    if (s !== "skipped" && (upTo === undefined || i <= upTo)) out.push(i);
  });
  return out;
}

// Did this journey row look again at what an earlier walk looked at — execute
// every one of these step positions itself, none carried, none skipped? "What
// the earlier walk looked at", not "every step": some journeys have a step no
// walk ever takes (checkmyapp.dev's "Check an app by URL" skips its fourth step
// in every check), and demanding it would keep a finding open for good.
// A walk shorter than a position answers with its own last step (meetbashar
// #275 checked the Holotope guide's links in step 0 of 3; #267 had found them
// dead in step 3).
//
// "any" is for a finding with no anchor (rows from before CHE-215): we never
// knew which step it came from, and journeys of that age have since changed
// shape, so step positions would be pretence. Any step of the journey executed
// again counts as a second look.
export function lookedAgainAt(j: RecurrenceJourney, positions: number[] | "any"): boolean {
  if (j.carried || j.steps.length === 0) return false;
  if (positions === "any") return j.steps.some((s) => s !== "skipped");
  return positions.length > 0 && positions.every((p) => j.steps[Math.min(p, j.steps.length - 1)] !== "skipped");
}

// What a later walk of `journey` must execute to have looked again at a
// finding anchored to step `stepIndex` of it: the positions its own walk
// executed up to that step, and that step itself. With no step (the anchor
// names only the journey), everything the walk executed. One rule for
// recurrence and for the release delta (src/lib/releases.ts).
export function positionsSeen(journey: RecurrenceJourney, stepIndex: number | null): number[] {
  const upTo = stepIndex ?? undefined;
  return [...new Set([...executed(journey, upTo), ...(upTo === undefined ? [] : [upTo])])];
}

interface Sighting {
  run: RecurrenceRun;
  finding: RecurrenceFinding;
  // The journey row the finding is anchored to, in its own check.
  journey: RecurrenceJourney | null;
  stepIndex: number | null;
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
    // The journeys the app has today (AppJourney ids, not retired). A journey
    // identity outside it can never be walked again: checks from before the
    // catalog (CHE-231) named their journeys by title, a new set every run.
    // Without this, a finding of run #29 waits for those titles forever and
    // reads as "recurring" a hundred checks later (checkmyapp.dev listed
    // "Clerk loaded with development keys" that way on 2026-10-02).
    liveJourneys?: Set<string>;
  } = {},
): Recurrence[] {
  const signatureOf = opts.signatureOf ?? storedOrComputed;
  const retiredSince = opts.retiredSince ?? new Map<string, number>();
  const live = opts.liveJourneys;
  const ordered = [...runs].sort((a, b) => a.runNumber - b.runNumber);

  // Groups of sightings that are one problem, each under its own key.
  const groups = new Map<string, Sighting[]>();
  // Restatements: not sightings, but the owner may have triaged them (a mark,
  // a ticket), and that triage is about the problem.
  const restated = new Map<string, Sighting[]>();
  const keyFor = (signature: string, s: Sighting, allowNew: boolean): string | null => {
    if (!isBucket(signature)) return signature;
    // Inside a bucket: join the group whose LATEST finding says the same
    // thing, the way a streak continues from one check to the next.
    let best: { key: string; sim: number } | null = null;
    for (const [key, list] of groups) {
      if (!key.startsWith(`${signature}~`)) continue;
      const sim = titleSimilarity(list[list.length - 1].finding.title, s.finding.title);
      if (sim >= SAME_PROBLEM && (!best || sim > best.sim)) best = { key, sim };
    }
    if (best) return best.key;
    return allowNew ? `${signature}~${s.finding.id}` : null;
  };
  // The app's first check with an anchored finding (CHE-215). Before it, "no
  // anchor" means "we never recorded one"; from it on, it means "this finding
  // has none" — and the second look is held to what the walk executed.
  let anchorsSince = Infinity;
  for (const run of ordered) {
    for (const finding of run.findings) {
      const ref = parseJson<{ stepRef?: { journeyIndex?: number; stepIndex?: number } | null }>(finding.anchor)?.stepRef;
      if (typeof ref?.journeyIndex === "number") anchorsSince = Math.min(anchorsSince, run.runNumber);
      const journey = typeof ref?.journeyIndex === "number" ? run.journeys[ref.journeyIndex] ?? null : null;
      const signature = signatureOf(finding, app.appSlug);
      if (signatureKind(signature) === "ours") continue;
      const s: Sighting = {
        run,
        finding,
        journey,
        stepIndex: journey && typeof ref?.stepIndex === "number" ? ref.stepIndex : null,
      };
      if (journey?.carried) {
        const key = keyFor(signature, s, false);
        if (key) restated.set(key, [...(restated.get(key) ?? []), s]);
        continue;
      }
      const key = keyFor(signature, s, true)!;
      groups.set(key, [...(groups.get(key) ?? []), s]);
    }
  }
  const resolvedLinks = pointLegacyLinks(app, ordered, links);

  // The first check after `seen` (and before `until`) by which everything the
  // sighting could have come from had been looked at again — see the header.
  // `catalog: false` asks only about real second looks — used to decide
  // whether two sightings are one streak: a problem seen again was there all
  // along, whatever became of the journeys in between.
  const lookedAgain = (seen: Sighting, until = Infinity, catalog = true): RecurrenceRun | undefined => {
    // Journey identity → what a later walk of it must have executed: for an
    // anchored finding, the positions its own walk executed up to the anchored
    // step (that step itself always); for one with no anchor, any step of each
    // journey its check walked.
    const waitingFor = new Map<string, number[] | "any">();
    if (seen.journey) {
      const positions = positionsSeen(seen.journey, seen.stepIndex);
      if (positions.length > 0) waitingFor.set(seen.journey.identity, positions);
    } else {
      // No anchor. In a check from before anchors existed, any later look at
      // each journey counts. In a check from the time findings ARE anchored
      // (one in six still is not: 6 of 36 on prod's checks #250+), "any" would
      // let a walk that ran step 0 and skipped the rest release it — so each
      // journey must be executed again through everything its own walk did.
      const strict = seen.run.runNumber >= anchorsSince;
      for (const j of seen.run.journeys) {
        if (!j.carried && executed(j).length > 0) waitingFor.set(j.identity, strict ? positionsSeen(j, null) : "any");
      }
    }
    for (const r of ordered) {
      if (r.runNumber <= seen.run.runNumber) continue;
      if (r.runNumber >= until) return undefined;
      // Its own check walked nothing, so there is no journey to wait for
      // (joblander.app #72: "No journeys were walked this run"). The first
      // later check that walked anything at all is the only second look
      // there can be; one that carried or skipped everything is none.
      if (waitingFor.size === 0) {
        if (r.journeys.some((j) => lookedAgainAt(j, "any"))) return r;
        continue;
      }
      for (const [id, positions] of [...waitingFor]) {
        const retired = (retiredSince.get(id) ?? Infinity) <= r.runNumber;
        // No longer one of the app's journeys, and this check does not list
        // it either: it has left the catalog, as a retired journey has.
        const left = catalog && live !== undefined && !live.has(id) && !r.journeys.some((j) => j.identity === id);
        if (retired || left || r.journeys.some((j) => j.identity === id && lookedAgainAt(j, positions))) waitingFor.delete(id);
      }
      if (waitingFor.size === 0) return r;
    }
    return undefined;
  };

  const out: Recurrence[] = [];
  for (const [key, sightings] of groups) {
    // A problem that went away and came back is a new streak, and only the
    // latest one is reported: "seen 6 times" must mean six checks in a row
    // that found it, not six over a history with fixes in between.
    let start = 0;
    for (let i = 1; i < sightings.length; i++) {
      if (lookedAgain(sightings[i - 1], sightings[i].run.runNumber, false)) start = i;
    }
    const streak = sightings.slice(start);
    const checks = [...new Set(streak.map((s) => s.run))];
    const last = streak[streak.length - 1];
    const again = lookedAgain(last);

    const triaged = [...sightings, ...(restated.get(key) ?? [])].sort((a, b) => a.run.runNumber - b.run.runNumber);
    const inStreak = triaged.filter((s) => s.run.runNumber >= streak[0].run.runNumber);
    let mark: { mark: string; runNumber: number } | null = null;
    for (const s of inStreak) {
      if (["known", "fixed"].includes(s.finding.mark)) mark = { mark: s.finding.mark, runNumber: s.run.runNumber };
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
    // A group can fold several reworded findings that each got a ticket: any
    // Canceled one settles it as not a bug, and the link shown is the one on
    // the latest finding that has a link — never whichever the database
    // happened to return first.
    const linked = triaged
      .map((s) => resolvedLinks.find((l) => l.findingId !== null && l.findingId === s.finding.id))
      .filter((l): l is RecurrenceLink => Boolean(l));
    const link = linked[linked.length - 1] ?? null;
    const ruledNotABug = triaged.some((s) => s.finding.mark === "false_positive") || linked.some((l) => l.status === "suppressed");

    // A "fixed" mark is someone's word, and reconcile sets it the moment a
    // ticket moves to Done, before any re-walk. It takes the issue out of
    // "recurring" (the ticket's rule) but does not make it gone: until a check
    // has looked again it is acknowledged — "known".
    const state: RecurringIssue["state"] = ruledNotABug
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
        signature: key,
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
      sightings: streak.map((s) => ({ runNumber: s.run.runNumber, findingId: s.finding.id, title: s.finding.title })),
    });
  }
  return out.sort((a, b) => b.issue.lastSeenRunNumber - a.issue.lastSeenRunNumber);
}

// A "page" or "req" signature is a bucket, not an identity. A page holds many
// problems; and a failing request is cited as evidence by findings that are
// about different things — on joblander.app one `verify-session 401` signature
// held "Sign in fires no network request", "verify-session 401 on every page
// load" and "the owner's analytics flag is misattributed" (prod, #12–#63).
// Inside a bucket the titles decide. An extension's error signature and the
// wording fallback are already as narrow as one problem.
const isBucket = (signature: string) => ["page", "req"].includes(signatureKind(signature));

// Two findings are the same problem: one signature, and inside a bucket a
// title that says the same thing. The rule recurrence groups by, for a caller
// that compares the findings of two checks directly.
export function sameIssue(a: { signature: string; title: string }, b: { signature: string; title: string }): boolean {
  if (a.signature !== b.signature) return false;
  return !isBucket(a.signature) || sameProblem(a, b);
}

interface HistoryRun extends RecurrenceRunRow {
  id: string;
  startedAt: Date;
  status: string;
  verdict: string | null;
  targetKind: string;
}

// D1 hands a DateTime back as text, in one of the two spellings prod holds
// ("2026-09-02 21:23:10", written by hand, and ISO). The first has no zone and
// JS would read it as local time.
const d1Date = (v: string | Date) => (v instanceof Date ? v : new Date(v.includes("T") ? v : `${v.replace(" ", "T")}Z`));

// Every finished check of a team's apps with its journeys, steps and findings:
// four flat statements for the whole team, one bound parameter each, stitched
// here. The nested select this replaces asked the query engine to assemble
// run → journey → step for an app's whole history; on one team of four apps
// (190 checks, 900 journeys, 4,000 steps) the engine gave up ("RuntimeError:
// unreachable") and the page that asked took 30 s (the CHE-357 stand,
// 2026-10-02 — before any page in prod read this).
//
// Each statement binds the team itself (teamRows — src/lib/tenant-db.ts), so
// the tenant verifier sees the scope in every one of them.
// Finished with a verdict only: `failed` is CheckMyApp not finishing, not a
// statement about the app (CLAUDE.md §4) — and it walked nothing to compare.
// `only` narrows the same statements to one of the team's apps — still inside
// the team's scope, so an id from another team reads nothing.
const finishedChecksOf = (team: string, only?: string) =>
  Prisma.sql`r.appId IN (SELECT id FROM "App" WHERE teamId = ${team}) AND r.status IN ('completed', 'partial')${
    only === undefined ? Prisma.empty : Prisma.sql` AND r.appId = ${only}`
  }`;

async function teamHistory(db: PrismaClient, teamId: string, only?: string): Promise<Map<string, HistoryRun[]>> {
  const [runs, journeys, steps, findings] = await Promise.all([
    // startedAt as the text it is stored as, so the spelling is read here and
    // not guessed by the driver.
    db.$queryRaw<{ id: string; appId: string; runNumber: number | bigint; startedAt: string | Date; status: string; verdict: string | null; targetKind: string }[]>(
      Prisma.sql`SELECT r.id, r.appId, r.runNumber, CAST(r.startedAt AS TEXT) AS startedAt, r.status, r.verdict, r.targetKind
        FROM "Run" r WHERE ${finishedChecksOf(teamRows(teamId), only)} ORDER BY r.runNumber`,
    ),
    db.$queryRaw<{ id: string; runId: string; appJourneyId: string | null; journeyKey: string | null; title: string; carriedFromRunId: string | null }[]>(
      Prisma.sql`SELECT j.id, j.runId, j.appJourneyId, j.journeyKey, j.title, j.carriedFromRunId
        FROM "Journey" j JOIN "Run" r ON r.id = j.runId WHERE ${finishedChecksOf(teamRows(teamId), only)} ORDER BY j.runId, j."order"`,
    ),
    db.$queryRaw<{ journeyId: string; status: string }[]>(
      Prisma.sql`SELECT s.journeyId, s.status
        FROM "Step" s JOIN "Journey" j ON j.id = s.journeyId JOIN "Run" r ON r.id = j.runId
        WHERE ${finishedChecksOf(teamRows(teamId), only)} ORDER BY s.journeyId, s."order"`,
    ),
    db.$queryRaw<(RecurrenceFinding & { runId: string })[]>(
      Prisma.sql`SELECT f.id, f.runId, f.title, f.category, f.severity, f.mark, f.detail, f.anchor, f.signature
        FROM "Finding" f JOIN "Run" r ON r.id = f.runId WHERE ${finishedChecksOf(teamRows(teamId), only)} ORDER BY f.runId, f.number`,
    ),
  ]);
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  const stepsOf = new Map<string, Array<{ status: string }>>();
  for (const s of steps) push(stepsOf, s.journeyId, { status: s.status });
  const journeysOf = new Map<string, HistoryRun["journeys"]>();
  for (const j of journeys) push(journeysOf, j.runId, { ...j, steps: stepsOf.get(j.id) ?? [] });
  const findingsOf = new Map<string, RecurrenceFinding[]>();
  for (const { runId, ...f } of findings) push(findingsOf, runId, f);
  const byApp = new Map<string, HistoryRun[]>();
  for (const r of runs) {
    push(byApp, r.appId, {
      id: r.id,
      runNumber: Number(r.runNumber),
      startedAt: d1Date(r.startedAt),
      status: r.status,
      verdict: r.verdict,
      targetKind: r.targetKind,
      journeys: journeysOf.get(r.id) ?? [],
      findings: findingsOf.get(r.id) ?? [],
    });
  }
  return byApp;
}

// `only`: a page about one app asks for that app alone (CHE-358), so its
// database work follows that app's history and not the team's whole portfolio.
export async function recurringByApp(db: PrismaClient, teamId: string, only?: string): Promise<Map<string, RecurringIssue[]>> {
  const [apps, history] = await Promise.all([
    db.app.findMany({
      where: { ...teamOwned(teamId), ...(only === undefined ? {} : { id: only }) },
      select: { id: true, appSlug: true },
    }),
    teamHistory(db, teamId, only),
  ]);
  const entries = await Promise.all(
    apps.map(async (app): Promise<[string, RecurringIssue[]]> => {
      const runs = history.get(app.id) ?? [];
      const [links, catalog] = await Promise.all([
        db.issueLink.findMany({
          where: { appId: app.id },
          select: { id: true, status: true, findingId: true, dedupKey: true, firstSeenRunId: true },
        }),
        db.appJourney.findMany({
          where: { appId: app.id },
          select: { id: true, retiredAt: true },
        }),
      ]);
      const published = runs.filter((r) => extensionReportPublished(r));
      const retiredSince = retiredSinceRun(catalog.filter((j) => j.retiredAt !== null), published);
      const liveJourneys = new Set(catalog.filter((j) => j.retiredAt === null).map((j) => j.id));
      const runNumberOf = new Map(runs.map((r) => [r.id, r.runNumber]));
      const recurrenceLinks = links.map((l) => ({
        id: l.id,
        status: l.status,
        findingId: l.findingId,
        dedupKey: l.dedupKey,
        firstSeenRunNumber: l.firstSeenRunId ? runNumberOf.get(l.firstSeenRunId) ?? null : null,
      }));
      return [
        app.id,
        recurrence(app, published.map(toRecurrenceRun), recurrenceLinks, { retiredSince, liveJourneys }).map((r) => r.issue),
      ];
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

export interface RecurrenceRunRow {
  runNumber: number;
  journeys: Array<{
    appJourneyId: string | null;
    journeyKey: string | null;
    title: string;
    carriedFromRunId: string | null;
    steps: Array<{ status: string }>;
  }>;
  findings: RecurrenceFinding[];
}

export function toRecurrenceRun(run: RecurrenceRunRow): RecurrenceRun {
  return {
    runNumber: run.runNumber,
    journeys: run.journeys.map((j) => ({
      identity: j.appJourneyId ?? j.journeyKey ?? j.title,
      carried: j.carriedFromRunId !== null,
      steps: j.steps.map((s) => s.status),
    })),
    findings: run.findings,
  };
}
