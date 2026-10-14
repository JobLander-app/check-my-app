// CHE-253 (Teams T0): resolving the team a person is acting for.
//
// A team owns the apps, pays the bill and grants the access. A personal account
// IS a team of one, created the moment a user exists, so nothing in the product
// branches on "team or not" — there is one billing subject and one access
// subject, and the single-seat case is exercised by every request we serve
// rather than by a test nobody runs.
//
// The personal team's id is derived from the user's (`team_<userId>`), the same
// value migration 0032 backfilled. That is not decoration: it makes creating it
// idempotent without a transaction, which is the only kind of idempotent D1
// offers.

import type { PrismaClient } from "@/generated/prisma/client";
import type { TeamScope } from "./scopes";

export type TeamRow = {
  id: string;
  name: string;
  isPersonal: boolean;
  plan: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
};

export type TeamContext = {
  team: TeamRow;
  scope: TeamScope;
};

export function personalTeamId(userId: string): string {
  return `team_${userId}`;
}

export function personalMembershipId(userId: string): string {
  return `mem_${userId}`;
}

// A name a person recognises as theirs. Their own name if we have one, their
// email otherwise — never "Personal team", which reads like a system row.
export function personalTeamName(user: { name?: string | null; email: string }): string {
  return user.name?.trim() || user.email;
}

// The personal team for a user, created if it is missing. Missing happens for
// every account created after this migration and for any row a webhook wrote
// directly, so this is the lazy half of the same guarantee the backfill gave
// existing accounts — the pattern the user mirror itself already uses.
export async function ensurePersonalTeam(
  db: PrismaClient,
  user: { id: string; name?: string | null; email: string },
): Promise<TeamRow> {
  const id = personalTeamId(user.id);
  const team = await db.team.upsert({
    where: { id },
    create: { id, name: personalTeamName(user), isPersonal: true },
    update: {},
  });
  await db.membership.upsert({
    where: { id: personalMembershipId(user.id) },
    create: {
      id: personalMembershipId(user.id),
      teamId: id,
      userId: user.id,
      scope: "admin",
    },
    update: {},
  });
  return team as TeamRow;
}

// CHE-261 (T8): the cookie that carries the choice. Not a session store and not
// a database column — a person's chosen team is a property of this browser, and
// signing in somewhere else should start from their own team rather than
// wherever they last were.
export const ACTIVE_TEAM_COOKIE = "cma_team";

// The rule for choosing, separated from the request so it can be asserted
// without one (scripts/verify-team-context.ts).
//
// `preferred` is what the browser asked for. It is honoured ONLY if the person
// is a member of that team — a cookie is something the holder can edit, so it
// is a request, never an authority. Anything else falls back to their personal
// team, and to the oldest membership if (impossibly) they have no personal one.
//
// CHE-481: except a personal team with nothing in it. Someone who signed up to
// accept an invitation has a team of their own they never asked for; on a new
// browser (no cookie yet) it opened empty, and the team they joined was a
// switch away — "it made me a new account". An empty personal team gives way
// to the oldest team they joined. `apps` is how many apps the team holds;
// left out, nothing is known and the personal team stands.
export function chooseTeam<T extends { teamId: string; apps?: number }>(
  memberships: T[],
  personalId: string,
  preferred: string | null,
): T | null {
  if (preferred) {
    const asked = memberships.find((m) => m.teamId === preferred);
    if (asked) return asked;
  }
  const personal = memberships.find((m) => m.teamId === personalId);
  const joined = memberships.find((m) => m.teamId !== personalId);
  if (personal && personal.apps === 0 && joined) return joined;
  return personal ?? memberships[0] ?? null;
}

// Which team this person is acting for, and what they may do in it.
//
// The active team is an explicit choice, carried in a cookie and validated
// against membership on every request. It is never inferred from the row being
// shown: a tenancy derived from what you happen to be looking at is how a check
// gets started against the wrong team's budget, and nobody can say why
// afterwards.
export async function activeTeamContext(
  db: PrismaClient,
  user: { id: string; name?: string | null; email: string },
  preferredTeamId: string | null = null,
): Promise<TeamContext> {
  const memberships = await db.membership.findMany({
    where: { userId: user.id },
    include: { team: { include: { _count: { select: { apps: true } } } } },
    orderBy: { createdAt: "asc" },
  });
  const chosen = chooseTeam(
    memberships.map((m) => ({ ...m, apps: m.team._count.apps })),
    personalTeamId(user.id),
    preferredTeamId,
  );
  if (!chosen) {
    // No membership at all: an account that predates the backfill or was
    // written straight by a webhook. Give it its team rather than refusing the
    // request — the same reason getOptionalUser upserts the mirror lazily.
    const team = await ensurePersonalTeam(db, user);
    return { team, scope: "admin" };
  }
  return { team: chosen.team as TeamRow, scope: chosen.scope as TeamScope };
}

// Every team this person belongs to, for the switcher and for the "you are in
// that team too" offer a deep link makes (T8). Ordered with the personal team
// first, then by name, so the list does not reshuffle itself between visits.
export async function teamsOf(
  db: PrismaClient,
  userId: string,
): Promise<{ id: string; name: string; scope: TeamScope; isPersonal: boolean }[]> {
  const memberships = await db.membership.findMany({
    where: { userId },
    include: { team: true },
  });
  const personal = personalTeamId(userId);
  return memberships
    .map((m) => ({
      id: m.teamId,
      name: m.team.name,
      scope: m.scope as TeamScope,
      isPersonal: m.teamId === personal,
    }))
    .sort((a, b) => (a.isPersonal === b.isPersonal ? a.name.localeCompare(b.name) : a.isPersonal ? -1 : 1));
}
