import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { can } from "@/lib/scopes";
import { TOPUP_AMOUNTS_USD, teamBalance, usd } from "@/lib/plans";
import type { UserPlan } from "@/lib/enums";
import { appHealth } from "@/lib/app-health";
import { shellData } from "@/lib/shell-data";
import { appPath } from "@/lib/app-shell";
import { appsCostLine, balanceLine, countLine, daysToNextMonth, outsideApps, pace, sharePercent } from "@/lib/billing-page";
import { TopUpCta } from "@/components/topup-cta";
import { ManageBillingButton } from "@/components/manage-billing-button";

const TH = "whitespace-nowrap border-b border-ink-700 px-3 py-2.5 text-left text-xs font-medium text-fg-muted first:pl-[18px] last:pr-[18px]";
const TD = "border-b border-ink-800 px-3 py-3.5 align-middle first:pl-[18px] last:pr-[18px]";

const Tile = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="card flex flex-col gap-1.5 p-5">
    <span className="text-[13px] text-fg-muted">{label}</span>
    {children}
  </div>
);

// Billing (CHE-355, direction C): what the apps cost a month, the balance, and
// how the two relate; then each app — its 30 days, a day, who started the
// checks, its share — and its last check's price, which opens into what that
// check did for it (?check=<appId>, rendered on the server: a link, no script).
// Top-ups, invoices and the plan are below. Prices only (CLAUDE.md §10).
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ topped_up?: string; check?: string }>;
}) {
  const { topped_up: toppedUp, check } = await searchParams;
  const { db, team, scope } = await requireUser();
  const plan = team.plan as UserPlan;
  const [balance, health, shell] = await Promise.all([
    teamBalance(db, { id: team.id, plan }),
    appHealth(db, team.id),
    shellData(db, team.id),
  ]);
  const mayBill = can(scope, "billing.manage");
  const nameOf = new Map(shell.apps.map((a) => [a.id, a.label]));
  const apps = [...health.apps].sort((a, b) => b.spendUsd - a.spendUsd);
  // What was paid for outside the apps (a PR preview, an address never saved):
  // in the total, in no app — so it gets its own row.
  const outside = outsideApps({ usd: health.totalSpendUsd, checks: health.totalChecks }, apps);
  const withCheck = apps.filter((a) => a.latest);
  // The opened check: the one the address names, else the first app's.
  const opened = withCheck.find((a) => a.appId === check) ?? withCheck[0];
  const atThisPace = pace({
    creditUsd: balance.creditUsd,
    renews: balance.renewsOn !== null,
    // Everything the balance pays for, the apps and what was outside them.
    monthlyUsd: health.monthlyRunRateUsd,
    balanceUsd: balance.balanceUsd,
    topupUsd: balance.topupUsd,
    daysToRenewal: balance.renewsOn !== null ? daysToNextMonth(new Date()) : null,
  });
  const appsSpendUsd = apps.reduce((s, a) => s + a.spendUsd, 0);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1 text-[13px] text-fg-muted">Settings</p>
          <h1 className="text-[30px] font-semibold leading-tight tracking-tight">Billing</h1>
        </div>
        <Link href="/pricing" className="inline-flex h-9 items-center rounded-lg border border-ink-600 bg-ink-850 px-3.5 text-sm text-fg hover:bg-ink-800">
          Change plan
        </Link>
      </header>

      {toppedUp && (
        <p className="card p-4 text-sm text-status-ok">
          ✓ Payment received — your balance goes up by ${toppedUp} as soon as the payment settles.
        </p>
      )}

      <section id="balance" className="grid gap-4 md:grid-cols-3">
        <Tile label="Your apps cost">
          <span className="flex items-baseline gap-2">
            <span className="font-mono text-[32px] leading-none">{usd(health.appsMonthlyUsd)}</span>
            <span className="text-fg-muted">a month</span>
          </span>
          <span className="text-[13px] text-fg-muted">
            {appsCostLine({
              windowDays: health.windowDays,
              apps: apps.length,
              checks: apps.reduce((n, a) => n + a.checks, 0),
              perDayUsd: appsSpendUsd / health.windowDays,
              outsideUsd: outside?.usd,
              usd,
            })}
          </span>
        </Tile>
        <Tile label="Balance">
          <span className="font-mono text-[32px] leading-none">{balance.balanceUsd === null ? "Unlimited" : usd(balance.balanceUsd)}</span>
          <span className="text-[13px] text-fg-muted">
            {balanceLine({ plan: team.plan, creditUsd: balance.creditUsd, renewsOn: balance.renewsOn, topupUsd: balance.topupUsd, usd })}
          </span>
        </Tile>
        <Tile label="At this pace">
          <span className="text-[22px] font-semibold leading-tight">{atThisPace.headline}</span>
          <span className="text-[13px] text-fg-muted">{atThisPace.detail}</span>
        </Tile>
      </section>

      {(apps.length > 0 || outside) && (
        // The table scrolls inside its card; the page never scrolls sideways.
        // A team with no saved app but paid checks (previews, one-off
        // addresses) still gets its one row.
        <section className="card overflow-x-auto">
          <div className="flex flex-wrap items-baseline justify-between gap-2 px-[18px] pb-3 pt-[18px]">
            <h2 className="text-[17px] font-semibold">What each app costs</h2>
            <span className="text-[13px] text-fg-muted">Click a price to see what the check did for it</span>
          </div>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className={TH}>App</th>
                <th className={`${TH} text-right`}>Last {health.windowDays} days</th>
                <th className={`${TH} text-right`}>A day</th>
                <th className={`${TH} text-right`}>Scheduled</th>
                <th className={`${TH} text-right`}>On request</th>
                <th className={TH}>Share</th>
                <th className={`${TH} text-right`}>Last check</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((app) => (
                <tr key={app.appId}>
                  <td className={`${TD} font-mono`}>
                    <Link href={appPath.page(app.appId)} className="whitespace-nowrap text-fg hover:underline">
                      {nameOf.get(app.appId) ?? app.appSlug}
                    </Link>
                  </td>
                  <td className={`${TD} text-right font-mono text-[15px]`}>{usd(app.spendUsd)}</td>
                  <td className={`${TD} text-right font-mono text-fg-muted`}>{usd(app.perDayUsd)}</td>
                  <td className={`${TD} whitespace-nowrap text-right`}>
                    <span className="font-mono">{usd(app.scheduled.usd)}</span>
                    <span className="block text-xs text-fg-muted">{countLine(app.scheduled.count, "not scheduled")}</span>
                  </td>
                  <td className={`${TD} whitespace-nowrap text-right`}>
                    <span className="font-mono">{usd(app.onRequest.usd)}</span>
                    <span className="block text-xs text-fg-muted">{countLine(app.onRequest.count, "none")}</span>
                  </td>
                  <td className={`${TD} w-40`}>
                    <span className="block h-1.5 min-w-24 rounded-full bg-ink-700">
                      <span className="block h-1.5 rounded-full bg-accent" style={{ width: `${sharePercent(app.spendUsd, health.totalSpendUsd)}%` }} />
                    </span>
                  </td>
                  <td className={`${TD} whitespace-nowrap text-right`}>
                    {app.latest ? (
                      <>
                        <Link
                          href={`/settings/billing?check=${app.appId}#check`}
                          aria-current={opened?.appId === app.appId ? "true" : undefined}
                          className={`font-mono underline decoration-dotted underline-offset-2 ${opened?.appId === app.appId ? "text-accent" : "text-fg hover:text-accent"}`}
                        >
                          {usd(app.latest.priceUsd)}
                        </Link>
                        <span className="mt-0.5 block font-mono text-xs text-fg-muted">#{app.latest.runNumber}</span>
                      </>
                    ) : (
                      <span className="text-xs text-fg-faint">no check yet</span>
                    )}
                  </td>
                </tr>
              ))}
              {outside && (
                <tr>
                  <td className={`${TD} text-fg-muted`}>Outside your apps</td>
                  <td className={`${TD} whitespace-nowrap text-right`}>
                    <span className="font-mono text-[15px]">{usd(outside.usd)}</span>
                    <span className="block text-xs text-fg-muted">{countLine(outside.checks, "none")}</span>
                  </td>
                  <td className={TD} />
                  {/* Not split: a removed app's checks lose their schedule with it. */}
                  <td className={TD} />
                  <td className={TD} />
                  <td className={`${TD} w-40`}>
                    <span className="block h-1.5 min-w-24 rounded-full bg-ink-700">
                      <span className="block h-1.5 rounded-full bg-accent" style={{ width: `${sharePercent(outside.usd, health.totalSpendUsd)}%` }} />
                    </span>
                  </td>
                  <td className={`${TD} text-right text-xs text-fg-faint`}>previews, one-off addresses, removed apps</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      {opened?.latest && (
        <section id="check" className="card flex scroll-mt-6 flex-col gap-3.5 p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-[17px] font-semibold">
              {nameOf.get(opened.appId) ?? opened.appSlug}, check #{opened.latest.runNumber}:{" "}
              <span className="font-mono">{usd(opened.latest.priceUsd)}</span>
            </h2>
            <Link href={appPath.check(opened.appId, opened.latest.runNumber)} className="text-sm text-accent hover:underline">
              Open review
            </Link>
          </div>
          <p className="text-[15px]">
            {opened.latest.price.work}.{" "}
            {opened.latest.price.comparison && <span className="text-fg-muted">{opened.latest.price.comparison}</span>}
          </p>
          {opened.latest.price.parts.length > 0 && (
            <ul className="flex flex-col">
              {opened.latest.price.parts.map((p) => (
                <li key={p.label} className="flex justify-between gap-4 border-b border-ink-800 py-2 text-sm last:border-b-0">
                  <span className="min-w-0">
                    {p.label}
                    {p.steps !== undefined && <span className="text-[13px] text-fg-muted"> {p.steps} step{p.steps === 1 ? "" : "s"}</span>}
                  </span>
                  <span className="font-mono">{usd(p.price_usd)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {balance.balanceUsd !== null && (
        <section className="card flex flex-wrap items-center justify-between gap-4 p-5">
          <div>
            <div className="text-base font-semibold">Add to the balance</div>
            <div className="text-[13px] text-fg-muted">
              {balance.renewsOn ? "Used only after the plan's monthly amount runs out." : "Added to what is left of the plan's amount."}
            </div>
          </div>
          {mayBill ? (
            <TopUpCta amounts={TOPUP_AMOUNTS_USD} />
          ) : (
            <p className="text-xs text-fg-faint">Top-ups are made by this team&apos;s admins.</p>
          )}
        </section>
      )}

      <section className="card p-5">
        <h2 className="text-[17px] font-semibold">Invoices and card</h2>
        <p className="mt-1 text-sm text-fg-muted">
          {team.name} is on <strong className="text-fg">{team.plan}</strong>.
        </p>
        {mayBill ? (
          <>
            <ManageBillingButton />
            <p className="mt-2 text-xs text-fg-muted">
              Payment method, invoices and cancellation are handled by Stripe — we do not keep a
              second copy of them to disagree with your card statement.
            </p>
          </>
        ) : (
          <p className="mt-4 text-sm text-fg-muted">Billing is handled by this team&apos;s admins.</p>
        )}
      </section>
    </main>
  );
}
