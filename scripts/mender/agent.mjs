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
// visible to it; that residual exposure is accepted and stated. Nothing here
// merges: a person does. TICKET=CHE-123 picks a ticket.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TEAM_ID = "b9503451-107e-41b6-a933-5959324a72af"; // Linear "Check My App"
const LABEL = "mender";
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
const REVIEWER = "coderabbitai[bot]";

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
const footer = (r) => `\n\n— Mender · ${MODEL} · ${r.steps} steps · $${Number(r.cost).toFixed(2)}`;

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

/** Oldest first; a ticket already tried MAX_ATTEMPTS times without a PR steps aside. */
export function chooseTicket(issues) {
  return [...issues]
    .filter((i) => ["backlog", "unstarted"].includes(i.state.type))
    .filter((i) => i.comments.nodes.filter((c) => c.body.includes(ATTEMPT_MARK)).length < MAX_ATTEMPTS)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
}

/**
 * Review comments newer than the last thing Mender did on the PR — its last
 * commit or its last round report, whichever is later: a round that rightly
 * changed nothing still answers the comments it read (Codex, #298 round 1).
 */
export function pendingReview({ reviewComments, lastCommitAt, lastRoundAt = "", roundsUsed }) {
  if (roundsUsed >= MAX_ROUNDS) return [];
  const handled = lastRoundAt > lastCommitAt ? lastRoundAt : lastCommitAt;
  return reviewComments.filter((c) => c.user === REVIEWER && c.createdAt > handled && c.body.trim());
}

async function findWork() {
  const repo = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const prs = ghJson(["pr", "list", "--state", "open", "--json", "number,headRefName,url", "--limit", "50"])
    .filter((p) => p.headRefName.startsWith("mender/"));
  for (const pr of prs) {
    const lastCommitAt = gh(["api", `repos/${repo}/pulls/${pr.number}/commits`, "--jq", ".[-1].commit.committer.date"]);
    const inline = ghJson(["api", `repos/${repo}/pulls/${pr.number}/comments`, "--jq", "[.[] | {user: .user.login, createdAt: .created_at, body: (.path + \":\" + ((.line // 0)|tostring) + \" \" + .body)}]"]);
    const reviews = ghJson(["api", `repos/${repo}/pulls/${pr.number}/reviews`, "--jq", "[.[] | {user: .user.login, createdAt: .submitted_at, body: .body}]"]);
    const issueComments = ghJson(["api", `repos/${repo}/issues/${pr.number}/comments`, "--jq", "[.[] | {user: .user.login, createdAt: .created_at, body: .body}]"]);
    const rounds = issueComments.filter((c) => c.body.includes(ROUND_MARK));
    const pending = pendingReview({ reviewComments: [...inline, ...reviews], lastCommitAt, lastRoundAt: rounds.at(-1)?.createdAt ?? "", roundsUsed: rounds.length });
    if (pending.length) return { kind: "review", pr, pending, round: rounds.length + 1, ticket: pr.headRefName.match(/^mender\/(che-\d+)/i)?.[1]?.toUpperCase() ?? null };
  }
  const fields = "id identifier title url createdAt state{type name} comments{nodes{body}}";
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
  return issues.filter((i) => i.state.type === "started" && i.state.name === "In Progress" && !openTickets.has(i.identifier));
}

// ─── Running the agent ───────────────────────────────────────────────────────

