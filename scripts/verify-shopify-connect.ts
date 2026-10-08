// CHE-333: a Shopify app is connected by its store, then chosen after the
// person signs in (src/lib/shopify-connect.ts). On a real D1:
//
//   - a team not given the "shopify" feature (CHE-433) is refused, by name;
//   - a store becomes ONE pending app (kind session, slug shopify:<store>, the
//     admin allowed, its daily check off) — asked twice, still one;
//   - the picked app is saved from what the host signed: its address in the
//     admin, slug shopify:<store>/<handle>, the admin and its own origin
//     allowed, the daily check on; a pick for another store, an origin we may
//     not open, or another team's app are refused;
//   - a second app of the same store is a second app, and the same app twice
//     is a duplicate that names the first;
//   - an ordinary website is still keyed on its host.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-shopify-connect.ts

process.env.CREDENTIALS_SECRET ??= "verify-shopify-connect-secret";

import "./fixtures/wasm-module-loader.mjs";
import { realD1 } from "./fixtures/real-d1";
import { createAppForTeam } from "@/lib/app-settings";
import { BAD_LINK, NOT_OPEN_YET, chooseApp, connectApp } from "@/lib/shopify-connect";
import type { Pick } from "@/lib/session-view";
import { hasEnvironmentLeak, hasHomework } from "@/lib/verdict-language";
import { startSavedApp } from "@/lib/start-saved-app";
import { enableWatchForApp } from "@/lib/watch-enable";
import { PENDING_SHOPIFY_APP } from "@/lib/session-view";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

