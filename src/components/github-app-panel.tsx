import Link from "next/link";
import type { TeamGitHub } from "@/lib/github-mapping";
import { OFFERED_POLICIES, POLICY_LABELS } from "@/lib/github-mapping";
import { setGitHubRepo } from "@/app/(app)/settings/integrations/actions";

// The GitHub App on Integrations (CHE-369): install it once, then say which
// app each repository deploys. From then on every successful production
// deploy of that repository is checked and answered on the commit — no YAML.
// The price of a check sits next to the switch that turns it on.
//
// Server component; each row is a plain form posting to a server action, so
// it works before any script loads. One row per repository, wrapping on a
// phone — no table that scrolls sideways.
export function GitHubAppPanel({
  github,
  canConnect,
  installable,
}: {
  github: TeamGitHub;
  canConnect: boolean;
  installable: boolean;
}) {
  const installed = github.installations.length > 0;
  return (
    <section id="github" className="card space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64 space-y-1">
          <p className="text-sm font-medium text-fg">
            GitHub App <span className="text-xs font-normal text-fg-faint">· every deploy checked, no YAML</span>
          </p>
          <p className="text-xs text-fg-muted">
            {installed
              ? "Choose which app each repository deploys. A successful production deploy of it starts a check of that app, and the verdict appears on the commit."
              : "Install it on the GitHub account your apps deploy from. Each successful production deploy is then checked, and the verdict appears on the commit."}
          </p>
        </div>
        {canConnect && installable && (
          <Link
            href="/api/integrations/github/app/start"
            prefetch={false}
            className="shrink-0 rounded-lg border border-ink-600 px-3 py-1.5 font-mono text-xs text-fg-muted transition-colors hover:border-fg-faint hover:text-fg"
          >
            {installed ? "Add an account →" : "Install →"}
          </Link>
        )}
      </div>

      {!installable && !installed && <p className="text-xs text-fg-faint">The GitHub App isn&apos;t available yet.</p>}
      {installable && !canConnect && !installed && <p className="text-xs text-fg-faint">An admin of the team installs it.</p>}

      {github.installations.map((inst) => (
        <div key={inst.id} className="space-y-2">
          <p className="font-mono text-xs text-fg-faint">
            {inst.accountLogin}
            {inst.suspended && <span className="text-status-risky"> · suspended on GitHub — nothing is checked</span>}
          </p>
          {inst.repos.length === 0 ? (
            <p className="text-xs text-fg-faint">No repositories yet — choose them in the App&apos;s settings on GitHub.</p>
          ) : (
            <ul className="divide-y divide-ink-700">
              {inst.repos.map((repo) => {
                const app = github.apps.find((a) => a.id === repo.appId) ?? null;
                return (
                  <li key={repo.id} className="py-3">
                    <form action={setGitHubRepo} className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <input type="hidden" name="repoId" value={repo.id} />
                      <span className="min-w-0 flex-1 basis-48 break-all font-mono text-sm text-fg">{repo.repoFullName}</span>
                      <label className="sr-only" htmlFor={`app-${repo.id}`}>
                        App this repository deploys
                      </label>
                      <select
                        id={`app-${repo.id}`}
                        name="appId"
                        defaultValue={repo.appId ?? ""}
                        disabled={!canConnect}
                        className="min-w-0 max-w-full rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5 text-xs text-fg"
                      >
                        <option value="">Not an app here</option>
                        {github.apps.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.appSlug}
                          </option>
                        ))}
                      </select>
                      <label className="sr-only" htmlFor={`policy-${repo.id}`}>
                        When its deploys are checked
                      </label>
                      <select
                        id={`policy-${repo.id}`}
                        name="policy"
                        defaultValue={repo.policy}
                        disabled={!canConnect}
                        className="min-w-0 max-w-full rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5 text-xs text-fg"
                      >
                        {OFFERED_POLICIES.map((p) => (
                          <option key={p} value={p}>
                            {POLICY_LABELS[p]}
                          </option>
                        ))}
                      </select>
                      {canConnect && (
                        <button
                          type="submit"
                          className="rounded-md border border-ink-600 px-2.5 py-1.5 font-mono text-xs text-fg-muted transition-colors hover:border-fg-faint hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                        >
                          Save
                        </button>
                      )}
                      <span className="basis-full text-xs text-fg-faint">
                        {app && repo.policy === "production"
                          ? `Checked on every production deploy — ${app.priceLine}.`
                          : app
                            ? `Deploys of ${app.appSlug} are not checked.`
                            : "Not mapped — its deploys start nothing."}
                      </span>
                    </form>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}
