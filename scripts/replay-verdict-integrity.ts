// CHE-365: put real production runs through the verdict-integrity rules and
// say which ones they would change. A replay, not a verify: it needs
// CLOUDFLARE_API_TOKEN and reads production D1 (read-only).
//
// Usage:
//   npx tsx --tsconfig tsconfig.json scripts/replay-verdict-integrity.ts 281 282 272
//   npx tsx --tsconfig tsconfig.json scripts/replay-verdict-integrity.ts --recent 150
//   npx tsx --tsconfig tsconfig.json scripts/replay-verdict-integrity.ts --dump 272   # fixture JSON
//
// The stored verdict stands in for synthesis's: it is what synthesis said,
// unless a rule already corrected it — and a stored `unverified` is skipped.

import { execFileSync } from "node:child_process";
import { judgeVerdictIntegrity, type IntegrityJourney } from "@/agent/verdict-integrity";
import type { Verdict } from "@/lib/enums";

interface RunRow {
  id: string;
  runNumber: number;
  appSlug: string;
  targetUrl: string;
  verdict: Verdict | null;
  bottomLine: string | null;
  nf: number;
}

interface StepRow {
  runId: string;
  jid: string;
  jo: number;
  title: string;
  js: string;
  carried: string | null;
  // Null on the single row a step-less journey yields from the left join.
  so: number | null;
  label: string | null;
  ss: string | null;
  ur: string | null;
  actions: string | null;
}

function d1<T>(sql: string): T[] {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "checkmyapp", "--remote", "--json", "--config", "wrangler.jsonc", "--command", sql],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out) as Array<{ results: T[] }>;
  return parsed.flatMap((r) => r.results);
}

function journeysOf(steps: StepRow[]): Array<IntegrityJourney & { title: string; carried: string | null }> {
  const byJourney = new Map<string, IntegrityJourney & { title: string; carried: string | null; order: number }>();
  for (const s of steps) {
    let j = byJourney.get(s.jid);
    if (!j) {
      j = { title: s.title, status: s.js, carried: s.carried, order: s.jo, steps: [] };
      byJourney.set(s.jid, j);
    }
    // A journey with no steps comes back as one row of nulls from the left join.
    if (s.ss !== null) j.steps.push({ status: s.ss, unverifiedReason: s.ur, actions: s.actions });
  }
  return [...byJourney.values()].sort((a, b) => a.order - b.order).map(({ order: _order, ...j }) => j);
}

const args = process.argv.slice(2);
const dump = args[0] === "--dump";
let where: string;
if (args[0] === "--recent") {
  const n = Number(args[1] ?? 100);
  where = `status in ('completed','partial') order by runNumber desc limit ${n}`;
} else {
  const nums = args.filter((a) => /^\d+$/.test(a));
  where = `runNumber in (${nums.join(",")}) order by runNumber`;
}

const runs = d1<RunRow>(
  `select id, runNumber, appSlug, targetUrl, verdict, bottomLine, ` +
    `(select count(*) from Finding f where f.runId = Run.id) nf from Run where ${where}`,
);

const BATCH = 15;
const stepsByRun = new Map<string, StepRow[]>();
for (let i = 0; i < runs.length; i += BATCH) {
  const ids = runs.slice(i, i + BATCH).map((r) => `'${r.id}'`).join(",");
  const rows = d1<StepRow>(
    `select j.runId, j.id jid, j."order" jo, j.title, j.status js, j.carriedFromRunId carried, ` +
      `s."order" so, s.label, s.status ss, s.unverifiedReason ur, s.actions ` +
      `from Journey j left join Step s on s.journeyId = j.id where j.runId in (${ids}) order by j."order", s."order"`,
  );
  for (const r of rows) {
    const list = stepsByRun.get(r.runId) ?? [];
    list.push(r);
    stepsByRun.set(r.runId, list);
  }
}

if (dump) {
  const run = runs[0];
  const steps = stepsByRun.get(run.id) ?? [];
  const byJourney = new Map<string, { title: string; status: string; carriedFromRunId: string | null; steps: unknown[] }>();
  for (const s of steps) {
    const j = byJourney.get(s.jid) ?? { title: s.title, status: s.js, carriedFromRunId: s.carried, steps: [] };
    // A fixture lands in source control: a URL's query can carry a signed
    // sign-in token (accounts.shopify.com's `verify`), and no rule reads a
    // query, so every query is redacted on the way out.
    const actions = s.actions?.replace(/(https?:\/\/[^"\\?\s]+)\?[^"\\\s]*/g, "$1?REDACTED") ?? null;
    if (s.ss !== null) j.steps.push({ label: s.label, status: s.ss, unverifiedReason: s.ur, actions });
    byJourney.set(s.jid, j);
  }
  console.log(
    JSON.stringify(
      {
        runNumber: run.runNumber,
        appSlug: run.appSlug,
        targetUrl: run.targetUrl,
        verdict: run.verdict,
        findings: run.nf,
        bottomLine: run.bottomLine,
        journeys: [...byJourney.values()],
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

let changed = 0;
for (const run of runs) {
  if (!run.verdict || run.verdict === "unverified") continue;
  const journeys = journeysOf(stepsByRun.get(run.id) ?? []);
  // A run with no journey rows is a smoke run: it completes before walking and
  // is deliberately never routed through these rules (workflow.ts), so
  // replaying it would report a change that cannot happen.
  if (journeys.length === 0) continue;
  // Only the count matters to the coverage rules; a stored `broken` already
  // survived the "broken needs a body" rule, so its findings are marked as
  // the body it had rather than re-judged here.
  const findings = Array.from({ length: run.nf }, () => ({ category: "broken", severity: "high" }));
  const out = judgeVerdictIntegrity(journeys, findings, { verdict: run.verdict, bottomLine: run.bottomLine }, run.targetUrl);
  const demoted = out.verdict === "unverified";
  const mark = demoted ? "CHANGED" : "same   ";
  if (demoted) changed++;
  console.log(
    `${mark} #${run.runNumber} ${run.appSlug.padEnd(32)} ${run.verdict.padEnd(16)} → ${out.verdict.padEnd(16)} ` +
      `findings=${run.nf} journeys=${journeys.length}${out.note ? `  [${out.note}]` : ""}`,
  );
}
console.log(`\n${changed} of ${runs.length} runs would change.`);
