// CHE-451 verification: a Shopify app on several dev stores, on a real D1
// (Miniflare), as Securify's agent meets it — the Pricing v3 case: Easy Block
// is connected on prod-release-1 (with the old slug "admin.shopify.com"), and
// the agent needs it checked on vladislav-dog-photos.
//
//   1. the app is recognised from its admin address, old slug or new;
//   2. list_apps names the Shopify app, its store and its other stores;
//   3. add_store adds a store of a known app (admin key), says which scenarios
//      come with it, and refuses an unknown app or a member key with a sentence;
//   4. picking the app on the new store carries the team's scenarios (not the
//      discovered ones), once;
//   5. start_check by shopify_app + store starts the check on that store, and a
//      wrong store names the right ones;
//   6. add_scenario all_stores writes once per store; a store-only scenario stays
//      on its store;
//   7. the agent panel's key carries its minter's own scope.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-shopify-stores.ts

process.env.CREDENTIALS_SECRET ??= "verify-shopify-stores-secret";

import "./fixtures/wasm-module-loader.mjs";
import { realD1 } from "./fixtures/real-d1";
import { calls, source } from "./fixtures/ts-source";
import { shopifyAppOf, storesOf } from "../src/lib/shopify-stores";
import { chooseApp } from "../src/lib/shopify-connect";
import { createRemoteTools } from "../src/lib/mcp/tools";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

const HANDLE = "easy-block-customer-ip-country";
const PROD = `https://admin.shopify.com/store/prod-release-1/apps/${HANDLE}`;

