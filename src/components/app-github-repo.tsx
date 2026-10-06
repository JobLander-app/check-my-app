import Link from "next/link";
import { APP_GITHUB_COPY as COPY, OFFERED_POLICIES, POLICY_LABELS, repoStatusLine } from "@/lib/github-mapping";
import type { OfferedPolicy } from "@/lib/github-mapping";
import { setAppGitHubRepo } from "@/app/dashboard/actions";

// Which repository deploys this app, and whether its deploys are checked —
// on the app's Integrations section, where each integration's app-specific
// setting lives. The team-wide connection is on /settings/integrations; this
// component assumes the team has done that already (or tells the owner so).
// One repository per app: setting one clears any other that pointed here.
//
// Server component, plain form posting to a server action — it works before
// any script loads. Every sentence comes from src/lib/github-mapping.ts.
export function AppGitHubRepo({
  appId,
  appSlug,
  github,
  canConnect,
}: {
  appId: string;
  appSlug: string;
  github: { installed: boolean; repos: Array<{ id: string; repoFullName: string; appId: string | null }>; current: { repoId: string; policy: OfferedPolicy } | null; priceLine: string };
  canConnect: boolean;
}) {
  return (
    <section className="card space-y-3 p-5">
      <div>
        <p className="text-sm font-medium text-fg">
          {COPY.title} <span className="text-xs font-normal text-fg-faint">· {COPY.tagline}</span>
        </p>
      </div>
      {!github.installed ? (
        <p className="text-xs text-fg-faint">
          {COPY.notInstalled}{" "}
          <Link href="/settings/integrations" className="text-accent hover:underline">
            {COPY.connectLink}
          </Link>
        </p>
      ) : (
        <form action={setAppGitHubRepo.bind(null, appId)} className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <label className="sr-only" htmlFor={`repo-${appId}`}>
            {COPY.repoLabel}
          </label>
          <select
            id={`repo-${appId}`}
            name="repoId"
            defaultValue={github.current?.repoId ?? ""}
            disabled={!canConnect}
            className="min-w-0 max-w-full rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5 text-xs text-fg"
          >
            <option value="">{COPY.none}</option>
            {github.repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.repoFullName}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor={`policy-${appId}`}>
            {COPY.policyLabel}
          </label>
          <select
            id={`policy-${appId}`}
            name="policy"
            defaultValue={github.current?.policy ?? "production"}
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
              {COPY.save}
            </button>
          )}
          <span className="basis-full text-xs text-fg-faint">
            {repoStatusLine({ appSlug: github.current ? appSlug : null, priceLine: github.priceLine, policy: github.current?.policy ?? "production", suspended: false })}
          </span>
        </form>
      )}
    </section>
  );
}
