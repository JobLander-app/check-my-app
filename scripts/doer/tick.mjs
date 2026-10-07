// One tick of the doer (design: "the second half of the loop", 2026-09-02).
//
// CheckMyApp files tickets against itself. Until now a person closed them, which
// is the builder grading its own work — the thing rule §8 forbids. This claims
// one ticket, has Mender attempt it, and publishes the attempt. Whether the work
// is actually FIXED is never decided here: the dispatcher may say shipped, and
// only a later CheckMyApp run walking the deployed product from outside may say
// resolved (src/agent/reconcile.ts).
//
// Runs in GitHub Actions rather than on a VM for one reason paid for on
// 2026-09-01: JobLander's dispatcher died of an out-of-memory kill on 26 August
// and nobody noticed for six days, because a stopped machine is silent while a
// failed workflow is loud.
//
// The implementer is Mender (scripts/doer/mender.mjs), run inside this tick.
// It used to be Codex, asked by a comment on the claim's pull request; Codex
// answers only a ChatGPT-linked identity and could not push here (CHE-155), and
// six claims in a row came back "the implementer never came". Codex is the
// reviewer now (scripts/doer/review.mjs), which is the half it could always do.
//
// Usage:
//   node scripts/doer/tick.mjs --dry-run   # decide and print, touch nothing
//   node scripts/doer/tick.mjs             # act

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideTick, branchFor, isDoerBranch, STOP_LABEL } from "./eligibility.mjs";
import { ROUND_ANSWER_MARKER, roundState } from "./machine.mjs";
import { COMMIT_IDENTITY, WITHDRAWN_TITLE_PREFIX, modelMarker, outcomeOf, runMender, ticketFor, tierModel, withdrawnByModel } from "./mender.mjs";
import { partition } from "./queue.mjs";

const DRY = process.argv.includes("--dry-run");
const REPO = process.env.DOER_REPO ?? "sorokinvj/check-my-app";
const BASE = "main";

