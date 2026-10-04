// CheckRunWorkflow (CHE-14/15) — the durable 6-phase orchestrator on Cloudflare
// Workflows, replacing the BullMQ worker loop. Each phase is a step.do(): the
// run survives retries and restarts; step outputs are persisted.
//
// connecting → surface_scan (deterministic) → discovery (LLM) → walking (LLM,
// per journey) → anatomy → writing (LLM synthesis + findings). Browser sessions
// are per-phase. Transcript (secret-free) → R2; cost rolled into Run.costUsd.
//
// Every run starts with a SURVEY (CHE-132, ./survey.ts + ./snapshot.ts): a
// plain fetch of the app's pages, no browser, no model, that records what the
// app looks like and whether it changed since the last snapshot. The ladder
// below reads that answer — a full walk happens when the app changed, not
// when a week has passed.
//
// Watch runs get a mode ladder in front of that, cheapest rung first:
//   1. SMOKE (CHE-51, ./replay.ts) — a free pre-check that can complete the run
//      before a single token is spent. See that file for what it does and does
//      not prove.
//   2. PARTIAL (CHE-57, ./partial.ts) — re-walk only the journeys that were bad
//      last time, carry the healthy ones forward. Skips discovery and reuses the
//      baseline anatomy; unlike smoke it does NOT skip synthesis, because it
//      produces fresh evidence that has to be adjudicated.
//   3. FULL — the six phases below.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { AppAnatomy } from "@/lib/types";
import type { Verdict } from "@/lib/enums";
import { normalizeAnatomy } from "@/lib/anatomy";
import { coverageSentence, pagePaths, unreachedPages } from "@/lib/coverage";
import { parseJson } from "@/lib/json";
import { readExtensionOptions } from "@/lib/extension-target";
import type { RunEvent, RunPhase } from "@/lib/types";
import { discoveryMemoryEnabled, makeAgentEnv, putText, type AgentBindings, type AgentEnv } from "./env";
import { makeLlm, refusalsOf, type UsageTotals } from "./llm";
import { launchAgentBrowser, closeAgentBrowser, newAgentContext, surfaceScan } from "./browser";
import { extensionBrowserFor } from "./extension-browser";
import { extensionStepConfig, isExtensionTarget } from "./extension-contract";
import { ExtensionRuntimeError } from "./extension-error";
import { extensionCoverageGap, completeExtensionAccessCheck } from "./extension-evidence";
import { completeClosedDoor } from "./closed-door";
import { completeSignedOut, noteSessionReached, SIGNED_OUT_FEED, tellOwnerSignedOut } from "./signed-out";
import { askForSession, isSessionTarget, releaseSession, sessionHost, waitForSession } from "./session-browser";
import { prepareExtensionPublication } from "./extension-publication";
import { LlmBudgetError } from "./core";
import { dedupKeyForFinding } from "@/lib/tracker/file";
import { findingSignature } from "@/lib/finding-signature";
import { discoverApp, type KnownMap, type ProposedJourney, type RunInput } from "./discovery";
import { loadKnownMap } from "./known-map";
import { loadAppKnowledge, type AppKnowledge } from "./knowledge";
import { walkOneJourney, type WalkRun } from "./execution";
import { parseAllowedOrigins, serializeAllowedOrigins } from "@/lib/allowed-origins";
import {
  catalogIsDeduplicated,
  clearUnsupportablePrices,
  journeysForPlanning,
  noteDiscoveryCoverage,
  recordJourneyCost,
} from "./journey-catalog";
import { orderByFocus } from "./limits";
import { parseActions, replayJourney, type ReplayResult } from "./journey-replay";
import { claimedHands, drivenControls, gateFindings } from "./findings-gate";
import { checkVerdictIntegrity } from "./verdict-load";
import { synthesizeVerdict, type SynthesizedFinding } from "./synthesis";
import { autoFileFindings } from "./autofile";
import {
  fileCapabilityGaps,
  fileDeliveryGap,
  fileRouteRefusal,
  ROUTE_REFUSAL_FILED,
  routeRefusalFiledAs,
} from "./capability-gaps";
import { fileRunFailure } from "./run-failures";
import { measureRunJourneys, measurementNote } from "./journey-measurement";
import { GAP_CLASSES } from "./gap-classes";
import { auditCreatedResources } from "./cleanup";
import { reconcileIssueLinks, reverifyInstructions, verifyFixedLinks } from "./reconcile";
import {
  notifyOutcomeCode,
  notifyVerdictReady,
  recordNotifyOutcome,
  type NotifiableRun,
} from "./notify-verdict";
import { RUNAWAY_COST_USD } from "@/lib/plans";
import { priceRun, voidRunPrice } from "./pricing";

// CHE-327: the runaway fuse. A NonRetryableError, so the engine does not spend
// again by retrying, and an "internal:" message, so the run reads as ours.
function assertBelowRunaway(runId: string, spentUsd: number): void {
  if (spentUsd <= RUNAWAY_COST_USD) return;
  console.error(`[runaway] run ${runId} stopped at $${spentUsd.toFixed(2)} (fuse $${RUNAWAY_COST_USD})`);
  throw new NonRetryableError(
    `internal: runaway fuse — the check cost more than any check should; stopped, nothing was published`,
    "RunawayCost",
  );
}
import { deliverWebhook, type RunCompletedPayload } from "@/lib/notify/webhook";
import { deliverSlack } from "@/lib/notify/slack";
import { decryptSecret } from "@/lib/crypto";
import { clearedCredentials } from "@/lib/test-accounts";
import type { TranscriptEntry } from "./core";
import {
  consoleSetAsideLine,
  quickCheckBottomLine,
  shortLabel,
  smokeOutcomeLine,
  smokeReplay,
  SMOKE_COST_USD,
  type SmokeReport,
} from "./replay";
import {
  decideRunMode,
  mergeSurveyedPages,
  NO_SURVEY,
  surveyEvent,
  takeSnapshot,
  type SurveyOutcome,
} from "./snapshot";
import {
  carryJourney,
  fullBottomLine,
  fullRunQueue,
  partialBottomLine,
  planKnownJourneys,
  planPartialRun,
  type CarriedJourney,
  type PartialDecision,
} from "./partial";

export interface CheckRunParams {
  runId: string;
}

// A budget failure must stop the whole run, and the Workflows engine must NOT
// retry the step (each retry would re-spend tokens we don't have) — convert at
// the step boundary (CHE-76).
function rethrowBudgetNonRetryable(err: unknown): never {
  if (err instanceof LlmBudgetError) {
    throw new NonRetryableError(err.message, "LlmBudgetError");
  }
  if (err instanceof ExtensionRuntimeError) throw new NonRetryableError(err.message, err.name);
  throw err as Error;
}

