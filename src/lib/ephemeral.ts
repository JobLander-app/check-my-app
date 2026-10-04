// Ephemeral runs (CHE-202): a PR-preview hostname is a run, not an app.
//
// A CI job that deploys pr-123.preview.example.com and asks us to walk it
// wants one verdict for one build. Nothing about that hostname deserves an App
// row: nobody will watch it, file tickets on it or export specs for it, and it
// is gone within days. So an ephemeral run is
//
//   - owned: only an authenticated caller (API key or Clerk) may start one, so
//     it is private and never listed on /checks/today — an anonymous
//     "ephemeral" request is refused, not silently downgraded;
//   - app-less: no App row is created, adopted or looked up for it, and the
//     paths that would create one on the way (Enable Daily Watch, Connect
//     GitHub, Export specs) refuse it;
//   - dated: expiresAt is set at creation, and once it passes the run is
//     deleted outright — journeys, steps, findings, evidence rows and the R2
//     objects nothing else references. It is the only kind of run we delete:
//     verdicts are otherwise the record of what we saw (rule §6), but the
//     target this one describes no longer exists either.
//
// The sweep is a function, not a scheduler: src/agent/janitor.ts calls it on
// every tick, the way it sweeps the self-check account.

import type { PrismaClient } from "@/generated/prisma/client";
import { deleteObjects, evidenceKey, thumbKeyOf } from "@/lib/storage";
import { isChromeStoreUrl } from "@/lib/extension-target";
import { systemWide } from "@/lib/tenant-db";

// How long an ephemeral run and its evidence live. Long enough to be read after
// the PR merges; short enough that a busy repo never accumulates them.
export const EPHEMERAL_RUN_TTL_DAYS = 7;

// The TTL the web worker is actually running with. Same parsing rule as the
// site cap (src/lib/plans.ts siteCapFromEnv): only a positive integer counts,
// anything else is the default, so a typo can never make runs immortal or
// delete them on the next tick. Pure; the web app reads its env in
// src/lib/site-cap.ts.
export function ephemeralTtlDaysFromEnv(env: Record<string, unknown> | null | undefined): number {
  const raw = env?.EPHEMERAL_RUN_TTL_DAYS;
  if (typeof raw !== "string" && typeof raw !== "number") return EPHEMERAL_RUN_TTL_DAYS;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return EPHEMERAL_RUN_TTL_DAYS;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : EPHEMERAL_RUN_TTL_DAYS;
}

export function ephemeralExpiry(now: Date, ttlDays: number): Date {
  return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
}

export const EPHEMERAL_REQUIRES_OWNER_CODE = "ephemeral_requires_owner";

export type EphemeralGate =
  | { ok: true; ephemeral: boolean }
  | { ok: false; code: typeof EPHEMERAL_REQUIRES_OWNER_CODE; reason: string };

// May this caller start an ephemeral run? An owned run is the whole point —
// private, quota by plan, deletable by us alone — so an anonymous request for
// one is refused with a code the caller can act on (sign in, or use an API
// key), never downgraded to a public anonymous run of a preview URL.
export function ephemeralGate(
  requested: boolean | undefined,
  owner: { id: string } | null,
): EphemeralGate {
  if (!requested) return { ok: true, ephemeral: false };
  if (!owner) {
    return {
      ok: false,
      code: EPHEMERAL_REQUIRES_OWNER_CODE,
      reason:
        "Ephemeral checks need an account: pass an API key (dashboard → API keys) or sign in. " +
        "Anonymous checks are public and cannot be ephemeral.",
    };
  }
  return { ok: true, ephemeral: true };
}

// D1 binds at most 100 parameters per statement, so every `in` below is
// chunked. Runs per sweep are bounded too: a tick stays short, and what is
// left is picked up by the next one.
const PARAM_CHUNK = 90;
const RUNS_PER_SWEEP = 25;

function chunk<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += PARAM_CHUNK) out.push(items.slice(i, i + PARAM_CHUNK));
  return out;
}

async function eachChunk<T>(items: T[], fn: (part: T[]) => Promise<unknown>): Promise<void> {
  for (const part of chunk(items)) await fn(part);
}

export interface EphemeralSweepResult {
  // Runs deleted.
  runs: number;
  // R2 objects deleted. Zero when no bucket was passed — the rows are gone
  // either way; the objects then wait for a sweep that has one.
  evidence: number;
}

