import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { appHealth } from "@/lib/app-health";
import { VERDICT_META } from "@/lib/status";
import { usd } from "@/lib/plans";
import { appPath } from "@/lib/app-shell";
import { shellData } from "@/lib/shell-data";

// Health → All apps (CHE-351 shell). One row per app: the colour of its latest
// verdict, what it costs a month at the rate of the last 30 days, and its
// latest check. The lanes and the strip of 21 checks are CHE-357.
export default async function AllAppsPage() {
  const { db, team } = await requireUser();
  // The names are the sidebar's (an extension is called by its name, not its
  // slug); the layout has already asked, so this costs nothing.
  const [health, shell] = await Promise.all([appHealth(db, team.id), shellData(db, team.id)]);
  const labelOf = new Map(shell.apps.map((a) => [a.id, a.label]));

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">All apps</h1>
          <p className="mt-1 text-sm text-fg-muted">
            {health.apps.length === 0
              ? "No apps yet."
              : `${health.apps.length} app${health.apps.length === 1 ? "" : "s"} · ${usd(health.appsMonthlyUsd)} a month at the rate of the last ${health.windowDays} days`}
          </p>
        </div>
        <Link
          href="/onboarding?path=app"
          className="rounded-md bg-accent px-4 py-2 font-mono text-[13px] font-semibold text-ink-950 transition-opacity hover:opacity-90"
        >
          + Add app
        </Link>
      </div>

      {health.apps.length > 0 && (
        <ul className="card divide-y divide-ink-700">
          {health.apps.map((app) => {
            const meta = app.latest?.verdict ? VERDICT_META[app.latest.verdict] : null;
            return (
              <li key={app.appId} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${meta?.dotClassName ?? "bg-ink-600"}`} />
                <Link href={appPath.page(app.appId)} className="min-w-0 flex-1 truncate font-mono text-sm text-fg hover:underline">
                  {labelOf.get(app.appId) ?? app.appSlug}
                </Link>
                <span className={`text-xs ${meta?.textClassName ?? "text-fg-faint"}`}>
                  {meta ? meta.label : "no check yet"}
                </span>
                <span className="w-24 text-right font-mono text-xs text-fg-muted">
                  {usd(app.perDayUsd * 30)}/mo
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
