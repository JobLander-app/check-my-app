"use server";

// CHE-261 (Teams T8): switching teams is an explicit act.
//
// The only thing that changes the active team. Nothing infers it: not the row
// being viewed, not the last team that did something, not a URL parameter. A
// tenancy derived from what you happen to be looking at is how a check gets
// started against the wrong team's budget with nobody able to say why
// afterwards — so "which team am I acting as" changes here and nowhere else.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { ACTIVE_TEAM_COOKIE } from "@/lib/teams";

export async function switchTeamAction(teamId: string, to?: string): Promise<void> {
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

  (await cookies()).set(ACTIVE_TEAM_COOKIE, teamId, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    // A year: switching teams is not a security boundary — membership is. The
    // cookie only remembers which of your own teams you were last working in.
    maxAge: 60 * 60 * 24 * 365,
  });

  redirect(to && to.startsWith("/") ? to : "/home");
}
