// CHE-445: Mender, the OpenCode agent that takes CHE tickets. What must hold
// whatever the model does: it takes one ticket at a time, oldest first; a
// ticket tried twice without a PR steps aside; a PR gets at most three review
// rounds; the checks run before anything is pushed; and nothing merges.
//
// Usage: node scripts/verify-mender-agent.mjs

import { readFileSync } from "node:fs";
import { CHECKS, chooseTicket, pendingReview } from "./mender/agent.mjs";

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

const agent = read("scripts/mender/agent.mjs");
check("Mender never merges", !/pr["',\s]+merge|merge_pull|gh pr merge/i.test(agent));
check("typecheck (both) and lint run before a push",
  ["typecheck", "agent:typecheck", "lint"].every((s) => CHECKS.some(([, a]) => a.includes(s))) &&
    agent.indexOf("failingChecks()") < agent.indexOf("commitAndPush(branch"));
check("review is asked of CodeRabbit, never Codex", /@coderabbitai review/.test(agent) && !/@codex/.test(agent));

const cfg = JSON.parse(read("opencode.json"));
check("the agent reads Linear and Notion", cfg.mcp?.linear?.enabled && cfg.mcp?.notion?.enabled);
check("its rules are loaded", (cfg.instructions ?? []).includes(".mender/MENDER.md"));

const wf = read(".github/workflows/mender-agent.yml");
check("one tick at a time", /concurrency:\s*\n\s*group: mender-agent/.test(wf));
check("the model is paid on OpenRouter, not the Claude subscription",
  /OPENROUTER_API_KEY/.test(wf) && !/CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY/.test(wf));

console.log(bad === 0 ? "\nall pass" : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
