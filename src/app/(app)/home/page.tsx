import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { ConnectAgent } from "@/components/connect-agent";
import { teamBalance, usd, watchTrialState } from "@/lib/plans";
import { appCanRun } from "@/lib/plan-status";
import type { UserPlan } from "@/lib/enums";
import { teamOwned } from "@/lib/tenant-db";
import { extensionCheckFor } from "@/lib/viewer-flags";
import { integrationNotice } from "@/lib/integration-notice";
import { BALANCE_PATH } from "@/lib/balance-links";
import { appPath, checkHref } from "@/lib/app-shell";
import { VERDICT_META } from "@/lib/status";
import { appHealth } from "@/lib/app-health";
import { recurringByApp } from "@/lib/recurring";
import { shellData } from "@/lib/shell-data";
import { QUICK_COMPARISON, quickCheckWork } from "@/lib/check-price";
import { CheckPrice } from "@/components/check-price";
import { firstSentence, splitBottomLine } from "@/lib/app-page";
import { balanceLine, daysToNextMonth, pace, sharePercent } from "@/lib/billing-page";
import { briefing, clip, dayLabel, daysAgo, hhmm, latestPerApp, longDate } from "@/lib/today";

const FINISHED = ["completed", "partial"];
const FEED_DAYS = 2; // today and yesterday; the rest is on Checks
const DAY_MS = 24 * 60 * 60 * 1000;

const Tile = ({ label, className = "", children }: { label: string; className?: string; children: React.ReactNode }) => (
  <section className={`card flex min-w-0 flex-col gap-2 p-[18px] ${className}`}>
    <div className="text-[13px] text-fg-muted">{label}</div>
    {children}
  </section>
);

