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
import { readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { realD1 } from "./fixtures/real-d1";
import { calls, source } from "./fixtures/ts-source";
import { shopifyAppOf, storesOf } from "../src/lib/shopify-stores";
import { isPendingShopifyApp } from "../src/lib/session-view";
import { keyScopeFor } from "../src/lib/scopes";
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

    // A store waiting for its app to be picked is not yet a store of the app.
    eq("a store still waiting for its pick is not listed as one of the app's stores", (await storesOf(db, "ts", HANDLE)).map((s) => s.store), ["prod-release-1"]);
    const listedPending = parse(await as("member").list_apps());
    eq("…nor among the app's other stores in list_apps", listedPending.apps.find((a: { app_id: string }) => a.app_id === "prod").other_stores, []);

    // 4.
    const pick = { slot: "main", store: "vladislav-dog-photos", handle: HANDLE, name: "Easy Block", origin: "https://easy-block.example" };
    const actor = { userId: "u", teamId: "ts", plan: "business" as const };
    // The copy fails half-way (the second scenario's write throws)…
    let writes = 0;
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== "appJourney") return typeof value === "function" ? value.bind(target) : value;
        return new Proxy(value as object, {
          get(delegate, method) {
            const fn = Reflect.get(delegate, method);
            if (method === "create") {
              return (...a: unknown[]) => (++writes === 2 ? Promise.reject(new Error("D1 went away")) : (fn as (...x: unknown[]) => unknown).apply(delegate, a));
            }
            return typeof fn === "function" ? fn.bind(delegate) : fn;
          },
        });
      },
    });
    const broken = await chooseApp(flaky as typeof db, actor, added.app_id, pick).then(() => "returned", (e: Error) => e.message);
    const half = await db.app.findUnique({ where: { id: added.app_id }, select: { appSlug: true, targetKind: true } });
    eq("a copy that fails half-way leaves the store waiting for its pick, so it can be picked again", [broken, isPendingShopifyApp(half!)], ["D1 went away", true]);
    // …and picking again finishes it, without a second copy of the first.
    const picked = await chooseApp(db, actor, added.app_id, pick);
    eq("picking again carries what is still missing", picked.ok && picked.carried, 1);
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
    const andRun = parse(await as("member").add_scenario({ app_id: "prod", title: "Unblock an IP", all_stores: true, run_now: true }));
    eq("…and with run_now, the answer still says where the copies went", [andRun.also_on?.map((s: { store: string }) => s.store), "check" in andRun], [["vladislav-dog-photos"], true]);
  } finally {
    await real.dispose();
  }

  // 7. The key's scope: the rule, where it is applied, and every place a key is made.
  eq("a key for 'self' is its minter's scope", (["admin", "member", "reader"] as const).map((m) => keyScopeFor(m, "self")), ["admin", "member", "reader"]);
  eq("a named scope is taken as named; anything else is a member key", [keyScopeFor("admin", "reader"), keyScopeFor("admin", "admin"), keyScopeFor("admin", "owner"), keyScopeFor("admin", "")], ["reader", "admin", "member", "member"]);
  const actionsSf = source("src/app/dashboard/actions.ts");
  const inCreate = calls(actionsSf).filter((c) => enclosingFunction(c.node) === "createApiKey");
  check("createApiKey decides the scope by that rule, from its minter and what was asked", inCreate.some((c) => c.callee === "keyScopeFor" && c.args.join(",") === "scope,keyScope"));
  const sites = callSites("src", "createApiKey").filter((s) => s.file !== "src/app/dashboard/actions.ts");
  eq(
    "every place that makes a key, and the scope it asks for: the agent panel its minter's own, the API keys block a member key",
    sites.map((s) => [s.file, s.args[1] ?? "(default member)"]).sort(),
    [["src/components/api-keys.tsx", "(default member)"], ["src/components/connect-agent.tsx", '"self"']],
  );

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

// The name of the function declaration a node sits in.
function enclosingFunction(node: ts.Node): string | null {
  for (let n: ts.Node | undefined = node; n; n = n.parent) if (ts.isFunctionDeclaration(n)) return n.name?.text ?? null;
  return null;
}
// Every call of `callee` in the .ts/.tsx files under `dir`, as parsed syntax.
function callSites(dir: string, callee: string): { file: string; args: string[] }[] {
  const out: { file: string; args: string[] }[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "generated") walk(p);
      } else if (/\.tsx?$/.test(e.name)) {
        for (const c of calls(source(p))) if (c.callee === callee) out.push({ file: p, args: c.args });
      }
    }
  };
  walk(dir);
  return out;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
