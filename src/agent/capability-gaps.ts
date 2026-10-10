// Self-filing capability gaps (CHE-83).
//
// Owner rule, 2026-08-27: **"we couldn't verify X" is never an acceptable end
// state.** If CheckMyApp could not check something, that is a defect in
// CheckMyApp — not a caveat for the customer to live with, and never homework
// handed back to them. Every such gap opens a high-priority ticket on OUR OWN
// board, deduped and counted, until the capability exists.
//
// This is the same machinery the product sells (autofile → dedup → comment and
// count → escalate), pointed at ourselves: the checker is a customer of its own
// loop. Runs after the verdict is written and, like autofile, never fails a run.

import { LinearTracker } from "@/lib/tracker/linear";
import { fileFindingTicket, type TicketFinding, type TicketRun } from "@/lib/tracker/file";
import type { Tracker } from "@/lib/tracker/types";
import { freshLinearToken } from "@/lib/tracker/token";
import { parseJson } from "@/lib/json";
import { findOrphans } from "./cleanup";
import type { AgentEnv } from "./env";
import type { RouteRefusal } from "./llm";
import { GAP_CLASSES, classifyGap, gapEvidenceText, isGapClass, isJudgementNotAction, MACHINE_DECIDED_CLASSES, type GapClass } from "./gap-classes";
import type { RecordedAction } from "./tools";

export interface CapabilityNote {
  icon: "ok" | "warn";
  text: string;
}

// One ticket per CAPABILITY, not per customer app: the same missing ability
// hit on ten apps is one thing to build. The classes and their labels live in
// gap-classes.ts (CHE-198); the labels are the dedup identity, so they must
// stay stable — the customer's own words never enter them.
//
// A step written since CHE-198 carries its class (Step.gapClass), decided at
// report time on the model's own words. Older rows, and a row that somehow
// has none, are classified here from what survived — the customer's copy and
// the machine trail — with "unclassified" as the last resort. It still files.
function classOf(g: {
  label: string;
  attempted: string | null;
  observed: string | null;
  gapClass: string | null;
  actions: string | null;
  targetOrigin?: string;
}): GapClass {
  if (isGapClass(g.gapClass)) return g.gapClass;
  return classifyGap({
    text: gapEvidenceText(g.observed, g.attempted, g.label),
    actions: parseJson<RecordedAction[]>(g.actions),
    targetOrigin: g.targetOrigin,
  });
}

// The Linear team our own defects are filed onto — the "Check My App" team,
// key CHE. The identity of our board, not a preference: see ourApp.
export const OUR_BOARD_TEAM_ID = "b9503451-107e-41b6-a933-5959324a72af";

// Our own app row (the one watching checkmyapp.dev) owns the tracker connection
// the gaps are filed through, and namespaces their dedup keys.
//
// CHE-329: found by the board it files to, not by hostname alone. Any account
// may save checkmyapp.dev as an app — the self-check account did on
// 2026-09-28, and as the newest row it made this return an app with no tracker,
// so any gap filed while that row lived found no board — and a customer who did the same and
// connected their own tracker would have received our raw failure messages
// from every app. Only the row whose tracker points at our own Linear team is
// ours; nobody outside our workspace can connect to that team.
export async function ourApp(env: AgentEnv) {
  const host = (() => {
    try {
      return new URL(env.bindings.APP_URL ?? "https://checkmyapp.dev").host;
    } catch {
      return "checkmyapp.dev";
    }
  })();
  return env.db.app.findFirst({
    where: { appSlug: host, tracker: { is: { teamId: OUR_BOARD_TEAM_ID } } },
    include: { tracker: true, policy: true },
    orderBy: { createdAt: "desc" },
  });
}

type OurApp = NonNullable<Awaited<ReturnType<typeof ourApp>>>;

// The board we file our own defects onto: our app row, the tracker to file
// through, and the web origin verdict links are built on. Exported as a type
// so the acceptance script (verify-gap-filing.ts) can hand the real filing
// path a stub tracker instead of a Linear token.
export interface GapBoard {
  self: OurApp;
  tracker: Tracker;
  baseUrl: string;
}

