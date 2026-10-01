import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { Button, buttonClass } from "@/components/ui/button";
import { decideAccept, hashInviteToken, inviteState } from "@/lib/invites";
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
  // Signing in first is deliberate: a team membership needs an identity, and
  // requireUser sends them through sign-in and back here.
  const { user, db } = await requireUser();
  const { token } = await params;
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
          <h1 className="break-words text-xl font-semibold">You are already on {invite?.team.name}</h1>
          <p className="mt-2 text-sm text-fg-muted">Nothing to accept — the team is in your dashboard.</p>
          <Link href="/dashboard" className={buttonClass("primary", "mt-6")}>
            Open the dashboard
          </Link>
        </section>
      ) : decision.kind === "refused" ? (
        <section className="card p-6">
          <h1 className="text-xl font-semibold">This invitation can&apos;t be used</h1>
          <p className="mt-2 text-sm text-fg-muted">{error ?? decision.reason}</p>
          <Link href="/dashboard" className={buttonClass("outline", "mt-6")}>
            Go to your dashboard
          </Link>
        </section>
      ) : (
        <section className="card p-6">
          <h1 className="break-words text-xl font-semibold">Join {invite!.team.name}</h1>
          <p className="mt-2 text-sm text-fg-muted">
            {decision.scope === "admin"
              ? "As an admin you will be able to run checks, change settings, and manage the team and its billing."
              : decision.scope === "member"
                ? "As a member you will be able to run checks, change an app's settings, and act on what we find."
                : "As a reader you will be able to see everything the team's checks find. Running a check is left to the others."}
          </p>
          <p className="mt-2 text-xs text-fg-muted">
            Signed in as {user.email}. The invitation was sent to {invite!.email} — joining with this account is fine.
          </p>
          {error && <p className="mt-4 text-sm text-status-broken">{error}</p>}
          <form
            action={async () => {
              "use server";
              await acceptInviteAction(token);
            }}
          >
            <Button type="submit" className="mt-6">
              Join {invite!.team.name}
            </Button>
          </form>
          <p className="mt-3 text-xs text-fg-muted">
            {inviteState(invite!) === "pending"
              ? `This link works until ${invite!.expiresAt.toISOString().slice(0, 10)}.`
              : null}
          </p>
        </section>
      )}
    </main>
  );
}