// Delete every ephemeral run whose expiresAt has passed, with everything it
// owns. Bottom-up so a failure midway leaves nothing dangling that the next
// tick cannot finish: evidence → steps → journeys → findings → ledgers → run.
//
// Shared R2 objects are deleted last and only when no surviving row still points at
// them: screenshots are content-addressed (src/agent/env.ts putScreenshot —
// screenshots/<sha256>.png), so two runs that saw the same pixels share one
// object, and an ephemeral run of a preview deploy very often sees exactly
// what production shows. Deleting by run would take the other run's evidence
// with it.
export async function sweepExpiredEphemeralRuns(
  db: PrismaClient,
  now: Date = new Date(),
  evidenceBucket?: R2Bucket | null,
): Promise<EphemeralSweepResult> {
  const expired = await db.run.findMany({ ...systemWide("janitor"),
    where: { ephemeral: true, expiresAt: { lt: now } },
    select: { id: true, targetKind: true, targetUrl: true, transcriptUrl: true, liveScreenshotUrl: true },
    orderBy: { expiresAt: "asc" },
    take: RUNS_PER_SWEEP,
  });
  // Private extension artifacts have no public URL references. Keep the row
  // until its private namespace can be swept, so an R2 outage remains retryable.
  const extension = (run: typeof expired[number]) => run.targetKind === "extension" || isChromeStoreUrl(run.targetUrl);
  const runs = expired.filter(run => !extension(run) || evidenceBucket);
  if (runs.length === 0) return { runs: 0, evidence: 0 };
  const runIds = runs.map((r) => r.id);
  const extensionKeys = new Set<string>();
  if (evidenceBucket) {
    for (const run of runs.filter(extension)) {
      for (const prefix of [`private/runs/${run.id}/`, `private/extensions/${run.id}_`, `extensions/${run.id}_`, `extensions/${run.id}/`]) {
        let cursor: string | undefined;
        do {
          const page = await evidenceBucket.list({ prefix, cursor });
          for (const object of page.objects) {
            if (!object.key.startsWith(prefix)) throw new Error("Extension expiry received an artifact outside its run");
            extensionKeys.add(object.key);
          }
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
      }
    }
    // These namespaces belong exclusively to the expired run. Delete before
    // its row so an R2 failure keeps the owner pointer for the next sweep.
    // A later D1 failure is safe to retry against an already empty namespace.
    await deleteObjects(evidenceBucket, [...extensionKeys]);
  }

  // Everything the runs own, and every evidence URL any of it carries.
  const journeys: { id: string; videoUrl: string | null }[] = [];
  await eachChunk(runIds, async (ids) => {
    journeys.push(
      ...(await db.journey.findMany({
        where: { runId: { in: ids } },
        select: { id: true, videoUrl: true },
      })),
    );
  });
  const journeyIds = journeys.map((j) => j.id);

  const steps: { id: string; screenshotUrl: string | null }[] = [];
  await eachChunk(journeyIds, async (ids) => {
    steps.push(
      ...(await db.step.findMany({
        where: { journeyId: { in: ids } },
        select: { id: true, screenshotUrl: true },
      })),
    );
  });
  const stepIds = steps.map((s) => s.id);

  const findings: { id: string }[] = [];
  await eachChunk(runIds, async (ids) => {
    findings.push(...(await db.finding.findMany({ where: { runId: { in: ids } }, select: { id: true } })));
  });
  const findingIds = findings.map((f) => f.id);

  const evidence: { id: string; storageUrl: string }[] = [];
  await eachChunk(stepIds, async (ids) => {
    evidence.push(
      ...(await db.evidence.findMany({ where: { stepId: { in: ids } }, select: { id: true, storageUrl: true } })),
    );
  });
  await eachChunk(findingIds, async (ids) => {
    evidence.push(
      ...(await db.evidence.findMany({
        where: { findingId: { in: ids } },
        select: { id: true, storageUrl: true },
      })),
    );
  });

  const urls = new Set<string>();
  for (const e of evidence) urls.add(e.storageUrl);
  for (const s of steps) if (s.screenshotUrl) urls.add(s.screenshotUrl);
  for (const j of journeys) if (j.videoUrl) urls.add(j.videoUrl);
  for (const r of runs) {
    if (r.transcriptUrl) urls.add(r.transcriptUrl);
    if (r.liveScreenshotUrl) urls.add(r.liveScreenshotUrl);
  }

  // Rows, bottom-up. Evidence rows are deleted by id, not by relation, so a
  // row attached to both a step and a finding goes exactly once.
  const evidenceIds = [...new Set(evidence.map((e) => e.id))];
  await eachChunk(evidenceIds, (ids) => db.evidence.deleteMany({ where: { id: { in: ids } } }));
  await eachChunk(stepIds, (ids) => db.step.deleteMany({ where: { id: { in: ids } } }));
  // Specs the agent formalised from these journeys (CHE-8): keyed by hostname
  // and by a plain journeyId. A spec of a preview hostname is nothing to keep.
  await eachChunk(journeyIds, (ids) => db.generatedTest.deleteMany({ where: { journeyId: { in: ids } } }));
  await eachChunk(journeyIds, (ids) => db.journey.deleteMany({ where: { id: { in: ids } } }));
  await eachChunk(findingIds, (ids) => db.finding.deleteMany({ where: { id: { in: ids } } }));
  await eachChunk(runIds, (ids) => db.llmUsage.deleteMany({ where: { runId: { in: ids } } }));
  await eachChunk(runIds, (ids) => db.createdResource.deleteMany({ where: { runId: { in: ids } } }));
  // The page snapshot the run took (CHE-132): a plain runId, no cascade.
  await eachChunk(runIds, (ids) => db.appSnapshot.deleteMany({ where: { runId: { in: ids } } }));
  // A paid check's parked row (src/lib/one-check.ts) points at its run by a
  // plain unique id. An ephemeral run is owned and never paid for, so this
  // finds nothing today; it is here so every `runId` column in the schema is
  // accounted for by mechanism (scripts/verify-ephemeral.ts derives the list
  // from prisma/schema.prisma). The row itself is the payment's record and
  // stays; only the pointer goes.
  await eachChunk(runIds, (ids) =>
    db.pendingCheck.updateMany({ where: { runId: { in: ids } }, data: { runId: null } }),
  );
  // CHE-239: a measurement point is DETACHED, not deleted. It belongs to the
  // journey, not to the run — it is a record of what the customer's own traffic
  // did on a given day, and it cost a query against their analytics to obtain.
  // The run that happened to ask is gone; what it learned is still true, and
  // deleting it would put a hole in a series whose whole value is continuity.
  // Same reasoning as verdicts, which are detached and never deleted.
  await eachChunk(runIds, (ids) =>
    db.journeyMetricPoint.updateMany({ where: { runId: { in: ids } }, data: { runId: null } }),
  );
  await eachChunk(runIds, (ids) => db.run.deleteMany({ ...systemWide("janitor"), where: { id: { in: ids } } }));

  // Not touched on purpose: Run.baselineRunId, Journey.carriedFromRunId,
  // IssueLink.firstSeenRunId and IssueLink.findingId in OTHER rows may now
  // point at a run or finding that is gone.
  // They are provenance ("diffed against", "walked by", "first claimed in"),
  // and nulling them would turn a true statement into a false one ("walked
  // this run", "first run of this watch"). Every reader looks the run up by id
  // and treats a missing row as absent (src/agent/replay.ts, partial.ts,
  // workflow.ts, reconcile.ts, capability-gaps.ts, the verdict page) — asserted
  // in scripts/verify-ephemeral.ts.

  // Objects: only those no surviving row still references.
  const candidates = [...urls].filter((u) => evidenceKey(u) !== null);
  if (candidates.length === 0 || !evidenceBucket) return { runs: runs.length, evidence: extensionKeys.size };

  const stillUsed = new Set<string>();
  await eachChunk(candidates, async (part) => {
    const [ev, st, jo, tr, live] = await Promise.all([
      db.evidence.findMany({ where: { storageUrl: { in: part } }, select: { storageUrl: true } }),
      db.step.findMany({ where: { screenshotUrl: { in: part } }, select: { screenshotUrl: true } }),
      db.journey.findMany({ where: { videoUrl: { in: part } }, select: { videoUrl: true } }),
      db.run.findMany({ ...systemWide("janitor"), where: { transcriptUrl: { in: part } }, select: { transcriptUrl: true } }),
      db.run.findMany({ ...systemWide("janitor"), where: { liveScreenshotUrl: { in: part } }, select: { liveScreenshotUrl: true } }),
    ]);
    for (const r of ev) stillUsed.add(r.storageUrl);
    for (const r of st) if (r.screenshotUrl) stillUsed.add(r.screenshotUrl);
    for (const r of jo) if (r.videoUrl) stillUsed.add(r.videoUrl);
    for (const r of tr) if (r.transcriptUrl) stillUsed.add(r.transcriptUrl);
    for (const r of live) if (r.liveScreenshotUrl) stillUsed.add(r.liveScreenshotUrl);
  });

  const keys = candidates
    .filter((u) => !stillUsed.has(u))
    .map((u) => evidenceKey(u))
    .filter((k): k is string => k !== null);
  // A screenshot's small copy (CHE-362) goes with it: no row points at the
  // copy, so nothing else would ever delete it. Counted with its original, not
  // on its own — it may never have been made.
  const thumbs = keys.map((k) => thumbKeyOf(k)).filter((k): k is string => k !== null);
  await deleteObjects(evidenceBucket, [...keys, ...thumbs]);

  return { runs: runs.length, evidence: new Set([...extensionKeys, ...keys]).size };
}