// Null when the CheckMyApp app has no tracker connected yet — callers say so
// out loud rather than swallowing it. Exported for run-failures.ts (CHE-329),
// which files onto the same board.
export async function ourBoard(env: AgentEnv): Promise<GapBoard | null> {
  const self = await ourApp(env);
  if (!self?.tracker?.teamId) return null;
  const tracker = new LinearTracker(
    await freshLinearToken(env.db, self.tracker, {
      clientId: env.bindings.LINEAR_CLIENT_ID,
      clientSecret: env.bindings.LINEAR_CLIENT_SECRET,
    }),
    self.tracker.teamId,
  );
  return { self, tracker, baseUrl: env.bindings.APP_URL ?? "https://checkmyapp.dev" };
}

/**
 * Journeys this run actually walked whose catalog row still carries no price.
 *
 * Only journeys with a catalog row count: a run with no App has nowhere to
 * store a price, which is CHE-234's problem and not a pricing gap. Carried
 * journeys (partial runs) are excluded for the same reason they are carried —
 * this run did not walk them, so it owed them no judgement.
 */
/**
 * CHE-238: journeys this run walked that we could not reduce to a funnel.
 *
 * Read from the catalog for the same reason pricing is: the refusal is recorded
 * where the journey lives, so a journey that has never once produced a funnel is
 * visible even across runs that each thought they had merely had an off day.
 *
 * `funnelStages IS NULL` and a refusal recorded together means we have never
 * derived one — a journey that HAS a stored funnel and merely wandered today is
 * not a gap, because the funnel it is measured along still stands.
 */
async function unfunnelledJourneys(env: AgentEnv, runId: string): Promise<string[]> {
  const rows = await env.db.journey.findMany({
    where: {
      runId,
      carriedFromRunId: null,
      appJourneyId: { not: null },
      appJourney: { funnelStages: null, funnelRefusal: { not: null } },
    },
    select: { title: true, appJourney: { select: { funnelRefusal: true } } },
    take: 20,
  });
  return rows.map((r) => `${r.title} (${r.appJourney?.funnelRefusal ?? "no reason recorded"})`);
}

async function unpricedJourneys(env: AgentEnv, runId: string): Promise<string[]> {
  const rows = await env.db.journey.findMany({
    where: { runId, carriedFromRunId: null, appJourneyId: { not: null }, appJourney: { price: null } },
    select: { title: true },
    take: 20,
  });
  return rows.map((r) => r.title);
}

// The ticket policy for anything we file against ourselves — the owner's own
// policy when the CheckMyApp app has one, otherwise the same defaults autofile
// falls back to, with the title prefix swapped.
export function selfPolicy(self: OurApp, titleFormat: string) {
  return self.policy
    ? { ...self.policy, titleFormat }
    : {
        priorityRule: "{}",
        pickupLabels: "[]",
        repoLabel: null,
        provenanceLabel: "checkmyapp",
        state: "Backlog",
        titleFormat,
        escalateAfterRuns: 3,
      };
}

