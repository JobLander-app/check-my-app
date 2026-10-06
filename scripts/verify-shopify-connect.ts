// CHE-333: a Shopify app is connected by its store, then chosen after the
// person signs in (src/lib/shopify-connect.ts). On a real D1:
//
//   - a team the session host does not serve yet is refused, by name;
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
import { NOT_OPEN_YET, chooseApp, connectStore } from "@/lib/shopify-connect";
import type { Pick } from "@/lib/session-view";
import { hasEnvironmentLeak, hasHomework } from "@/lib/verdict-language";
import { startSavedApp } from "@/lib/start-saved-app";
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
    await db.team.createMany({ data: [{ id: "team_a", name: "A", plan: "business" }, { id: "team_z", name: "Z", plan: "business" }] });
    await db.membership.createMany({ data: [
      { teamId: "team_a", userId: "ann", scope: "admin" },
      { teamId: "team_z", userId: "zed", scope: "admin" },
    ] as never });
    const ann = { userId: "ann", teamId: "team_a", plan: "business" as const };
    const zed = { userId: "zed", teamId: "team_z", plan: "business" as const };
    const env = { SESSION_TEAMS: "team_a" };
    const pick = (over: Partial<Pick> = {}): Pick => ({ slot: "main", store: "prod-release-1", handle: "securify", name: "Securify", origin: "https://securify.example.app", ...over });

    const closed = await connectStore(db, zed, env, "zed-store");
    check("a team the session host does not serve is told so", "error" in closed && closed.error === NOT_OPEN_YET, JSON.stringify(closed));
    const bad = await connectStore(db, ann, env, "joblander.app");
    check("an address that is not a store is refused", "error" in bad && bad.code === "invalid_input", JSON.stringify(bad));

    const first = await connectStore(db, ann, env, "Prod-Release-1.myshopify.com");
    const appId = "ok" in first ? first.appId : "";
    const pending = await db.app.findUnique({ where: { id: appId }, select: { targetKind: true, appSlug: true, targetUrl: true, allowedOrigins: true, watch: { select: { active: true } } } });
    check("the store becomes a pending app checked inside the session", pending?.targetKind === "session" && pending.appSlug === "shopify:prod-release-1" && pending.targetUrl === "https://admin.shopify.com/store/prod-release-1", JSON.stringify(pending));
    check("…with the admin allowed and no daily check until the app is chosen", pending?.allowedOrigins === JSON.stringify(["https://admin.shopify.com"]) && pending?.watch === null, JSON.stringify(pending));
    // Codex on #288: nothing may check a store whose app is not chosen.
    let triggered = 0;
    const startDeps = { trigger: async () => { triggered++; }, siteCap: () => 1000, source: "mcp" as const };
    const early = await startSavedApp(db, { id: "ann", teamId: "team_a", plan: "business" }, appId, startDeps);
    check("a check of a store whose app is not chosen is refused, and nothing starts", "error" in early && early.error === PENDING_SHOPIFY_APP && triggered === 0, JSON.stringify(early));
    const again = await connectStore(db, ann, env, "prod-release-1");
    check("the same store asked again is the same pending app", "ok" in again && again.appId === appId && again.reused, JSON.stringify(again));

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

    const second = await connectStore(db, ann, env, "prod-release-1");
    const secondId = "ok" in second ? second.appId : "";
    check("connecting the store again starts a second app", "ok" in second && secondId !== appId && !second.reused, JSON.stringify(second));
    const dupe = await chooseApp(db, ann, secondId, pick());
    check("the same app chosen twice is a duplicate that names the first", "error" in dupe && dupe.code === "duplicate" && dupe.appId === appId, JSON.stringify(dupe));
    const flow = await chooseApp(db, ann, secondId, pick({ handle: "flow", name: "Flow", origin: "https://flow.example.app" }));
    check("another app of the same store is its own app", "ok" in flow && flow.appSlug === "shopify:prod-release-1/flow", JSON.stringify(flow));

    // Every refusal above is a sentence a person reads on the connect page or
    // the sign-in page (rule 1: about their store, never our machinery or
    // homework).
    const refusals = [closed, bad, otherStore, ours, foreign, dupe].map((r) => ("error" in r ? r.error : "")).filter(Boolean);
    check("every refusal reads as being about the person's store", refusals.length === 6 && refusals.every((s) => !hasEnvironmentLeak(s) && !hasHomework(s) && !/\b(browser|session host|VNC)\b/i.test(s)), refusals.join(" | "));

    // Codex on #288: a Free team with two stores waiting gets one daily check,
    // not two — the watch cap is asked when the app is chosen.
    await db.team.create({ data: { id: "team_f", name: "F", plan: "free" } });
    await db.user.create({ data: { id: "fay", clerkUserId: "ck_fay", email: "fay@team-f.test" } });
    await db.membership.create({ data: { teamId: "team_f", userId: "fay", scope: "admin" } as never });
    const fay = { userId: "fay", teamId: "team_f", plan: "free" as const };
    const envF = { SESSION_TEAMS: "team_a,team_f" };
    const s1 = await connectStore(db, fay, envF, "store-one");
    const s2 = await connectStore(db, fay, envF, "store-two");
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