async function main() {
  const real = await realD1();
  try {
    const db = real.db;
    await db.user.createMany({ data: [
      { id: "ann", clerkUserId: "ck_ann", email: "ann@team-a.test" },
      { id: "zed", clerkUserId: "ck_zed", email: "zed@team-z.test" },
    ] });
    // CHE-433: team A has been given the "shopify" feature; team Z has not.
    await db.team.createMany({ data: [{ id: "team_a", name: "A", plan: "business", features: '["shopify"]' }, { id: "team_z", name: "Z", plan: "business" }] });
    await db.membership.createMany({ data: [
      { teamId: "team_a", userId: "ann", scope: "admin" },
      { teamId: "team_z", userId: "zed", scope: "admin" },
    ] as never });
    const ann = { userId: "ann", teamId: "team_a", plan: "business" as const };
    const zed = { userId: "zed", teamId: "team_z", plan: "business" as const };
    const pick = (over: Partial<Pick> = {}): Pick => ({ slot: "main", store: "prod-release-1", handle: "securify", name: "Securify", origin: "https://securify.example.app", ...over });

    const APP = (store: string, handle: string) => `https://admin.shopify.com/store/${store}/apps/${handle}`;
    const closed = await connectApp(db, zed,APP("zed-store", "zapp"));
    check("a team not given the shopify feature is told so", "error" in closed && closed.error === NOT_OPEN_YET, JSON.stringify(closed));
    const bad = await connectApp(db, ann,"joblander.app");
    check("an address that is not a link to an app in a store's admin is refused", "error" in bad && bad.error === BAD_LINK, JSON.stringify(bad));
    const storeOnly = await connectApp(db, ann,"https://admin.shopify.com/store/prod-release-1");
    check("a store's admin with no app in the link is refused, naming the link it wants", "error" in storeOnly && storeOnly.error === BAD_LINK, JSON.stringify(storeOnly));

    // As copied from the address bar: deeper in the app, with a query.
    const first = await connectApp(db, ann,`${APP("Prod-Release-1", "securify")}/settings?embedded=1`);
    const appId = "ok" in first ? first.appId : "";
    const pending = await db.app.findUnique({ where: { id: appId }, select: { targetKind: true, appSlug: true, targetUrl: true, allowedOrigins: true, watch: { select: { active: true } } } });
    check("the link becomes a pending app — store and app both read from it", "ok" in first && first.store === "prod-release-1" && first.handle === "securify" && pending?.targetKind === "session" && pending.appSlug === "shopify:prod-release-1" && pending.targetUrl === APP("prod-release-1", "securify"), JSON.stringify({ first, pending }));
    check("…with the admin allowed and no daily check until the app is chosen", pending?.allowedOrigins === JSON.stringify(["https://admin.shopify.com"]) && pending?.watch === null, JSON.stringify(pending));
    // Codex on #288: nothing may check a store whose app is not chosen.
    let triggered = 0;
    const startDeps = { trigger: async () => { triggered++; }, siteCap: () => 1000, source: "mcp" as const };
    const early = await startSavedApp(db, { id: "ann", teamId: "team_a", plan: "business" }, appId, startDeps);
    check("a check of a store whose app is not chosen is refused, and nothing starts", "error" in early && early.error === PENDING_SHOPIFY_APP && triggered === 0, JSON.stringify(early));
    // Codex on #288: nor may a daily check be switched on for it (MCP enable_watch).
    const earlyWatch = await enableWatchForApp(db, { id: "ann", teamId: "team_a", plan: "business" }, appId, { frequency: "daily" });
    const watches = await db.watch.count({ where: { appId } });
    check("a daily check for a store whose app is not chosen is refused, and no watch appears", earlyWatch.kind === "gated" && earlyWatch.reason === PENDING_SHOPIFY_APP && watches === 0, JSON.stringify({ earlyWatch, watches }));
    const again = await connectApp(db, ann,"prod-release-1.myshopify.com/admin/apps/securify");
    check("the same app by the older link form is the same pending app", "ok" in again && again.appId === appId && again.reused && !again.connected, JSON.stringify(again));

    const notLinked = await chooseApp(db, ann, appId, pick({ handle: "flow", name: "Flow", origin: "https://flow.example.app" }));
    check("a pick of another app than the one linked is refused", "error" in notLinked && notLinked.code === "invalid_input", JSON.stringify(notLinked));
    const otherStore = await chooseApp(db, ann, appId, pick({ store: "someone-else" }));
    check("a pick from another store is refused", "error" in otherStore && otherStore.code === "invalid_input", JSON.stringify(otherStore));
    const ours = await chooseApp(db, ann, appId, pick({ origin: "https://checkmyapp.dev" }));
    check("an app served from an origin we may not open is refused", "error" in ours && ours.code === "invalid_input", JSON.stringify(ours));
    const foreign = await chooseApp(db, zed, appId, pick());
    check("another team cannot choose for this team's app", "error" in foreign && foreign.code === "not_found", JSON.stringify(foreign));

    const chosen = await chooseApp(db, ann, appId, pick());
    const saved = await db.app.findUnique({ where: { id: appId }, select: { appSlug: true, targetUrl: true, allowedOrigins: true, watch: { select: { active: true, targetUrl: true, appSlug: true } } } });
    check("the chosen app is saved with its address in the admin and its own origin", "ok" in chosen && saved?.appSlug === "shopify:prod-release-1/securify" && saved.targetUrl === "https://admin.shopify.com/store/prod-release-1/apps/securify" && saved.allowedOrigins === JSON.stringify(["https://admin.shopify.com", "https://securify.example.app"]), JSON.stringify({ chosen, saved }));
    check("…and its daily check is on, at the same address", saved?.watch?.active === true && saved.watch.targetUrl === saved.targetUrl && saved.watch.appSlug === saved.appSlug, JSON.stringify(saved?.watch));

    const repoint = await chooseApp(db, ann, appId, pick({ handle: "flow", name: "Flow", origin: "https://flow.example.app" }));
    check("a connected app is not repointed at another app by a stale page", "error" in repoint && repoint.code === "invalid_input", JSON.stringify(repoint));
    const started = await startSavedApp(db, { id: "ann", teamId: "team_a", plan: "business" }, appId, startDeps);
    check("once chosen, the app's check starts", "publicId" in started && triggered === 1, JSON.stringify(started));

    const dupe = await connectApp(db, ann,APP("prod-release-1", "securify"));
    check("linking an app already connected leads to it, and makes no second row", "ok" in dupe && dupe.connected && dupe.appId === appId && (await db.app.count({ where: { teamId: "team_a", appSlug: { startsWith: "shopify:" } } })) === 1, JSON.stringify(dupe));
    const second = await connectApp(db, ann,APP("prod-release-1", "flow"));
    const secondId = "ok" in second ? second.appId : "";
    check("another app of the same store is a second app", "ok" in second && secondId !== appId && !second.reused, JSON.stringify(second));
    const flow = await chooseApp(db, ann, secondId, pick({ handle: "flow", name: "Flow", origin: "https://flow.example.app" }));
    check("…saved under its own name", "ok" in flow && flow.appSlug === "shopify:prod-release-1/flow", JSON.stringify(flow));

    // Every refusal above is a sentence a person reads on the connect page or
    // the sign-in page (rule 1: about their store, never our machinery or
    // homework).
    const refusals = [closed, bad, storeOnly, notLinked, otherStore, ours, foreign].map((r) => ("error" in r ? r.error : "")).filter(Boolean);
    check("every refusal reads as being about the person's store", refusals.length === 7 && refusals.every((s) => !hasEnvironmentLeak(s) && !hasHomework(s) && !/\b(browser|session host|VNC)\b/i.test(s)), refusals.join(" | "));

    // Codex on #288: a Free team with two stores waiting gets one daily check,
    // not two — the watch cap is asked when the app is chosen.
    await db.team.create({ data: { id: "team_f", name: "F", plan: "free", features: '["shopify"]' } });
    await db.user.create({ data: { id: "fay", clerkUserId: "ck_fay", email: "fay@team-f.test" } });
    await db.membership.create({ data: { teamId: "team_f", userId: "fay", scope: "admin" } as never });
    const fay = { userId: "fay", teamId: "team_f", plan: "free" as const };
    const s1 = await connectApp(db, fay,APP("store-one", "securify"));
    const s2 = await connectApp(db, fay,APP("store-two", "securify"));
    const c1 = "ok" in s1 ? await chooseApp(db, fay, s1.appId, pick({ store: "store-one" })) : s1;
    const c2 = "ok" in s2 ? await chooseApp(db, fay, s2.appId, pick({ store: "store-two" })) : s2;
    const activeF = await db.watch.count({ where: { teamId: "team_f", active: true } });
    check("a Free team choosing two waiting stores gets one daily check, and is told why not the second",
      "ok" in c1 && !c1.watchRefused && "ok" in c2 && Boolean(c2.watchRefused) && activeF === 1, JSON.stringify({ c1, c2, activeF }));
    const trial = await db.watch.findFirst({ where: { teamId: "team_f", active: true }, select: { trialEndsAt: true } });
    check("…and the Free trial runs from the moment the app was chosen", Boolean(trial?.trialEndsAt) && new Date(trial!.trialEndsAt!).getTime() > Date.now() + 6 * 24 * 3600_000, JSON.stringify(trial));

    const site = await createAppForTeam(db, ann, { targetUrl: "https://shop.example/path" });
    const siteRow = "ok" in site ? await db.app.findUnique({ where: { id: site.app.id }, select: { appSlug: true, targetKind: true } }) : null;
    check("an ordinary website is still keyed on its host", siteRow?.appSlug === "shop.example" && siteRow.targetKind !== "session", JSON.stringify(siteRow));
  } finally {
    await real.close?.();
  }
  console.log(failures ? `\nverify-shopify-connect: ${failures} FAILED` : "\nverify-shopify-connect: all passed");
  process.exit(failures ? 1 : 0);
}

void main();
