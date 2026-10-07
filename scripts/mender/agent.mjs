// Mender: an OpenCode agent on the OpenRouter key that takes any CHE ticket
// labelled `mender`, opens a pull request, asks CodeRabbit to review it, works
// through the review, and reports on the ticket (owner, 2026-10-07; CHE-445).
//
// One unit of work per tick, in this order:
//   1. a review round — an open `mender/*` PR with CodeRabbit comments newer
//      than its last commit (at most MAX_ROUNDS per PR);
//   2. a new ticket — the oldest CHE issue labelled `mender`, not started, not
//      already given MAX_ATTEMPTS without a pull request.
// The agent does the work (it reads Linear and Notion through MCP, see
// opencode.json and .mender/MENDER.md); everything that must not depend on a
// model's mood — the git, the checks, the PR, the review request, the ticket's
// state — is done here. Nothing here merges: a person does.
//
// Usage: node scripts/mender/agent.mjs        (TICKET=CHE-123 to pick one)

import { execFileSync, spawn } from "node:child_process";

const TEAM_ID = "b9503451-107e-41b6-a933-5959324a72af"; // Linear "Check My App"
const LABEL = "mender";
const MODEL = process.env.MENDER_MODEL ?? "anthropic/claude-sonnet-5.5";
const BUDGET = Number(process.env.MENDER_BUDGET ?? 5);
const MAX_TURNS = Number(process.env.MENDER_MAX_TURNS ?? 8);
const MAX_ROUNDS = 3;
const MAX_ATTEMPTS = 2;
const ATTEMPT_MARK = "<!-- mender:attempt -->";
const ROUND_MARK = "<!-- mender:round -->";
const REVIEWER = "coderabbitai[bot]";
export const CHECKS = [["npm", ["run", "typecheck"]], ["npm", ["run", "agent:typecheck"]], ["npm", ["run", "lint"]]];

const say = (...a) => console.log("[mender]", ...a);
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const gh = (args) => sh("gh", args);
const ghJson = (args) => JSON.parse(gh(args) || "null");

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

/** Review comments newer than the branch's last commit, if the PR still has rounds left. */
export function pendingReview({ reviewComments, lastCommitAt, roundsUsed }) {
  if (roundsUsed >= MAX_ROUNDS) return [];
  return reviewComments.filter((c) => c.user === REVIEWER && c.createdAt > lastCommitAt && c.body.trim());
}

async function findWork() {
  const prs = ghJson(["pr", "list", "--state", "open", "--json", "number,headRefName,url,body", "--limit", "50"])
    .filter((p) => p.headRefName.startsWith("mender/"));
  for (const pr of prs) {
    const repo = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
    const lastCommitAt = gh(["api", `repos/${repo}/pulls/${pr.number}/commits`, "--jq", ".[-1].commit.committer.date"]);
    const inline = ghJson(["api", `repos/${repo}/pulls/${pr.number}/comments`, "--jq", "[.[] | {user: .user.login, createdAt: .created_at, body: (.path + \":\" + ((.line // 0)|tostring) + \" \" + .body)}]"]);
    const reviews = ghJson(["api", `repos/${repo}/pulls/${pr.number}/reviews`, "--jq", "[.[] | {user: .user.login, createdAt: .submitted_at, body: .body}]"]);
    const issueComments = ghJson(["api", `repos/${repo}/issues/${pr.number}/comments`, "--jq", "[.[] | {user: .user.login, createdAt: .created_at, body: .body}]"]);
    const roundsUsed = issueComments.filter((c) => c.body.includes(ROUND_MARK)).length;
    const pending = pendingReview({ reviewComments: [...inline, ...reviews], lastCommitAt, roundsUsed });
    if (pending.length) return { kind: "review", pr, pending, round: roundsUsed + 1, ticket: pr.headRefName.match(/^mender\/(che-\d+)/i)?.[1]?.toUpperCase() };
  }
  const d = await linear(
    `query($f:IssueFilter){issues(filter:$f,first:50){nodes{id identifier title url createdAt state{type} comments{nodes{body}}}}}`,
    { f: { team: { id: { eq: TEAM_ID } }, labels: { name: { eq: LABEL } } } },
  );
  const pinned = process.env.TICKET;
  const issue = pinned ? d.issues.nodes.find((i) => i.identifier === pinned) ?? (await linear(`{issue(id:"${pinned}"){id identifier title url createdAt state{type} comments{nodes{body}}}}`)).issue
    : chooseTicket(d.issues.nodes);
  return issue ? { kind: "ticket", issue } : null;
}

// ─── Running the agent ───────────────────────────────────────────────────────

