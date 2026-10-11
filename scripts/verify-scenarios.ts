// CHE-435 / CHE-434 B verification: a team edits its app's scenarios, on the
// page and through MCP, on a real D1 (Miniflare).
//
//   1. every scenario is the team's own — another team's id is not_found; a
//      reader and a team without `shopify` are refused;
//   2. a team scenario is added, edited and removed (retired, kept); a scenario
//      the check found keeps its title, is not removed, and is replaced;
//   3. a daily team scenario is in the focus of every check of the app — one
//      started from the page or MCP, a scheduled one, a re-check — and a
//      once-scenario only in the check that names it;
//   4. MCP: list / add / update / remove by id, run_now, start_check scenarios.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-scenarios.ts

process.env.CREDENTIALS_SECRET ??= "verify-scenarios-secret";

import "./fixtures/wasm-module-loader.mjs";
import { realD1 } from "./fixtures/real-d1";
import { addScenario, focusForRun, listScenarios, mergeFocus, removeScenario, replaceScenario, updateScenario, type ScenarioActor } from "../src/lib/scenarios";
import { startSavedApp } from "../src/lib/start-saved-app";
import { createRecheckRun } from "../src/lib/recheck";
import { createWatchRun } from "../src/agent/scheduler";
import { createRemoteTools } from "../src/lib/mcp/tools";
import type { AgentEnv } from "../src/agent/env";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
const code = (r: { ok: boolean } & Partial<{ code: string }>) => (r.ok ? "ok" : r.code);

