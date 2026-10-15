import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LIVE_RUN_STATUSES, TERMINAL_RUN_STATUSES, RUN_STATUSES, RUN_STATUS_KIND } from "../src/lib/enums";

// The gate exists because a deploy kills an extension run in flight (CHE-272),
// and it can only be trusted if it cannot go blind. Two ways it could: a new
// run status nobody classified, and a second copy of the status list somewhere
// that drifts from the first.
async function main() {
  // Exhaustive by construction — Record<RunStatus, …> will not compile with a
  // member missing — so this asserts the halves are disjoint and complete.
  assert.equal(LIVE_RUN_STATUSES.length + TERMINAL_RUN_STATUSES.length, RUN_STATUSES.length);
  assert.equal(LIVE_RUN_STATUSES.some(status => TERMINAL_RUN_STATUSES.includes(status)), false, "A status cannot be both");
  assert.ok(RUN_STATUSES.length >= 11, `Every run status must be classified; found ${RUN_STATUSES.length}`);
  for (const status of ["queued", "walking", "writing"] as const) assert.equal(RUN_STATUS_KIND[status], "live");
  // The one that was missing when this was three hand-kept lists.
  for (const status of ["completed", "partial", "failed", "canceled"] as const) assert.equal(RUN_STATUS_KIND[status], "terminal");

  const gate = readFileSync(new URL("./deploy-gate-extension.ts", import.meta.url), "utf8");
  assert.match(gate, /LIVE_RUN_STATUSES/, "The gate must read the classification, never spell its own list");
  assert.doesNotMatch(gate, /'(queued|walking|writing)'/, "A hardcoded status in the gate is a list that will drift");
  // CHE-486: Mender's PRs merge themselves at any hour, so the deploy waits for
  // every check in flight. Only an extension check dies, so only it fails the
  // deploy past the wait; a website check repeats a step and is deployed over.
  assert.doesNotMatch(gate, /WHERE targetKind = 'extension' AND/, "The gate waits for every check in flight, not only extension ones");
  assert.match(gate, /running\.some\(run => run\.targetKind === 'extension'\)\)[\s\S]*?process\.exitCode = 1/, "Past the wait, an extension check still fails the deploy");
  assert.match(gate, /::warning::deploy-gate: website check/, "…while website checks are deployed over, with a warning");
  assert.match(gate, /process\.exitCode = 1;\n\}\);/, "An unanswerable question is not permission to deploy");

  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const gateAt = workflow.indexOf("deploy-gate-extension.ts");
  const migrationsAt = workflow.indexOf("d1 migrations apply");
  const deployAt = workflow.indexOf("wrangler deploy");
  assert.ok(gateAt > 0, "The deploy job must run the gate");
  assert.ok(gateAt < migrationsAt && gateAt < deployAt, "The gate runs before anything that touches production");
  assert.equal(workflow.slice(0, gateAt).includes("jobs:\n  check"), true, "The gate belongs to the deploy job, not the check job — a red check would block every merge");

  // CHE-471: deploys queue on one group and run in the order their checks
  // finish, so an older commit can deploy after a newer one and take it back
  // out of production (04beb87 over 445f241, 2026-10-13). A deploy whose commit
  // is no longer main's tip stops before it touches anything.
  const deployJob = workflow.slice(workflow.indexOf("\n  deploy:\n"));
  const steps = deployJob.split(/\n      - /).slice(1);
  const stepWith = (marker: string) => {
    const found = steps.filter(step => step.includes(marker));
    assert.equal(found.length, 1, `Exactly one deploy step must contain ${marker}`);
    return found[0];
  };
  // Asked twice: before anything (a superseded deploy waits for nothing), and
  // again after the extension gate, which can hold the job 25 minutes while a
  // newer commit merges and queues behind it.
  const newest = stepWith("id: newest");
  const still = stepWith("id: still");
  for (const [name, step] of [["newest", newest], ["still", still]] as const) {
    assert.match(step, /commits\/main/, `The ${name} step must ask GitHub for main's tip`);
    assert.match(step, /\$GITHUB_SHA/, `…and compare it with the commit this deploy would ship (${name})`);
    assert.doesNotMatch(step, /\|\|\s*(true|:)|continue-on-error/, `A tip lookup that cannot fail silently (${name}): a swallowed error would skip every deploy without a red run`);
  }
  assert.ok(steps.indexOf(newest) < steps.indexOf(stepWith("id: creds")), "The newest-commit step answers before the deploy decides it is ready");
  assert.match(stepWith("id: creds"), /steps\.newest\.outputs\.yes == 'true'/, "Ready means credentials and the newest commit");
  const gateStep = stepWith("deploy-gate-extension.ts");
  assert.match(gateStep, /if: steps\.creds\.outputs\.ready == 'true'/, "The extension gate runs only when this deploy is ready");
  assert.match(still, /if: steps\.creds\.outputs\.ready == 'true'/, "The second look runs only for a deploy that was ready");
  assert.ok(steps.indexOf(gateStep) < steps.indexOf(still), "The second look comes after the gate's wait");
  for (const marker of ["d1 migrations apply", "wrangler deploy --config", "opennextjs-cloudflare build", "opennextjs-cloudflare deploy", "sync-plans-notion"]) {
    const step = stepWith(marker);
    assert.ok(steps.indexOf(still) < steps.indexOf(step), `The second look comes before ${marker}`);
    assert.match(step, /if: steps\.still\.outputs\.yes == 'true'/, `${marker} must run only when this commit is still main's tip after the wait`);
  }
  assert.match(stepWith("CLOUDFLARE_API_TOKEN not set"), /steps\.newest\.outputs\.yes == 'true'/, "A superseded deploy must not claim the token is missing");

  console.log("deploy gate: statuses classified once, the gate reads them, it runs before production is touched, and only main's tip deploys");
}

main();
