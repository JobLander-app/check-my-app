"use server";

// CHE-258 (Teams T5): managing a team from inside the product.
//
// Every mutation here goes through requireActionScope, so the registry entry
// (src/lib/route-scopes.ts) and the code say the same thing — and through the
// pure rules in src/lib/membership.ts, so the last-admin rule is enforced where
// the change happens rather than in the page that offers the button.

import { revalidatePath } from "next/cache";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireActionScope } from "@/lib/team-auth";
import {
  decideLeave,
  decideRemoval,
  decideScopeChange,
  type MemberRow,
} from "@/lib/membership";
import {
  checkInviteRequest,
  generateInviteToken,
  hashInviteToken,
  inviteExpiry,
  inviteState,
} from "@/lib/invites";
import { sendInviteMail } from "@/lib/invite-mail";
import { memberEmailForLog, recordTeamEvent } from "@/lib/team-events";
import { seatGate } from "@/lib/seats";
import { syncTeamSeats } from "@/lib/billing-sync";
import { getStripeEnv } from "@/lib/stripe";
import type { UserPlan } from "@/lib/enums";
import type { TeamScope } from "@/lib/scopes";
import type { PrismaClient } from "@/generated/prisma/client";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://checkmyapp.dev";

// The team as the rules need to see it: who is on it and with what scope.
async function membersOf(db: PrismaClient, teamId: string): Promise<MemberRow[]> {
  const rows = await db.membership.findMany({
    where: { teamId },
    select: { userId: true, scope: true },
  });
  return rows.map((r) => ({ userId: r.userId, scope: r.scope as TeamScope }));
}

export async function inviteMemberAction(formData: FormData): Promise<void> {
  const { user, db, team } = await requireActionScope("member.invite");
  const parsed = checkInviteRequest({
    email: String(formData.get("email") ?? ""),
    scope: String(formData.get("scope") ?? "member"),
  });
  if (!parsed.ok) throw new Error(parsed.reason);

  const members = await membersOf(db, team.id);
  const seats = seatGate(team.plan as UserPlan, members, parsed.scope, Boolean(team.stripeSubscriptionId));
  if (!seats.ok) throw new Error(seats.reason);

  const already = await db.membership.findFirst({
    where: { teamId: team.id, user: { email: parsed.email } },
    select: { id: true },
  });
  if (already) throw new Error("They are already on this team.");

  const token = generateInviteToken();
  await db.teamInvite.create({
    data: {
      teamId: team.id,
      email: parsed.email,
      scope: parsed.scope,
      tokenHash: await hashInviteToken(token),
      invitedByUserId: user.id,
      expiresAt: inviteExpiry(),
    },
  });

  const { env } = getCloudflareContext();
  await sendInviteMail(env as unknown as Record<string, unknown>, {
    to: parsed.email,
    teamName: team.name,
    invitedBy: user.name?.trim() || user.email,
    scope: parsed.scope,
    acceptUrl: `${APP_URL}/invite/${token}`,
  });
  await recordTeamEvent(db, {
    teamId: team.id,
    actorUserId: user.id,
    action: "member.invited",
    subject: parsed.email,
    summary: `invited ${parsed.email} as ${parsed.scope}`,
  });
  revalidatePath("/settings/team");
}

export async function revokeInviteAction(inviteId: string): Promise<void> {
  const { user, db, team } = await requireActionScope("member.invite");
  const invite = await db.teamInvite.findFirst({
    where: { id: inviteId, teamId: team.id },
    select: { id: true, email: true, expiresAt: true, acceptedAt: true, revokedAt: true, revokedReason: true, teamId: true, scope: true },
  });
  if (!invite) throw new Error("Invitation not found.");
  if (inviteState(invite) === "pending") {
    await db.teamInvite.update({
      where: { id: invite.id },
      data: { revokedAt: new Date(), revokedReason: "revoked" },
    });
    await recordTeamEvent(db, {
      teamId: team.id,
      actorUserId: user.id,
      action: "member.invite_revoked",
      subject: invite.email,
      summary: `cancelled the invitation to ${invite.email}`,
    });
  }
  revalidatePath("/settings/team");
}

export async function changeScopeAction(userId: string, formData: FormData): Promise<void> {
  const scope = String(formData.get("scope") ?? "");
  const { user, db, team } = await requireActionScope("member.scope.change");
  const members = await membersOf(db, team.id);
  const decision = decideScopeChange(members, userId, scope as TeamScope);
  if (!decision.ok) throw new Error(decision.reason);
  // Named before the change, and never throws: the log line is not allowed to
  // fail a change that has already happened.
  const email = await memberEmailForLog(db, userId);
  await db.membership.updateMany({
    where: { teamId: team.id, userId },
    data: { scope },
  });
  // CHE-259: promoting a reader adds a paid seat, demoting frees one. Derived
  // from the memberships rather than incremented, so a missed sync is put right
  // by the next change instead of compounding.
  await syncTeamSeats(db, getStripeEnv(getCloudflareContext().env as Record<string, unknown>), team.id);
  await recordTeamEvent(db, {
    teamId: team.id,
    actorUserId: user.id,
    action: "member.scope_changed",
    subject: email,
    summary: `changed ${email}'s access to ${scope}`,
  });
  revalidatePath("/settings/team");
}

export async function removeMemberAction(userId: string): Promise<void> {
  const { user, db, team } = await requireActionScope("member.remove");
  const members = await membersOf(db, team.id);
  const decision = decideRemoval(members, userId, user.id);
  if (!decision.ok) throw new Error(decision.reason);
  const email = await memberEmailForLog(db, userId);
  // Only the membership goes. Their apps, checks and tickets belong to the
  // team, and ownerId on those rows is attribution — the record of who did it.
  await db.membership.deleteMany({ where: { teamId: team.id, userId } });
  await syncTeamSeats(db, getStripeEnv(getCloudflareContext().env as Record<string, unknown>), team.id);
  await recordTeamEvent(db, {
    teamId: team.id,
    actorUserId: user.id,
    action: "member.removed",
    subject: email,
    summary: `removed ${email} from the team — their apps, checks and tickets stayed`,
  });
  revalidatePath("/settings/team");
}

export async function leaveTeamAction(): Promise<void> {
  // Leaving is not an admin action: any member may do it, so the scope asked
  // for is the one everybody has.
  const { user, db, team } = await requireActionScope("read");
  const members = await membersOf(db, team.id);
  const decision = decideLeave(members, user.id);
  if (!decision.ok) throw new Error(decision.reason);
  await db.membership.deleteMany({ where: { teamId: team.id, userId: user.id } });
  await syncTeamSeats(db, getStripeEnv(getCloudflareContext().env as Record<string, unknown>), team.id);
  await recordTeamEvent(db, {
    teamId: team.id,
    actorUserId: user.id,
    action: "member.left",
    subject: user.email,
    summary: `${user.email} left the team`,
  });
  revalidatePath("/settings/team");
}