function opencode(message, session) {
  const args = ["run", "-m", `openrouter/${MODEL}`, "--format", "json", ...(session ? ["--session", session] : []), message];
  return new Promise((resolve) => {
    const p = spawn("opencode", args, { stdio: ["ignore", "pipe", "inherit"] });
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
    try { sh(cmd, args, { maxBuffer: 64 << 20 }); } catch (e) {
      return `\`${cmd} ${args.join(" ")}\` failed:\n${String(e.stdout ?? "").slice(-3000)}${String(e.stderr ?? "").slice(-1000)}`;
    }
  }
  return null;
}

/** Turns until the agent says it is done or blocked and the checks pass, within budget. */
async function work(prompt) {
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

const changed = () => sh("git", ["status", "--porcelain"]).length > 0;
const footer = (r) => `\n\n— Mender · ${MODEL} · ${r.steps} steps · $${r.cost.toFixed(2)}`;

function commitAndPush(branch, message) {
  sh("git", ["add", "-A"]);
  sh("git", ["-c", "user.name=Mender", "-c", "user.email=mender@checkmyapp.dev", "commit", "-q", "-m", message]);
  sh("git", ["push", "-q", "-u", "origin", branch]);
}

async function doTicket(issue) {
  say(`ticket ${issue.identifier}: ${issue.title}`);
  await setState(issue.id, "In Progress");
  const r = await work(`Your ticket is ${issue.identifier} (${issue.url}). Read it with the Linear tools, follow .mender/MENDER.md, and do it.`);
  if (r.status !== "done" || !changed()) {
    sh("git", ["checkout", "-q", "--", "."]);
    sh("git", ["clean", "-fdq"]);
    await comment(issue.id, `${ATTEMPT_MARK}\n**Mender did not open a pull request** (${r.status === "done" ? "no change" : r.status}).\n\n${r.text || "(no report)"}${footer(r)}`);
    await setState(issue.id, "Todo");
    return;
  }
  const slug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/-+$/, "");
  const branch = `mender/${issue.identifier.toLowerCase()}-${slug}`;
  sh("git", ["checkout", "-q", "-b", branch]);
  commitAndPush(branch, `${issue.identifier}: ${issue.title}\n\n${r.text.replace("MENDER_DONE", "").trim()}`);
  const url = gh(["pr", "create", "--head", branch, "--title", `${issue.identifier}: ${issue.title}`,
    "--body", `${issue.url}\n\n${r.text.replace("MENDER_DONE", "").trim()}${footer(r)}\n\nMerged by a person, never by Mender.`]);
  gh(["pr", "comment", url, "--body", "@coderabbitai review"]);
  await comment(issue.id, `${ATTEMPT_MARK}\n**Pull request opened:** ${url}\nCodeRabbit asked to review.\n\n${r.text.replace("MENDER_DONE", "").trim()}${footer(r)}`);
  await setState(issue.id, "In Review");
  say(`opened ${url}`);
}

async function doReview({ pr, pending, round, ticket }) {
  say(`review round ${round} on #${pr.number}`);
  sh("git", ["fetch", "-q", "origin", pr.headRefName]);
  sh("git", ["checkout", "-q", "-B", pr.headRefName, `origin/${pr.headRefName}`]);
  const findings = pending.map((c) => `- ${c.body.slice(0, 2000)}`).join("\n");
  const r = await work(`This branch is the pull request ${pr.url} for ${ticket ?? "its ticket"}. Review round ${round}: CodeRabbit left these comments. Follow .mender/MENDER.md "Review rounds".\n\n${findings}`);
  const pushed = r.status === "done" && changed();
  if (pushed) commitAndPush(pr.headRefName, `Review round ${round} (${ticket ?? `#${pr.number}`})`);
  gh(["pr", "comment", pr.url, "--body", `${ROUND_MARK}\n**Round ${round}: ${pushed ? "pushed" : "nothing pushed"} (${r.status}).**\n\n${r.text.replace("MENDER_DONE", "").trim() || "(no report)"}${footer(r)}${pushed && round < MAX_ROUNDS ? "\n\n@coderabbitai review" : ""}`]);
  if (ticket) {
    const d = await linear(`{issue(id:"${ticket}"){id}}`);
    await comment(d.issue.id, `**Review round ${round} on ${pr.url}: ${pushed ? "fixes pushed" : "nothing pushed"}.**${footer(r)}`);
  }
}

async function main() {
  const job = await findWork();
  if (!job) return say("nothing to do: no open review and no CHE ticket labelled `mender`");
  if (job.kind === "review") return doReview(job);
  return doTicket(job.issue);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
