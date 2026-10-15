// Mender: an OpenCode agent on the OpenRouter key that takes any CHE ticket
// labelled `mender`, opens a pull request, asks CodeRabbit to review it, works
// through the review, and reports on the ticket (owner, 2026-10-07; CHE-445).
//
// One unit of work per tick, in this order:
//   1. a review round — an open `mender/*` PR with CodeRabbit comments newer
//      than the last thing Mender did on it (at most MAX_ROUNDS per PR);
//   2. a new ticket — the oldest CHE issue labelled `mender`, not started, not
//      already given MAX_ATTEMPTS without a pull request.
//
// Two jobs on two machines, because a ticket or a linked page can carry a
// prompt injection (Codex, #298 round 1):
//   node scripts/mender/agent.mjs work     — the model runs here, then the checks.
//       No token that can write to GitHub exists on this machine; the checkout
//       keeps no credential. Its only output is $MENDER_DIR/{out.json,patch.diff}.
//   node scripts/mender/agent.mjs publish  — a fresh machine, this file as main
//       has it (the model could have rewritten anything on the first one). The
//       patch is refused if it touches the workflows, Mender itself or the
//       rules (a PR's own workflow runs with the repository's secrets); else it
//       is applied to the recorded base, pushed to `mender/*` with the personal
//       token, the PR opened, CodeRabbit asked, the ticket told.
// The Linear, Notion and OpenRouter keys are the agent's own tools and are
// visible to it; that residual exposure is accepted and stated.
//   node scripts/mender/agent.mjs gate     — no model: a Mender PR whose CI is
//       green and whose review is done merges itself (CHE-486, owner
//       2026-10-15; gate.mjs). It used to wait for a person, and ten waited for
//       days. TICKET=CHE-123 picks a ticket; GATE_PR=123 limits the gate to one PR.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexReviewState, gateDecision, isP1, REVIEW_SILENCE_MINUTES } from "./gate.mjs";
import { codexSummaryState, REVIEW_REQUEST, REVIEWER_LOGIN } from "../doer/review.mjs";

const TEAM_ID = "b9503451-107e-41b6-a933-5959324a72af"; // Linear "Check My App"
const LABEL = "mender";
const LABEL_ID = "f623d304-3b3e-4c10-8af6-9a20b8b2d054";
const MODEL = process.env.MENDER_MODEL ?? "anthropic/claude-sonnet-5.5";
const BUDGET = Number(process.env.MENDER_BUDGET ?? 5);
const MAX_TURNS = Number(process.env.MENDER_MAX_TURNS ?? 8);
const DIR = process.env.MENDER_DIR ?? "/tmp/mender";
const OUT = join(DIR, "out.json");
const PATCH = join(DIR, "patch.diff");

/** Paths a Mender patch may never touch: they run with secrets or judge Mender. */
export const FORBIDDEN = [/^\.github\//, /^\.mender\//, /^opencode\.json$/, /^scripts\/mender\//, /^scripts\/verify-mender-agent\.mjs$/,
  /^CLAUDE\.md$/, /^AGENTS\.md$/, /^mender\.yml$/, /^package-lock\.json$/, /^wrangler[^/]*\.jsonc$/];
export const forbiddenPaths = (paths) => paths.filter((p) => FORBIDDEN.some((re) => re.test(p)));
const MAX_ROUNDS = 3;
const MAX_ATTEMPTS = 2;
const ATTEMPT_MARK = "<!-- mender:attempt -->";
const ROUND_MARK = "<!-- mender:round -->";
// Whose review comments start a round: CodeRabbit, and Codex since the gate
// asks it (CHE-486) — CodeRabbit is rate-limited more often than not.
const REVIEWERS = ["coderabbitai[bot]", "chatgpt-codex-connector[bot]"];

// AGENTS.md's sequence, after the model is done: the client is regenerated in
// case the schema changed, then everything CI runs, the acceptance registry
// included (Codex, #298 round 1).
export const CHECKS = [
  ["npx", ["prisma", "generate"]],
  ["npm", ["run", "typecheck"]],
  ["npm", ["run", "agent:typecheck"]],
  ["npm", ["run", "lint"]],
  ["npm", ["run", "verify:all"]],
];

/** The model's environment: no GitHub token of any kind, even the read-only one. */
export function agentEnv(env) {
  const out = { ...env };
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "MENDER_GH_TOKEN"]) delete out[k];
  return out;
}

const say = (...a) => console.log("[mender]", ...a);
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const gh = (args) => sh("gh", args);
const ghJson = (args) => JSON.parse(gh(args) || "null");
const clean = (text) => String(text ?? "").replace(/MENDER_DONE/g, "").trim();
// A run that reached the cap says so, and the next attempt splits the ticket
// first (#306 spent $5.03 over 80 steps; owner 2026-10-12: Mender splits).
const CAP_NOTE = "cap — Mender splits this ticket next";
const footer = (r) => `\n\n— Mender · ${MODEL} · ${r.steps} steps · $${Number(r.cost).toFixed(2)}` +
  (Number(r.cost) >= BUDGET ? ` · **reached the $${BUDGET} ${CAP_NOTE}**` : "");

async function linear(query, variables = {}) {
  const r = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: process.env.LINEAR_API_KEY ?? "", "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(`Linear: ${JSON.stringify(j.errors).slice(0, 300)}`);
  return j.data;
}

const comment = (issueId, body) =>
  linear("mutation($i:String!,$b:String!){commentCreate(input:{issueId:$i,body:$b}){success}}", { i: issueId, b: body });

