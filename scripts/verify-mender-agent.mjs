// CHE-445: Mender, the OpenCode agent that takes CHE tickets. What must hold
// whatever the model does: it takes one ticket at a time, oldest first; a
// ticket tried twice without a PR steps aside; a PR gets at most three review
// rounds; the checks run before anything is pushed; and nothing merges.
//
// Usage: node scripts/verify-mender-agent.mjs

import { execFileSync } from "node:child_process";
import { codexReviewState, factsFrom, gateDecision, isP1, MAX_GATE_ROUNDS, REVIEW_SILENCE_MINUTES } from "./mender/gate.mjs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALARM_TITLE, CHECKS, agentEnv, checksInFlight, answerOf, branchFor, chooseTicket, forbiddenPaths, isFeedback, keyShortfall, ourRefusal, pendingReview, readEvent, report, runAgent, stagedPaths, stranded, turnError, uiPaths, usableAnswer, validBranch } from "./mender/agent.mjs";

let bad = 0;
const check = (name, ok, detail = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
};
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const issue = (identifier, createdAt, type = "unstarted", attempts = 0) => ({
  identifier, createdAt, state: { type },
  comments: { nodes: Array.from({ length: attempts }, () => ({ body: "<!-- mender:attempt -->\nno PR" })) },
});
check("the oldest labelled ticket goes first",
  chooseTicket([issue("CHE-2", "2026-10-02"), issue("CHE-1", "2026-10-01")])?.identifier === "CHE-1");
check("a ticket already in progress or in review is not taken again",
  chooseTicket([issue("CHE-1", "2026-10-01", "started"), issue("CHE-2", "2026-10-02")])?.identifier === "CHE-2");
check("a ticket tried twice without a PR steps aside",
  chooseTicket([issue("CHE-1", "2026-10-01", "unstarted", 2), issue("CHE-2", "2026-10-02")])?.identifier === "CHE-2");
check("nothing labelled → nothing taken", chooseTicket([]) === null);
// Ticket rules (owner, 2026-10-12).
const inEpic = (identifier, createdAt, epicLabels) => ({ ...issue(identifier, createdAt), parent: { identifier: "CHE-100", labels: { nodes: epicLabels.map((name) => ({ name })) } } });
check("a ticket in an epic its lead has not given to Mender is not taken",
  chooseTicket([inEpic("CHE-1", "2026-10-01", ["shopify"]), issue("CHE-2", "2026-10-02")])?.identifier === "CHE-2");
check("…once the epic carries the label, it is",
  chooseTicket([inEpic("CHE-1", "2026-10-01", ["mender"]), issue("CHE-2", "2026-10-02")])?.identifier === "CHE-1");
const split = (identifier, createdAt, types) => ({ ...issue(identifier, createdAt), children: { nodes: types.map((type) => ({ state: { type } })) } });
check("a ticket Mender split waits while a part is open, and comes back when all are closed",
  chooseTicket([split("CHE-1", "2026-10-01", ["completed", "unstarted"]), issue("CHE-2", "2026-10-02")])?.identifier === "CHE-2" &&
    chooseTicket([split("CHE-1", "2026-10-01", ["completed", "canceled"])])?.identifier === "CHE-1");
check("a part still in triage counts as open (the tracker contract)",
  chooseTicket([split("CHE-1", "2026-10-01", ["triage"])]) === null);
check("an answer with homework or our machinery is not used; a plain one is",
  !(await usableAnswer("Answer: please verify this in a real browser yourself.")) &&
    !(await usableAnswer("Answer: our test browser could not click it.")) &&
    !(await usableAnswer("Answer: Claude Sonnet concluded the label is right.")) &&
    !(await usableAnswer("Answer: the check cost $4.20 and used 10,000 tokens.")) &&
    (await usableAnswer("Answer: the store has no published products, so there is nothing to scan.")));
check("a change to screens or emails is marked ui; other code is not",
  uiPaths(["src/app/(app)/health/apps/[appId]/page.tsx", "src/components/verdict-view.tsx", "src/lib/email.ts", "src/lib/home-copy.ts", "src/lib/invite-mail.ts",
    "src/lib/step-cause.ts", "scripts/verify-x.ts", "src/app/api/x/route.ts"]).length === 5);
