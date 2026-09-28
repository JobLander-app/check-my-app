// Partial watch runs (CHE-57) — the middle rung of the mode ladder.
//
// A watch whose last check found trouble in two journeys out of five does not
// need the other three walked again tonight. It needs the two bad ones
// re-walked, hard, and the three good ones stated as what they are: verified
// recently, carried forward, not re-checked today.
//
// The ladder, in the order the workflow tries it:
//   1. SMOKE (replay.ts) — baseline healthy and its known pages still serve:
//      carry the whole verdict, $0.01, done.
//   2. PARTIAL (here) — baseline has both bad and good journeys: skip discovery
//      entirely, re-walk the bad ones, copy the good ones forward, synthesize
//      over the combined picture.
//   3. FULL — everything else.
//
// What partial does NOT do: it does not skip synthesis. A smoke pass can end a
// run without a verdict of its own because it re-verifies nothing; a partial run
// produces fresh evidence and must be adjudicated like any other run — verdict
// integrity guards included.
//
// Two honesty rules hold this together:
//   - Provenance is the run that ACTUALLY walked a journey. Carrying a journey
//     that was itself carried points carriedFromRunId further back, never at the
//     run we copied from — so a carry chain can never launder a two-week-old
//     walk into "checked yesterday".
//   - Carried evidence expires on the same clock as the smoke path
//     (FULL_RUN_MAX_AGE_DAYS) — and since CHE-132 on the same gate: an app the
//     survey saw unchanged is never sent full for age alone, a changed one
//     always is, and the clock applies only when nothing could be compared.
//
// Bias on every uncertainty, as in replay.ts: fall through to the full run.

import type { AgentEnv } from "./env";
import { FULL_RUN_MAX_AGE_DAYS, findLastWalkedRun } from "./replay";
import { fullRunGate, gateInputFrom, surveySaysUnchanged, type SurveyOutcome } from "./snapshot";
import { journeysForPlanning, recordCarry, type CatalogJourneyState } from "./journey-catalog";
import { matchJourney } from "@/lib/journey-key";
import { parseRunAccounts, usableRunAccounts } from "@/lib/test-accounts";
import type { ProposedJourney } from "./discovery";
import { cutSelfCheckRefusalClaims, isSelfCheckRefusalStep, summaryFallback, walkSummaryOnly } from "@/lib/verdict-language";

// The only journey statuses worth carrying: "ok" (everything worked) and
// "partial" (everything attempted worked, some steps went unverified). Anything
// else — broken, exposed, risky, confusing, skipped — is either a problem the
// owner is waiting on or a journey that verified nothing, and both get re-walked.
const CARRIABLE_STATUSES = new Set(["ok", "partial"]);

// The re-walk proposal reuses the baseline's own step labels. Long journeys get
// clipped so the walking prompt stays a plan, not a transcript.
const MAX_PROPOSED_STEPS = 12;

/**
 * How many journeys one run may actually walk. The same number discovery is
 * allowed to propose (discovery.ts), for the same reason: a walk is the
 * expensive thing, and five of them is what a daily check can afford.
 *
 * It is also what makes the rotation necessary. joblander's catalog holds 23
 * live journeys; at five a run, a full circuit takes five days, which is inside
 * the seven-day window carried evidence is allowed to live in
 * (FULL_RUN_MAX_AGE_DAYS). A catalog bigger than budget × window cannot be kept
 * inside that window at all — that is a coverage gap of ours, and the plan says
 * so rather than quietly carrying month-old evidence as if it were last night's.
 */
export const JOURNEY_WALK_BUDGET = 5;

/** A journey copied forward from an earlier run instead of walked again. */
export interface CarriedJourney {
  /** Journey row on the baseline run that gets copied (with its steps + evidence). */
  sourceJourneyId: string;
  /** Position in this run — baseline order, re-indexed to 0..n-1. */
  order: number;
  title: string;
  /** The run that actually walked it. Provenance root, not the run we copy from. */
  sourceRunId: string;
  sourceRunNumber: number;
  /**
   * When that walk happened, ISO. Set on the journeys a run lists without
   * walking (knownJourneysToList) so the coverage line can date each one; a
   * partial plan dates its carry once, in oldestVerifiedAt.
   */
  walkedAt?: string;
}

/** A journey that was bad last time and gets walked again from its old plan. */
export interface RewalkJourney {
  order: number;
  title: string;
  /** Baseline step labels, fed to walkOneJourney as the proposed steps. */
  steps: string[];
  /** What it looked like last time — for the run feed, not for the verdict. */
  previousStatus: string;
}

