// CHE-257 (Teams T4): invite somebody to the team.
//
// An admin picks the address and the scope; we mint a token, keep only its
// hash, and email the link. The scope is decided here, at invite time, and
// travels with the invitation — accepting never picks a default.

import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDbFromContext } from "@/lib/db";
import { requireScope } from "@/lib/team-auth";
import {
  checkInviteRequest,
  generateInviteToken,
  hashInviteToken,
  inviteExpiry,
} from "@/lib/invites";
import { sendInviteMail } from "@/lib/invite-mail";
import { seatGate, seatNotice } from "@/lib/seats";
import type { UserPlan } from "@/lib/enums";
import type { TeamScope } from "@/lib/scopes";
import { isSelfCheckRequest, selfCheckReadOnlyResponse } from "@/lib/self-check";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://checkmyapp.dev";

export async function POST(req: Request) {
  // CHE-193: our own checker never invites anyone. First, before anything else.
  if (isSelfCheckRequest(req.headers)) return selfCheckReadOnlyResponse();

  const db = await getDbFromContext();
  const decision = await requireScope(db, req, "member.invite", "Sign in to invite someone");
  if (!decision.ok) return decision.response;
  const { user, team } = decision.grant;

  const json = (await req.json().catch(() => null)) as { email?: unknown; scope?: unknown } | null;
  const parsed = checkInviteRequest({
    email: typeof json?.email === "string" ? json.email : "",
    scope: typeof json?.scope === "string" ? json.scope : "",
  });
  if (!parsed.ok) return NextResponse.json({ error: parsed.reason }, { status: 400 });

  // Already on the team: say so rather than sending a link that would answer
  // "you are already in" after they click it.
  // CHE-259: the seat is decided before the email goes out. An invitation that
  // is refused after the person clicks it wastes their time and ours.
  const members = await db.membership.findMany({ where: { teamId: team.id }, select: { scope: true } });
  const seats = seatGate(
    team.plan as UserPlan,
    members.map((m) => ({ scope: m.scope as TeamScope })),
    parsed.scope,
    Boolean(team.stripeSubscriptionId),
  );
  if (!seats.ok) return NextResponse.json({ error: seats.reason }, { status: 402 });

  const existingMember = await db.membership.findFirst({
    where: { teamId: team.id, user: { email: parsed.email } },
    select: { id: true },
  });
  if (existingMember) {
    return NextResponse.json({ error: "They are already on this team." }, { status: 409 });
  }

  const token = generateInviteToken();
  const invite = await db.teamInvite.create({
    data: {
      teamId: team.id,
      email: parsed.email,
      scope: parsed.scope,
      tokenHash: await hashInviteToken(token),
      invitedByUserId: user.id,
      expiresAt: inviteExpiry(),
    },
    select: { id: true, email: true, scope: true, expiresAt: true },
  });

  const { env } = getCloudflareContext();
  await sendInviteMail(env as unknown as Record<string, unknown>, {
    to: parsed.email,
    teamName: team.name,
    invitedBy: user.name?.trim() || user.email,
    scope: parsed.scope,
    acceptUrl: `${APP_URL}/invite/${token}`,
  });

  return NextResponse.json(
    { invite, seatNotice: seatNotice(team.plan as UserPlan, seats) },
    { status: 201 },
  );
}