async function setState(issueId, name) {
  const d = await linear(`{team(id:"${TEAM_ID}"){states{nodes{id name}}}}`);
  const st = d.team.states.nodes.find((s) => s.name === name);
  if (st) await linear("mutation($i:String!,$s:String!){issueUpdate(id:$i,input:{stateId:$s}){success}}", { i: issueId, s: st.id });
}

// ─── Picking the work ────────────────────────────────────────────────────────

/** Outside an epic, or in one whose lead labelled the epic too. Picking AND releasing obey it (Codex, #333). */
export const givenToMender = (i) => !i.parent || i.parent.labels.nodes.some((l) => l.name === LABEL);

// Open = still in flight, triage included (the tracker contract, src/lib/tracker/types.ts).
export const OPEN = ["triage", "backlog", "unstarted", "started"];

/**
 * Oldest first; a ticket already tried MAX_ATTEMPTS times without a PR steps
 * aside. Ticket rules (owner, 2026-10-12): a ticket inside an epic is taken
 * only when the epic carries the label too — the epic's lead agent says so by
 * labelling it (CHE-443 was taken from another session's epic unannounced);
 * and a ticket Mender split waits while its parts are open.
 */
export function chooseTicket(issues) {
  return [...issues]
    .filter((i) => ["backlog", "unstarted"].includes(i.state.type))
    .filter((i) => i.comments.nodes.filter((c) => c.body.includes(ATTEMPT_MARK)).length < MAX_ATTEMPTS)
    .filter(givenToMender)
    .filter((i) => !(i.children?.nodes ?? []).some((c) => OPEN.includes(c.state.type)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
}

/** Paths whose change a user sees: screens and emails. The owner sees them before merge. */
// Customer sentences live outside JSX too (`*-copy.ts`, `*-mail.ts`; Codex, #333).
export const UI = [/^src\/(app|components)\/.*\.(tsx|css)$/, /^src\/lib\/[^/]*(email|mail|copy)[^/]*\.tsx?$/, /^public\//];
export const uiPaths = (paths) => paths.filter((p) => UI.some((re) => re.test(p)));

/** A "[Pilot feedback]" ticket the check got right is answered, not fixed (CHE-441's contract). */
export const isFeedback = (title) => String(title).startsWith("[Pilot feedback]");
export const answerOf = (text) => String(text).match(/^Answer: .+$/m)?.[0] ?? null;

// What only Mender's own answer can leak: the model, its cost, its tokens
// (CLAUDE.md §10; Codex, #333). A verdict never names these, so the shared
// guard does not look for them.
export const OUR_MACHINERY = /\$\s?\d|\btokens?\b|\b(claude|sonnet|opus|haiku|gpt|openai|anthropic|openrouter|opencode|mender|llm|ai model|language model)\b/i;

/** The rules CHE-441 applies before mailing an answer, from main's own file (no npm ci here). */
export async function usableAnswer(answer) {
  const { hasHomework, hasEnvironmentLeak } = await import("../../src/lib/verdict-language.ts");
  return !hasHomework(answer) && !hasEnvironmentLeak(answer) && !OUR_MACHINERY.test(answer);
}

/**
 * Review comments newer than the last thing Mender did on the PR — its last
 * commit or its last round report, whichever is later: a round that rightly
 * changed nothing still answers the comments it read (Codex, #298 round 1).
 */
export function pendingReview({ reviewComments, lastCommitAt, lastRoundAt = "", roundsUsed }) {
  if (roundsUsed >= MAX_ROUNDS) return [];
  const handled = lastRoundAt > lastCommitAt ? lastRoundAt : lastCommitAt;
  return reviewComments.filter((c) => REVIEWERS.includes(c.user) && c.createdAt > handled && c.body.trim());
}

// `release: false` is the read-only look `peek` takes: it changes nothing on the
// board and only says whether a tick would find work.
async function findWork({ release = true } = {}) {
  const repo = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const prs = ghJson(["pr", "list", "--state", "open", "--json", "number,headRefName,url", "--limit", "50"])
    .filter((p) => p.headRefName.startsWith("mender/"));
  // Every page of every list (GitHub returns 30 by default; Codex, #298 round 3).
  const pages = (path, jq) => gh(["api", "--paginate", `${path}?per_page=100`, "--jq", `.[] | ${jq} | tojson`])
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  for (const pr of prs) {
    const lastCommitAt = pages(`repos/${repo}/pulls/${pr.number}/commits`, ".commit.committer.date").at(-1) ?? "";
    const inline = pages(`repos/${repo}/pulls/${pr.number}/comments`, "{user: .user.login, createdAt: .created_at, body: (.path + \":\" + ((.line // 0)|tostring) + \" \" + .body)}");
    const reviews = pages(`repos/${repo}/pulls/${pr.number}/reviews`, "{user: .user.login, createdAt: .submitted_at, body: (.body // \"\")}");
    const issueComments = pages(`repos/${repo}/issues/${pr.number}/comments`, "{user: .user.login, createdAt: .created_at, body: .body}");
    const rounds = issueComments.filter((c) => c.body.includes(ROUND_MARK));
    const pending = pendingReview({ reviewComments: [...inline, ...reviews], lastCommitAt, lastRoundAt: rounds.at(-1)?.createdAt ?? "", roundsUsed: rounds.length });
    if (pending.length) return { kind: "review", pr, pending, round: rounds.length + 1, ticket: pr.headRefName.match(/^mender\/(che-\d+)/i)?.[1]?.toUpperCase() ?? null };
  }
  const fields = "id identifier title url createdAt state{type name} comments{nodes{body}} parent{identifier labels{nodes{name}}} children{nodes{state{type}}}";
  const pinned = process.env.TICKET;
  if (pinned) {
    const d = await linear(`query($i:String!){issue(id:$i){${fields}}}`, { i: pinned });
    return d.issue ? { kind: "ticket", issue: d.issue } : null;
  }
  // Every page, not the first fifty (Codex, #298 round 2).
  const all = [];
  for (let after = null; ;) {
    const d = await linear(`query($f:IssueFilter,$a:String){issues(filter:$f,first:100,after:$a){nodes{${fields}} pageInfo{hasNextPage endCursor}}}`,
      { f: { team: { id: { eq: TEAM_ID } }, labels: { name: { eq: LABEL } } }, a: after });
    all.push(...d.issues.nodes);
    if (!d.issues.pageInfo.hasNextPage) break;
    after = d.issues.pageInfo.endCursor;
  }
  // Ticks run one at a time, so a labelled ticket still In Progress with no
  // open Mender PR was left by a tick that died (timeout, crash, a failed
  // publish). It goes back to Todo and the failure counts as an attempt
  // (Codex, #298 round 2).
  const open = new Set(prs.map((p) => p.headRefName.match(/^mender\/(che-\d+)/i)?.[1]?.toUpperCase()).filter(Boolean));
  for (const s of stranded(all, open)) {
    if (!release) return { kind: "stranded", issue: s };
    await comment(s.id, `${ATTEMPT_MARK}\n**Mender's previous run ended without a result** (it stopped before reporting). Back to Todo.`);
    await setState(s.id, "Todo");
    s.state = { type: "unstarted" };
    s.comments.nodes.push({ body: ATTEMPT_MARK });
  }
  const issue = chooseTicket(all);
  return issue ? { kind: "ticket", issue } : null;
}

/** Labelled tickets Mender claimed (In Progress) that have no open Mender PR. */
export function stranded(issues, openTickets) {
  return issues.filter((i) => givenToMender(i) && i.state.type === "started" && i.state.name === "In Progress" && !openTickets.has(i.identifier));
}

// ─── The key (2026-10-14) ────────────────────────────────────────────────────
// Mender's OpenRouter key (`journeyman`) reached its $30 limit on CHE-480's
// first turn. Every turn after that was refused; OpenCode said so in an `error`
// event nobody read, and Mender marked CHE-480 and CHE-311 "unfinished" with an
// empty report. A refused key is ours to fix, not the ticket's: the tick stops
// before claiming anything, the ticket keeps its attempts, and one alarm sits on
// the board until the key serves again — Mender closes it then.

/**
 * OpenRouter refused the request: an unknown key (401), no money (402), a key
 * over its limit — or a guardrail on the prompt (403; Codex, #353). Whether a
 * refusal is the key's or the ticket's is decided by `ourRefusal`.
 */
export const REFUSED = [401, 402, 403];
export const ALARM_TITLE = "[Mender] OpenRouter does not serve Mender's key";

/** OpenCode's `error` event (`opencode run --format json`), as what Mender needs of it. */
export function turnError(event) {
  if (event?.type !== "error") return null;
  const status = Number(event.error?.data?.statusCode) || null;
  const message = String(event.error?.data?.message ?? event.error?.name ?? "unknown error").slice(0, 300);
  // OpenRouter names a spent key or account itself: 402, or `limit_source` in the body.
  const ours = status === 402 || /openrouter_(key_limit|credits)/.test(String(event.error?.data?.responseBody ?? ""));
  return { status, message, refused: REFUSED.includes(status), ours };
}

/**
 * A refusal mid-run: why it is ours (the key or the account), or null when it is
 * the ticket's — a guardrail on its prompt, with the key still able to pay. A
 * ticket's refusal counts as its attempt, so it cannot hold the queue forever.
 */
export async function ourRefusal(error, askKey = keyProblem) {
  const answered = `OpenRouter answered HTTP ${error.status}: ${error.message}`;
  if (error.ours) return answered;
  const { why } = await askKey();
  return why ? `${why} (${answered})` : null;
}

/** Why the key cannot pay for one more ticket, from GET /api/v1/key's `data`; null when it can. */
export function keyShortfall(info, budget = BUDGET) {
  const left = info?.limit_remaining;
  if (typeof left !== "number" || left >= budget) return null;
  return `the OpenRouter key has $${left.toFixed(2)} left of its $${info.limit} limit` +
    (info.limit_reset ? ` (it resets ${info.limit_reset})` : " (it never resets)") + `, and one ticket may spend $${budget}`;
}

async function openAlarm() {
  const d = await linear("query($f:IssueFilter){issues(filter:$f,first:1){nodes{id}}}",
    { f: { team: { id: { eq: TEAM_ID } }, title: { eq: ALARM_TITLE }, state: { type: { in: OPEN } } } });
  return d.issues.nodes[0] ?? null;
}

/** One open alarm on the board, then the tick fails. Never labelled `mender`: Mender cannot mend its own key. */
async function alarm(reason) {
  const run = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : "";
  if (!(await openAlarm())) {
    await linear("mutation($team:String!,$t:String!,$d:String!){issueCreate(input:{teamId:$team,title:$t,description:$d,priority:1}){success}}", {
      team: TEAM_ID, t: ALARM_TITLE,
      d: `Mender stopped: ${reason}.${run ? ` (${run})` : ""}\n\nNo ticket is claimed and no attempt is counted; the queue waits. ` +
        "Mender tries again every half hour and closes this ticket itself once the key serves.\n\n" +
        "What ends it: the limit of the OpenRouter key `journeyman` (raised through the management key in the Progress Log), or its reset.",
    });
  }
  throw new Error(`Mender stopped: ${reason}`);
}

/** What OpenRouter says of the key now: why it cannot pay for one more ticket (null if it can), and its numbers. */
async function keyProblem() {
  const r = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}` }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) return { why: `OpenRouter refused the key (HTTP ${r.status})`, info: null };
  const info = (await r.json()).data;
  return { why: keyShortfall(info), info };
}

/** One request of a single token to the model: null when it is served, else why not. */
async function modelAnswers() {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
    signal: AbortSignal.timeout(60_000),
  });
  return r.ok ? null : `OpenRouter still refuses a request (HTTP ${r.status}: ${(await r.text()).slice(0, 200)})`;
}

/**
 * Before any work: the key must be able to pay for a whole ticket. An open
 * alarm closes only on a request the model actually serves: /api/v1/key does
 * not see the account's credits, so a 402 would close and reopen it every tick
 * (Codex, #353). While it is refused, nothing is claimed.
 */
async function keyServes() {
  const { why, info } = await keyProblem();
  if (why) return alarm(why);
  const open = await openAlarm();
  if (!open) return;
  const still = await modelAnswers();
  if (still) return alarm(still);
  await comment(open.id, `The model answers again ($${Number(info?.limit_remaining ?? 0).toFixed(2)} left of the key's $${info?.limit ?? "∞"}); Mender resumed.`);
  await setState(open.id, "Done");
}

// ─── Running the agent ───────────────────────────────────────────────────────

/** What a turn learns from one OpenCode event. */
export function readEvent(out, e) {
  out.session = out.session ?? e.sessionID;
  if (e.type === "text") out.text = String(e.part?.text ?? out.text);
  if (e.type === "step_finish") { out.steps++; out.cost += Number(e.part?.cost ?? 0); }
  out.error = turnError(e) ?? out.error;
  return out;
}

function opencode(message, session) {
  const args = ["run", "-m", `openrouter/${MODEL}`, "--format", "json", ...(session ? ["--session", session] : []), message];
  return new Promise((resolve) => {
    const p = spawn("opencode", args, { stdio: ["ignore", "pipe", "inherit"], env: agentEnv(process.env) });
    let buf = "";
    const out = { session, cost: 0, steps: 0, text: "", error: null };
    p.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        readEvent(out, e);
      }
    });
    p.on("close", (code) => resolve({ ...out, code }));
  });
}

