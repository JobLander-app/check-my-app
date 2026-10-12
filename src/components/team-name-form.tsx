"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { renameTeamAction } from "@/app/team/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// CHE-446: the team's name, set by its admin. Everyone on the team sees it in
// the switcher and on invitations; only an admin is shown this form.
export function TeamNameForm({ name }: { name: string }) {
  const [state, formAction] = useActionState(renameTeamAction, null);
  return (
    <section className="card mb-6 p-6">
      <h2 className="text-lg font-medium">Team name</h2>
      <p className="mt-1 text-sm text-fg-muted">What everyone on the team sees, and what invitations say.</p>
      <form action={formAction} className="mt-4 flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 basis-64">
          <span className="sr-only">Team name</span>
          {/* No maxLength: HTML counts UTF-16 units, the server counts characters
              (TEAM_NAME_MAX) — the server's sentence says when it is too long. */}
          <Input name="name" defaultValue={state?.saved ?? name} required autoComplete="organization" />
        </label>
        <SaveButton />
      </form>
      {state?.error && <p className="mt-2 text-sm text-status-broken">{state.error}</p>}
      {state?.saved && <p className="mt-2 text-sm text-fg-muted">Saved.</p>}
    </section>
  );
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving…" : "Save"}
    </Button>
  );
}
