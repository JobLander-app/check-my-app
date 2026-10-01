import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { can } from "@/lib/scopes";
import { TOPUP_AMOUNTS_USD, spendByApp, teamBalance, usd } from "@/lib/plans";
import type { UserPlan } from "@/lib/enums";
import { TopUpCta } from "@/components/topup-cta";
import { ManageBillingButton } from "@/components/manage-billing-button";

// Billing (CHE-351 shell): the balance card that was /dashboard#balance, and
// the Stripe portal that was on the team's settings. What each app costs a
// month and a day, with the last check's price and why, is CHE-355.
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ topped_up?: string }>;
}) {
  const { topped_up: toppedUp } = await searchParams;
  const { db, team, scope } = await requireUser();
  const plan = team.plan as UserPlan;
  // CHE-327: the balance is the plan. Headline = what is left and what this
  // period's checks came to, with where it went; each check's own price lives
  // on its verdict, next to the work it paid for.
  const balance = await teamBalance(db, { id: team.id, plan });
  const spend = await spendByApp(db, { id: team.id, plan });
  const mayBill = can(scope, "billing.manage");

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Billing</h1>

      <section id="balance" className="card mb-6 space-y-3 p-5">
        {toppedUp && (
          <p className="text-sm text-status-ok">
            ✓ Payment received — your balance goes up by ${toppedUp} as soon as the payment settles.
          </p>
        )}
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <p className="text-sm text-fg-muted">Balance</p>
            <p className="text-2xl font-semibold tracking-tight text-fg">
              {balance.balanceUsd === null ? "Unlimited" : usd(balance.balanceUsd)}
            </p>
            <p className="text-xs text-fg-muted">
              {usd(balance.spentUsd)} spent {balance.window === "month" ? "this month" : "so far"}
              {balance.renewsOn && balance.creditUsd !== null
                ? ` · your plan adds ${usd(balance.creditUsd)} on ${balance.renewsOn}`
                : ""}
              {balance.topupUsd > 0 ? ` · ${usd(balance.topupUsd)} of it topped up` : ""}
            </p>
          </div>
          <Link href="/pricing" className="text-xs text-accent hover:underline">
            Upgrade →
          </Link>
        </div>
        {spend.length > 0 && (
          <ul className="space-y-0.5 text-xs text-fg-muted">
            {spend.slice(0, 5).map((s) => (
              <li key={s.appSlug} className="flex justify-between gap-4 font-mono">
                <span className="truncate">
                  {s.appSlug} · {s.checks} check{s.checks === 1 ? "" : "s"}
                </span>
                <span>{usd(s.spentUsd)}</span>
              </li>
            ))}
          </ul>
        )}
        {balance.balanceUsd !== null &&
          (mayBill ? (
            <TopUpCta amounts={TOPUP_AMOUNTS_USD} />
          ) : (
            <p className="text-xs text-fg-faint">Top-ups are made by this team&apos;s admins.</p>
          ))}
      </section>

      <section className="card p-5">
        <h2 className="text-lg font-medium">Plan</h2>
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