function failingChecks() {
  for (const [cmd, args] of CHECKS) {
    try { sh(cmd, args, { maxBuffer: 64 << 20, env: agentEnv(process.env) }); } catch (e) {
      return `\`${cmd} ${args.join(" ")}\` failed:\n${String(e.stdout ?? "").slice(-3000)}${String(e.stderr ?? "").slice(-1000)}`;
    }
  }
  return null;
}

/**
 * Turns until the agent says it is done or blocked and the checks pass, within
 * budget. A refusal ends the run at once: every further turn would be refused
 * too. Any other error is kept, so the ticket says why a turn was empty.
 */
export async function runAgent(prompt, run = opencode) {
  let session = null, cost = 0, steps = 0, text = "", message = prompt, error = null;
  for (let turn = 0; turn < MAX_TURNS && cost < BUDGET; turn++) {
    const r = await run(message, session);
    session = r.session; cost += r.cost; steps += r.steps; text = r.text || text; error = r.error ?? error;
    say(`turn ${turn + 1}: ${r.steps} steps, $${r.cost.toFixed(4)} (total $${cost.toFixed(4)})${r.error ? ` — OpenCode error ${r.error.status ?? ""}: ${r.error.message}` : ""}`);
    if (r.error?.refused) return { status: "refused", text, cost, steps, error };
    if (/MENDER_BLOCKED/.test(text)) return { status: "blocked", text, cost, steps };
    if (/MENDER_SPLIT/.test(text)) return { status: "split", text, cost, steps };
    if (/MENDER_ANSWERED/.test(text)) return { status: "answered", text, cost, steps };
    if (!/MENDER_DONE/.test(text)) { message = "Continue with the ticket. Use your tools; end with MENDER_DONE when the checks pass."; continue; }
    const failing = failingChecks();
    if (!failing) return { status: "done", text, cost, steps };
    message = `You said MENDER_DONE, but a check fails. Fix it, run it again, then end with MENDER_DONE.\n\n${failing}`;
    text = "";
  }
  return { status: cost >= BUDGET ? "budget" : "unfinished", text, cost, steps, error };
}