check("every open part of a split is put in Mender's queue",
  /issueAddLabel\(id:\$i,labelId:\$l\)/.test(read("scripts/mender/agent.mjs")) && /if \(parts\.length\) \{/.test(read("scripts/mender/agent.mjs")));
check("only a [Pilot feedback] ticket is answered, and only with an Answer: line",
  isFeedback("[Pilot feedback] app · step: x") && !isFeedback("[Checker gap] x") &&
    answerOf("report\nAnswer: the store has no products.\nMENDER_ANSWERED") === "Answer: the store has no products." && answerOf("no answer") === null);

const c = (user, createdAt) => ({ user, createdAt, body: "src/x.ts:1 rename this" });
check("CodeRabbit comments after the last commit are a review round",
  pendingReview({ reviewComments: [c("coderabbitai[bot]", "2026-10-07T12:00Z")], lastCommitAt: "2026-10-07T11:00Z", roundsUsed: 0 }).length === 1);
check("…comments the last push already answered are not",
  pendingReview({ reviewComments: [c("coderabbitai[bot]", "2026-10-07T10:00Z")], lastCommitAt: "2026-10-07T11:00Z", roundsUsed: 0 }).length === 0);
// CHE-486: Codex is the gate's reviewer, so its findings start a round too.
check("…and so do Codex's, which the gate asks for",
  pendingReview({ reviewComments: [c("chatgpt-codex-connector[bot]", "2026-10-07T12:00Z")], lastCommitAt: "2026-10-07T11:00Z", roundsUsed: 0 }).length === 1);
check("…nor anyone else's: a person's or a workflow's comment is not a reviewer's finding",
  pendingReview({ reviewComments: [c("sorokinvj", "2026-10-07T12:00Z"), c("github-actions[bot]", "2026-10-07T12:00Z")], lastCommitAt: "2026-10-07T11:00Z", roundsUsed: 0 }).length === 0);
check("three rounds and the PR waits for a person",
  pendingReview({ reviewComments: [c("coderabbitai[bot]", "2026-10-07T12:00Z")], lastCommitAt: "2026-10-07T11:00Z", roundsUsed: 3 }).length === 0);

check("a review round that changed nothing still answers what it read",
  pendingReview({ reviewComments: [c("coderabbitai[bot]", "2026-10-07T12:00Z")], lastCommitAt: "2026-10-07T11:00Z", lastRoundAt: "2026-10-07T12:30Z", roundsUsed: 1 }).length === 0);

check("a patch touching the workflows or Mender itself is refused",
  forbiddenPaths([".github/workflows/x.yml", "scripts/mender/agent.mjs", "opencode.json", ".mender/MENDER.md", "CLAUDE.md", "src/lib/a.ts"]).length === 5);
// On a real repository: a workflow moved OUT of .github/ and one added under a
// name git quotes must both be caught (git apply --numstat names only a
// rename's destination, which is how the first version let a move through).
{
  const dir = mkdtempSync(join(tmpdir(), "mender-paths-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  writeFileSync(join(dir, ".github/workflows/ci.yml"), "a\n");
  writeFileSync(join(dir, "a.ts"), "x\n");
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "i");
  git("mv", ".github/workflows/ci.yml", "moved-ci.yml");
  writeFileSync(join(dir, ".github/workflows/réview.yml"), "z\n");
  writeFileSync(join(dir, "a.ts"), "y\n");
  git("add", "-A");
  const bad = forbiddenPaths(stagedPaths(dir)).sort().join(", ");
  check("a workflow moved out and one with a quoted name are both refused",
    bad === ".github/workflows/ci.yml, .github/workflows/réview.yml", bad);
  rmSync(dir, { recursive: true, force: true });
}
const started = (identifier) => ({ ...issue(identifier, "2026-10-01"), state: { type: "started", name: "In Progress" } });
check("a claimed ticket with no open PR is released; one with a PR is not",
  stranded([started("CHE-1"), started("CHE-2"), issue("CHE-3", "2026-10-01")], new Set(["CHE-2"])).map((i) => i.identifier).join() === "CHE-1");
check("…nor one another session works on inside an epic not given to Mender",
  stranded([{ ...started("CHE-4"), parent: { identifier: "CHE-100", labels: { nodes: [] } } }], new Set()).length === 0);
check("…an ordinary change is not", forbiddenPaths(["src/lib/a.ts", "scripts/verify-x.ts", "prisma/schema.prisma"]).length === 0);
check("the model's environment holds no GitHub token",
  Object.keys(agentEnv({ GH_TOKEN: "x", GITHUB_TOKEN: "y", MENDER_GH_TOKEN: "z", LINEAR_API_KEY: "k" })).join() === "LINEAR_API_KEY");

check("the personal token pushes only to mender/che-* branches",
  validBranch("mender/che-423-a-run-stays-queued") && !validBranch("main") && !validBranch("mender/../main") &&
    !validBranch("refs/heads/main") && !validBranch("mender/che-1 main"));
check("a ticket's branch is a valid one, whatever its title",
  validBranch(branchFor({ identifier: "CHE-9", title: "«Quoted» — weird/title!!" })) && validBranch(branchFor({ identifier: "CHE-9", title: "!!!" })));

// 2026-10-14: the key reached its $30 limit on CHE-480's first turn; OpenCode
// reported every refusal in an `error` event Mender never read, and two tickets
// were marked "unfinished" with an empty report. The event below is what
// opencode-ai@1.18.35 printed for a refused key (headers dropped).
const refused = (statusCode, message, metadata) => ({ type: "error", sessionID: "ses_x",
  error: { name: "APIError", data: { message, statusCode, isRetryable: false, responseBody: JSON.stringify({ error: { message, code: statusCode, ...(metadata ? { metadata } : {}) } }) } } });
const turn = (events) => events.reduce(readEvent, { session: null, cost: 0, steps: 0, text: "", error: null });
check("OpenCode's error event is read: 401, 402 and 403 are refusals; a 400 is not",
  turn([refused(401, "User not found.")]).error?.refused === true &&
    [402, 403].every((s) => turnError(refused(s, "Key limit exceeded"))?.refused === true) &&
    turnError(refused(400, "context length exceeded"))?.refused === false &&
    turnError({ type: "step_finish", part: { cost: 0.1 } }) === null);
check("…OpenRouter's own word that the key or account is spent makes it ours; a guardrail's 403 does not (Codex, #353)",
  turnError(refused(402, "Insufficient credits"))?.ours === true &&
    turnError(refused(403, "Key limit exceeded", { limit_source: "openrouter_key_limit" }))?.ours === true &&
    turnError(refused(403, "Flagged by the content filter"))?.ours === false);
check("…and a turn that also did work keeps its steps and cost",
  (() => { const t = turn([{ type: "step_finish", sessionID: "s", part: { cost: 0.69 } }, refused(403, "Key limit exceeded")]);
    return t.steps === 1 && t.cost === 0.69 && t.error?.status === 403; })());
{
  const healthy = async () => ({ why: null });
  const spent = async () => ({ why: "the OpenRouter key has $0.00 left of its $30 limit" });
  let asked = 0;
  const counting = async () => { asked++; return { why: null }; };
  const guardrail = turnError(refused(403, "Flagged by the content filter"));
  check("a guardrail's 403 with a key that can pay is the ticket's, and counts as its attempt",
    (await ourRefusal(guardrail, healthy)) === null);
  check("…the same 403 with a spent key is ours",
    /\$0\.00 left[\s\S]*HTTP 403: Flagged/.test((await ourRefusal(guardrail, spent)) ?? ""));
  check("…and a 402 is ours without asking the key",
    /HTTP 402/.test((await ourRefusal(turnError(refused(402, "Insufficient credits")), counting)) ?? "") && asked === 0);
}
{
  let calls = 0;
  const r = await runAgent("ticket", async () => { calls++; return { session: "s", cost: 0, steps: 0, text: "", error: turnError(refused(403, "Key limit exceeded")) }; });
  check("a refusal ends the run at once, not after eight empty turns",
    calls === 1 && r.status === "refused" && r.error.status === 403, `${calls} calls, ${r.status}`);
  calls = 0;
  const other = await runAgent("ticket", async () => { calls++; return { session: "s", cost: 0, steps: 0, text: "", error: turnError(refused(400, "context length exceeded")) }; });
  check("…any other error is kept, so the ticket says why the report is empty",
    other.status === "unfinished" && calls > 1 && /OpenCode stopped: 400 context length exceeded/.test(report(other)), report(other));
}
check("a key that cannot pay for one more ticket stops the tick; one that can, or has no limit, does not",
  /\$0\.00 left of its \$30 limit \(it never resets\)/.test(keyShortfall({ limit: 30, limit_remaining: 0, limit_reset: null }, 5) ?? "") &&
    keyShortfall({ limit: 100, limit_remaining: 4.99, limit_reset: "monthly" }, 5) !== null &&
    keyShortfall({ limit: 100, limit_remaining: 71.84, limit_reset: "monthly" }, 5) === null &&
    keyShortfall({ limit: null, limit_remaining: null }, 5) === null);

const agent = read("scripts/mender/agent.mjs");
const workSrc = agent.slice(agent.indexOf("async function work()"), agent.indexOf("// ─── Publishing"));
check("the key is asked before any ticket is claimed or released",
  workSrc.indexOf("await keyServes();") > 0 && workSrc.indexOf("await keyServes();") < workSrc.indexOf("findWork()"));
const ticketPath = workSrc.slice(workSrc.indexOf("const { issue } = job;"));
const stopped = ticketPath.slice(ticketPath.indexOf("if (ours) {"), ticketPath.indexOf("const patch = r.status"));
check("a ticket stopped by the key goes back to Todo without counting as an attempt, and the tick fails",
  /const ours = r\.status === "refused" \? await ourRefusal\(r\.error\) : null;/.test(ticketPath) &&
    /setState\(issue\.id, "Todo"\);\s*return alarm\(/.test(stopped) && !/ATTEMPT_MARK/.test(stopped) &&
    /async function alarm\([\s\S]*?throw new Error/.test(agent));
check("…a refusal that is the ticket's goes on to publish, which counts the attempt",
  /if \(r\.status === "refused"\) r\.status = `refused by OpenRouter/.test(ticketPath) &&
    /const ours = r\.status === "refused" \? await ourRefusal\(r\.error\) : null;\s*\n\s*if \(ours\) return alarm\(/.test(workSrc));
check("the alarm is one open ticket, never in Mender's own queue",
  ALARM_TITLE.startsWith("[Mender]") && /if \(!\(await openAlarm\(\)\)\)/.test(agent) &&
    !/issueCreate\(input:\{[^}]*labelIds/.test(agent));
check("…and Mender closes it only after the model has served a request, not on the key's numbers (Codex, #353)",
  /const open = await openAlarm\(\);\s*\n\s*if \(!open\) return;\s*\n\s*const still = await modelAnswers\(\);\s*\n\s*if \(still\) return alarm\(still\);[\s\S]*?setState\(open\.id, "Done"\)/.test(agent) &&
    /chat\/completions[\s\S]*?max_tokens: 1/.test(agent));
check("…and a tick runs while it is open, even with nothing queued (Codex, #353)",
  /async function peek\(\) \{[\s\S]*?const yes = [^\n]*await openAlarm\(\)/.test(agent));

const publishSrc = agent.slice(agent.indexOf("async function publish()"));
check("publishing takes its targets from GitHub and Linear, not from the artifact the model could rewrite",
  /const target = await trustedTarget\(job\);/.test(publishSrc) &&
    publishSrc.indexOf("trustedTarget(job)") < publishSrc.indexOf("stage(job.baseSha)") &&
    !/job\.pr\.(headRefName|url)|job\.issue\.(identifier|title|url)|job\.ticket/.test(publishSrc));
check("every page of review comments is read", /"--paginate"/.test(agent) && /per_page=100/.test(agent));
// CHE-486 (owner, 2026-10-15): Mender's PRs merge themselves — but only through
// the gate, which runs no model, and only on the gate's own decision.
const gateSrc = agent.slice(agent.indexOf("// ─── The merge gate (CHE-486)"), agent.indexOf("if (import.meta.url"));
const beforeGate = agent.slice(0, agent.indexOf("// ─── The merge gate (CHE-486)"));
check("only the gate merges, and only when its decision says merge",
  !/"merge"/.test(beforeGate.replace(/\/\/.*$/gm, "")) && /if \(d\.action === "merge"\) await mergePr\(pr, d\.reason\);/.test(gateSrc) &&
    /async function mergePr[\s\S]*?gh\(\["pr", "merge", String\(pr\.number\), "--squash", "--delete-branch", "--match-head-commit", pr\.headRefOid\]\)/.test(gateSrc) &&
    !/opencode|runAgent\(/.test(gateSrc));
check("AGENTS.md's sequence runs before the patch is taken: prisma generate, both typechecks, lint, verify:all",
  ["generate", "typecheck", "agent:typecheck", "lint", "verify:all"].every((s) => CHECKS.some(([, a]) => a.includes(s))) &&
    /const failing = failingChecks\(\);\s*\n\s*if \(!failing\) return \{ status: "done"/.test(agent) &&
    /r\.status === "done" \? patchFrom\(baseSha\)/.test(agent));
check("CodeRabbit is asked when a PR opens; Codex only by the gate, with the owner's token",
  /@coderabbitai review/.test(agent) && !/@codex/.test(agent) && /function askReview[\s\S]*?CODEX_REVIEW_TOKEN[\s\S]*?REVIEW_REQUEST/.test(gateSrc));
check("a PR that touches screens or emails is labelled ui, opened or reviewed",
  (publishSrc.match(/markUi\((url|pr\.url), paths\)/g) ?? []).length === 2);
check("an answer closes the ticket as Canceled only on a feedback ticket with no change, once the language rules pass",
  /r\.status === "answered" && !job\.changed && isFeedback\(issue\.title\) \? answerOf\(r\.text\) : null/.test(publishSrc) &&
    publishSrc.indexOf('setState(issue.id, "Canceled")') > publishSrc.indexOf("if (answer && (await usableAnswer(answer)))"));
check("the answer comment is the answer alone (the author reads all of it)", /await comment\(issue\.id, answer\);/.test(publishSrc));
check("a split is believed only when Linear shows an open part",
  /const parts = d\.issue\.children\.nodes\.filter\(\(c\) => OPEN\.includes\(c\.state\.type\)\);/.test(publishSrc));
check("publishing runs on Node 22, which imports the language rules",
  /actions\/setup-node@v4\s*\n\s*with:\s*\n\s*node-version: 22/.test(read(".github/workflows/mender-agent.yml").split(/\n  publish:\n/)[1] ?? ""));
check("every pilot feedback report is filed for Mender",
  /labelNames: \["pilot-feedback", "mender"\]/.test(read("src/agent/feedback-filing.ts")));

const cfg = JSON.parse(read("opencode.json"));
check("the agent reads Linear and Notion", cfg.mcp?.linear?.enabled && cfg.mcp?.notion?.enabled);
check("its rules are loaded", (cfg.instructions ?? []).includes(".mender/MENDER.md"));

const wf = read(".github/workflows/mender-agent.yml");
check("one tick at a time", /concurrency:\s*\n\s*group: mender-agent/.test(wf));
// Tempo (CHE-445): GitHub fired the schedule every 4–7 h.
check("a CodeRabbit or Codex review on a mender/ PR starts its round at once",
  /pull_request_review:\s*\n\s*types: \[submitted\]/.test(wf) &&
    /startsWith\(github\.event\.pull_request\.head\.ref, 'mender\/'\) &&\s*\n\s*\(github\.event\.review\.user\.login == 'coderabbitai\[bot\]' \|\| github\.event\.review\.user\.login == 'chatgpt-codex-connector\[bot\]'\)/.test(wf));
check("…and runs main's files, never the PR's",
  /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/.test(wf));
check("an idle tick stops at peek, before npm ci",
  wf.indexOf("agent.mjs peek") > 0 && wf.indexOf("agent.mjs peek") < wf.indexOf("run: npm ci") &&
    /if: steps\.peek\.outputs\.work == 'yes'\s*\n\s*run: npm ci/.test(wf) && /if: needs\.work\.outputs\.work == 'yes'/.test(wf));
check("a publish with more work queued starts the next tick", /publish: \(\) => publish\(\)\.then\(chainNext\)/.test(agent) &&
  /"workflow", "run", "mender-agent\.yml"/.test(agent));
const [workJob, publishJob] = wf.split(/\n  publish:\n/);
check("the model's job keeps no credential in the checkout and holds no writing token",
  /persist-credentials: false/.test(workJob) && !/MENDER_GH_TOKEN/.test(workJob) && /node scripts\/mender\/agent\.mjs work/.test(workJob));
check("publishing runs on a fresh machine from main, after the model's job",
  /needs: work/.test(publishJob ?? "") && /ref: main/.test(publishJob ?? "") && /MENDER_GH_TOKEN/.test(publishJob ?? "") && !/opencode/.test(publishJob ?? ""));
check("the model is paid on OpenRouter, not the Claude subscription",
  /OPENROUTER_API_KEY/.test(wf) && !/CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY/.test(wf));

// ─── The gate (CHE-486) ──────────────────────────────────────────────────────
const G = (f) => gateDecision({ ci: "success", review: null, p1: 0, roundsUsed: 0, answered: false, askedMinutesAgo: null, ...f }).action;
check("no merge before CI is green on the head; a red head is closed and the ticket goes back",
  G({ ci: "pending", review: "clean" }) === "wait" && G({ ci: "none", review: "clean" }) === "wait" && G({ ci: "failure", review: "clean" }) === "close");
check("green and a clean review merges", G({ review: "clean" }) === "merge");
check("no review yet: ask; asked and silent past the limit: merge anyway (the watch protects); asked recently: wait",
  G({}) === "ask" && G({ askedMinutesAgo: REVIEW_SILENCE_MINUTES + 1 }) === "merge" && G({ askedMinutesAgo: 5 }) === "wait" && G({ review: "running", askedMinutesAgo: 90 }) === "wait");
check("findings: one round first; after it, P2 and lower do not hold the merge",
  G({ review: "findings" }) === "wait" && G({ review: "findings", roundsUsed: 1 }) === "merge" && G({ review: "findings", answered: true }) === "merge");
check("a P1 waits for Mender's rounds, and after the last one, or an answer that did not fix it, the PR is closed — never merged",
  G({ review: "findings", p1: 1, roundsUsed: 2 }) === "wait" && G({ review: "findings", p1: 1, roundsUsed: MAX_GATE_ROUNDS }) === "close" &&
    G({ review: "findings", p1: 1, answered: true }) === "close" && G({ review: "findings", p1: 1, roundsUsed: 1 }) !== "merge");
// Codex's summary comment as it really reads (PR #353, 2026-10-15).
const SUMMARY = '<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 {"code_review":{"commit_sha":"094aa520bae21b348acc7f83d90816279eef4ef1","has_any_findings":null,"has_unresolved_findings":null,"status":"running"},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}} -->\n\n## Codex Review Summary';
check("Codex's machine-readable review state is read for its commit",
  codexReviewState(SUMMARY)?.commitSha === "094aa520bae21b348acc7f83d90816279eef4ef1" && codexReviewState(SUMMARY)?.status === "running" &&
    codexReviewState("## Codex Review Summary") === null);
check("a P1 badge is a P1; a P2 is not",
  isP1("**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Redact query credentials") &&
    !isP1("**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Keep alarm recovery"));
// Codex, #356: a merge starts a deploy, and a deploy doubles a running website
// check's cost; the gate counts production's running checks first, with the
// deploy gate's own classification, and fails closed.
{
  const env = { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" };
  let sql = "";
  const answer = (n) => async (_url, init) => { sql = JSON.parse(init.body).sql; return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results: [{ n }] }] }) }; };
  const two = await checksInFlight(env, answer(2));
  check("the checks running in production are counted with LIVE_RUN_STATUSES",
    two === 2 && /status IN \('queued', 'connecting'.*'writing'\)/.test(sql), sql);
  const refused = await checksInFlight(env, async () => ({ ok: false, status: 403, json: async () => ({ success: false }) })).then(() => "answered", (e) => e.message);
  const blind = await checksInFlight({}, answer(0)).then(() => "answered", (e) => e.message);
  check("…and an unanswerable question is not permission to merge", /D1 refused/.test(refused) && /no Cloudflare credentials/.test(blind), `${refused} | ${blind}`);
}
check("the merge waits for production to be idle, then is pinned to the head the gate read",
  /async function mergePr[\s\S]*?const running = await checksInFlight\(\);[\s\S]*?"--match-head-commit", pr\.headRefOid\]/.test(gateSrc));
check("closing a PR returns the ticket without spending another attempt",
  /async function closePr[\s\S]*?await comment\(issue\.id, `\*\*Mender's pull request/.test(gateSrc) && !/async function closePr[\s\S]*?ATTEMPT_MARK[\s\S]*?\nfunction askReview/.test(gateSrc.replace(/\/\/.*$/gm, "")));
// Codex, #356 round 2: both reviewers' findings count, and only Mender's own
// identities can report a round or ask for a review — the repository is public.
{
  const head = "abc1234def";
  const base = { head, headAt: "2026-10-15T20:00:00Z", check: { status: "completed", conclusion: "success" }, roundMark: "<!-- mender:round -->",
    reviewRequest: "@codex review", summaryTable: () => null, trusted: new Set(["sorokinvj"]), now: Date.parse("2026-10-15T22:00:00Z") };
  const cr = { user: "coderabbitai[bot]", sha: head, createdAt: "2026-10-15T20:30:00Z", reply: null,
    body: "**🎯 Functional Correctness** | **🟠 Major** | **⚡ Quick win**\n\n**Major: the merge ignores X.**" };
  const withCr = factsFrom({ ...base, comments: [], inline: [cr] });
  check("a CodeRabbit Major on the head is a finding that holds the merge, even with Codex silent",
    withCr.review === "findings" && withCr.p1 === 1 && gateDecision(withCr).action !== "merge", JSON.stringify(withCr));
  const forged = factsFrom({ ...base, inline: [{ ...cr, body: "**🟡 Minor** | x" }], comments: [
    { user: "a-stranger", createdAt: "2026-10-15T21:00:00Z", body: "<!-- mender:round -->\nRound 1: pushed." },
    { user: "a-stranger", createdAt: "2026-10-15T20:10:00Z", body: "@codex review" },
  ] });
  check("a stranger's round marker or review request counts for nothing",
    forged.roundsUsed === 0 && !forged.answered && forged.askedMinutesAgo === null && gateDecision(forged).action === "wait", JSON.stringify(forged));
  const ours = factsFrom({ ...base, inline: [{ ...cr, body: "**🟡 Minor** | x" }], comments: [
    { user: "sorokinvj", createdAt: "2026-10-15T21:00:00Z", body: "<!-- mender:round -->\nRound 1: pushed." },
  ] });
  check("…Mender's own round does, and a Minor after it does not hold the merge", ours.roundsUsed === 1 && ours.answered && gateDecision(ours).action === "merge");
}
check("a closed PR's ticket left In Review is settled by the next gate run — merged: Done, closed: Todo — and only from In Review",
  /async function reconcileMerged[\s\S]*?"--state", "closed"[\s\S]*?if \(d\.issue\?\.state\?\.name !== "In Review"\) continue;[\s\S]*?if \(pr\.mergedAt\) \{[\s\S]*?setState\(d\.issue\.id, "Done"\)[\s\S]*?setState\(d\.issue\.id, "Todo"\)/.test(gateSrc) &&
    /await reconcileMerged\(\);/.test(gateSrc));
check("a check stuck for hours holds no merge (the deploy gate's staleness rule)", /createdAt > strftime\('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 hours'\)/.test(agent));
check("one PR the gate cannot decide never holds the others", /try \{[\s\S]*?const d = gateDecision\(facts\);[\s\S]*?\} catch \(e\) \{\s*\n\s*failed\+\+;/.test(gateSrc));
const gwf = read(".github/workflows/mender-gate.yml");
check("the gate runs on events, never on a schedule (owner: no crons)",
  !/schedule:|cron:/.test(gwf) && /workflow_run:\s*\n\s*workflows: \["CI \/ Deploy", "Mender"\]/.test(gwf) && /issue_comment:/.test(gwf) &&
    /github\.event\.comment\.user\.login == 'chatgpt-codex-connector\[bot\]'/.test(gwf) && /startsWith\(github\.event\.workflow_run\.head_branch, 'mender\/'\)/.test(gwf));
check("…from main's files, with the personal token (a GITHUB_TOKEN merge starts no deploy), and no model",
  /ref: main/.test(gwf) && /GH_TOKEN: \$\{\{ secrets\.MENDER_GH_TOKEN \}\}/.test(gwf) && /agent\.mjs gate/.test(gwf) && !/opencode|OPENROUTER/.test(gwf) &&
    /group: mender-gate/.test(gwf));

console.log(bad === 0 ? "\nall pass" : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