export interface PartialPlan {
  taken: true;
  /** Run the journeys are copied from (the last one that actually walked). */
  baselineRunId: string;
  baselineRunNumber: number;
  /** Reused instead of re-running discovery/anatomy — same app, same map. */
  anatomy: string | null;
  carry: CarriedJourney[];
  rewalk: RewalkJourney[];
  /**
   * CHE-232: journeys this run neither walked nor carried — the budget could not
   * reach them and their evidence is already too old to stand on. Empty in every
   * ordinary case; non-empty means the catalog has outgrown what a run can keep
   * verified, which is a coverage gap of ours to say out loud, never a silence.
   */
  deferred?: string[];
  /** Oldest real walk among the carried journeys — the weakest link we're standing on. */
  oldestVerifiedAt: string;
}

export interface PartialSkipped {
  taken: false;
  reason: string;
}

export type PartialDecision = PartialPlan | PartialSkipped;

// ─── Which journeys this run walks (CHE-232) ─────────────────────────────────

/** One journey's place in tonight's plan, decided from the catalog alone. */
export interface Rotation {
  /** Walked again tonight: due, or the oldest green ones filling the budget. */
  walk: CatalogJourneyState[];
  /** Green and recent enough to stand on; copied forward with its own date. */
  carry: CatalogJourneyState[];
  /**
   * Neither walked nor carried: its evidence is too old to stand on and the
   * budget did not reach it. This is our coverage gap, never a silence — the
   * caller says so out loud and files it (rule 2).
   */
  deferred: CatalogJourneyState[];
}

/**
 * Tonight's plan, from the catalog's own state. Pure on purpose: everything it
 * needs is in the arguments, so scripts/verify-journey-rotation.ts can hold the
 * real rules against real shapes without a database.
 *
 * The order of the walk list is the order of urgency, and it is the whole
 * design:
 *
 *   1. journeys that ended badly — a failing journey is re-checked every run,
 *      however long the queue behind it, because it is the one the owner is
 *      waiting on (longest failing streak first);
 *   2. journeys nothing has ever walked — a catalog row discovery proposed but
 *      no run reached is not "green", it is unknown;
 *   3. everything else oldest-first, which is the rotation: with a budget of
 *      five a day, the twenty-third journey comes round on the fifth day
 *      instead of never.
 *
 * A journey whose evidence has aged past `maxAgeDays` can no longer be carried
 * — carrying it would date last month's walk as tonight's — so it is due even
 * when it is green, and if the budget cannot reach it, it is deferred rather
 * than pretended about.
 */
export function planRotation(args: {
  journeys: CatalogJourneyState[];
  now: Date;
  budget?: number;
  maxAgeDays?: number;
  /** When the survey says nothing changed, age alone never forces a walk (CHE-132). */
  ageCounts?: boolean;
}): Rotation {
  const budget = args.budget ?? JOURNEY_WALK_BUDGET;
  const maxAgeDays = args.maxAgeDays ?? FULL_RUN_MAX_AGE_DAYS;
  const ageCounts = args.ageCounts ?? true;

  const isGreen = (j: CatalogJourneyState) => j.status !== null && CARRIABLE_STATUSES.has(j.status);
  const ageOf = (j: CatalogJourneyState) =>
    j.lastWalkedAt ? ageInDays(j.lastWalkedAt, args.now) : Number.POSITIVE_INFINITY;
  // Evidence we could not date, or that predates the window, cannot be carried.
  const carriable = (j: CatalogJourneyState) =>
    isGreen(j) && Boolean(j.lastWalkedRunId) && j.lastWalkedAt !== null && ageOf(j) <= maxAgeDays;

  const bad = args.journeys.filter((j) => j.status !== null && !isGreen(j));
  const unwalked = args.journeys.filter((j) => j.status === null || j.lastWalkedAt === null);
  const rest = args.journeys.filter((j) => !bad.includes(j) && !unwalked.includes(j));

  bad.sort((a, b) => b.consecutiveBad - a.consecutiveBad || ageOf(b) - ageOf(a));
  rest.sort((a, b) => ageOf(b) - ageOf(a));

  // Expired greens are due for the same reason a bad one is: what we hold about
  // them is no longer good enough to stand on. Only when age counts at all.
  const expired = ageCounts ? rest.filter((j) => !carriable(j)) : [];
  const fresh = rest.filter((j) => !expired.includes(j));

  const queue = [...bad, ...unwalked, ...expired, ...fresh];
  const walk = queue.slice(0, budget);
  const left = queue.slice(budget);

  return {
    walk,
    carry: left.filter((j) => carriable(j)),
    deferred: left.filter((j) => !carriable(j)),
  };
}