/** The model's report, or — when it wrote none — the error that left it empty. */
export const report = (r) => clean(r.text) || (r.error ? `OpenCode stopped: ${r.error.status ?? "error"} ${r.error.message}` : "(no report)");

/** The whole change against the base, committed by the model or not, as a patch. */
function patchFrom(baseSha) {
  sh("git", ["add", "-A"]);
  return execFileSync("git", ["diff", "--cached", "--binary", baseSha], { encoding: "utf8", maxBuffer: 64 << 20 });
}

async function work() {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(PATCH, "");
  await keyServes();
  const job = await findWork();
  if (!job) {
    say("nothing to do: no open review and no CHE ticket labelled `mender`");
    return writeFileSync(OUT, JSON.stringify({ kind: "none" }));
  }
  if (job.kind === "review") {
    say(`review round ${job.round} on #${job.pr.number}`);
    sh("git", ["checkout", "-q", "-B", job.pr.headRefName, `origin/${job.pr.headRefName}`]);
    const baseSha = sh("git", ["rev-parse", "HEAD"]);
    const findings = job.pending.map((c) => `- ${c.body.slice(0, 2000)}`).join("\n");
    const r = await runAgent(`This branch is the pull request ${job.pr.url} for ${job.ticket ?? "its ticket"}. Review round ${job.round}: CodeRabbit left these comments. Follow .mender/MENDER.md "Review rounds".\n\n${findings}`);
    // Ours: the round is not spent (publish never runs) and the next tick takes it
    // again. The ticket's: it is an ordinary round that pushed nothing.
    const ours = r.status === "refused" ? await ourRefusal(r.error) : null;
    if (ours) return alarm(`${ours}, during review round ${job.round} on #${job.pr.number}`);
    const patch = r.status === "done" ? patchFrom(baseSha) : "";
    writeFileSync(PATCH, patch);
    return writeFileSync(OUT, JSON.stringify({ ...job, pending: undefined, baseSha, result: r, changed: patch.length > 0 }));
  }
  const { issue } = job;
  say(`ticket ${issue.identifier}: ${issue.title}`);
  await setState(issue.id, "In Progress");
  const baseSha = sh("git", ["rev-parse", "HEAD"]);
  const capped = issue.comments.nodes.some((c) => c.body.includes(CAP_NOTE));
  const r = await runAgent(`Your ticket is ${issue.identifier} (${issue.url}). Read it with the Linear tools, follow .mender/MENDER.md, and do it.` +
    (capped ? ` A previous attempt reached the $${BUDGET} cap: split the ticket first (.mender/MENDER.md "Too big for one pull request").` : ""));
  const ours = r.status === "refused" ? await ourRefusal(r.error) : null;
  if (ours) {
    await comment(issue.id, `**Mender stopped on its own key, not on this ticket:** ${ours}. Back to Todo; this is not counted as an attempt.${footer(r)}`);
    await setState(issue.id, "Todo");
    return alarm(`${ours}, on ${issue.identifier}`);
  }
  // The key can pay: OpenRouter refused this ticket's prompt, and that is its attempt.
  if (r.status === "refused") r.status = `refused by OpenRouter (HTTP ${r.error.status}: ${r.error.message})`;
  const patch = r.status === "done" ? patchFrom(baseSha) : "";
  writeFileSync(PATCH, patch);
  writeFileSync(OUT, JSON.stringify({ kind: "ticket", issue, baseSha, result: r, changed: patch.length > 0 }));
}

