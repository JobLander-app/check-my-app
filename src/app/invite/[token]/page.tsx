import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { requireUser } from "@/lib/auth";
import { getDbFromContext } from "@/lib/db";
import { Button, buttonClass } from "@/components/ui/button";
import { decideAccept, hashInviteToken, inviteAuthPath, inviteState } from "@/lib/invites";
import { INVITE_COPY } from "@/lib/invite-copy";
import { switchTeamAction } from "@/app/team/switch-actions";
import { acceptInviteAction } from "./actions";

// CHE-257 (Teams T4): the page an invitation link opens.
//
// Joining happens on a button, not on the page load. An email security scanner
// follows every link in a message it inspects; if opening the link joined the
// team, a scanner would consume the invitation before the person ever saw it,
// and they would be told it was already used. The page is safe to fetch; the
// button is the act.
export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  // Signing in first is deliberate: a team membership needs an identity. The
  // way there carries the way back (inviteAuthPath) — requireUser's own
  // redirect is a bare /sign-in, and this page is the one place that loses
  // the person if they come out of sign-up anywhere but here.
  const { token } = await params;
  if (!(await auth()).userId) {
    const db = await getDbFromContext();
    const sentTo = await db.teamInvite.findUnique({
      where: { tokenHash: await hashInviteToken(token) },
      select: { email: true },
    });
    const hasAccount = sentTo
      ? (await db.user.findFirst({ where: { email: sentTo.email }, select: { id: true } })) !== null
      : false;
    redirect(inviteAuthPath(token, hasAccount));
  }
  const { user, db } = await requireUser();
  const { error } = await searchParams;

  const invite = await db.teamInvite.findUnique({
    where: { tokenHash: await hashInviteToken(token) },
    select: {
      teamId: true,
      scope: true,
      email: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      revokedReason: true,
      team: { select: { name: true } },
    },
  });

  const alreadyMember = invite
    ? (await db.membership.findFirst({
        where: { teamId: invite.teamId, userId: user.id },
        select: { id: true },
      })) !== null
    : false;

  const decision = decideAccept(invite, alreadyMember);

  return (
    <main className="mx-auto w-full max-w-lg px-4 py-16">
      {decision.kind === "already_member" ? (
        <section className="card p-6">
          <h1 className="break-words text-xl font-semibold">{INVITE_COPY.alreadyTitle(invite!.team.name)}</h1>
          <p className="mt-2 text-sm text-fg-muted">{INVITE_COPY.alreadyBody}</p>
          {/* Opens the dashboard IN that team: a plain link would open whichever
              team this browser last used, usually their own empty one. */}
          <form action={switchTeamAction.bind(null, invite!.teamId, "/home")}>
            <Button type="submit" className="mt-6">
              {INVITE_COPY.openTeam(invite!.team.name)}
            </Button>
          </form>
        </section>
      ) : decision.kind === "refused" ? (
        <section className="card p-6">
          <h1 className="text-xl font-semibold">{INVITE_COPY.refusedTitle}</h1>
          <p className="mt-2 text-sm text-fg-muted">{error ?? decision.reason}</p>
          <Link href="/home" className={buttonClass("outline", "mt-6")}>
            {INVITE_COPY.toDashboard}
          </Link>
        </section>
      ) : (
        <section className="card p-6">
          <h1 className="break-words text-xl font-semibold">{INVITE_COPY.joinTitle(invite!.team.name)}</h1>
          <p className="mt-2 text-sm text-fg-muted">{INVITE_COPY.scope[decision.scope]}</p>
          <p className="mt-2 text-xs text-fg-muted">{INVITE_COPY.signedInAs(user.email, invite!.email)}</p>
          {error && <p className="mt-4 text-sm text-status-broken">{error}</p>}
          <form
            action={async () => {
              "use server";
              await acceptInviteAction(token);
            }}
          >
            <Button type="submit" className="mt-6">
              {INVITE_COPY.joinButton(invite!.team.name)}
            </Button>
          </form>
          <p className="mt-3 text-xs text-fg-muted">
            {inviteState(invite!) === "pending" ? INVITE_COPY.worksUntil(invite!.expiresAt.toISOString().slice(0, 10)) : null}
          </p>
        </section>
      )}
    </main>
  );
}
