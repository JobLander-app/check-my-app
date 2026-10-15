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
 * @param {{status:string, conclusion:string|null}|null} p.check the latest `check` run on the head
 * @param {{user:string, createdAt:string, body:string}[]} p.comments the PR's issue comments
 * @param {{user:string, sha:string, createdAt:string, body:string, reply:number|null}[]} p.inline review comments
 * @param {Set<string>} p.trusted
 * @param {string} p.roundMark
 * @param {string} p.reviewRequest
 * @param {(body:string, head:string) => string|null} p.summaryTable Codex's summary table reader (doer/review.mjs)
 * @param {number} [p.now]
 */
export function factsFrom({ head, headAt, check, comments, inline, trusted, roundMark, reviewRequest, summaryTable, now = Date.now() }) {
  const ci = !check ? "none" : check.status !== "completed" ? "pending" : check.conclusion === "success" ? "success" : "failure";
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
 * @param {"success"|"failure"|"pending"|"none"} f.ci the `check` job on the head
 * @param {"clean"|"findings"|"running"|null} f.review the reviewer's verdict on THIS head
 * @param {number} f.p1 P1 findings the reviewer left on this head
 * @param {number} f.roundsUsed fix rounds Mender has answered on this PR
 * @param {boolean} f.answered Mender answered (pushed or reported) after the reviewer's last finding on this head
 * @param {number|null} f.askedMinutesAgo minutes since the reviewer was asked about this head; null = not asked
 * @returns {{action:"merge"|"ask"|"wait"|"close", reason:string}}
 */
export function gateDecision({ ci, review, p1 = 0, roundsUsed = 0, answered = false, askedMinutesAgo = null }) {
  if (ci === "none" || ci === "pending") return { action: "wait", reason: "CI has not finished on this head" };
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