// ─── Publishing (a fresh machine; the model is not running) ──────────────────

/**
 * Every path the staged change touches, read after the patch is applied:
 * NUL-delimited, so a name git would quote (".github/workflows/réview.yml")
 * comes as itself, and --no-renames, so a file moved out of a protected
 * directory shows its old path too (Codex, #298 round 2). `git apply
 * --numstat` was not enough: for a rename it names only the destination.
 */
export function stagedPaths(cwd = process.cwd()) {
  return execFileSync("git", ["diff", "--cached", "--name-only", "-z", "--no-renames"], { cwd, encoding: "utf8" })
    .split("\0").filter(Boolean);
}

/** Apply the patch to its base in the index; the refusal reads what is staged. */
function stage(baseSha) {
  sh("git", ["checkout", "-q", "--detach", baseSha]);
  sh("git", ["apply", "--index", "--binary", PATCH]);
  return stagedPaths();
}

/** A PR that changes screens or emails is labelled `ui`: the reviewer shows the owner before merging. */
function markUi(url, paths) {
  if (!uiPaths(paths).length) return;
  gh(["label", "create", "ui", "--color", "FBCA04", "--description", "Changes screens or emails: owner sees them before merge", "--force"]);
  gh(["pr", "edit", url, "--add-label", "ui"]);
}

export function branchFor(issue) {
  const slug = String(issue.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "");
  return `mender/${String(issue.identifier).toLowerCase()}${slug ? `-${slug}` : ""}`;
}

/** The only refs the personal token may ever be used to push to. */
export const validBranch = (b) => /^mender\/che-\d+(-[a-z0-9]+)*$/.test(String(b));

function push(branch, message, { force = false } = {}) {
  if (!validBranch(branch)) throw new Error(`refusing to push to ${JSON.stringify(branch)}: not a mender/che-* branch`);
  sh("git", ["-c", "user.name=Mender", "-c", "user.email=mender@checkmyapp.dev", "commit", "-q", "-m", message]);
  const repo = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  sh("git", ["push", "-q", ...(force ? ["--force"] : []), `https://x-access-token:${process.env.GH_TOKEN}@github.com/${repo}.git`, `HEAD:refs/heads/${branch}`]);
}

/**
 * What to publish to, taken from GitHub and Linear — never from the artifact.
 * The model had a shell on the machine that wrote out.json and could have
 * rewritten it after work() returned (Codex, #298 round 3); the artifact may
 * only say WHICH PR or ticket, and each is then checked here: a PR must be
 * open, ours, on a mender/ branch, with the head the patch was made on; a
 * ticket must carry the label and be the one this tick claimed; a ticket's
 * base must be a commit of main.
 */