function gh(args, { json = true } = {}) {
  const out = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return json ? JSON.parse(out || "null") : out;
}
function run(cmd, args, opts = {}) {
  if (DRY) return console.log(`   [dry-run] ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}
const say = (s) => console.log(s);

// ─── State ───────────────────────────────────────────────────────────────────
//
// The queue is what our own runs filed and nothing else (CHE-118). It is read
// from our database rather than from labels on GitHub issues, because the
// tickets were never there: a run that cannot verify a step files a "[Checker
// gap] …", a rejected claim files a "[Checker defect] …", and both leave a row
// in IssueLink. The label queue was filled by a person once, in September, and
// by nobody since (CHE-170).
//
// Shelling out to tsx rather than importing: this file is plain node and the
// reader needs the product's own hashing to recognise a capability. The tick
// already shells out to `gh` for everything else.
const board = JSON.parse(
  execFileSync("npx", ["tsx", "--tsconfig", "tsconfig.json", "scripts/doer/board-queue.ts", "--json"], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  }),
);
const { queue, refused } = partition(board.known);

// Every tick says what it saw, including what it refused and why. A queue that
// silently drops most of what it is offered looks identical to an empty one,
// and telling those two apart is the whole of CHE-152.
say(`Board: ${board.known.length} open ticket(s) of ours, ${queue.length} admitted, ${refused.length} refused`);
for (const r of refused) say(`   refused ${r.ticket} — ${r.reason}`);
for (const u of board.unknown ?? []) {
  say(`   ${u.ticket} matches no capability this repository knows about — the two lists have drifted apart`);
}

// How many attempts at each ticket came back with nothing (CHE-211). No new
// store for this: a withdrawn attempt leaves a closed pull request on the
// ticket's own branch, titled as such, and that is the history. Merged ones are
// not counted — those are attempts that ended in work — and neither are the
// Codex-era claims nobody ever attempted (mender.mjs isWithdrawnAttempt).
// Counted per model: a ticket the t1 model gave up on twice is fresh for t2
// (mender.mjs withdrawnByModel).
const model = tierModel();
const closedDoerPrs = gh([
  "pr", "list", "--repo", REPO, "--state", "closed", "--limit", "100",
  "--json", "headRefName,mergedAt,title,body",
]).filter((p) => isDoerBranch(p.headRefName) && withdrawnByModel(p, model));

const withdrawnByTicket = {};
for (const p of closedDoerPrs) {
  const ticket = ticketOfBranch(p.headRefName);
  withdrawnByTicket[ticket] = (withdrawnByTicket[ticket] ?? 0) + 1;
}

// Branches are `doer/<ticket>-<slug>`; the ticket is what the tick put there.
function ticketOfBranch(ref) {
  return String(ref).slice("doer/".length).split("-").slice(0, 2).join("-").toUpperCase();
}

// The repository-wide stop stays on GitHub, where a person who wants the doer to
// stop is already looking. It is the one brake that must not require the board.
const issues = gh([
  "issue", "list", "--repo", REPO, "--state", "open", "--limit", "100",
  "--json", "number,title,labels",
]).map((i) => ({ ...i, labels: i.labels.map((l) => l.name) }));

const openPrs = gh([
  "pr", "list", "--repo", REPO, "--state", "open", "--limit", "50",
  "--json", "number,headRefName,headRefOid,isDraft",
]);
const openDoerPrs = openPrs
  .filter((p) => isDoerBranch(p.headRefName))
  .map((p) => ({ number: p.number, headRef: p.headRefName, headSha: p.headRefOid, isDraft: p.isDraft }));

const stopped = issues.some((i) => i.labels.includes(STOP_LABEL));
if (stopped) {
  say(`Stopped — a ${STOP_LABEL} label is set. Nothing was touched.`);
  process.exit(0);
}

// ─── First: an open pull request waiting on a fix round ──────────────────────
//
// Driving a PR to a decision is the shepherd's job (CHE-122); it runs every
// twenty minutes and holds no implementer. When it hands findings back it
// writes a round marker, and answering that is this tick's first duty — nothing
// new may be built while something old is waiting on us. One open doer PR at a
// time (eligibility.mjs), so at most one of these.
for (const pr of openDoerPrs) {
  if (pr.isDraft) continue;
  const headAt = gh(["api", `repos/${REPO}/commits/${pr.headSha}`, "--jq", ".commit.committer.date"], { json: false }).trim();
  const comments = gh([
    "api", `repos/${REPO}/issues/${pr.number}/comments?per_page=100`,
    "--jq", "[.[] | {body: .body, createdAt: .created_at}]",
  ]) ?? [];
  const { pending, roundsUsed } = roundState(comments, headAt);
  if (!pending) continue;

  const ticket = ticketOfBranch(pr.headRef);
  const item = board.known.find((k) => k.ticket === ticket);
  say(`PR #${pr.number} (${pr.headRef}) has a fix round waiting (round ${roundsUsed}).`);
  if (!item) {
    say(`   ${ticket} is no longer open on the board — leaving the pull request to the shepherd.`);
    continue;
  }
  const findings = pending.body.split(ROUND_ANSWER_MARKER)[0].replace(/<!--.*?-->/gs, "").trim();
  const attempt = runAttempt({
    item,
    base: pr.headRef,
    attempt: roundsUsed + 1,
    round: { round: roundsUsed, findings },
  });
  if (attempt.action === "commit") {
    commitPatch({ branch: pr.headRef, patch: attempt.patch, message: `Mender: round ${roundsUsed} — ${item.label}` });
    comment(pr.number, `${ROUND_ANSWER_MARKER}\n**Round ${roundsUsed} answered with a push.** ${attempt.summary}\n\n${attempt.reportText}`);
  } else {
    comment(pr.number,
      `${ROUND_ANSWER_MARKER}\n**Round ${roundsUsed}: nothing pushed.** ${attempt.summary}\n\n${attempt.reportText}\n\n` +
      `The findings above are still open. The shepherd decides whether there is a round left.`);
  }
  say("Fix round done. Nothing here decides whether it worked.");
  process.exit(0);
}

// ─── Then: may we start something new? ───────────────────────────────────────
const decision = decideTick({ queue, openDoerPrs, stopped, withdrawnByTicket });
if (!decision.act) {
  say(`No new work this tick: ${decision.reason}`);
  process.exit(0);
}

for (const t of decision.steppedAside ?? []) {
  say(`   ${t.ticket} steps aside — ${t.withdrawn} attempt(s) came back with nothing; it waits for a fix on our side`);
}

const item = decision.item;
const branch = branchFor(item.ticket.toLowerCase(), item.label);
if (!branch.startsWith("doer/")) throw new Error(`refusing to push a branch outside doer/: ${branch}`);
say(`Claiming ${item.ticket} — ${item.label}`);
say(`Branch: ${branch}`);

if (!DRY) {
  mkdirSync(".doer", { recursive: true });
  // What the pull request carries about the ticket: the capability, and where
  // to read the rest. The evidence itself goes to Mender in the ticket file and
  // never into this public repository — the step text is a customer's product.
  writeFileSync(
    ".doer/TICKET.md",
    `# ${item.label}\n\nTicket: ${item.ticket} (${item.kind}, seen ${item.occurrences} time(s))\n`,
  );
}
run("git", ["config", "user.name", COMMIT_IDENTITY.name]);
run("git", ["config", "user.email", COMMIT_IDENTITY.email]);
// A branch left behind by a failed claim is invisible to the eligibility check,
// which counts open PRs — so the tick claims the same ticket again, and the push
// fails as a non-fast-forward every two hours forever. That is what happened on
// 2026-09-03: the 16:23 tick pushed doer/6, could not open the PR, and left the
// branch; every tick after it died on the push instead of naming the real cause.
//
// Deleting it is safe by construction: a doer branch with no PR carries the
// claim and at most a patch nobody published, and both are about to be made again.
if (!DRY) {
  try {
    execFileSync("git", ["ls-remote", "--exit-code", "--heads", "origin", branch], { stdio: "ignore" });
    say(`Found a leftover ${branch} with no PR — removing it before claiming again.`);
    run("git", ["push", "origin", "--delete", branch]);
  } catch {
    // exit code 2 means no such branch, which is the normal case.
  }
}

run("git", ["checkout", "-b", branch]);
run("git", ["add", "-f", ".doer/TICKET.md"]);
run("git", ["commit", "-m", `doer: claim ${item.ticket} — ${item.label}`]);
run("git", ["push", "-u", "origin", branch]);

// ─── The attempt ─────────────────────────────────────────────────────────────
const attempt = runAttempt({ item, base: branch, attempt: (withdrawnByTicket[item.ticket] ?? 0) + 1 });

const title = `[doer] ${item.label}`;
const provenance =
  `Claimed from ${item.ticket} (${item.kind}, seen ${item.occurrences} time(s)).\n\n` +
  `The patch was written by Mender — a model holding no credentials for this repository — and ` +
  `checked on a clean checkout it never saw: apply, setup, typecheck, lint, the \`verify:*\` registry, ` +
  `and a test that fails without the patch and passes with it. The merge gate and the reviewer decide ` +
  `whether it merges; only a later CheckMyApp run walking the deployed product decides whether the ` +
  `problem is gone (src/agent/reconcile.ts).`;

if (attempt.action === "commit") {
  commitPatch({ branch, patch: attempt.patch, message: `Mender: ${item.label} (${item.ticket})` });
  openPr({ branch, title, body: `${provenance}\n\n${attempt.reportText}`, draft: false });
  say("Published. This tick is done — nothing here decides whether it worked.");
} else {
  // For the record, and for the count (CHE-211): a red attempt is a closed
  // pull request on the ticket's branch, which is how the next tick knows this
  // ticket has been tried. Opened as a draft so the reviewer never reads it.
  const pr = openPr({
    branch,
    title: `${WITHDRAWN_TITLE_PREFIX} — ${item.label}`,
    body: `${modelMarker(model)}\n${provenance}\n\n**Attempt withdrawn.** ${attempt.summary}\n\n${attempt.reportText}`,
    draft: true,
  });
  if (attempt.action === "defect") {
    say(`   DEFECT: ${attempt.summary}`);
  }
  if (pr) {
    run("gh", ["pr", "close", String(pr), "--repo", REPO, "--delete-branch", "--comment",
      `Nothing was built and nothing is judged here — the ticket is untouched and may be attempted again. ` +
      `${attempt.summary}`]);
  }
  say("Attempt withdrawn. This tick is done.");
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function runAttempt({ item, base, attempt = 1, round = null }) {
  const ticket = ticketFor({ item, repo: REPO, round });
  const dir = join(tmpdir(), "doer-mender");
  mkdirSync(dir, { recursive: true });
  const ticketFile = join(dir, `${item.ticket}.json`);
  writeFileSync(ticketFile, JSON.stringify(ticket, null, 2));
  say(`Ticket for Mender written to ${ticketFile} (${ticket.body.length} chars)`);

  if (DRY) {
    say(`   [dry-run] Mender would run on base ${base}`);
    return { action: "withdraw", summary: "dry run — Mender was not run", patch: null, reportText: "" };
  }

  const result = runMender({ ticketFile, base, attempt, say });
  const outcome = outcomeOf(result.row, !!result.patch);
  say(`   ${outcome.summary}`);
  const reportText = result.report ? readFileSync(result.report, "utf8") : "_(no report was written)_";
  return { ...outcome, patch: result.patch, reportText };
}

function commitPatch({ branch, patch, message }) {
  if (DRY) return say(`   [dry-run] would apply ${patch} on ${branch} and push`);
  // The working tree is on `branch` already (claim) or must be moved there
  // (fix round): fetch what the branch holds, sit on it, apply, push. No
  // --force anywhere: a fix round is a new commit on top of the earlier patch.
  execFileSync("git", ["fetch", "origin", branch], { stdio: "inherit" });
  execFileSync("git", ["checkout", "-B", branch, `origin/${branch}`], { stdio: "inherit" });
  execFileSync("git", ["apply", "--whitespace=nowarn", "-p1", patch], { stdio: "inherit" });
  execFileSync("git", ["add", "-A"], { stdio: "inherit" });
  execFileSync("git", ["commit", "-m", message], { stdio: "inherit" });
  execFileSync("git", ["push", "origin", branch], { stdio: "inherit" });
}

// If the PR cannot be opened, take the branch back down. A pushed branch with no
// PR is the orphan above — it poisons every later tick on the same ticket, and
// the failure it produces then names the push rather than the reason the PR could
// not be created. Fail loudly at the real cause instead.
function openPr({ branch, title, body, draft }) {
  const args = ["pr", "create", "--repo", REPO, "--base", BASE, "--head", branch, "--title", title, "--body", body];
  if (draft) args.push("--draft");
  try {
    run("gh", args);
  } catch (err) {
    if (!DRY) {
      say(`Could not open the pull request — removing ${branch} so the next tick is not blocked by it.`);
      try { execFileSync("git", ["push", "origin", "--delete", branch], { stdio: "inherit" }); } catch {}
    }
    throw err;
  }
  const number = DRY ? null : gh(["pr", "view", branch, "--repo", REPO, "--json", "number"]).number;
  say(`PR opened: #${number ?? "(dry-run)"}`);
  return number;
}

function comment(prNumber, body) {
  run("gh", ["pr", "comment", String(prNumber), "--repo", REPO, "--body", body]);
}