function opencode(message, session) {
  const args = ["run", "-m", `openrouter/${MODEL}`, "--format", "json", ...(session ? ["--session", session] : []), message];
  return new Promise((resolve) => {
    const p = spawn("opencode", args, { stdio: ["ignore", "pipe", "inherit"], env: agentEnv(process.env) });
    let buf = "";
    const out = { session, cost: 0, steps: 0, text: "" };
    p.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        out.session = out.session ?? e.sessionID;
        if (e.type === "text") out.text = String(e.part?.text ?? out.text);
        if (e.type === "step_finish") { out.steps++; out.cost += Number(e.part?.cost ?? 0); }
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

/** Turns until the agent says it is done or blocked and the checks pass, within budget. */
async function runAgent(prompt) {
  let session = null, cost = 0, steps = 0, text = "", message = prompt;
  for (let turn = 0; turn < MAX_TURNS && cost < BUDGET; turn++) {
    const r = await opencode(message, session);
    session = r.session; cost += r.cost; steps += r.steps; text = r.text || text;
    say(`turn ${turn + 1}: ${r.steps} steps, $${r.cost.toFixed(4)} (total $${cost.toFixed(4)})`);
    if (/MENDER_BLOCKED/.test(text)) return { status: "blocked", text, cost, steps };
    if (!/MENDER_DONE/.test(text)) { message = "Continue with the ticket. Use your tools; end with MENDER_DONE when the checks pass."; continue; }
    const failing = failingChecks();
    if (!failing) return { status: "done", text, cost, steps };
    message = `You said MENDER_DONE, but a check fails. Fix it, run it again, then end with MENDER_DONE.\n\n${failing}`;
    text = "";
  }
  return { status: cost >= BUDGET ? "budget" : "unfinished", text, cost, steps };
}

/** The whole change against the base, committed by the model or not, as a patch. */
function patchFrom(baseSha) {
  sh("git", ["add", "-A"]);
  return execFileSync("git", ["diff", "--cached", "--binary", baseSha], { encoding: "utf8", maxBuffer: 64 << 20 });
}

async function work() {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(PATCH, "");
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
    const patch = r.status === "done" ? patchFrom(baseSha) : "";
    writeFileSync(PATCH, patch);
    return writeFileSync(OUT, JSON.stringify({ ...job, pending: undefined, baseSha, result: r, changed: patch.length > 0 }));
  }
  const { issue } = job;
  say(`ticket ${issue.identifier}: ${issue.title}`);
  await setState(issue.id, "In Progress");
  const baseSha = sh("git", ["rev-parse", "HEAD"]);
  const r = await runAgent(`Your ticket is ${issue.identifier} (${issue.url}). Read it with the Linear tools, follow .mender/MENDER.md, and do it.`);
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
  return forbiddenPaths(stagedPaths());
}

function push(branch, message) {
  sh("git", ["-c", "user.name=Mender", "-c", "user.email=mender@checkmyapp.dev", "commit", "-q", "-m", message]);
  const repo = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  sh("git", ["push", "-q", `https://x-access-token:${process.env.GH_TOKEN}@github.com/${repo}.git`, `HEAD:refs/heads/${branch}`]);
}

async function publish() {
  const job = JSON.parse(readFileSync(OUT, "utf8"));
  if (job.kind === "none") return;
  const r = job.result;
  if (job.kind === "review" && job.changed) {
    const head = gh(["pr", "view", job.pr.url, "--json", "headRefOid", "--jq", ".headRefOid"]);
    if (head !== job.baseSha) throw new Error(`#${job.pr.number} moved from ${job.baseSha} to ${head} during the round; nothing pushed`);
  }
  if (job.changed) {
    const bad = stage(job.baseSha);
    if (bad.length) {
      sh("git", ["reset", "-q", "--hard"]);
      job.changed = false;
      r.status = "refused";
      r.text = `The patch touched paths Mender may never change: ${bad.join(", ")}. Nothing was pushed.\n\n${r.text}`;
    }
  }
  if (job.kind === "review") {
    const { pr, round, ticket } = job;
    if (job.changed) push(pr.headRefName, `Review round ${round} (${ticket ?? `#${pr.number}`})`);
    gh(["pr", "comment", pr.url, "--body", `${ROUND_MARK}\n**Round ${round}: ${job.changed ? "pushed" : "nothing pushed"} (${r.status}).**\n\n${clean(r.text) || "(no report)"}${footer(r)}${job.changed && round < MAX_ROUNDS ? "\n\n@coderabbitai review" : ""}`]);
    if (ticket) {
      const d = await linear(`query($i:String!){issue(id:$i){id}}`, { i: ticket });
      await comment(d.issue.id, `**Review round ${round} on ${pr.url}: ${job.changed ? "fixes pushed" : "nothing pushed"}.**${footer(r)}`);
    }
    return;
  }
  const { issue } = job;
  if (!job.changed) {
    await comment(issue.id, `${ATTEMPT_MARK}\n**Mender did not open a pull request** (${r.status === "done" ? "no change" : r.status}).\n\n${clean(r.text) || "(no report)"}${footer(r)}`);
    return setState(issue.id, "Todo");
  }
  const slug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/-+$/, "");
  const branch = `mender/${issue.identifier.toLowerCase()}-${slug}`;
  push(branch, `${issue.identifier}: ${issue.title}\n\n${clean(r.text)}`);
  const url = gh(["pr", "create", "--head", branch, "--title", `${issue.identifier}: ${issue.title}`,
    "--body", `${issue.url}\n\n${clean(r.text)}${footer(r)}\n\nMerged by a person, never by Mender.`]);
  gh(["pr", "comment", url, "--body", "@coderabbitai review"]);
  await comment(issue.id, `${ATTEMPT_MARK}\n**Pull request opened:** ${url}\nCodeRabbit asked to review.\n\n${clean(r.text)}${footer(r)}`);
  await setState(issue.id, "In Review");
  say(`opened ${url}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const step = process.argv[2];
  (step === "publish" ? publish() : step === "work" ? work() : Promise.reject(new Error("usage: agent.mjs work|publish")))
    .catch((e) => { console.error(e); process.exit(1); });
}
