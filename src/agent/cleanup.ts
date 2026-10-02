// Cleanup audit for CRUD lifecycle checking (CHE-90).
//
// Owner rule, 2026-08-28: a check that creates something must end by deleting
// it. The promise cannot live in a prompt — a crashed journey, a retried step
// or a model that simply forgets would leave real junk in a customer's product
// (our own self-check left a live app and a daily watch on your-app.com, $1.10
// burned before anyone noticed). So creations are ledgered the moment they
// happen and this audit runs at the end of EVERY run.
//
// What survives the audit is never swept under the rug. It is:
//   1. said out loud in the run feed, with where to find it;
//   2. surfaced to the owner as a finding — they must be able to delete it by
//      hand if we could not;
//   3. classified as OUR defect (rule §2) — an orphan means our lifecycle
//      handling failed, whatever the product did.

import type { AgentEnv } from "./env";
import { findingSignature, OUR_LEFTOVERS_WHERE } from "@/lib/finding-signature";

export interface CleanupNote {
  icon: "ok" | "warn";
  text: string;
}

export interface OrphanSummary {
  fromThisRun: number;
  older: number;
  lines: string[];
}

// Everything this run created and did not remove, plus anything an earlier run
// of the same app left behind (a crashed run never reaches its own audit).
export async function findOrphans(env: AgentEnv, runId: string): Promise<OrphanSummary> {
  const run = await env.db.run.findUnique({
    where: { id: runId },
    select: { appId: true, runNumber: true },
  });

  const mine = await env.db.createdResource.findMany({
    where: { runId, deletedAt: null },
    select: { kind: true, marker: true, locationUrl: true, cleanupNote: true },
  });

  const older = run?.appId
    ? await env.db.createdResource.findMany({
        where: { appId: run.appId, deletedAt: null, runId: { not: runId } },
        select: { kind: true, marker: true, locationUrl: true, cleanupNote: true },
        take: 20,
      })
    : [];

  const lines = [...mine, ...older].map(
    (r) =>
      `${r.kind} "${r.marker}"${r.locationUrl ? ` — ${r.locationUrl}` : ""}` +
      `${r.cleanupNote ? ` (${r.cleanupNote})` : ""}`,
  );
  return { fromThisRun: mine.length, older: older.length, lines };
}

export async function auditCreatedResources(env: AgentEnv, runId: string): Promise<CleanupNote[]> {
  const created = await env.db.createdResource.count({ where: { runId } });
  if (created === 0) return [];

  const orphans = await findOrphans(env, runId);
  const total = orphans.fromThisRun + orphans.older;

  if (total === 0) {
    return [
      {
        icon: "ok",
        text: `Cleaned up after ourselves: ${created} test record${created === 1 ? "" : "s"} created and removed`,
      },
    ];
  }

  // A finding, so it reaches the owner on the verdict page and not only in the
  // live feed — they may have to remove it by hand.
  const run = await env.db.run.findUnique({ where: { id: runId }, select: { appSlug: true } });
  const nextNumber =
    ((await env.db.finding.findFirst({
      where: { runId },
      orderBy: { number: "desc" },
      select: { number: true },
    })) ?? { number: 0 }).number + 1;

  const finding = {
    title: `Test records we created are still in your ${run?.appSlug ?? "app"}`,
    category: "risky",
    severity: "medium",
    detail: JSON.stringify({
      where: OUR_LEFTOVERS_WHERE,
      whatWeTried: orphans.lines.slice(0, 10),
      whatHappened:
        `${total} record${total === 1 ? "" : "s"} created for this check ${total === 1 ? "was" : "were"} ` +
        `not removed again. Everything we create carries a "CheckMyApp test" marker, so they are easy to spot.`,
      whyItMatters:
        "We clean up after every check — these slipped through, and we are fixing that on our side. " +
        "Until then you can delete them safely: nothing carrying our marker is real data of yours.",
    }),
  };
  await env.db.finding.create({
    data: {
      runId,
      number: nextNumber,
      ...finding,
      // CHE-354: the identity recurrence is counted by (src/lib/recurring.ts).
      signature: run ? findingSignature({ appSlug: run.appSlug, ...finding }) : null,
    },
  });

  return [
    {
      icon: "warn",
      text:
        `${total} test record${total === 1 ? "" : "s"} we created ${total === 1 ? "is" : "are"} still in the app ` +
        `— listed in the verdict, and filed against us`,
    },
  ];
}
