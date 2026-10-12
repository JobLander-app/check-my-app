"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { removeTeamByokAction, setTeamByokAction } from "@/app/team/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ONLY_ADMINS, keyStatusLine, type StoredKey } from "@/lib/byok-copy";

// CHE-448: the team's own OpenRouter key. Admins add, replace and remove it;
// everyone else on the team sees whether there is one. The browser only ever
// gets the masked form — the key itself stays on the server. A key that can no
// longer be read is said to be unusable, never shown as working.
export function TeamModelKey({ stored, mayManage }: { stored: StoredKey; mayManage: boolean }) {
  const [state, formAction] = useActionState(setTeamByokAction, null);
  const status = keyStatusLine(stored);

  return (
    <section className="card mt-6 p-6">
      <h2 className="text-lg font-medium">Model key (OpenRouter)</h2>
      <p className={`mt-1 text-sm ${status.tone === "broken" ? "text-status-broken" : "text-fg-muted"}`}>{status.text}</p>

      {mayManage ? (
        <>
          <form action={formAction} className="mt-4 flex flex-wrap items-end gap-3">
            <label className="min-w-0 flex-1 basis-64">
              <span className="text-xs text-fg-muted">{stored ? "Replace with another key" : "OpenRouter API key"}</span>
              <Input name="key" type="password" autoComplete="off" spellCheck={false} required className="mt-1" placeholder="sk-or-v1-…" />
            </label>
            <SaveButton replacing={Boolean(stored)} />
          </form>
          {state?.error && <p className="mt-2 text-sm text-status-broken">{state.error}</p>}
          {state?.saved && <p className="mt-2 text-sm text-fg-muted">Saved. New checks run on {state.saved}.</p>}
          {stored && (
            <form action={removeTeamByokAction} className="mt-4">
              <Button type="submit" variant="outline" className="py-1.5">Remove key</Button>
            </form>
          )}
          <p className="mt-4 text-xs text-fg-muted">
            Create one at openrouter.ai/keys. A check that has already started keeps the key it started with.
          </p>
        </>
      ) : (
        <p className="mt-4 text-xs text-fg-muted">{ONLY_ADMINS}</p>
      )}
    </section>
  );
}

function SaveButton({ replacing }: { replacing: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Checking with OpenRouter…" : replacing ? "Replace" : "Save key"}
    </Button>
  );
}
