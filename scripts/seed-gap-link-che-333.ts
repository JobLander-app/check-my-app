// One-off data fix for CHE-374: give the hand-filed CHE-333 the ledger row the
// filer would have written, so the shopify_admin capability gap comments and
// counts on CHE-333 instead of opening a new ticket.
//
// The row is keyed exactly as fileCapabilityGaps keys a gap — on our own app,
// with dedupKeyForFinding over the class label — and verify-gap-filing.ts runs
// the real filing path against this key, so the two cannot drift apart.
//
// Idempotent: a second run inserts nothing. If the key is already taken by a
// different ticket (a Shopify run filed between deploy and seed), nothing is
// overwritten and the script exits non-zero naming that ticket — it is then a
// duplicate of CHE-333 to merge by hand, not something to paper over.
//
// Not a migration: it needs our own app's row, which exists only in prod.
//
// Usage:
//   npx tsx --tsconfig tsconfig.json scripts/seed-gap-link-che-333.ts --dry-run
//   node --env-file=.env node_modules/.bin/tsx --tsconfig tsconfig.json scripts/seed-gap-link-che-333.ts
// The second form writes to prod D1 and needs CLOUDFLARE_API_TOKEN.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { OUR_BOARD_TEAM_ID } from "@/agent/capability-gaps";
import { GAP_CLASSES } from "@/agent/gap-classes";
import { dedupKeyForFinding } from "@/lib/tracker/file";

export const CHE_333 = {
  identifier: "CHE-333",
  linearId: "7b784932-1993-4dda-8d48-2dd3183bf3a1",
  url: "https://linear.app/joblander/issue/CHE-333/checker-gap-checking-an-app-that-lives-inside-the-shopify-admin",
} as const;

// The fields fileCapabilityGaps hashes, for the shopify_admin class. Only
// title, category, severity and detail.where reach the key; the rest of the
// filer's detail carries no request signature (verify-gap-filing.ts proves the
// key matches the filer's own).
export function shopifyAdminDedupKey(): string {
  return dedupKeyForFinding(
    {
      title: GAP_CLASSES.shopify_admin.label,
      category: "broken",
      severity: "high",
      detail: JSON.stringify({ where: "CheckMyApp agent capability" }),
    },
    { appSlug: "checkmyapp.dev" },
  );
}

const SEED_ID = "seed-che-374-shopify-admin";

// Our own app is found the way ourApp() finds it: the checkmyapp.dev row whose
// tracker files to our own Linear team, newest first.
const OUR_APP = `SELECT a.id FROM App a JOIN TrackerIntegration t ON t.appId = a.id
  WHERE a.appSlug = 'checkmyapp.dev' AND t.teamId = '${OUR_BOARD_TEAM_ID}'
  ORDER BY a.createdAt DESC LIMIT 1`;

// The text Prisma writes for a DateTime on D1 ("2026-10-01T20:33:52.030+00:00"),
// not SQLite's CURRENT_TIMESTAMP ("2026-10-01 20:33:52"): every other row in
// the table has this shape, and this one is read back by the same client.
const NOW = `strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now')`;

export function seedSql(key = shopifyAdminDedupKey()): string {
  // externalIssueId holds the identifier, as the filer writes it (file.ts),
  // not the Linear UUID: the tracker resolves either. defectClass stays NULL:
  // it records why a SUPPRESSED claim was wrong (reconcile.ts), and an open gap
  // link carries none. firstSeenRunId stays NULL: no run filed this ticket.
  return `INSERT INTO IssueLink (id, appId, dedupKey, externalIssueId, status, occurrences, firstSeenRunId, lastSeenAt, createdAt, updatedAt)
SELECT '${SEED_ID}', (${OUR_APP}), '${key}', '${CHE_333.identifier}', 'open', 1, NULL, ${NOW}, ${NOW}, ${NOW}
WHERE (${OUR_APP}) IS NOT NULL
ON CONFLICT DO NOTHING;`;
}

function readBackSql(key: string): string {
  return `SELECT id, appId, dedupKey, externalIssueId, status, occurrences FROM IssueLink
WHERE appId = (${OUR_APP}) AND dedupKey = '${key}';`;
}

interface LinkRow {
  id: string;
  appId: string;
  dedupKey: string;
  externalIssueId: string;
  status: string;
  occurrences: number;
}

function d1(sql: string): LinkRow[] {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "checkmyapp", "--remote", "--json", "--config", "wrangler.jsonc", "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  return (JSON.parse(out) as { results: LinkRow[] }[])[0]?.results ?? [];
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const key = shopifyAdminDedupKey();
  console.log(`class    : shopify_admin — "${GAP_CLASSES.shopify_admin.label}"`);
  console.log(`dedupKey : ${key}`);
  console.log(`ticket   : ${CHE_333.identifier} (${CHE_333.linearId}) ${CHE_333.url}`);
  console.log(`row      : ${JSON.stringify({ id: SEED_ID, appId: "<our app: checkmyapp.dev on team " + OUR_BOARD_TEAM_ID + ">", dedupKey: key, externalIssueId: CHE_333.identifier, status: "open", occurrences: 1, defectClass: null, firstSeenRunId: null })}`);
  console.log(`\n${seedSql(key)}\n`);

  if (dryRun) {
    if (process.env.CLOUDFLARE_API_TOKEN) {
      const existing = d1(readBackSql(key));
      console.log(`prod now : ${existing.length ? JSON.stringify(existing[0]) : "no row under this key — the seed would insert it"}`);
    }
    console.log("dry run: nothing written");
    return;
  }

  if (!process.env.CLOUDFLARE_API_TOKEN) {
    console.error("CLOUDFLARE_API_TOKEN is not set — run with node --env-file=.env (see Usage).");
    process.exit(1);
  }
  d1(seedSql(key));
  const [row] = d1(readBackSql(key));
  if (!row) {
    console.error("no row after the insert — our own app (checkmyapp.dev on our Linear team) was not found");
    process.exit(1);
  }
  console.log(`prod row : ${JSON.stringify(row)}`);
  if (row.externalIssueId !== CHE_333.identifier) {
    console.error(`the key already points at ${row.externalIssueId}, not ${CHE_333.identifier} — merge that ticket into ${CHE_333.identifier} and re-point the row by hand`);
    process.exit(1);
  }
  console.log(`seeded: shopify_admin gaps now count on ${CHE_333.identifier}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
