import Link from "next/link";
import { cookies } from "next/headers";
import { requireUser } from "@/lib/auth";
import { appHealth, type AppHealth } from "@/lib/app-health";
import { VERDICT_META } from "@/lib/status";
import { shouldSkipWatch, usd } from "@/lib/plans";
import type { UserPlan } from "@/lib/enums";
import { teamOwned } from "@/lib/tenant-db";
import { appPath } from "@/lib/app-shell";
import { shellData } from "@/lib/shell-data";
import { recurringByApp } from "@/lib/recurring";
import {
  recurringCount,
  recurringLine,
  APPS_FILTERS,
  APPS_VIEW_COOKIE,
  allAppsHref,
  appsFilter,
  appsView,
  checkedWhen,
  inFilter,
  scheduleLabel,
  stripStory,
  type WatchState,
} from "@/lib/all-apps";
import { AppsViewToggle } from "@/components/apps-view-toggle";
import { VerdictStrip } from "@/components/verdict-strip";
import { CheckPrice } from "@/components/check-price";

// `newestVerdict` is the strip's last bar. `latest` can be one check behind it:
// a check is shown with its price, and the price is written a step after the
// verdict (appHealth). "Need attention" follows the newest verdict, so the
// filter never leaves out an app whose strip already ends in red.
//
// `recurring` is how many problems of the app were seen in two or more checks in
// a row and are still there (CHE-354, src/lib/recurring.ts) — the owner's
// "what keeps coming back because nobody fixes it".
type Row = AppHealth & { name: string; watch: WatchState; newestVerdict: string | null; recurring: number };

function Latest({ app }: { app: Row }) {
  const meta = app.latest?.verdict ? VERDICT_META[app.latest.verdict] : null;
  if (!app.latest || !meta) return <span className="text-xs text-fg-faint">No check yet</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className={`inline-flex h-6 items-center whitespace-nowrap rounded-full border px-2.5 text-xs font-medium ${meta.pillClassName}`}>
        {meta.label}
      </span>
      <Link href={`/verdict/${app.latest.publicId}`} className="font-mono text-[13px] text-accent hover:underline">
        #{app.latest.runNumber}
      </Link>
      {app.latest.completedAt && (
        <span className="text-xs text-fg-faint">{checkedWhen(app.latest.completedAt)}</span>
      )}
    </span>
  );
}

