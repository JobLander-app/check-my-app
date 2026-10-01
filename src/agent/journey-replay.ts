// Replay a walked journey with no model in the loop (CHE-129, spike).
//
// Walking is 69% of a run's cost — about 24 model calls per journey — and a
// watch run spends them re-discovering a path it walked the day before. It has
// to, because Step keeps prose (label / attempted / observed) and prose cannot
// be executed; the Playwright specs the walk writes need the test runner on
// Node, which workerd does not have. Step.actions closes that gap: the
// navigate/click/fill calls the walk actually executed, as data.
//
// This module is the measurement, not the feature. It redoes those actions on
// the live app through the same executeTool the walk used — so every gate the
// walk had (origin, the one-attempt credential rule, create/state-toggle
// refusals, hydration waits, the fallback click ladder) applies identically —
// and reports how much of the journey a browser could reproduce on its own.
// The owner decides from that number whether to build the full feature
// (2026-09-03). Nothing here is customer-facing: no events, no verdict, no
// email; Journey.replayStatus is read by our own scripts and nobody else.
//
// Deliberately read-only: writeAllowed is false whatever the walk was allowed,
// so a replay can never create a record, and there is no ledger for it to
// forget one in. What the walk created it also deleted; redoing the creation
// without the model that knew how to delete it would leave junk behind.

import type { Browser, BrowserContext } from "@cloudflare/playwright";
import type { AgentEnv } from "./env";
import { credentialToolEnv } from "./credentials";
import { executeTool, NO_FRAME_MATCH, prepareAgentPage, UNDRIVEN_INSTRUCTION, type RecordedAction, type ToolEnv } from "./tools";
import { parseAllowedOrigins } from "@/lib/allowed-origins";

// The stable head of UNDRIVEN_INSTRUCTION — the tool text for a control our own
// hands could not drive (CHE-214).
const UNDRIVEN_MARKER = UNDRIVEN_INSTRUCTION.slice(0, UNDRIVEN_INSTRUCTION.indexOf(" — "));

export type ActionOutcome = "ok" | "refused" | "diverged" | "errored";
export type StepOutcome = ActionOutcome | "no_actions";
export type ReplayStatus = "reproduced" | StepOutcome;

export interface ReplayStepResult {
  order: number;
  label: string;
  status: StepOutcome;
  // The first action that was not ok, and what the tool said about it.
  detail: string | null;
}

export interface ReplayResult {
  status: ReplayStatus;
  note: string;
  steps: ReplayStepResult[];
}

export interface ReplayRun {
  id: string;
  targetUrl: string;
  testEmail?: string | null;
  testPasswordEnc?: string | null;
  // CHE-322: Run.testAccounts, so a step recorded as a named account replays as it.
  testAccounts?: string | null;
  appId?: string | null;
  // CHE-373: Run.allowedOrigins, so a recorded step on an allowed origin
  // replays where it was walked instead of being refused as off-target.
  allowedOrigins?: string | null;
}

export interface ReplayJourney {
  id: string;
  title: string;
  steps: Array<{ order: number; label: string; actions: string | null }>;
}

// Whole-journey wall clock. A journey the model walked in a few minutes must
// not become a replay that holds the run for ten: after this, remaining
// actions are marked errored with a timeout note and the context is closed.
export const REPLAY_BUDGET_MS = 3 * 60_000;
const TIMEOUT_RESULT = "Error: replay time budget exhausted";

// Worst-of ordering. A refusal is our own gate saying no (the path exists, we
// chose not to walk it); a divergence is the app not doing what it did last
// time; an error is the action not executing at all.
const OUTCOME_RANK: Record<ActionOutcome, number> = { ok: 0, refused: 1, diverged: 2, errored: 3 };

// ─── Pure classification (exercised by scripts/verify-replay-actions.ts) ──────

