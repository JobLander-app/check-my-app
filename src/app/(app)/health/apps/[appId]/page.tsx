import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { alreadyScoped, teamOwned } from "@/lib/tenant-db";
import { VERDICT_META } from "@/lib/status";
import { can } from "@/lib/scopes";
import { PLAN_LIMITS, shouldSkipWatch, usd } from "@/lib/plans";
import type { UserPlan } from "@/lib/enums";
import { extensionDisplayName } from "@/lib/extension-target";
import { appPath } from "@/lib/app-shell";
import { appHealth } from "@/lib/app-health";
import { recurringByApp } from "@/lib/recurring";
import { dayMonth, scheduleLabel, stripStory } from "@/lib/all-apps";
import { accountsLabel, costSplit, firstSentence, integrationsLabel, journeysLabel, splitBottomLine } from "@/lib/app-page";
import { QUICK_COMPARISON, quickCheckWork } from "@/lib/check-price";
import { RunSavedApp } from "@/components/run-saved-app";
import { VerdictStrip } from "@/components/verdict-strip";

const TIMELINE = 12;
const FINISHED = ["completed", "partial"];

const Row = ({ href, label, value }: { href: string; label: string; value: string }) => (
  <Link href={href} className="flex items-center justify-between gap-4 border-b border-ink-800 py-3 text-sm last:border-b-0 hover:text-accent">
    <span>{label}</span>
    <span className="truncate text-[13px] text-fg-muted">{value}</span>
  </Link>
);

