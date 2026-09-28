// A run that fails on our side is on our board the moment it fails (CHE-329).
//
// Owner, 2026-09-28, on run #258: "и что никто это не видит на нашей стороне,
// что сломано?" — true. Run #197 (checkmyapp.dev, 2026-09-15) and #258
// (joblander.app, 2026-09-27) both died in synthesis on the model provider's
// `403 {"error":{"type":"forbidden",…}}`; #206 on WorkflowInternalError; five
// self-check runs (#198–#244) on placeholder hosts that refuse every
// connection. Every one
// of them ended as status=failed and nothing else — no ticket, no count, and the
// only record a raw string on a row nobody reads.
//
// A failed run is rule 2 in its bluntest form: the customer got nothing, and
// the reason is ours unless we can show it is not. So every failure is filed
// on our own board through the same loop as a capability gap (autofile →
// dedup → comment and count), one ticket per SIGNATURE — a stable label, never
// the customer's words — counted across every app that trips it, each
// recurrence commented with its run and its message.
//
// Whose failure it is (the rule, in order):
//   1. Our model budget refusing us is ours, whatever the target (CHE-76).
//   2. An extension run's failure is already filed, by fileCapabilityGaps as an
//      extension gap with its evidence kept private (workflow.ts "fail") — not
//      filed twice. Unless it threw after its verdict was written: that branch
//      of "fail" files no gap, so it is filed here like any other.
//   3. Our runaway fuse, the Workflows engine, and the model provider answering
//      an HTTP error are ours. A route refusal that ended synthesis (a 4xx in
//      `writing`, isRefusalStatus) was already filed by fileRouteRefusal
//      (CHE-330) with its route facts, and is not filed twice.
//   4. The target's page not loading in our browser:
//        - on a target that is ours (our host on our run, or a self-check
//          account's placeholder app — silenceReason, CLAUDE.md §6) it is ours:
//          we pointed our own checker at something that does not answer;
//        - on a customer's site that ALSO refuses a plain request from our
//          side it is theirs — the site was down, and a site being down is not
//          a defect in the checker;
//        - on a customer's site that answers a plain request it is ours: the
//          site is up and our browser could not reach it (rule 8 — our
//          incapacity must never be filed as their outage, nor forgotten).
//   5. Anything else is ours. "We could not tell whose it was" is our defect
//      too (rule 8), filed under its normalised message until someone gives it
//      a name here.
//
// No `cloudflare:workers` import, so scripts/verify-failed-run.ts drives the
// real classification and the real filing path against a stub board.

import { fileFindingTicket, type TicketFinding } from "@/lib/tracker/file";
import { ourBoard, selfPolicy, type CapabilityNote, type GapBoard } from "./capability-gaps";
import { isRefusalStatus } from "./llm";
import { isOwnRun, silenceReason } from "./notify-verdict";
import type { AgentEnv } from "./env";

export type FailureOwner =
  | { kind: "ours"; signature: string }
  | { kind: "theirs"; why: string }
  | { kind: "filed_elsewhere"; why: string };

export interface FailureFacts {
  message: string;
  budget: boolean;
  isExtension: boolean;
  /**
   * The verdict was already written when this threw (workflow.ts "fail" kept
   * the run finished). The extension-gap filing lives on the other branch of
   * that step, so here nothing else has filed it.
   */
  afterVerdict: boolean;
  /** Run.status when it threw — the phase it died in. */
  phase: string | null;
  /** Our host on our run, or a self-check account's run — silenceReason() !== null. */
  ourTarget: boolean;
  /** A plain request from our side got an HTTP answer from the target. null = not asked. */
  targetAnswers: boolean | null;
}

// Playwright's words for a page that never loaded. The code in the message is
// the part that stays the same run to run; the URL around it is the customer's.
const NAVIGATION = /page\.goto: (?:net::(ERR_[A-Z_]+)|(Timeout) \d+ms exceeded)/;

export function navigationFailure(message: string): string | null {
  const m = NAVIGATION.exec(message);
  return m ? (m[1] ?? "timeout") : null;
}

// The model SDK's error shape: `<status> <json body>` or `<status> status code
// (no body)` — run #258's `403 {"error":{"type":"forbidden",…}}`.
const PROVIDER_HTTP = /^([1-5]\d{2}) (?:\{|status code)/;

/**
 * A message reduced to what two occurrences of the same failure share: the
 * first line, URLs and ids and long numbers out, whitespace collapsed. HTTP
 * statuses (three digits) stay — a 403 and a 500 are different failures.
 */
export function normalizeFailure(message: string): string {
  const first = message.split("\n")[0] ?? "";
  const norm = first
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b(?=[a-z]*\d)[a-z0-9]{16,}\b/gi, "<id>")
    .replace(/\b\d{4,}\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return norm || "(no message)";
}

export function classifyRunFailure(f: FailureFacts): FailureOwner {
  if (f.budget) return { kind: "ours", signature: "Model provider refused us for our credit state" };
  if (f.isExtension && !f.afterVerdict) {
    return { kind: "filed_elsewhere", why: "an extension run's failure is filed as an extension gap" };
  }
  const msg = f.message.trim();
  if (/^internal: runaway fuse/i.test(msg)) return { kind: "ours", signature: "Runaway-cost fuse stopped a check" };
  if (/WorkflowInternalError|internal workflows error/i.test(msg)) {
    return { kind: "ours", signature: "Workflow engine failed the run" };
  }
  const http = PROVIDER_HTTP.exec(msg);
  // CHE-330: a refusal that ends synthesis was filed by fileRouteRefusal, with
  // the route and the location it left from, before the run failed. One
  // failure, one ticket: not filed a second time under this signature.
  if (http && f.phase === "writing" && isRefusalStatus(Number(http[1]))) {
    return { kind: "filed_elsewhere", why: "a refused verdict route is filed as its own gap (fileRouteRefusal)" };
  }
  if (http) return { kind: "ours", signature: `Model provider answered HTTP ${http[1]}` };
  const nav = navigationFailure(msg);
  if (nav) {
    if (f.ourTarget) return { kind: "ours", signature: `Our own check target does not load (${nav})` };
    if (f.targetAnswers === true) {
      return { kind: "ours", signature: `Target answers a plain request but not our browser (${nav})` };
    }
    return { kind: "theirs", why: `the site did not load (${nav}) and did not answer a plain request either` };
  }
  return { kind: "ours", signature: `Unrecognised failure: ${normalizeFailure(msg)}` };
}

// Does the target answer at all, asked the plainest way we can? Any HTTP
// response counts — a 403 or a 500 is still a server that is up. Only asked
// when the page did not load in our browser; that is the one question it
// settles.
export async function targetAnswersPlainRequest(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000) });
    return true;
  } catch {
    return false;
  }
}

