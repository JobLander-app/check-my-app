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
      journeys: { orderBy: { order: "asc" }, select: { title: true, status: true, summary: true } },
      findings: {
        orderBy: { number: "asc" },
        select: { number: true, title: true, category: true, severity: true, mark: true },
      },
      llmUsage: true,
    },
  });
  if (!run) return null;
  if (!extensionReportPublished(run)) {
    return { status: run.status, verdict: null, bottom_line: null, journeys: [], findings: [] };
  }

  const totalTokens = run.llmUsage.reduce(
    (s, u) => s + u.inputTokens + u.cacheWriteTokens + u.cacheReadTokens + u.outputTokens,
    0,
  );

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
    journeys: run.journeys,
    findings: run.findings,
    cost_usd: run.costUsd,
    total_tokens: totalTokens || null,
    completed_at: run.completedAt,
  };
}

export type VerdictPayload = NonNullable<Awaited<ReturnType<typeof loadVerdict>>>;
