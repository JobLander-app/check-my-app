import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { can } from "@/lib/scopes";
import { TOPUP_AMOUNTS_USD, teamBalance, usd } from "@/lib/plans";
import type { UserPlan } from "@/lib/enums";
import { appHealth, type AppHealth } from "@/lib/app-health";
import { shellData } from "@/lib/shell-data";
import { appPath } from "@/lib/app-shell";
import { FOLD, TABLE_CLASS } from "@/lib/table-fold";
import { appsCostLine, balanceLine, countLine, daysToNextMonth, outsideApps, pace, sharePercent } from "@/lib/billing-page";
import { TopUpCta } from "@/components/topup-cta";
import { ManageBillingButton } from "@/components/manage-billing-button";
import { CheckPrice } from "@/components/check-price";

const TH = "whitespace-nowrap border-b border-ink-700 px-3 py-2.5 text-left text-xs font-medium text-fg-muted first:pl-[18px] last:pr-[18px]";
const TD = "border-b border-ink-800 px-3 py-3.5 align-middle first:pl-[18px] last:pr-[18px]";

const Tile = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="card flex flex-col gap-1.5 p-5">
    <span className="text-[13px] text-fg-muted">{label}</span>
    {children}
  </div>
);

// The last check's price, which opens what that check did in the price modal
// (CHE-411), with the check's number, which opens the check: under the price
// in a row, beside it in a card.
function LastCheck({ app, name, inline = false }: { app: AppHealth; name: string; inline?: boolean }) {
  if (!app.latest) return <span className="text-xs text-fg-faint">no check yet</span>;
  return (
    <>
      <CheckPrice explanation={app.latest.price} label={null} title={`${name}, check #${app.latest.runNumber}`} />
      <Link
        href={appPath.check(app.appId, app.latest.runNumber)}
        className={`font-mono text-xs text-fg-muted hover:text-accent hover:underline ${inline ? "" : "mt-0.5 block"}`}
      >
        #{app.latest.runNumber}
      </Link>
    </>
  );
}

