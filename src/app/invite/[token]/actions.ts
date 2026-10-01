"use server";

// CHE-257 (Teams T4): joining a team.
//
// Acceptance matches on the TOKEN, never on the email address the invitation
// was sent to: a colleague types the address they know, and the person signs in
// with the Google account they actually use. Matching on the address would
// refuse exactly the people the invitation was meant for, and to them it would
// look like a broken link rather than a rule.

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { decideAccept, hashInviteToken } from "@/lib/invites";
import { personalTeamId } from "@/lib/teams";
import { syncTeamSeats } from "@/lib/billing-sync";
import { recordTeamEvent } from "@/lib/team-events";
import { getStripeEnv } from "@/lib/stripe";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function acceptInviteAction(token: string): Promise<void> {
  const { user, db } = await requireUser();

  const invite = await db.teamInvite.findUnique({
    where: { tokenHash: await hashInviteToken(token) },
    select: {
      id: true,
      teamId: true,
      scope: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      revokedReason: true,
      invitedByUserId: true,
    },
  });

  const alreadyMember = invite
    ? (await db.membership.findFirst({
        where: { teamId: invite.teamId, userId: user.id },
        select: { id: true },
      })) !== null
    : false;

  const decision = decideAccept(invite, alreadyMember);
  if (decision.kind === "refused") {
    redirect(`/invite/${token}?error=${encodeURIComponent(decision.reason)}`);
  }
  if (decision.kind === "already_member") {
    redirect(`/home?team=${decision.teamId}`);
  }

  // The membership and the invitation's own record of what happened to it. D1
  // has no transactions, so the membership is written first: a crash between
  // the two leaves a person on the team with an invitation that still says
  // pending, which the next accept resolves (alreadyMember wins). The other
  // order would leave a used invitation and nobody on the team.
  await db.membership.upsert({
    where: { teamId_userId: { teamId: decision.teamId, userId: user.id } },
    create: {
      teamId: decision.teamId,
      userId: user.id,
      scope: decision.scope,
      invitedByUserId: invite!.invitedByUserId,
    },
    update: {},
  });
  await db.teamInvite.update({
    where: { id: invite!.id },
    data: { acceptedAt: new Date(), acceptedByUserId: user.id },
  });
  // CHE-259: the seat exists now, so the subscription should say so. Silent and
  // best-effort — a Stripe outage must not leave somebody half-joined.
  await syncTeamSeats(db, getStripeEnv(getCloudflareContext().env as Record<string, unknown>), decision.teamId);
  await recordTeamEvent(db, {
    teamId: decision.teamId,
    actorUserId: user.id,
    action: "member.joined",
    subject: user.email,
    summary: `${user.email} joined as ${decision.scope}`,
  });

  // Their personal team still exists and still holds their own apps; this adds
  // a second one rather than replacing anything (T8 adds the switch between
  // them). The redirect goes to the team they just joined.
  void personalTeamId(user.id);
  redirect(`/home?team=${decision.teamId}`);
}
