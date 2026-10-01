import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { can } from "@/lib/scopes";
import { seatSummary } from "@/lib/seats";
import { PLAN_LIMITS, teamBalance, usd } from "@/lib/plans";
import type { UserPlan } from "@/lib/enums";
import type { TeamScope } from "@/lib/scopes";
import { ManageBillingButton } from "@/components/manage-billing-button";
import { buttonClass } from "@/components/ui/button";
import { teamOwned } from "@/lib/tenant-db";

// CHE-277 — the team's settings: everything where one person spends the team's
// money, access or credibility (src/lib/settings-boundary.ts).
//
// What is deliberately NOT here: anything about one app. The tracker project,
// the analytics project, test credentials and write mode live on the app's own
// page, because they are properties of an app the way its URL is — and a
// settings page listing four apps × three integrations answers "where do I
// change this?" with "somewhere else".
export default async function TeamSettingsPage() {
  const { db, team, scope } = await requireUser();

  const memberships = await db.membership.findMany({
    where: { teamId: team.id },
    select: { scope: true },
  });
  const members = memberships.map((m) => ({ scope: m.scope as TeamScope }));
  const pendingInvites = await db.teamInvite.count({
    where: { teamId: team.id, acceptedAt: null, revokedAt: null },
  });
  const apiKeys = await db.apiKey.count({ where: { ...teamOwned(team.id) } });

  const mayBill = can(scope, "billing.manage");
  const mayInvite = can(scope, "member.invite");
  const limits = PLAN_LIMITS[team.plan as UserPlan];
  const balance = await teamBalance(db, { id: team.id, plan: team.plan as UserPlan });

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12">
      <header className="mb-8">
        <p className="font-mono text-xs uppercase tracking-wider text-fg-muted">Team settings</p>
        <h1 className="mt-1 text-2xl font-semibold">{team.name}</h1>
        <p className="mt-2 text-sm text-fg-muted">
          Everything here is felt by everyone on the team. What only affects you —
          which apps mail you, which team you are acting as — is on{" "}
          <Link href="/settings/account" className="text-accent hover:underline">
            your own settings
          </Link>
          .
        </p>
      </header>

      <section className="card p-6">
        <h2 className="text-lg font-medium">People</h2>
        <p className="mt-2 text-sm text-fg-muted">
          {members.length === 1
            ? "Just you, for now."
            : `${members.length} people.`}{" "}
          {seatSummary(team.plan as UserPlan, members)}
          {pendingInvites > 0 &&
            ` ${pendingInvites} invitation${pendingInvites === 1 ? "" : "s"} waiting to be accepted.`}
        </p>
        <Link href="/team" className={buttonClass("outline", "mt-4")}>
          {mayInvite ? "Manage people and invitations" : "See who is on the team"}
        </Link>
      </section>

      <section className="card mt-6 p-6">
        <h2 className="text-lg font-medium">Plan and billing</h2>
        <p className="mt-2 text-sm text-fg-muted">
          On <strong>{team.plan}</strong>:{" "}
          {balance.balanceUsd === null
            ? "unlimited checks."
            : `${usd(balance.balanceUsd)} left${balance.renewsOn ? ` — the plan adds ${usd(limits.creditUsd ?? 0)} on ${balance.renewsOn}` : ""}.`}{" "}
          <Link href="/dashboard#balance" className="text-accent hover:underline">
            Balance and top-up
          </Link>
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
          <p className="mt-4 text-sm text-fg-muted">
            Billing is handled by this team&apos;s admins.
          </p>
        )}
      </section>

      <section className="card mt-6 p-6">
        <h2 className="text-lg font-medium">API keys</h2>
        <p className="mt-2 text-sm text-fg-muted">
          {apiKeys === 0
            ? "None yet."
            : `${apiKeys} key${apiKeys === 1 ? "" : "s"}, belonging to the team rather than to whoever made ${apiKeys === 1 ? "it" : "them"}.`}{" "}
          A key carries its own access: a reader key can read every verdict over the API and start
          nothing.
        </p>
        <Link href="/dashboard" className={buttonClass("outline", "mt-4")}>
          {can(scope, "apikey.manage") ? "Manage API keys" : "See API keys"}
        </Link>
      </section>

      <section className="card mt-6 p-6">
        <h2 className="text-lg font-medium">Integrations</h2>
        <p className="mt-2 text-sm text-fg-muted">
          Connections the whole team shares — your issue tracker and your analytics. Connect once
          here; which project or board a given app uses is set on that app, next to everything else
          about it.
        </p>
        <Link href="/dashboard" className={buttonClass("outline", "mt-4")}>
          Open the dashboard
        </Link>
      </section>

      <section className="card mt-6 p-6">
        <h2 className="text-lg font-medium">What has happened here</h2>
        <p className="mt-2 text-sm text-fg-muted">
          Invitations, access changes and billing are recorded with who did them and when.
        </p>
        <Link href="/team" className={buttonClass("outline", "mt-4")}>
          See the team log
        </Link>
      </section>
    </main>
  );
}
