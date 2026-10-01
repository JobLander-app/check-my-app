import { requireUser } from "@/lib/auth";
import { can } from "@/lib/scopes";
import { REMOVAL_KEEPS_EVERYTHING, decideLeave } from "@/lib/membership";
import { inviteState } from "@/lib/invites";
import { describeEvent } from "@/lib/team-events";
import { seatSummary } from "@/lib/seats";
import type { UserPlan } from "@/lib/enums";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  changeScopeAction,
  inviteMemberAction,
  leaveTeamAction,
  removeMemberAction,
  revokeInviteAction,
} from "./actions";

// CHE-258 (Teams T5): who is on the team, what they may do, and who invited
// them — readable by everyone on the team, editable by its admins.
//
// The page offers exactly the controls the server would honour: `can()` is the
// same table both sides read (CHE-254). A control that fails on click is the
// defect this product flags on other people's apps, and doing it to a colleague
// is worse than doing it to a stranger — they report it as a bug rather than
// assuming they lack access.
export default async function TeamPage() {
  const { user, db, team, scope } = await requireUser();

  const memberships = await db.membership.findMany({
    where: { teamId: team.id },
    select: {
      userId: true,
      scope: true,
      createdAt: true,
      invitedByUserId: true,
      user: { select: { email: true, name: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const invites = await db.teamInvite.findMany({
    where: { teamId: team.id, acceptedAt: null, revokedAt: null },
    select: { id: true, email: true, scope: true, expiresAt: true, acceptedAt: true, revokedAt: true, revokedReason: true, teamId: true },
    orderBy: { createdAt: "desc" },
  });
  const pending = invites.filter((i) => inviteState(i) === "pending");

  const inviterEmail = new Map(memberships.map((m) => [m.userId, m.user.email]));
  const actorEmail = inviterEmail;
  // CHE-264: readable by everyone on the team. It is an account log — never
  // anything a customer reads about their own product (rule 1).
  const events = await db.teamEvent.findMany({
    where: { teamId: team.id },
    orderBy: { createdAt: "desc" },
    take: 25,
    select: { id: true, action: true, subject: true, summary: true, actorUserId: true, createdAt: true },
  });
  const mayManage = can(scope, "member.scope.change");
  const mayInvite = can(scope, "member.invite");
  const canLeave = decideLeave(
    memberships.map((m) => ({ userId: m.userId, scope: m.scope as "admin" | "member" | "reader" })),
    user.id,
  );

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">{team.name}</h1>
        <p className="mt-1 text-sm text-fg-muted">
          {memberships.length === 1
            ? "Just you, for now. Invite someone and they see the same checks you do."
            : `${memberships.length} people. Everyone here reads the same checks; what they can change depends on their access.`}
        </p>
      </header>

      <section className="card p-6">
        <h2 className="text-lg font-medium">People</h2>
        <ul className="mt-4 divide-y divide-ink-700">
          {memberships.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0 flex-1 basis-64">
                <p className="text-sm">
                  {m.user.name?.trim() || m.user.email}
                  {m.userId === user.id && <span className="text-fg-muted"> — you</span>}
                </p>
                <p className="text-xs text-fg-muted">
                  {m.user.email} · joined {m.createdAt.toISOString().slice(0, 10)}
                  {m.invitedByUserId && inviterEmail.get(m.invitedByUserId)
                    ? ` · invited by ${inviterEmail.get(m.invitedByUserId)}`
                    : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {mayManage ? (
                  // Keyed on the scope: after Save, React resets the form to the
                  // select's mount-time default, which would show the old scope
                  // until a reload. A new scope is a new form.
                  <form key={m.scope} action={changeScopeAction.bind(null, m.userId)} className="flex items-center gap-2">
                    <Select name="scope" defaultValue={m.scope} className="w-auto py-1.5" aria-label={`Access for ${m.user.email}`}>
                      <option value="admin">admin</option>
                      <option value="member">member</option>
                      <option value="reader">reader</option>
                    </Select>
                    <Button type="submit" variant="outline" className="py-1.5">Save</Button>
                  </form>
                ) : (
                  <span className="text-sm text-fg-muted">{m.scope}</span>
                )}
                {mayManage && m.userId !== user.id && (
                  <form action={removeMemberAction.bind(null, m.userId)}>
                    <Button type="submit" variant="outline" className="py-1.5">Remove</Button>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-fg-muted">{seatSummary(team.plan as UserPlan, memberships.map((m) => ({ scope: m.scope as "admin" | "member" | "reader" })))}</p>
        {mayManage && <p className="mt-4 text-xs text-fg-muted">{REMOVAL_KEEPS_EVERYTHING}</p>}
      </section>

      {mayInvite && (
        <section className="card mt-6 p-6">
          <h2 className="text-lg font-medium">Invite someone</h2>
          <form action={inviteMemberAction} className="mt-4 flex flex-wrap items-end gap-3">
            <label className="w-full">
              <span className="text-xs text-fg-muted">Email</span>
              <Input name="email" type="email" required className="mt-1" placeholder="colleague@company.com" />
            </label>
            <label className="min-w-0 flex-1 basis-64">
              <span className="text-xs text-fg-muted">Access</span>
              <Select name="scope" defaultValue="member" className="mt-1">
                <option value="admin">admin — everything, including billing</option>
                <option value="member">member — run checks and act on findings</option>
                <option value="reader">reader — read everything, spend nothing</option>
              </Select>
            </label>
            <Button type="submit">Send invitation</Button>
          </form>

          {pending.length > 0 && (
            <>
              <h3 className="mt-6 text-sm font-medium">Waiting to be accepted</h3>
              <ul className="mt-2 divide-y divide-ink-700">
                {pending.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="text-sm">
                      {i.email} <span className="text-fg-muted">· {i.scope} · expires {i.expiresAt.toISOString().slice(0, 10)}</span>
                    </span>
                    <form action={revokeInviteAction.bind(null, i.id)}>
                      <Button type="submit" variant="outline" className="py-1.5">Cancel</Button>
                    </form>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <section className="card mt-6 p-6">
        <h2 className="text-lg font-medium">What has happened here</h2>
        {events.length === 0 ? (
          <p className="mt-2 text-sm text-fg-muted">Nothing yet. Invitations, access changes and billing will show up here.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {events.map((e) => (
              <li key={e.id} className="text-sm">
                <span className="text-fg-muted">{e.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC — </span>
                {describeEvent({ ...e, actorEmail: e.actorUserId ? actorEmail.get(e.actorUserId) ?? null : null })}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card mt-6 p-6">
        <h2 className="text-lg font-medium">Leave this team</h2>
        {canLeave.ok ? (
          <>
            <p className="mt-2 text-sm text-fg-muted">
              You lose access to its apps and checks. Nothing you did is removed.
            </p>
            <form action={leaveTeamAction}>
              <Button type="submit" variant="outline" className="mt-4">Leave {team.name}</Button>
            </form>
          </>
        ) : (
          <p className="mt-2 text-sm text-fg-muted">{canLeave.reason}</p>
        )}
      </section>
    </main>
  );
}