// One app (CHE-358, direction C): what state it is in and how it got there —
// the latest verdict and the strip's own line, the last checks as a timeline
// (each with what its verdict said and its price), what the app costs and who
// started the checks, the problems that keep coming back, and one click to
// each part of its settings.
export default async function AppPage({ params }: { params: Promise<{ appId: string }> }) {
  const { appId } = await params;
  const { user, db, team, scope } = await requireUser();
  const app = await db.app.findFirst({
    where: { ...teamOwned(team.id), id: appId },
    select: {
      id: true, ownerId: true, appSlug: true, targetUrl: true, targetKind: true, testEmail: true,
      posthogProjectName: true, webhookUrl: true, slackWebhookUrl: true,
      tracker: { select: { id: true } },
      repo: { select: { id: true } },
      watch: { select: { active: true, frequency: true, trialEndsAt: true } },
    },
  });
  // Not in the team you are acting as. The settings page answers that case —
  // it offers the switch when the app is in another team of yours, and 404s
  // otherwise (CHE-261) — so it is said in one place.
  if (!app) redirect(appPath.settings(appId));

  // Which checks are this app's is appHealth's rule, here as there: the ones
  // attached to it, and — when it is the team's only app with this address —
  // the ones made before it was saved (no appId). Otherwise the header could
  // name a check the timeline does not have.
  const onlyOneWithSlug = (await db.app.count({ where: { ...teamOwned(team.id), appSlug: app.appSlug } })) === 1;
  const [health, recurring, runs, journeys, namedAccounts] = await Promise.all([
    // This app's entries alone: the page's work follows one app's history,
    // not the team's whole portfolio.
    appHealth(db, team.id, { only: app.id }),
    recurringByApp(db, team.id, app.id),
    db.run.findMany({
      // The header's rule (appHealth): a check is shown with its price, which
      // is written a step after its verdict — so the timeline never runs ahead
      // of the badge above it. Newest first by the check's number: D1 orders
      // completedAt as text and prod holds two spellings of it.
      where: {
        ...teamOwned(team.id),
        OR: [{ appId: app.id }, ...(onlyOneWithSlug ? [{ appId: null, appSlug: app.appSlug }] : [])],
        status: { in: FINISHED }, verdict: { not: null }, priceUsd: { not: null },
      },
      orderBy: { runNumber: "desc" },
      take: TIMELINE,
      select: { publicId: true, runNumber: true, verdict: true, bottomLine: true, priceUsd: true, completedAt: true, quickPagesOpened: true },
    }),
    db.appJourney.count({ where: { appId: app.id, retiredAt: null } }),
    db.testAccount.count({ ...alreadyScoped("the App was just scoped to this team"), where: { appId: app.id } }),
  ]);
  const mine = health.apps.find((a) => a.appId === app.id);
  const isExtension = app.targetKind === "extension";
  const name = isExtension ? extensionDisplayName(app.targetUrl) : app.appSlug;
  const meta = mine?.latest?.verdict ? VERDICT_META[mine.latest.verdict] : null;
  const watch = app.watch
    ? { active: app.watch.active, frequency: app.watch.frequency, trialEnded: shouldSkipWatch(app.watch, team.plan as UserPlan) }
    : undefined;
  const again = (recurring.get(app.id) ?? []).filter((i) => i.state === "recurring");
  const settings = appPath.settings(app.id);
  // The button is shown only where pressing it starts a check: the viewer's
  // scope allows it, and the app is one they added — today startSavedApp
  // answers "App not found" for a teammate's app (CHE-395). A reader, or a
  // member on a teammate's app, sees the review link alone.
  const mayRun = can(scope, "run.start") && app.ownerId === user.id;
  // The same for the tracker offer: exactly what /api/integrations/linear/start
  // asks for — the scope, a plan that carries tracker integrations, the
  // viewer's own app. Anyone else would follow it into a refusal.
  const mayConnectTracker =
    can(scope, "integration.connect") && PLAN_LIMITS[team.plan as UserPlan].trackerIntegration && app.ownerId === user.id;

  return (
    <main className="mx-auto grid w-full max-w-6xl items-start gap-8 px-4 py-10 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-w-0 flex-col gap-6">
        <header className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="break-all font-mono text-[26px] font-medium leading-tight">{name}</h1>
            {meta && (
              <span className={`inline-flex h-6 items-center whitespace-nowrap rounded-full border px-2.5 text-xs font-medium ${meta.pillClassName}`}>
                {meta.label}
              </span>
            )}
          </div>
          <p className="max-w-2xl text-xl leading-snug">{stripStory((mine?.verdicts ?? []).map((v) => v.verdict))}</p>
          {mine && mine.verdicts.length > 0 && <VerdictStrip verdicts={mine.verdicts} className="h-5 max-w-md" />}
          <div className="mt-1 flex flex-wrap items-start gap-2.5">
            {mayRun && <RunSavedApp appId={app.id} primary />}
            {mine?.latest && (
              <Link
                href={appPath.check(app.id, mine.latest.runNumber)}
                className="inline-flex h-9 items-center rounded-lg border border-ink-600 bg-ink-850 px-3.5 text-sm text-fg hover:bg-ink-800"
              >
                Open latest review
              </Link>
            )}
          </div>
        </header>

        {runs.length === 0 ? (
          <p className="card p-6 text-sm text-fg-muted">No checks yet. The first one maps the app and walks what it finds.</p>
        ) : (
          <section aria-label="Checks, newest first" className="flex flex-col">
            {runs.map((run, i) => {
              const v = run.verdict ? VERDICT_META[run.verdict] : null;
              // A quick check found nothing changed and walked nothing: its row
              // says that in the price explanation's own words, not in the
              // bottom line written for it (older ones name our machinery —
              // CHE-377).
              const { coverage, said } =
                run.quickPagesOpened !== null
                  ? { coverage: null, said: `${quickCheckWork(run.quickPagesOpened)}.` }
                  : splitBottomLine(run.bottomLine);
              return (
                <div key={run.publicId} className="grid grid-cols-[64px_20px_minmax(0,1fr)_56px] items-start gap-3.5">
                  <div className="py-3.5">
                    <div className="text-[13px]">{run.completedAt ? dayMonth(run.completedAt) : "—"}</div>
                    <Link href={appPath.check(app.id, run.runNumber)} className="font-mono text-xs text-accent hover:underline">
                      #{run.runNumber}
                    </Link>
                  </div>
                  <div aria-hidden className="flex flex-col items-center self-stretch">
                    <span className={`h-[18px] w-0.5 ${i === 0 ? "bg-transparent" : "bg-ink-700"}`} />
                    <span className={`h-2 w-2 shrink-0 rounded-full ${v?.dotClassName ?? "bg-ink-600"}`} />
                    <span className={`w-0.5 flex-1 ${i === runs.length - 1 ? "bg-transparent" : "bg-ink-700"}`} />
                  </div>
                  <div className="flex min-w-0 flex-col gap-0.5 py-3.5">
                    <span className={`text-sm font-medium ${v?.textClassName ?? "text-fg-faint"}`}>{v?.label ?? run.verdict}</span>
                    {said && <span className="text-sm">{firstSentence(said)}</span>}
                    {coverage && <span className="text-xs text-fg-faint">{coverage}</span>}
                  </div>
                  <div className="py-3.5 text-right font-mono text-sm">{run.priceUsd !== null ? usd(run.priceUsd) : ""}</div>
                </div>
              );
            })}
          </section>
        )}
      </div>

      <aside className="flex min-w-0 flex-col gap-[18px]">
        <section className="card flex flex-col gap-2 p-[18px]">
          <div className="text-[13px] text-fg-muted">This app costs</div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[28px] leading-none">{usd(mine?.spendUsd ?? 0)}</span>
            <span className="text-fg-muted">in the last {health.windowDays} days</span>
          </div>
          <div className="text-[13px] text-fg-muted">
            {mine ? costSplit(mine.scheduled, mine.onRequest, usd) : "No checks in this window."}
          </div>
          {mine?.latest && (
            <div className="border-t border-ink-800 pt-2.5 text-[13px]">
              Last check <span className="font-mono">{usd(mine.latest.priceUsd)}</span>: {mine.latest.price.work}.
              {/* A quick check's comparison repeats its work line. */}
              {mine.latest.price.comparison && mine.latest.price.comparison !== QUICK_COMPARISON ? ` ${mine.latest.price.comparison}` : ""}
            </div>
          )}
        </section>

        {again.length > 0 && (
          <section className="card flex flex-col gap-2 p-[18px]">
            <div className="text-[15px] font-semibold">Keeps coming back</div>
            <ul className="flex flex-col gap-2">
              {again.map((issue) => (
                <li key={issue.signature} className="text-[13px]">
                  <span className="text-status-risky">{issue.title}</span>
                  <span className="block text-fg-muted">
                    Seen in {issue.timesSeen} checks in a row, #{issue.firstSeenRunNumber} to #{issue.lastSeenRunNumber}.
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="card px-[18px] py-1.5">
          <Row href={appPath.section(app.id, "scope")} label="What we check" value={journeysLabel(journeys)} />
          <Row href={appPath.section(app.id, "accounts")} label="Test accounts" value={accountsLabel(Boolean(app.testEmail), namedAccounts)} />
          {isExtension ? (
            // An extension is checked on request only: there is no schedule to open.
            <div className="flex items-center justify-between gap-4 border-b border-ink-800 py-3 text-sm">
              <span>Schedule</span>
              <span className="truncate text-[13px] text-fg-muted">On request only</span>
            </div>
          ) : (
            <Row href={appPath.schedule(app.id)} label="Schedule" value={scheduleLabel(watch)} />
          )}
          <Row
            href={appPath.section(app.id, "integrations")}
            label="Integrations"
            value={integrationsLabel({
              tracker: app.tracker !== null,
              analyticsProject: app.posthogProjectName,
              repo: app.repo !== null,
              webhook: Boolean(app.webhookUrl),
              slack: Boolean(app.slackWebhookUrl),
            })}
          />
        </section>

        {app.tracker === null && mayConnectTracker && (
          <section className="card flex flex-col gap-2 p-[18px]">
            <div className="text-[15px] font-semibold">Send problems to your tracker</div>
            <div className="text-[13px] text-fg-muted">
              Connect Linear and each problem becomes one ticket that closes itself when a later check sees the fix.
            </div>
            <Link
              href={appPath.section(app.id, "integrations")}
              className="inline-flex h-9 items-center self-start rounded-lg border border-ink-600 bg-ink-850 px-3.5 text-sm text-fg hover:bg-ink-800"
            >
              Connect Linear
            </Link>
          </section>
        )}
      </aside>
    </main>
  );
}
