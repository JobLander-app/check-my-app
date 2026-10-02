"use client";

import { useState } from "react";
import { track } from "@/lib/analytics";

// CHE-327: the top-up buttons on the dashboard's balance card. Each opens a
// Stripe Checkout payment for that amount (POST /api/billing/topup); the
// webhook credits it. Until billing is configured the API answers 503
// `billing_unconfigured` and the card says so quietly, like UpgradeCta.
export function TopUpCta({ amounts }: { amounts: readonly number[] }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function topUp(amountUsd: number) {
    track("topup_opened", { amountUsd });
    setBusy(amountUsd);
    setNote(null);
    const res = await fetch("/api/billing/topup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountUsd }),
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { url?: string; code?: string; error?: string } | null;
    if (res?.ok && body?.url) {
      window.location.assign(body.url);
      return; // keep the buttons disabled while the browser navigates
    }
    setBusy(null);
    setNote(
      body?.code === "billing_unconfigured"
        ? "Top-ups launch soon."
        : (body?.error ?? "Something went wrong — try again."),
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {amounts.map((a) => (
          <button
            key={a}
            type="button"
            disabled={busy !== null}
            onClick={() => topUp(a)}
            className="rounded-md border border-ink-600 bg-ink-850 px-3 py-1.5 font-mono text-xs text-fg transition-colors hover:border-fg-faint hover:bg-ink-800 disabled:opacity-60"
          >
            {busy === a ? "Redirecting…" : `Top up $${a}`}
          </button>
        ))}
      </div>
      {note && <p className="font-mono text-xs text-fg-faint">{note}</p>}
    </div>
  );
}