async function main() {
  const real = await realD1();
  const { db } = real;
  try {
    await db.user.create({ data: { id: "ua", clerkUserId: "ck_a", email: "member@securify.test" } });
    await db.user.create({ data: { id: "ub", clerkUserId: "ck_b", email: "other@else.test" } });
    await db.team.create({ data: { id: "ta", name: "Securify", plan: "business", features: '["shopify"]' } });
    await db.team.create({ data: { id: "tb", name: "Else", plan: "business", features: '["shopify"]' } });
    await db.membership.create({ data: { teamId: "ta", userId: "ua", scope: "member" } });
    await db.app.create({ data: { id: "a1", teamId: "ta", ownerId: "ua", appSlug: "shop.securify.test", targetUrl: "https://shop.securify.test", targetKind: "website", focusAreas: "Checkout must never break." } });
    await db.app.create({ data: { id: "b1", teamId: "tb", ownerId: "ub", appSlug: "else.test", targetUrl: "https://else.test", targetKind: "website" } });
    await db.appJourney.create({ data: { id: "found1", appId: "a1", key: "sign-in", title: "Sign in" } });

    const member: ScenarioActor = { userId: "ua", teamId: "ta", scope: "member", features: ["shopify"] };
    const reader: ScenarioActor = { ...member, scope: "reader" };
    const unflagged: ScenarioActor = { ...member, features: [] };
    const stranger: ScenarioActor = { userId: "ub", teamId: "tb", scope: "admin", features: ["shopify"] };

    // 1–2. Edits.
    const daily = await addScenario(db, member, { appId: "a1", title: "Block a country", description: "Add Germany; a German visitor sees the block page", daily: true });
    const once = await addScenario(db, member, { appId: "a1", title: "Refund a blocked order", daily: false });
    eq("a member adds a daily and a once scenario", [code(daily), code(once)], ["ok", "ok"]);
    const dailyId = (daily as { id: string }).id;
    const onceId = (once as { id: string }).id;
    eq("a reader is refused", code(await addScenario(db, reader, { appId: "a1", title: "x x x" })), "forbidden");
    eq("a team without the shopify feature is refused", code(await addScenario(db, unflagged, { appId: "a1", title: "x x x" })), "forbidden");
    eq("another team's app is not found", code(await addScenario(db, stranger, { appId: "a1", title: "x x x" })), "not_found");
    eq("another team's scenario is not found", code(await updateScenario(db, stranger, dailyId, { daily: false })), "not_found");
    eq("a title too short to recognise is refused", code(await addScenario(db, member, { appId: "a1", title: "x" })), "invalid_input");
    const row = await db.appJourney.findUnique({ where: { id: dailyId } });
    eq("a team scenario is the team's, by its author", [row?.source, row?.authorId, row?.daily, row?.key], ["team", "ua", true, row?.key]);

    eq("a team scenario's title is edited", code(await updateScenario(db, member, dailyId, { title: "Block Germany" })), "ok");
    eq("a found scenario keeps its title", code(await updateScenario(db, member, "found1", { title: "Log in" })), "invalid_input");
    eq("…but its description and daily are the team's to set", code(await updateScenario(db, member, "found1", { description: "Use the test account", daily: false })), "ok");
    eq("a found scenario is not removed — it would come back", code(await removeScenario(db, member, "found1")), "invalid_input");

    const replaced = await replaceScenario(db, member, "found1", { title: "Sign in with Shopify", description: "From the admin, not the storefront" });
    const found = await db.appJourney.findUnique({ where: { id: "found1" } });
    check("'it is really a different scenario' adds the team's and retires the found one, naming it",
      replaced.ok && found?.retiredAt !== null && /Sign in with Shopify/.test(found?.retiredReason ?? ""), found?.retiredReason ?? "");

    const listed = (await listScenarios(db, "ta", "a1")) ?? [];
    eq("the list: live scenarios, team first, the replaced one gone", listed.map((s) => s.title), ["Block Germany", "Refund a blocked order", "Sign in with Shopify"]);
    eq("another team cannot list them", await listScenarios(db, "tb", "a1"), null);

    // 3. Focus.
    const focus = (await focusForRun(db, "a1")) ?? "";
    check("a daily scenario is in every check's focus, with its words", focus.includes("Block Germany — Add Germany") && focus.includes("Sign in with Shopify"), focus);
    check("…a once-scenario is not", !focus.includes("Refund a blocked order"));
    check("…unless the check names it", ((await focusForRun(db, "a1", [onceId])) ?? "").includes("Refund a blocked order"));
    eq("the run's focus keeps the app's own words first", mergeFocus("Checkout must never break.", "1. A")?.split("\n")[0], "Checkout must never break.");

    const started = await startSavedApp(db, { id: "ua", teamId: "ta", plan: "business" }, "a1", { trigger: async () => {}, siteCap: () => 1000 }, { scenarios: [onceId] });
    const pageRun = "error" in started ? null : await db.run.findFirst({ where: { publicId: started.publicId } });
    check("a check from the page carries the app's words, the daily scenarios and the one it names",
      Boolean(pageRun?.focusAreas?.includes("Checkout must never break.") && pageRun.focusAreas.includes("Block Germany") && pageRun.focusAreas.includes("Refund a blocked order")),
      "error" in started ? started.error : pageRun?.focusAreas ?? "");
    await db.run.update({ where: { id: pageRun!.id }, data: { status: "completed" } });

    const env = { db, bindings: {} } as unknown as AgentEnv;
    await db.watch.create({ data: { id: "w1", appSlug: "shop.securify.test", targetUrl: "https://shop.securify.test", appId: "a1", ownerId: "ua", teamId: "ta" } });
    const scheduled = await createWatchRun(env, {
      id: "w1", targetUrl: "https://shop.securify.test", appSlug: "shop.securify.test", testEmail: null, testPasswordEnc: null, storePasswordEnc: null,
      appId: "a1", ownerId: "ua", teamId: "ta",
      app: { scopeHints: null, userNotes: null, focusAreas: "Checkout must never break.", allowedOrigins: null, targetKind: "website", extensionId: null, extensionConfig: null },
    } as never, null);
    const watchRun = await db.run.findUnique({ where: { id: scheduled.id } });
    check("a scheduled check carries every daily scenario and not the once one",
      Boolean(watchRun?.focusAreas?.includes("Block Germany") && !watchRun.focusAreas.includes("Refund a blocked order")), watchRun?.focusAreas ?? "");

    // A re-check of the page's check takes the focus as it is now: a daily
    // scenario added after that check is in it.
    await addScenario(db, member, { appId: "a1", title: "Added after the check", daily: true });
    const again = await createRecheckRun(db, pageRun!.publicId, { full: true }, {
      canMutate: async () => true, trigger: async () => {}, siteCap: () => 1000, now: () => new Date(), ephemeralTtlDays: () => 7,
    } as never);
    const recheckRun = again.kind === "ok" ? await db.run.findFirst({ where: { publicId: again.publicId } }) : null;
    check("a re-check carries the app's focus as it is now, a scenario added since included",
      Boolean(recheckRun?.focusAreas?.includes("Added after the check") && recheckRun.focusAreas.includes("Checkout must never break.")),
      `${again.kind} ${recheckRun?.focusAreas ?? ""}`);
    if (recheckRun) await db.run.update({ where: { id: recheckRun.id }, data: { status: "completed" } });

    await removeScenario(db, member, dailyId);
    check("a removed scenario leaves every later focus", !((await focusForRun(db, "a1")) ?? "").includes("Block Germany"));
    eq("…and stays as history", (await db.appJourney.findUnique({ where: { id: dailyId } }))?.retiredReason, "removed by the team");

    // 4. MCP.
    const deps = { db, origin: "https://checkmyapp.dev", trigger: async () => {}, siteCap: () => 1000, ephemeralTtlDays: () => 7, sleep: async () => {}, now: () => Date.now() };
    const as = (scope: "member" | "reader", teamId = "ta") =>
      createRemoteTools({ user: { id: "ua", email: "x@x.test", name: null }, team: { id: teamId, name: "T", plan: "business", features: ["shopify"] }, scope, door: "mcp" } as never, deps as never);
    const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);
    const added = parse(await as("member").add_scenario({ app_id: "a1", title: "Unblock an IP", daily: false }));
    eq("add_scenario: a member's key adds one", [added.ok, added.daily], [true, false]);
    eq("…a reader's key is refused", parse(await as("reader").add_scenario({ app_id: "a1", title: "Something new" })).code, "forbidden");
    eq("…another team's key does not find the app", parse(await as("member", "tb").add_scenario({ app_id: "a1", title: "Something new" })).code, "not_found");
    const list = parse(await as("reader").list_scenarios({ app_id: "a1" }));
    check("list_scenarios: a reader sees them, by id, with who wrote each", list.ok && list.scenarios.some((s: { scenario_id: string; written_by: string }) => s.scenario_id === added.scenario_id && s.written_by === "team"));
    eq("update_scenario: by id", parse(await as("member").update_scenario({ scenario_id: added.scenario_id, daily: true })).ok, true);
    eq("remove_scenario: by id", parse(await as("member").remove_scenario({ scenario_id: added.scenario_id })).removed, true);
    eq("start_check: a scenario of another app is refused", parse(await as("member").start_check({ app_id: "a1", scenarios: ["found1x"] })).code, "not_found");
    // The scheduled check above is still queued: run_now must not claim it covers the new one.
    const busy = parse(await as("member").add_scenario({ app_id: "a1", title: "Added while one runs", daily: false, run_now: true }));
    check("add_scenario run_now while a check runs: says that check does not cover it, and how to run it",
      busy.ok && busy.check?.already_running === true && busy.check?.covers_this_scenario === false && String(busy.hint).includes(busy.scenario_id),
      JSON.stringify(busy.check));
    await db.run.update({ where: { id: scheduled.id }, data: { status: "completed" } });
    const now = parse(await as("member").add_scenario({ app_id: "a1", title: "Check it right now", daily: false, run_now: true }));
    const nowRun = now.check?.run_id ? await db.run.findFirst({ where: { publicId: now.check.run_id } }) : null;
    check("add_scenario run_now: one check starts and covers it",
      Boolean(now.check?.started && now.check?.covers_this_scenario && nowRun?.focusAreas?.includes("Check it right now")), JSON.stringify(now.check));
  } finally {
    await real.dispose();
  }
  console.log(failures ? `\n${failures} FAILED` : "\nall pass");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