// Read the outcome off the tool's result text — the same text the model reads
// during a walk, so replay and walk agree on what "did not work" means.
export function classifyResult(kind: RecordedAction["kind"], result: string): ActionOutcome {
  if (result.startsWith("Error:")) return "errored";
  if (result.startsWith("Refused:")) return "refused";
  // CHE-214: a control our hands could not drive no longer comes back as a bare
  // "Error:" — the tool now says what the failure means. It is still an action
  // that did not execute, and a replay must count it as one.
  if (result.includes(UNDRIVEN_MARKER)) return "errored";
  if (result.includes("did not react AT ALL")) return "diverged";
  // CHE-373: the frame the walk acted in is not on the page any more — the app
  // is not where it was, and nothing was pressed.
  if (result.startsWith(NO_FRAME_MATCH)) return "diverged";
  // The walk signed in with this credential; the app turning it away now is
  // the replay landing somewhere the walk did not, not a reproduction.
  if (result.includes("was REJECTED")) return "diverged";
  if (kind === "navigate") {
    const status = result.match(/\(status (\d{3})\)/);
    if (status && Number(status[1]) >= 500) return "diverged";
  }
  return "ok";
}

export function worstOutcome(outcomes: ActionOutcome[]): StepOutcome {
  if (outcomes.length === 0) return "no_actions";
  return outcomes.reduce<ActionOutcome>(
    (worst, o) => (OUTCOME_RANK[o] > OUTCOME_RANK[worst] ? o : worst),
    "ok",
  );
}

// reproduced: every step that had actions came back ok, and at least one did.
// no_actions: nothing on this journey was executable. Otherwise the worst step.
export function rollUpJourney(steps: StepOutcome[]): ReplayStatus {
  const acted = steps.filter((s): s is ActionOutcome => s !== "no_actions");
  if (acted.length === 0) return "no_actions";
  const worst = worstOutcome(acted);
  return worst === "ok" ? "reproduced" : worst;
}

export function replayNote(steps: ReplayStepResult[]): string {
  const acted = steps.filter((s) => s.status !== "no_actions");
  if (acted.length === 0) {
    return `no recorded actions on any of ${steps.length} step${steps.length === 1 ? "" : "s"}`;
  }
  const ok = acted.filter((s) => s.status === "ok").length;
  const parts = [`${ok} of ${acted.length} step${acted.length === 1 ? "" : "s"} reproduced`];
  const first = acted.find((s) => s.status !== "ok");
  if (first) {
    parts.push(`step ${first.order + 1} "${first.label}" ${first.status}: ${first.detail ?? "(no detail)"}`);
  }
  const silent = steps.length - acted.length;
  if (silent > 0) parts.push(`${silent} step${silent === 1 ? "" : "s"} without recorded actions`);
  return parts.join("; ");
}

// Tolerant on purpose: a malformed column is "nothing to replay", never a
// crash in the middle of a run.
export function parseActions(json: string | null | undefined): RecordedAction[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a): a is RecordedAction =>
        typeof a === "object" &&
        a !== null &&
        !(a as { surface?: unknown }).surface &&
        ["navigate", "click", "fill"].includes((a as { kind?: unknown }).kind as string),
    );
  } catch {
    return [];
  }
}

function toolInput(action: RecordedAction): Record<string, unknown> {
  switch (action.kind) {
    case "navigate":
      return { url: action.url };
    // CHE-373: the frame the walk acted in, so the replay acts there and not on
    // a control of the same name the page or an earlier frame also has.
    case "click":
      return { role: action.role, name: action.name, selector: action.selector, frame: action.frame };
    case "fill":
      return { label: action.label, selector: action.selector, value: action.value, frame: action.frame };
  }
}

function describe(action: RecordedAction): string {
  switch (action.kind) {
    case "navigate":
      return `navigate ${action.url}`;
    case "click":
      return `click ${[action.role, action.name, action.selector].filter(Boolean).join(" ")}`;
    case "fill":
      return `fill ${action.label ?? action.selector ?? "(first input)"}`;
  }
}

