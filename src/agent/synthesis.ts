// Phase 6 — Synthesis (CF agent). Turns the observed run into the App Lens
// (PM-voice) + categorized findings + a one-sentence bottom line. Runs on the
// synthesis model (Opus 4.8) — one shot, quality over cost (CHE-16).

import type { AppLens, AppAnatomy } from "@/lib/types";
import type { Verdict, StepStatus } from "@/lib/enums";
import type Anthropic from "@anthropic-ai/sdk";
import {
  addUsage,
  costOf,
  createOnRoutes,
  emptyUsage,
  mergeUsage,
  refusalsOf,
  synthRoutes,
  type LlmConfig,
  type RouteRefusal,
  type UsageTotals,
} from "./llm";
import { finalizeStructured } from "./core";
import { harnessMode, type AgentEnv } from "./env";
import type { ProposedJourney } from "./discovery";
import { cutUndrivenClaims } from "./findings-gate";
import { knowledgeBlock } from "./instructions";
import type { AppKnowledge } from "./knowledge";
import { DEFAULT_ACCOUNT_LABEL, describeAccounts, parseRunAccounts, rejectedAccountLabels } from "@/lib/test-accounts";
import {
  CUSTOMER_LANGUAGE_RULES,
  cutSelfCheckRefusalClaims,
  hasEnvironmentLeak,
  hasHomework,
  isSelfCheckRefusalStep,
  type RefusalContextStep,
  stripEnvironmentLeak,
  stripHomework,
} from "@/lib/verdict-language";

const APP_LENS_RULES = `You just observed a web app for a while. Produce two things.

1. An "App Lens": (1) what this app does in one sentence, (2) who it's for,
(3) core value, (4) business model, (5) tech surface, (6) critical paths to
protect, plus a bottom-line verdict on its current state.
Write it like a product manager describing the product, not like a QA report.
Use language the founder would use themselves.

The bottomLine renders directly under the verdict pill as its explanation, so
it must read as the REASON for the verdict: 1-2 sentences, leading with the
problem (or, when everything passed, the all-clear). Never open with an
inventory of what works — "X, Y and Z all work cleanly; but..." buries the
answer the reader came for. Say the problem first, then at most one clause on
what's healthy.

If the observation carries "ownerConcerns", the owner told us what they are
most worried about. The bottomLine MUST address each concern explicitly —
"your YouTube links: all N we checked play" or "we could not verify X this
run" — before anything else you want to say.

2. "Findings": 0-12 concrete, actionable findings from the walked journeys.
Categories: broken (does not work) / risky (works but fragile or abusable) /
confusing (user would hesitate) / polish (cosmetic) / exposed (security).
Severity: high / medium / low. Every finding must trace back to something
actually observed in the steps — no speculation. Where possible reference the
step it came from via stepRef (journeyIndex and stepIndex are 0-based).

A finding is a PROBLEM the founder can act on — something broken, fragile,
confusing, ugly, or exposed. NEVER file "X works end-to-end" or "the flagship
feature produced good output" as a finding: positive confirmations belong in
the journey summaries and the bottomLine, not in the findings list, whatever
category you'd put them under. A clean run has FEW or ZERO findings — do not
pad the list to reach a count. Each finding's "why this matters" must contain
a recommendation the owner could act on; if you cannot phrase one, it is not
a finding.

If the journeys array is empty, or a step was skipped, nothing was verified for
it: do NOT claim it fails. When coverage is incomplete, say so in bottomLine
("we couldn't verify X this run") instead of inventing failures. A journey with
status "partial" means everything attempted worked and only some steps went
unverified — treat it as working, with a coverage caveat, never as a failure.

If any step was skipped because no test credentials were provided (sign-in /
authenticated journeys), the run could not verify anything behind the login. Say
so plainly in bottomLine and ask for what's missing, e.g.: "To check your signed-in
experience, add test-account credentials in your dashboard." Frame it as a next
step for the owner, not a defect in their app.

A journey marked "carried": true was NOT walked this run (a partial re-check):
it was verified in an earlier run and copied forward unchanged. Its steps are
honest evidence of what worked then, so use them for context and for the overall
picture — but never write as if we re-verified it today. If a finding leans on
one, say in the detail that it comes from the earlier walk.

Never call an app broken unless you can point at it: a finding you categorized
"broken" or "exposed", or a step we actually observed fail. Absence of evidence
is not evidence of breakage — if nothing you saw broke, the worst honest verdict
is "needs attention".

A step that simply produced no effect for us, with no error response and no
console exception, proves NOTHING about the product. It is an unverified step,
not a defect: it must never become a finding, and the only honest mention is a
coverage clause ("we could not confirm X this run"). Never extrapolate it into
"no user can log in".

HTTP 429 / "rate limit" responses are self-induced by our own request volume.
They are never a finding and never belong in the bottom line.

${CUSTOMER_LANGUAGE_RULES}`;

