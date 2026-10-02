"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

// CHE-277: opens Stripe's own billing portal for the team.
//
// The route answers 409 when the team has no subscription yet and 503 when
// billing is not configured, and both of those are sentences a person can act
// on — so they are shown rather than swallowed. A button that appears to do
// nothing is the defect this product flags on other people's apps.
export function ManageBillingButton() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function open() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (res.ok && body?.url) {
        window.location.href = body.url;
        return;
      }
      setError(body?.error ?? `Could not open billing (${res.status}).`);
    } catch {
      setError("Could not reach billing just now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4">
      <Button type="button" variant="outline" onClick={open} disabled={busy}>
        {busy ? "Opening…" : "Manage billing"}
      </Button>
      {error && <p className="mt-2 text-sm text-status-broken">{error}</p>}
    </div>
  );
}
