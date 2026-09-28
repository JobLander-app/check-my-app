// Pricing rule (CLAUDE.md §10): what a check costs US — dollars, tokens, the
// multiplier we price it at — never reaches anything a customer or their agent
// reads. Owner, 2026-09-28.
//
// verify-public-copy.ts guards the hand-written pages. This guards the other
// door, the DATA: until 2026-09-28 the public verdict payload (by run id, no
// login) and the MCP tools get_verdict / wait_for_run returned `cost_usd` and
// `total_tokens` — our operating figures, handed to every caller.
//
// Two checks, because a word list alone would miss a leak spelled differently
// (see the memory note "a check that counts will lie"):
//   1. Static: no cost/token/multiplier identifier in the modules that build
//      customer-facing payloads (comments stripped — a comment is ours).
//   2. Behavioural: the real loadVerdict / loadRunStatus, fed a run whose cost
//      and token figures are known, return a payload in which neither the keys
//      nor the values appear.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/verify-cost-never-shown.ts

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { loadRunStatus, loadVerdict } from "../src/lib/run-read";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`);
}

// Modules whose return values a customer or their agent receives. Internal
// accounting (the workflow, the doer, cleanup) is deliberately not here.
const PAYLOAD_SOURCES = [
  "src/app/api",
  "src/lib/mcp",
  "src/lib/run-read.ts",
  "src/lib/review.ts",
  "src/lib/latest-results.ts",
  "src/lib/email.ts",
];

// Identifiers that carry our side of the invoice. `priceUsd` / `price_usd` —
// what the customer pays — is not on this list and is allowed.
const FORBIDDEN = /\b(costUsd|cost_usd|llmUsage|total_tokens|inputTokens|outputTokens|multiplier|markup)\b/;

function files(p: string): string[] {
  const abs = path.join(repoRoot, p);
  if (!statSync(abs, { throwIfNoEntry: false })) return [];
  if (statSync(abs).isFile()) return [abs];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(p, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(abs, e.name)] : [],
  );
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

for (const file of PAYLOAD_SOURCES.flatMap(files)) {
  const lines = stripComments(readFileSync(file, "utf8")).split("\n");
  lines.forEach((line, i) => {
    const m = line.match(FORBIDDEN);
    if (m) check(`no ${m[1]} in a customer payload`, false, `${path.relative(repoRoot, file)}:${i + 1}`);
  });
}
check("static scan of customer payload modules ran", PAYLOAD_SOURCES.flatMap(files).length > 5);

// Behavioural: a completed run with distinctive cost and token numbers.
const COST = 0.4217;
const TOKENS = 987_654;
const row = {
  publicId: "pub_rule10",
  runNumber: 42,
  appSlug: "shop.example.test",
  targetUrl: "https://shop.example.test",
  targetKind: "website",
  status: "completed",
  verdict: "mostly_ok",
  deploySha: null,
  deployEnv: null,
  bottomLine: "Checkout works.",
  ephemeral: false,
  expiresAt: null,
  events: "[]",
  errorMessage: null,
  startedAt: new Date(),
  completedAt: new Date(),
  costUsd: COST,
  journeys: [],
  findings: [],
  llmUsage: [{ model: "m", costUsd: COST, inputTokens: TOKENS, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }],
};
// Honours `select` the way Prisma does, so a loader that selects only safe
// columns is judged on what it selected, not on the whole row.
const db = {
  run: {
    findUnique: async (args: { select?: Record<string, boolean> }) =>
      args.select
        ? Object.fromEntries(Object.keys(args.select).filter((k) => args.select![k]).map((k) => [k, row[k as keyof typeof row]]))
        : row,
  },
} as never;

async function main() {
  for (const [name, load] of [["loadVerdict", loadVerdict], ["loadRunStatus", loadRunStatus]] as const) {
    const payload = await load(db, row.publicId);
    const json = JSON.stringify(payload);
    check(`${name} returns a payload`, payload != null);
    check(`${name} carries no cost/token key`, !/cost|token|multiplier/i.test(json), json.match(/"[^"]*(cost|token|multiplier)[^"]*"/i)?.[0] ?? "");
    check(`${name} carries no cost value`, !json.includes(String(COST)));
    check(`${name} carries no token count`, !json.includes(String(TOKENS)));
  }
  console.log(failures === 0 ? "\nall pass" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
