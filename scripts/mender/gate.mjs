// Mender's merge gate (CHE-486). Owner, 2026-10-15: «да, пусть все мержится
// само, но нужно подключить self healing loop … все равно монитор на следующем
// тике все поймает». A Mender pull request no longer waits for a person: ten of
// them sat unmerged for one to three days, and the pilot's feedback never
// reached production. What protects production now is what happens after the
// merge (the watch, CHE-486 part 4), so this gate only asks what is cheap and
// certain before it: CI is green on the head, and the reviewer had its say.
//
// Pure: the facts come from GitHub (agent.mjs `gate`), the decision is here and
// in scripts/verify-mender-agent.mjs.

/** Fix rounds a pull request may spend (the same three as review rounds). */
export const MAX_GATE_ROUNDS = 3;
/** How long a reviewer that was asked may stay silent before the gate merges without it. */
export const REVIEW_SILENCE_MINUTES = 45;

/**
 * What Codex's summary comment says, from the machine-readable state it embeds:
 *   <!-- codex-review-state:v1 {"code_review":{"commit_sha":"…","has_any_findings":false,"status":"completed"}} -->
 * Null when the comment carries no such state.
 *
 * @returns {{commitSha:string, status:string|null, hasAnyFindings:boolean|null}|null}
 */
export function codexReviewState(body) {
  const m = String(body ?? "").match(/<!--\s*codex-review-state:v1\s+(\{[\s\S]*?\})\s*-->/);
  if (!m) return null;
  try {
    const r = JSON.parse(m[1])?.code_review;
    if (!r?.commit_sha) return null;
    return { commitSha: String(r.commit_sha), status: r.status ?? null, hasAnyFindings: r.has_any_findings ?? null };
  } catch {
    return null;
  }
}

/**
 * A finding that holds a merge: Codex's P1 badge, or CodeRabbit's Major or
 * Critical badge (both reviewers' findings count; Codex, #356). P2, Minor and
 * lower do not hold a merge once a round has answered them.
 */
export const isP1 = (body) => /!\[P1 Badge\]|\bP1-orange\b|\*\*(?:🟠|🔴)\s*(?:Major|Critical)\*\*/.test(String(body ?? ""));

/** The reviewers whose inline findings the gate reads. */
export const GATE_REVIEWERS = ["chatgpt-codex-connector[bot]", "coderabbitai[bot]"];

/**
 * A CI run that ended without a verdict on the patch: cancelled, timed out,
 * never started. That is the runner's trouble, not the patch's, and closing the
 * PR for it would throw away a good attempt (Codex, #356). It runs once more; a
 * second such ending is a failure.
 */
const INCONCLUSIVE = new Set(["cancelled", "timed_out", "skipped", "neutral", "stale", "startup_failure"]);

/**
 * The gate's facts from what GitHub returned for one PR. Pure, so the
 * acceptance script runs it on real shapes.
 *
 * Only comments by `trusted` logins (the identities Mender and the gate post
 * as) count as a round report or a review request: the repository is public,
 * and anyone could otherwise post "<!-- mender:round -->" and turn a finding
 * into a merge (Codex, #356).
 *
 * @param {object} p
 * @param {string} p.head the head commit the gate inspects
 * @param {string} p.headAt its committer date
 * @param {{status:string, conclusion:string|null, id?:number, attempts?:number}|null} p.check the latest `check` run on the head, and how many there were
 * @param {{user:string, createdAt:string, body:string}[]} p.comments the PR's issue comments
 * @param {{user:string, sha:string, createdAt:string, body:string, reply:number|null}[]} p.inline review comments
 * @param {Set<string>} p.trusted
 * @param {string} p.roundMark
 * @param {string} p.reviewRequest
 * @param {(body:string, head:string) => string|null} p.summaryTable Codex's summary table reader (doer/review.mjs)
 * @param {number} [p.now]
 */
export function factsFrom({ head, headAt, check, comments, inline, trusted, roundMark, reviewRequest, summaryTable, now = Date.now() }) {
  const ci = !check ? "none" : check.status !== "completed" ? "pending" : check.conclusion === "success" ? "success"
    : INCONCLUSIVE.has(check.conclusion) && (check.attempts ?? 1) < 2 ? "inconclusive" : "failure";
  const onHead = inline.filter((c) => GATE_REVIEWERS.includes(c.user) && c.sha === head && !c.reply);
  const codex = comments.filter((c) => c.user === GATE_REVIEWERS[0]);
  const summary = codex.map((c) => codexReviewState(c.body)).find((s) => s?.commitSha === head);
  const table = codex.map((c) => summaryTable(c.body, head)).find(Boolean);
  const review = summary?.status === "completed" ? (summary.hasAnyFindings || onHead.length ? "findings" : "clean")
    : summary?.status === "running" || table === "running" ? "running"
      : table === "completed" ? (onHead.length ? "findings" : "clean")
        : onHead.length ? "findings" : null;
  const lastFindingAt = onHead.map((c) => c.createdAt).sort().at(-1) ?? "";
  const ours = comments.filter((c) => trusted.has(c.user));
  const rounds = ours.filter((c) => c.body.includes(roundMark));
  const asks = ours.filter((c) => c.body.toLowerCase().includes(reviewRequest) && c.createdAt > headAt).map((c) => c.createdAt).sort();
  return {
    ci,
    checkId: check?.id ?? null,
    review,
    p1: onHead.filter((c) => isP1(c.body)).length,
    roundsUsed: rounds.length,
    answered: Boolean(lastFindingAt) && rounds.some((c) => c.createdAt > lastFindingAt),
    askedMinutesAgo: asks.length ? (now - Date.parse(asks[0])) / 60_000 : null,
    findings: onHead.map((c) => `- ${c.body.split("\n").find((l) => l.trim() && !/Badge|^\*\*\S+ /.test(l)) ?? c.body.slice(0, 200)}`).join("\n"),
  };
}