/**
 * How many of a full run's walk slots are spent on the catalog's queue rather
 * than on what discovery proposed.
 *
 * The rotation was only ever consulted by partial mode, and partial fires on
 * 18% of watch runs (checkmyapp.dev 6 of 34, joblander 9 of 45, meetbashar 3 of
 * 24, month to 2026-09-15). On the other runs the model picks five, and it
 * picks the flows that read as most important — which is how joblander ends up
 * with 9 of 23 journeys walked once or never while its primary flows carry
 * double-digit walk counts.
 *
 * Two slots, not five: an app is checked daily to answer "is it still working
 * this morning", and that question is about the flows people actually use. The
 * headline journeys keep their daily walk; the rest of the catalog comes round
 * through these two.
 */
export const ROTATION_SLOTS = 2;

/**
 * A full run's walk list: what discovery proposed, with the last slots given to
 * the journeys the catalog says have waited longest.
 *
 * Pure, so scripts/verify-journey-rotation.ts can hold it to the real rules.
 * A journey discovery already proposed is never added twice — it is matched
 * against the catalog by the same identity rules the walk itself uses, so a
 * rewording does not buy a second slot.
 */
export function fullRunQueue(args: {
  /** What discovery proposed, already ordered by focus (CHE-134). */
  proposed: ProposedJourney[];
  /** The app's live journeys; empty for a run with no catalog behind it. */
  catalog: CatalogJourneyState[];
  now: Date;
  budget?: number;
  rotationSlots?: number;
}): ProposedJourney[] {
  const budget = args.budget ?? JOURNEY_WALK_BUDGET;
  const slots = args.rotationSlots ?? ROTATION_SLOTS;
  const proposed = args.proposed.slice(0, budget);
  if (args.catalog.length === 0 || slots <= 0) return proposed;

  // Which catalog journeys the proposal already covers. Same rules as the walk:
  // a reworded title resolves to its journey rather than looking new.
  const candidates = args.catalog.map((j) => ({
    key: j.key,
    title: j.title,
    aliases: j.aliases.length ? j.aliases : [j.title],
    surface: j.surface,
  }));
  const covered = new Set<string>();
  for (const p of proposed) {
    const hit = matchJourney(p.title, candidates, p.surface);
    if (hit) covered.add(hit.key);
  }

  // The catalog's own queue, minus everything this run is already walking.
  const waiting = planRotation({
    journeys: args.catalog.filter((j) => !covered.has(j.key)),
    now: args.now,
    budget: slots,
  }).walk;
  if (waiting.length === 0) return proposed;

  // Discovery keeps the slots the rotation does not need, and its own order:
  // focus areas first (CHE-134), then whatever it thought mattered most.
  const keep = Math.max(1, budget - waiting.length);
  return [
    ...proposed.slice(0, keep),
    ...waiting.map((j) => ({
      title: j.title,
      // A stored plan when a walk produced one; the title is a worse plan than
      // real steps and a much better one than none.
      steps: j.plan.length ? j.plan.slice(0, MAX_PROPOSED_STEPS) : [j.title],
      surface: j.surface,
    })),
  ].slice(0, budget);
}

// ─── Decision ────────────────────────────────────────────────────────────────

