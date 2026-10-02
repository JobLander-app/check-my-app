import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { teamOwned } from "@/lib/tenant-db";
import { VERDICT_META } from "@/lib/status";
import { usd } from "@/lib/plans";
import type { UserPlan } from "@/lib/enums";
import { LIVE_RUN_STATUSES } from "@/lib/enums";
import { appPath, checkHref } from "@/lib/app-shell";
import { appHealth, teamSpend } from "@/lib/app-health";
import { shellData } from "@/lib/shell-data";
import { explainPrice } from "@/lib/check-price";
import { BY_SCHEDULE, ON_REQUEST } from "@/lib/started-via";
import { CheckPrice } from "@/components/check-price";
import {
  CHECKS_PAGE,
  STARTED_FILTERS,
  checksHref,
  checksLine,
  outcome,
  runNumberParam,
  startedFilter,
  startedLabel,
  whenLine,
} from "@/lib/checks-page";

const TH = "whitespace-nowrap border-b border-ink-700 px-3 py-2.5 text-left text-xs font-medium text-fg-muted first:pl-[18px] last:pr-[18px]";
const TD = "border-b border-ink-800 px-3 py-3 align-top first:pl-[18px] last:pr-[18px]";

// Health → Checks (CHE-360, direction C): every check of the team, newest
// first — number, app, when, what started it, how it came out, its price — by
// app and by scheduled / on request. A price opens into its reason through the
// address (?why=<number>): one reason is loaded, for the check the reader asked
// about, not fifty for a page of rows.
export default async function ChecksPage({
  searchParams,
}: {
  searchParams: Promise<{ app?: string; started?: string; before?: string; why?: string }>;
}) {
  const sp = await searchParams;
  const started = startedFilter(sp.started);
  const before = runNumberParam(sp.before);
  const why = runNumberParam(sp.why);
  const { db, team } = await requireUser();
  const shell = await shellData(db, team.id);
  const nameOf = new Map(shell.apps.map((a) => [a.id, a.label]));
  // The team's apps are the sidebar's (already read for this request). An app
  // from the address that is not among them is no filter at all.
  const app = shell.apps.find((a) => a.id === sp.app) ?? null;
  const appId = app?.id ?? null;
  // Which checks are an app's is appHealth's rule, as on the app's own page:
  // attached to it, or — for the team's only app of that address — made with
  // no app. The same rule names a row's app and links it.
  const slugCount = new Map<string, number>();
  for (const a of shell.apps) slugCount.set(a.appSlug, (slugCount.get(a.appSlug) ?? 0) + 1);
  const onlyAppOf = new Map(shell.apps.filter((a) => slugCount.get(a.appSlug) === 1).map((a) => [a.appSlug, a.id]));
  const ofApp = app ? { OR: [{ appId: app.id }, ...(onlyAppOf.get(app.appSlug) === app.id ? [{ appId: null, appSlug: app.appSlug }] : [])] } : {};
  // The filter is the label's own rule (src/lib/started-via.ts), in the database.
  const byStart = started === "scheduled" ? BY_SCHEDULE : started === "request" ? ON_REQUEST : {};

  // The header's numbers are appHealth's. For every app together that is the
  // team's totals alone (teamSpend — the same pass, without each app's history
  // and price explanation); for one app, that app's entry.
  const [totals, health, found] = await Promise.all([
    app ? null : teamSpend(db, team.id),
    app ? appHealth(db, team.id, { only: app.id }) : null,
    db.run.findMany({
      // Each of the two filters is an OR of its own, so they are joined by AND.
      where: { ...teamOwned(team.id), AND: [ofApp, byStart], ...(before ? { runNumber: { lt: before } } : {}) },
      // By number: D1 orders dates as text and prod holds two spellings of them.
      orderBy: { runNumber: "desc" },
      take: CHECKS_PAGE + 1,
      select: {
        id: true, teamId: true, publicId: true, runNumber: true, appId: true, appSlug: true, status: true, verdict: true,
        priceUsd: true, quickPagesOpened: true, createdAt: true, completedAt: true, watchId: true, startedVia: true,
      },
    }),
  ]);
  const runs = found.slice(0, CHECKS_PAGE);
  const older = found.length > CHECKS_PAGE ? runs[runs.length - 1].runNumber : null;
  // The one reason asked for — of a check on this page, so it is the team's.
  const opened = why ? runs.find((r) => r.runNumber === why) : undefined;
  const reason = opened ? await explainPrice(db, opened, team.plan as UserPlan) : null;

  const mine = app ? health?.apps.find((a) => a.appId === app.id) : undefined;
  const windowDays = health?.windowDays ?? totals?.windowDays ?? 30;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-10">
      <header>
        <h1 className="text-[30px] font-semibold leading-tight tracking-tight">Checks</h1>
        <p className="mt-1.5 text-sm text-fg-muted">
          {app
            ? checksLine({
                windowDays,
                checks: mine?.checks ?? 0,
                usd: usd(mine?.spendUsd ?? 0),
                scheduled: mine?.scheduled.count ?? 0,
                onRequest: mine?.onRequest.count ?? 0,
              })
            : checksLine({ windowDays, checks: totals?.totalChecks ?? 0, usd: usd(totals?.totalSpendUsd ?? 0) })}{" "}
          Times are in UTC.
        </p>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="What started the check" className="flex flex-wrap gap-1.5">
          {STARTED_FILTERS.map((f) => (
            <Link
              key={f.key}
              href={checksHref({ app: appId, started: f.key })}
              aria-current={started === f.key ? "true" : undefined}
              className={`inline-flex h-7 items-center rounded-full border px-3 text-xs ${
                started === f.key ? "border-ink-600 bg-ink-800 text-fg" : "border-ink-700 text-fg-muted hover:text-fg"
              }`}
            >
              {f.label}
            </Link>
          ))}
        </nav>
        {shell.apps.length > 1 && (
          <nav aria-label="Which app" className="flex flex-wrap gap-1.5">
            {[{ id: null as string | null, label: "All apps" }, ...shell.apps.map((a) => ({ id: a.id as string | null, label: a.label }))].map((a) => (
              <Link
                key={a.id ?? "all"}
                href={checksHref({ app: a.id, started })}
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
      </div>

      {runs.length === 0 ? (
        <p className="card p-6 text-sm text-fg-muted">{before ? "No earlier checks." : "No checks here yet."}</p>
      ) : (
        // The table scrolls inside its card; the page never scrolls sideways.
        <section className="card overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className={TH}>Check</th>
                <th className={TH}>App</th>
                <th className={TH}>When</th>
                <th className={TH}>Started</th>
                <th className={TH}>Result</th>
                <th className={`${TH} text-right`}>Price</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const result = outcome(run, LIVE_RUN_STATUSES);
                const ownApp = run.appId ?? onlyAppOf.get(run.appSlug) ?? null;
                const meta = result.kind === "verdict" ? VERDICT_META[result.verdict] : null;
                // A finished check opens inside the app; one that is running or
                // did not finish has its own page, which says where it stands.
                const href = result.kind === "verdict" ? checkHref({ appId: ownApp, runNumber: run.runNumber, publicId: run.publicId }) : `/run/${run.publicId}`;
                return (
                  <tr key={run.id} id={`c${run.runNumber}`} className="scroll-mt-6">
                    <td className={`${TD} whitespace-nowrap font-mono`}>
                      <Link href={href} className="text-accent hover:underline">
                        #{run.runNumber}
                      </Link>
                    </td>
                    <td className={`${TD} max-w-[260px] truncate font-mono text-[13px]`}>
                      {ownApp ? (
                        <Link href={appPath.page(ownApp)} className="text-fg hover:underline">
                          {nameOf.get(ownApp) ?? run.appSlug}
                        </Link>
                      ) : (
                        <span className="text-fg-muted">{run.appSlug}</span>
                      )}
                    </td>
                    <td className={`${TD} whitespace-nowrap text-[13px] text-fg-muted`}>{whenLine(run.completedAt ?? run.createdAt)}</td>
                    <td className={`${TD} whitespace-nowrap text-[13px] text-fg-muted`}>{startedLabel(run)}</td>
                    <td className={`${TD} whitespace-nowrap`}>
                      {result.kind === "verdict" ? (
                        <span className={`inline-flex h-6 items-center rounded-full border px-2.5 text-xs font-medium ${meta?.pillClassName ?? "border-ink-600 text-fg-faint"}`}>
                          {meta?.label ?? result.verdict}
                        </span>
                      ) : (
                        <span className="text-[13px] text-fg-muted">{result.kind === "running" ? "Running" : "Did not finish"}</span>
                      )}
                    </td>
                    <td className={`${TD} text-right`}>
                      {/* A check that did not finish is ours and is not charged
                          (CLAUDE.md §4): it says so, whether its price was
                          never written or written as zero. */}
                      {run.priceUsd === null || (result.kind === "unfinished" && run.priceUsd === 0) ? (
                        <span className="text-[13px] text-fg-faint">{result.kind === "unfinished" ? "not charged" : "—"}</span>
                      ) : opened?.id === run.id && reason ? (
                        <CheckPrice explanation={reason} label={null} open />
                      ) : (
                        <Link
                          href={checksHref({ app: appId, started, before, why: run.runNumber })}
                          className="whitespace-nowrap font-mono text-fg underline decoration-dotted underline-offset-2 hover:text-accent"
                        >
                          {usd(run.priceUsd)}
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {(older || before) && (
        <nav aria-label="Pages" className="flex items-center gap-4 text-sm">
          {before && (
            <Link href={checksHref({ app: appId, started })} className="text-accent hover:underline">
              ← Newest
            </Link>
          )}
          {older && (
            <Link href={checksHref({ app: appId, started, before: older })} className="text-accent hover:underline">
              Earlier checks →
            </Link>
          )}
        </nav>
      )}
    </main>
  );
}
