"use server";

// CHE-261 (Teams T8): switching teams is an explicit act.
//
// One of two things that change the active team — the other is pressing "Join"
// on an invitation, which is choosing that team by name. Nothing infers it: not
// the row being viewed, not the last team that did something, not a URL
// parameter. A tenancy derived from what you happen to be looking at is how a
// check gets started against the wrong team's budget with nobody able to say
// why afterwards.

import { redirect } from "next/navigation";
import { rememberActiveTeam, requireUser } from "@/lib/auth";
import { refuseSelfCheck } from "@/lib/self-check-action";

export async function switchTeamAction(teamId: string, to?: string): Promise<void> {
  await refuseSelfCheck("/home");
  const { user, db } = await requireUser();

  // Membership is checked here, not trusted from the cookie. The cookie is
  // what the browser asks for; this is the answer.
  const membership = await db.membership.findFirst({
    where: { teamId, userId: user.id },
    select: { id: true },
  });
  if (!membership) {
    redirect("/home?team_error=" + encodeURIComponent("You are not on that team."));
  }

  await rememberActiveTeam(teamId);

  redirect(to && to.startsWith("/") ? to : "/home");
}
