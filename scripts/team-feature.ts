// CHE-433: give a team a feature, or take it away — ours to do, never the
// customer's. Prints the team before and after.
//
//   npm run team:feature -- <teamId>              (show)
//   npm run team:feature -- <teamId> +shopify     (give)
//   npm run team:feature -- <teamId> -shopify     (take away)
//
// Runs against the production D1 through wrangler, with CLOUDFLARE_API_TOKEN
// from .env (node --env-file=.env).

import { execFileSync } from "node:child_process";
import { parseTeamFeatures, withFeatureChange } from "../src/lib/team-features";

function d1(sql: string): Record<string, unknown>[] {
  const out = execFileSync(
    process.execPath,
    ["./node_modules/wrangler/bin/wrangler.js", "d1", "execute", "checkmyapp", "--remote", "--json", "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const parsed = JSON.parse(out) as { results: Record<string, unknown>[] }[];
  return parsed[0]?.results ?? [];
}

function show(teamId: string): string[] {
  const row = d1(`SELECT id, name, plan, features FROM "Team" WHERE id = '${teamId}'`)[0];
  if (!row) throw new Error(`no team ${teamId}`);
  const features = parseTeamFeatures(row.features as string | null);
  console.log(`${row.id} · ${row.name} · ${row.plan} · features: ${features.length ? features.join(", ") : "none"}`);
  return features;
}

const [teamId, change] = process.argv.slice(2);
if (!teamId || !/^team_[a-z0-9]+$/.test(teamId)) {
  console.error("usage: npm run team:feature -- <teamId> [+feature|-feature]");
  process.exit(2);
}
const before = show(teamId);
if (change) {
  const next = withFeatureChange(before as Parameters<typeof withFeatureChange>[0], change);
  if (!next) {
    console.error(`not a known change: ${change}`);
    process.exit(2);
  }
  // The value is built from the closed list only, so it is safe to inline.
  const value = next.length ? `'${JSON.stringify(next)}'` : "NULL";
  d1(`UPDATE "Team" SET "features" = ${value}, "updatedAt" = CURRENT_TIMESTAMP WHERE id = '${teamId}'`);
  show(teamId);
}