/**
 * The gate's decision for one pull request.
 *
 * @param {object} f
 * @param {"success"|"failure"|"inconclusive"|"pending"|"none"} f.ci the `check` job on the head
 * @param {"clean"|"findings"|"running"|null} f.review the reviewer's verdict on THIS head
 * @param {number} f.p1 P1 findings the reviewer left on this head
 * @param {number} f.roundsUsed fix rounds Mender has answered on this PR
 * @param {boolean} f.answered Mender answered (pushed or reported) after the reviewer's last finding on this head
 * @param {number|null} f.askedMinutesAgo minutes since the reviewer was asked about this head; null = not asked
 * @returns {{action:"merge"|"ask"|"wait"|"close"|"rerun", reason:string}}
 */
export function gateDecision({ ci, review, p1 = 0, roundsUsed = 0, answered = false, askedMinutesAgo = null }) {
  if (ci === "none" || ci === "pending") return { action: "wait", reason: "CI has not finished on this head" };
  if (ci === "inconclusive") return { action: "rerun", reason: "CI ended without a verdict on this head (cancelled or timed out); it runs once more" };
  if (ci === "failure") return { action: "close", reason: "CI failed on this head" };
  if (review === "clean") return { action: "merge", reason: "CI green and the review of this head found nothing" };
  if (review === "findings") {
    if (p1 === 0 && (roundsUsed >= 1 || answered)) return { action: "merge", reason: "CI green; a round was answered and nothing above P2 is left" };
    if (p1 > 0 && roundsUsed >= MAX_GATE_ROUNDS) return { action: "close", reason: `a P1 finding is still open after ${MAX_GATE_ROUNDS} rounds` };
    if (p1 > 0 && answered) return { action: "close", reason: "Mender answered a P1 finding without fixing it" };
    return { action: "wait", reason: "the review found something; Mender's round comes next" };
  }
  if (review === "running") return { action: "wait", reason: "the review of this head is running" };
  if (askedMinutesAgo === null) return { action: "ask", reason: "nobody has asked for a review of this head" };
  if (askedMinutesAgo >= REVIEW_SILENCE_MINUTES) {
    return { action: "merge", reason: `CI green and the reviewer has been silent for ${Math.round(askedMinutesAgo)} minutes` };
  }
  return { action: "wait", reason: "the review was asked for and has not come yet" };
}

// ─── The watch (CHE-486 part 4) ──────────────────────────────────────────────
//
// What protects production after a merge nobody read. A new error in production
// (the monitor's "[Prod error]" ticket) or a new kind of failed check ("[Checker
// failure]") wakes the watch with the time it was seen. If it appeared within
// WATCH_MINUTES of a deploy that carried only Mender's changes, those changes are
// reverted on main and their tickets go back to Mender with the reason. Anything
// else — no recent deploy, or a deploy with a person's change in it too — is not
// the watch's to judge: the ticket stays, and Mender is woken for it.

/** How long after a deploy a new error is taken as that deploy's. */
export const WATCH_MINUTES = 30;

/**
 * Why the next merge must wait, or null when it may go. One merge, one deploy,
 * one whole watch: main is not deploying, and the last deploy has been watched
 * for WATCH_MINUTES. Otherwise two merges share a deploy, or an error meant for
 * the first lands after the second and the wrong change is reverted.
 *
 * @param {{deploying:boolean, deployedAt:number|null, now?:number}} m
 */
export function mergeHold({ deploying, deployedAt, now = Date.now() }) {
  if (deploying) return "main is still deploying the last merge";
  if (!deployedAt) return null;
  const left = WATCH_MINUTES - (now - deployedAt) / 60_000;
  return left > 0 ? `the last deploy is ${Math.round(WATCH_MINUTES - left)} of its ${WATCH_MINUTES} watched minutes in` : null;
}

/**
 * @param {object} w
 * @param {number} w.seenAt when the error was first seen (ms)
 * @param {{sha:string, deployedAt:number}|null} w.deploy the deploy that put main's current code in production
 * @param {{sha:string, pr:number|null, branch:string|null}[]|null} w.commits what that deploy carried that the one before it did not; null = unknown
 * @param {(branch:string|null) => boolean} w.isMender
 * @returns {{action:"revert"|"keep", reason:string, revert:{sha:string, pr:number|null, branch:string|null}[]}}
 */
export function watchDecision({ seenAt, deploy, commits, isMender }) {
  const keep = (reason) => ({ action: "keep", reason, revert: [] });
  if (!deploy) return keep("no deploy of main was found");
  const minutes = (seenAt - deploy.deployedAt) / 60_000;
  if (minutes < 0) return keep("the error was seen before the latest deploy");
  if (minutes > WATCH_MINUTES) return keep(`the latest deploy was ${Math.round(minutes)} minutes before the error, past the ${WATCH_MINUTES}-minute watch`);
  if (!commits) return keep("the deploy before the latest one was not found, so what the latest one carried is unknown");
  const mender = commits.filter((c) => isMender(c.branch));
  if (!mender.length) return keep("the latest deploy carried no change of Mender's");
  if (mender.length < commits.length) {
    return keep(`the latest deploy, ${Math.round(minutes)} minutes before the error, carried Mender's ${mender.map((c) => `#${c.pr}`).join(", ")} and other changes too — not the watch's to judge`);
  }
  return { action: "revert", reason: `it appeared ${Math.round(minutes)} minutes after the deploy that carried only Mender's ${mender.map((c) => `#${c.pr}`).join(", ")}`, revert: mender };
}
