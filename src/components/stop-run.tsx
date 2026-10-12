"use client";

import { useState, useTransition } from "react";
import { stopRunAction } from "@/app/run/actions";
import { Button } from "@/components/ui/button";

// CHE-454: stop a check that should not run on. Two presses, on the page — a
// misclick must not end a check someone is waiting for. The live screen moves
// to the stopped card when the stream says the run ended.
export function StopRun({ publicId }: { publicId: string }) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!asking) {
    return (
      <Button type="button" variant="outline" className="py-1.5 text-xs" onClick={() => setAsking(true)}>
        Stop this check
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-fg-muted">Stop it now? Nothing is published and it costs nothing.</span>
      <Button
        type="button"
        className="py-1.5 text-xs"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await stopRunAction(publicId);
            if (result?.error) setError(result.error);
          })
        }
      >
        {pending ? "Stopping…" : "Stop"}
      </Button>
      <Button type="button" variant="outline" className="py-1.5 text-xs" disabled={pending} onClick={() => setAsking(false)}>
        Keep it running
      </Button>
      {error && <span className="w-full text-status-broken">{error}</span>}
    </div>
  );
}
