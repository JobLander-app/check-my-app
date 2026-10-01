// Which PostHog project holds this app's data, as the owner sees it (CHE-237).
//
// The screen has one job: make the question short enough to answer once. So the
// suggestion, when there is one, says WHY it is the suggestion — "we see
// checkmyapp.dev in this project" — because a recommendation whose reasoning is
// invisible is one the owner has to verify themselves, which is the work we
// were trying to save.
//
// Four states, and none of them nag:
//   - no connection      → one sentence, no call to action beyond a quiet link;
//   - connected, unset   → the list, suggestion first;
//   - connected, chosen  → what it is, with a way to change or clear it;
//   - connection broken  → what we could not do, in the owner's terms (rule 2).

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { setAppPosthogProject } from "@/app/dashboard/actions";
import type { ProjectChoices } from "@/lib/posthog/choices";

/** What the dropdown opens on: the stored choice, else the suggestion, else
 *  nothing. Never a project the owner has not been shown a reason for. */
function selectedValue(
  chosen: { id: string; name: string | null } | null,
  choices: ProjectChoices,
): string {
  if (choices.kind !== "ready") return "";
  const id = chosen?.id ?? choices.suggested?.id;
  if (!id) return "";
  const known = choices.projects.find((p) => p.id === id);
  // A stored project that is no longer in the account: show "none" rather than
  // a value the list cannot explain. The line above still says what we read.
  return known ? `${known.id}:${known.name}` : "";
}

export function AnalyticsProject({
  appId,
  chosen,
  choices,
}: {
  appId: string;
  chosen: { id: string; name: string | null } | null;
  choices: ProjectChoices;
}) {
  return (
    <section className="mt-12 space-y-4">
      <div>
        <p className="section-label">product metrics</p>
        <p className="mt-1 text-sm text-fg-muted">
          Which PostHog project holds this app&apos;s data. Asked once.
        </p>
        {/* The explanation the dashboard dropdown used to carry in an option
            label. A dropdown is not where anyone learns a concept, and "use our
            estimate" read as the reader's own estimate rather than ours. Here
            there is room to say it properly (owner, 2026-09-17). */}
        <p className="mt-1 text-sm text-fg-faint">
          With a project, a check can say how many people actually finish each journey. Without
          one, that number stays a judgement we formed by walking the app — never a count of your
          users.
        </p>
      </div>

      <div className="card space-y-3 p-4">
        {choices.kind === "not-connected" ? (
          <p className="text-sm text-fg-faint">
            No analytics connected. Checks still run — they use our own estimate of what a journey
            is worth.{" "}
            <Link href="/dashboard" className="text-accent hover:underline">
              Connect PostHog
            </Link>{" "}
            to use your real numbers instead.
          </p>
        ) : choices.kind === "unavailable" ? (
          // Rule 2: what we could not do is ours to say, not theirs to infer
          // from an empty list.
          <p className="text-sm text-status-confusing">
            We couldn&apos;t list your PostHog projects — {choices.reason}.
          </p>
        ) : (
          <form action={setAppPosthogProject.bind(null, appId)} className="space-y-3">
            {chosen?.id && (
              <p className="text-sm text-fg">
                <span className="text-status-ok">✓</span> Reading{" "}
                <span className="font-mono">{chosen.name ?? `Project ${chosen.id}`}</span>
              </p>
            )}

            <label className="block space-y-1">
              <span className="text-xs text-fg-muted">
                {chosen?.id ? "Change project" : "Project"}
              </span>
              {/* id and name travel together in one value, so the label stored
                  is the one the owner was looking at when they chose. A hidden
                  field cannot follow a <select> without client JS, and a
                  server-side re-lookup could disagree with what was on screen. */}
              <select
                name="posthogProject"
                defaultValue={selectedValue(chosen, choices)}
                className="w-full rounded-md border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-[13px] text-fg"
              >
                <option value="">— none: keep our own estimate —</option>
                {choices.projects.map((p) => (
                  <option key={p.id} value={`${p.id}:${p.name}`}>
                    {p.name}
                    {p.match === "exact" && p.matchedHost ? ` · we see ${p.matchedHost} here` : ""}
                    {p.match === "same-domain" && p.matchedHost ? ` · same domain as ${p.matchedHost}` : ""}
                  </option>
                ))}
              </select>
            </label>

            {choices.suggested && !chosen?.id && (
              <p className="text-xs text-fg-faint">
                Suggested because this project has recently received events from{" "}
                <span className="font-mono">{choices.suggested.matchedHost}</span>.
              </p>
            )}
            {!choices.probed && (
              <p className="text-xs text-fg-faint">
                Too many projects to guess from — pick the one holding this app&apos;s data.
              </p>
            )}
            {choices.probed && !choices.suggested && !chosen?.id && choices.projects.length > 0 && (
              <p className="text-xs text-fg-faint">
                We couldn&apos;t tell which project this app reports to, so nothing is preselected.
              </p>
            )}
            {choices.projects.length === 0 && (
              <p className="text-xs text-fg-faint">This PostHog account has no projects yet.</p>
            )}

            <Button type="submit" variant="outline" className="px-3 py-1.5 text-xs">
              Save project
            </Button>
          </form>
        )}
      </div>
    </section>
  );
}
