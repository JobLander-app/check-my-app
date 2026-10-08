// CHE-433: what a team has been given beyond its plan (src/lib/team-features.ts).
// The Securify pilot (CHE-432) puts everything Shopify behind the "shopify"
// feature, per team. This drives, against a real D1:
//
//   1. the stored value → features: unknown names ignored, garbage is nothing;
//   2. the operator's change (+shopify / -shopify), and refusal of anything else;
//   3. the real /connect/shopify page: a team without the feature gets a 404, a
//      team with it gets the form;
//   4. the real connectApp: refused without the feature, accepted with it;
//   5. the migration gives the feature to exactly the two teams SESSION_TEAMS
//      named, and SESSION_TEAMS is gone from the code.
// The MCP side (the tool listed only for a team with the feature) is held by
// scripts/verify-mcp-remote.ts.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-team-features.ts

process.env.CREDENTIALS_SECRET ??= "verify-team-features-secret";

import "./fixtures/wasm-module-loader.mjs";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { realD1 } from "./fixtures/real-d1";
import { hasFeature, parseTeamFeatures, teamFeatures, teamHasFeature, withFeatureChange } from "@/lib/team-features";
import { NOT_OPEN_YET, connectApp } from "@/lib/shopify-connect";

const ROOT = join(import.meta.dirname, "..");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

const fixture = { db: null as unknown, team: { id: "" } };

async function bundlePage(): Promise<() => Promise<unknown>> {
  const out = await build({
    entryPoints: [join(ROOT, "src/app/(app)/connect/shopify/page.tsx")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime"],
    plugins: [{
      name: "boundaries",
      setup(b) {
        const mocks: Record<string, string> = {
          "@/lib/auth": "export const requireUser = async () => ({ db: fixture.db, team: fixture.team, user: { id: 'u' } });",
          "next/navigation": "export const notFound = () => { const e = new Error('NEXT_NOT_FOUND'); e.digest = 'NEXT_NOT_FOUND'; throw e; };",
          "@/components/connect-shopify-form": "export const ConnectShopifyForm = () => null;",
        };
        b.onResolve({ filter: /.*/ }, (args) => (mocks[args.path] ? { path: args.path, namespace: "fixture" } : undefined));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
        // The real team-features module talks to the fixture's database.
        b.onResolve({ filter: /^@\/(.*)$/ }, (args) => ({ path: join(ROOT, "src", args.path.slice(2)) + (/\.(ts|tsx)$/.test(args.path) ? "" : ".ts") }));
      },
    }],
  });
  const mod = { exports: {} as { default: () => Promise<unknown> } };
  new Function("module", "exports", "fixture", "require", out.outputFiles[0].text)(mod, mod.exports, fixture, require);
  return mod.exports.default;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "generated" ? [] : walk(full);
    return /\.(ts|tsx|mjs)$/.test(name) ? [full] : [];
  });
}

async function main() {
  // 1 — the stored value.
  check("nothing stored → no features", parseTeamFeatures(null).length === 0 && parseTeamFeatures("").length === 0);
  check("garbage → no features", parseTeamFeatures("not json").length === 0 && parseTeamFeatures('{"shopify":true}').length === 0);
  check("a known feature is read", JSON.stringify(parseTeamFeatures('["shopify"]')) === '["shopify"]');
  check("an unknown name is ignored, never trusted", JSON.stringify(parseTeamFeatures('["shopify","admin","*"]')) === '["shopify"]');
  check("hasFeature", hasFeature(["shopify"], "shopify") && !hasFeature([], "shopify") && !hasFeature(null, "shopify"));

  // 2 — the operator's change.
  check("+shopify gives it", JSON.stringify(withFeatureChange([], "+shopify")) === '["shopify"]');
  check("-shopify takes it away", JSON.stringify(withFeatureChange(["shopify"], "-shopify")) === "[]");
  check("giving twice is still once", JSON.stringify(withFeatureChange(["shopify"], "+shopify")) === '["shopify"]');
  check("an unknown feature or a bare name is refused", withFeatureChange([], "+admin") === null && withFeatureChange([], "shopify") === null);

  const real = await realD1();
  try {
    const db = real.db;
    fixture.db = db;
    await db.user.createMany({ data: [{ id: "u_on", clerkUserId: "ck_on", email: "on@t.test" }, { id: "u_off", clerkUserId: "ck_off", email: "off@t.test" }] });
    await db.team.createMany({ data: [
      { id: "team_on", name: "On", plan: "business", features: '["shopify"]' },
      { id: "team_off", name: "Off", plan: "business" },
    ] });
    await db.membership.createMany({ data: [{ teamId: "team_on", userId: "u_on", scope: "admin" }, { teamId: "team_off", userId: "u_off", scope: "admin" }] as never });

    check("teamFeatures reads the row", JSON.stringify(await teamFeatures(db, "team_on")) === '["shopify"]' && (await teamFeatures(db, "team_off")).length === 0);
    check("a team that does not exist has nothing", !(await teamHasFeature(db, "team_nobody", "shopify")));

    // 3 — the real page.
    const page = await bundlePage();
    const render = async (teamId: string) => {
      fixture.team = { id: teamId };
      try {
        await page();
        return "rendered";
      } catch (err) {
        return (err as { digest?: string }).digest === "NEXT_NOT_FOUND" ? "404" : `error: ${(err as Error).message}`;
      }
    };
    check("/connect/shopify: a team without the feature gets a 404", (await render("team_off")) === "404");
    check("/connect/shopify: a team with it gets the form", (await render("team_on")) === "rendered");

    // 4 — the real connectApp.
    const link = "https://admin.shopify.com/store/a-store/apps/an-app";
    const off = await connectApp(db, { userId: "u_off", teamId: "team_off", plan: "business" }, link);
    check("connectApp: refused without the feature, by the sentence the page shows", "error" in off && off.error === NOT_OPEN_YET, JSON.stringify(off));
    const on = await connectApp(db, { userId: "u_on", teamId: "team_on", plan: "business" }, link);
    check("connectApp: accepted with it", "ok" in on && on.store === "a-store", JSON.stringify(on));
  } finally {
    await real.close?.();
  }

  // 5 — the migration, and the env list gone.
  const migrations = readdirSync(join(ROOT, "prisma/migrations")).filter((f) => f.endsWith(".sql"));
  const sql = migrations.map((f) => readFileSync(join(ROOT, "prisma/migrations", f), "utf8")).join("\n");
  check("a migration adds Team.features", /ALTER TABLE "Team" ADD COLUMN "features" TEXT/.test(sql));
  check("…and gives shopify to exactly the two teams SESSION_TEAMS named",
    /UPDATE "Team" SET "features" = '\["shopify"\]'\s+WHERE "id" IN \('team_cmt63nqx60000xm1op5202kif', 'team_cmumxo96y0000x31oqtgy50to'\)/.test(sql));
  const naming = walk(join(ROOT, "src")).filter((f) => readFileSync(f, "utf8").includes("SESSION_TEAMS"));
  check("SESSION_TEAMS is gone from the code", naming.length === 0, naming.join(", "));

  console.log(failures ? `\nverify-team-features: ${failures} FAILED` : "\nverify-team-features: all passed");
  process.exit(failures ? 1 : 0);
}

void main();