async function trustedTarget(job) {
  if (job.kind === "review") {
    const pr = ghJson(["pr", "view", String(Number(job.pr?.number)), "--json", "number,url,state,headRefName,headRefOid,isCrossRepository"]);
    if (pr.state !== "OPEN" || pr.isCrossRepository || !validBranch(pr.headRefName)) throw new Error(`#${pr.number} is not an open Mender PR`);
    if (pr.headRefOid !== job.baseSha) throw new Error(`#${pr.number} moved from ${job.baseSha} to ${pr.headRefOid} during the round; nothing pushed`);
    return { pr, ticket: pr.headRefName.match(/^mender\/(che-\d+)/)[1].toUpperCase() };
  }
  const d = await linear(`query($i:String!){issue(id:$i){id identifier title url state{name} labels{nodes{name}}}}`, { i: String(job.issue?.id ?? "") });
  const issue = d.issue;
  if (!issue || !issue.labels.nodes.some((l) => l.name === LABEL) || issue.state.name !== "In Progress") throw new Error("the ticket in the artifact is not one Mender claimed");
  if (job.changed) {
    try { sh("git", ["merge-base", "--is-ancestor", String(job.baseSha), "origin/main"]); } catch { throw new Error(`base ${job.baseSha} is not a commit of main`); }
  }
  return { issue };
}

async function publish() {
  const job = JSON.parse(readFileSync(OUT, "utf8"));
  if (job.kind === "none") return;
  const r = job.result;
  const target = await trustedTarget(job);
  let paths = [];
  if (job.changed) {
    paths = stage(job.baseSha);
    const bad = forbiddenPaths(paths);
    if (bad.length) {
      sh("git", ["reset", "-q", "--hard"]);
      job.changed = false;
      r.status = "refused";
      r.text = `The patch touched paths Mender may never change: ${bad.join(", ")}. Nothing was pushed.\n\n${r.text}`;
    }
  }
  if (job.kind === "review") {
    const { pr, ticket } = target;
    const round = Math.max(1, Math.min(MAX_ROUNDS, Number(job.round) || 1));
    if (job.changed) { push(pr.headRefName, `Review round ${round} (${ticket})`); markUi(pr.url, paths); }
    gh(["pr", "comment", pr.url, "--body", `${ROUND_MARK}\n**Round ${round}: ${job.changed ? "pushed" : "nothing pushed"} (${r.status}).**\n\n${report(r)}${footer(r)}${job.changed && round < MAX_ROUNDS ? "\n\n@coderabbitai review" : ""}`]);
    if (ticket) {
      const d = await linear(`query($i:String!){issue(id:$i){id}}`, { i: ticket });
      await comment(d.issue.id, `**Review round ${round} on ${pr.url}: ${job.changed ? "fixes pushed" : "nothing pushed"}.**${footer(r)}`);
    }
    return;
  }
  const { issue } = target;
  // Split into parts (created by the model with the Linear tools): the ticket
  // waits in Todo while they are open, and this is not a failed attempt —
  // unless no open part exists on Linear, whatever the model said (Codex, #333).
  if (r.status === "split") {
    const d = await linear(`query($i:String!){issue(id:$i){children{nodes{id state{type} labels{nodes{name}}}}}}`, { i: issue.id });
    const parts = d.issue.children.nodes.filter((c) => OPEN.includes(c.state.type));
    // Every open part enters the queue, whether or not the model labelled it.
    for (const c of parts.filter((c) => !c.labels.nodes.some((l) => l.name === LABEL))) {
      await linear("mutation($i:String!,$l:String!){issueAddLabel(id:$i,labelId:$l){success}}", { i: c.id, l: LABEL_ID });
    }
    if (parts.length) {
      await comment(issue.id, `**Mender split this ticket** into the sub-issues below; each is taken on its own.\n\n${clean(r.text)}${footer(r)}`);
      return setState(issue.id, "Todo");
    }
    r.status = "split without sub-issues";
  }
  // A "[Pilot feedback]" report the check got right: Canceled with a comment
  // that starts "Answer: …", which CHE-441 mails to its author. The model only
  // writes the answer; the state is set here, only on a feedback ticket, only
  // for an answer the customer-language rules pass (the mail would refuse it
  // and the report would wait forever), and the answer comment carries nothing
  // else — the author reads all of it (Codex, #333).
  const answer = r.status === "answered" && !job.changed && isFeedback(issue.title) ? answerOf(r.text) : null;
  if (answer && (await usableAnswer(answer))) {
    await comment(issue.id, `**Mender: the check was right.**${footer(r)}`);
    await comment(issue.id, answer);
    return setState(issue.id, "Canceled");
  }
  if (answer) r.status = "answer refused by the customer-language rules";
  if (!job.changed) {
    await comment(issue.id, `${ATTEMPT_MARK}\n**Mender did not open a pull request** (${r.status === "done" ? "no change" : r.status}).\n\n${report(r)}${footer(r)}`);
    return setState(issue.id, "Todo");
  }
  const branch = branchFor(issue);
  // A retry after a publish that died between the push and the PR finds its own
  // branch already there: it is Mender's, so it is replaced, and an existing PR
  // for it is reused rather than failing (Codex, #298 round 3).
  push(branch, `${issue.identifier}: ${issue.title}\n\n${clean(r.text)}`, { force: true });
  const existing = gh(["pr", "list", "--head", branch, "--state", "open", "--json", "url", "--jq", ".[0].url // empty"]);
  const url = existing || gh(["pr", "create", "--head", branch, "--title", `${issue.identifier}: ${issue.title}`,
    "--body", `${issue.url}\n\n${clean(r.text)}${footer(r)}\n\nMerges itself once CI is green and the review is done (CHE-486); the watch after the deploy decides whether it stays.`]);
  markUi(url, paths);
  gh(["pr", "comment", url, "--body", "@coderabbitai review"]);
  await comment(issue.id, `${ATTEMPT_MARK}\n**Pull request opened:** ${url}\nCodeRabbit asked to review.\n\n${clean(r.text)}${footer(r)}`);
  await setState(issue.id, "In Review");
  say(`opened ${url}`);
}

