// CHE-354 backfill: Finding.signature for rows written before the column, and
// IssueLink.findingId for customer tickets filed before CHE-103 (see below).
//
// Reads production D1 through wrangler (SELECT only) and computes each row's
// signature with the same function the agent now writes it with
// (src/lib/finding-signature.ts). It NEVER writes to the database: writing
// production data is a decision, so the script's output is a report and,
// with --sql, a file of UPDATE statements that whoever makes that decision
// applies with `wrangler d1 execute checkmyapp --remote --file <path>`.
//
// The report is also the evidence the ticket asks for: how many rows got which
// kind of signature, how often two findings of ONE check share a signature
// (the upper bound on problems the page key merges), what meetbashar.com's
// Holotope finding comes to, and the recurring count per app
// (src/lib/recurring.ts over the same rows).
//
// Usage (CLOUDFLARE_API_TOKEN exported, from the repo or a worktree):
//   npx tsx --tsconfig tsconfig.json scripts/backfill-finding-signature.ts [--sql out.sql]

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { findingSignature, signatureKind } from "@/lib/finding-signature";
import { extensionReportPublished } from "@/lib/extension-target";
import { recurrence, retiredSinceRun, toRecurrenceRun, type RecurrenceLink } from "@/lib/recurring";
import { dedupKeyForFinding } from "@/lib/tracker/file";

function query<T>(sql: string): T[] {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "checkmyapp", "--remote", "--json", "--command", sql], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out)[0].results as T[];
}

interface FindingRow {
  id: string;
  runId: string;
  number: number;
  title: string;
  category: string;
  severity: string;
  mark: string;
  detail: string | null;
  anchor: string | null;
  signature: string | null;
}
interface RunRow {
  id: string;
  runNumber: number;
  appId: string | null;
  appSlug: string;
  status: string;
  verdict: string | null;
  targetKind: string;
  startedAt: string;
}
interface JourneyRow {
  runId: string;
  order: number;
  appJourneyId: string | null;
  journeyKey: string | null;
  title: string;
  carriedFromRunId: string | null;
  status: string;
}

const sqlOut = process.argv.includes("--sql") ? process.argv[process.argv.indexOf("--sql") + 1] : null;

// The column arrives with migration 0053; before it is applied every row is
// simply unfilled.
let columnExists = true;
let findings: FindingRow[];
const COLS = `id, runId, number, title, category, severity, mark, detail, anchor`;
try {
  findings = query<FindingRow>(`SELECT ${COLS}, signature FROM Finding`);
} catch {
  columnExists = false;
  findings = query<Omit<FindingRow, "signature">>(`SELECT ${COLS} FROM Finding`).map((f) => ({ ...f, signature: null }));
}
const runs = query<RunRow>(`SELECT id, runNumber, appId, appSlug, status, verdict, targetKind, startedAt FROM Run`);
const journeys = query<JourneyRow>(
  `SELECT runId, "order", appJourneyId, journeyKey, title, carriedFromRunId, status FROM Journey ORDER BY runId, "order"`,
);
const retiredJourneys = query<{ id: string; appId: string; retiredAt: string }>(
  `SELECT id, appId, retiredAt FROM AppJourney WHERE retiredAt IS NOT NULL`,
);
const allLinks = query<RecurrenceLink & { appId: string; dedupKey: string; externalIssueId: string; firstSeenRunId: string | null }>(
  `SELECT id, appId, status, findingId, dedupKey, externalIssueId, firstSeenRunId FROM IssueLink`,
);

const runById = new Map(runs.map((r) => [r.id, r]));
const computed = new Map<string, string>();
for (const f of findings) {
  const run = runById.get(f.runId);
  if (run) computed.set(f.id, findingSignature({ appSlug: run.appSlug, ...f }));
}

// ── IssueLink.findingId for customer tickets filed before CHE-103 ─────────────
// recurring.ts ties a ticket to an issue only through findingId, because a
// link without one is usually our own [Checker gap]/[Checker defect] ticket.
// But customer tickets filed before CHE-103 have none either (CHE-79 and CHE-87
// were Canceled = not a bug). Recover their finding exactly the way reconcile
// does (originalFinding): the finding of the first-seen run whose CHE-59 key
// equals the link's — else the earliest finding of the app with that key. A
// link no finding produces is our own ticket and stays NULL.
const appIdOfRun = (runId: string) => runById.get(runId)?.appId ?? null;
const linkPointers: Array<{ link: (typeof allLinks)[number]; finding: FindingRow }> = [];
for (const link of allLinks.filter((l) => l.findingId === null)) {
  const candidates = findings
    .filter((f) => appIdOfRun(f.runId) === link.appId && dedupKeyForFinding(f, runById.get(f.runId)!) === link.dedupKey)
    .sort((a, b) => runById.get(a.runId)!.runNumber - runById.get(b.runId)!.runNumber);
  const finding = candidates.find((f) => f.runId === link.firstSeenRunId) ?? candidates[0];
  if (finding) linkPointers.push({ link, finding });
}
const pointed = new Map(linkPointers.map((p) => [p.link.id, p.finding.id]));
const links = allLinks
  .map((l) => ({ ...l, findingId: l.findingId ?? pointed.get(l.id) ?? null }))
  .filter((l) => l.findingId !== null);
console.log(`IssueLink without findingId: ${allLinks.filter((l) => l.findingId === null).length}` +
  ` · customer tickets recovered: ${linkPointers.length} · left NULL (our own tickets): ` +
  `${allLinks.filter((l) => l.findingId === null).length - linkPointers.length}`);
for (const p of linkPointers) {
  console.log(`  ${p.link.externalIssueId} (${p.link.status}) → #${runById.get(p.finding.runId)!.runNumber} "${p.finding.title}"`);
}

