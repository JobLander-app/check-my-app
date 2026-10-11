// CHE-420 (second item): a journey whose last walk left a step of OURS
// unverified is not coverage of the customer's product.
//
// Run cmuvu9xhl (Securify inside the Shopify admin, 2026-10-05) listed "Log in
// to the Shopify Admin (blocked by bot challenge)" as "carried forward from 2
// earlier runs". It came from run #301, walked on a browser that could not pass
// the challenge: steps 3–4 skipped / our_capability, rolled up `partial` — which
// counts as green — and its summary, our incapacity (rule 1), went onto a
// verdict page again.
//
// What this holds, through the real recordWalk / planRotation /
// knownJourneysToList, on a real D1:
//   1. a walk that leaves an our_capability step marks the catalog row, and the
//      next walk that leaves none clears it; a walk that did not happen moves
//      nothing;
//   2. such a journey is not green: never carried, always due for a re-walk;
//   3. it is not listed on a run that did not walk it, like one never walked;
//   4. a journey with only `missing_access` / `not_applicable` gaps is a gap of
//      the customer's setup, not ours, and stands as before;
//   5. the migration sets the flag on rows that already exist, from the walk
//      they point at (the same UPDATE, run over seeded rows).
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-gap-journey-not-coverage.ts

import "./fixtures/wasm-module-loader.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Module from "node:module";
import { realD1 } from "./fixtures/real-d1";
import type { AgentEnv } from "@/agent/env";
import { journeysForPlanning, leftOurGap, recordWalk } from "@/agent/journey-catalog";

