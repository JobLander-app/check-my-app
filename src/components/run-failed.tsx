import Link from "next/link";
import { FAILED_RUN_LINE, PAID_RETRY_LINE } from "@/lib/failed-run";
import { RetryFailedRunButton } from "@/components/verdict-actions";

// CHE-329: what /run/{id} shows for a check that didn't finish. It replaced a
// card that printed the provider's raw error and promised "an email with a
// retry link" that was never sent: one plain sentence, the price when we can
// state it, and the one thing to do next. Why it failed is ours, and is on our
// board (src/agent/run-failures.ts) — not here.
//
// No hooks, so the server page renders it with everything it knows, and the
// live screen renders it bare in the moment before its refresh lands.
export function RunFailed({
  free,
  paidRetry = false,
  retry,
  notice = null,
  balanceRefused = false,
}: {
  // failedRunWasFree (src/lib/failed-run.ts): true only where it is a fact.
  free: boolean;
  // CHE-335: a $1 check whose one re-check is still owed (paidRetryOwed).
  paidRetry?: boolean;
  // Offered only to a viewer the re-check would accept (canMutateOwned).
  // needsPassword: the owed re-check of a signed-in paid check asks for its
  // password again (CHE-335).
  retry: { runId: string; appSlug: string; needsPassword?: boolean } | null;
  // A refused "Run it again", bounced back as text (retryFailedRunAction).
  notice?: string | null;
  balanceRefused?: boolean;
}) {
  return (
    <div className="card mx-auto max-w-xl space-y-3 p-8 text-center">
      <p className="text-2xl">◌</p>
      <p className="text-lg font-medium">{FAILED_RUN_LINE}</p>
      {free && <p className="text-sm text-fg-muted">It wasn&apos;t charged.</p>}
      {paidRetry && retry && <p className="text-sm text-fg-muted">{PAID_RETRY_LINE}</p>}
      {retry && (
        <div className="flex justify-center pt-1">
          <RetryFailedRunButton runId={retry.runId} appSlug={retry.appSlug} needsPassword={retry.needsPassword} />
        </div>
      )}
      {notice && (
        <p className="rounded-md border border-ink-600 bg-ink-800/60 px-3 py-2 text-sm text-fg-muted">
          {notice}
          {/* CHE-327: an empty balance is never met without its two doors. */}
          {balanceRefused && (
            <>
              {" "}
              <Link href="/settings/billing" className="text-accent hover:underline">
                Top up
              </Link>{" "}
              ·{" "}
              <Link href="/pricing" className="text-accent hover:underline">
                Upgrade
              </Link>
            </>
          )}
        </p>
      )}
    </div>
  );
}