// ─── Tempo (CHE-445): GitHub's schedule fired every 4–7 h, not every 30 min ──

/**
 * Is there anything for a tick to do? Read-only, and needs no `npm ci`, so an
 * idle tick ends in seconds. Writes `work=yes|no` for the workflow's later steps.
 */
async function peek() {
  // An open alarm is work too: only `work` can see the model serve again and
  // close it, whatever is left in the queue (Codex, #353).
  const yes = Boolean(process.env.TICKET) || Boolean(await findWork({ release: false })) || Boolean(await openAlarm());
  say(`peek: ${yes ? "work to do" : "nothing to do"}`);
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `work=${yes ? "yes" : "no"}\n`, { flag: "a" });
  return yes;
}

/**
 * After a publish, if more work is queued, start the next tick now instead of
 * waiting for the schedule — a batch of labelled tickets goes back to back.
 * The personal token starts it (an event from GITHUB_TOKEN would not); the
 * workflow's concurrency group keeps ticks serial.
 */
async function chainNext() {
  if (!(await findWork({ release: false }))) return say("queue empty — no next tick");
  gh(["workflow", "run", "mender-agent.yml", "--ref", "main"]);
  say("more work queued — next tick started");
}

// ─── The merge gate (CHE-486): Mender's pull requests merge themselves ───────
//
// Owner, 2026-10-15: «пусть все мержится само … монитор на следующем тике все
// поймает». Run on a fresh machine from main, with no model, whenever something
// that can change the decision happens: CI finishing on a mender/ branch, the
// reviewer answering, a tick ending. The decision is gate.mjs; this gathers the
// facts from GitHub and acts on them.

const pagesOf = (path, jq) => gh(["api", "--paginate", `${path}?per_page=100`, "--jq", `.[] | ${jq} | tojson`])
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** Everything the gate decides from, for one open Mender pull request. */
function gateFacts(repo, pr) {
  const head = pr.headRefOid;
  const headAt = gh(["api", `repos/${repo}/commits/${head}`, "--jq", ".commit.committer.date"]);
  // The latest `check` job on this head (a re-run is a newer one).
  const check = ghJson(["api", `repos/${repo}/commits/${head}/check-runs?per_page=100`, "--jq",
    `[.check_runs[] | select(.name == "check")] | sort_by(.id) | last // null | if . == null then null else {status, conclusion} end`]);
  const ci = !check ? "none" : check.status !== "completed" ? "pending" : check.conclusion === "success" ? "success" : "failure";
  const comments = pagesOf(`repos/${repo}/issues/${pr.number}/comments`, "{user: .user.login, createdAt: .created_at, body: (.body // \"\")}");
  const inline = pagesOf(`repos/${repo}/pulls/${pr.number}/comments`,
    "{user: .user.login, sha: .original_commit_id, createdAt: .created_at, body: (.body // \"\"), reply: .in_reply_to_id}");
  const onHead = inline.filter((c) => c.user === REVIEWER_LOGIN && c.sha === head && !c.reply);
  const summary = comments.filter((c) => c.user === REVIEWER_LOGIN).map((c) => codexReviewState(c.body)).find((s) => s?.commitSha === head);
  const table = comments.filter((c) => c.user === REVIEWER_LOGIN).map((c) => codexSummaryState(c.body, head)).find(Boolean);
  const review = summary?.status === "completed" ? (summary.hasAnyFindings || onHead.length ? "findings" : "clean")
    : summary?.status === "running" || table === "running" ? "running"
      : table === "completed" ? (onHead.length ? "findings" : "clean")
        : onHead.length ? "findings" : null;
  const lastFindingAt = onHead.map((c) => c.createdAt).sort().at(-1) ?? "";
  const rounds = comments.filter((c) => c.body.includes(ROUND_MARK));
  const asks = comments.filter((c) => c.body.toLowerCase().includes(REVIEW_REQUEST) && c.createdAt > headAt).map((c) => c.createdAt).sort();
  return {
    ci,
    review,
    p1: onHead.filter((c) => isP1(c.body)).length,
    roundsUsed: rounds.length,
    answered: Boolean(lastFindingAt) && rounds.some((c) => c.createdAt > lastFindingAt),
    askedMinutesAgo: asks.length ? (Date.now() - Date.parse(asks[0])) / 60_000 : null,
    findings: onHead.map((c) => `- ${c.body.split("\n").find((l) => l.trim() && !l.includes("Badge")) ?? c.body.slice(0, 200)}`).join("\n"),
  };
}

/** The ticket a mender/che-N-… branch belongs to, from Linear. */
async function ticketOf(branch) {
  const id = branch.match(/^mender\/(che-\d+)/i)?.[1]?.toUpperCase();
  if (!id) return null;
  const d = await linear("query($i:String!){issue(id:$i){id identifier}}", { i: id });
  return d.issue ?? null;
}

/**
 * How many checks are running in production now. A deploy re-runs a website
 * check's current step and doubles what it costs, and ci.yml's own gate waits
 * only for extension checks (CHE-272), so the merge — which starts the deploy —
 * waits for none to be running (Codex, #356). Read with the classification the
 * deploy gate reads, never a list of our own.
 */