// `opts.board` is for the acceptance script only: the real board is looked
// up from our own app row and its Linear connection.
export async function fileCapabilityGaps(
  env: AgentEnv,
  runId: string,
  opts: { board?: GapBoard; extraGaps?: Array<{ label: string; attempted: string; observed: string; gapClass: GapClass }> } = {},
): Promise<CapabilityNote[]> {
  const run = await env.db.run.findUnique({
    where: { id: runId },
    select: { id: true, runNumber: true, publicId: true, startedAt: true, appSlug: true, targetUrl: true, targetKind: true },
  });
  if (!run) return [];

  const gaps = await env.db.step.findMany({
    // Carried journeys keep their steps' reasons for the page (CHE-334), but
    // this run did not walk them: their gaps were filed by the run that did.
    where: { unverifiedReason: "our_capability", journey: { runId, carriedFromRunId: null } },
    select: {
      label: true,
      attempted: true,
      observed: true,
      gapClass: true,
      actions: true,
      journey: { select: { title: true } },
    },
  });

  // CHE-90: leaving a test record behind is our defect too, not just an
  // inability — it files through the same loop so it gets fixed, not tolerated.
  const orphans = await findOrphans(env, runId);
  const orphanGaps =
    orphans.fromThisRun + orphans.older > 0
      ? [
          {
            label: "Checker leaves its test records behind",
            attempted: "Create → read → update → delete lifecycle with guaranteed cleanup",
            observed: `Records still present: ${orphans.lines.slice(0, 5).join(" · ")}`,
            gapClass: "test_records",
            actions: null,
            journey: { title: "Cleanup audit" },
          },
        ]
      : [];

  // CHE-235: a journey this run walked that still has no price. Read from the
  // catalog rather than tracked through the walk, because the two ways to end
  // up here are one failure: a model that skipped the numbers and a model that
  // answered with numbers no journey can have (run #192 priced four journeys at
  // 0 actions / 0% and explained that the figure was "not tracked"). Either
  // way the owner is owed a judgement and did not get it.
  const unpriced = await unpricedJourneys(env, runId);
  const unpricedGaps =
    unpriced.length > 0
      ? [
          {
            label: GAP_CLASSES.unpriced_journey.label,
            attempted: "Price each journey we walked: actions the user performs, and how many of 100 finish",
            observed: `Walked and left unpriced: ${unpriced.slice(0, 5).join(" · ")}`,
            gapClass: "unpriced_journey",
            actions: null,
            journey: { title: "Journey pricing" },
          },
        ]
      : [];

  // CHE-238: a journey we walked and could not turn into a funnel. Our gap,
  // filed on our board — never a caveat pushed at the customer (rule 2).
  const unfunnelled = await unfunnelledJourneys(env, runId);
  const unfunnelledGaps =
    unfunnelled.length > 0
      ? [
          {
            label: GAP_CLASSES.unfunnelled_journey.label,
            attempted: "Derive each walked journey's funnel from the path the walk took through it",
            observed: `Walked and left without a funnel: ${unfunnelled.slice(0, 5).join(" · ")}`,
            gapClass: "unfunnelled_journey",
            actions: null,
            journey: { title: "Journey funnels" },
          },
        ]
      : [];

  // CHE-440: rows written before settleStepGap refused a judgement, or by a
  // walker whose words only the stored copy keeps. The stored class is not
  // consulted when it came from the text rules: the Custlo step carried
  // verification_code and was still not one. A class the tools decided from a
  // machine failure stands whatever the wording says.
  const actionGaps = gaps.filter(
    (g) =>
      (isGapClass(g.gapClass) && MACHINE_DECIDED_CLASSES.includes(g.gapClass)) ||
      !isJudgementNotAction(gapEvidenceText(g.label, g.attempted, g.observed)),
  );

  const allGaps = [...actionGaps, ...orphanGaps, ...unpricedGaps, ...unfunnelledGaps, ...(opts.extraGaps ?? []).map(gap => ({ ...gap, actions: null, journey: { title: "Extension verification" } }))];
  if (allGaps.length === 0) return [];

  const board = opts.board ?? (await ourBoard(env));
  if (!board) {
    // Nothing to file into yet — still say it out loud in the run feed so the
    // gap is never silent.
    return [
      {
        icon: "warn",
        text: `${actionGaps.length} step(s) went unverified because of our checker — connect the CheckMyApp app's own tracker to auto-file these.`,
      },
    ];
  }
  const { self, tracker, baseUrl } = board;
  const privateAuditKey = `private/runs/${runId}/checker-gaps.json`;
  let privateAudit = run.targetKind === "extension" && Boolean(await env.bindings.EVIDENCE.head(privateAuditKey));
  if (run.targetKind === "extension" && !privateAudit) {
    await env.bindings.EVIDENCE.put(privateAuditKey, JSON.stringify(allGaps), { httpMetadata: { contentType: "application/json" } });
    privateAudit = true;
  }

  // Collapse this run's gaps onto capabilities before filing.
  const byCapability = new Map<GapClass, string[]>();
  for (const g of allGaps) {
    const cls = classOf({ ...g, targetOrigin: run.targetUrl });
    const examples = byCapability.get(cls) ?? [];
    examples.push(privateAudit ? `${run.appSlug} · ${GAP_CLASSES[cls].label}: observed during this run; original step evidence is retained privately.`
      : `${run.appSlug} · ${g.journey.title} → ${g.label}: ${g.observed ?? ""}`.slice(0, 300));
    byCapability.set(cls, examples);
  }

  const notes: CapabilityNote[] = [];
  for (const [cls, examples] of byCapability) {
    const { label, why } = GAP_CLASSES[cls];
    const observationExamples = privateAudit ? [...examples, `Original step labels, observations and actions are retained in private R2 evidence: ${privateAuditKey}.`] : examples;
    const finding: TicketFinding = {
      runId: run.id,
      number: 0,
      title: label,
      category: "broken",
      severity: "high",
      detail: JSON.stringify({
        where: "CheckMyApp agent capability",
        whatWeTried: observationExamples,
        whatHappened:
          `A customer run could not verify a step because of our own checker, not because of ` +
          `anything wrong with their product. Seen on ${run.appSlug} (run #${run.runNumber}).`,
        whyItMatters: `${why} Until this exists, we ship "we could not verify X" — which is exactly what customers pay us to avoid.`,
      }),
      evidence: [],
    };
    const ticketRun: TicketRun = {
      runNumber: run.runNumber,
      publicId: run.publicId,
      startedAt: run.startedAt,
      // Dedup identity lives on OUR app, so one capability = one ticket across
      // every customer app that trips it.
      appSlug: self.appSlug,
    };

    try {
      const outcome = await fileFindingTicket({
        db: env.db,
        tracker,
        appId: self.id,
        finding,
        run: ticketRun,
        policy: selfPolicy(self, "[Checker gap] {verdict}"),
        ownerId: self.ownerId,
        verdictUrl: `${baseUrl}/verdict/${run.publicId}`,
      });
      // The unclassified bucket is the exception that gets investigated, not
      // the rule that absorbs everything: the recurrence comment alone said
      // "still present in run #N" and CHE-86's body still lists only run
      // #96's steps. The steps themselves go on the ticket every time, so the
      // next class can be written from them.
      if ((cls === "unclassified" || privateAudit) && outcome.kind === "commented") {
        await tracker.addComment(
          outcome.identifier,
          `${cls === "unclassified" ? "Unclassified" : "Evidence"} in run #${run.runNumber} — the step(s):\n` +
            observationExamples.map((e) => `- ${e}`).join("\n"),
        );
      }
      notes.push({
        icon: "ok",
        text:
          outcome.kind === "created"
            ? `Opened ${outcome.identifier} on our own board: ${label}`
            : outcome.kind === "commented"
              ? `Our checker gap "${label}" recurred — ${outcome.identifier} now at ${outcome.occurrences} occurrence(s)`
              : `Our checker gap "${label}" is filed as ${outcome.identifier}`,
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      console.warn(`[capability] filing failed: ${text}`);
      notes.push({ icon: "warn", text: `Couldn't file our checker gap "${label}": ${text}` });
    }
  }
  return notes;
}

// ─── A verdict that never reached the owner (CHE-224) ───────────────────────
//
// The product's promise is one sentence: you find out the next morning that
// your app broke overnight. A send the provider refuses breaks that promise
// completely, and it used to break it silently — `notifyVerdictReady` swallowed
// the error into a console.warn, which is the one place that expires.
//
// It is a capability gap in our own sense of the word: we could not tell whether
// the customer got their verdict. So it files like every other one — one ticket
// for the capability, counted across every app and every address that trips it,
// with the provider's own words on it so the next occurrence names the cause
// instead of restarting this investigation.

const DELIVERY_GAP = {
  label: "Verdict email does not reach the owner",
  why:
    "The morning email IS the product — everything else this codebase does serves it. " +
    "A run that finds the app broken and cannot say so has produced nothing the owner " +
    "can act on, and until 2026-09-08 it produced no trace either.",
};

// Never throws: a failure to file must not cost a run that is otherwise done.
export async function fileDeliveryGap(
  env: AgentEnv,
  runId: string,
  opts: { address: string; error: string },
): Promise<CapabilityNote> {
  const run = await env.db.run.findUnique({
    where: { id: runId },
    select: { runNumber: true, publicId: true, startedAt: true, appSlug: true },
  });
  if (!run) return { icon: "warn", text: `Couldn't file the delivery gap: run ${runId} is gone.` };

  const board = await ourBoard(env);
  if (!board) {
    return {
      icon: "warn",
      text:
        `The verdict email to ${opts.address} was not delivered — connect the CheckMyApp ` +
        `app's own tracker so delivery failures get filed.`,
    };
  }
  const { self, tracker, baseUrl } = board;

  const finding: TicketFinding = {
    runId,
    number: 0,
    title: DELIVERY_GAP.label,
    category: "broken",
    severity: "high",
    detail: JSON.stringify({
      // Fixed, so every refused send hashes to the same ticket: the address and
      // the run number are occurrence facts and stay out of the dedup signature.
      where: "CheckMyApp verdict notification",
      whatWeTried: [
        `We asked the mail provider to deliver a finished verdict to ${opts.address}.`,
        `It answered: ${opts.error}`,
        `On: ${run.appSlug} (run #${run.runNumber}).`,
      ],
      whatHappened:
        "A run finished, wrote its verdict, and the owner was never told. Nothing about " +
        "the run says it is undelivered except this ticket.",
      whyItMatters: `${DELIVERY_GAP.why} This ticket counts every refused send; it closes when the sends land, not when the run is forgotten.`,
    }),
    evidence: [],
  };

  try {
    const outcome = await fileFindingTicket({
      db: env.db,
      tracker,
      appId: self.id,
      finding,
      run: {
        runNumber: run.runNumber,
        publicId: run.publicId,
        startedAt: run.startedAt,
        // Dedup identity on OUR app: one capability, one ticket, across every
        // customer whose verdict fails to arrive.
        appSlug: self.appSlug,
      },
      policy: selfPolicy(self, "[Checker gap] {verdict}"),
      ownerId: self.ownerId,
      verdictUrl: `${baseUrl}/verdict/${run.publicId}`,
    });
    return {
      icon: "ok",
      text:
        outcome.kind === "created"
          ? `Opened ${outcome.identifier} on our own board: ${DELIVERY_GAP.label}`
          : outcome.kind === "commented"
            ? `A verdict email failed to reach its owner again — ${outcome.identifier} now at ${outcome.occurrences} occurrence(s)`
            : `Our undelivered-verdict gap is filed as ${outcome.identifier}`,
    };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    console.warn(`[delivery-gap] filing failed: ${text}`);
    return { icon: "warn", text: `Couldn't file our undelivered-verdict gap: ${text}` };
  }
}

// ─── A model road that refused the verdict (CHE-330) ────────────────────────
//
// Synthesis now survives a refused road by asking over the next one, which is
// exactly what would let the refusal go unseen: the run completes and nobody
// learns that the first road is closed from where our Workflows run. So each
// refusal files here, one ticket counted across every run, carrying the
// provider's words and the location the request left from.

const ROUTE_REFUSAL = {
  label: "The verdict model refused us on its first route",
  why:
    "Every run that hits this pays for its walk and then depends on the fallback road to " +
    "write the verdict. Runs #135, #197 and #258 were lost outright to it before the " +
    "fallback existed.",
};

// CHE-329: when every road refused and the run is failing, the failure path
// must know whether THIS run's refusal reached our board — the error object
// (and the refusals riding on it) does not cross the step boundary, and a
// filing that failed must fall back to the run-failure ticket rather than be
// assumed. So a filed refusal is written into the message the run fails with:
// Run.errorMessage is internal, and the prefix is a per-run fact, not an
// inference from the status code and the phase.
export const ROUTE_REFUSAL_FILED = "internal: route refusal filed as ";

// The identifier fileRouteRefusal filed onto, or null when it did not file.
// A suppressed signature counts as settled: the owner ruled on it.
export function routeRefusalFiledAs(result: string): string | null {
  return /^(?:created|commented|suppressed) (\S+)$/.exec(result)?.[1] ?? null;
}

// Never throws, and nothing in it can: it runs inside the `writing` step, and
// a tracker or database hiccup here must not turn a verdict the fallback just
// wrote into a failed step that pays for synthesis again. verdictWritten is
// false when no road answered synthesis and the run is failing anyway.
export async function fileRouteRefusal(
  env: AgentEnv,
  runId: string,
  opts: { refusals: RouteRefusal[]; verdictWritten: boolean },
): Promise<string> {
  try {
    return await fileRouteRefusalOrThrow(env, runId, opts);
  } catch (err) {
    return `filing failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function fileRouteRefusalOrThrow(
  env: AgentEnv,
  runId: string,
  opts: { refusals: RouteRefusal[]; verdictWritten: boolean },
): Promise<string> {
  const run = await env.db.run.findUnique({
    where: { id: runId },
    select: { runNumber: true, publicId: true, startedAt: true, appSlug: true },
  });
  if (!run) return `run ${runId} is gone`;
  const board = await ourBoard(env);
  if (!board) return "no tracker on our own app";
  const { self, tracker, baseUrl } = board;

  const finding: TicketFinding = {
    runId,
    number: 0,
    title: ROUTE_REFUSAL.label,
    category: "broken",
    severity: "high",
    detail: JSON.stringify({
      // Fixed, so every refusal hashes to the same ticket.
      where: "CheckMyApp verdict synthesis",
      whatWeTried: [
        ...opts.refusals.map(
          (r) =>
            `${r.model} answered ${r.error} (left from ${r.colo ?? "unknown location"}` +
            `${r.loc ? `, country ${r.loc}` : ""}); ` +
            `${r.answeredBy ? `${r.answeredBy} answered that call instead.` : "no road answered that call."}`,
        ),
        `On: ${run.appSlug} (run #${run.runNumber}).`,
      ],
      whatHappened: opts.verdictWritten
        ? "A road to the verdict model refused the request; the run finished on the fallback."
        : "Every road to the verdict model refused the request, and a run whose walk was paid for published nothing.",
      whyItMatters: `${ROUTE_REFUSAL.why} This ticket counts every refusal; it closes when the first road stops refusing.`,
    }),
    evidence: [],
  };

  const outcome = await fileFindingTicket({
    db: env.db,
    tracker,
    appId: self.id,
    finding,
    run: { runNumber: run.runNumber, publicId: run.publicId, startedAt: run.startedAt, appSlug: self.appSlug },
    policy: selfPolicy(self, "[Checker gap] {verdict}"),
    ownerId: self.ownerId,
    verdictUrl: `${baseUrl}/verdict/${run.publicId}`,
  });
  return `${outcome.kind} ${outcome.identifier}`;
}

