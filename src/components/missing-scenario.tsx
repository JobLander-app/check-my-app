"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { addScenarioAction } from "@/app/scenarios/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

// CHE-434 (6) / CHE-435: "the check did not pick up a scenario" — said where
// the reader sees what the check walked, and added to the app's list.
export function MissingScenario({ appId }: { appId: string }) {
  const [state, action] = useActionState(addScenarioAction.bind(null, appId), null);
  return (
    <details className="rounded-lg border border-ink-700 bg-ink-850/40 px-3 py-2">
      <summary className="cursor-pointer text-sm text-accent">+ A scenario the check missed?</summary>
      <form action={action} className="mt-3 flex flex-col gap-2">
        <Input name="title" required minLength={3} maxLength={120} placeholder="Block a country" />
        <Textarea
          name="description"
          rows={2}
          maxLength={1000}
          placeholder="What a user does and what should happen"
          className="text-sm"
        />
        <label className="flex items-center gap-2 text-sm text-fg">
          <input type="checkbox" name="daily" defaultChecked className="h-4 w-4 rounded border-ink-600 bg-ink-900" />
          Check it every time
        </label>
        <div className="flex items-center gap-3">
          <Submit />
          {state?.error && <span className="text-sm text-status-broken">{state.error}</span>}
          {state?.saved && <span className="text-sm text-fg-muted">Added to this app&apos;s scenarios. The next check walks it.</span>}
        </div>
      </form>
    </details>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" className="py-1.5" disabled={pending}>
      {pending ? "Adding…" : "Add scenario"}
    </Button>
  );
}