export class CheckRunWorkflow extends WorkflowEntrypoint<AgentBindings, CheckRunParams> {
  async run(event: WorkflowEvent<CheckRunParams>, step: WorkflowStep): Promise<void> {
    const { runId } = event.payload;
    const env = makeAgentEnv(this.env);
    const llm = makeLlm(this.env);

    const run = await step.do("load-run", async () => {
      const r = await env.db.run.findUnique({
        where: { id: runId },
        select: {
          id: true,
          publicId: true,
          runNumber: true,
          targetUrl: true,
          targetKind: true,
          extensionId: true,
          extensionConfig: true,
          appSlug: true,
          testEmail: true,
          testPasswordEnc: true,
          testAccounts: true,
          // CHE-372: the store password, for every phase that opens the store.
          storePasswordEnc: true,
          scopeHints: true,
          userNotes: true,
          focusAreas: true,
          // CHE-373: the origins the owner allowed besides the target's.
          allowedOrigins: true,
          notifyEmail: true,
          watchId: true,
          baselineRunId: true,
          forceFull: true,
          appId: true,
          // CHE-136: tracker settlements are kept per owner (CHE-101).
          ownerId: true,
          // CHE-253/CHE-262: whose run this is, and therefore who hears about it.
          teamId: true,
        },
      });
      if (!r) throw new Error(`run ${runId} not found`);
      // CHE-373: our own SELF_CHECK_HOSTS out of the allowed origins once,
      // here, so neither the tools, the evidence rules nor the prompt ever
      // treat one of our hosts as the customer's product.
      return { ...r, allowedOrigins: serializeAllowedOrigins(parseAllowedOrigins(r.allowedOrigins, env.bindings.SELF_CHECK_HOSTS)) };
    });
    const isExtension = isExtensionTarget(run);
    // CHE-389: an app checked inside a signed-in session (session-browser.ts).
    // Everything that looks at the app from outside that session — the page
    // survey's plain fetch, the smoke replay and the replay audit in a fresh
    // browser — would meet the sign-in page and call it the product, so a
    // session run takes none of those shortcuts: it walks, in the session.
    const isSession = isSessionTarget(run);
    // The host is leased to one run at a time. Given back at every way out of
    // this function; the lease's own expiry is the backstop. Never fails a run.
    const releaseSessionHost = async (stepName: string) => {
      if (!isSession) return;
      await step.do(stepName, async () => {
        try {
          return await releaseSession(sessionHost(env.bindings), run.id);
        } catch (err) {
          console.warn(`[session] could not release the host: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        }
      });
    };
    // The host is one browser, held by one run for as long as that run needs
    // it. Before every phase that opens it, the run takes its turn: asleep
    // while another run holds the host, not retrying (session-browser.ts). A
    // host held past the limit fails the run with an internal reason (rule 4).
    // What the feed says while it waits is that it waits — nothing about whose
    // turn it is on our host, which is not the customer's product (rule 1);
    // saying nothing at all would read as a check that hung.
    const sessionTurn = async (phase: string, feed: { phase: "connecting" | "discovery" | "walking"; text: "Waiting to start" | "Waiting to continue" }) => {
      if (!isSession) return;
      await waitForSession(
        {
          ask: (name) => step.do(name, () => askForSession(sessionHost(env.bindings), run.id)),
          waiting: (name) =>
            step.do(name, async () => {
              console.log(`[session] run ${runId} waits for the host before ${phase}: another check holds it`);
              await appendEvent(env, runId, feed.phase, { icon: "info", text: feed.text });
            }),
          sleep: (name, seconds) => step.sleep(name, seconds * 1000),
        },
        phase,
      );
    };

    // Everything below is inside the failure handler: a run left in a
    // non-terminal status is worse than a failed one — the scheduler treats it
    // as still in flight and never fires that Watch again.
    try {
      // Survey (CHE-132): what the app's pages look like to a plain fetch, and
      // whether that differs from the last snapshot. Free, under a minute, and
      // the input every mode decision below reads. Swallowed on error like the
      // other pre-flight rungs: a survey that could not run leaves the ladder
      // exactly as it was before this step existed, never a failed run.
      const survey = await step.do("survey", async (): Promise<SurveyOutcome> => {
        if (isExtension || isSession) return NO_SURVEY;
        try {
          return await takeSnapshot(env, run);
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          console.warn(`[survey] ${run.appSlug}: ${text}`);
          return NO_SURVEY;
        }
      });
      if (run.watchId) {
        await step.do("survey-log", async () => {
          await appendEvent(env, runId, "replay", surveyEvent(survey));
        });
      }

      // Reverse sync (CHE-61): fold the tracker's verdicts back in before any
      // mode decision. Done tickets queue a targeted re-verification (and veto
      // the smoke shortcut below — a smoke pass can't confirm a fix); Canceled
      // tickets suppress their signatures for good. Same swallow contract as
      // the other pre-flight rungs: a tracker outage costs reverse sync, never
      // the run.
      const reconciled = await step.do("reconcile", async () => {
        try {
          const r = await reconcileIssueLinks(env, run);
          for (const note of r.notes) {
            await appendEvent(env, runId, "replay", note);
          }
          return r;
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          console.warn(`[reconcile] tracker sync failed: ${text}`);
          return { notes: [], reverify: [] };
        }
      });

      // AppKnowledge (CHE-136): what earlier runs settled about this app —
      // findings the owner marked or the tracker canceled, fixes confirmed
      // from outside, pages the survey saw change, the last walk's journeys —
      // composed once and read by all three prompts. After reconcile on
      // purpose, so a ticket canceled today counts today. A hint, never a
      // reason: a failure to load it costs the prompts their memory, not the
      // run. No feed line — this is our machinery, not news about their app.
      const knowledge = await step.do("knowledge", async (): Promise<AppKnowledge | null> => {
        try {
          const k = await loadAppKnowledge(env, run, survey);
          if (k) {
            console.log(
              `[knowledge] ${k.settled.length} settled, ${k.changedPaths.length} changed paths, ` +
                `${k.journeys.length} journeys`,
            );
          }
          return k;
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          console.warn(`[knowledge] unavailable: ${text}`);
          return null;
        }
      });

      // Phase 0 — Replay-first (CHE-51). Before spending ~$0.53 of tokens on a
      // recurring watch run, re-check the pages we already know for free. A green
      // smoke pass ends the run right here carrying the baseline verdict forward;
      // anything else falls through to the next rung of the ladder. Errors inside
      // the check are swallowed on purpose: a Browser Rendering hiccup during a
      // cheap pre-check must cost a full run, never the run itself.
      const smoke = await step.do("replay", async () => {
        if (isExtension) return { taken: false as const, reason: "extension checks require the installed product" };
        if (isSession) return { taken: false as const, reason: "this app is checked while signed in — walking everything" };
        // Full re-check (CHE-74): the owner explicitly asked to walk everything
        // — no shortcut may eat that request.
        if (run.forceFull) {
          return { taken: false as const, reason: "full re-check requested — walking everything" };
        }
        // A pending fix verification needs a real walk of the journey the
        // ticket came from; "the pages still serve" cannot confirm a fix.
        if (reconciled.reverify.length > 0) {
          const n = reconciled.reverify.length;
          return {
            taken: false as const,
            reason: `${n} fixed ticket${n === 1 ? "" : "s"} to re-verify — a smoke pass can't confirm a fix`,
          };
        }
        try {
          return await smokeReplay(env, run, survey);
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          console.warn(`[replay] smoke check errored: ${text}`);
          return { taken: false as const, reason: `smoke check errored (${text})` };
        }
      });

      // Phase 0b — Partial mode (CHE-57), the middle rung of the ladder. Only
      // reachable when the smoke check did NOT run: a green smoke ends the run
      // above, and a red one is app-wide trouble that deserves a full walk. Same
      // swallow-and-fall-through contract as the smoke check — a planning error
      // costs a full run, never the run itself.
      const plan = await step.do("partial-plan", async (): Promise<PartialDecision> => {
        if (isExtension) return { taken: false, reason: "extension checks require fresh native evidence" };
        if (isSession) return { taken: false, reason: "this app is checked while signed in — walking everything" };
        if (run.forceFull) {
          return { taken: false, reason: "full re-check requested — walking everything" };
        }
        if (!run.watchId) return { taken: false, reason: "one-off check" };
        if (smoke.taken) {
          return { taken: false, reason: "the smoke check found trouble — re-walking every journey" };
        }
        try {
          return await planPartialRun(env, run, survey);
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          console.warn(`[partial] planning errored: ${text}`);
          return { taken: false, reason: `partial planning errored (${text})` };
        }
      });

      if (run.watchId) {
        await step.do("replay-log", async () => {
          for (const event of modeEvents(smoke, plan, run.targetUrl)) {
            await appendEvent(env, runId, "replay", event);
          }
        });
      }

      // The mode, said once (CHE-213). Both rungs have answered; snapshot.ts
      // turns those two answers into smoke / partial / full, and every branch
      // below reads this instead of re-deriving it from `smoke` and `plan`.
      // scripts/verify-survey.ts asserts the same function against the real
      // planners, so the table cannot drift from what production does.
      const mode = decideRunMode({
        smoke: smoke.taken ? { ran: true, ok: smoke.ok } : { ran: false, reason: smoke.reason },
        partial: plan.taken ? { planned: true } : { planned: false, reason: plan.reason },
      });
      // Our own log, not the feed: the feed already carries each rung's line
      // in the owner's words (modeEvents), and this is the one place a cost
      // question can be answered from the logs alone.
      console.log(`[mode] ${mode.mode} — ${mode.reason}`);

      // `smoke.taken` is how TypeScript learns the report's fields are there;
      // decideRunMode returning "smoke" already implies it.
      if (mode.mode === "smoke" && smoke.taken) {
        // Deliberately NOT routed through synthesis or checkVerdictIntegrity: a
        // smoke run walks zero journeys, so the zero-coverage guard would rewrite
        // this to "unverified". The guard is right about LLM runs and wrong here —
        // coverage came from the baseline, and the bottom line says so out loud.
        await step.do("replay-complete", async () => {
          await env.db.run.update({
            where: { id: runId },
            data: {
              status: "completed",
              verdict: smoke.verdict,
              // CHE-179: a page that did not answer is said, never counted
              // as healthy, and never a reason to spend on a full run.
              // CHE-377: the wording lives in smoke.ts, under verify-smoke-gate.
              bottomLine: quickCheckBottomLine(smoke),
              // Carried from the last full run so the verdict page still describes
              // the app instead of rendering a near-empty shell.
              appLens: smoke.appLens,
              anatomy: smoke.anatomy,
              ...(smoke.screenshotUrl ? { liveScreenshotUrl: smoke.screenshotUrl } : {}),
              costUsd: SMOKE_COST_USD,
              // CHE-327: the work its few-cent price paid for.
              quickPagesOpened: smoke.probes.length,
              currentAction: null,
              completedAt: new Date(),
            },
          });
        });
        // CHE-327: a quick check costs its real, tiny price — priced on the
        // balance like every other check (src/lib/plans.ts priceRun).
        await step.do("price-quick", async () => {
          await priceRun(env.db, runId);
        });

        // CHE-289: measure here too. A smoke run walks nothing, and until now
        // it therefore asked the customer's analytics nothing — which starved
        // the series on exactly the apps that are healthy. "Nothing is broken,
        // AND the journey that makes you money converted worse" is the sentence
        // this project exists for, and "nothing is broken" is the smoke run.
        //
        // Before the notify step below, because a movement is itself a reason
        // to break a change-only watch's silence (CHE-241) and the alert is
        // assembled from points that must already exist.
        await step.do("measure-journeys-smoke", async () => {
          try {
            const summary = await measureRunJourneys(env, runId, { appUrl: env.bindings.APP_URL });
            const note = measurementNote(summary);
            if (note) await appendEvent(env, runId, "replay", { icon: "info", text: note });
          } catch (err) {
            console.warn(`[measure] smoke: ${err instanceof Error ? err.message : String(err)}`);
          }
        });

        // Same notification contract as a full run: a notifyOnChangeOnly watch
        // stays quiet, because the verdict we just carried forward is by
        // definition the baseline's — unless a metric moved (CHE-241).
        if (run.notifyEmail) {
          await step.do("replay-notify", () =>
            notifyAndRecord(env, this.env, runId, run, smoke.verdict),
          );
        }
        // No credential cleanup: a smoke pass only happens on watch runs, and a
        // Watch retains its credentials for the next one.
        return;
      }

      // Loop C: findings the owner marked "watch" on earlier runs of this app are
      // verified FIRST — they become a priority block in the client instructions.
      const watched = await step.do("load-watched-findings", async () => {
        const rows = await env.db.finding.findMany({
          where: { mark: "watch", run: { appSlug: run.appSlug, id: { not: run.id } } },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: { title: true, category: true, severity: true, detail: true, anchor: true, createdAt: true },
        });
        if (rows.length === 0) return [];
        // CHE-109: a watch mark had no way to end. The query asked only "was
        // this ever marked watch", so a mark set on 23 July was still the first
        // priority of every run six weeks later — for an endpoint fixed on 22
        // August and confirmed fixed twice since. Follow-up that outlives the
        // thing it follows stops being follow-up and becomes noise with
        // priority. A signature marked fixed afterwards is finished.
        const settled = await env.db.finding.findMany({
          where: { mark: "fixed", run: { appSlug: run.appSlug } },
          select: { title: true, category: true, severity: true, detail: true, anchor: true, createdAt: true },
        });
        const key = (f: (typeof rows)[number]) => dedupKeyForFinding(f, { appSlug: run.appSlug });
        const done = new Map(settled.map((f) => [key(f), f.createdAt]));
        return rows
          .filter((f) => {
            const fixedAt = done.get(key(f));
            return !fixedAt || fixedAt <= f.createdAt;
          })
          .map((f) => f.title);
      });
      // CHE-109: says what we can prove. The mark records no author and no date
      // — we cannot tell whether the owner set it, or one of our own sessions
      // did while exploring — so "the owner flagged" was a claim about the
      // customer built on our own unaudited bookkeeping, and it reached them as
      // "On your flagged analytics concern" about something they never touched.
      const watchNotes = watched.length
        ? `PRIORITY — these findings were marked for follow-up on an earlier run. ` +
          `Re-check them first. Do NOT describe them to the owner as something they asked ` +
          `for or flagged: say what you found, not who wanted it looked at.\n${watched
            .map((t) => `- ${t}`)
            .join("\n")}`
        : null;
      // Reverse sync (CHE-61): fixes claimed Done in the tracker ride the same
      // priority channel, so the walker chases them specifically.
      const reverifyBlock = reverifyInstructions(reconciled.reverify);
      const expectedExtensionResult = isExtension ? readExtensionOptions(run.extensionConfig).expectedOutcome : null;
      const userNotes = [run.userNotes, expectedExtensionResult ? `Expected extension result: ${expectedExtensionResult}` : null, reverifyBlock, watchNotes].filter(Boolean).join("\n\n") || null;

      // CHE-90: CRUD lifecycle checking is per-app and opt-in. The marker goes
      // into every record the agent creates so cleanup can only touch our own.
      const writeMode = run.appId
        ? ((await env.db.app.findUnique({ where: { id: run.appId }, select: { writeMode: true } }))
            ?.writeMode ?? "read_only")
        : "read_only";
      // CHE-91: creation happens ONLY as the owner's test account. Without one
      // the agent would be creating in shared or anonymous space — someone
      // else's data, not a sandbox we can clean up — so the permission is void
      // however the app is configured. Deterministic, not a prompt promise.
      const hasTestAccount = Boolean(run.testEmail && run.testPasswordEnc);
      const writeAllowed = writeMode === "create_cleanup" && hasTestAccount;
      if (writeMode === "create_cleanup" && !hasTestAccount) {
        await appendEvent(env, runId, "connecting", {
          icon: "warn",
          text:
            "Record creation is enabled for this app but no test account is set — " +
            "checking read-only. Add test credentials so we create only inside that account.",
        });
      }
      const walkRun: WalkRun = {
        id: run.id,
        appSlug: run.appSlug,
        appId: run.appId,
        runNumber: run.runNumber,
        targetUrl: run.targetUrl,
        testEmail: run.testEmail,
        testPasswordEnc: run.testPasswordEnc,
        testAccounts: run.testAccounts,
        storePasswordEnc: run.storePasswordEnc,
        scopeHints: run.scopeHints,
        userNotes,
        focusAreas: run.focusAreas,
        allowedOrigins: run.allowedOrigins,
        writeAllowed,
        testMarker: `CheckMyApp test r${run.runNumber}`,
      };

      await step.do("connecting", async () => {
        await transition(env, runId, "connecting", { icon: "info", text: "Spinning up agent" });
      });

      // CHE-389: a session run takes its turn on the host before it starts.
      await sessionTurn("scan", { phase: "connecting", text: "Waiting to start" });

      // Phase 2 — Surface scan (deterministic).
      const scan = await step.do("surface_scan", extensionStepConfig(isExtension), async () => {
        await transition(env, runId, "surface_scan", { icon: "info", text: `Loading ${run.targetUrl}` });
        const browser = await launchAgentBrowser(env, { run, phase: "scan" }).catch(rethrowBudgetNonRetryable);
        try {
          const extension = extensionBrowserFor(browser);
          if (extension) {
            await env.db.run.update({ where: { id: runId }, data: { extensionEvidence: JSON.stringify({ identity: extension.identity }) } });
            await appendEvent(env, runId, "surface_scan", { icon: "ok", text: `${extension.identity.name} is ready to explore` });
            return { status: null, techSignals: [], internalLinkCount: 0, screenshotUrl: null, door: null, signedOut: null, extensionIdentity: extension.identity };
          }
          // CHE-390: what earlier looks at this app found, so a closed first
          // page is not taken for a closed app.
          const r = await surfaceScan(env, browser, run, knownAddresses(survey));
          if (r.screenshotUrl) {
            await env.db.run.update({ where: { id: runId }, data: { liveScreenshotUrl: r.screenshotUrl } });
          }
          // CHE-389: what loaded was the sign-in page, not the app — its status,
          // stack and links are not the app's, and are not reported as such.
          if (r.signedOut) return { ...r, extensionIdentity: null };
          // …and when it was the app, the sign-in works as of now: written
          // here, at the scan, so it holds whatever becomes of this run. It
          // names the sign-in the next "ended" message is about.
          if (isSession && !r.door) await noteSessionReached(env, run);
          await appendEvent(env, runId, "surface_scan", {
            icon: "ok",
            text: `Loaded homepage (HTTP ${r.status ?? "?"})`,
          });
          if (r.techSignals.length) {
            await appendEvent(env, runId, "surface_scan", {
              icon: "ok",
              text: `Detected ${r.techSignals.join(" + ")}`,
            });
          }
          await appendEvent(env, runId, "surface_scan", {
            icon: "ok",
            text: `Found ${r.internalLinkCount} internal links`,
          });
          return { ...r, extensionIdentity: null };
        } finally {
          await closeAgentBrowser(browser, { env, runId, phase: "scan" }).catch(rethrowBudgetNonRetryable);
        }
      });

      // CHE-389: a check that runs inside a signed-in session met the product's
      // sign-in page instead of the app — the sign-in has ended (signed-out.ts).
      // Mapping and walking a sign-in page would produce a report about it as
      // if it were the app. The run ends here: Not verified, nothing spent,
      // access named as what is missing, and the person who signs in told —
      // once per ended sign-in, however many runs meet it.
      if (scan.signedOut) {
        const host = scan.signedOut;
        await step.do("signed-out", async () => {
          await appendEvent(env, runId, "surface_scan", { icon: "warn", text: SIGNED_OUT_FEED });
          await completeSignedOut(env, { id: runId, targetUrl: run.targetUrl }, host);
        });
        await step.do("price-signed-out", async () => {
          await priceRun(env.db, runId);
        });
        // Its own step, so a retry of anything around it cannot send twice; the
        // send itself is refused a second time by its id. Never fails the run.
        await step.do("tell-signed-out", async () => {
          const told = await tellOwnerSignedOut(env, { id: runId, appId: run.appId, appSlug: run.appSlug }, host);
          console.log(`[session] run ${runId}: sign-in ended (${host}); owner ${told.told}${"detail" in told ? ` — ${told.detail}` : ""}`);
          return told.told;
        });
        if (run.notifyEmail) {
          await step.do("notify-signed-out", () => notifyAndRecord(env, this.env, runId, run, "unverified"));
        }
        await step.do("cleanup-signed-out", async () => {
          if (!run.watchId) {
            await env.db.run.update({ where: { id: runId }, data: clearedCredentials(run) });
          }
        });
        await releaseSessionHost("release-session-signed-out");
        return;
      }

      // CHE-390: the app's own first page turned us away, twice, and showed
      // nothing of the product (closed-door.ts). There is nothing to map or
      // walk and nothing a model could say about it that would be about the
      // product — run #292 mapped, walked and published "Broken" about a door
      // it never got through, and charged for it. The run ends here: Not
      // verified, nothing spent, the gap on our own board. Like the quick-check
      // branch above, not routed through synthesis or the verdict guards — no
      // finding can exist, and the bottom line is the fixed sentence.
      if (scan.door) {
        const door = scan.door;
        await step.do("closed-door", async () => {
          await appendEvent(env, runId, "surface_scan", {
            icon: "warn",
            text: "The first page turned the check away before anything loaded — nothing to check this run",
          });
          await completeClosedDoor(env, { id: runId, targetUrl: run.targetUrl }, door);
        });
        await step.do("price-closed-door", async () => {
          await priceRun(env.db, runId);
        });
        await step.do("capability-gaps-closed-door", async () => {
          try {
            for (const note of await fileCapabilityGaps(env, runId, { extraGaps: [] })) {
              await appendEvent(env, runId, "writing", note);
            }
          } catch (err) {
            console.warn(`[capability] gap filing failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        });
        if (run.notifyEmail) {
          await step.do("notify-closed-door", () => notifyAndRecord(env, this.env, runId, run, "unverified"));
        }
        await step.do("cleanup-closed-door", async () => {
          if (!run.watchId) {
            await env.db.run.update({ where: { id: runId }, data: clearedCredentials(run) });
          }
        });
        await releaseSessionHost("release-session-closed-door");
        return;
      }

      // Phase 3 — Discovery (LLM), or its partial-mode stand-in. A partial run
      // already knows this app's map: re-mapping it would spend Sonnet tokens to
      // rediscover journeys we are about to re-walk by name anyway.
      if (plan.taken) {
        await step.do("reuse-map", async () => {
          await transition(env, runId, "discovery", {
            icon: "info",
            text: `Reusing Run #${plan.baselineRunNumber}'s map — no discovery needed`,
          });
          await appendEvent(env, runId, "discovery", {
            icon: "ok",
            text:
              `Carrying forward ${plan.carry.length} healthy journey` +
              `${plan.carry.length === 1 ? "" : "s"}: ${plan.carry.map((c) => c.title).join(" · ")}`,
          });
        });
      }
      if (!plan.taken) await sessionTurn("discovery", { phase: "discovery", text: "Waiting to continue" });
      const discovery = plan.taken ? null : await step.do("discovery", extensionStepConfig(isExtension), async () => {
        // CHE-133: a watched app was mapped on its last full check; hand that
        // map to discovery so it confirms rather than redraws. Same swallow
        // contract as the other cheap rungs — a failure to load memory costs
        // a from-scratch map, never the run.
        let known: KnownMap | null = null;
        if (discoveryMemoryEnabled(this.env)) {
          try {
            known = await loadKnownMap(env, run);
          } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            console.warn(`[discovery] known map unavailable: ${text}`);
          }
        }
        await transition(env, runId, "discovery", {
          icon: "info",
          text: known ? `Confirming the map from Run #${known.runNumber}` : "Mapping your app",
        });
        const browser = await launchAgentBrowser(env, { run, phase: "discovery", expected: scan.extensionIdentity ?? undefined }).catch(rethrowBudgetNonRetryable);
        try {
          const d = await discoverApp({
            env,
            llm,
            browser,
            run: { ...run, userNotes } as RunInput,
            known: known ?? undefined,
            knowledge,
            // CHE-171: what the survey saw served plus what the last map named.
            publishedUrls: [
              ...surveyedUrls(survey),
              ...pagePaths(known?.anatomy.pages ?? []).map((p) => p.path),
            ],
            onLiveScreenshot: (url) => setLive(env, runId, { liveScreenshotUrl: url }),
            onProgress: (note) => setLive(env, runId, { currentAction: isExtension ? "Exploring extension controls" : note }),
          }).catch(rethrowBudgetNonRetryable);
          // Extraction trouble first, then the outcome — so "No journeys
          // mapped" always arrives with the reason it happened next to it.
          for (const n of d.notes) {
            await appendEvent(env, runId, "discovery", { icon: "warn", text: n });
          }
          await appendEvent(env, runId, "discovery", {
            icon: d.journeys.length ? "ok" : "warn",
            text: d.journeys.length
              ? `Proposed ${d.journeys.length} user journeys`
              : "No journeys mapped",
          });
          await recordUsage(env, runId, "discovery", llm.navModel, d.usage);
          return d;
        } finally {
          await closeAgentBrowser(browser, { env, runId, phase: "discovery" }).catch(rethrowBudgetNonRetryable);
        }
      });

      // Phase 4 — Walking journeys (LLM). ONE Workflow step per journey (CHE-24)
      // so a CPU-limit/retry only re-does that journey, never the whole walk;
      // walkOneJourney is idempotent on (runId, order). A fresh browser per
      // journey keeps each step's session within Browser Rendering limits.
      // A partial run walks its bad journeys under the SAME (runId, order) slots
      // they had in the baseline, with the carried ones filling the rest — so
      // journey order, dedupKeys (CHE-50) and synthesis stepRefs all line up with
      // the picture the owner already knows.
      // CHE-232: on a full run the catalog gets the last slots. Discovery
      // proposes what it sees; the catalog knows what has waited longest, and
      // without this the model picks its five headline flows every run and the
      // long tail of a big app is never walked again. Partial runs already plan
      // from the catalog, and they are one run in five.
      // CHE-232: a journey the product no longer has retires after three full
      // checks that mapped the app and did not find it. Only here, and only on
      // a full run: a smoke pass and a partial run propose nothing, and reading
      // their silence as absence would retire a whole catalog in three quiet
      // days. Best-effort by contract, like every other catalog write.
      if (!plan.taken && run.appId && discovery?.journeys?.length) {
        await step.do("journey-retirement", async () => {
          try {
            const retired = await noteDiscoveryCoverage(env, run.appId as string, discovery.journeys);
            if (retired.length) {
              await appendEvent(env, runId, "discovery", {
                icon: "info",
                text: `No longer part of this app: ${retired.slice(0, 4).join(" · ")}${retired.length > 4 ? ` and ${retired.length - 4} more` : ""}`,
              });
            }
          } catch (err) {
            console.warn(`[journey] retirement pass skipped: ${err instanceof Error ? err.message : String(err)}`);
          }
        });
      }

      // CHE-291: a stored price its own walks cannot support is cleared, whether
      // or not this run walks that journey. Deliberately NOT inside the
      // retirement pass above, which only runs on a full run with discovery: a
      // wrong number on a journey nobody proposes any more is exactly the case
      // that needs repairing, and it would never qualify.
      if (run.appId) {
        await step.do("clear-unsupportable-prices", async () => {
          try {
            const cleared = await clearUnsupportablePrices(env, run.appId as string);
            if (cleared.length) {
              console.warn(`[journey] cleared prices on: ${cleared.join(" · ")}`);
            }
          } catch (err) {
            console.warn(`[journey] price sweep skipped: ${err instanceof Error ? err.message : String(err)}`);
          }
        });
      }

      const fullWalkList = await step.do("walk-queue", async (): Promise<ProposedJourney[]> => {
        const focused = orderByFocus(discovery?.journeys ?? [], run.focusAreas);
        if (!run.appId) return focused;
        try {
          const catalog = await journeysForPlanning(env, run.appId);
          const queue = fullRunQueue({ proposed: focused, catalog, now: new Date() });
          const added = queue.filter((q) => !focused.slice(0, queue.length).some((f) => f.title === q.title));
          if (added.length) {
            console.log(`[rotation] full run: ${added.length} slot(s) to the catalog queue — ${added.map((a) => a.title).join(" · ")}`);
          }
          return queue;
        } catch (err) {
          // A catalog we could not read costs this run its rotation, never the
          // run: the same swallow contract every pre-flight rung here uses.
          console.warn(`[rotation] full-run queue fell back to discovery order: ${err instanceof Error ? err.message : String(err)}`);
          return focused;
        }
      });

      const walkList: Array<{ order: number; proposed: ProposedJourney }> = plan.taken
        ? plan.rewalk.map((r) => ({ order: r.order, proposed: { title: r.title, steps: r.steps } }))
        : // CHE-134: journeys covering the owner's focus areas walk first, so a
          // budget cut (an iteration cap, a run time limit, a retry that gives
          // up) lands on the journeys they did not single out. `order` is
          // assigned after the sort: it is the walk position, 0..n-1.
          fullWalkList.map((proposed, i) => ({ order: i, proposed }));

      await step.do("walking-start", async () => {
        await transition(env, runId, "walking", {
          icon: "info",
          text: plan.taken
            ? `Re-walking ${plan.rewalk.length} journey` +
              `${plan.rewalk.length === 1 ? "" : "s"} that had trouble in Run ` +
              `#${plan.baselineRunNumber}: ` +
              plan.rewalk.map((r) => `"${r.title}" (was ${r.previousStatus})`).join(" · ")
            : `Walking ${walkList.length} discovered journeys`,
        });
      });

      // Copy the healthy journeys across before walking anything: if a re-walk
      // burns its retries, the run still carries the coverage it was promised.
      if (plan.taken) {
        await step.do("carry-journeys", async () => {
          for (const entry of plan.carry) {
            await carryJourney(env, runId, entry, run.runNumber);
          }
        });
      }

      let walkCost = 0;
      for (const { order, proposed } of walkList) {
        // CHE-327: the runaway fuse (RUNAWAY_COST_USD in src/lib/plans.ts).
        // Not fair use — a check this expensive means something of ours is
        // looping, so it stops as our failure: the fail handler below prices
        // it 0 and publishes nothing. Read only from step outputs, so a
        // replayed workflow trips at the same journey.
        assertBelowRunaway(runId, (discovery?.costUsd ?? 0) + walkCost);
        await sessionTurn(`walk-${order}`, { phase: "walking", text: "Waiting to continue" });
        const jcost = await step.do(`walk-${order}`, extensionStepConfig(isExtension), async () => {
          const browser = await launchAgentBrowser(env, { run, phase: `walk-${order}`, expected: scan.extensionIdentity ?? undefined, scenario: proposed.extensionScenario }).catch(rethrowBudgetNonRetryable);
          try {
            const r = await walkOneJourney({
              env,
              llm,
              browser,
              run: walkRun,
              proposed,
              index: order,
              knowledge,
              // CHE-171: the survey's pages; the walk learns the rest itself.
              publishedUrls: surveyedUrls(survey),
              onLiveScreenshot: (url) => setLive(env, runId, { liveScreenshotUrl: url }),
              onProgress: (note) => setLive(env, runId, { currentAction: isExtension ? "Checking extension controls" : note }),
            }).catch(rethrowBudgetNonRetryable);
            const journey = await env.db.journey.findFirst({
              where: { runId, order },
              select: { id: true, appJourneyId: true },
            });
            await recordUsage(env, runId, "walking", llm.navModel, r.usage, journey?.id ?? null);
            // CHE-231: the journey is the unit of work, so it is the unit of
            // spend too. Known only here — the judge's tokens land after the
            // walk returns — and never fatal: a cost we failed to file is a
            // gap in our accounting, not in the customer's check.
            if (journey) {
              await recordJourneyCost(env, {
                journeyId: journey.id,
                appJourneyId: journey.appJourneyId,
                costUsd: r.costUsd,
              }).catch((err) =>
                console.warn(
                  `[journey] cost not filed for journey ${order}: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                ),
              );
            }
            // CHE-169: the judge is its own phase in the ledger, so
            // `npm run cost:trend` can show what the second opinion costs
            // next to what it adjudicated. No row when it was never called.
            if (r.judgeUsage) {
              await recordUsage(
                env,
                runId,
                "judge",
                llm.judgeModel ?? llm.navModel,
                r.judgeUsage,
                journey?.id ?? null,
              );
            }
            // Persist the walking transcript per journey (CHE-58): the run-level
            // transcript only kept discovery, so walking — 90% of the calls and
            // the most useful audit + cost-analysis artifact — was invisible.
            if (r.transcript.length) {
              await putText(
                env,
                isExtension ? `private/runs/${runId}/walk-${order}.json` : `transcripts/${runId}-walk-${order}.json`,
                JSON.stringify(r.transcript, null, 2),
              );
            }
            return r.costUsd;
          } finally {
            await closeAgentBrowser(browser, { env, runId, phase: `walk-${order}` }).catch(rethrowBudgetNonRetryable);
          }
        });
        walkCost += jcost;
      }
      // CHE-389: the last phase that opens the browser is behind us — the host
      // goes back now, not after the verdict is written, so the next run does
      // not wait through minutes of work that needs no browser. The releases
      // at each way out below stay: giving back what is not held is a no-op.
      await releaseSessionHost("release-session-walked");
      assertBelowRunaway(runId, (discovery?.costUsd ?? 0) + walkCost);

      // CHE-331: the app's other known journeys, as of their last real walk.
      // Only a partial run used to carry anything, so a full check or any
      // on-demand check listed the handful it walked and the verdict silently
      // lost the rest (checkmyapp.dev: #247 showed 10, #261 showed 3 of 12
      // live). Planned here, after the walks, because which journeys this run
      // covered is only known once each walk has resolved its identity; the
      // copies themselves are written after the verdict is decided (below), so
      // none of their old evidence enters this run's findings or pill.
      // NOT best-effort, unlike the catalog writes: a read that failed and
      // returned nothing would publish exactly the truncated verdict this
      // exists to prevent. The step retries, and a D1 that stays down fails
      // the run as ours (rule 4) — it could not have written the verdict
      // either.
      const known = await step.do(
        "known-journeys-plan",
        async (): Promise<{ listed: CarriedJourney[]; complete: boolean }> => {
          if (!run.appId || isExtension) return { listed: [], complete: true };
          const planned = await planKnownJourneys(env, {
            runId,
            appId: run.appId,
            startOrder: Math.max(0, ...walkList.map((w) => w.order + 1)),
          });
          // A known journey whose walk is gone was not covered either; it
          // just has nothing to show, and fix verification must know that.
          if (planned.omitted.length) {
            console.warn(`[known-journeys] no walk to show for: ${planned.omitted.join(" · ")}`);
          }
          return { listed: planned.listed, complete: planned.omitted.length === 0 };
        },
      );
      const listed = known.listed;

      // Phase 5 — Anatomy (merge deterministic scan signals into the LLM map).
      // A partial run reuses the baseline's anatomy: nothing re-mapped the app
      // this run, so writing a fresh-looking map would be an invention.
      const anatomy: AppAnatomy = await step.do("anatomy", async () => {
        await transition(env, runId, "anatomy", {
          icon: "info",
          text: plan.taken
            ? `Reusing Run #${plan.baselineRunNumber}'s app anatomy`
            : "Assembling app anatomy",
        });
        const mapped = plan.taken
          ? normalizeAnatomy(parseJson<unknown>(plan.anatomy))
          : normalizeAnatomy(discovery?.anatomy);
        const safe = mapped ?? {
          pages: [],
          actions: [],
          services: [],
          tech: {},
        };
        const tech = { ...safe.tech };
        if (scan.techSignals.length && !tech.frontend) tech.frontend = scan.techSignals.join(" · ");
        // CHE-132: the survey saw every page a sitemap or the homepage links
        // to; discovery names the ones it judged worth a journey. The pages
        // discovery left out are still the customer's product, and the
        // coverage line (CHE-107) can only count what the map mentions — so
        // they go in, in the label shape coverage.ts matches on. Only when
        // discovery ran: a reused map is the baseline's, not this run's.
        const pages = plan.taken ? safe.pages : mergeSurveyedPages(safe.pages, survey);
        const merged: AppAnatomy = { ...safe, pages, tech };
        await env.db.run.update({ where: { id: runId }, data: { anatomy: JSON.stringify(merged) } });
        return merged;
      });

      // Phase 6 — Writing (LLM synthesis + findings + verdict).
      const verdict = await step.do("writing", extensionStepConfig(isExtension), async () => {
        let extensionEvidence: string | null = null;
        if (isExtension) {
          const evidence = await env.db.run.findUnique({ where: { id: runId }, select: { extensionEvidence: true, credentialsRejected: true } });
          extensionEvidence = evidence?.extensionEvidence ?? null;
          const gap = evidence?.credentialsRejected ? "missing_access" : extensionCoverageGap(run, evidence?.extensionEvidence);
          if (gap === "missing_access") return completeExtensionAccessCheck(env, runId, (discovery?.costUsd ?? 0) + walkCost);
          if (gap) throw new NonRetryableError("internal: the extension's core result and cleanup were not established; no verdict may be published", "ExtensionRuntimeError");
        }
        await transition(env, runId, "writing", { icon: "info", text: "Writing your verdict" });
        const structured = extensionEvidence ? await prepareExtensionPublication(env, runId, extensionEvidence) : null;
        const synth = structured ?? await synthesizeVerdict({ env, llm, runId, anatomy, knowledge }).catch(
          async (err: unknown) => {
            // CHE-330: every road refused. The run fails as it always did; the
            // refusals, with where they left from, still reach our board.
            const refusals = refusalsOf(err);
            if (refusals.length) {
              const filed = await fileRouteRefusal(env, runId, { refusals, verdictWritten: false });
              console.warn(`[synthesis] run ${runId}: synthesis failed after refusals; our board: ${filed}`);
              // CHE-329: say on the failure itself that it is on our board, so
              // the run-failure filing does not count it a second time — and
              // only when it truly is: a filing that failed leaves the provider's
              // message as it was, and the run-failure ticket catches it.
              const identifier = routeRefusalFiledAs(filed);
              if (identifier && !(err instanceof LlmBudgetError)) {
                const message = err instanceof Error ? err.message : String(err);
                throw new Error(`${ROUTE_REFUSAL_FILED}${identifier}: ${message}`);
              }
            }
            return rethrowBudgetNonRetryable(err);
          },
        );
        if (!structured) {
          // CHE-330: the ledger names the model that wrote the verdict, so a
          // fallback shows as its own model id on this run (a bottom-line
          // rewrite's few hundred tokens ride on the same row). Each refusal
          // names the road that answered its own call, and goes to our board
          // and the log — not to the run's events, which the customer reads
          // (CLAUDE.md rules 1 and 10).
          const written = "model" in synth ? synth : null;
          await recordUsage(env, runId, "synthesis", written?.model ?? llm.synthModel, synth.usage);
          if (written?.refusals.length) {
            const filed = await fileRouteRefusal(env, runId, { refusals: written.refusals, verdictWritten: true });
            const roads = written.refusals.map((r) => `${r.model}→${r.answeredBy ?? "none"}`).join(", ");
            console.warn(`[synthesis] run ${runId} refused on ${roads}; our board: ${filed}`);
          }
        }
        // CHE-188: a finding whose only evidence is a skipped step is dropped
        // before it becomes a row (run #153 wrote one off a step our own fill
        // could not drive). Same journey/step order synthesis numbered its
        // stepRefs by. Logged, not recorded as a run event: the gate is our
        // machinery, and rule 1 keeps that out of what the customer reads.
        // CHE-215 adds `actions` to the same read: a finding that says one of
        // our interactions produced nothing is checked against the trail of
        // what the browser actually drove (run #159 claimed a fill on a field
        // nothing ever filled).
        const gated = gateFindings(
          synth.findings,
          await env.db.journey.findMany({
            where: { runId },
            select: {
              status: true,
              steps: {
                orderBy: { order: "asc" },
                select: {
                  status: true,
                  unverifiedReason: true,
                  label: true,
                  observed: true,
                  attempted: true,
                  actions: true,
                },
              },
            },
            orderBy: { order: "asc" },
          }),
          // CHE-372: a run that only ever reached a store's password page has
          // no finding to make about the store.
          { targetUrl: run.targetUrl },
        );
        for (const d of gated.dropped) {
          console.log(`[findings] dropped: ${d.finding.title} — ${d.reason}`);
        }
        await persistFindings(env, runId, gated.kept);
        if (gated.kept.length) {
          await appendEvent(env, runId, "writing", {
            icon: "ok",
            text: `Recorded ${gated.kept.length} findings`,
          });
        }

        const checked = await checkVerdictIntegrity(env, runId, synth);
        if (checked.note) {
          await appendEvent(env, runId, "writing", { icon: "warn", text: checked.note });
        }

        const transcript: TranscriptEntry[] = discovery?.transcript ?? [];
        let transcriptUrl: string | null = null;
        if (transcript.length) {
          const rawTranscriptUrl = await putText(
            env,
            isExtension ? `private/runs/${runId}/discovery.json` : `transcripts/${runId}.json`,
            JSON.stringify(transcript, null, 2),
          );
          if (!isExtension) transcriptUrl = rawTranscriptUrl;
        }
        if (structured) {
          transcriptUrl = await putText(env, `transcripts/${runId}.json`, JSON.stringify(structured.audit, null, 2));
        }

        // Coverage before opinion: a partial run's pill covers journeys nobody
        // walked today, so the bottom line says which is which before it says
        // anything else. The re-walk count comes from the rows that landed, so
        // an aborted walk shrinks the claim instead of inflating it. CHE-331:
        // the same holds for any run that lists journeys it did not walk.
        const walkedHere =
          plan.taken || listed.length > 0
            ? await env.db.journey.count({
                where: { runId, carriedFromRunId: null, status: { not: "skipped" } },
              })
            : 0;
        const carriedAware = plan.taken
          ? partialBottomLine(plan, checked.bottomLine, walkedHere, listed)
          : fullBottomLine(walkList.length, checked.bottomLine, walkedHere, listed);

        // CHE-107: discovery writes down what it found; the walk writes down
        // where it went. A page in the first list and not the second is a part
        // of the product this verdict does not cover, and until now nothing
        // said so — run #128 knew about seven pages, built four journeys, and
        // the difference was visible only in the database.
        const bottomLine = await (async () => {
          if (structured) return carriedAware;
          const pages = (anatomy.pages ?? []).filter(Boolean);
          if (pages.length === 0) return carriedAware;
          const steps = await env.db.step.findMany({
            where: { journey: { runId } },
            select: { networkLog: true, observed: true },
          });
          const note = coverageSentence(
            unreachedPages(pages, steps.flatMap((s) => [s.networkLog ?? "", s.observed ?? ""])),
            pages.length,
          );
          return note ? [carriedAware, note].filter(Boolean).join(" ") : carriedAware;
        })();

        const costUsd = (discovery?.costUsd ?? 0) + walkCost + synth.costUsd;
        await env.db.run.update({
          where: { id: runId },
          data: {
            // CHE-331: a run with journeys still to list stays in "writing"
            // until they land (the step below). A terminal status is what
            // every poller — wait_for_run, the live page, CI — reads as "the
            // verdict is whole", and one that fired before the copies would
            // hand them the 3 walked journeys of 12 for good.
            ...(listed.length > 0
              ? {}
              : { status: structured?.partial ? "partial" : "completed", completedAt: new Date() }),
            verdict: checked.verdict,
            bottomLine,
            appLens: JSON.stringify(synth.appLens),
            transcriptUrl,
            costUsd,
            currentAction: null,
          },
        });
        return checked.verdict;
      });

      // CHE-331: the known journeys this run did not walk go onto its verdict
      // now that the verdict has been decided without them. Each copy keeps the
      // run and the date of the walk it came from, and the bottom line above
      // already counts them. Not swallowed: carryJourney clears its slot
      // before writing, so a retry of this step replaces a half-written copy
      // rather than leaving the bottom line counting one that is not there —
      // and a D1 that cannot write them could not have written the verdict.
      if (listed.length > 0) {
        await step.do("list-known-journeys", async () => {
          for (const entry of listed) {
            await carryJourney(env, runId, entry, run.runNumber);
          }
          await appendEvent(env, runId, "writing", {
            icon: "info",
            text:
              `Also listed as of their last check: ${listed.length} journey` +
              `${listed.length === 1 ? "" : "s"} not walked this run — ` +
              listed
                .slice(0, 6)
                .map((l) => `${l.title} (Run #${l.sourceRunNumber})`)
                .join(" · ") +
              (listed.length > 6 ? ` and ${listed.length - 6} more` : ""),
          });
          // Last, so nothing reads the run as finished before its list is.
          await env.db.run.update({
            where: { id: runId },
            data: { status: "completed", completedAt: new Date() },
          });
        });
      }

      // CHE-327: the check is done — price it on the team's balance. Its own
      // step, after the verdict is written, so a retry of pricing never
      // re-writes the verdict and a retry of writing never prices twice.
      await step.do("price", async () => {
        await priceRun(env.db, runId);
      });

      // Auto-file tracker tickets (CHE-50). Watch runs only, and only when the
      // owner connected a tracker — autoFileFindings decides both. Non-fatal by
      // construction: a tracker outage leaves warn events on a completed run.
      if (run.watchId) {
        await step.do("autofile", async () => {
          try {
            for (const note of await autoFileFindings(env, runId)) {
              await appendEvent(env, runId, "writing", note);
            }
          } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            console.warn(`[autofile] ticket filing failed: ${text}`);
            await appendEvent(env, runId, "writing", {
              icon: "warn",
              text: `Couldn't file tracker tickets: ${text}`,
            });
          }
        });
      }

      // CHE-90 — cleanup audit. Anything this run created inside the customer's
      // product must be gone by now. Whatever is left is reported to the owner
      // (with where to find it) AND filed as our own defect: leaving junk in
      // someone's product is never an acceptable outcome. Older orphans from
      // crashed runs of the same app are swept in here too.
      await step.do("cleanup-audit", async () => {
        try {
          for (const note of await auditCreatedResources(env, runId)) {
            await appendEvent(env, runId, "writing", note);
          }
        } catch (err) {
          console.warn(`[cleanup] audit failed: ${err instanceof Error ? err.message : err}`);
        }
      });

      // CHE-83 — hold OURSELVES to the same loop. Any step this run could not
      // verify because of our checker (not because of the customer's product)
      // becomes a high-priority ticket on our own board. Runs for every run,
      // watch or not: a capability gap is a defect wherever it shows up. Never
      // fails the run, exactly like autofile.
      await step.do("capability-gaps", async () => {
        try {
          // CHE-232: journeys the rotation could neither walk tonight nor carry,
          // because the catalog has outgrown what one run can keep inside the
          // carry window. The owner is paying for an app to be checked and part
          // of it was not — that is ours to fix, not theirs to live with.
          //
          // But only when we know how many journeys the app really has. A
          // catalog that still holds one journey under several titles (CHE-247:
          // checkmyapp.dev carries "Start a check" as twelve rows) is not a big
          // app we cannot cover — it is a list we have not deduplicated, and a
          // ticket saying "cannot keep every journey checked" would send the
          // next reader to raise the budget instead of fixing identity. Rule 8:
          // a claim we cannot separate from our own defect is not a finding.
          const deferred = plan.taken ? (plan.deferred ?? []) : [];
          const countable = deferred.length > 0 && run.appId ? await catalogIsDeduplicated(env, run.appId) : false;
          if (deferred.length > 0 && !countable) {
            console.log(
              `[partial] ${deferred.length} deferred journey(s) not filed as a gap — ` +
                `the catalog still holds duplicate titles (CHE-247)`,
            );
          }
          const extraGaps = countable
            ? [
                {
                  label: GAP_CLASSES.journey_rotation.label,
                  attempted: "Check every journey this app has, inside the window a check stays good for",
                  observed: `Not reached this run: ${deferred.slice(0, 8).join(" · ")}`,
                  gapClass: "journey_rotation" as const,
                },
              ]
            : [];
          for (const note of await fileCapabilityGaps(env, runId, { extraGaps })) {
            await appendEvent(env, runId, "writing", note);
          }
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          console.warn(`[capability] gap filing failed: ${text}`);
        }
      });

      // CHE-239: what the customer's own analytics say happened on the journeys
      // we just walked. One point per journey per run, so the series can later
      // answer "conversion fell from 31% to 12%" rather than only "it is 12%".
      //
      // After the walk and after gap filing, and wrapped in its own step: this
      // is a read of someone else's system, and a failure in it must cost the
      // measurement and nothing else. measureRunJourneys never throws; the
      // try/catch is the second belt.
      await step.do("measure-journeys", async () => {
        try {
          const summary = await measureRunJourneys(env, runId, { appUrl: env.bindings.APP_URL });
          const note = measurementNote(summary);
          if (note) await appendEvent(env, runId, "writing", { icon: "info", text: note });
        } catch (err) {
          console.warn(`[measure] skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

      // Reverse sync, closing half (CHE-61): after autofile, so a reappeared
      // signature has already been refiled (flipping its link back to "open")
      // and can never be mistaken for a verified fix. Links still "fixed" whose
      // signature stayed away — in a walk that actually covered their journey —
      // get the "verified fixed in prod" comment and status "resolved".
      // CHE-331: not when the known-journeys list is incomplete — a known
      // journey's walk is gone. verifyFixedLinks treats a
      // run with no carried rows as a walk of the whole app, and such a run may
      // carry none only because we could not show what it missed — a fix is
      // confirmed by a walk of its journey, never by our own blind spot.
      if (run.watchId && !known.complete) {
        console.warn("[reconcile] fix verification skipped — this run's known-journeys list is incomplete");
      }
      if (run.watchId && known.complete) {
        await step.do("reconcile-verify", async () => {
          try {
            for (const note of await verifyFixedLinks(env, runId)) {
              await appendEvent(env, runId, "writing", note);
            }
          } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            console.warn(`[reconcile] fix verification failed: ${text}`);
            await appendEvent(env, runId, "writing", {
              icon: "warn",
              text: `Couldn't verify fixed tickets: ${text}`,
            });
          }
        });
      }

      // Outbound integrations (CHE-53): generic webhook + Slack preset. Watch
      // runs only, and they fire on EVERY completed run — no notifyOnChangeOnly
      // here, because a monitoring feed that skips quiet runs can't be told
      // apart from one that died (consumers filter on `changed` themselves).
      // Non-fatal like autofile: delivery failures leave warn events, never throw.
      if (run.watchId && run.appId) {
        await step.do("notify-integrations", async () => {
          try {
            for (const note of await notifyIntegrations(env, runId, verdict)) {
              await appendEvent(env, runId, "writing", note);
            }
          } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            console.warn(`[notify-integrations] dispatch failed: ${text}`);
            await appendEvent(env, runId, "writing", {
              icon: "warn",
              text: `Couldn't deliver webhooks: ${text}`,
            });
          }
        });
      }