// ─── A rejected ticket is a defect report against us (CHE-99) ───────────────
//
// Owner rule, 2026-08-30: "is this our bug or theirs" must never be settled by
// looking deeper into the customer — it must be made impossible by not having
// bugs on our side. Reverse sync already reads Canceled as not-a-bug and stops
// refiling that signature (reconcile.ts), and that is exactly where it used to
// go quiet: a customer telling us we were wrong produced nothing on our board.
//
// Deduped by CLASS, not by incident — the same way one missing capability is
// one ticket across every app that trips it. We want the count of "times our
// configuration produced a false claim" to climb on ONE ticket until the cause
// is gone, not to scatter into a ticket per apology.

export type DefectClass = "capability" | "configuration" | "interpretation" | "bookkeeping";

const DEFECTS: Record<DefectClass, { label: string; why: string }> = {
  capability: {
    label: "Checker reported a product defect it was never able to observe",
    why: "We could not perform the action, and said the product was at fault instead of saying we could not do it. Every instance is a capability we owe ourselves — the step should have gone to our own board, silently, and the customer should have read nothing.",
  },
  configuration: {
    label: "Checker reported a product defect caused by our own configuration",
    why: "Our inputs were wrong — a stale credential, a wrong URL, a scope that no longer matches. The truth was entirely on our side of the boundary and we never checked it before spending money and someone else's attention.",
  },
  interpretation: {
    label: "Checker reported a product defect from the absence of evidence",
    why: "Silence is not evidence. Rule §3 requires positive evidence a real user would hit; a claim built on nothing happening is a claim about our own uncertainty wearing the customer's name.",
  },
  bookkeeping: {
    label: "Checker re-filed something it had already been told was not a bug",
    why: "We lost track of what we had filed or been told. Repeating a disproved claim is the fastest way to be filtered out — the second one costs more trust than the first one cost time.",
  },
};

