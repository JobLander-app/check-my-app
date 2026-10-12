import { notFound, redirect } from "next/navigation";
import { getDbFromContext } from "@/lib/db";
import { RunLive } from "@/components/run-live";
import { RunFailed } from "@/components/run-failed";
import { isTerminal } from "@/lib/status";
import { appLabel, isShopifyApp } from "@/lib/app-label";
import { failedRunWasFree } from "@/lib/failed-run";
import { canMutateOwned, getOptionalUser } from "@/lib/auth";
import { can, type TeamScope } from "@/lib/scopes";
import { unstoppableReason } from "@/lib/run-cancel";
import { paidRetryOwed } from "@/lib/recheck";
import { publicRow } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";

const STOPPED_CARD = "It was stopped before it finished. Nothing was published, and it costs nothing.";

// CHE-454: Stop is offered to whoever the server would let stop it — a member
// or an admin of the run's own team — on a check that can be stopped at all.
async function mayStopRun(
  db: Awaited<ReturnType<typeof getDbFromContext>>,
  run: { teamId: string | null; targetKind: string; app: { writeMode: string } | null },
): Promise<boolean> {
  const teamId = run.teamId;
  if (!teamId || unstoppableReason(run)) return false;
  const user = await getOptionalUser(db);
  if (!user) return false;
  const member = await db.membership.findFirst({ where: { teamId, userId: user.id }, select: { scope: true } });
  return Boolean(member) && can(member!.scope as TeamScope, "run.start");
}

// Screen 2 — In-progress · /run/{id}
export default async function RunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ recheck?: string; balance?: string }>;
}) {
  const prisma = await getDbFromContext();
  const run = await prisma.run.findUnique({ ...publicRow(),
    where: { publicId: (await params).id },
    select: {
      publicId: true,
      appSlug: true,
      targetKind: true,
      targetUrl: true,
      extensionEvidence: true,
      status: true,
      runNumber: true,
      startedAt: true,
      notifyEmail: true,
      ownerId: true,
      teamId: true,
      priceUsd: true,
      id: true,
      paidCheckoutSessionId: true,
      testEmail: true,
      // CHE-457: what the team calls the app, when the check is of a saved one.
      app: { select: { name: true, writeMode: true } },
    },
  });
  if (!run) notFound();

  // CHE-454: a stopped check has no verdict to jump to — it says so here.
  if (run.status === "canceled") {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <section className="card p-6">
          <h1 className="text-lg font-medium">This check was stopped</h1>
          <p className="mt-2 text-sm text-fg-muted">{STOPPED_CARD}</p>
        </section>
      </main>
    );
  }

  // If it already finished, jump straight to the verdict.
  if (isTerminal(run.status) && run.status !== "failed") {
    redirect(`/verdict/${run.publicId}`);
  }

  // CHE-329: a check that didn't finish. Rendered here, on the server, because
  // what it may say depends on the row — the price, and whether this viewer
  // may start another — and the live screen refreshes into it when a run
  // fails in front of someone.
  if (run.status === "failed") {
    const { recheck, balance } = await searchParams;
    const canRetry = await canMutateOwned(prisma, run.ownerId);
    const paidRetry = await paidRetryOwed(prisma, run);
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <RunFailed
          free={failedRunWasFree(run)}
          paidRetry={paidRetry}
          retry={
            canRetry
              ? { runId: run.publicId, appSlug: run.appSlug, needsPassword: paidRetry && Boolean(run.testEmail) }
              : null
          }
          notice={recheck === "notfound" ? "That run no longer exists." : (recheck ?? null)}
          balanceRefused={balance === "1" && typeof recheck === "string"}
        />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <RunLive
        publicId={run.publicId}
        appSlug={appLabel({ ...run, name: run.app?.name }, run.extensionEvidence)}
        isExtension={run.targetKind === "extension"}
        isShopify={isShopifyApp(run)}
        runNumber={run.runNumber}
        startedAt={run.startedAt.toISOString()}
        notifyEmail={run.notifyEmail}
        mayStop={await mayStopRun(prisma, run)}
      />
    </main>
  );
}
