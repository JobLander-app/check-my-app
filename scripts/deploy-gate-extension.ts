// A deploy waits for the checks running in production. Run by CI before the
// migrations and the deploy itself.
//
// An extension check dies with a deploy: it rebuilds and rolls the container
// image, and an extension run in flight loses its executor — "Runtime
// signalled the container to exit due to a new version rollout" (CHE-272, runs
// #195 and #202). It cannot confirm that a paid session stopped charging and
// publishes nothing. So a deploy waits for it, and fails rather than kill it.
//
// A website check survives a deploy but re-executes its current step, which
// doubles what that step costs. That used to be avoided by a convention —
// "merge only when D1 shows nothing in flight" — and a convention fails when
// nobody is there to keep it. Since CHE-486 Mender's pull requests merge
// themselves at any hour, so the deploy waits for every check, website ones
// too, and does not deploy over one (Codex, #356): past the wait it fails, and
// the next push deploys. A check started more than STALE_HOURS ago is not "in
// flight" but stuck, and is not waited for — one hung row must not hold every
// deploy forever; the orphan sweep is what ends it.
//
// The same rule with nobody to remember it. It also outlives any convention: a
// scheduled check appears on no announcement at all.
//
// Skipped, not failed, when there are no credentials: the deploy job is already
// a no-op then, and a gate that fails a pipeline it cannot inform is worse than
// no gate.

import { readFileSync } from "node:fs";
import { LIVE_RUN_STATUSES } from "../src/lib/enums";

const WAIT_MS = Number(process.env.DEPLOY_GATE_WAIT_MS ?? 60 * 60 * 1000);
const POLL_MS = Number(process.env.DEPLOY_GATE_POLL_MS ?? 30_000);
const STALE_HOURS = 3;

interface LiveRun { runNumber: number; status: string; appSlug: string; targetKind: string }

function databaseId(): string {
  const config = readFileSync(new URL("../wrangler-agent.jsonc", import.meta.url), "utf8");
  const id = /"database_id"\s*:\s*"([0-9a-f-]+)"/.exec(config)?.[1];
  if (!id) throw new Error("wrangler-agent.jsonc has no database_id — the gate cannot find the database to ask");
  return id;
}

async function liveRuns(account: string, token: string, database: string): Promise<LiveRun[]> {
  const statuses = LIVE_RUN_STATUSES.map(status => `'${status}'`).join(", ");
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      sql: `SELECT runNumber, status, appSlug, targetKind FROM Run WHERE status IN (${statuses}) ` +
        `AND createdAt > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${STALE_HOURS} hours')`,
    }),
  });
  if (!response.ok) throw new Error(`D1 refused the question (HTTP ${response.status}); the gate cannot tell whether a run is in flight`);
  const body = await response.json() as { success: boolean; result?: { results: LiveRun[] }[]; errors?: unknown };
  if (!body.success) throw new Error(`D1 refused the question: ${JSON.stringify(body.errors)}`);
  return body.result?.[0]?.results ?? [];
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN, account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) {
    console.log("deploy-gate: no Cloudflare credentials — nothing to deploy into, so nothing to wait for.");
    return;
  }
  const database = databaseId();
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const running = await liveRuns(account, token, database);
    if (!running.length) {
      console.log("deploy-gate: no check in flight — deploying.");
      return;
    }
    const names = running.map(run => `#${run.runNumber} ${run.appSlug} (${run.targetKind}, ${run.status})`).join(", ");
    if (Date.now() >= deadline) {
      console.error(`deploy-gate: still in flight after ${Math.round(WAIT_MS / 60_000)} minutes: ${names}.`);
      console.error(running.some(run => run.targetKind === 'extension')
        ? "Deploying now would kill an extension check and leave a paid session with nobody to stop it."
        : "Deploying now would make each of these checks repeat its current step, at a cost.");
      console.error("Not deployed. The next push to main deploys this commit too; or re-run this job when the checks are done.");
      process.exitCode = 1;
      return;
    }
    console.log(`deploy-gate: waiting for ${names}…`);
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

main().catch(error => {
  // An unanswerable question is not permission to proceed: the whole point is
  // that nobody is watching.
  console.error(`deploy-gate: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