async function main() {
  // 1.
  eq("an app connected before #288 (slug admin.shopify.com) is read from its address", shopifyAppOf({ appSlug: "admin.shopify.com", targetUrl: PROD }), { store: "prod-release-1", handle: HANDLE });
  eq("a new one too", shopifyAppOf({ appSlug: "shopify:8mrftg-tk/otp-plus-sso", targetUrl: "https://admin.shopify.com/store/8mrftg-tk/apps/otp-plus-sso" }), { store: "8mrftg-tk", handle: "otp-plus-sso" });
  eq("a website is not a Shopify app", shopifyAppOf({ appSlug: "securification.ai", targetUrl: "https://securification.ai/" }), null);

  const real = await realD1();
  const { db } = real;
  try {
    await db.user.create({ data: { id: "u", clerkUserId: "ck", email: "vladislav@securify.test" } });
    await db.team.create({ data: { id: "ts", name: "Securify", plan: "business", features: '["shopify"]' } });
    await db.app.create({ data: { id: "prod", teamId: "ts", ownerId: "u", appSlug: "admin.shopify.com", targetUrl: PROD, targetKind: "session", allowedOrigins: '["https://admin.shopify.com"]' } });
    await db.app.create({ data: { id: "site", teamId: "ts", ownerId: "u", appSlug: "securification.ai", targetUrl: "https://securification.ai/", targetKind: "website" } });
    await db.appJourney.create({ data: { appId: "prod", key: "block-country", title: "Block a country", description: "Add Germany; a German visitor sees the block page.", source: "team", daily: true, authorId: "u" } });
    await db.appJourney.create({ data: { appId: "prod", key: "protection-dashboard", title: "Protection Dashboard loads", source: "team", daily: false, authorId: "u" } });
    await db.appJourney.create({ data: { appId: "prod", key: "found-by-check", title: "Open the app", source: "discovered" } });

    const triggered: string[] = [];
    const deps = { db, origin: "https://checkmyapp.dev", trigger: async (id: string) => void triggered.push(id), siteCap: () => 1000, ephemeralTtlDays: () => 7, sleep: async () => {}, now: () => Date.now() };
    const as = (scope: "admin" | "member") =>
      createRemoteTools({ user: { id: "u", email: "vladislav@securify.test", name: null }, team: { id: "ts", name: "Securify", plan: "business", features: ["shopify"] }, scope, door: "mcp" } as never, deps as never);
    const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

    // 2.
    const listed = parse(await as("member").list_apps());
    const prod = listed.apps.find((a: { app_id: string }) => a.app_id === "prod");
    eq("list_apps: the Shopify app and its store", [prod.shopify_app, prod.store, prod.other_stores], [HANDLE, "prod-release-1", []]);
    check("list_apps: a website carries no Shopify fields", !("shopify_app" in listed.apps.find((a: { app_id: string }) => a.app_id === "site")));

    // 3.
    const memberAdd = parse(await as("member").add_store({ shopify_app: HANDLE, store: "vladislav-dog-photos" }));
    // What the refusal says beyond "forbidden" (the key's scope, what it can
    // still do) is #317's, checked in verify-mcp-remote.
    check("add_store: a member key is refused", memberAdd.code === "forbidden", JSON.stringify(memberAdd));
    const unknown = parse(await as("admin").add_store({ shopify_app: "not-connected", store: "x" }));
    check("add_store: an app the team never connected is not found, and says how to connect it", unknown.code === "not_found" && /connect_shopify_app/.test(unknown.error), unknown.error);
    const again = parse(await as("admin").add_store({ shopify_app: HANDLE, store: "prod-release-1" }));
    eq("add_store: a store it is already on is that app", [again.already_connected, again.app_id], [true, "prod"]);
    const added = parse(await as("admin").add_store({ shopify_app: HANDLE, store: "vladislav-dog-photos" }));
    check("add_store: the new store, with its sign-in page", added.ok === true && added.store === "vladislav-dog-photos" && /\/sign-in$/.test(added.sign_in_url), JSON.stringify(added));
    check("add_store: it says the app is on prod-release-1 and two team scenarios come with it",
      added.other_stores?.[0]?.store === "prod-release-1" && added.scenarios_coming === 2 && /prod-release-1/.test(added.same_app_note ?? ""), JSON.stringify(added));

    // 4.
    const picked = await chooseApp(db, { userId: "u", teamId: "ts", plan: "business" }, added.app_id, { slot: "main", store: "vladislav-dog-photos", handle: HANDLE, name: "Easy Block", origin: "https://easy-block.example" });
    eq("picking the app on the new store carries the team's two scenarios", picked.ok && picked.carried, 2);
    const titles = (await db.appJourney.findMany({ where: { appId: added.app_id }, select: { title: true, daily: true, source: true } })).map((s) => [s.title, s.daily, s.source]);
    eq("…as team scenarios, daily as they were, not the one the check found", titles.sort(), [["Block a country", true, "team"], ["Protection Dashboard loads", false, "team"]]);
    eq("both stores now listed together", (await storesOf(db, "ts", HANDLE)).map((s) => s.store), ["prod-release-1", "vladislav-dog-photos"]);

    // 5.
    const started = parse(await as("member").start_check({ shopify_app: HANDLE, store: "vladislav-dog-photos", deploy_sha: "pricingv3" }));
    const run = started.run_id ? await db.run.findFirst({ where: { publicId: started.run_id }, select: { appId: true } }) : null;
    eq("start_check: shopify_app + store starts the check on that store", run?.appId, added.app_id);
    const wrong = parse(await as("member").start_check({ shopify_app: HANDLE, store: "staging" }));
    check("start_check: a store the app is not on names the ones it is on, and the call that adds it", wrong.code === "not_found" && /prod-release-1, vladislav-dog-photos/.test(wrong.error) && /add_store/.test(wrong.error), wrong.error);
    eq("start_check: app_id and shopify_app together are refused", parse(await as("member").start_check({ app_id: "prod", shopify_app: HANDLE, store: "prod-release-1" })).code, "invalid_input");

    // 6.
    const onlyHere = parse(await as("member").add_scenario({ app_id: added.app_id, title: "Pricing v3 plans are shown", daily: false }));
    eq("add_scenario: a scenario for one store stays on it", [onlyHere.ok, onlyHere.also_on ?? null, await db.appJourney.count({ where: { title: "Pricing v3 plans are shown" } })], [true, null, 1]);
    const everywhere = parse(await as("member").add_scenario({ app_id: "prod", title: "Block an IP", all_stores: true }));
    eq("add_scenario all_stores: written on every store of the app, once", [everywhere.also_on?.map((s: { store: string }) => s.store), await db.appJourney.count({ where: { title: "Block an IP" } })], [["vladislav-dog-photos"], 2]);
  } finally {
    await real.dispose();
  }

  // 7.
  check(
    "the agent panel's key carries its minter's scope",
    calls(source("src/components/connect-agent.tsx")).some((c) => c.callee === "createApiKey" && c.args[1] === '"self"') &&
      /keyScope === "self" \? scope/.test(source("src/app/dashboard/actions.ts").getText()),
  );

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
