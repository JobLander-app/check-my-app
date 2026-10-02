import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { releaseLensFor } from "@/lib/viewer-flags";
import { teamOwned } from "@/lib/tenant-db";
import { VERDICT_META } from "@/lib/status";
import { usd } from "@/lib/plans";
import { appPath, checkHref } from "@/lib/app-shell";
import { shellData } from "@/lib/shell-data";
import { releasesByTeam } from "@/lib/releases";
import { commitHref, envLabel, releasesHref, releasesLine, shortSha } from "@/lib/release-page";
import { dayLabel, hhmm } from "@/lib/today";
import { ReleaseDelta } from "@/components/release-delta";

const DAYS = 90;

// Release (CHE-367, the fourth lens): every release of the team's apps, newest
// first, by day — the app, the environment, the commit, how its check came
// out, its price, and what it broke, fixed or left alone against the release
// before it. A release is a check CI told us is a build (Run.deploySha); the
// rules are in src/lib/releases.ts.
//
// Behind the lens-release flag, read here on the server; with the flag off the
// address does not exist (CHE-352).
export default async function ReleasesPage({ searchParams }: { searchParams: Promise<{ app?: string }> }) {
  const { app: appParam } = await searchParams;
  const { user, db, team } = await requireUser();
  if (!(await releaseLensFor(user))) notFound();

  const now = new Date();
  const [shell, releases, repos] = await Promise.all([
    shellData(db, team.id),
    releasesByTeam(db, team.id, { days: DAYS, now }),
    db.app.findMany({ where: { ...teamOwned(team.id) }, select: { id: true, repo: { select: { repoFullName: true } } } }),
  ]);
  const nameOf = new Map(shell.apps.map((a) => [a.id, a.label]));
  const repoOf = new Map(repos.map((a) => [a.id, a.repo?.repoFullName ?? null]));
  // An app that is not the team's is no filter at all.
  const appId = appParam && nameOf.has(appParam) ? appParam : null;
  const shown = releases.filter((r) => appId === null || r.appId === appId);
  const withReleases = shell.apps.filter((a) => releases.some((r) => r.appId === a.id));
  const days = [...new Set(shown.map((r) => dayLabel(r.completedAt!, now)))];

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-10">
      <header>
        <h1 className="text-[30px] font-semibold leading-tight tracking-tight">Releases</h1>
        <p className="mt-1.5 max-w-3xl text-sm text-fg-muted">{releasesLine(shown.length, DAYS)}</p>
      </header>

      {withReleases.length > 1 && (
        <nav aria-label="Which app" className="flex flex-wrap gap-1.5">
          {[{ id: null as string | null, label: "All apps" }, ...withReleases.map((a) => ({ id: a.id as string | null, label: a.label }))].map((a) => (
            <Link
              key={a.id ?? "all"}
              href={releasesHref(a.id)}
              aria-current={appId === a.id ? "true" : undefined}
              className={`inline-flex h-7 items-center rounded-full border px-3 font-mono text-xs ${
                appId === a.id ? "border-ink-600 bg-ink-800 text-fg" : "border-ink-700 text-fg-muted hover:text-fg"
              }`}
            >
              {a.label}
            </Link>
          ))}
        </nav>
      )}

      {shown.length === 0 ? (
        <section className="card p-6 text-sm text-fg-muted">
          <p>
            A release shows up here when a check is started with the commit it is checking — from your CI, or by your
            agent after a deploy.
          </p>
          <Link href="/guides" className="mt-3 inline-block text-accent hover:underline">
            How to check every release →
          </Link>
        </section>
      ) : (
        days.map((day) => (
          <section key={day} className="flex flex-col gap-3">
            <h2 className="border-b border-ink-700 pb-1.5 text-[13px] text-fg-muted">
              {day} <span className="text-fg-faint">· times in UTC</span>
            </h2>
            {shown
              .filter((r) => dayLabel(r.completedAt!, now) === day)
              .map((r) => {
                const meta = r.verdict ? VERDICT_META[r.verdict] : null;
                const commit = commitHref(r.appId ? repoOf.get(r.appId) : null, r.sha);
                return (
                  <article key={r.publicId} className="card flex flex-col gap-2.5 px-5 py-4">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <span className="font-mono text-[13px] text-fg-muted">{hhmm(r.completedAt!)}</span>
                      {r.appId ? (
                        <Link href={appPath.page(r.appId)} className="font-mono text-[15px] text-fg hover:underline">
                          {nameOf.get(r.appId) ?? r.appSlug}
                        </Link>
                      ) : (
                        <span className="font-mono text-[15px]">{r.appSlug}</span>
                      )}
                      <span className="inline-flex h-6 items-center rounded-full border border-ink-600 px-2.5 text-xs text-fg-muted">{envLabel(r.env)}</span>
                      {commit ? (
                        <a href={commit} className="font-mono text-[13px] text-accent hover:underline" rel="noreferrer" target="_blank">
                          {shortSha(r.sha)}
                        </a>
                      ) : (
                        <span className="font-mono text-[13px] text-fg-muted">{shortSha(r.sha)}</span>
                      )}
                      {meta && (
                        <span className={`inline-flex h-6 items-center whitespace-nowrap rounded-full border px-2.5 text-xs font-medium ${meta.pillClassName}`}>{meta.label}</span>
                      )}
                      <Link href={checkHref(r)} className="font-mono text-[13px] text-accent hover:underline">
                        #{r.runNumber}
                      </Link>
                      {r.priceUsd !== null && <span className="ml-auto font-mono text-sm">{usd(r.priceUsd)}</span>}
                    </div>
                    <ReleaseDelta release={r} />
                  </article>
                );
              })}
          </section>
        ))
      )}
    </main>
  );
}
