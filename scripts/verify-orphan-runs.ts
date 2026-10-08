// CHE-423 verification: a run whose hand-off to the agent threw does not stay
// queued for ever, and no run ever has two Workflow instances.
//
// Against the stub database (scripts/fixtures/mcp-db.ts) and a stand-in for the
// CHECK_RUN binding that behaves as the platform does — an instance id can be
// created once, and `get` of an id nobody created throws — through the real
// startCheck, startSavedApp and sweepOrphanedRuns:
//
//   1. the problem, as it was: with a trigger that throws, both doors leave the
//      row `queued`, and a saved app then answers `alreadyRunning` with it;
//   2. every hand-off names the instance after the run (source check: the
//      three call sites), so a second create is refused;
//   3. the sweep hands an orphan off again — once: running it twice, or two
//      sweeps at once, leaves one instance;
//   4. a run whose instance exists is left alone however long it has been
//      queued (an extension run waits for its session host in `queued`);
//   5. a binding that stays down: the run is left until GIVE_UP_AFTER_MINUTES,
//      then ended as `failed` with an internal reason, priced 0, passwords
//      cleared, its watch moved up — and the saved app can start again;
//   6. an instance that is over (errored) while the row is still queued ends
//      the run the same way; a fresh or terminal run is never touched.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-orphan-runs.ts

process.env.CREDENTIALS_SECRET ??= "verify-orphan-runs-secret";

import { readFileSync } from "node:fs";
import path from "node:path";
import { startCheck } from "@/lib/start-check";
import { startSavedApp } from "@/lib/start-saved-app";
import { GIVE_UP_AFTER_MINUTES, ORPHAN_RUN_MESSAGE, REHAND_AFTER_MINUTES, sweepOrphanedRuns, type HandOff } from "@/agent/orphan-runs";
import type { AgentEnv } from "@/agent/env";
import { createStubDb } from "./fixtures/mcp-db";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const NOW = new Date(Date.UTC(2026, 9, 7, 12, 0, 0));
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

// The platform's rules, as far as the sweep depends on them.
class FakeBinding implements HandOff {
  instances = new Map<string, { status: string }>();
  down = false;
  attempts = 0;
  async create(options: { id: string; params: { runId: string } }) {
    this.attempts++;
    if (this.down) throw new Error("binding unavailable");
    if (this.instances.has(options.id)) throw new Error("instance.already_exists");
    this.instances.set(options.id, { status: "running" });
  }
  async get(id: string) {
    const i = this.instances.get(id);
    if (!i) throw new Error("instance.not_found");
    return { status: async () => ({ status: i.status }) };
  }
}