export async function planPartialRun(
  env: AgentEnv,
  run: { id: string; watchId: string | null; appId?: string | null },
  survey?: SurveyOutcome | null,
  now: Date = new Date(),
): Promise<PartialDecision> {
  if (!run.watchId) return { taken: false, reason: "one-off check — nothing to carry forward" };

  // Deliberately the last run that WALKED, not run.baselineRunId: the baseline
  // may itself be a green smoke pass with zero journeys, and the journeys we
  // want are one run further back. Age is checked below either way.
  const baseline = await findLastWalkedRun(env, run.watchId);
  if (!baseline?.completedAt) {
    return { taken: false, reason: "no earlier walked run to build on" };
  }
  const baselineAge = ageInDays(baseline.completedAt, now);
  const gate = fullRunGate(gateInputFrom(survey, baselineAge, FULL_RUN_MAX_AGE_DAYS));
  if (gate.force) {
    return {
      taken: false,
      reason:
        gate.cause === "stale"
          ? `the last real walk was ${Math.floor(baselineAge)} days ago — time for a full check`
          : gate.reason,
    };
  }

  // Credentials that appeared or changed since the last real walk invalidate
  // the carried picture: those journeys were walked without them (or as a
  // different account), so the authenticated part of the product was never
  // verified by anything we'd be carrying (CHE-69 / CHE-64: creds are often
  // added via the settings screen after the first runs). Watch runs keep their
  // credential columns after completion, so the baseline row is comparable.
  const [currentCreds, baselineCreds] = await Promise.all([
    env.db.run.findUnique({
      where: { id: run.id },
      select: { testEmail: true, testPasswordEnc: true, testAccounts: true },
    }),
    env.db.run.findUnique({
      where: { id: baseline.id },
      select: { testEmail: true, testPasswordEnc: true, testAccounts: true },
    }),
  ]);
  const hasCreds = Boolean(currentCreds?.testEmail && currentCreds?.testPasswordEnc);
  const baselineHadCreds = Boolean(baselineCreds?.testEmail && baselineCreds?.testPasswordEnc);
  if (hasCreds && (!baselineHadCreds || currentCreds?.testEmail !== baselineCreds?.testEmail)) {
    return {
      taken: false,
      reason: baselineHadCreds
        ? "the test account changed since the last full walk — re-checking everything"
        : "test credentials were added since the last full walk — re-checking everything",
    };
  }
  // CHE-322: the same holds per named account. A new "admin" login opens a
  // part of the product no carried journey was walked as. Compared on label +
  // email: the baseline's passwords are gone if it was a one-off run, and a
  // watch run's are the same encrypted blob only by coincidence of re-use.
  const walkedAs = new Set(parseRunAccounts(baselineCreds?.testAccounts).map((a) => `${a.label}\u0000${a.email}`));
  const newAccounts = usableRunAccounts(currentCreds?.testAccounts).filter((a) => !walkedAs.has(`${a.label}\u0000${a.email}`));
  if (newAccounts.length) {
    return {
      taken: false,
      reason: `test account ${newAccounts.map((a) => `"${a.label}"`).join(", ")} ${newAccounts.length === 1 ? "is" : "are"} new since the last full walk — re-checking everything`,
    };
  }

  // CHE-232: the catalog decides, when there is one. Each journey brings its own
  // last-walked date, so the plan is per journey instead of per baseline run —
  // and an app with more journeys than a run can afford gets a rotation rather
  // than a fixed five that never reaches the rest. The old baseline-row path
  // below still runs for anything with no catalog behind it.
  const catalog = run.appId ? await journeysForPlanning(env, run.appId) : [];
  if (catalog.length > 0) {
    return planFromCatalog(env, { catalog, baseline, survey, now });
  }

  const journeys = await env.db.journey.findMany({
    where: { runId: baseline.id },
    orderBy: { order: "asc" },
    select: {
      id: true,
      title: true,
      status: true,
      carriedFromRunId: true,
      steps: { orderBy: { order: "asc" }, select: { label: true } },
    },
  });
  const good = journeys.filter((j) => CARRIABLE_STATUSES.has(j.status));
  const bad = journeys.filter((j) => !CARRIABLE_STATUSES.has(j.status));
  if (bad.length === 0) {
    // Nothing to re-walk: a partial run with an empty rewalk list produces no
    // fresh evidence at all, which is a smoke pass that also pays for
    // synthesis. So this rung steps aside either way — but what it steps aside
    // TO is the point of CHE-213. Until now the only next rung was a full walk,
    // and "nothing was wrong last time" was therefore a reason to spend the
    // most on the quietest app (run #157, joblander.app: $0.24 for a walk that
    // found nothing). It no longer is: on an app the survey saw unchanged the
    // smoke rung above cannot refuse for want of specs or targets, so this line
    // is reached only when the survey had no answer to give.
    return {
      taken: false,
      reason: surveySaysUnchanged(survey)
        ? "nothing changed and nothing had trouble last time — no journey needs re-walking"
        : "nothing was wrong last time — re-checking everything",
    };
  }
  if (good.length === 0) {
    return { taken: false, reason: "every journey had trouble last time — walking them all" };
  }

  // Provenance + expiry. A journey the baseline itself carried was walked
  // further back; that older date is the one that has to be inside the drift
  // bound, and it's the one the bottom line quotes.
  const sourceIds = [...new Set(good.map((j) => j.carriedFromRunId ?? baseline.id))];
  const sources = await env.db.run.findMany({
    where: { id: { in: sourceIds } },
    select: { id: true, runNumber: true, completedAt: true },
  });
  const byId = new Map(sources.map((s) => [s.id, s]));

  // One pass over the baseline's journeys in their own order, so each half gets
  // its slot from the same counter. Orders must be distinct across both halves:
  // walkOneJourney claims (runId, order) by deleting it first, and a collision
  // would delete a journey we just carried.
  const carry: CarriedJourney[] = [];
  const rewalk: RewalkJourney[] = [];
  let oldest: Date | null = null;
  for (let order = 0; order < journeys.length; order++) {
    const j = journeys[order];
    if (!CARRIABLE_STATUSES.has(j.status)) {
      rewalk.push({
        order,
        title: j.title,
        // An empty plan would leave the walker with nothing but the mission
        // text; the title is a worse plan than real steps but a much better one
        // than none.
        steps: j.steps.length ? j.steps.map((s) => s.label).slice(0, MAX_PROPOSED_STEPS) : [j.title],
        previousStatus: j.status,
      });
      continue;
    }
    const source = byId.get(j.carriedFromRunId ?? baseline.id);
    if (!source?.completedAt) {
      // Undateable evidence is unusable evidence: we cannot tell the owner what
      // "carried" means here, so we don't carry at all.
      return { taken: false, reason: `couldn't date the evidence behind "${j.title}"` };
    }
    const age = ageInDays(source.completedAt, now);
    // Same gate as above: only a journey whose evidence cannot be compared
    // against anything expires on age.
    if (fullRunGate(gateInputFrom(survey, age, FULL_RUN_MAX_AGE_DAYS)).force) {
      return {
        taken: false,
        reason:
          `"${j.title}" was last actually walked ${Math.floor(age)} days ago — ` +
          "carrying it again would be stale, so this is a full check",
      };
    }
    if (!oldest || source.completedAt < oldest) oldest = source.completedAt;
    carry.push({
      sourceJourneyId: j.id,
      order,
      title: j.title,
      sourceRunId: source.id,
      sourceRunNumber: source.runNumber,
    });
  }

  return {
    taken: true,
    baselineRunId: baseline.id,
    baselineRunNumber: baseline.runNumber,
    anatomy: baseline.anatomy,
    carry,
    rewalk,
    oldestVerifiedAt: (oldest ?? baseline.completedAt).toISOString(),
  };
}