const Figure = ({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) => (
  <div className="min-w-0">
    <div className="text-xs text-fg-muted">{label}</div>
    <div className="font-mono text-[17px] text-fg">{value}</div>
    {children}
  </div>
);

function Card({ app, days }: { app: Row; days: number }) {
  return (
    <article className="card grid grid-cols-2 gap-x-6 gap-y-4 px-5 py-[18px] lg:grid-cols-[220px_minmax(0,1fr)_110px_190px_120px_auto] lg:items-center">
      <div className="col-span-2 flex min-w-0 flex-col gap-1.5 lg:col-span-1">
        <Link href={appPath.page(app.appId)} className="truncate font-mono text-[15px] text-fg hover:underline">
          {app.name}
        </Link>
        <Latest app={app} />
      </div>
      <div className="col-span-2 flex min-w-0 flex-col gap-1.5 lg:col-span-1">
        <VerdictStrip verdicts={app.verdicts} />
        <span className="text-xs text-fg-muted">{stripStory(app.verdicts.map((v) => v.verdict))}</span>
        {/* Under the strip, where the reason has room to open. */}
        {app.latest && <CheckPrice explanation={app.latest.price} label="Last check" />}
      </div>
      <Figure label={`${days} days`} value={usd(app.spendUsd)}>
        <div className="text-xs text-fg-muted">{usd(app.perDayUsd)} a day</div>
      </Figure>
      <Figure label={`Checks, ${days} days`} value={String(app.checks)}>
        <div className="text-xs text-fg-muted">
          {app.scheduled.count} scheduled · {app.onRequest.count} on request
        </div>
        <div className="text-xs text-fg-muted">{scheduleLabel(app.watch)}</div>
      </Figure>
      <div className="min-w-0">
        <div className="text-xs text-fg-muted">Recurring</div>
        <div className={`font-mono text-[17px] ${app.recurring > 0 ? "text-status-risky" : "text-fg-muted"}`}>{app.recurring}</div>
        <div className="text-xs text-fg-muted">{recurringLine(app.recurring)}</div>
      </div>
      <Link href={appPath.settings(app.appId)} className="self-end text-right text-[13px] text-accent hover:underline lg:self-auto">
        Settings
      </Link>
    </article>
  );
}

const TH = "whitespace-nowrap border-b border-ink-700 px-3 py-2.5 text-left text-xs font-medium text-fg-muted first:pl-4 last:pr-4";
const TD = "border-b border-ink-800 px-3 py-3.5 align-middle first:pl-4 last:pr-4";

function List({ apps, days }: { apps: Row[]; days: number }) {
  return (
    // The table scrolls inside its card; the page never scrolls sideways.
    <section className="card overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className={TH}>App</th>
            <th className={TH}>Latest</th>
            <th className={TH}>Last 21 checks</th>
            <th className={`${TH} text-right`}>{days} days</th>
            <th className={`${TH} text-right`}>A day</th>
            <th className={`${TH} text-right`}>Last check</th>
            <th className={`${TH} text-right`}>Checks</th>
            <th className={`${TH} text-right`}>Scheduled · on request</th>
            <th className={`${TH} text-right`}>Recurring</th>
            <th className={TH}>Schedule</th>
            <th className={TH} />
          </tr>
        </thead>
        <tbody>
          {apps.map((app) => (
            <tr key={app.appId}>
              <td className={`${TD} font-mono`}>
                <Link href={appPath.page(app.appId)} className="whitespace-nowrap text-fg hover:underline">
                  {app.name}
                </Link>
              </td>
              <td className={`${TD} whitespace-nowrap`}>
                <Latest app={app} />
              </td>
              {/* The same strip as the card, small; its one line is the tooltip. */}
              <td className={TD}>
                <VerdictStrip verdicts={app.verdicts} className="h-4 w-[132px]" summary={stripStory(app.verdicts.map((v) => v.verdict))} />
              </td>
              <td className={`${TD} text-right font-mono`}>{usd(app.spendUsd)}</td>
              <td className={`${TD} text-right font-mono`}>{usd(app.perDayUsd)}</td>
              <td className={`${TD} text-right font-mono`}>
                {app.latest ? <CheckPrice explanation={app.latest.price} label={null} /> : "—"}
              </td>
              <td className={`${TD} text-right font-mono`}>{app.checks}</td>
              <td className={`${TD} whitespace-nowrap text-right font-mono`}>
                {app.scheduled.count} · {app.onRequest.count}
              </td>
              <td
                className={`${TD} text-right font-mono ${app.recurring > 0 ? "text-status-risky" : "text-fg-muted"}`}
                title={recurringLine(app.recurring)}
              >
                {app.recurring}
              </td>
              <td className={`${TD} whitespace-nowrap`}>{scheduleLabel(app.watch)}</td>
              <td className={`${TD} text-right`}>
                <Link href={appPath.settings(app.appId)} className="text-[13px] text-accent hover:underline">
                  Settings
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// Health → All apps (CHE-357, direction C): per app, the latest verdict with the
// way to its review, the strip of its last 21 checks and what the strip says,
// what the app cost over the window and a day, the latest check's price with
// its reason, how many checks that was and who started them, the schedule, and
// one click to its settings. Cards or a list (?view=), all or a part (?show=).
export default async function AllAppsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; show?: string }>;
}) {
  const [{ view: viewParam, show }, jar] = await Promise.all([searchParams, cookies()]);
  const view = appsView(viewParam, jar.get(APPS_VIEW_COOKIE)?.value);
  const filter = appsFilter(show);

  const { db, team } = await requireUser();
  // The names are the sidebar's (an extension is called by its name, not its
  // slug); the layout has already asked, so this costs nothing.
  const [health, shell, recurring, watches] = await Promise.all([
    appHealth(db, team.id),
    shellData(db, team.id),
    recurringByApp(db, team.id),
    db.watch.findMany({
      where: { ...teamOwned(team.id) },
      select: { appId: true, active: true, frequency: true, trialEndsAt: true },
    }),
  ]);
  const nameOf = new Map(shell.apps.map((a) => [a.id, a.label]));
  // "On a schedule" is the scheduler's own rule: a Free team's watch stays
  // active after its trial and is never started again.
  const watchOf = new Map(
    watches.map((w) => [w.appId, { active: w.active, frequency: w.frequency, trialEnded: shouldSkipWatch(w, team.plan as UserPlan) }]),
  );
  const all: Row[] = health.apps.map((a) => ({
    ...a,
    name: nameOf.get(a.appId) ?? a.appSlug,
    watch: watchOf.get(a.appId),
    newestVerdict: a.verdicts.at(-1)?.verdict ?? null,
    recurring: recurringCount(recurring.get(a.appId) ?? []),
  }));
  const apps = all.filter((a) => inFilter(filter, { latestVerdict: a.newestVerdict, watch: a.watch }));

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[30px] font-semibold leading-tight tracking-tight">All apps</h1>
          <p className="mt-1.5 text-sm text-fg-muted">
            {all.length === 0
              ? "No apps yet."
              : `${usd(health.totalSpendUsd)} in the last ${health.windowDays} days. Each bar is one check, the latest on the right.`}
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <AppsViewToggle view={view} hrefs={{ cards: allAppsHref("cards", filter), list: allAppsHref("list", filter) }} />
          <Link
            href="/onboarding?path=app"
            className="inline-flex h-9 items-center rounded-lg bg-accent px-3.5 text-sm font-medium text-ink-950 transition-opacity hover:opacity-90"
          >
            Add app
          </Link>
        </div>
      </header>

      {all.length > 0 && (
        <nav aria-label="Which apps" className="flex flex-wrap gap-1.5">
          {APPS_FILTERS.map((f) => {
            const count = all.filter((a) => inFilter(f.key, { latestVerdict: a.newestVerdict, watch: a.watch })).length;
            return (
              <Link
                key={f.key}
                href={allAppsHref(view, f.key)}
                aria-current={filter === f.key ? "true" : undefined}
                className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs ${
                  filter === f.key ? "border-ink-600 bg-ink-800 text-fg" : "border-ink-700 text-fg-muted hover:text-fg"
                }`}
              >
                {f.label}
                <span className="font-mono text-fg-faint">{count}</span>
              </Link>
            );
          })}
        </nav>
      )}

      {all.length > 0 && apps.length === 0 && (
        <p className="card p-6 text-sm text-fg-muted">
          {filter === "attention" ? "No app needs attention in its latest check." : "No app is checked on a schedule."}
        </p>
      )}

      {apps.length > 0 &&
        (view === "cards" ? (
          <div className="flex flex-col gap-3.5">
            {apps.map((app) => (
              <Card key={app.appId} app={app} days={health.windowDays} />
            ))}
          </div>
        ) : (
          <List apps={apps} days={health.windowDays} />
        ))}
    </main>
  );
}