async function main() {
  // 2 — the call sites name the instance.
  for (const file of ["src/lib/trigger.ts", "src/agent/scheduler.ts", "src/agent/index.ts"]) {
    const src = readFileSync(path.resolve(__dirname, "..", file), "utf8");
    const creates = src.match(/CHECK_RUN\.create\(\{[^)]*\)/g) ?? [];
    check(`${file}: every CHECK_RUN.create names the instance after the run`,
      creates.length > 0 && creates.every((c) => /\bid:\s*(runId|run\.id|body\.runId)\b/.test(c)), creates.join(" | "));
  }

  const stub = createStubDb({
    user: [{ id: "u_a", email: "a@team-a.test", name: "Ann" }],
    team: [{ id: "team_a", name: "Team A", plan: "business", isPersonal: false }],
    app: [{
      id: "app_a", ownerId: "u_a", teamId: "team_a", appSlug: "shop.test", targetUrl: "https://shop.test",
      targetKind: "website", testEmail: null, testPasswordEnc: null, focusAreas: null, scopeHints: null, userNotes: null,
      writeMode: "read_only", createdAt: minutesAgo(10_000),
    }],
    watch: [{ id: "watch_a", appId: "app_a", active: true, frequency: "daily", nextRunAt: new Date(NOW.getTime() + 24 * 3_600_000) }],
    run: [],
    counter: [{ id: "counter", name: "runNumber", value: 100 }],
  });
  const db = stub.db;
  const runs = stub.table("run");
  const row = (id: string) => runs.find((r) => r.id === id)!;
  const throwing = async () => { throw new Error("binding unavailable"); };

  // 1 — the problem as it stood.
  await startCheck(db, { input: { url: "https://one-off.test" }, ownerId: null, anonKeyHash: "k" }, { trigger: throwing })
    .then(() => check("start: a throwing hand-off reaches the caller", false), () => check("start: a throwing hand-off reaches the caller", true));
  const oneOff = runs[0];
  check("start: …and leaves the run queued with nothing behind it", oneOff?.status === "queued", String(oneOff?.status));

  const owner = { id: "u_a", teamId: "team_a", plan: "business" as const };
  const deps = { trigger: throwing, siteCap: () => 20 };
  await startSavedApp(db, owner, "app_a", deps).then(() => check("saved app: a throwing hand-off reaches the caller", false), () => check("saved app: a throwing hand-off reaches the caller", true));
  const saved = runs.find((r) => r.appId === "app_a")!;
  const blocked = await startSavedApp(db, owner, "app_a", { ...deps, trigger: async () => {} });
  check("saved app: the orphan blocks the next start (alreadyRunning)",
    "alreadyRunning" in blocked && blocked.publicId === saved.publicId, JSON.stringify(blocked));

  // Make both orphans old enough, and add the neighbours the sweep must leave.
  oneOff.createdAt = minutesAgo(REHAND_AFTER_MINUTES + 1);
  saved.createdAt = minutesAgo(REHAND_AFTER_MINUTES + 1);
  const seed = (id: string, status: string, ageMin: number, extra: Record<string, unknown> = {}) =>
    runs.push({ id, publicId: `pub_${id}`, runNumber: 900 + runs.length, status, createdAt: minutesAgo(ageMin), targetUrl: "https://x.test", appSlug: "x.test", teamId: null, watchId: null, testAccounts: null, ...extra });
  seed("run_fresh", "queued", 1);
  seed("run_done", "completed", 600);
  seed("run_running", "queued", GIVE_UP_AFTER_MINUTES + 120);

  const binding = new FakeBinding();
  binding.instances.set("run_running", { status: "running" });
  const filed: string[] = [];
  const env = { db, bindings: { CHECK_RUN: binding, APP_URL: "https://checkmyapp.dev" } } as unknown as AgentEnv;
  const sweepDeps = { workflow: binding, file: (async (_e: AgentEnv, id: string) => { filed.push(id); return null; }) as never };

  // 3 — handed off again, once.
  const first = await sweepOrphanedRuns(env, NOW, sweepDeps);
  check("sweep: both orphans are handed off again", first.handedOff.sort().join() === [oneOff.id, saved.id].sort().join() && first.ended.length === 0, JSON.stringify(first));
  check("sweep: each now has one instance, named after the run",
    binding.instances.has(oneOff.id as string) && binding.instances.has(saved.id as string) && binding.instances.size === 3, [...binding.instances.keys()].join());
  const again = await sweepOrphanedRuns(env, NOW, sweepDeps);
  check("sweep: a second pass hands nothing off and ends nothing", again.handedOff.length === 0 && again.ended.length === 0 && binding.instances.size === 3, JSON.stringify(again));

  // 4 — a live instance is left alone, however old.
  check("sweep: a queued run that has an instance is untouched", row("run_running").status === "queued");
  check("sweep: a fresh queued run and a finished one are untouched", row("run_fresh").status === "queued" && row("run_done").status === "completed");

  // Two ticks at once on one orphan: the platform refuses the second.
  seed("run_race", "queued", REHAND_AFTER_MINUTES + 2);
  const [a, b] = await Promise.all([sweepOrphanedRuns(env, NOW, sweepDeps), sweepOrphanedRuns(env, NOW, sweepDeps)]);
  check("sweep: two concurrent sweeps hand one run off once",
    a.handedOff.filter((i) => i === "run_race").length + b.handedOff.filter((i) => i === "run_race").length === 1 && binding.instances.has("run_race"));

  // 5 — a binding that stays down.
  binding.down = true;
  seed("run_down_young", "queued", GIVE_UP_AFTER_MINUTES - 5, { teamId: "team_a" });
  seed("run_down_old", "queued", GIVE_UP_AFTER_MINUTES + 5, {
    teamId: "team_a", watchId: "watch_a", appId: "app_a", testPasswordEnc: "enc-secret",
    testAccounts: JSON.stringify([{ label: "admin", email: "a@x.test", passwordEnc: "enc-admin" }]),
  });
  seed("run_down_oneoff", "queued", GIVE_UP_AFTER_MINUTES + 5, { teamId: "team_a", testPasswordEnc: "enc-secret", storePasswordEnc: "enc-store" });
  const down = await sweepOrphanedRuns(env, NOW, sweepDeps);
  check("down: a run younger than the give-up age is left for the next tick", row("run_down_young").status === "queued");
  check("down: older runs are ended, nothing handed off", down.handedOff.length === 0 && down.ended.sort().join() === ["run_down_old", "run_down_oneoff"].join(), JSON.stringify(down));
  const old = row("run_down_old");
  check("down: ended as failed with an internal reason", old.status === "failed" && old.errorMessage === ORPHAN_RUN_MESSAGE && String(old.errorMessage).startsWith("internal:"), `${old.status}: ${old.errorMessage}`);
  check("down: nothing is charged (priced 0)", old.priceUsd === 0, String(old.priceUsd));
  check("down: a watch run keeps its login for the next tick", old.testPasswordEnc === "enc-secret");
  const oneoff = row("run_down_oneoff");
  check("down: a one-off run loses its passwords", oneoff.testPasswordEnc === null && oneoff.storePasswordEnc === null, JSON.stringify([oneoff.testPasswordEnc, oneoff.storePasswordEnc]));
  const watchRow = stub.table("watch").find((w) => w.id === "watch_a")!;
  check("down: the watch tries again within hours, not after a whole interval",
    (watchRow.nextRunAt as Date).getTime() < NOW.getTime() + 3 * 3_600_000, String(watchRow.nextRunAt));
  check("down: the failure is filed on our board", filed.includes("run_down_old") && filed.includes("run_down_oneoff"), filed.join());

  // The saved app is startable again once its orphan is ended.
  runs.filter((r) => r.appId === "app_a" && r.status === "queued").forEach((r) => { r.status = "completed"; });
  const next = await startSavedApp(db, owner, "app_a", { ...deps, trigger: async () => {} });
  check("saved app: after the orphan is ended a new run starts", "id" in next && !("alreadyRunning" in next), JSON.stringify(next));

  // 6 — an instance that is over while the row is still queued.
  binding.down = false;
  seed("run_errored", "queued", GIVE_UP_AFTER_MINUTES + 5);
  binding.instances.set("run_errored", { status: "errored" });
  seed("run_errored_young", "queued", REHAND_AFTER_MINUTES + 1);
  binding.instances.set("run_errored_young", { status: "errored" });
  const over = await sweepOrphanedRuns(env, NOW, sweepDeps);
  check("over: an errored instance behind an old queued row ends the run", over.ended.join() === "run_errored" && row("run_errored").status === "failed", JSON.stringify(over));
  check("over: …but not before the give-up age", row("run_errored_young").status === "queued");

  console.log(failures === 0 ? "\nverify-orphan-runs: all checks passed" : `\nverify-orphan-runs: ${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-orphan-runs: crashed:", err);
  process.exit(1);
});
