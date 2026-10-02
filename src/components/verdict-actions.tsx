"use client";

import Link from "next/link";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { enableWatchAction, fullRecheckRunAction, recheckRunAction, retryFailedRunAction } from "@/app/verdict/actions";
import { track } from "@/lib/analytics";

// Verdict header/footer actions: enable Daily Watch (Loop B) and re-check now
// (Journey 7). Kept client-side so the report page itself stays a server render.

// CHE-75: same pre-hydration treatment as RecheckButton — a form around a
// server action, so an early click can't be silently swallowed. The action
// redirects: to /watch/{slug} on success, to sign-in for anonymous visitors,
// back here with ?watch_error=… when gated (the verdict page renders it).
export function EnableWatchButton({
  runId,
  hasWatch,
  appSlug,
  variant = "primary",
  back,
}: {
  runId: string;
  hasWatch: boolean;
  appSlug: string;
  variant?: "primary" | "outline";
  // CHE-371: inside the app, the check's own address — where a refusal is read.
  back?: string;
}) {
  if (hasWatch) {
    return (
      <Link
        href={`/watch/${appSlug}`}
        className="inline-flex items-center justify-center gap-2 rounded-lg border border-ink-600 bg-ink-850 px-4 py-2.5 text-sm text-fg transition-colors hover:border-ink-700 hover:bg-ink-800"
      >
        Watch settings
      </Link>
    );
  }

  return (
    // Recorded on the submit: the action redirects away, so the click is the
    // last moment this page can speak.
    <form action={back ? enableWatchAction.bind(null, runId, back) : enableWatchAction.bind(null, runId)} onSubmit={() => track("watch_enabled", { appSlug })}>
      <EnableWatchSubmit variant={variant} />
    </form>
  );
}

function EnableWatchSubmit({ variant }: { variant: "primary" | "outline" }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending}>
      {pending ? "Enabling…" : "Enable Daily Watch"}
    </Button>
  );
}

// A <form> around a server action, not an onClick (CHE-73): the old handler
// attached only after hydration, so an early click was silently swallowed —
// the exact pre-hydration failure this product flags on other people's apps.
// A native form submit works from the first paint.
//
// CHE-137 (owner, 2026-09-06): this is the product's "re-check after a
// deploy" — it re-walks what changed since the last check, and (CHE-327)
// spends the team's balance like any check. The click is recorded on submit:
// the action redirects away.
export function RecheckButton({ runId, appSlug, back }: { runId: string; appSlug: string; back?: string }) {
  return (
    <form
      action={back ? recheckRunAction.bind(null, runId, back) : recheckRunAction.bind(null, runId)}
      onSubmit={() => track("recheck_clicked", { kind: "regular", appSlug })}
    >
      <RecheckSubmit label="Re-check after a deploy" title="Re-walks what changed since the last check" />
    </form>
  );
}

// CHE-74: walk everything from scratch — carried journeys get re-verified
// instead of riding the partial-run carry forever. CHE-327: no separate
// allowance any more; a full walk spends the balance like any check, and
// costs more because it walks more — the tooltip says so up front.
export function FullRecheckButton({ runId, appSlug, back }: { runId: string; appSlug: string; back?: string }) {
  return (
    <form
      action={back ? fullRecheckRunAction.bind(null, runId, back) : fullRecheckRunAction.bind(null, runId)}
      onSubmit={() => track("recheck_clicked", { kind: "full", appSlug })}
    >
      <RecheckSubmit
        label="Full re-check"
        title="Walks every journey from scratch — it costs more than a regular re-check, which re-walks only what changed"
      />
    </form>
  );
}

// CHE-329: the one way forward from a check that didn't finish. Same form
// around a server action as RecheckButton, for the same pre-hydration reason.
// CHE-335: a paid check that signed in lost its password when it ended, so its
// owed re-check asks for it again. The account is not named: the run link is
// shareable, and its address is the customer's.
export function RetryFailedRunButton({
  runId,
  appSlug,
  needsPassword = false,
}: {
  runId: string;
  appSlug: string;
  needsPassword?: boolean;
}) {
  return (
    <form
      action={retryFailedRunAction.bind(null, runId)}
      onSubmit={() => track("recheck_clicked", { kind: "retry_failed", appSlug })}
      className="flex flex-col items-center gap-2"
    >
      {needsPassword && (
        <label className="flex w-full max-w-xs flex-col gap-1 text-left text-sm text-fg-muted">
          Password for the test account
          <input
            type="password"
            name="testPassword"
            required
            autoComplete="off"
            className="rounded-md border border-ink-600 bg-ink-850 px-3 py-2 text-fg"
          />
        </label>
      )}
      <RecheckSubmit label="Run it again" />
    </form>
  );
}

function RecheckSubmit({ label, title }: { label: string; title?: string }) {
  const { pending } = useFormStatus();
  return (
    <span title={title} className="inline-flex">
      <Button type="submit" variant="outline" disabled={pending} title={title}>
        {pending ? "Queuing…" : label}
      </Button>
    </span>
  );
}