export async function checksInFlight(env = process.env, doFetch = fetch) {
  const { LIVE_RUN_STATUSES } = await import("../../src/lib/enums.ts");
  const config = readFileSync(new URL("../../wrangler-agent.jsonc", import.meta.url), "utf8");
  const database = /"database_id"\s*:\s*"([0-9a-f-]+)"/.exec(config)?.[1];
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID || !database) throw new Error("no Cloudflare credentials: cannot tell whether a check is running");
  const statuses = LIVE_RUN_STATUSES.map((s) => `'${s}'`).join(", ");
  const r = await doFetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${database}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql: `SELECT count(*) AS n FROM Run WHERE status IN (${statuses})` }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await r.json();
  if (!r.ok || !body.success) throw new Error(`D1 refused the question (HTTP ${r.status})`);
  return Number(body.result?.[0]?.results?.[0]?.n ?? 0);
}

const MERGE_WAIT_MS = Number(process.env.MENDER_MERGE_WAIT_MS ?? 20 * 60_000);

async function mergePr(pr, reason) {
  // Wait for production to be idle; still busy after the wait, the PR stays
  // open and the next event decides again. An unanswerable question is not
  // permission to deploy.
  for (const deadline = Date.now() + MERGE_WAIT_MS; ;) {
    const running = await checksInFlight();
    if (!running) break;
    if (Date.now() >= deadline) return say(`#${pr.number}: ${running} check(s) still running in production — left open`);
    say(`#${pr.number}: ${running} check(s) running in production — waiting before the merge`);
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
  // The personal token, so the push to main starts CI and the deploy (a merge by
  // GITHUB_TOKEN starts no workflow). Pinned to the head the gate inspected: a
  // round pushed meanwhile makes this fail rather than merge unread code (Codex, #356).
  gh(["pr", "merge", String(pr.number), "--squash", "--delete-branch", "--match-head-commit", pr.headRefOid]);
  gh(["pr", "comment", String(pr.number), "--body",
    `**Merged by the gate:** ${reason}.\n\nWhether the problem is gone is for the watch after the deploy and the next CheckMyApp check to say — not for this merge.`]);
  const issue = await ticketOf(pr.headRefName);
  if (issue) {
    await comment(issue.id, `**Merged:** ${pr.url} — ${reason}.`);
    await setState(issue.id, "Done");
  }
  say(`merged #${pr.number}`);
}

async function closePr(pr, reason, facts) {
  gh(["pr", "close", String(pr.number), "--delete-branch", "--comment",
    `**Closed by the gate:** ${reason}. The ticket goes back to Mender's queue with what stopped it.`]);
  const issue = await ticketOf(pr.headRefName);
  if (issue) {
    // No attempt mark: the PR's opening already counted this attempt, and a
    // second mark would take the ticket out of the queue at once (Codex, #356).
    await comment(issue.id, `**Mender's pull request ${pr.url} was closed:** ${reason}.` +
      (facts.findings ? `\n\nWhat the review found on its last head:\n${facts.findings}` : "") +
      "\n\nBack to Todo; the next attempt starts from current main.");
    await setState(issue.id, "Todo");
  }
  say(`closed #${pr.number}: ${reason}`);
}

/** Codex answers only an identity linked to a ChatGPT account, so it is asked with the owner's token (CHE-155). */
function askReview(pr) {
  const token = process.env.CODEX_REVIEW_TOKEN;
  if (!token) return say(`#${pr.number}: CODEX_REVIEW_TOKEN is not set — the review cannot be asked; the gate merges after ${REVIEW_SILENCE_MINUTES} minutes of silence`);
  execFileSync("gh", ["pr", "comment", String(pr.number), "--body", `${REVIEW_REQUEST}\n\nAsked by Mender's gate for ${pr.headRefOid.slice(0, 7)}.`],
    { stdio: "inherit", env: { ...process.env, GH_TOKEN: token } });
}

async function gate() {
  const repo = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const only = Number(process.env.GATE_PR) || null;
  const prs = ghJson(["pr", "list", "--state", "open", "--limit", "50", "--json", "number,headRefName,headRefOid,url,isCrossRepository,mergeable"])
    .filter((p) => validBranch(p.headRefName) && !p.isCrossRepository && (!only || p.number === only));
  let failed = 0;
  for (const pr of prs) {
    // One PR the gate cannot read or act on never holds the others.
    try {
      // A branch main has moved under: the next attempt starts from main instead.
      if (pr.mergeable === "CONFLICTING") {
        await closePr(pr, "it conflicts with main", { findings: "" });
        continue;
      }
      const facts = gateFacts(repo, pr);
      const d = gateDecision(facts);
      say(`gate #${pr.number} ${pr.headRefOid.slice(0, 7)}: ${d.action} — ${d.reason}`);
      if (d.action === "ask") askReview(pr);
      if (d.action === "merge") await mergePr(pr, d.reason);
      if (d.action === "close") await closePr(pr, d.reason, facts);
    } catch (e) {
      failed++;
      console.error(`[mender] gate #${pr.number}: ${e.message}`);
    }
  }
  if (failed) throw new Error(`the gate could not decide ${failed} pull request(s)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const step = process.argv[2];
  const run = { peek, work, gate, publish: () => publish().then(chainNext) }[step];
  (run ? run() : Promise.reject(new Error("usage: agent.mjs peek|work|publish|gate")))
    .catch((e) => { console.error(e); process.exit(1); });
}