function ageInDays(then: Date, now: Date): number {
  return (now.getTime() - then.getTime()) / 86_400_000;
}

/**
 * CHE-232 — the plan, built from the catalog's rotation.
 *
 * The shape it returns is the one the workflow already knows: journeys to walk
 * with a plan each, journeys to copy forward with their own provenance. What
 * changed is where both halves come from. A carried journey's evidence is
 * fetched from the run that really walked THAT journey, not from one baseline
 * run everything is copied off, so "verified on" is true per journey.
 */
async function planFromCatalog(
  env: AgentEnv,
  args: {
    catalog: CatalogJourneyState[];
    baseline: { id: string; runNumber: number; anatomy: string | null; completedAt: Date | null };
    survey?: SurveyOutcome | null;
    now: Date;
  },
): Promise<PartialDecision> {
  const rotation = planRotation({
    journeys: args.catalog,
    now: args.now,
    // CHE-132 again: on an app the survey saw unchanged, age alone never turns a
    // green journey into a due one.
    ageCounts: !surveySaysUnchanged(args.survey),
  });

  if (rotation.walk.length === 0) {
    return {
      taken: false,
      reason: surveySaysUnchanged(args.survey)
        ? "nothing changed and every journey was healthy recently — no journey needs re-walking"
        : "nothing was wrong last time — re-checking everything",
    };
  }
  if (rotation.carry.length === 0) {
    // Nothing to stand on: this is a full walk wearing a partial's clothes, and
    // the full rung does it properly (discovery included, so a journey the app
    // has grown since is not missed).
    return { taken: false, reason: "no journey is recent enough to carry — walking them all" };
  }

  // Where each carried journey's evidence actually lives: the run that walked
  // THAT journey. One query for all of them, then matched up per journey.
  const walkedRunIds = [...new Set(rotation.carry.map((j) => j.lastWalkedRunId as string))];
  const [sourceJourneys, sourceRuns] = await Promise.all([
    env.db.journey.findMany({
      where: { runId: { in: walkedRunIds }, appJourneyId: { in: rotation.carry.map((j) => j.appJourneyId) } },
      select: { id: true, runId: true, appJourneyId: true },
    }),
    env.db.run.findMany({
      where: { id: { in: walkedRunIds } },
      select: { id: true, runNumber: true, completedAt: true },
    }),
  ]);
  const rowFor = new Map(sourceJourneys.map((j) => [`${j.runId}:${j.appJourneyId}`, j]));
  const runFor = new Map(sourceRuns.map((r) => [r.id, r]));

  const rewalk: RewalkJourney[] = rotation.walk.map((j, i) => ({
    order: i,
    title: j.title,
    // A title is a worse plan than real steps and a much better one than none.
    steps: j.plan.length ? j.plan.slice(0, MAX_PROPOSED_STEPS) : [j.title],
    previousStatus: j.status ?? "never walked",
  }));

  const carry: CarriedJourney[] = [];
  let oldest: Date | null = null;
  for (const j of rotation.carry) {
    const row = rowFor.get(`${j.lastWalkedRunId}:${j.appJourneyId}`);
    const source = runFor.get(j.lastWalkedRunId as string);
    if (!row || !source?.completedAt) {
      // The catalog says this journey was walked, and the walk is not there to
      // copy. Undateable evidence is unusable evidence (the same rule the old
      // path applies), so the whole run falls through to a full walk rather
      // than carrying a journey we cannot show.
      return { taken: false, reason: `couldn't find the walk behind "${j.title}"` };
    }
    if (!oldest || source.completedAt < oldest) oldest = source.completedAt;
    carry.push({
      sourceJourneyId: row.id,
      order: rewalk.length + carry.length,
      title: j.title,
      sourceRunId: source.id,
      sourceRunNumber: source.runNumber,
    });
  }

  if (rotation.deferred.length > 0) {
    // Not a silence and not a carry: journeys the budget could not reach whose
    // evidence is already too old to stand on. Said out loud here; the run feed
    // and our own board get it from the plan (rule 2).
    console.log(
      `[partial] ${rotation.deferred.length} journey(s) deferred — catalog is larger than ` +
        `${JOURNEY_WALK_BUDGET}/run can keep inside ${FULL_RUN_MAX_AGE_DAYS} days: ` +
        rotation.deferred.map((j) => j.title).join(" · "),
    );
  }

  return {
    taken: true,
    baselineRunId: args.baseline.id,
    baselineRunNumber: args.baseline.runNumber,
    anatomy: args.baseline.anatomy,
    carry,
    rewalk,
    deferred: rotation.deferred.map((j) => j.title),
    oldestVerifiedAt: (oldest ?? args.baseline.completedAt ?? args.now).toISOString(),
  };
}

