// CHE-257 (Teams T4): cancel an invitation, or send it again.
//
// Neither deletes the row. Revoking marks it revoked; resending marks the old
// one "resent" and writes a new one, so the link in the older email stops
// working the moment a newer one exists. "Who invited whom, and what happened
// to it" is the history T11's audit log reads, and a row that vanishes takes
// its own history with it.

import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDbFromContext } from "@/lib/db";
import { requireScope } from "@/lib/team-auth";
import {
  generateInviteToken,
  hashInviteToken,
  inviteExpiry,
  inviteState,
} from "@/lib/invites";
import { sendInviteMail } from "@/lib/invite-mail";
import { isSelfCheckRequest, selfCheckReadOnlyResponse } from "@/lib/self-check";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://checkmyapp.dev";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isSelfCheckRequest(req.headers)) return selfCheckReadOnlyResponse();

  const db = await getDbFromContext();
  const decision = await requireScope(db, req, "member.invite");
  if (!decision.ok) return decision.response;
  const { team } = decision.grant;

  const { id } = await params;
  // Scoped by team: an admin of one team cannot cancel another team's
  // invitation by knowing its id.
  const invite = await db.teamInvite.findFirst({
    where: { id, teamId: team.id },
    select: { id: true, expiresAt: true, acceptedAt: true, revokedAt: true, revokedReason: true, teamId: true, scope: true },
  });
  if (!invite) return NextResponse.json({ error: "Invitation not found" }, { status: 404 });

  const state = inviteState(invite);
  if (state === "accepted") {
    return NextResponse.json(
      { error: "That invitation was already accepted — remove the member instead." },
      { status: 409 },
    );
  }
  if (state === "pending") {
    await db.teamInvite.update({
      where: { id: invite.id },
      data: { revokedAt: new Date(), revokedReason: "revoked" },
    });
  }
  // Already revoked, resent or expired: nothing to do, and saying "done" is
  // honest — the link does not work either way.
  return NextResponse.json({ ok: true, state: state === "pending" ? "revoked" : state });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isSelfCheckRequest(req.headers)) return selfCheckReadOnlyResponse();

  const db = await getDbFromContext();
  const decision = await requireScope(db, req, "member.invite");
  if (!decision.ok) return decision.response;
  const { user, team } = decision.grant;

  const { id } = await params;
  const invite = await db.teamInvite.findFirst({
    where: { id, teamId: team.id },
    select: {
      id: true,
      email: true,
      scope: true,
      teamId: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      revokedReason: true,
    },
  });
  if (!invite) return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  if (inviteState(invite) === "accepted") {
    return NextResponse.json({ error: "That invitation was already accepted." }, { status: 409 });
  }

  // A resend mints a NEW token and kills the old one. Two live links to the
  // same team would mean revoking one leaves the other working, which is the
  // kind of surprise nobody would think to check for.
  const token = generateInviteToken();
  await db.teamInvite.update({
    where: { id: invite.id },
    data: { revokedAt: new Date(), revokedReason: "resent" },
  });
  const fresh = await db.teamInvite.create({
    data: {
      teamId: team.id,
      email: invite.email,
      scope: invite.scope,
      tokenHash: await hashInviteToken(token),
      invitedByUserId: user.id,
      expiresAt: inviteExpiry(),
    },
    select: { id: true, email: true, scope: true, expiresAt: true },
  });

  const { env } = getCloudflareContext();
  await sendInviteMail(env as unknown as Record<string, unknown>, {
    to: invite.email,
    teamName: team.name,
    invitedBy: user.name?.trim() || user.email,
    scope: invite.scope,
    acceptUrl: `${APP_URL}/invite/${token}`,
  });

  return NextResponse.json({ invite: fresh }, { status: 201 });
}