const UNCLASSIFIED = {
  label: "Checker filed a claim the owner rejected, cause unclassified",
  why: "An unclassified rejection is the one we learn least from. Whoever picks this up should name the cause and, if it is a new shape, give it its own class.",
};

// Our own formulaic phrasing for "nothing happened, so we called it a defect" —
// the exact shape rules §1 and §3 exist to forbid.
const ABSENCE_CLAIM =
  /could not be (confirmed|verified)|did ?n[o']t respond|no (network )?(request|reaction|response) (followed|at all)|nothing happened|unresponsive|inert/i;

// Which of our failure modes produced a claim the owner rejected. Fact-based
// where a fact exists, null where it does not: a guess here would corrupt the
// only number that tells us whether we are getting better.
//
// `bookkeeping` is deliberately not inferred. It is not a thing to detect after
// the fact — CHE-101 makes re-filing a settled signature structurally
// impossible, and until then the honest answer is "unclassified".
export async function classifyCheckerDefect(
  env: AgentEnv,
  opts: {
    originRunId: string | null;
    journeyTitle: string | null;
    claimText: string;
    /** Set by the credential preflight (CHE-100) when our own inputs were wrong. */
    configurationFault?: boolean;
  },
): Promise<DefectClass | null> {
  if (opts.configurationFault) return "configuration";

  // Recorded fact, not inference: the walk itself said OUR checker could not do
  // something in this journey. A customer-facing claim on top of that is ours.
  if (opts.originRunId) {
    const blocked = await env.db.step.count({
      where: {
        unverifiedReason: "our_capability",
        journey: {
          runId: opts.originRunId,
          ...(opts.journeyTitle ? { title: opts.journeyTitle } : {}),
        },
      },
    });
    if (blocked > 0) return "capability";
  }

  if (ABSENCE_CLAIM.test(opts.claimText)) return "interpretation";

  return null;
}

// Open (or count another occurrence on) the ticket for this class of our own
// defect. Same failure contract as everything else in this file: it never
// throws, because housekeeping on our own board must not cost a customer a run.
export async function fileCheckerDefect(
  env: AgentEnv,
  opts: {
    defectClass: DefectClass | null;
    /** The customer ticket the owner canceled, e.g. "JOB-904". */
    rejectedIssueId: string;
    customerAppSlug: string;
    /** What we claimed, in our own words at the time. */
    claimTitle: string | null;
    originRunId: string | null;
  },
): Promise<CapabilityNote> {
  const { label, why } = opts.defectClass ? DEFECTS[opts.defectClass] : UNCLASSIFIED;

  const board = await ourBoard(env);
  if (!board) {
    return {
      icon: "warn",
      text: `${opts.rejectedIssueId} was rejected as not-a-bug — connect the CheckMyApp app's own tracker so our own defects get filed.`,
    };
  }
  const { self, tracker, baseUrl } = board;

  const origin = opts.originRunId
    ? await env.db.run.findUnique({
        where: { id: opts.originRunId },
        select: { runNumber: true, publicId: true, startedAt: true },
      })
    : null;

  const finding: TicketFinding = {
    runId: opts.originRunId ?? "",
    number: 0,
    title: label,
    category: "broken",
    severity: "high",
    detail: JSON.stringify({
      // Fixed, so every instance of this class hashes to the same ticket. The
      // customer's own request facts stay OUT of the three fields the dedup
      // signature reads — one endpoint must not fork this into its own ticket.
      where: "CheckMyApp checker accuracy",
      whatWeTried: [
        `We claimed: ${opts.claimTitle ?? "(claim text no longer on file)"}`,
        `On: ${opts.customerAppSlug}${origin ? ` (run #${origin.runNumber})` : ""}`,
        `The owner closed ${opts.rejectedIssueId} as not-a-bug.`,
      ],
      whatHappened:
        "We told a customer their product was broken and they showed us it was not. " +
        "The cost is not the wasted ticket — it is that a customer's team now has " +
        "evidence that our output needs checking before it is trusted.",
      whyItMatters: `${why} This ticket counts every time this class of ours reaches a customer; it closes when the cause is gone, not when the incident is forgotten.`,
    }),
    evidence: [],
  };

  try {
    const outcome = await fileFindingTicket({
      db: env.db,
      tracker,
      appId: self.id,
      finding,
      run: {
        runNumber: origin?.runNumber ?? 0,
        publicId: origin?.publicId ?? "",
        startedAt: origin?.startedAt ?? new Date(),
        // Dedup identity lives on OUR app: one class = one ticket across every
        // customer that ever rejects us.
        appSlug: self.appSlug,
      },
      policy: selfPolicy(self, "[Checker defect] {verdict}"),
      ownerId: self.ownerId,
      verdictUrl: origin ? `${baseUrl}/verdict/${origin.publicId}` : baseUrl,
    });
    return {
      icon: "ok",
      text:
        outcome.kind === "created"
          ? `Opened ${outcome.identifier} on our own board: ${label}`
          : outcome.kind === "commented"
            ? `Our own defect "${label}" reached a customer again — ${outcome.identifier} now at ${outcome.occurrences} occurrence(s)`
            : `Our own defect "${label}" is filed as ${outcome.identifier}`,
    };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    console.warn(`[checker-defect] filing failed: ${text}`);
    return { icon: "warn", text: `Couldn't file our own defect for ${opts.rejectedIssueId}: ${text}` };
  }
}