      // Verdict-ready email (CHE: the home-page form promises it). Non-fatal: a
      // notification failure must never fail a completed run. Watch runs arrive
      // here too — the scheduler copies notifyEmail onto the run — but a
      // notifyOnChangeOnly watch stays quiet while the verdict holds steady.
      if (run.notifyEmail) {
        await step.do("notify", () => notifyAndRecord(env, this.env, runId, run, verdict));
      }

      // CHE-129 spike — redo each walked journey's recorded actions with no
      // model in the loop and write down how far a browser got on its own. This
      // is our measurement of whether walking can stop re-discovering
      // yesterday's path; it is not news about the customer's product, so it
      // appends no events and touches nothing the verdict, the findings, the
      // cost ledger or the email read. It sits HERE, not after walking, because
      // the owner's rule is that no optimisation may move the verdict time: by
      // now the run is completed and the email is out, so up to three minutes
      // per journey costs the customer nothing — and it sits BEFORE cleanup
      // because that step clears the test password on one-off runs, and a
      // sign-in replay needs it. Only journeys walked THIS run are measured: a
      // carried journey has nothing new to reproduce. Every failure ends up in
      // replayStatus, never in the run.
      for (const { order } of isExtension || isSession ? [] : walkList) {
        await step.do(`replay-audit-${order}`, async () => {
          try {
            await auditJourneyReplay(env, walkRun, order);
          } catch (err) {
            console.warn(
              `[replay-audit] journey ${order}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        });
      }

      // Privacy: clear test credentials after a terminal completion, unless a
      // Watch retains them for recurring runs. CHE-322: every named account's
      // password with the default's — one function for both paths.
      await step.do("cleanup", async () => {
        if (!run.watchId) {
          await env.db.run.update({ where: { id: runId }, data: clearedCredentials(run) });
        }
      });
      await releaseSessionHost("release-session");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // CHE-76: our own LLM budget dying is an internal outage, not a fact
      // about the customer's app. Mark the run failed with an internal
      // reason (no verdict/findings/email were published — the throw
      // happened before synthesis) and retry the watch soon.
      const budget =
        err instanceof LlmBudgetError ||
        (err instanceof Error &&
          (err.name === "LlmBudgetError" || /available credits|payment_required/i.test(msg)));
      // Returns the phase the run died in (Run.status until this write), for
      // the ticket below.
      const ended = await step.do("fail", async (): Promise<{ phase: string | null; afterVerdict: boolean }> => {
        const before = await env.db.run.findUnique({ where: { id: runId }, select: { status: true } });
        // Privacy, same rule as the "cleanup" step: a one-off run keeps the
        // test password only while it runs. That step sits on the success
        // path, so a run that failed kept the encrypted password forever —
        // while the home form promises "deleted after the run" and
        // /guides/login-and-test-accounts says it goes when the check
        // finishes. A watch run keeps it for the next tick.
        const cleared = run.watchId ? {} : clearedCredentials(run);
        // CHE-329 (Codex on #204): the verdict was already written — a later
        // step (price, cleanup) threw after the webhook, Slack or the email may
        // have gone out. Flipping the run to failed now would hide a verdict
        // the customer was already told about and zero the price of a check
        // that did its job. The run stays finished; the throw is ours, kept on
        // the row and filed on our board below. Credentials are still cleared:
        // the step that clears them may be the one that threw.
        if (before?.status === "completed" || before?.status === "partial") {
          await env.db.run.update({
            where: { id: runId },
            data: {
              ...cleared,
              errorMessage: `internal: after the verdict was written: ${msg}`.slice(0, 500),
            },
          });
          await priceRun(env.db, runId).catch((e) =>
            console.warn(`[balance] pricing finished run ${runId} did not happen: ${e instanceof Error ? e.message : String(e)}`),
          );
          return { phase: `${before.status}, after the verdict was written`, afterVerdict: true };
        }
        await env.db.run.update({
          where: { id: runId },
          data: {
            status: "failed",
            ...cleared,
            errorMessage: budget
              ? `internal: LLM budget exhausted — nothing was published. ${msg}`.slice(0, 500)
              : msg,
          },
        });
        // CHE-327: a failed run costs the customer nothing (rule 4: our
        // failures never reach them — their balance included). Priced 0 if it
        // never was; if a later step threw after it was priced, the price is
        // voided and any bought balance it took goes back. Never fatal: a
        // pricing hiccup must not mask the failure being recorded.
        await priceRun(env.db, runId)
          .then(() => voidRunPrice(env.db, runId))
          .catch((e) =>
            console.warn(`[balance] zeroing failed run ${runId} did not happen: ${e instanceof Error ? e.message : String(e)}`),
          );
        if (isExtension && !budget) {
          try {
            for (const note of await fileCapabilityGaps(env, runId, { extraGaps: [{
              label: "Extension check did not complete",
              attempted: "Check the installed extension through its native controls and owned target tab",
              observed: msg.slice(0, 500),
              gapClass: /cleanup|Stop|billing/i.test(msg) ? "extension_session_cleanup" : "extension_runtime",
            }] })) console.warn(`[extension-gap] ${note.text}`);
          } catch (error) { console.warn(`[extension-gap] filing failed: ${String(error)}`); }
        }
        if (budget) {
          console.error(`[budget] run ${runId} aborted: LLM provider refused for credit state`);
          // CHE-329: the feed is public (the live page, get_check_status's
          // recent_events) — it says what happened to the check, not which of
          // our providers did it. The retry is promised only where it exists.
          await appendEvent(env, runId, "connecting", {
            icon: "warn",
            text:
              "This check stopped on our side before it finished — nothing was published." +
              (run.watchId ? " The watch tries again in about two hours." : ""),
          });
          if (run.watchId) {
            await env.db.watch
              .update({
                where: { id: run.watchId },
                data: { nextRunAt: new Date(Date.now() + 2 * 60 * 60 * 1000) },
              })
              .catch(() => {});
          }
        }
        return { phase: before?.status ?? null, afterVerdict: false };
      });
      // CHE-329: on our own board within the same minute, not discovered by
      // the owner a day later on the customer's page. Its own step, so a
      // retried "fail" cannot count one failure twice; never throws.
      await step.do("file-failure", async () => {
        const note = await fileRunFailure(env, runId, { message: msg, budget, ...ended });
        if (note) console.log(`[run-failure] ${note.text}`);
        return note?.text ?? null;
      });
      await releaseSessionHost("release-session-failed");
      throw err;
    }
  }
}

// ─── Replay audit (CHE-129 spike) ────────────────────────────────────────────
// Loads what the walk recorded for one journey, replays it, and stores the
// outcome on the journey. Never throws past its own catch: a Browser Rendering
// hiccup, a bad column, a D1 timeout — all of it becomes replayStatus
// "errored" with the message in the note. A journey with nothing executable
// is written "no_actions" without launching a browser.

async function auditJourneyReplay(env: AgentEnv, run: WalkRun, order: number): Promise<void> {
  const journey = await env.db.journey.findFirst({
    where: { runId: run.id, order, carriedFromRunId: null },
    select: {
      id: true,
      title: true,
      steps: { orderBy: { order: "asc" }, select: { order: true, label: true, actions: true } },
    },
  });
  if (!journey) return;

  const write = (r: Pick<ReplayResult, "status" | "note">) =>
    env.db.journey.update({
      where: { id: journey.id },
      data: { replayStatus: r.status, replayNote: r.note.slice(0, 500) },
    });

  if (!journey.steps.some((s) => parseActions(s.actions).length > 0)) {
    const n = journey.steps.length;
    await write({
      status: "no_actions",
      note: `no recorded actions on any of ${n} step${n === 1 ? "" : "s"}`,
    });
    return;
  }

  let result: Pick<ReplayResult, "status" | "note">;
  try {
    const browser = await launchAgentBrowser(env);
    try {
      // CHE-193: the replay context announces itself on our own hosts too.
      result = await replayJourney(env, browser, run, journey, (b) =>
        newAgentContext(b, run.targetUrl, env.bindings),
      );
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (err) {
    result = {
      status: "errored",
      note: `replay errored: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  await write(result);
  console.log(`[replay-audit] journey ${order} "${journey.title}": ${result.status} — ${result.note}`);
}

// ─── Mode-ladder event trail (CHE-51 + CHE-57) ───────────────────────────────
// The feed is the only place an owner can see why a day cost $0.01 instead of
// $0.53 — or why the cheap modes handed over to a full run anyway. Every rung
// says what it saw, in the same voice as the rest of the run, and the mode the
// run actually took is always stated out loud.

function modeEvents(
  smoke: { taken: false; reason: string } | SmokeReport,
  plan: PartialDecision,
  targetUrl: string,
): Array<Omit<RunEvent, "at" | "phase">> {
  const events: Array<Omit<RunEvent, "at" | "phase">> = [];

  if (smoke.taken) {
    const pages = smoke.probes.map((p) => shortLabel(p.url, targetUrl)).join(" · ");
    events.push({
      icon: "info",
      text:
        `Smoke check: re-visiting ${smoke.probes.length} known pages — ${pages}` +
        (smoke.skipped > 0
          ? ` (${smoke.skipped} more known page${smoke.skipped === 1 ? "" : "s"} left for the next check)`
          : ""),
    });
    // Wording lives in smoke.ts (CHE-179) so verify-smoke-gate reads the same
    // sentence the owner does: healthy pages, pages that did not answer, and
    // the verdict carried forward.
    events.push({ icon: smoke.ok ? "ok" : "warn", text: smokeOutcomeLine(smoke, targetUrl) });
    // CHE-213: on a green pass, any console burst the survey's answer let us
    // set aside is said out loud. A red pass already names what went wrong,
    // and adding "these other pages were fine" to it would only blur that.
    const aside = smoke.ok ? consoleSetAsideLine(smoke.consoleBurstsSetAside, targetUrl) : null;
    if (aside) events.push({ icon: "info", text: aside });
  } else {
    events.push({ icon: "info", text: `No smoke check — ${smoke.reason}` });
  }

  if (plan.taken) {
    events.push({
      icon: "info",
      text:
        `Partial run: re-walking ${plan.rewalk.length} of ` +
        `${plan.rewalk.length + plan.carry.length} journeys ` +
        `(${plan.carry.length} carried from #${plan.baselineRunNumber})`,
    });
    // CHE-232 + rule 2: coverage stated plainly, in the owner's terms — which
    // journeys of their app this check did not reach. The ticket on our board
    // is the rest of the answer; this line is the honest minimum while it exists.
    const deferred = plan.deferred ?? [];
    if (deferred.length > 0) {
      events.push({
        icon: "warn",
        text: `Not checked this time: ${deferred.slice(0, 5).join(" · ")}${deferred.length > 5 ? ` and ${deferred.length - 5} more` : ""}`,
      });
    }
  } else if (!smoke.taken) {
    // When the smoke check ran and went red it already said "running the full
    // check"; repeating the partial mode's reason there would just be noise.
    events.push({ icon: "info", text: `Running the full check — ${plan.reason}` });
  }
  return events;
}

// ─── Verdict-ready notification ──────────────────────────────────────────────
// notifyVerdictReady, its silence gate and the watch-notice rule live in
// ./notify-verdict.ts (CHE-156) — that file has no `cloudflare:workers` import,
// so scripts/verify-self-check-silence.ts can drive the real function.
//
// CHE-224: the ONE path a verdict email may be attempted on. Every send now
// leaves three traces — the outcome on the run row (queryable), the step's own
// output in the Workflow instance history, and, when it failed, a line in the
// feed plus a ticket on our own board. The bug this closes is not that a send
// failed; it is that thirty of them failed and nothing anywhere said so.
async function notifyAndRecord(
  env: AgentEnv,
  bindings: AgentBindings,
  runId: string,
  run: NotifiableRun,
  verdict: Verdict | null,
): Promise<string> {
  const outcome = await notifyVerdictReady(env, bindings, run, verdict);
  // Bookkeeping never fails a finished run — but it is loud when it cannot do
  // its job, which is the whole point of this ticket.
  try {
    await recordNotifyOutcome(env, run.publicId, outcome);
  } catch (err) {
    console.error(
      `[notify] could not record the outcome for run ${run.publicId}: ` +
        `${err instanceof Error ? err.message : err}`,
    );
  }
  if (outcome.kind === "failed") {
    try {
      // The customer's line says the fact and nothing about our plumbing
      // (CLAUDE.md rule 1); the provider's own words live on the run row and on
      // the ticket, where the next person to look needs them.
      await appendEvent(env, runId, "writing", {
        icon: "warn",
        text: `We couldn't deliver this verdict to ${run.notifyEmail}. That's on us — it's on our board.`,
      });
      await appendEvent(
        env,
        runId,
        "writing",
        await fileDeliveryGap(env, runId, {
          address: run.notifyEmail ?? "(no address)",
          error: outcome.error,
        }),
      );
    } catch (err) {
      console.error(
        `[notify] could not report the delivery failure for run ${run.publicId}: ` +
          `${err instanceof Error ? err.message : err}`,
      );
    }
  }
  // Returned so the Workflow step stores it: `wrangler workflows instances
  // describe` then shows what happened to the mail beside every other step.
  return notifyOutcomeCode(outcome);
}

// ─── Verdict integrity (CHE-42, CHE-365) ─────────────────────────────────────
// The rules live in ./verdict-integrity.ts; what they read is loaded by
// checkVerdictIntegrity in ./verdict-load.ts, which a verify script can drive
// over a stub database (this module cannot be loaded on plain Node).

// CHE-171: the addresses the survey (CHE-132) reached — both the path it was
// sent to (a sitemap entry, a homepage link: published by the product) and the
// URL it ended on. Status is not a filter here: a sitemap entry that 404s is
// still a page the product points users at, and a 404 there IS a defect.
function surveyedUrls(survey: SurveyOutcome | null | undefined): string[] {
  const pages = survey?.snapshot?.pages ?? [];
  return pages.flatMap((p) => [p.url, p.path]);
}

// CHE-390: every address an earlier or the current survey of this app holds —
// what the surface scan tries before it calls a closed first page a closed app.
function knownAddresses(survey: SurveyOutcome | null | undefined): string[] {
  return [...(survey?.previous?.pages ?? []), ...(survey?.snapshot?.pages ?? [])].map((p) => p.url);
}

// ─── Outbound integrations (CHE-53) ──────────────────────────────────────────
// Build one run.completed payload and deliver it to whichever endpoints the
// app has configured: generic webhook (HMAC-signed if a secret is set) and/or
// the Slack preset. Both deliveries are best-effort and report run events.

// Worst first, so the payload's 10-finding cap keeps breakage over polish.
const FINDING_SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

async function notifyIntegrations(
  env: AgentEnv,
  runId: string,
  verdict: Verdict,
): Promise<{ icon: "ok" | "warn"; text: string }[]> {
  const run = await env.db.run.findUnique({
    where: { id: runId },
    select: {
      appId: true,
      appSlug: true,
      runNumber: true,
      publicId: true,
      bottomLine: true,
      baselineRunId: true,
      completedAt: true,
      deploySha: true,
      deployEnv: true,
    },
  });
  if (!run?.appId) return [];

  const app = await env.db.app.findUnique({
    where: { id: run.appId },
    select: { webhookUrl: true, slackWebhookUrl: true, webhookSecretEnc: true },
  });
  if (!app || (!app.webhookUrl && !app.slackWebhookUrl)) return [];

  const baseline = run.baselineRunId
    ? await env.db.run.findUnique({
        where: { id: run.baselineRunId },
        select: { verdict: true },
      })
    : null;
  const previousVerdict = baseline?.verdict ?? null;

  const findings = await env.db.finding.findMany({
    where: { runId },
    select: { title: true, category: true, severity: true },
    orderBy: { number: "asc" },
  });
  const top = findings
    .sort(
      (a, b) => (FINDING_SEVERITY_RANK[a.severity] ?? 3) - (FINDING_SEVERITY_RANK[b.severity] ?? 3),
    )
    .slice(0, 10);

  const baseUrl = env.bindings.APP_URL ?? "https://checkmyapp.dev";
  const payload: RunCompletedPayload = {
    event: "run.completed",
    app: run.appSlug,
    runNumber: run.runNumber,
    verdict,
    deploy: run.deploySha ? { sha: run.deploySha, env: run.deployEnv } : null,
    previousVerdict,
    changed: previousVerdict !== verdict,
    bottomLine: run.bottomLine,
    findings: top,
    verdictUrl: `${baseUrl}/verdict/${run.publicId}`,
    completedAt: (run.completedAt ?? new Date()).toISOString(),
  };

  const notes: { icon: "ok" | "warn"; text: string }[] = [];
  if (app.webhookUrl) {
    const secret = app.webhookSecretEnc ? decryptSecret(app.webhookSecretEnc) : null;
    const r = await deliverWebhook(app.webhookUrl, payload, secret);
    notes.push(
      r.ok
        ? { icon: "ok", text: `Webhook delivered (${r.status})` }
        : {
            icon: "warn",
            text: `Webhook delivery failed${r.status ? ` (HTTP ${r.status})` : `: ${r.error}`}`,
          },
    );
  }
  if (app.slackWebhookUrl) {
    const r = await deliverSlack(app.slackWebhookUrl, payload);
    notes.push(
      r.ok
        ? { icon: "ok", text: "Slack notification delivered" }
        : {
            icon: "warn",
            text: `Slack delivery failed${r.status ? ` (HTTP ${r.status})` : `: ${r.error}`}`,
          },
    );
  }
  return notes;
}

// ─── LLM usage ledger ────────────────────────────────────────────────────────
// One row per unit of work (phase, or journey within walking). Idempotent per
// (runId, phase, journeyId) so Workflow step retries replace, not duplicate.

async function recordUsage(
  env: AgentEnv,
  runId: string,
  phase: string,
  model: string,
  usage: UsageTotals,
  journeyId?: string | null,
) {
  await env.db.llmUsage.deleteMany({
    where: { runId, phase, journeyId: journeyId ?? null },
  });
  await env.db.llmUsage.create({
    data: { runId, phase, journeyId: journeyId ?? null, model, ...usage },
  });
}

// ─── findings persistence (port of pipeline.persistFindings) ─────────────────

async function persistFindings(env: AgentEnv, runId: string, findings: SynthesizedFinding[]) {
  if (!findings.length) return;
  const run = await env.db.run.findUnique({
    where: { id: runId },
    select: { appSlug: true },
  });
  const journeys = await env.db.journey.findMany({
    where: { runId },
    include: { steps: { orderBy: { order: "asc" }, include: { evidence: true } } },
    orderBy: { order: "asc" },
  });

  // Marks the owner set on earlier runs' findings (CHE-78: "That's fine" must
  // survive into the next run). Keyed by the CHE-59 dedup signature, so the
  // match tolerates prose drift; latest mark per signature wins. "watch" rides
  // its own priority channel and "none" carries nothing.
  const inheritedMarks = new Map<string, string>();
  if (run) {
    const marked = await env.db.finding.findMany({
      where: {
        mark: { in: ["known", "false_positive"] },
        run: { appSlug: run.appSlug, id: { not: runId } },
      },
      orderBy: { createdAt: "asc" },
      select: { title: true, category: true, severity: true, detail: true, anchor: true, mark: true },
    });
    for (const m of marked) {
      inheritedMarks.set(dedupKeyForFinding(m, { appSlug: run.appSlug }), m.mark);
    }
  }

  // CHE-215: the same walked steps the gate judged against, so the anchor
  // written on the row says what the row was allowed to rest on.
  const trailPresent = drivenControls(
    journeys.flatMap((j) => j.steps).filter((s) => s.status !== "skipped"),
  ).recorded;

  let number = 1;
  for (const f of findings) {
    const step = f.stepRef ? journeys[f.stepRef.journeyIndex]?.steps[f.stepRef.stepIndex] : undefined;
    const shot = step?.evidence.find((e) => e.type === "screenshot");
    const shaped = {
      title: f.title.slice(0, 300),
      category: f.category,
      severity: f.severity,
      detail: JSON.stringify(f.detail),
    };
    const anchor = JSON.stringify({
      ...(f.errorSignature ? { errorSignature: f.errorSignature } : {}),
      stepRef: step ? f.stepRef : null,
      hands: claimedHands(f),
      trail: trailPresent ? "present" : "absent",
    });
    const mark = run ? inheritedMarks.get(dedupKeyForFinding({ ...shaped, anchor }, { appSlug: run.appSlug })) : undefined;
    await env.db.finding.create({
      data: {
        runId,
        number: number++,
        ...shaped,
        anchor,
        // CHE-354: the identity recurrence is counted by (src/lib/recurring.ts).
        signature: run ? findingSignature({ appSlug: run.appSlug, ...shaped, anchor }) : null,
        ...(mark ? { mark } : {}),
        evidence: shot
          ? { create: [{ type: "screenshot", storageUrl: shot.storageUrl, sha256: shot.sha256 }] }
          : undefined,
      },
    });
  }
}

// ─── D1 event helpers (single-instance serial — no transaction needed) ───────

async function setLive(
  env: AgentEnv,
  runId: string,
  data: { currentAction?: string; liveScreenshotUrl?: string },
) {
  await env.db.run.update({ where: { id: runId }, data });
}

async function transition(
  env: AgentEnv,
  runId: string,
  phase: RunPhase,
  event: Omit<RunEvent, "at" | "phase">,
) {
  const events = await readEvents(env, runId);
  events.push({ at: new Date().toISOString(), phase, ...event });
  await env.db.run.update({ where: { id: runId }, data: { status: phase, events: JSON.stringify(events) } });
}

async function appendEvent(
  env: AgentEnv,
  runId: string,
  phase: RunPhase,
  event: Omit<RunEvent, "at" | "phase">,
) {
  const events = await readEvents(env, runId);
  events.push({ at: new Date().toISOString(), phase, ...event });
  await env.db.run.update({ where: { id: runId }, data: { events: JSON.stringify(events) } });
}

async function readEvents(env: AgentEnv, runId: string): Promise<RunEvent[]> {
  const r = await env.db.run.findUnique({ where: { id: runId }, select: { events: true } });
  if (!r?.events) return [];
  try {
    return JSON.parse(r.events) as RunEvent[];
  } catch {
    return [];
  }
}
