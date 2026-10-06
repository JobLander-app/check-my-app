import Link from "next/link";
import type { TeamGitHub } from "@/lib/github-mapping";
import { GITHUB_PANEL_COPY as COPY } from "@/lib/github-mapping";
import { guidePath } from "@/lib/guides";

// The GitHub App on Integrations (CHE-369): install it once. From then on every
// successful production deploy of a repository the installation can see is
// checked and answered on the commit — no YAML. The team page only needs to
// show the connection; which repository deploys which app is set on that
// app's Integrations section (src/components/app-github-repo.tsx).
//
// Server component; every sentence comes from src/lib/github-mapping.ts, which
// the language gates read (CODE_STANDARDS R18).
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
            {COPY.title} <span className="text-xs font-normal text-fg-faint">· {COPY.tagline}</span>
          </p>
          <p className="text-xs text-fg-muted">{installed ? COPY.installedIntro : COPY.emptyIntro}</p>
          <Link href={guidePath("github-app")} className="text-xs text-accent hover:underline">
            {COPY.guideLink}
          </Link>
        </div>
        {canConnect && installable && (
          <Link
            href="/api/integrations/github/app/start"
            prefetch={false}
            className="shrink-0 rounded-lg border border-ink-600 px-3 py-1.5 font-mono text-xs text-fg-muted transition-colors hover:border-fg-faint hover:text-fg"
          >
            {installed ? COPY.addAccount : COPY.install}
          </Link>
        )}
      </div>

      {!installable && !installed && <p className="text-xs text-fg-faint">{COPY.unavailable}</p>}
      {installable && !canConnect && !installed && <p className="text-xs text-fg-faint">{COPY.adminInstalls}</p>}

      {github.installations.map((inst) => (
        <p key={inst.id} className="font-mono text-xs text-fg-faint">
          {inst.accountLogin} · {inst.repos.length} {COPY.repoCount}
          {inst.suspended && <span className="text-status-risky">{` · ${COPY.suspended}`}</span>}
        </p>
      ))}
    </section>
  );
}
