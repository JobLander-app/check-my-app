// CHE-457 verification: an app has a name of its own, and a Shopify app is
// marked as one wherever it is shown.
//
//   1. the rules: a name is trimmed, collapsed, at most 60 characters, "" clears
//      it; the label is the name, else an extension's name, else the address;
//      a Shopify app is an app checked inside the Shopify admin;
//   2. on a real D1 (Miniflare): the settings write sets, clears and refuses a
//      name without touching the address; the sidebar's data names the app by
//      it and marks the Shopify app; MCP update_app / list_apps carry it;
//   3. every place that names an app goes through the one rule (read as
//      syntax): no page or component works the label out by itself, and the
//      lists that show an app put the mark beside it;
//   4. the verdict mail names the app as the team calls it.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-app-name.ts

process.env.CREDENTIALS_SECRET ??= "verify-app-name-secret";

import "./fixtures/wasm-module-loader.mjs";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { realD1 } from "./fixtures/real-d1";
import { calls, jsx, source } from "./fixtures/ts-source";
import { APP_NAME_MAX, appLabel, checkAppName, isShopifyApp } from "../src/lib/app-label";
import { updateAppForTeam } from "../src/lib/app-settings";
import { loadShellData } from "../src/lib/shell-data";
import { createRemoteTools } from "../src/lib/mcp/tools";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

const EASY_BLOCK = "https://admin.shopify.com/store/prod-release-1/apps/easy-block-customer-ip-country";