const APP_LENS_CONTRACT = `Respond with ONLY JSON:
{"oneLiner":"...","whoFor":"...","coreValue":"...","businessModel":"...",
 "techSurface":"...","criticalPaths":["..."],"ifItBreaks":"...","bottomLine":"...",
 "findings":[{"title":"...","category":"broken|risky|confusing|polish|exposed",
  "severity":"high|medium|low",
  "detail":{"where":"...","whatWeTried":["..."],"whatHappened":"...","whyItMatters":"..."},
  "stepRef":{"journeyIndex":0,"stepIndex":0}}]}`;

// CHE-136: what the owner already settled sits between the rules and the JSON
// contract, so a finding they marked "that's fine" is not written again and
// then merely inherited a mark after the fact. Without knowledge the prompt is
// byte-identical to what it was before knowledge existed.
export function synthesisSystem(knowledge?: AppKnowledge | null): string {
  const block = knowledgeBlock(knowledge ?? null, "synthesis");
  return [APP_LENS_RULES, block, APP_LENS_CONTRACT].filter(Boolean).join("\n\n");
}

export interface SynthesizedFinding {
  errorSignature?: string;
  title: string;
  category: "broken" | "risky" | "confusing" | "polish" | "exposed";
  severity: "high" | "medium" | "low";
  detail: { where?: string; whatWeTried?: string[]; whatHappened?: string; whyItMatters?: string };
  stepRef?: { journeyIndex: number; stepIndex: number };
}