// executeTool never rejects (it turns every throw into "Error: …"), so the
// only thing to guard is time. The Playwright call left in flight on timeout
// is torn down with the context in the caller's finally.
function withinBudget(work: Promise<string>, ms: number): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(TIMEOUT_RESULT), Math.max(ms, 0));
    work.then(
      (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      (err) => {
        clearTimeout(timer);
        resolve(`Error: ${err instanceof Error ? err.message : String(err)}`);
      },
    );
  });
}

// ─── The replay ──────────────────────────────────────────────────────────────

// openContext is passed in rather than imported from ./browser because that
// module pulls @cloudflare/playwright's runtime (cloudflare:workers) at import,
// and this file must load on plain Node for the verify script. The workflow
// passes newAgentContext(browser, run.targetUrl, bindings) — CHE-193: the
// self-check announcement on our hosts only, CHE-212: on the guarded requests
// only, which is routing and so cannot be expressed as context options.
// Nothing else is meant to call this.
export async function replayJourney(
  env: AgentEnv,
  browser: Browser,
  run: ReplayRun,
  journey: ReplayJourney,
  openContext: (browser: Browser) => Promise<BrowserContext>,
): Promise<ReplayResult> {
  const deadline = Date.now() + REPLAY_BUDGET_MS;
  const context = await openContext(browser);
  try {
    const page = await context.newPage();
    const toolEnv: ToolEnv = {
      page,
      targetOrigin: originOf(run.targetUrl),
      allowedOrigins: parseAllowedOrigins(run.allowedOrigins),
      // CHE-193: lets the click gate know which extra hosts are ours. Optional
      // chaining because verify-replay-actions.ts drives this loop with a bare
      // env (db only); production always has bindings.
      selfCheckHosts: env.bindings?.SELF_CHECK_HOSTS,
      // Same run, same rule: a credential the walk found rejected is not tried
      // again, and a rejection met here is written to the run like any other.
      // CHE-322: a recorded {{TEST_PASSWORD:admin}} replays as admin.
      ...(await credentialToolEnv(env, run)),
      networkLog: [],
      consoleLog: [],
      writeAllowed: false,
    };
    await prepareAgentPage(toolEnv);

    const steps: ReplayStepResult[] = [];
    let timedOut = false;
    for (const step of [...journey.steps].sort((a, b) => a.order - b.order)) {
      const actions = parseActions(step.actions);
      if (actions.length === 0) {
        steps.push({ order: step.order, label: step.label, status: "no_actions", detail: null });
        continue;
      }
      if (timedOut) {
        steps.push({
          order: step.order,
          label: step.label,
          status: "errored",
          detail: "not reached: replay time budget exhausted",
        });
        continue;
      }
      const outcomes: ActionOutcome[] = [];
      let detail: string | null = null;
      // Every action runs even after one goes wrong: the measurement is how
      // much of the path survives, and a later step landing ok after an
      // earlier refusal is information (the gate, not the app, stopped us).
      for (const action of actions) {
        const result = await withinBudget(
          executeTool(toolEnv, action.kind, toolInput(action)),
          deadline - Date.now(),
        );
        const outcome = classifyResult(action.kind, result);
        outcomes.push(outcome);
        if (outcome !== "ok" && detail === null) {
          detail = `${describe(action)} → ${result.replace(/\s+/g, " ").slice(0, 200)}`;
        }
        if (result === TIMEOUT_RESULT) {
          timedOut = true;
          break;
        }
      }
      steps.push({ order: step.order, label: step.label, status: worstOutcome(outcomes), detail });
    }
    const status = rollUpJourney(steps.map((s) => s.status));
    return { status, note: replayNote(steps), steps };
  } finally {
    await context.close().catch(() => {});
  }
}

// Same as discovery's originOf, which cannot be imported here for the reason
// contextOptions is a parameter: discovery.ts loads ./browser.
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