const WHY =
  "A customer asked for a check and got none. The page says only that the check didn't " +
  "finish; everything else about why lives here. Until this signature stops recurring, " +
  "that is what we ship to whoever trips it.";

// Never throws: filing on our own board must not turn one failure into two.
// `opts.board` and `opts.probe` are for the acceptance script only.
export async function fileRunFailure(
  env: AgentEnv,
  runId: string,
  facts: { message: string; budget: boolean; phase: string | null; afterVerdict?: boolean },
  opts: { board?: GapBoard; probe?: (url: string) => Promise<boolean> } = {},
): Promise<CapabilityNote | null> {
  try {
    const run = await env.db.run.findUnique({
      where: { id: runId },
      select: {
        id: true,
        runNumber: true,
        publicId: true,
        startedAt: true,
        appSlug: true,
        targetUrl: true,
        targetKind: true,
        ownerId: true,
        teamId: true,
        watchId: true,
        owner: { select: { isTestAccount: true } },
      },
    });
    if (!run) return null;

    const ourTarget =
      silenceReason({
        targetUrl: run.targetUrl,
        ownRun: isOwnRun(run),
        ownedByTestAccount: Boolean(run.owner?.isTestAccount),
        selfCheckHosts: env.bindings.SELF_CHECK_HOSTS,
      }) !== null;
    const needsProbe = navigationFailure(facts.message) !== null && !ourTarget;
    const targetAnswers = needsProbe
      ? await (opts.probe ?? targetAnswersPlainRequest)(run.targetUrl)
      : null;
    const owner = classifyRunFailure({
      message: facts.message,
      budget: facts.budget,
      isExtension: run.targetKind === "extension",
      afterVerdict: facts.afterVerdict === true,
      phase: facts.phase,
      ourTarget,
      targetAnswers,
    });
    if (owner.kind !== "ours") {
      console.log(`[run-failure] run #${run.runNumber} not filed: ${owner.why}`);
      return null;
    }

    const board = opts.board ?? (await ourBoard(env));
    if (!board) {
      return {
        icon: "warn",
        text: `Run #${run.runNumber} failed (${owner.signature}) — connect the CheckMyApp app's own tracker so run failures get filed.`,
      };
    }
    const { self, tracker, baseUrl } = board;
    const runUrl = `${baseUrl}/run/${run.publicId}`;
    // No code fences: the ticket body already sets this inside one.
    const occurrence = [
      `Run #${run.runNumber} on ${run.appSlug} threw${facts.phase ? ` (${facts.phase})` : ""}: ${runUrl}`,
      `Run.errorMessage: ${facts.message.slice(0, 800)}`,
    ].join("\n");

    const finding: TicketFinding = {
      runId: run.id,
      number: 0,
      title: owner.signature,
      category: "broken",
      severity: "high",
      detail: JSON.stringify({
        // Fixed, so one signature is one ticket: the app, the run and the
        // message are occurrence facts and stay out of the three fields the
        // dedup key reads.
        where: "CheckMyApp run failure",
        whatWeTried: [occurrence],
        whatHappened:
          "A check ended as failed: no verdict, no findings, no email. The customer was told only " +
          "that it did not finish.",
        whyItMatters: WHY,
      }),
      evidence: [],
    };

    const outcome = await fileFindingTicket({
      db: env.db,
      tracker,
      appId: self.id,
      finding,
      run: {
        runNumber: run.runNumber,
        publicId: run.publicId,
        startedAt: run.startedAt,
        // Dedup identity on OUR app: one signature, one ticket, across every
        // customer whose check it ends.
        appSlug: self.appSlug,
      },
      policy: selfPolicy(self, "[Checker failure] {verdict}"),
      ownerId: self.ownerId,
      verdictUrl: runUrl,
      recurrenceDetail: occurrence,
    });
    return {
      icon: "ok",
      text:
        outcome.kind === "created"
          ? `Opened ${outcome.identifier} on our own board: ${owner.signature}`
          : outcome.kind === "commented"
            ? `Run failure "${owner.signature}" recurred — ${outcome.identifier} now at ${outcome.occurrences} occurrence(s)`
            : `Run failure "${owner.signature}" is settled as ${outcome.identifier}`,
    };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    console.warn(`[run-failure] filing failed: ${text}`);
    return { icon: "warn", text: `Couldn't file run failure: ${text}` };
  }
}
