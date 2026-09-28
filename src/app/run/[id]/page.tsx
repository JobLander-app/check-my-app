import { notFound, redirect } from "next/navigation";
import { getDbFromContext } from "@/lib/db";
import { RunLive } from "@/components/run-live";
import { RunFailed } from "@/components/run-failed";
import { isTerminal } from "@/lib/status";
import { extensionDisplayName } from "@/lib/extension-target";
import { failedRunWasFree } from "@/lib/failed-run";
import { canMutateOwned } from "@/lib/auth";
import { paidRetryOwed } from "@/lib/recheck";
import { publicRow } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";

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
    },
  });
  if (!run) notFound();

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
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <RunFailed
          free={failedRunWasFree(run)}
          paidRetry={await paidRetryOwed(prisma, run)}
          retry={canRetry ? { runId: run.publicId, appSlug: run.appSlug } : null}
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
        appSlug={run.targetKind === "extension" ? extensionDisplayName(run.targetUrl, run.extensionEvidence) : run.appSlug}
        isExtension={run.targetKind === "extension"}
        runNumber={run.runNumber}
        startedAt={run.startedAt.toISOString()}
        notifyEmail={run.notifyEmail}
      />
    </main>
  );
}
