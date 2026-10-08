// CHE-436: store a team's own OpenRouter key (BYOK) or clear it — ours to do,
// never the customer's. Prints the team before and after.
//
//   npm run team:byok -- <teamId>              (show whether it has a key)
//   npm run team:byok -- <teamId> <key>        (set the key)
//   npm run team:byok -- <teamId> clear        (clear the key)
//
// Runs against the production D1 through wrangler, with CLOUDFLARE_API_TOKEN
// from .env (node --env-file=.env). The key is encrypted with CREDENTIALS_SECRET
// from .env before storage; never logged or shown.

import { execFileSync } from "node:child_process";
import { encryptSecret } from "../src/lib/crypto";

function d1(sql: string): Record<string, unknown>[] {
  const out = execFileSync(
    process.execPath,
    ["./node_modules/wrangler/bin/wrangler.js", "d1", "execute", "checkmyapp", "--remote", "--json", "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const parsed = JSON.parse(out) as { results: Record<string, unknown>[] }[];
  return parsed[0]?.results ?? [];
}

function show(teamId: string): boolean {
  const row = d1(`SELECT id, name, plan, openrouterKeyEnc FROM "Team" WHERE id = '${teamId}'`)[0];
  if (!row) throw new Error(`no team ${teamId}`);
  const hasKey = Boolean(row.openrouterKeyEnc);
  console.log(`${row.id} · ${row.name} · ${row.plan} · byok: ${hasKey ? "set" : "none"}`);
  return hasKey;
}

const [teamId, arg] = process.argv.slice(2);
if (!teamId || !/^team_[a-z0-9]+$/.test(teamId)) {
  console.error("usage: npm run team:byok -- <teamId> [<key>|clear]");
  process.exit(2);
}
show(teamId);
if (arg) {
  const value = arg === "clear" ? "NULL" : `'${encryptSecret(arg)}'`;
  d1(`UPDATE "Team" SET "openrouterKeyEnc" = ${value}, "updatedAt" = CURRENT_TIMESTAMP WHERE id = '${teamId}'`);
  show(teamId);
  if (arg !== "clear") {
    // The key itself must never be logged; fingerprint it instead.
    console.log(`(key set; never shown again — use "clear" to remove)`);
  }
}
