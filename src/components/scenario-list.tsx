"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  addScenarioAction,
  removeScenarioAction,
  replaceScenarioAction,
  updateScenarioAction,
  type ScenarioFormState,
} from "@/app/scenarios/actions";
import type { ScenarioView } from "@/lib/scenarios";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

// CHE-435: what this app's checks look at, edited by the team. A daily scenario
// is in every check; the rest only in a check that names it.
export function ScenarioList({ appId, scenarios, mayEdit }: { appId: string; scenarios: ScenarioView[]; mayEdit: boolean }) {
  return (
    <section className="card space-y-3 p-5">
      <div>
        <p className="text-sm font-medium text-fg">Scenarios</p>
        <p className="text-xs text-fg-faint">
          What every check walks and reports on. The check finds most of them; add your own in your words, or replace one
          the check got wrong.
        </p>
      </div>
      {scenarios.length === 0 ? (
        <p className="text-sm text-fg-muted">None yet. The first check maps the app and lists what it finds here.</p>
      ) : (
        <ul className="divide-y divide-ink-800">
          {scenarios.map((s) => (
            <li key={s.id} className="space-y-1.5 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm text-fg">{s.title}</span>
                <span className="text-xs text-fg-faint">
                  {s.source === "team" ? "written by your team" : "found by the check"} · {s.daily ? "every check" : "only when asked"}
                  {s.status ? ` · last: ${s.status}` : ""}
                </span>
              </div>
              {s.description && <p className="text-xs text-fg-muted">{s.description}</p>}
              {mayEdit && <Edit appId={appId} scenario={s} />}
            </li>
          ))}
        </ul>
      )}
      {mayEdit && <Add appId={appId} />}
    </section>
  );
}

function Fields({ title, description, daily, withTitle = true }: { title?: string; description?: string | null; daily: boolean; withTitle?: boolean }) {
  return (
    <>
      {withTitle && <Input name="title" required minLength={3} maxLength={120} defaultValue={title ?? ""} placeholder="Block a country" />}
      <Textarea
        name="description"
        rows={2}
        maxLength={1000}
        defaultValue={description ?? ""}
        placeholder="What a user does and what should happen, e.g. Add Germany in Block Countries; a visitor from Germany sees the block page."
        className="text-sm"
      />
      <label className="flex items-center gap-2 text-sm text-fg">
        <input type="checkbox" name="daily" defaultChecked={daily} className="h-4 w-4 rounded border-ink-600 bg-ink-900" />
        Check it every time
      </label>
    </>
  );
}

function Add({ appId }: { appId: string }) {
  const [state, action] = useActionState(addScenarioAction.bind(null, appId), null);
  return (
    <details className="rounded-lg border border-ink-700 px-3 py-2">
      <summary className="cursor-pointer text-sm text-accent">+ Add a scenario</summary>
      <form action={action} className="mt-3 flex flex-col gap-2">
        <Fields daily />
        <Footer state={state} label="Add scenario" />
      </form>
    </details>
  );
}

function Edit({ appId, scenario: s }: { appId: string; scenario: ScenarioView }) {
  const [state, update] = useActionState(updateScenarioAction.bind(null, appId, s.id), null);
  const [replaced, replace] = useActionState(replaceScenarioAction.bind(null, appId, s.id), null);
  return (
    <div className="flex flex-wrap gap-2">
      <details className="min-w-0 flex-1 basis-64 rounded-lg border border-ink-700 px-3 py-1.5">
        <summary className="cursor-pointer text-xs text-fg-muted">Edit</summary>
        <form action={update} className="mt-2 flex flex-col gap-2">
          <Fields title={s.title} description={s.description} daily={s.daily} withTitle={s.source === "team"} />
          <Footer state={state} label="Save" />
        </form>
      </details>
      {s.source === "team" ? (
        <form action={removeScenarioAction.bind(null, appId, s.id)}>
          <Button type="submit" variant="outline" className="py-1 text-xs">Remove</Button>
        </form>
      ) : (
        <details className="min-w-0 flex-1 basis-64 rounded-lg border border-ink-700 px-3 py-1.5">
          <summary className="cursor-pointer text-xs text-fg-muted">It is really a different scenario</summary>
          <form action={replace} className="mt-2 flex flex-col gap-2">
            <Fields daily={s.daily} />
            <Footer state={replaced} label="Replace" />
          </form>
        </details>
      )}
    </div>
  );
}

function Footer({ state, label }: { state: ScenarioFormState; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <Submit label={label} />
      {state?.error && <span className="text-sm text-status-broken">{state.error}</span>}
      {state?.saved && <span className="text-sm text-fg-muted">Saved. The next check uses it.</span>}
    </div>
  );
}

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" className="py-1.5" disabled={pending}>
      {pending ? "Saving…" : label}
    </Button>
  );
}
