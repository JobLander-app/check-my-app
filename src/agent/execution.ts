// Phase 4 — Walking journeys (CF agent). One agent-loop per journey: the model
// acts through browser tools, reports outcomes via report_step (Step + R2
// screenshot evidence), and formalizes the journey via write_e2e_test
// (GeneratedTest in D1 + spec copy in R2 — no Workers filesystem).

import type { Browser } from "@cloudflare/playwright";
import type { StepStatus } from "@/lib/enums";
import { LlmBudgetError, runAgentLoop, finalizeJson, type TranscriptEntry } from "./core";
import {
  countsTowardJourney,
  knownUrlsFrom,
  prepareAgentPage,
  productizeStep,
  scrubSecrets,
  type RecordedAction,
  type UndrivenControl,
  type ToolEnv,
} from "./tools";
import { newAgentContext, newAgentPage, closeAgentContext } from "./browser";
import { extensionBrowserFor } from "./extension-browser";
import { walkingSystem } from "./instructions";
import type { AppKnowledge } from "./knowledge";
import { harnessMode, putScreenshot, putText, walkImageWindow, type AgentEnv } from "./env";
import { originOf, type ProposedJourney, type RunInput } from "./discovery";
import { emptyUsage, mergeUsage, type LlmConfig, type UsageTotals } from "./llm";
import { credentialToolEnv } from "./credentials";
import { WALK_WRAP_UP_ITERATIONS, walkingIterationCap } from "./limits";
import { walkingVision } from "./harness";
import { deriveFunnel } from "@/lib/funnel";
import { parseJson } from "@/lib/json";
import { adjudicateStep } from "./judge";
import { classifyGap, gapEvidenceText, walkGapEvidence } from "./gap-classes";
import { cutUndrivenClaims, type GateStep } from "./findings-gate";
import { cutSelfCheckRefusalClaims, summaryFallback, walkSummaryOnly } from "@/lib/verdict-language";
import { summarizeWalk } from "./summary";
import { journeyMetric, normalizeScenario, recordWalk, resolveJourney } from "./journey-catalog";
import { normalizeSurface } from "@/lib/journey-key";
import { parseAllowedOrigins } from "@/lib/allowed-origins";
import { ExtensionRuntimeError } from "./extension-error";
import { extensionAccountingStep, extensionProductFailureStep } from "./extension-evidence";

export interface WalkRun extends RunInput {
  id: string;
  appSlug: string;
  appId?: string | null;
  // CHE-231: stamped on the journey's catalog row as "last seen in Run #157".
  runNumber: number;
}

const SEVERITY_ORDER: StepStatus[] = ["ok", "skipped", "confusing", "risky", "exposed", "broken"];

function worstStatus(statuses: StepStatus[]): StepStatus {
  return statuses.reduce<StepStatus>(
    (worst, s) => (SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(worst) ? s : worst),
    "ok",
  );
}

// Journey roll-up. Skipped steps must not drag a working journey down to
// "Skipped": ok + skipped mixes become "partial" (the flow works, part of it
// went unverified). All-skipped stays "skipped"; any real problem still wins.
function journeyStatus(statuses: StepStatus[]): string {
  const attempted = statuses.filter((s) => s !== "skipped");
  if (attempted.length === 0) return "skipped";
  const worst = worstStatus(attempted);
  return worst === "ok" && attempted.length < statuses.length ? "partial" : worst;
}

// The forced-extraction path asks for raw code, but models still wrap it in a
// ```ts fence about half the time. Strip a single leading/trailing fence.
/**
 * The funnel this journey's walk implies (CHE-238).
 *
 * The steps each carry their own slice of the machine trail; the funnel is
 * derived from all of them in order, because a conversion path crosses steps —
 * "landed, tried the thing, hit the login wall" is three steps and one funnel.
 *
 * Returns a refusal rather than nothing when there is no funnel: that refusal
 * is a statement about our own capability and is what a "[Checker gap]" is
 * filed from (rule 2), so losing it would turn a gap of ours into silence.
 */
