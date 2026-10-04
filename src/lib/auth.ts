// Server-side auth helper bridging Clerk → the D1 user mirror (CHE-28/30).
//
// requireUser() guarantees a local `User` row for the signed-in Clerk user and
// returns it alongside a db handle. It lazily upserts the mirror so the owner
// experience works before the Clerk webhook is configured (the webhook then
// just keeps it in sync). Call only from protected server contexts.

import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getDbFromContext } from "./db";
import { upsertUserFromClerk } from "./users";
import { resolveApiKeyGrant, resolveApiKeyOwner } from "./apiKeys";
import { can } from "./scopes";
import { ACTIVE_TEAM_COOKIE, activeTeamContext, type TeamRow } from "./teams";
import { cookies } from "next/headers";
import { cache } from "react";
import type { TeamScope } from "./scopes";
import type { PrismaClient } from "@/generated/prisma/client";

// CHE-253: a protected page gets the person, the team they are acting for and
// what they may do in it — all three from one place. A page given only the user
// would have to re-answer "which team is this" from whatever row it happens to
// be rendering, and tenancy inferred from the row on screen is the mistake this
// epic exists to make impossible.
// CHE-261 (T8): which team this browser last chose. A cookie is a request, not
// an authority — activeTeamContext honours it only if the person is actually a
// member of that team, so editing it by hand gets you your own team back.
export async function preferredTeamId(): Promise<string | null> {
  try {
    return (await cookies()).get(ACTIVE_TEAM_COOKIE)?.value ?? null;
  } catch {
    // Read from a context with no request cookies (a background call). No
    // preference is the honest answer, and the caller falls back to personal.
    return null;
  }
}

// Once per request (CHE-351): the app shell's layout and the page inside it
// both need the signed-in person, and each call writes the user mirror. React's
// cache() hands the second caller the first one's answer.
export const requireUser = cache(requireUserUncached);

async function requireUserUncached(): Promise<{
  user: NonNullable<Awaited<ReturnType<PrismaClient["user"]["upsert"]>>>;
  db: PrismaClient;
  team: TeamRow;
  scope: TeamScope;
}> {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const clerkUser = await currentUser();
  const db = await getDbFromContext();
  const email =
    clerkUser?.primaryEmailAddress?.emailAddress ??
    clerkUser?.emailAddresses?.[0]?.emailAddress ??
    "";
  const name =
    [clerkUser?.firstName, clerkUser?.lastName].filter(Boolean).join(" ") || null;

  const user = await upsertUserFromClerk(db, {
    clerkUserId: userId,
    email,
    name,
  });
  // Lazily, like the mirror above: an account created before teams existed, or
  // written straight by a webhook, gets its personal team on first use rather
  // than being refused.
  const { team, scope } = await activeTeamContext(db, user, await preferredTeamId());
  return { user, db, team, scope };
}

// API-route auth: resolve the signed-in user's D1 mirror, or null (no redirect).
// Use in route handlers where anonymous access is valid for some paths.
// Lazily upserts the mirror like requireUser does: without this, a Clerk user
// who never visited a protected page has no D1 row, every optional-auth API
// treats them as anonymous, and flows like Enable Daily Watch 401-loop through
// sign-in with no visible error (the webhook that would create the row is
// inert until CLERK_WEBHOOK_SIGNING_SECRET is configured).
export async function getOptionalUser(db: PrismaClient) {
  const { userId } = await auth();
  if (!userId) return null;
  const existing = await db.user.findUnique({ where: { clerkUserId: userId } });
  if (existing) return existing;
  const clerkUser = await currentUser();
  const email =
    clerkUser?.primaryEmailAddress?.emailAddress ??
    clerkUser?.emailAddresses?.[0]?.emailAddress ??
    "";
  const name =
    [clerkUser?.firstName, clerkUser?.lastName].filter(Boolean).join(" ") || null;
  return upsertUserFromClerk(db, {
    clerkUserId: userId,
    email,
    name,
  });
}

// The team an API-route caller is acting for, and what they may do in it.
// requireUser's counterpart for routes where anonymous access is also valid:
// the caller may be a browser session or an API key (getOwnerFromRequest), and
// both resolve to the same team context so nothing downstream has to ask which
// kind of caller it is looking at.
export async function optionalTeamContext(
  db: PrismaClient,
  user: { id: string; name?: string | null; email: string } | null,
) {
  if (!user) return null;
  return activeTeamContext(db, user, await preferredTeamId());
}

// Request-level owner resolution for API routes (CHE-52): a browser presents a
// Clerk session, a coding agent presents `Authorization: Bearer cma_…`. Tries
// Clerk first, then the API key; either way the caller gets the same D1 User
// row getOptionalUser returns, so everything downstream (quota, attribution)
// is identical. `via` tells the route how the owner authenticated — API-key
// requests are machine-to-machine and are exempt from browser bot checks
// (a valid key is a stronger proof than a Turnstile token).
export async function getOwnerFromRequest(
  db: PrismaClient,
  req: Request,
): Promise<{ user: NonNullable<Awaited<ReturnType<typeof getOptionalUser>>>; via: "clerk" | "api_key" } | null> {
  const clerkUser = await getOptionalUser(db);
  if (clerkUser) return { user: clerkUser, via: "clerk" };
  const keyOwner = await resolveApiKeyOwner(db, req);
  if (keyOwner) return { user: keyOwner, via: "api_key" };
  return null;
}

// Tenant guard for resources that may be owned or anonymous (CHE-33).
// - Owned (ownerId set): only the authenticated owner may mutate.
// - Anonymous (ownerId null): knowledge of the unguessable publicId/slug IS the
//   capability (the public free-run funnel), so it's allowed.
export async function canMutateOwned(
  db: PrismaClient,
  ownerId: string | null,
): Promise<boolean> {
  if (!ownerId) return true;
  const user = await getOptionalUser(db);
  return !!user && user.id === ownerId;
}

// CHE-263 / CHE-246: may THIS request act on an owned row?
//
// canMutateOwned above only knows a Clerk session, so an API key — a stronger
// proof than a browser cookie — was refused by every route that used it. This
// answers for both identities, and for the team rather than the person: a run
// belongs to a team, so a colleague's key may re-check it, which is the whole
// point of the row belonging to the team and not to whoever clicked first.
export async function canMutateOwnedFromRequest(
  db: PrismaClient,
  req: Request,
  row: { ownerId: string | null; teamId?: string | null },
): Promise<boolean> {
  // An anonymous row is mutable by whoever holds its unguessable id (CHE-33).
  if (!row.ownerId && !row.teamId) return true;

  const grant = await resolveApiKeyGrant(db, req);
  if (grant?.team) {
    // A reader key reads. Acting on a row is not reading, and the scope table
    // is the one place that decides which is which.
    if (!can(grant.scope as TeamScope, "run.recheck")) return false;
    if (row.teamId && grant.team.id === row.teamId) return true;
    return grant.user.id === row.ownerId;
  }

  const user = await getOptionalUser(db);
  if (!user) return false;
  if (user.id === row.ownerId) return true;
  if (!row.teamId) return false;
  const membership = await db.membership.findFirst({
    where: { teamId: row.teamId, userId: user.id },
    select: { scope: true },
  });
  return membership ? can(membership.scope as TeamScope, "run.recheck") : false;
}
