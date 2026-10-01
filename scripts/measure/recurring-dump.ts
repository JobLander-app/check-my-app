// CHE-354: what recurrence() says about real history — read-only.
//
// Feeds a dump of prod rows through the same toRecurrenceRun + recurrence the
// product uses, and prints every issue seen in two or more checks with the
// findings it grouped, so a person can read each group and see whether it is
// one problem. This is how the grouping rule was measured (SAME_PROBLEM in
// src/lib/finding-signature.ts) and how a reviewer can measure it again.
//
// The dump is six JSON files as `wrangler d1 execute --json` prints them
// (`[{ results: [...] }]`), in one directory:
//
//   runs.json      SELECT id, runNumber, appId, appSlug, status, verdict, targetKind, startedAt FROM Run
//   journeys.json  SELECT id, runId, "order", journeyKey, appJourneyId, title, carriedFromRunId FROM Journey
//   steps.json     SELECT journeyId, "order", status FROM Step
//   findings.json  SELECT id, runId, number, title, category, severity, mark, detail, anchor FROM Finding
//   links.json     SELECT id, appId, status, findingId, dedupKey, firstSeenRunId FROM IssueLink
//   catalog.json   SELECT id, appId, retiredAt FROM AppJourney
//
// Runs are grouped by appSlug, not appId: a third of the history predates the
// App row, and the question here is the grouping, not who owns the app.
//
// Usage: npx tsx --tsconfig tsconfig.json scripts/measure/recurring-dump.ts <dir> [prefix]

import { readFileSync } from "node:fs";
import { recurrence, retiredSinceRun, toRecurrenceRun, type RecurrenceFinding } from "@/lib/recurring";

const dir = process.argv[2];
const prefix = process.argv[3] ?? "";
if (!dir) {
  console.error("usage: recurring-dump.ts <dir> [file prefix]");
  process.exit(2);
}
function rows<T>(name: string): T[] {
  const parsed = JSON.parse(readFileSync(`${dir}/${prefix}${name}.json`, "utf8"));
  return (Array.isArray(parsed) && parsed[0]?.results ? parsed[0].results : parsed) as T[];
}

type Run = { id: string; runNumber: number; appId: string | null; appSlug: string; status: string; startedAt: string };
type Journey = { id: string; runId: string; order: number; journeyKey: string | null; appJourneyId: string | null; title: string; carriedFromRunId: string | null };
type Step = { journeyId: string; order: number; status: string };
type Finding = RecurrenceFinding & { runId: string; number: number };
type Link = { id: string; appId: string; status: string; findingId: string | null; dedupKey: string; firstSeenRunId: string | null };

const runs = rows<Run>("runs").filter((r) => ["completed", "partial"].includes(r.status));
const journeys = rows<Journey>("journeys");
const steps = rows<Step>("steps");
const findings = rows<Finding>("findings");
const links = rows<Link>("links");
const catalog = rows<{ id: string; appId: string; retiredAt: string | null }>("catalog");

const stepsOf = new Map<string, Step[]>();
for (const s of steps) stepsOf.set(s.journeyId, [...(stepsOf.get(s.journeyId) ?? []), s]);
const journeysOf = new Map<string, Journey[]>();
for (const j of journeys) journeysOf.set(j.runId, [...(journeysOf.get(j.runId) ?? []), j]);
const findingsOf = new Map<string, Finding[]>();
for (const f of findings) findingsOf.set(f.runId, [...(findingsOf.get(f.runId) ?? []), f]);
const runNumberOf = new Map(runs.map((r) => [r.id, r.runNumber]));

const apps = [...new Set(runs.map((r) => r.appSlug))].sort();
let total = 0;
let multi = 0;
const states: Record<string, number> = {};
for (const appSlug of apps) {
  const appRuns = runs.filter((r) => r.appSlug === appSlug).sort((a, b) => a.runNumber - b.runNumber);
  const appIds = new Set(appRuns.map((r) => r.appId).filter(Boolean));
  const recurrenceRuns = appRuns.map((r) =>
    toRecurrenceRun({
      runNumber: r.runNumber,
      journeys: (journeysOf.get(r.id) ?? [])
        .sort((a, b) => a.order - b.order)
        .map((j) => ({ ...j, steps: (stepsOf.get(j.id) ?? []).sort((a, b) => a.order - b.order) })),
      findings: (findingsOf.get(r.id) ?? []).sort((a, b) => a.number - b.number).map((f) => ({ ...f, signature: null })),
    }),
  );
  const appLinks = links
    .filter((l) => appIds.has(l.appId))
    .map((l) => ({ ...l, firstSeenRunNumber: l.firstSeenRunId ? runNumberOf.get(l.firstSeenRunId) ?? null : null }));
  const own = catalog.filter((j) => appIds.has(j.appId));
  const retiredSince = retiredSinceRun(own.filter((j) => j.retiredAt !== null), appRuns);
  const liveJourneys = new Set(own.filter((j) => j.retiredAt === null).map((j) => j.id));
  const result = recurrence({ id: appSlug, appSlug }, recurrenceRuns, appLinks, { retiredSince, liveJourneys });
  total += result.length;
  for (const r of result) states[r.issue.state] = (states[r.issue.state] ?? 0) + 1;
  const seenTwice = result.filter((r) => r.issue.timesSeen >= 2);
  multi += seenTwice.length;
  if (seenTwice.length === 0) continue;
  console.log(`\n${appSlug}: ${result.length} issues, ${seenTwice.length} seen in two or more checks`);
  for (const r of seenTwice) {
    console.log(`  ${r.issue.state}${r.goneSinceRunNumber ? ` since #${r.goneSinceRunNumber}` : ""}, ${r.issue.timesSeen}×`);
    for (const s of r.sightings) console.log(`    #${s.runNumber}  ${s.title}`);
  }
}
console.log(`\n${total} issues over ${apps.length} apps; ${multi} seen in two or more checks; by state: ${JSON.stringify(states)}`);