// ─── Every known journey on the verdict ──────────────────────────────────────

/**
 * The app's live journeys this run has no row for, in the order the verdict
 * lists them: the ones that ended badly first, then the most recently walked.
 *
 * Until CHE-331 only a partial run copied anything forward, and a partial run
 * happens only on a watch run of an app the survey saw unchanged. Every other
 * run — a full check after a deploy, any on-demand or MCP check — listed only
 * the five it walked. checkmyapp.dev's verdict went from ten journeys (#247,
 * partial) to five (#257, #260) and three (#261) with twelve live in its
 * catalog: nothing had been retired, the page had simply stopped saying they
 * existed.
 *
 * Pure, so scripts/verify-known-journeys-listed.ts holds it to the rules
 * without a database. A journey nothing has walked has no evidence to show and
 * is left out; a retired one is not in the catalog to begin with
 * (journeysForPlanning reads retiredAt: null), so this never resurrects one.
 */
export function knownJourneysToList(args: {
  catalog: CatalogJourneyState[];
  /** appJourneyIds this run already has a row for — walked or carried. */
  present: Iterable<string>;
}): CatalogJourneyState[] {
  const present = new Set(args.present);
  const bad = (j: CatalogJourneyState) => (j.status !== null && !CARRIABLE_STATUSES.has(j.status) ? 0 : 1);
  return args.catalog
    .filter((j) => !present.has(j.appJourneyId) && Boolean(j.lastWalkedRunId) && j.lastWalkedAt !== null)
    .sort(
      (a, b) =>
        bad(a) - bad(b) || (b.lastWalkedAt as Date).getTime() - (a.lastWalkedAt as Date).getTime(),
    );
}

/**
 * The copies that put every known journey on this run's verdict, each from the
 * run that last really walked it and dated by that walk. Orders continue after
 * the highest one the run already holds, so a copy can never take the slot of a
 * journey this run walked (walkOneJourney and carryJourney both clear their slot
 * first).
 *
 * What a copy is, and is not: the journey's last real walk, shown under its own
 * run number and date. It is not a check of it today, and nothing it carries
 * enters this run's adjudication — the workflow writes these after the verdict,
 * the findings and the pill are decided from what this run walked (rule 8: a
 * claim about the product rests on this run's evidence).
 *
 * `omitted` names the known journeys that could not be shown because their
 * walk is gone. The run still did not cover them, and the caller must not let
 * their absence read as "nothing left to list" — fix verification treats a run
 * with no carried rows as a walk of the whole app.
 */