// Billing (CHE-355, direction C): what the apps cost a month, the balance, and
// how the two relate; then each app — its 30 days, a day, who started the
// checks, its share — and its last check's price, which opens into what that
// check did for it (the price modal, CHE-411). Top-ups, invoices and the plan
// are below. Prices only (CLAUDE.md §10).
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ topped_up?: string }>;
}) {
  const { topped_up: toppedUp } = await searchParams;
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
        // The table fits the work area at every width (src/lib/table-fold.ts):
        // a day and the share are columns on a wide screen and lines under the
        // window's amount until then; below the sidebar's width each app is a
        // card. A team with no saved app but paid checks (previews, one-off
        // addresses) still gets its one row.
        <section className="card">
          <div className="flex flex-wrap items-baseline justify-between gap-2 px-[18px] pb-3 pt-[18px]">
            <h2 className="text-[17px] font-semibold">What each app costs</h2>
            <span className="text-[13px] text-fg-muted">Click a price to see what the check did for it</span>
          </div>
          <div className={FOLD.tableClassName}>
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <th className={TH}>App</th>
                  <th className={`${TH} w-[104px] text-right`}>Last {health.windowDays} days</th>
                  <th className={`${TH} w-[84px] text-right ${FOLD.wideColumnClassName}`}>A day</th>
                  <th className={`${TH} w-[116px] text-right`}>Scheduled</th>
                  <th className={`${TH} w-[116px] text-right`}>On request</th>
                  <th className={`${TH} w-[136px] ${FOLD.wideColumnClassName}`}>Share</th>
                  <th className={`${TH} w-[104px] text-right`}>Last check</th>
                </tr>
              </thead>
              <tbody>
                {apps.map((app) => (
                  <tr key={app.appId}>
                    <td className={`${TD} font-mono`}>
                      <Link href={appPath.page(app.appId)} title={nameOf.get(app.appId) ?? app.appSlug} className="block truncate text-fg hover:underline">
                        {nameOf.get(app.appId) ?? app.appSlug}
                      </Link>
                      <span className={`mt-1.5 block h-1.5 max-w-[160px] rounded-full bg-ink-700 ${FOLD.foldedClassName}`}>
                        <span className="block h-1.5 rounded-full bg-accent" style={{ width: `${sharePercent(app.spendUsd, health.totalSpendUsd)}%` }} />
                      </span>
                    </td>
                    <td className={`${TD} whitespace-nowrap text-right`}>
                      <span className="font-mono text-[15px]">{usd(app.spendUsd)}</span>
                      <span className={`block font-mono text-xs text-fg-muted ${FOLD.foldedClassName}`}>{usd(app.perDayUsd)} a day</span>
                    </td>
                    <td className={`${TD} text-right font-mono text-fg-muted ${FOLD.wideColumnClassName}`}>{usd(app.perDayUsd)}</td>
                    <td className={`${TD} whitespace-nowrap text-right`}>
                      <span className="font-mono">{usd(app.scheduled.usd)}</span>
                      <span className="block text-xs text-fg-muted">{countLine(app.scheduled.count, "not scheduled")}</span>
                    </td>
                    <td className={`${TD} whitespace-nowrap text-right`}>
                      <span className="font-mono">{usd(app.onRequest.usd)}</span>
                      <span className="block text-xs text-fg-muted">{countLine(app.onRequest.count, "none")}</span>
                    </td>
                    <td className={`${TD} ${FOLD.wideColumnClassName}`}>
                      <span className="block h-1.5 rounded-full bg-ink-700">
                        <span className="block h-1.5 rounded-full bg-accent" style={{ width: `${sharePercent(app.spendUsd, health.totalSpendUsd)}%` }} />
                      </span>
                    </td>
                    <td className={`${TD} whitespace-nowrap text-right`}>
                      <LastCheck app={app} name={nameOf.get(app.appId) ?? app.appSlug} />
                    </td>
                  </tr>
                ))}
                {outside && (
                  <tr>
                    <td className={`${TD} text-fg-muted`}>
                      Outside your apps
                      <span className="block text-xs text-fg-faint">previews, one-off addresses, removed apps</span>
                      <span className={`mt-1.5 block h-1.5 max-w-[160px] rounded-full bg-ink-700 ${FOLD.foldedClassName}`}>
                        <span className="block h-1.5 rounded-full bg-accent" style={{ width: `${sharePercent(outside.usd, health.totalSpendUsd)}%` }} />
                      </span>
                    </td>
                    <td className={`${TD} whitespace-nowrap text-right`}>
                      <span className="font-mono text-[15px]">{usd(outside.usd)}</span>
                      <span className="block text-xs text-fg-muted">{countLine(outside.checks, "none")}</span>
                    </td>
                    <td className={`${TD} ${FOLD.wideColumnClassName}`} />
                    {/* Not split: a removed app's checks lose their schedule with it. */}
                    <td className={TD} />
                    <td className={TD} />
                    <td className={`${TD} ${FOLD.wideColumnClassName}`}>
                      <span className="block h-1.5 rounded-full bg-ink-700">
                        <span className="block h-1.5 rounded-full bg-accent" style={{ width: `${sharePercent(outside.usd, health.totalSpendUsd)}%` }} />
                      </span>
                    </td>
                    <td className={TD} />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <ul className={`${FOLD.cardsClassName} px-[18px] pb-[18px]`}>
            {apps.map((app) => (
              <li key={app.appId} className="flex flex-col gap-2 rounded-lg border border-ink-700 px-4 py-3.5">
                <div className="flex items-baseline justify-between gap-3">
                  <Link href={appPath.page(app.appId)} className="truncate font-mono text-fg hover:underline">
                    {nameOf.get(app.appId) ?? app.appSlug}
                  </Link>
                  <span className="whitespace-nowrap font-mono text-[15px]">{usd(app.spendUsd)}</span>
                </div>
                <span className="block h-1.5 rounded-full bg-ink-700">
                  <span className="block h-1.5 rounded-full bg-accent" style={{ width: `${sharePercent(app.spendUsd, health.totalSpendUsd)}%` }} />
                </span>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
                  <span>
                    <span className="font-mono">{usd(app.perDayUsd)}</span> a day
                  </span>
                  <span>
                    <span className="font-mono">{usd(app.scheduled.usd)}</span> scheduled, {countLine(app.scheduled.count, "none")}
                  </span>
                  <span>
                    <span className="font-mono">{usd(app.onRequest.usd)}</span> on request, {countLine(app.onRequest.count, "none")}
                  </span>
                </div>
                <div className="flex items-baseline gap-2 text-xs text-fg-muted">
                  Last check
                  <LastCheck app={app} name={nameOf.get(app.appId) ?? app.appSlug} inline />
                </div>
              </li>
            ))}
            {outside && (
              <li className="flex flex-col gap-2 rounded-lg border border-ink-700 px-4 py-3.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-fg-muted">Outside your apps</span>
                  <span className="whitespace-nowrap font-mono text-[15px]">{usd(outside.usd)}</span>
                </div>
                <span className="block h-1.5 rounded-full bg-ink-700">
                  <span className="block h-1.5 rounded-full bg-accent" style={{ width: `${sharePercent(outside.usd, health.totalSpendUsd)}%` }} />
                </span>
                <span className="text-xs text-fg-muted">
                  {countLine(outside.checks, "none")} · <span className="text-fg-faint">previews, one-off addresses, removed apps</span>
                </span>
              </li>
            )}
          </ul>
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
