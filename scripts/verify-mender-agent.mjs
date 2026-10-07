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
import { CHECKS, agentEnv, branchFor, chooseTicket, forbiddenPaths, pendingReview, stagedPaths, stranded, validBranch } from "./mender/agent.mjs";

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
check("…an ordinary change is not", forbiddenPaths(["src/lib/a.ts", "scripts/verify-x.ts", "prisma/schema.prisma"]).length === 0);
check("the model's environment holds no GitHub token",
  Object.keys(agentEnv({ GH_TOKEN: "x", GITHUB_TOKEN: "y", MENDER_GH_TOKEN: "z", LINEAR_API_KEY: "k" })).join() === "LINEAR_API_KEY");

check("the personal token pushes only to mender/che-* branches",
  validBranch("mender/che-423-a-run-stays-queued") && !validBranch("main") && !validBranch("mender/../main") &&
    !validBranch("refs/heads/main") && !validBranch("mender/che-1 main"));
check("a ticket's branch is a valid one, whatever its title",
  validBranch(branchFor({ identifier: "CHE-9", title: "«Quoted» — weird/title!!" })) && validBranch(branchFor({ identifier: "CHE-9", title: "!!!" })));

const agent = read("scripts/mender/agent.mjs");
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

const cfg = JSON.parse(read("opencode.json"));
check("the agent reads Linear and Notion", cfg.mcp?.linear?.enabled && cfg.mcp?.notion?.enabled);
check("its rules are loaded", (cfg.instructions ?? []).includes(".mender/MENDER.md"));

const wf = read(".github/workflows/mender-agent.yml");
check("one tick at a time", /concurrency:\s*\n\s*group: mender-agent/.test(wf));
const [workJob, publishJob] = wf.split(/\n  publish:\n/);
check("the model's job keeps no credential in the checkout and holds no writing token",
  /persist-credentials: false/.test(workJob) && !/MENDER_GH_TOKEN/.test(workJob) && /node scripts\/mender\/agent\.mjs work/.test(workJob));
check("publishing runs on a fresh machine from main, after the model's job",
  /needs: work/.test(publishJob ?? "") && /ref: main/.test(publishJob ?? "") && /MENDER_GH_TOKEN/.test(publishJob ?? "") && !/opencode/.test(publishJob ?? ""));
check("the model is paid on OpenRouter, not the Claude subscription",
  /OPENROUTER_API_KEY/.test(wf) && !/CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY/.test(wf));

console.log(bad === 0 ? "\nall pass" : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