export async function synthesizeVerdict(args: {
  env: AgentEnv;
  llm: LlmConfig;
  runId: string;
  anatomy: AppAnatomy;
  // CHE-136: findings the owner settled and pages that changed, for the prompt.
  knowledge?: AppKnowledge | null;
}): Promise<{
  appLens: AppLens;
  verdict: Verdict;
  bottomLine: string | null;
  findings: SynthesizedFinding[];
  costUsd: number;
  usage: UsageTotals;
  // CHE-330: the model that wrote the verdict, and the roads that refused
  // before it. Ours only: the ledger and our board.
  model: string;
  refusals: RouteRefusal[];
}> {
  const { env, llm, runId, anatomy, knowledge } = args;
  const system = synthesisSystem(knowledge);

  // CHE-81: the owner's priority concerns ride into the observation so the
  // bottom line speaks to them explicitly.
  const runRow = await env.db.run.findUnique({
    where: { id: runId },
    select: { focusAreas: true, credentialsRejected: true, rejectedAccounts: true, testAccounts: true },
  });
  // CHE-322: which accounts were turned away, by the owner's own labels. With
  // only the default account there is nothing to name, and the sentence stays
  // what it always was.
  const rejected = runRow ? rejectedAccountLabels(runRow) : [];
  const named = rejected.length > 0 && (parseRunAccounts(runRow?.testAccounts).length > 0 || rejected.some((l) => l !== DEFAULT_ACCOUNT_LABEL));

  const journeys = await env.db.journey.findMany({
    where: { runId },
    // include (not select) keeps every Journey scalar, carriedFromRunId among
    // them, so the observation can flag the journeys this run copied forward
    // instead of walking (CHE-57).
    include: {
      steps: {
        orderBy: { order: "asc" },
        select: {
          label: true,
          status: true,
          attempted: true,
          observed: true,
          consoleLog: true,
          networkLog: true,
          // CHE-219: read for the bottom-line cut below, and deliberately kept
          // out of the observation — the trail is our machinery, and the model
          // has never needed it to describe the product.
          unverifiedReason: true,
          actions: true,
        },
      },
    },
    orderBy: { order: "asc" },
  });
  const observation = JSON.stringify({
    ownerConcerns: runRow?.focusAreas ?? undefined,
    // CHE-100: a fact about US, stated so the verdict cannot turn it into a
    // fact about them. The product refused a bad password, which is the product
    // working; the signed-in half simply went unchecked, and the honest ask is
    // for a working credential — never a claim that their login is broken.
    ...(rejected.length && !named
      ? {
          signInBlocked:
            "The sign-in details on file were rejected by this product's auth endpoint. That is " +
            "correct behaviour on their side and an access problem on ours. Say plainly in the " +
            "bottom line that the signed-in part could not be checked because the sign-in " +
            "details we hold no longer work, and ask for updated ones. NEVER describe the " +
            "login, or anything behind it, as broken, confusing or failing.",
        }
      : {}),
    ...(rejected.length && named
      ? {
          signInBlocked:
            `The sign-in details on file for ${describeAccounts(rejected)} were rejected by this ` +
            "product's auth endpoint. That is correct behaviour on their side and an access " +
            "problem on ours. Say plainly in the bottom line WHICH test account's sign-in " +
            "details no longer work, by that name, that what needed it could not be checked, " +
            "and ask for updated ones for that account. Any other test account is unaffected. " +
            "NEVER describe the login, or anything behind it, as broken, confusing or failing.",
        }
      : {}),
    pages: anatomy.pages,
    actions: anatomy.actions,
    services: anatomy.services,
    tech: anatomy.tech,
    journeys: journeys.map((j) => ({
      title: j.title,
      status: j.status,
      summary: j.summary,
      ...(j.carriedFromRunId ? { carried: true } : {}),
      steps: j.steps.map(({ actions: _actions, unverifiedReason: _reason, ...step }) => step),
    })),
  });

  // CHE-330: a refusal from the first road moves the call to the next one
  // instead of losing a run whose walking is already paid for. Which road
  // answered, and what refused, go back to the workflow for our own ledger
  // and board — never into anything the customer reads.
  const { message, model, refusals } = await createOnRoutes(synthRoutes(llm), {
    max_tokens: 8_000,
    thinking: { type: "adaptive" },
    system,
    messages: [{ role: "user", content: observation }],
  });

  let costUsd = costOf(model, message.usage);
  const usage = emptyUsage();
  addUsage(usage, model, message.usage);
  let parsed = parseAppLens(message);

  // The one-shot reply sometimes carries no parseable JSON, and the old silent
  // fallback shipped a placeholder verdict with 0 findings (run #68). Same cure
  // as discovery's CHE-42 ladder: force a schema-valid extraction over the
  // same context instead of shipping the placeholder.
  if (!parsed.bottomLine && parsed.findings.length === 0) {
    const assistantText = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    try {
      const forced = await finalizeStructured<
        Partial<AppLens> & { bottomLine?: string; findings?: SynthesizedFinding[] }
      >(
        llm,
        [
          { role: "user", content: `${system}\n\nOBSERVATION:\n${observation}` },
          { role: "assistant", content: assistantText.trim() || "(no analysis was produced)" },
        ],
        "Your analysis above did not include the required JSON object. Output it now — " +
          "the App Lens fields, bottomLine, and the findings — based ONLY on the observation.",
        SYNTH_RETRY_SCHEMA,
        // CHE-169: under the judge tier the forced retry gets one more chance
        // on the judge model before the placeholder verdict ships.
        { judgeFallback: harnessMode(env.bindings).judge },
      );
      costUsd += forced.costUsd;
      mergeUsage(usage, forced.usage);
      if (forced.parsed) {
        const { bottomLine, findings, ...lens } = forced.parsed;
        parsed = {
          appLens: { ...placeholderLens(), ...lens },
          bottomLine: bottomLine ?? null,
          findings: shapeFindings(findings),
        };
      } else {
        console.warn(`[synthesis] structured retry produced nothing — ${forced.note}`);
      }
    } catch (err) {
      console.warn(
        `[synthesis] structured retry failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // CHE-82 — customer-language gate. Deterministic, applied AFTER the model has
  // spoken, because three rounds of prompt rules did not stop the leak. Runs
  // before the roll-up on purpose: a finding that only describes our own
  // machinery is an artifact, and it must not colour the verdict either.
  {
    const before = parsed.findings.length;
    const cleanedFindings = parsed.findings
      .map(cleanFindingLanguage)
      .filter((f): f is SynthesizedFinding => f !== null);

    let bottomLine = parsed.bottomLine;
    // CHE-219: before anything else, a sentence claiming one of our
    // interactions produced nothing at a control the run never drove. Run
    // #159's bottom line opened with one, and no phrase table could see it —
    // it names none of our words. Same cut as the homework rule below, same
    // evidence as the findings gate, and the same fail-open: a run with no
    // machine trail is left alone.
    {
      const claim = cutUndrivenClaims(bottomLine, journeys);
      if (claim.cut.length) {
        console.warn(
          `[synthesis] bottom line claimed ${claim.cut.length} interaction(s) this run never performed — cutting: ${claim.cut.join(" / ")}`,
        );
        bottomLine = claim.text ?? BOTTOM_LINE_FALLBACK;
      }
    }
    // CHE-334: where our own self-check guard refused a step, the bottom line
    // and the findings may not retell that refusal as the product's.
    const refusal = ownGuardRefusals(journeys, bottomLine, cleanedFindings);
    if (refusal.cut.length) {
      console.warn(`[synthesis] cut our own guard retold as the product's: ${refusal.cut.join(" / ")}`);
      bottomLine = refusal.bottomLine;
      cleanedFindings.splice(0, cleanedFindings.length, ...refusal.findings);
    }
    // CHE-191: a trailing "Worth checking …" is one sentence to cut, not a
    // reason to spend a model call rewriting the line. Cut first; what is
    // left goes through the machinery check below as before.
    if (hasHomework(bottomLine)) {
      console.warn(`[synthesis] bottom line handed the customer homework — cutting the sentence: ${bottomLine}`);
      bottomLine = stripHomework(bottomLine!, BOTTOM_LINE_FALLBACK);
    }
    if (hasEnvironmentLeak(bottomLine)) {
      console.warn(`[synthesis] bottom line leaked our environment — rewriting: ${bottomLine}`);
      // CHE-330: the rewrite rides the same roads, so its refusals are ours
      // to file too — whether it recovered on the fallback or gave up.
      const rewritten = await rewriteBottomLine(llm, bottomLine!).catch((err: unknown) => {
        refusals.push(...refusalsOf(err));
        return null;
      });
      if (rewritten) {
        costUsd += rewritten.costUsd;
        mergeUsage(usage, rewritten.usage);
        refusals.push(...rewritten.refusals);
      }
      bottomLine =
        rewritten && !hasEnvironmentLeak(rewritten.text)
          ? rewritten.text
          : (stripEnvironmentLeak(bottomLine) ?? BOTTOM_LINE_FALLBACK);
    }

    if (cleanedFindings.length !== before) {
      console.warn(
        `[synthesis] dropped ${before - cleanedFindings.length} finding(s) that described our environment, not the product`,
      );
    }
    parsed = { ...parsed, bottomLine, findings: cleanedFindings };
  }

  // Verdict rolls up BOTH observed journey-step outcomes AND synthesized
  // findings. Earlier it ignored findings, so a run with 0 journeys but several
  // high-severity findings reported "all_good" — a contradiction.
  let verdict = rollUpVerdict(
    journeys.map((j) => j.status as StepStatus),
    parsed.findings,
  );
  // Nothing walked ⇒ nothing verified end-to-end: a "broken" verdict would be
  // speculation (Run #10 fabricated a broken login exactly this way). Cap at
  // needs_attention unless a security exposure was directly observed.
  if (
    journeys.length === 0 &&
    verdict === "broken" &&
    !parsed.findings.some((f) => f.category === "exposed")
  ) {
    verdict = "needs_attention";
  }
  return { ...parsed, verdict, costUsd, usage, model, refusals };
}

// The bottom line when nothing the model wrote about the product survived.
export const BOTTOM_LINE_FALLBACK = "We checked what we could reach this run; some paths went unverified.";

// CHE-334. Pure, exported for scripts/verify-self-check-own-state.ts. A run
// whose steps carry no refusal of our own guard comes back untouched — the
// words "403" and "refused" are real evidence on every other run. Where one
// does, a finding is judged by its anchor first: anchored on a refused step,
// it is not written; anchored on a step that stands (a real 403 elsewhere in
// the run), it is kept whatever its words. Only a finding with no usable
// anchor is judged by its words — every field the customer reads — and goes
// if any of them retells a refusal. The bottom line loses the sentences that
// retell it. Both word tests are matched against the run's steps (Codex
// review of #205): a sentence that points at a standing problem step more
// than at a refused one — "the /settings/team page answers 403" next to a
// refused "Show me my app" — is the product's own evidence and stays.
export function ownGuardRefusals(
  journeys: Array<{ steps: RefusalContextStep[] }>,
  bottomLine: string | null,
  findings: SynthesizedFinding[],
): { bottomLine: string | null; findings: SynthesizedFinding[]; cut: string[] } {
  if (!journeys.some((j) => j.steps.some(isSelfCheckRefusalStep))) return { bottomLine, findings, cut: [] };
  const allSteps = journeys.flatMap((j) => j.steps);
  const cut: string[] = [];
  const kept = findings.filter((f) => {
    const ref = f.stepRef;
    const anchored = ref ? journeys[ref.journeyIndex]?.steps[ref.stepIndex] : undefined;
    const d = f.detail ?? {};
    const words = [f.title, d.where, ...(Array.isArray(d.whatWeTried) ? d.whatWeTried : []), d.whatHappened, d.whyItMatters]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .map((s) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`))
      .join(" ");
    const refused = anchored
      ? isSelfCheckRefusalStep(anchored)
      : cutSelfCheckRefusalClaims(words, allSteps).cut.length > 0;
    if (refused) {
      cut.push(`finding "${f.title}"`);
      return false;
    }
    return true;
  });
  const line = cutSelfCheckRefusalClaims(bottomLine, allSteps);
  cut.push(...line.cut);
  return {
    bottomLine: line.cut.length ? (line.text ?? BOTTOM_LINE_FALLBACK) : bottomLine,
    findings: kept,
    cut,
  };
}

// One finding through the customer-language gate (CHE-82, CHE-191). Null means
// the finding is not written. Exported so verify-homework-gate.ts runs the
// exact function the workflow runs.
//
// The title IS the claim: if it names our machinery or hands the reader
// homework, the whole finding is an artifact of how we check, not a fact about
// the product. whatHappened is the evidence: once our machinery and the ask
// are cut, nothing left means nothing was observed → not written. whyItMatters
// is the consequence: a homework sentence is cut and the rest stays (run #147:
// "VK and OK are among the most-used networks …" survives, "Worth confirming
// both share flows …" does not); when the ask was ALL of it, the coverage
// sentence stands in rather than an empty panel. whatWeTried is a list: an
// entry that was an ask is removed, the others stay.
export function cleanFindingLanguage(f: SynthesizedFinding): SynthesizedFinding | null {
  const detail = f.detail ?? {};
  if (hasEnvironmentLeak(f.title)) return null;
  const whatHappened = hasEnvironmentLeak(detail.whatHappened)
    ? stripEnvironmentLeak(detail.whatHappened)
    : (detail.whatHappened ?? null);
  if (detail.whatHappened && !whatHappened) return null;
  let whyItMatters: string | null = detail.whyItMatters ?? null;
  if (whyItMatters && hasHomework(whyItMatters)) whyItMatters = stripHomework(whyItMatters);
  if (whyItMatters && hasEnvironmentLeak(whyItMatters)) whyItMatters = stripEnvironmentLeak(whyItMatters);
  const whatWeTried = Array.isArray(detail.whatWeTried)
    ? detail.whatWeTried
        .filter((s): s is string => typeof s === "string")
        .map((s) => (hasEnvironmentLeak(s) ? stripEnvironmentLeak(s) : s))
        .filter((s): s is string => !!s)
    : undefined;
  const where =
    typeof detail.where === "string" && hasEnvironmentLeak(detail.where)
      ? (stripEnvironmentLeak(detail.where) ?? undefined)
      : detail.where;
  return {
    ...f,
    detail: {
      ...detail,
      ...(where !== undefined ? { where } : {}),
      ...(whatWeTried !== undefined ? { whatWeTried } : {}),
      ...(whatHappened ? { whatHappened } : {}),
      ...(whyItMatters ? { whyItMatters } : {}),
    },
  };
}

const VERDICT_RANK: Verdict[] = ["all_good", "mostly_ok", "needs_attention", "broken"];
function worseVerdict(a: Verdict, b: Verdict): Verdict {
  return VERDICT_RANK.indexOf(a) >= VERDICT_RANK.indexOf(b) ? a : b;
}

// A synthesized finding (derived from exploration, not an observed runtime
// failure) maps conservatively: a product gap categorized "broken/high" is
// "needs_attention", not a fully broken app. Security exposures escalate by
// severity — a medium "evidence links are public by design" must not paint the
// whole app broken (run #29 did exactly that), a high one should.
function findingVerdict(f: SynthesizedFinding): Verdict {
  if (f.category === "exposed") return f.severity === "high" ? "broken" : "needs_attention";
  if (f.category === "broken") return "needs_attention";
  if (f.category === "risky") return f.severity === "high" ? "needs_attention" : "mostly_ok";
  if (f.category === "confusing") return "mostly_ok";
  return "all_good"; // polish
}

// Synthesis is the adjudicator: it re-reads every step with full context and
// writes findings off that picture. A step the walking model labeled broken
// mid-flight (run #28: a background analytics 401 flagged "client priority")
// only drives a broken VERDICT when a finding corroborates it — otherwise the
// step caps the roll-up at needs_attention and the pill stays honest.
function rollUpVerdict(statuses: StepStatus[], findings: SynthesizedFinding[]): Verdict {
  let verdict: Verdict = "all_good";
  const corroborated = findings.some(
    (f) => f.category === "broken" || (f.category === "exposed" && f.severity === "high"),
  );
  if (statuses.some((s) => s === "broken" || s === "exposed")) {
    verdict = corroborated ? "broken" : "needs_attention";
  } else if (statuses.some((s) => s === "risky")) {
    verdict = worseVerdict(verdict, "needs_attention");
  } else if (statuses.some((s) => s === "confusing")) {
    verdict = worseVerdict(verdict, "mostly_ok");
  }
  for (const f of findings) verdict = worseVerdict(verdict, findingVerdict(f));
  return verdict;
}

const VALID_CATEGORIES = ["broken", "risky", "confusing", "polish", "exposed"] as const;
const VALID_SEVERITIES = ["high", "medium", "low"] as const;

function parseAppLens(message: Anthropic.Message): {
  appLens: AppLens;
  bottomLine: string | null;
  findings: SynthesizedFinding[];
} {
  const text = message.content.find((b) => b.type === "text");
  if (text && text.type === "text") {
    const match = text.text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const raw = JSON.parse(match[0]) as AppLens & {
          bottomLine?: string;
          findings?: SynthesizedFinding[];
        };
        const { bottomLine, findings, ...lens } = raw;
        return {
          appLens: { ...placeholderLens(), ...lens },
          bottomLine: bottomLine ?? null,
          findings: shapeFindings(findings),
        };
      } catch {
        // fall through
      }
    }
  }
  return { appLens: placeholderLens(), bottomLine: null, findings: [] };
}

// Validation shared by the one-shot parse and the structured retry.
function shapeFindings(findings: SynthesizedFinding[] | undefined): SynthesizedFinding[] {
  return (findings ?? [])
    .filter((f) => f.title)
    .slice(0, 20)
    .map((f) => ({
      ...f,
      category: VALID_CATEGORIES.includes(f.category) ? f.category : "confusing",
      severity: VALID_SEVERITIES.includes(f.severity) ? f.severity : "low",
      detail: f.detail ?? {},
    }));
}

// Schema for the forced retry (finalizeStructured → output_config json_schema).
const SYNTH_RETRY_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["bottomLine", "findings"],
  properties: {
    oneLiner: { type: "string" },
    whoFor: { type: "string" },
    coreValue: { type: "string" },
    businessModel: { type: "string" },
    techSurface: { type: "string" },
    criticalPaths: { type: "array", items: { type: "string" } },
    ifItBreaks: { type: "string" },
    bottomLine: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "category", "severity"],
        properties: {
          title: { type: "string" },
          category: { type: "string", enum: [...VALID_CATEGORIES] },
          severity: { type: "string", enum: [...VALID_SEVERITIES] },
          detail: {
            type: "object",
            properties: {
              where: { type: "string" },
              whatWeTried: { type: "array", items: { type: "string" } },
              whatHappened: { type: "string" },
              whyItMatters: { type: "string" },
            },
          },
          stepRef: {
            type: "object",
            properties: {
              journeyIndex: { type: "integer" },
              stepIndex: { type: "integer" },
            },
          },
        },
      },
    },
  },
};

function placeholderLens(): AppLens {
  return {
    oneLiner: "Synthesis produced no lens.",
    whoFor: "",
    coreValue: "",
    businessModel: "",
    techSurface: "",
    criticalPaths: [],
    ifItBreaks: "",
  };
}

// One short call to restate a bottom line in customer language (CHE-82). Cheap
// by construction: it only ever sees the offending sentence, never the run.
async function rewriteBottomLine(
  llm: LlmConfig,
  bottomLine: string,
): Promise<{ text: string; costUsd: number; usage: UsageTotals; refusals: RouteRefusal[] }> {
  const { message, model, refusals } = await createOnRoutes(synthRoutes(llm), {
    max_tokens: 600,
    system:
      `Rewrite a product verdict's bottom line so it never mentions how the check ` +
      `was performed and never asks the reader to verify anything themselves.\n\n` +
      CUSTOMER_LANGUAGE_RULES +
      `\n\nKeep every real finding about the product. Turn anything we could not ` +
      `confirm into a plain coverage clause ("we could not confirm X this run"). ` +
      `Reply with the rewritten text only — no preamble, no quotes.`,
    messages: [{ role: "user", content: bottomLine }],
  });
  const usage = emptyUsage();
  addUsage(usage, model, message.usage);
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
  return { text, costUsd: costOf(model, message.usage), usage, refusals };
}
