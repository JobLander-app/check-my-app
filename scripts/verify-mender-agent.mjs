// CHE-445: Mender, the OpenCode agent that takes CHE tickets. What must hold
// whatever the model does: it takes one ticket at a time, oldest first; a
// ticket tried twice without a PR steps aside; a PR gets at most three review
// rounds; the checks run before anything is pushed; and nothing merges.
//
// Usage: node scripts/verify-mender-agent.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALARM_TITLE, CHECKS, agentEnv, answerOf, branchFor, chooseTicket, forbiddenPaths, isFeedback, keyShortfall, pendingReview, readEvent, report, runAgent, stagedPaths, stranded, turnError, uiPaths, usableAnswer, validBranch } from "./mender/agent.mjs";

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
check("…nor anyone else's (Codex is out of this loop)",
  pendingReview({ reviewComments: [c("chatgpt-codex-connector[bot]", "2026-10-07T12:00Z")], lastCommitAt: "2026-10-07T11:00Z", roundsUsed: 0 }).length === 0);
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
const refused = (statusCode, message) => ({ type: "error", sessionID: "ses_x",
  error: { name: "APIError", data: { message, statusCode, isRetryable: false, responseBody: JSON.stringify({ error: { message, code: statusCode } }) } } });
const turn = (events) => events.reduce(readEvent, { session: null, cost: 0, steps: 0, text: "", error: null });
check("OpenCode's error event is read: a refused key is the key's fault, not the ticket's",
  turn([refused(401, "User not found.")]).error?.keyRefused === true &&
    [402, 403].every((s) => turnError(refused(s, "Key limit exceeded"))?.keyRefused === true) &&
    turnError(refused(400, "context length exceeded"))?.keyRefused === false &&
    turnError({ type: "step_finish", part: { cost: 0.1 } }) === null);
check("…and a turn that also did work keeps its steps and cost",
  (() => { const t = turn([{ type: "step_finish", sessionID: "s", part: { cost: 0.69 } }, refused(403, "Key limit exceeded")]);
    return t.steps === 1 && t.cost === 0.69 && t.error?.status === 403; })());
{
  let calls = 0;
  const r = await runAgent("ticket", async () => { calls++; return { session: "s", cost: 0, steps: 0, text: "", error: turnError(refused(403, "Key limit exceeded")) }; });
  check("a refused key ends the run on its first refusal, not after eight empty turns",
    calls === 1 && r.status === "key refused" && r.error.status === 403, `${calls} calls, ${r.status}`);
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
const stopped = workSrc.slice(workSrc.indexOf('if (r.status === "key refused") {'), workSrc.indexOf("const patch = r.status", workSrc.indexOf('if (r.status === "key refused") {')));
check("a ticket stopped by the key goes back to Todo without counting as an attempt, and the tick fails",
  /setState\(issue\.id, "Todo"\);\s*return alarm\(/.test(stopped) && !/ATTEMPT_MARK/.test(stopped) &&
    /async function alarm\([\s\S]*?throw new Error/.test(agent));
check("the alarm is one open ticket, never in Mender's own queue",
  ALARM_TITLE.startsWith("[Mender]") && /if \(!\(await openAlarm\(\)\)\)/.test(agent) &&
    !/issueCreate\(input:\{[^}]*labelIds/.test(agent));
check("…and Mender closes it once the key serves again",
  /const open = await openAlarm\(\);\s*\n\s*if \(!open\) return;[\s\S]*?setState\(open\.id, "Done"\)/.test(agent));

const publishSrc = agent.slice(agent.indexOf("async function publish()"));
check("publishing takes its targets from GitHub and Linear, not from the artifact the model could rewrite",
  /const target = await trustedTarget\(job\);/.test(publishSrc) &&
    publishSrc.indexOf("trustedTarget(job)") < publishSrc.indexOf("stage(job.baseSha)") &&
    !/job\.pr\.(headRefName|url)|job\.issue\.(identifier|title|url)|job\.ticket/.test(publishSrc));
check("every page of review comments is read", /"--paginate"/.test(agent) && /per_page=100/.test(agent));
check("Mender never merges", !/pr["',\s]+merge|merge_pull|gh pr merge/i.test(agent));
check("AGENTS.md's sequence runs before the patch is taken: prisma generate, both typechecks, lint, verify:all",
  ["generate", "typecheck", "agent:typecheck", "lint", "verify:all"].every((s) => CHECKS.some(([, a]) => a.includes(s))) &&
    /const failing = failingChecks\(\);\s*\n\s*if \(!failing\) return \{ status: "done"/.test(agent) &&
    /r\.status === "done" \? patchFrom\(baseSha\)/.test(agent));
check("review is asked of CodeRabbit, never Codex", /@coderabbitai review/.test(agent) && !/@codex/.test(agent));
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
check("a CodeRabbit review on a mender/ PR starts its round at once",
  /pull_request_review:\s*\n\s*types: \[submitted\]/.test(wf) &&
    /startsWith\(github\.event\.pull_request\.head\.ref, 'mender\/'\) && github\.event\.review\.user\.login == 'coderabbitai\[bot\]'/.test(wf));
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

console.log(bad === 0 ? "\nall pass" : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