export async function planKnownJourneys(
  env: AgentEnv,
  args: { runId: string; appId: string; startOrder: number },
): Promise<{ listed: CarriedJourney[]; omitted: string[] }> {
  const [catalog, rows] = await Promise.all([
    journeysForPlanning(env, args.appId),
    env.db.journey.findMany({ where: { runId: args.runId }, select: { appJourneyId: true, order: true } }),
  ]);
  const due = knownJourneysToList({
    catalog,
    present: rows.map((r) => r.appJourneyId).filter((id): id is string => Boolean(id)),
  });
  if (due.length === 0) return { listed: [], omitted: [] };

  const walkedRunIds = [...new Set(due.map((j) => j.lastWalkedRunId as string))];
  const [sourceJourneys, sourceRuns] = await Promise.all([
    env.db.journey.findMany({
      // The walk itself, never a copy of it: a copy's steps are the same, but
      // its run is not the one that saw them.
      where: {
        runId: { in: walkedRunIds },
        appJourneyId: { in: due.map((j) => j.appJourneyId) },
        carriedFromRunId: null,
        status: { not: "skipped" },
      },
      orderBy: { order: "asc" },
      select: { id: true, runId: true, appJourneyId: true },
    }),
    env.db.run.findMany({ where: { id: { in: walkedRunIds } }, select: { id: true, runNumber: true } }),
  ]);
  const rowFor = new Map<string, string>();
  for (const j of sourceJourneys) {
    const key = `${j.runId}:${j.appJourneyId}`;
    if (!rowFor.has(key)) rowFor.set(key, j.id);
  }
  const runNumberOf = new Map(sourceRuns.map((r) => [r.id, r.runNumber]));

  let order = Math.max(args.startOrder, ...rows.map((r) => r.order + 1));
  const listed: CarriedJourney[] = [];
  const omitted: string[] = [];
  for (const j of due) {
    const sourceJourneyId = rowFor.get(`${j.lastWalkedRunId}:${j.appJourneyId}`);
    const sourceRunNumber = runNumberOf.get(j.lastWalkedRunId as string);
    if (!sourceJourneyId || sourceRunNumber === undefined) {
      // The catalog names a walk that is not there to show (a pruned run, an
      // ephemeral sweep). Undateable evidence is unusable evidence — this one
      // journey is left off rather than shown without its proof, and said.
      console.warn(`[known-journeys] no walk to show for "${j.title}" (run ${j.lastWalkedRunId})`);
      omitted.push(j.title);
      continue;
    }
    listed.push({
      sourceJourneyId,
      order: order++,
      title: j.title,
      sourceRunId: j.lastWalkedRunId as string,
      sourceRunNumber,
      walkedAt: (j.lastWalkedAt as Date).toISOString(),
    });
  }
  return { listed, omitted };
}

// ─── Carrying journeys forward ───────────────────────────────────────────────

// Copy one baseline journey (steps + evidence) onto this run. Evidence rows are
// duplicated pointing at the SAME storageUrl/sha256 — no screenshot is
// re-uploaded and no R2 object is rewritten, so the carried strip renders from
// the very bytes the original walk captured. capturedAt is copied too: the
// evidence was captured then, and stamping it now would be a small lie in the
// one place the product sells honesty.
//
// Idempotent like walkOneJourney: the (runId, order) slot is cleared first, so a
// Workflow step retry replaces the copy instead of duplicating it.
export async function carryJourney(
  env: AgentEnv,
  runId: string,
  entry: CarriedJourney,
  runNumber?: number,
): Promise<void> {
  const source = await env.db.journey.findUnique({
    where: { id: entry.sourceJourneyId },
    select: {
      title: true,
      status: true,
      summary: true,
      videoUrl: true,
      // CHE-231: identity travels with the copy. Without it a carried journey
      // would look like a journey the app has never had before, which is the
      // opposite of what carrying means.
      appJourneyId: true,
      journeyKey: true,
      steps: {
        orderBy: { order: "asc" },
        select: {
          order: true,
          label: true,
          status: true,
          screenshotUrl: true,
          attempted: true,
          observed: true,
          unverifiedReason: true,
          gapClass: true,
          consoleLog: true,
          networkLog: true,
          evidence: {
            select: { type: true, storageUrl: true, sha256: true, capturedAt: true },
          },
        },
      },
    },
  });
  if (!source) return;

  // CHE-334: a carried summary is read on today's verdict, so it meets the same
  // cut a fresh walk's summary does. Summaries written before the cut existed
  // still open with "CheckMyApp is a …" or retell our history; carrying them
  // verbatim put that back on the page the cut was built for (run
  // cmuln3zoo00031g1o0bd577bx, journey 5).
  const run = await env.db.run.findUnique({ where: { id: runId }, select: { targetUrl: true } });
  const walkOnly = run ? walkSummaryOnly(source.summary, run.targetUrl) : { text: source.summary, cut: [] };
  // And, as on a fresh walk, where the carried steps show our own guard
  // refused us, the sentences retelling that refusal as a product fact go too
  // (Codex review of #206).
  const metOwnGuard = source.steps.some(isSelfCheckRefusalStep);
  const guarded = metOwnGuard ? cutSelfCheckRefusalClaims(walkOnly.text, source.steps) : { text: walkOnly.text, cut: [] };
  const ownWords = [...walkOnly.cut, ...guarded.cut];
  const summary = ownWords.length ? (guarded.text ?? summaryFallback(source.status)) : source.summary;

  await env.db.journey.deleteMany({ where: { runId, order: entry.order } });
  const journey = await env.db.journey.create({
    data: {
      runId,
      order: entry.order,
      title: source.title,
      status: source.status,
      summary,
      videoUrl: source.videoUrl,
      carriedFromRunId: entry.sourceRunId,
      appJourneyId: source.appJourneyId,
      journeyKey: source.journeyKey,
    },
  });
  // CHE-231: the catalog records that this run had the journey, and nothing
  // more — lastWalkedAt, the walk count and the failure streak stay where the
  // real walk left them. A carry that moved them would launder old evidence
  // into "checked today", which is the one thing carrying must never do.
  if (typeof runNumber === "number") {
    await recordCarry(env, { appJourneyId: source.appJourneyId, runId, runNumber }).catch((err) =>
      console.warn(`[journey] carry not recorded: ${err instanceof Error ? err.message : err}`),
    );
  }

  // One step at a time with its evidence nested — the exact write shape
  // execution.ts already runs in production against D1.
  for (const step of source.steps) {
    await env.db.step.create({
      data: {
        journeyId: journey.id,
        order: step.order,
        label: step.label,
        status: step.status,
        screenshotUrl: step.screenshotUrl,
        attempted: step.attempted,
        observed: step.observed,
        // Why a carried step went unverified travels with it: without the
        // reason, a not_applicable skip reads as an unexplained one.
        unverifiedReason: step.unverifiedReason,
        gapClass: step.gapClass,
        consoleLog: step.consoleLog,
        networkLog: step.networkLog,
        evidence: step.evidence.length ? { create: step.evidence } : undefined,
      },
    });
  }
}