// partial.ts reaches replay.ts → browser.ts, whose @cloudflare/playwright
// requires the `cloudflare:workers` builtin at load time; nothing here opens a
// browser.
const moduleLoader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const realLoad = moduleLoader._load;
moduleLoader._load = function (request: string, ...rest: unknown[]) {
  if (request === "cloudflare:workers") return {};
  return realLoad.call(this, request, ...rest);
};

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const NOW = new Date("2026-10-06T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

async function main() {
  const { planRotation, knownJourneysToList } = await import("@/agent/partial");
  const real = await realD1();
  try {
    const db = real.db;
    await db.user.create({ data: { id: "ann", clerkUserId: "ck_ann", email: "ann@a.test" } });
    await db.team.create({ data: { id: "team_a", name: "A", plan: "business" } });
    await db.app.create({ data: { id: "app_a", teamId: "team_a", ownerId: "ann", appSlug: "securify", targetUrl: "https://admin.example.test", targetKind: "website" } });
    await db.run.create({ data: { id: "run_301", runNumber: 301, ownerId: "ann", teamId: "team_a", targetUrl: "https://admin.example.test", appSlug: "securify", status: "completed" } as never });
    const env = { db, bindings: {} } as unknown as AgentEnv;

    const seed = async (id: string, title: string) => {
      await db.appJourney.create({ data: { id, appId: "app_a", key: id, title, aliases: JSON.stringify([title]) } });
    };
    await seed("aj_login", "Log in to the Shopify Admin (blocked by bot challenge)");
    await seed("aj_clean", "Review the dashboard");
    await seed("aj_access", "Open the billing page");

    // ── 1. the flag follows the walk ─────────────────────────────────────────
    const walk = (id: string, status: string, gap: boolean | undefined, at: Date, runId = "run_301") =>
      recordWalk(env, { appJourneyId: id, runId, runNumber: 301, title: id, status, plan: ["a"], gap, at });
    const flagOf = async (id: string) => (await db.appJourney.findUnique({ where: { id } }))?.lastWalkGap;

    check("leftOurGap: an our_capability step is a gap of ours", leftOurGap([{ unverifiedReason: "our_capability" }]));
    check(
      "leftOurGap: missing_access and not_applicable are not",
      !leftOurGap([{ unverifiedReason: "missing_access" }, { unverifiedReason: "not_applicable" }, { unverifiedReason: null }, {}]),
    );

    await walk("aj_login", "partial", true, daysAgo(4));
    await walk("aj_clean", "ok", false, daysAgo(2));
    await walk("aj_access", "partial", false, daysAgo(3));
    check("a walk that left our_capability marks the row", (await flagOf("aj_login")) === true);
    check("a walk that left none does not", (await flagOf("aj_clean")) === false && (await flagOf("aj_access")) === false);

    await walk("aj_login", "skipped", false, daysAgo(3));
    check("a walk that did not happen (skipped) moves nothing", (await flagOf("aj_login")) === true);
    await walk("aj_login", "partial", true, daysAgo(4));

    // ── 2 + 3. what the plan does with it ────────────────────────────────────
    const catalog = await journeysForPlanning(env, "app_a");
    const login = catalog.find((j) => j.appJourneyId === "aj_login");
    check("the planning state carries the flag", login?.gap === true && catalog.find((j) => j.appJourneyId === "aj_clean")?.gap === false);

    // Give every row a dated walk of its own, as production has.
    // The gap journey is the MOST recently walked, so nothing but the flag can
    // put it ahead of the others in the queue or keep it out of the carry list.
    const dated = catalog.map((j) => ({
      ...j,
      lastWalkedRunId: "run_301",
      lastWalkedAt: j.appJourneyId === "aj_login" ? daysAgo(0.5) : (j.lastWalkedAt ?? daysAgo(4)),
      status: j.status ?? "ok",
    }));
    const loginState = dated.find((j) => j.appJourneyId === "aj_login")!;
    check("the journey still reads partial — the status that used to count as green", loginState.status === "partial");

    const rotation = planRotation({ journeys: dated, now: NOW, budget: 1 });
    check("it is due for a re-walk ahead of green journeys", rotation.walk[0]?.appJourneyId === "aj_login", rotation.walk.map((j) => j.title).join(" | "));
    check("…and is never carried, whatever the budget", !rotation.carry.some((j) => j.appJourneyId === "aj_login"));
    const roomy = planRotation({ journeys: dated, now: NOW, budget: 5 });
    check("…even when the budget reaches everything it is walked, not carried", roomy.walk.some((j) => j.appJourneyId === "aj_login") && roomy.carry.length === 0);
    const unmarked = planRotation({ journeys: dated.map((j) => ({ ...j, gap: false })), now: NOW, budget: 1 });
    check(
      "the same row without the flag is carried as before (the flag is what changes it)",
      unmarked.carry.some((j) => j.appJourneyId === "aj_login"),
      unmarked.walk.map((j) => j.title).join(" | "),
    );

    const listed = knownJourneysToList({ catalog: dated, present: [] }).map((j) => j.appJourneyId);
    check("a journey that left our gap is not listed on a run that did not walk it", !listed.includes("aj_login"), listed.join(","));
    check("journeys that did stand are still listed", listed.includes("aj_clean") && listed.includes("aj_access"), listed.join(","));

    await walk("aj_login", "partial", false, daysAgo(1));
    check("the next walk that leaves no gap clears it", (await flagOf("aj_login")) === false);
    const after = knownJourneysToList({ catalog: await journeysForPlanning(env, "app_a"), present: [] }).map((j) => j.appJourneyId);
    check("…and the journey stands as coverage again", after.includes("aj_login"), after.join(","));

    // ── 5. the migration's backfill, over rows that predate the column ───────
    await db.run.create({ data: { id: "run_old", runNumber: 300, ownerId: "ann", teamId: "team_a", targetUrl: "https://admin.example.test", appSlug: "securify", status: "completed" } as never });
    for (const [aj, reason] of [["aj_login", "our_capability"], ["aj_clean", null], ["aj_access", "missing_access"]] as const) {
      await db.journey.create({
        data: {
          id: `j_${aj}`, runId: "run_old", order: 0, appJourneyId: aj, title: aj, status: "partial",
          steps: { create: [{ order: 0, label: "Open", status: "ok", actions: "[]" }, { order: 1, label: "Pass the challenge", status: "skipped", unverifiedReason: reason, actions: "[]" }] },
        } as never,
      });
    }
    await real.exec(`UPDATE "AppJourney" SET "lastWalkedRunId" = 'run_old', "lastWalkGap" = 0`);
    const migration = readFileSync(join(process.cwd(), "prisma/migrations/0065_journey_last_walk_gap.sql"), "utf8");
    const backfill = migration.slice(migration.indexOf("UPDATE")).replace(/;\s*$/, "").replace(/^\s*--.*$/gm, "");
    await real.exec(backfill);
    check(
      "the migration marks only the row whose last walk left an our_capability step",
      (await flagOf("aj_login")) === true && (await flagOf("aj_clean")) === false && (await flagOf("aj_access")) === false,
      JSON.stringify([await flagOf("aj_login"), await flagOf("aj_clean"), await flagOf("aj_access")]),
    );
  } finally {
    await real.dispose();
  }
  console.log(failures ? `\nverify-gap-journey-not-coverage: ${failures} FAILED` : "\nverify-gap-journey-not-coverage: all passed");
  process.exit(failures ? 1 : 0);
}

void main();