// Today (CHE-361, direction C — the briefing): one sentence on whether
// everything is alive, then what the apps cost, the balance and what keeps
// coming back in a row of three, then the checks of today and yesterday with
// what each said and its price. One centred column, the width the other pages
// use (CHE-411): a side rail left a third of the screen empty whenever it had
// nothing to say. The per-app controls the old dashboard carried here (tracker
// team, analytics project, webhooks) are the app's settings now.
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ integration?: string; added?: string; extensionAdded?: string }>;
}) {
  const { integration, added, extensionAdded } = await searchParams;
  const { user, db, team } = await requireUser();
  const plan = team.plan as UserPlan;
  const now = new Date();
  // Checks placed by createdAt on the [teamId, createdAt] index, a day of
  // slack for the old spelling of dates; the day a check belongs to is the day
  // it finished.
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - FEED_DAYS * DAY_MS);

  const [shell, health, recurring, balance, apiKeys, extensionCheck, watches, runs] = await Promise.all([
    shellData(db, team.id),
    appHealth(db, team.id),
    recurringByApp(db, team.id),
    teamBalance(db, { id: team.id, plan }),
    db.apiKey.findMany({ where: { ...teamOwned(team.id) }, orderBy: { createdAt: "desc" }, select: { lastUsedAt: true } }),
    extensionCheckFor(user),
    db.watch.findMany({ where: { ...teamOwned(team.id) }, select: { appId: true, appSlug: true, active: true, trialEndsAt: true } }),
    db.run.findMany({
      where: { ...teamOwned(team.id), status: { in: FINISHED }, verdict: { not: null }, priceUsd: { not: null }, createdAt: { gte: since } },
      // Every check of the window, no row limit: the sentence above the feed
      // needs the latest check of EACH app, and a cap on rows would drop a
      // quiet app's check behind a busy one's (seven apps checked every six
      // hours are 56 rows in two days). The window is what bounds it.
      orderBy: { runNumber: "desc" },
      select: {
        publicId: true, runNumber: true, appId: true, appSlug: true, verdict: true, bottomLine: true,
        priceUsd: true, completedAt: true, quickPagesOpened: true,
      },
    }),
  ]);
  const nameOf = new Map(shell.apps.map((a) => [a.id, a.label]));
  // Whose check it is, by appHealth's rule: the app it is attached to, or —
  // for a check with no app — the team's only app with that address. Anything
  // else (a preview, an address never saved) is in the feed under its own
  // address and is not one of "your apps" in the sentence above it.
  const slugCount = new Map<string, number>();
  for (const a of health.apps) slugCount.set(a.appSlug, (slugCount.get(a.appSlug) ?? 0) + 1);
  const onlyAppOf = new Map(health.apps.filter((a) => slugCount.get(a.appSlug) === 1).map((a) => [a.appSlug, a.appId]));
  const feed = runs
    .filter((r) => r.completedAt !== null && daysAgo(r.completedAt, now) < FEED_DAYS)
    .map((r) => {
      const appId = r.appId ?? onlyAppOf.get(r.appSlug) ?? null;
      // What the check said: a quick check in the price explanation's words, a
      // partial check without its fixed coverage opening (src/lib/app-page.ts).
      const said = r.quickPagesOpened !== null ? `${quickCheckWork(r.quickPagesOpened)}.` : firstSentence(splitBottomLine(r.bottomLine).said);
      return { ...r, appId, completedAt: r.completedAt!, verdict: r.verdict!, appKey: appId ?? "", name: (appId && nameOf.get(appId)) || r.appSlug, said };
    })
    // By the moment it finished, not by its number: a long check started
    // earlier can finish after a quick one, and the days below follow this order.
    .sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime());
  const days = [...new Set(feed.map((r) => dayLabel(r.completedAt, now)))];
  const brief = briefing(latestPerApp(feed.filter((r) => r.appId !== null), now), shell.apps.length);
  // The check the sentence quotes, to open it inside the app (CHE-371).
  const attentionCheck = brief.attention ? feed.find((r) => r.publicId === brief.attention!.publicId) : undefined;

  // The scheduler's own gate, per watched app: a watch the balance cannot pay
  // for, or one past its trial, is not running — said here, with the way out.
  const paused = (
    await Promise.all(
      watches
        .filter((w) => w.active && w.appId)
        .map(async (w) => {
          const trial = watchTrialState(w, plan);
          if (trial.kind === "ended") return { id: w.appId!, why: "trial" as const };
          return (await appCanRun(db, { id: team.id, plan }, balance, w.appSlug)).ok ? null : { id: w.appId!, why: "balance" as const };
        }),
    )
  ).filter((p) => p !== null);

  const again = shell.apps.flatMap((a) =>
    (recurring.get(a.id) ?? []).filter((i) => i.state === "recurring").map((i) => ({ ...i, appName: a.label })),
  );
  const costly = [...health.apps].sort((a, b) => b.spendUsd - a.spendUsd);
  // The same order as the feed: the check that finished last.
  const finishedAt = (a: (typeof health.apps)[number]) => a.latest?.completedAt?.getTime() ?? 0;
  const last = [...health.apps].filter((a) => a.latest).sort((a, b) => finishedAt(b) - finishedAt(a))[0];
  const atThisPace = pace({
    creditUsd: balance.creditUsd,
    renews: balance.renewsOn !== null,
    monthlyUsd: health.monthlyRunRateUsd,
    balanceUsd: balance.balanceUsd,
    topupUsd: balance.topupUsd,
    daysToRenewal: balance.renewsOn !== null ? daysToNextMonth(now) : null,
  });
  const notice = integrationNotice(integration);
  const empty = shell.apps.length === 0 && feed.length === 0;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-10">
      {/* CHE-92: a successful onboarding lands here and is told so. */}
      {added && (
        <div className="card border-status-ok/40 bg-status-ok/5 p-4">
          <p className="text-sm text-status-ok">
            ✓ {added} is added and its first check is on the way — you&apos;ll get an email when
            the verdict is ready.
          </p>
        </div>
      )}
      {extensionAdded && (
        <div className="card border-status-ok/40 bg-status-ok/5 p-4">
          <p className="text-sm text-status-ok">✓ Extension added. Start its first check from its page.</p>
        </div>
      )}
      {notice && (
        <div className="card flex items-start justify-between gap-4 p-4">
          <p className={notice.ok ? "text-sm text-status-ok" : "text-sm text-status-confusing"}>{notice.text}</p>
          <Link href="/home" className="text-xs text-fg-muted hover:text-fg" aria-label="Dismiss">
            Dismiss ✕
          </Link>
        </div>
      )}

      {/* CHE-317: the agent is the interface. Big until one of the team's
          keys has been used, one line after that. */}
      <ConnectAgent keys={apiKeys.map((k) => ({ lastUsedAt: k.lastUsedAt?.toISOString() ?? null }))} />

      {empty ? (
        <section className="card flex flex-col items-center px-6 py-12 text-center">
          <p className="text-sm text-fg-muted">{longDate(now)}</p>
          <h1 className="mt-2 text-[28px] font-medium leading-tight tracking-tight sm:text-[34px]">Nothing is being checked yet</h1>
          <p className="mt-3 max-w-md text-sm text-fg-muted">
            Connect your agent above and ask it to add your app, or add the first one here. From then on
            this page says whether it still works.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/onboarding?path=app"
              className="inline-flex h-9 items-center rounded-lg bg-accent px-3.5 text-sm font-medium text-ink-950 transition-opacity hover:opacity-90"
            >
              Add your first app
            </Link>
            {extensionCheck && (
              <Link href="/onboarding?type=extension" className="text-sm text-accent hover:underline">
                Add an extension
              </Link>
            )}
          </div>
        </section>
      ) : (
        <>
          <section className="flex flex-col gap-4">
            <p className="text-sm text-fg-muted">{longDate(now)}</p>
            {/* Display size is the lead and "<app> needs you" only; what the
                check said is quoted below in body size, clipped (CHE-411). */}
            <h1 className="max-w-3xl text-[28px] font-medium leading-tight tracking-tight sm:text-[34px]">
              {brief.lead}
              {brief.attention && (
                <>
                  {" "}
                  <span className="text-status-risky">{brief.attention.label}</span>
                </>
              )}
            </h1>
            {brief.attention?.text && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <p className="max-w-2xl text-[15px] leading-snug text-fg-muted">{clip(brief.attention.text)}</p>
                <Link
                  href={attentionCheck ? checkHref(attentionCheck) : "/health/apps"}
                  className="inline-flex h-9 shrink-0 items-center rounded-lg bg-accent px-3.5 text-sm font-medium text-ink-950 transition-opacity hover:opacity-90"
                >
                  Open the review
                </Link>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2.5">
              {brief.attention && !brief.attention.text && (
                <Link
                  href={attentionCheck ? checkHref(attentionCheck) : "/health/apps"}
                  className="inline-flex h-9 items-center rounded-lg bg-accent px-3.5 text-sm font-medium text-ink-950 transition-opacity hover:opacity-90"
                >
                  Open the review
                </Link>
              )}
              <Link href="/health/apps" className="inline-flex h-9 items-center rounded-lg border border-ink-600 bg-ink-850 px-3.5 text-sm text-fg hover:bg-ink-800">
                All apps
              </Link>
              <Link href="/onboarding?path=app" className="text-sm text-accent hover:underline">
                Add app
              </Link>
              {extensionCheck && (
                <Link href="/onboarding?type=extension" className="text-sm text-accent hover:underline">
                  Add extension
                </Link>
              )}
            </div>
            {paused.length > 0 && (
              <ul className="flex flex-col gap-1 text-xs text-status-confusing">
                {paused.map((p) => (
                  <li key={p.id}>
                    <Link href={appPath.page(p.id)} className="font-mono hover:underline">{nameOf.get(p.id) ?? "An app"}</Link>
                    {p.why === "trial" ? (
                      <>
                        : trial ended — daily watch paused ·{" "}
                        <Link href="/pricing" className="text-accent hover:underline">Upgrade to resume →</Link>
                      </>
                    ) : (
                      <>
                        : paused, the balance is used —{" "}
                        <Link href={BALANCE_PATH} className="text-accent hover:underline">top up</Link> or{" "}
                        <Link href="/pricing" className="text-accent hover:underline">upgrade</Link>; it resumes on its own
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* The apps' costs are the tall tile; the balance and what keeps
              coming back stack beside it, the second taking the rest of the
              height — three tiles in a row left two of them mostly empty. */}
          <div className="grid gap-4 md:grid-cols-2 md:grid-rows-[auto_1fr]">
            <Tile label="Your apps cost" className="md:row-span-2">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[28px] leading-none">{usd(health.appsMonthlyUsd)}</span>
                <span className="text-fg-muted">a month</span>
              </div>
              <div className="flex flex-col gap-2.5 pt-1">
                {costly.map((a) => (
                  <div key={a.appId} className="flex flex-col gap-1">
                    <div className="flex justify-between gap-3 text-[13px]">
                      <Link href={appPath.page(a.appId)} className="truncate font-mono hover:underline">{nameOf.get(a.appId) ?? a.appSlug}</Link>
                      <span className="font-mono">{usd(a.spendUsd)}</span>
                    </div>
                    <span className="block h-[5px] rounded-full bg-ink-700">
                      <span className="block h-[5px] rounded-full bg-accent" style={{ width: `${sharePercent(a.spendUsd, health.totalSpendUsd)}%` }} />
                    </span>
                  </div>
                ))}
              </div>
              {last?.latest && (
                <div className="mt-auto flex flex-col gap-1 border-t border-ink-800 pt-3 text-[13px]">
                  <span className="flex justify-between gap-3">
                    <span className="truncate">Last check, {nameOf.get(last.appId) ?? last.appSlug}</span>
                    <CheckPrice explanation={last.latest.price} label={null} title={`${nameOf.get(last.appId) ?? last.appSlug}, check #${last.latest.runNumber}`} />
                  </span>
                  <span className="text-fg-muted">
                    {last.latest.price.work}.
                    {last.latest.price.comparison && last.latest.price.comparison !== QUICK_COMPARISON ? ` ${last.latest.price.comparison}` : ""}
                  </span>
                </div>
              )}
              <Link href={BALANCE_PATH} className="text-[13px] text-accent hover:underline">What each app costs</Link>
            </Tile>

            <Tile label="Balance">
              <div className="font-mono text-[28px] leading-none">{balance.balanceUsd === null ? "Unlimited" : usd(balance.balanceUsd)}</div>
              <div className="text-[13px] text-fg-muted">
                {balanceLine({ plan: team.plan, creditUsd: balance.creditUsd, renewsOn: balance.renewsOn, topupUsd: balance.topupUsd, usd })}{" "}
                {atThisPace.headline}.
              </div>
            </Tile>

            <Tile label="Keeps coming back">
              {again.length === 0 ? (
                <div className="text-[15px]">Nothing right now.</div>
              ) : (
                <ul className="flex flex-col gap-2">
                  {again.slice(0, 3).map((i) => (
                    <li key={`${i.appId}:${i.signature}`} className="text-[13px]">
                      <span className="text-status-risky">{i.title}</span>
                      <span className="block text-fg-muted">
                        <Link href={appPath.page(i.appId)} className="font-mono hover:underline">{i.appName}</Link>
                        {" · "}seen in {i.timesSeen} checks in a row, #{i.firstSeenRunNumber} to #{i.lastSeenRunNumber}
                      </span>
                    </li>
                  ))}
                  {again.length > 3 && <li className="text-[13px] text-fg-muted">and {again.length - 3} more</li>}
                </ul>
              )}
            </Tile>
          </div>

          <section aria-label="Checks of today and yesterday">
            {days.length === 0 && <p className="text-sm text-fg-muted">No checks today or yesterday.</p>}
            {days.map((day) => (
              <div key={day}>
                <div className="border-b border-ink-700 pb-2 pt-4 text-xs text-fg-muted">
                  {day} <span className="text-fg-faint">· times in UTC</span>
                </div>
                {feed
                  .filter((r) => dayLabel(r.completedAt, now) === day)
                  .map((r) => {
                    const v = VERDICT_META[r.verdict];
                    return (
                      <div key={r.publicId} className="grid grid-cols-[44px_10px_minmax(0,1fr)_56px] items-start gap-3 border-b border-ink-800 py-4">
                        <span className="font-mono text-[13px] text-fg-muted">{hhmm(r.completedAt)}</span>
                        <span aria-hidden className={`mt-1.5 h-2 w-2 rounded-full ${v?.dotClassName ?? "bg-ink-600"}`} />
                        <div className="flex min-w-0 flex-col gap-1">
                          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                            {r.appId ? (
                              <Link href={appPath.page(r.appId)} className="truncate font-mono text-sm text-fg hover:underline">{r.name}</Link>
                            ) : (
                              <span className="truncate font-mono text-sm">{r.name}</span>
                            )}
                            <span className={`inline-flex h-6 items-center whitespace-nowrap rounded-full border px-2.5 text-xs font-medium ${v?.pillClassName ?? "border-ink-600 text-fg-faint"}`}>
                              {v?.label ?? r.verdict}
                            </span>
                            <Link href={checkHref(r)} className="font-mono text-[13px] text-accent hover:underline">
                              #{r.runNumber}
                            </Link>
                          </div>
                          {r.said && <span className="text-sm">{r.said}</span>}
                        </div>
                        {/* The price opens its reason, loaded for the one check asked about. */}
                        <span className="text-right text-sm">
                          <CheckPrice publicId={r.publicId} priceUsd={r.priceUsd!} label={null} title={`${r.name}, check #${r.runNumber}`} />
                        </span>
                      </div>
                    );
                  })}
              </div>
            ))}
            <Link href="/health/checks" className="mt-4 inline-block text-sm text-accent hover:underline">
              Earlier checks
            </Link>
          </section>
        </>
      )}
    </main>
  );
}