// ─── Owner-facing coverage line ──────────────────────────────────────────────

// The verdict page's bottom line has to state coverage before it states an
// opinion: a partial run's clean pill covers journeys nobody walked today.
// `rewalked` is counted from the DB after the walk, not taken from the plan: a
// journey whose walk aborted leaves a skipped row behind, and "re-checked 2 of
// 5" would then be a claim about work that didn't happen.
//
// CHE-331: `listed` is the rest of the app's known journeys, shown as of their
// last walk (planKnownJourneys). They are carried like the plan's own, so the
// sentence counts them in the same breath and the date it quotes is the oldest
// walk among all of them.
export function partialBottomLine(
  plan: PartialPlan,
  synthesized: string | null,
  rewalked: number,
  listed: CarriedJourney[] = [],
): string {
  const oldest = [plan.oldestVerifiedAt, ...listed.map((c) => c.walkedAt ?? plan.oldestVerifiedAt)].sort()[0];
  const prefix = coveragePrefix(plan.rewalk.length, rewalked, [...plan.carry, ...listed], oldest);
  return synthesized ? `${prefix} ${synthesized.trim()}` : prefix;
}

/**
 * CHE-331 — the same coverage-before-opinion line for a full run that lists
 * journeys it did not walk. A full run that walked every known journey says
 * nothing extra: its verdict already covers the whole app.
 */
export function fullBottomLine(
  planned: number,
  synthesized: string | null,
  walked: number,
  listed: CarriedJourney[],
): string | null {
  const dates = listed.map((c) => c.walkedAt).filter((d): d is string => Boolean(d)).sort();
  if (listed.length === 0 || dates.length === 0) return synthesized;
  const prefix = coveragePrefix(planned, walked, listed, dates[0]);
  return synthesized ? `${prefix} ${synthesized.trim()}` : prefix;
}

function coveragePrefix(planned: number, rewalked: number, carried: CarriedJourney[], oldestIso: string): string {
  const k = planned;
  const m = carried.length;
  const missed = Math.max(0, k - rewalked);
  // Name the run only when every carried journey came from the same one —
  // otherwise "from Run #43 (last walked Aug 19)" would credit #43 with a walk
  // that happened three runs earlier.
  const sources = new Set(carried.map((c) => c.sourceRunNumber));
  const from =
    sources.size === 1
      ? `carried forward from Run #${[...sources][0]}`
      : `carried forward from ${sources.size} earlier runs`;
  return (
    `Re-checked ${rewalked} of ${k + m} journey${k + m === 1 ? "" : "s"}` +
    (missed ? ` (${missed} couldn't be re-walked this run)` : "") +
    `; ${m} ${from} (last walked ${formatDay(oldestIso)}).`
  );
}

/** "Aug 12" — no Intl dependency, identical on workerd and Node. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "an earlier run";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