// ── What the backfill would write ─────────────────────────────────────────────
const unfilled = findings.filter((f) => f.signature === null && computed.has(f.id));
const disagree = findings.filter((f) => f.signature !== null && f.signature !== computed.get(f.id));
const byKind: Record<string, number> = {};
for (const f of unfilled) byKind[signatureKind(computed.get(f.id)!)] = (byKind[signatureKind(computed.get(f.id)!)] ?? 0) + 1;
console.log(`Finding.signature column in prod: ${columnExists ? "present" : "absent (migration 0053 not applied yet)"}`);
console.log(`rows: ${findings.length} · to fill: ${unfilled.length} · already filled: ${findings.length - unfilled.length}` +
  ` · filled but disagreeing with today's function: ${disagree.length}`);
console.log(`by kind: ${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(" · ")}`);

const perRun = new Map<string, Map<string, string[]>>();
for (const f of findings) {
  const sig = computed.get(f.id);
  if (!sig) continue;
  const m = perRun.get(f.runId) ?? new Map<string, string[]>();
  m.set(sig, [...(m.get(sig) ?? []), f.title]);
  perRun.set(f.runId, m);
}
const shared = [...perRun.entries()].flatMap(([runId, m]) =>
  [...m.entries()].filter(([, titles]) => titles.length > 1).map(([sig, titles]) => ({ run: runById.get(runId)!, sig, titles })),
);
const anchoredRunIds = new Set(findings.filter((f) => f.anchor).map((f) => f.runId));
console.log(`\ntwo or more findings of ONE check sharing a signature: ${shared.length}` +
  ` (${shared.filter((s) => anchoredRunIds.has(s.run.id)).length} in checks whose findings carry an anchor)`);
for (const s of shared.filter((x) => anchoredRunIds.has(x.run.id))) {
  console.log(`  #${s.run.runNumber} ${s.run.appSlug} ${signatureKind(s.sig)}: ${s.titles.map((t) => JSON.stringify(t)).join(" + ")}`);
}

// ── Recurrence per app, over the same rows ────────────────────────────────────
const journeysByRun = new Map<string, JourneyRow[]>();
for (const j of journeys) journeysByRun.set(j.runId, [...(journeysByRun.get(j.runId) ?? []), j]);
const findingsByRun = new Map<string, FindingRow[]>();
for (const f of findings) findingsByRun.set(f.runId, [...(findingsByRun.get(f.runId) ?? []), f]);

const apps = new Map<string, string>();
for (const r of runs) if (r.appId) apps.set(r.appId, r.appSlug);
console.log(`\nrecurring per app (finished checks only):`);
console.log(`  app                                  checks  issues  recurring  new  gone  known  not_a_bug`);
const meetbashar: string[] = [];
for (const [appId, appSlug] of [...apps.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
  const finished = runs
    .filter((r) => r.appId === appId && ["completed", "partial"].includes(r.status) && extensionReportPublished(r))
    .sort((a, b) => a.runNumber - b.runNumber);
  const retiredSince = retiredSinceRun(retiredJourneys.filter((j) => j.appId === appId), finished);
  const appRuns = finished
    .map((r) =>
      toRecurrenceRun({
        runNumber: r.runNumber,
        journeys: journeysByRun.get(r.id) ?? [],
        findings: (findingsByRun.get(r.id) ?? []).sort((a, b) => a.number - b.number).map((f) => ({ ...f, signature: computed.get(f.id)! })),
      }),
    );
  const result = recurrence({ id: appId, appSlug }, appRuns, links.filter((l) => l.appId === appId), { retiredSince });
  const n = (s: string) => result.filter((r) => r.issue.state === s).length;
  console.log(`  ${appSlug.padEnd(36)} ${String(appRuns.length).padStart(6)}  ${String(result.length).padStart(6)}` +
    `  ${String(n("recurring")).padStart(9)}  ${String(n("new")).padStart(3)}  ${String(n("gone")).padStart(4)}` +
    `  ${String(n("known")).padStart(5)}  ${String(n("not_a_bug")).padStart(9)}`);
  if (appSlug === "meetbashar.com") {
    for (const r of result) {
      meetbashar.push(`  ${r.issue.state.padEnd(9)} seen ${r.issue.timesSeen}× #${r.issue.firstSeenRunNumber}→#${r.issue.lastSeenRunNumber}` +
        `${r.goneSinceRunNumber ? `, gone since #${r.goneSinceRunNumber}` : ""}  ${signatureKind(r.issue.signature)}  ${r.issue.title}`);
    }
  }
  for (const r of result.filter((x) => x.issue.state === "recurring")) {
    console.log(`      recurring: seen ${r.issue.timesSeen}× #${r.issue.firstSeenRunNumber}→#${r.issue.lastSeenRunNumber}  ${r.issue.title}`);
  }
}
console.log(`\nmeetbashar.com, every issue:\n${meetbashar.join("\n")}`);

if (sqlOut) {
  const statements = [
    ...unfilled.map((f) => `UPDATE "Finding" SET "signature" = '${computed.get(f.id)}' WHERE "id" = '${f.id}' AND "signature" IS NULL;`),
    ...linkPointers.map((p) => `UPDATE "IssueLink" SET "findingId" = '${p.finding.id}' WHERE "id" = '${p.link.id}' AND "findingId" IS NULL;`),
  ];
  writeFileSync(sqlOut, `${statements.join("\n")}\n`);
  console.log(`\nwrote ${statements.length} UPDATE statements (${unfilled.length} Finding.signature, ` +
    `${linkPointers.length} IssueLink.findingId) to ${sqlOut} — NOT applied.`);
}