async function main() {
  // 1. The rules.
  eq("a name is trimmed and its inner spaces collapsed", checkAppName("  OTP+ \n app "), { ok: true, name: "OTP+ app" });
  eq("a blank name clears it", checkAppName("   "), { ok: true, name: null });
  eq(`${APP_NAME_MAX} characters is fine, one more is refused`, [checkAppName("x".repeat(APP_NAME_MAX)).ok, checkAppName("x".repeat(APP_NAME_MAX + 1)).ok], [true, false]);
  eq("the label is the name when there is one", appLabel({ name: "Securify", appSlug: "admin.shopify.com", targetKind: "session", targetUrl: EASY_BLOCK }), "Securify");
  eq("…the address when there is none, or only blanks", [null, "  "].map((n) => appLabel({ name: n, appSlug: "admin.shopify.com", targetKind: "session", targetUrl: EASY_BLOCK })), ["admin.shopify.com", "admin.shopify.com"]);
  eq("…an extension's own name when it has none", appLabel({ name: null, appSlug: "extension:abc", targetKind: "extension", targetUrl: "https://chromewebstore.google.com/detail/my-tool/abcdefghijklmnopabcdefghijklmnop" }), "my tool");
  eq("a Shopify app is one checked inside the Shopify admin; a website and an extension are not", ["session", "website", "extension"].map((k) => isShopifyApp({ targetKind: k })), [true, false, false]);

  // 2. The rows.
  const real = await realD1();
  const { db } = real;
  try {
    await db.user.create({ data: { id: "u", clerkUserId: "ck", email: "vladislav@securify.test" } });
    await db.team.create({ data: { id: "ts", name: "Securify", plan: "business", features: '["shopify"]' } });
    await db.app.create({ data: { id: "eb", teamId: "ts", ownerId: "u", appSlug: "admin.shopify.com", targetUrl: EASY_BLOCK, targetKind: "session" } });
    await db.app.create({ data: { id: "site", teamId: "ts", ownerId: "u", appSlug: "securification.ai", targetUrl: "https://securification.ai/", targetKind: "website" } });
    const actor = { userId: "u", teamId: "ts", plan: "business" as const };

    const named = await updateAppForTeam(db, actor, "eb", { name: " Securify " });
    const row = await db.app.findUnique({ where: { id: "eb" }, select: { name: true, appSlug: true, targetUrl: true } });
    eq("the settings write names the app, and the address stays", [named.ok, row], [true, { name: "Securify", appSlug: "admin.shopify.com", targetUrl: EASY_BLOCK }]);
    const tooLong = await updateAppForTeam(db, actor, "eb", { name: "x".repeat(APP_NAME_MAX + 1), userNotes: "not written either" });
    const after = await db.app.findUnique({ where: { id: "eb" }, select: { name: true, userNotes: true } });
    eq("a name too long is refused and nothing of the edit is written", ["error" in tooLong, after], [true, { name: "Securify", userNotes: null }]);
    await updateAppForTeam(db, actor, "eb", { userNotes: "a note" });
    eq("an edit that does not name it keeps the name", (await db.app.findUnique({ where: { id: "eb" }, select: { name: true } }))?.name, "Securify");

    const shell = await loadShellData(db, "ts");
    eq("the sidebar names the app by its name and marks the Shopify app; the website as before",
      shell.apps.map((a) => [a.label, a.shopify]).sort(), [["Securify", true], ["securification.ai", false]]);

    const deps = { db, origin: "https://checkmyapp.dev", trigger: async () => {}, siteCap: () => 1000, ephemeralTtlDays: () => 7, sleep: async () => {}, now: () => Date.now() };
    const tools = createRemoteTools({ user: { id: "u", email: "vladislav@securify.test", name: null }, team: { id: "ts", name: "Securify", plan: "business", features: ["shopify"] }, scope: "admin", door: "mcp" } as never, deps as never);
    const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);
    const renamed = parse(await tools.update_app({ app_id: "site", name: "OTP+" }));
    const listed = parse(await tools.list_apps()).apps.map((a: { app_id: string; name: string | null; app: string }) => [a.app_id, a.name, a.app]).sort();
    eq("MCP update_app names an app, and list_apps returns the name beside the address", [renamed.ok, listed], [true, [["eb", "Securify", "admin.shopify.com"], ["site", "OTP+", "securification.ai"]]]);
    parse(await tools.update_app({ app_id: "site", name: "" }));
    eq("…and \"\" clears it", (await db.app.findUnique({ where: { id: "site" }, select: { name: true } }))?.name, null);
  } finally {
    await real.dispose();
  }

  // 3. One rule, every place.
  const files = walk("src").filter((f) => /\.tsx?$/.test(f) && !f.startsWith("src/generated/"));
  const ownLabel = files.filter((f) => f !== "src/lib/app-label.ts" && calls(source(f)).some((c) => c.callee === "extensionDisplayName"));
  eq("no page or component works an app's label out by itself — every one asks appLabel", ownLabel, []);
  const marked = (file: string, expr: RegExp) => jsx(source(file)).some((e) => e.tag === "AppName" && expr.test(e.props.shopify ?? ""));
  check("the sidebar marks a Shopify app", marked("src/components/shell/sidebar.tsx", /^app\.shopify$/));
  check("All apps marks it, in the list and in the cards", jsx(source("src/app/(app)/health/apps/page.tsx")).filter((e) => e.tag === "AppName" && e.props.shopify === "app.shopify").length === 2);
  check("the live check and the verdict mark it", marked("src/components/run-live.tsx", /^isShopify$/) && marked("src/components/verdict-view.tsx", /isShopifyApp\(run\)/));
  const appPage = source("src/app/(app)/health/apps/[appId]/page.tsx");
  check("the app's own page marks it in its title", jsx(appPage).some((e) => e.tag === "ShopifyMark" && e.guard === "isShopifyApp(app)"));

  // 4. The mail.
  const notify = source("src/agent/notify-verdict.ts");
  const send = calls(notify).find((c) => c.callee === "sendVerdictReady");
  check("the verdict mail names the app by its name", Boolean(send && /appSlug: written\?\.app\?\.name\?\.trim\(\) \|\| run\.appSlug/.test(send.args[0])), send?.args[0].slice(0, 120));

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
