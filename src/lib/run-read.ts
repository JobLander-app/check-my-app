// A run's status and its structured verdict — the payloads behind
// GET /api/runs/{id} and GET /api/runs/{id}/verdict, and behind the MCP tools
// get_check_status / get_verdict / wait_for_run (CHE-315).
//
// One shape for both doors on purpose: the stdio MCP server used to read these
// routes over HTTP, and an agent moving to the remote server must get the same
// fields it got before, not a re-derivation that drifted.
//
// Visibility is the CALLER's decision, not this file's: the routes address a
// run by its unguessable publicId (CHE-33); MCP first checks the run belongs to
// the key's team and only then reads it through here.

import type { PrismaClient } from "@/generated/prisma/client";
import { parseJson } from "@/lib/json";
import type { RunEvent } from "@/lib/types";
import { extensionReportPublished, publicRunError } from "@/lib/extension-target";
import { publicRow } from "@/lib/tenant-db";

export async function loadRunStatus(db: PrismaClient, publicId: string) {
  const run = await db.run.findUnique({ ...publicRow(),
    where: { publicId },
    select: {
      publicId: true,
      appSlug: true,
      targetUrl: true,
      targetKind: true,
      status: true,
      verdict: true,
      events: true,
      errorMessage: true,
      startedAt: true,
      completedAt: true,
    },
  });
  if (!run) return null;
  return { ...run, errorMessage: publicRunError(run.targetKind, run.errorMessage), events: parseJson<RunEvent[]>(run.events) };
}

export type RunStatusPayload = NonNullable<Awaited<ReturnType<typeof loadRunStatus>>>;

export async function loadVerdict(db: PrismaClient, publicId: string) {
  const run = await db.run.findUnique({ ...publicRow(),
    where: { publicId },
    include: {
      journeys: {
        orderBy: { order: "asc" },
        select: { title: true, status: true, summary: true, carriedFromRunId: true },
      },
      findings: {
        orderBy: { number: "asc" },
        select: { number: true, title: true, category: true, severity: true, mark: true },
      },
    },
  });
  if (!run) return null;
  if (!extensionReportPublished(run)) {
    return { status: run.status, verdict: null, bottom_line: null, journeys: [], findings: [] };
  }

  // CHE-331: every check lists the app's known journeys, and the ones it did
  // not walk are an earlier run's evidence. An agent reading this must be able
  // to tell them apart as the verdict page does — by the run that walked it and
  // when — or a days-old "ok" reads as today's.
  const carriedIds = [...new Set(run.journeys.map((j) => j.carriedFromRunId).filter((id): id is string => Boolean(id)))];
  const sources = carriedIds.length
    ? await db.run.findMany({ ...publicRow(),
        where: { id: { in: carriedIds } },
        select: { id: true, runNumber: true, completedAt: true },
      })
    : [];
  const sourceOf = new Map(sources.map((s) => [s.id, s]));
  const journeys = run.journeys.map(({ carriedFromRunId, ...j }) => {
    const source = carriedFromRunId ? sourceOf.get(carriedFromRunId) : undefined;
    return {
      ...j,
      carried_from: carriedFromRunId
        ? { run_number: source?.runNumber ?? null, walked_at: source?.completedAt ?? null }
        : null,
    };
  });

  return {
    run_number: run.runNumber,
    app: run.appSlug,
    status: run.status,
    verdict: run.verdict,
    // Deploy identity (CHE-56): null when the run wasn't tied to a build, so a
    // CI gate can tell "not a deploy check" from "a deploy check that passed".
    deploy: run.deploySha ? { sha: run.deploySha, env: run.deployEnv } : null,
    bottom_line: run.bottomLine,
    // CHE-202: a preview run says when it will be gone; null on every other run.
    ephemeral: run.ephemeral,
    expires_at: run.expiresAt,
    journeys,
    findings: run.findings,
    // Pricing rule (CLAUDE.md §10): what a check cost US — dollars, tokens,
    // the multiplier — never leaves in anything a customer or their agent
    // reads. This payload is public by run id. The customer's price for a
    // check arrives with CHE-327.
    completed_at: run.completedAt,
  };
}

export type VerdictPayload = NonNullable<Awaited<ReturnType<typeof loadVerdict>>>;