function funnelFromWalk(steps: readonly GateStep[]) {
  return deriveFunnel(
    steps.flatMap((s) => parseJson<Array<{ outcome?: { urlAfter?: string | null } | null }>>(s.actions) ?? []),
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stripCodeFence(text: string): string {
  const fenced = text.match(/```(?:[a-zA-Z]+)?\n([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

async function sha256hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Walk ONE journey. Called per-journey from its own Workflow step (CHE-24) so a
// CPU-limit/retry only re-does that journey, never the whole walk. Idempotent:
// any pre-existing journey for (runId, order) is deleted first (cascades steps/
// evidence), so a step retry can't accumulate duplicate journey rows.
export async function walkOneJourney(args: {
  env: AgentEnv;
  llm: LlmConfig;
  browser: Browser;
  run: WalkRun;
  proposed: ProposedJourney;
  index: number;
  // CHE-136: settled findings and changed pages, so the walk stops proving a
  // known condition again. Absent = the prompt as before.
  knowledge?: AppKnowledge | null;
  // CHE-171: addresses the run already knows the product publishes (the
  // survey's pages, CHE-132), seeding the set a 404 is judged against. The
  // walk adds what it reads and where it lands as it goes.
  publishedUrls?: string[];
  onLiveScreenshot?: (url: string) => Promise<void>;
  onProgress?: (note: string) => Promise<void>;
}): Promise<{
  transcript: TranscriptEntry[];
  // Everything this journey cost, the judge included — what Run.costUsd sums.
  costUsd: number;
  // The walking loop's own tokens: the "walking" LlmUsage row.
  usage: UsageTotals;
  // CHE-169: the judge's tokens, its own "judge" row. Null when no judge call
  // was made, so the ledger carries no empty rows for walks that needed none.
  judgeUsage: UsageTotals | null;
}> {
  const { env, llm, browser, run, proposed, index, knowledge, publishedUrls, onLiveScreenshot, onProgress } =
    args;
  const transcripts: TranscriptEntry[] = [];
  let costUsd = 0;
  const usage = emptyUsage();
  // CHE-169: the tier decides how the walk sees and whether a negative step
  // gets a second opinion. With HARNESS_TIER unset both are today's walk.
  const harness = harnessMode(env.bindings);
  const vision = walkingVision(harness, llm.navVision);
  const judgeUsage = emptyUsage();

  await env.db.journey.deleteMany({ where: { runId: run.id, order: index } });

  {
    // CHE-193: on our own hosts the context announces itself on the requests
    // the web half guards, and on nothing else (CHE-212; self-hosts.ts).
    const context = await newAgentContext(browser, run.targetUrl, env.bindings);
    const page = await newAgentPage(browser, context);
    const extension = extensionBrowserFor(browser);

    // CHE-231: which journey OF THE APP this walk is a check of, decided before
    // a single step is written. The identity rules are in lib/journey-key.ts;
    // a run with no App row gets the key and no catalog row. Never fatal: a
    // catalog we could not read costs this journey its history, not its walk.
    // CHE-247: the scenario goes in with the title. extension-discovery.ts has
    // been setting it all along and the browser has been launched with it; it
    // simply never reached identity, which is why "Practice with interview
    // assistance" was absorbed into "Interview assistance and session minutes"
    // at 0.67 token overlap and the two-meter scenario had no history anywhere.
    const identity = await resolveJourney(env, run, proposed.title, proposed.surface, proposed.extensionScenario).catch((err) => {
      console.warn(`[journey] identity unresolved for "${proposed.title}": ${errText(err)}`);
      return { appJourneyId: null, key: null, isNew: false };
    });

    // CHE-235: what this check says the journey is worth to its user. Decided
    // against the stored value, so a number only moves when the model named
    // what changed; `null` when this run had nothing to say (a re-walk, a
    // model that skipped the field).
    const metric = await journeyMetric(env, identity.appJourneyId, proposed.metric);

    const journey = await env.db.journey.create({
      data: {
        runId: run.id,
        order: index,
        title: proposed.title,
        status: "ok",
        appJourneyId: identity.appJourneyId,
        journeyKey: identity.key,
        surface: normalizeSurface(proposed.surface),
        scenario: normalizeScenario(proposed.extensionScenario),
        price: metric?.price ?? null,
        conversion: metric?.conversion ?? null,
      },
    });

    const stepStatuses: StepStatus[] = [];
    let stepOrder = 0;
    let testWritten = false;
    let lastScreenshot: { storageUrl: string; sha256: string } | null = null;
    // CHE-129: navigate/click/fill accumulate here between report_step calls;
    // each report drains what ran since the last one into that step's row.
    const actionTrail: RecordedAction[] = [];
    // CHE-214: controls a fill or a click could not drive, drained by the same
    // report_step that drains the trail above.
    const undrivenControls: UndrivenControl[] = [];
    // CHE-219: this journey's steps as they land, so its summary can be held to
    // the same evidence a finding is.
    const walkedSteps: GateStep[] = [];
    // CHE-334: this walk met our own self-check guard, so its summary may not
    // retell that refusal as the product's.
    let metOwnGuard = false;

    const toolEnv: ToolEnv = {
      page,
      extension,
      targetOrigin: originOf(extension?.identity.targetUrl ?? run.targetUrl),
      // CHE-373: the origins the owner allowed besides the target's.
      allowedOrigins: parseAllowedOrigins(run.allowedOrigins, env.bindings.SELF_CHECK_HOSTS),
      // CHE-193: lets the click gate know which extra hosts are ours.
      selfCheckHosts: env.bindings.SELF_CHECK_HOSTS,
      // CHE-168 decides whether the nav model sees at all (llm.navVision);
      // CHE-169 decides when — every capture, or only at a judgment moment.
      visionScreenshots: vision.visionScreenshots,
      // CHE-169: present only under vision on demand, so the ToolEnv with the
      // harness off is the object it was before the field existed.
      ...(vision.visionTriggers ? { visionTriggers: true } : {}),
      // CHE-90: creation is allowed only when the owner enabled it, and every
      // created record lands in the ledger the moment it exists.
      writeAllowed: run.writeAllowed ?? false,
      testMarker: run.testMarker,
      onResourceCreated: async (r) => {
        await env.db.createdResource.create({
          data: {
            runId: run.id,
            appId: run.appId ?? null,
            kind: r.kind.slice(0, 100),
            marker: r.marker.slice(0, 200),
            locationUrl: r.locationUrl?.slice(0, 500) ?? null,
            notes: r.notes?.slice(0, 500) ?? null,
          },
        });
      },
      onResourceDeleted: async (r) => {
        await env.db.createdResource.updateMany({
          where: { runId: run.id, marker: r.marker },
          data: r.ok
            ? { deletedAt: new Date(), cleanupNote: r.note?.slice(0, 500) ?? null }
            : { cleanupNote: (r.note ?? "deletion failed").slice(0, 500) },
        });
      },
      // CHE-100: read fresh per journey, because that is what makes the rule
      // hold across journeys — an earlier one may already have been told no.
      // CHE-322: every named account the run carries, not only the default.
      ...(await credentialToolEnv(env, run)),
      networkLog: [],
      consoleLog: [],
      actionTrail,
      undrivenControls,
      // CHE-171: a 404 on an address outside this set is not a defect.
      knownUrls: knownUrlsFrom(run.targetUrl, publishedUrls),
      onScreenshot: async (buffer) => {
        const stored = await putScreenshot(env, buffer, extension ? { privateRunId: run.id } : "public");
        lastScreenshot = extension ? null : stored;
        if (!extension) await onLiveScreenshot?.(stored.storageUrl);
        return stored.storageUrl;
      },
      onReportStep: async (reported) => {
        // CHE-214: a class already decided from the machine trail at report
        // time (a control our hands could not drive) is evidence, not a guess.
        // Captured before adjudication, which may hand back a different object.
        const machineClass = reported.gapClass;
        // CHE-169: a negative step gets its second opinion BEFORE anything is
        // written — the status that lands in the row is the adjudicated one.
        // With the judge off this returns the step untouched.
        const step = await adjudicateStep({
          llm,
          enabled: harness.judge && !extension?.popup,
          step: reported,
          page: toolEnv.page,
          networkLog: toolEnv.networkLog,
          scrub: (text) => scrubSecrets(toolEnv, text),
          usage: judgeUsage,
        });
        // CHE-198: the capability is named HERE, on the model's own words
        // (reported — the judge may have replaced the observed text) and the
        // machine trail, before productizeStep cuts every sentence that names
        // our side. The filer (capability-gaps.ts) used to re-read the stored
        // text and could not find the words it keyed on.
        if (step.unverifiedReason === "our_capability") {
          step.gapClass =
            machineClass ??
            classifyGap(
              walkGapEvidence(
                toolEnv,
                gapEvidenceText(reported.label, reported.attempted, reported.observed, step.observed),
                actionTrail,
              ),
            );
        } else {
          step.gapClass = undefined;
        }
        // CHE-180: the customer's words, decided after the judge has seen the
        // model's. Nothing between here and the row may reintroduce ours.
        productizeStep(step);
        // CHE-334: a step our own guard refused is kept (it is what the walk
        // did) but is no part of the journey's status — the journey is judged
        // up to the guard.
        if (countsTowardJourney(step)) stepStatuses.push(step.status as StepStatus);
        if (step.selfCheckGuardSeen) metOwnGuard = true;
        const trail = actionTrail.splice(0);
        // CHE-219: the same rows the summary below is judged against, kept as
        // they are written so the cut sees this journey's own evidence.
        walkedSteps.push({
          status: step.status,
          unverifiedReason: step.unverifiedReason ?? null,
          label: step.label,
          observed: step.observed,
          attempted: step.attempted,
          actions: trail.length ? JSON.stringify(trail) : null,
        });
        await env.db.step.create({
          data: {
            journeyId: journey.id,
            order: stepOrder++,
            label: step.label,
            status: step.status,
            attempted: step.attempted,
            observed: step.observed,
            consoleLog: step.consoleExcerpt ?? null,
            networkLog: step.networkExcerpt ?? null,
            unverifiedReason: step.unverifiedReason ?? null,
            gapClass: step.gapClass ?? null,
            actions: trail.length ? JSON.stringify(trail) : null,
            screenshotUrl: lastScreenshot?.storageUrl ?? null,
            evidence: lastScreenshot
              ? { create: [{ type: "screenshot", ...lastScreenshot }] }
              : undefined,
          },
        });
        lastScreenshot = null;
      },
      onWriteTest: async (test) => {
        testWritten = true;
        // Native specs are built from successful operations only, after Stop
        // and disposal; a model-authored website spec cannot replay the popup.
        if (extension) return;
        await persistGeneratedTest(env, {
          appSlug: run.appSlug,
          journeyId: journey.id,
          title: test.title,
          content: test.content,
        });
      },
    };
    await prepareAgentPage(toolEnv);

    try {
      const result = await runAgentLoop({
        system: walkingSystem(run, proposed.title, proposed.steps, knowledge),
        task: extension
          ? `Target product: installed extension ${extension.identity.name}. Walk this journey through extension_open and the companion tab ${extension.identity.targetUrl}. The Store listing and synthetic companion content are not the product. Session actions use the owned session tools; Stop must be observed before completing the journey.`
          : `Target app: ${run.targetUrl}\nWalk the journey now. Navigate to the target first.`,
        env: toolEnv,
        llm,
        // CHE-134: sized to the journey. The cap was a flat 50 whatever the
        // journey's length, and walks ran 25–40 calls each, output-token
        // dominated (COSTS.md). A 3-step journey gets 27, an 8-step one 50.
        maxIterations: walkingIterationCap(proposed.steps.length),
        // CHE-134: the spec is the last artefact a journey produces; after it
        // the walk got no further evidence, only the bill. Three more turns
        // cover cleanup (a create_cleanup walk must delete its record and
        // call record_deleted before finishing, CHE-90) and the summary.
        // Model-facing only: report_step is untouched, so nothing here can
        // reach Step.attempted/observed or any other customer-facing text.
        wrapUpAfter: {
          tool: "write_e2e_test",
          extraIterations: WALK_WRAP_UP_ITERATIONS,
          note:
            "The journey is recorded. Wrap up now: if you created anything, delete it " +
            "and call record_deleted; then reply with the 1-2 sentence summary and make " +
            "no further tool calls.",
        },
        // E3 (CHE-58): walking is act/observe, not deep reasoning — drop
        // adaptive thinking to cut output tokens/call. Verdict calibration
        // still happens in synthesis (Opus, thinking on).
        thinking: "off",
        onProgress,
        // CHE-130: screenshots accumulated in the walking context and were
        // re-read every iteration — a full joblander walk went $0.91 → $2.31
        // when vision nav landed. Keep only the last few in view.
        imageWindow: walkImageWindow(env.bindings),
      });
      transcripts.push(...result.transcript);
      costUsd += result.costUsd;
      mergeUsage(usage, result.usage);

      // The walk authors a Playwright spec via write_e2e_test, but the model
      // often exhausts its iteration budget acting/observing and never reaches
      // that closing call (same failure mode as discovery's journey JSON). If
      // it walked real steps but wrote no test, reuse the journey context to
      // force the spec out — the "worker authors its own e2e tests" guarantee
      // must hold per run, not depend on the model remembering to wrap up.
      if (!extension && !testWritten && stepStatuses.length > 0) {
        const spec = await finalizeJson(
          llm,
          result.messages,
          "You did not call write_e2e_test. Output ONLY a complete Playwright spec " +
            "(TypeScript, @playwright/test) replaying this journey's happy path with " +
            "role-based locators and process.env.TARGET_URL as base URL. Assert only on " +
            "what you actually observed working. No prose — just the code.",
          usage,
        );
        const content = stripCodeFence(spec);
        if (content.includes("@playwright/test")) {
          await persistGeneratedTest(env, {
            appSlug: run.appSlug,
            journeyId: journey.id,
            title: proposed.title,
            content,
          });
        }
      }

      // CHE-180: the model's last text is the summary only when the model
      // stopped on its own and the text is a finished statement; a walk the
      // cap cut mid-action (run #144: "Let me try the Reset to Defaults
      // button") is asked once more for the summary alone.
      const status = journeyStatus(stepStatuses);
      const written = await summarizeWalk(llm, result, usage, status);
      // CHE-219: run #159's journey 0 summary said the notes field "fails to
      // accept input — the fill operation times out", about a control this
      // journey never drove. The phrase tables cannot see that sentence; the
      // machine trail can. What is left of the summary stands; when nothing is,
      // the journey gets the same fixed sentence an empty summary gets.
      const claim = cutUndrivenClaims(written, [{ steps: walkedSteps }]);
      if (claim.cut.length) {
        console.warn(
          `[walk] summary claimed ${claim.cut.length} interaction(s) this journey never performed — cutting: ${claim.cut.join(" / ")}`,
        );
      }
      const claimed = claim.cut.length ? (claim.text ?? summaryFallback(status)) : written;
      // CHE-334: what happened on this walk — not a description of the
      // product, not our own history, and not our own guard retold as theirs.
      const walkOnly = walkSummaryOnly(claimed, run.targetUrl);
      const guarded = metOwnGuard ? cutSelfCheckRefusalClaims(walkOnly.text, walkedSteps) : { text: walkOnly.text, cut: [] };
      const ownWords = [...walkOnly.cut, ...guarded.cut];
      if (ownWords.length) {
        console.warn(`[walk] summary cut ${ownWords.length} sentence(s) not about this walk: ${ownWords.join(" / ")}`);
      }
      const summary = ownWords.length ? (guarded.text ?? summaryFallback(status)) : claimed;

      await env.db.journey.update({
        where: { id: journey.id },
        data: { status, summary },
      });
      if (extension && stepStatuses.length > 0) {
        await extension.finish();
        const failure = extensionProductFailureStep(await extension.finalEvidence());
        if (failure) {
          productizeStep(failure);
          await env.db.step.create({ data: { journeyId: journey.id, order: stepOrder++, ...failure } });
          stepStatuses.push(failure.status);
          await env.db.journey.update({ where: { id: journey.id }, data: { status: journeyStatus(stepStatuses) } });
        }
        const accounting = extensionAccountingStep(await extension.finalEvidence());
        if (accounting) {
          // The final balance settles after the agent's last visible Stop.
          // Record that independent observation even if the loop wrapped up.
          await env.db.step.create({ data: { journeyId: journey.id, order: stepOrder++, ...accounting } });
          stepStatuses.push(accounting.status);
          await env.db.journey.update({ where: { id: journey.id }, data: { status: journeyStatus(stepStatuses) } });
        }
        await persistGeneratedTest(env, { appSlug: run.appSlug, journeyId: journey.id, title: proposed.title,
          content: await extension.exportSpec(proposed.title) });
      }
      // CHE-231: the catalog learns what this walk found — the status, the plan
      // the next walk starts from, the failure streak. After the extension
      // block, which can add steps and move the status: the catalog records
      // where the journey actually landed, not where it stood mid-wrap-up.
      // Best-effort by contract: the catalog is how the app remembers, never
      // how a run succeeds.
      await recordWalk(env, {
        appJourneyId: identity.appJourneyId,
        runId: run.id,
        runNumber: run.runNumber,
        title: proposed.title,
        status: journeyStatus(stepStatuses),
        plan: walkedSteps.map((s) => s.label).filter(Boolean),
        surface: proposed.surface,
        scenario: proposed.extensionScenario,
        metric,
        // CHE-238: the funnel is the pages this walk actually moved through.
        // The customer is never asked to define one.
        funnel: funnelFromWalk(walkedSteps),
      }).catch((err) => console.warn(`[journey] catalog not updated: ${errText(err)}`));
    } catch (err) {
      // Per-journey isolation: one failure must not abort the rest of the run.
      // Our own LLM budget died (CHE-76) — not a fact about this journey or the
      // app. Propagate so the workflow aborts the whole run unpublished instead
      // of burning through the remaining journeys and shipping a verdict.
      if (err instanceof LlmBudgetError || err instanceof ExtensionRuntimeError) throw err;
      console.error(`[walk] journey "${proposed.title}" failed:`, err);
      const abortedStatus = journeyStatus(stepStatuses);
      await env.db.journey.update({
        where: { id: journey.id },
        data: {
          status: abortedStatus,
          summary: `Walk aborted: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
        },
      });
      // An aborted walk is still what we know about this journey today — the
      // catalog records the status that landed, streak included.
      await recordWalk(env, {
        appJourneyId: identity.appJourneyId,
        runId: run.id,
        runNumber: run.runNumber,
        title: proposed.title,
        status: abortedStatus,
        plan: walkedSteps.map((s) => s.label).filter(Boolean),
        surface: proposed.surface,
        scenario: proposed.extensionScenario,
        metric,
        funnel: funnelFromWalk(walkedSteps),
      }).catch((e) => console.warn(`[journey] catalog not updated: ${errText(e)}`));
    } finally {
      await closeAgentContext(browser, context);
    }
  }

  // The judge's cost belongs to the journey's total (Run.costUsd), but to its
  // own ledger row — the walking row must keep meaning "the walking loop".
  costUsd += judgeUsage.costUsd;
  return {
    transcript: transcripts,
    costUsd,
    usage,
    judgeUsage: judgeUsage.iterations > 0 ? judgeUsage : null,
  };
}

// Generated specs: versioned in D1 (served by /api/tests/{id}) + a copy in R2
// for direct download. No Workers filesystem, so nothing is written to disk.
async function persistGeneratedTest(
  env: AgentEnv,
  args: { appSlug: string; journeyId: string; title: string; content: string },
): Promise<void> {
  const sha256 = await sha256hex(args.content);
  const existing = await env.db.generatedTest.findFirst({
    where: { appSlug: args.appSlug, title: args.title },
    orderBy: { version: "desc" },
  });
  const version = (existing?.version ?? 0) + 1;

  await env.db.generatedTest.create({
    data: {
      appSlug: args.appSlug,
      journeyId: args.journeyId,
      title: args.title,
      content: args.content,
      sha256,
      version,
    },
  });

  const fileSlug = args.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  await putText(env, `specs/${args.appSlug}/${fileSlug}.v${version}.spec.ts`, args.content);
}
