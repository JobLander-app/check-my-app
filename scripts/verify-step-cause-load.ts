// CHE-443 verification: the two loaders behind the admin's card, the mail and
// the unchecked share (src/lib/step-cause-load.ts), on a real D1 (Miniflare)
// at real size — a run with well over a hundred steps, because a select that
// works on five rows can abort the engine on a real team's history.
//
//   1. causesOfRun groups a run's unchecked steps by cause, most steps first,
//      with the first labels in walk order; our defects carry no cause;
//   2. walkedOnly leaves out the journeys the run carried forward;
//   3. causesOfAppsLatestRun picks the app's latest finished run of the team:
//      not one still walking, not one with no verdict, not another team's.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-step-cause-load.ts

import "./fixtures/wasm-module-loader.mjs";
import { realD1 } from "./fixtures/real-d1";
import { causesOfAppsLatestRun, causesOfRun } from "../src/lib/step-cause-load";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

const CAPABILITY = 60;
const ACCESS = 40;
const CHECKED = 20;
const NO_REASON = 5;
const CARRIED = 20;

async function main() {
  const real = await realD1();
  const { db } = real;
  try {
    await db.user.create({ data: { id: "ua", clerkUserId: "ck_a", email: "admin@securify.test" } });
    await db.user.create({ data: { id: "ub", clerkUserId: "ck_b", email: "other@else.test" } });
    await db.team.create({ data: { id: "ta", name: "Securify", plan: "business", features: '["shopify"]' } });
    await db.team.create({ data: { id: "tb", name: "Else", plan: "business" } });
    await db.app.create({ data: { id: "a1", teamId: "ta", ownerId: "ua", appSlug: "shop.securify.test", targetUrl: "https://shop.securify.test", targetKind: "website" } });
    const run = (id: string, runNumber: number, teamId: string, ownerId: string, status: string, verdict: string | null) =>
      db.run.create({
        data: {
          id, publicId: `pub_${id}`, runNumber, teamId, ownerId, appId: "a1",
          appSlug: "shop.securify.test", targetUrl: "https://shop.securify.test", status, verdict,
        },
      });
    await run("r2", 2, "ta", "ua", "completed", "ok");
    await run("r3", 3, "ta", "ua", "partial", "broken");
    // Newer, but none of these is the app's latest finished check of team ta.
    await run("r4", 4, "ta", "ua", "walking", null);
    await run("r5", 5, "ta", "ua", "completed", null);
    await run("r9", 9, "tb", "ub", "completed", "ok");

    await db.journey.create({ data: { id: "jw", runId: "r3", order: 0, title: "Block a country", status: "risky" } });
    await db.journey.create({ data: { id: "jc", runId: "r3", order: 1, title: "Visit the store", status: "ok", carriedFromRunId: "r2" } });
    let order = 0;
    const step = (journeyId: string, label: string, status: string, extra: Record<string, string> = {}) =>
      db.step.create({ data: { journeyId, order: order++, label, status, ...extra } });
    for (let i = 0; i < CAPABILITY; i++) await step("jw", `Open settings tab ${i % 4}`, "skipped", { unverifiedReason: "our_capability", gapClass: "new_tab" });
    for (let i = 0; i < ACCESS; i++) await step("jw", `Open the storefront ${i}`, "skipped", { unverifiedReason: "missing_access", observed: "The store asks for a store password." });
    for (let i = 0; i < CHECKED; i++) await step("jw", `Checked ${i}`, "ok");
    for (let i = 0; i < NO_REASON; i++) await step("jw", `Silent ${i}`, "skipped");
    order = 0;
    for (let i = 0; i < CARRIED; i++) await step("jc", `Sign in ${i}`, "skipped", { unverifiedReason: "missing_access", observed: "No test account was given." });
    const total = CAPABILITY + ACCESS + CHECKED + NO_REASON;
    check("the run is at real size", total + CARRIED > 100, String(total + CARRIED));

    // 1–2. One run.
    const walked = await causesOfRun(db, "r3", { walkedOnly: true });
    eq(
      "walked only: causes by size, most steps first",
      walked.groups.map((g) => [g.cause, g.steps]),
      [["our_capability:new_tab", CAPABILITY], ["missing_access:store_password", ACCESS]],
    );
    eq("labels: the first three distinct, in walk order", walked.groups[0].labels, ["Open settings tab 0", "Open settings tab 1", "Open settings tab 2"]);
    eq(
      "the share counts the walked steps; a step with no reason is our defect, not a cause",
      [walked.summary.total, walked.summary.unchecked, walked.summary.defects.length],
      [total, CAPABILITY + ACCESS + NO_REASON, NO_REASON],
    );
    const all = await causesOfRun(db, "r3", { walkedOnly: false });
    eq(
      "with carried journeys: their cause joins",
      all.groups.map((g) => [g.cause, g.steps]),
      [["our_capability:new_tab", CAPABILITY], ["missing_access:store_password", ACCESS], ["missing_access:test_account", CARRIED]],
    );
    eq("with carried journeys: every step counts", all.summary.total, total + CARRIED);
    eq("a run with no steps has no causes", (await causesOfRun(db, "r2", { walkedOnly: false })).groups, []);

    // 3. The app's latest.
    const latest = await causesOfAppsLatestRun(db, "ta", "a1");
    eq("the latest finished check with a verdict, of this team — not #4 walking, #5 without a verdict, #9 another team's", latest?.runNumber, 3);
    eq("…read with its carried journeys", latest?.groups.length, 3);
    eq("an app with no finished check has none", await causesOfAppsLatestRun(db, "ta", "nope"), null);
  } finally {
    await real.dispose();
  }
  if (failures) {
    console.error(`\n${failures} step-cause loader check(s) failed.`);
    process.exit(1);
  }
  console.log("\nStep-cause loaders hold on a real D1 at real size.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
