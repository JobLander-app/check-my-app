// CHE-255 (Teams T2): one way to ask "may this caller do this", for routes and
// for server actions.
//
// The registry (src/lib/route-scopes.ts) says which action a route is. This is
// where that answer is enforced, and it is deliberately the only place that
// combines the three questions a handler used to answer for itself:
//
//   who is calling      — a browser session or an API key. getOwnerFromRequest
//                         already tells them apart and returns the same User
//                         row for both, so a key is not a second kind of caller
//                         here (which is how a key ended up refused by a route
//                         that only knew about sessions — CHE-246).
//   for which team      — activeTeamContext, never inferred from the row being
//                         acted on.
//   with what scope     — can(scope, action) from the one table (CHE-254).
//
// A refusal is a sentence, not a bare status: the person reading it is a
// colleague of whoever can grant it, and the copy says so.

import { NextResponse } from "next/server";
import { getOptionalUser, getOwnerFromRequest, requireUser } from "./auth";
import { resolveApiKeyGrant } from "./apiKeys";
import { activeTeamContext, type TeamContext, type TeamRow } from "./teams";
import { preferredTeamId } from "./auth";
import { can, refusal, type TeamAction, type TeamScope } from "./scopes";
import type { PrismaClient } from "@/generated/prisma/client";

export type ScopeGrant = {
  user: NonNullable<Awaited<ReturnType<typeof getOwnerFromRequest>>>["user"];
  team: TeamRow;
  scope: TeamScope;
  via: "clerk" | "api_key";
};

export type ScopeDecision = { ok: true; grant: ScopeGrant } | { ok: false; response: NextResponse };

// For API routes. Returns the refusal as a response rather than throwing, so a
// handler keeps its own shape and the copy stays with the rule.
export async function requireScope(
  db: PrismaClient,
  req: Request,
  action: TeamAction,
  // What an unauthenticated caller is told. The default is fine for an API; a
  // route with its own conversion path (Enable Daily Watch, Upgrade) passes the
  // sentence that belongs to it.
  unauthenticated = "Sign in to do that",
): Promise<ScopeDecision> {
  // CHE-263: a key carries its own scope and its own team, so it is answered
  // from the key rather than from whatever the person who minted it can do
  // today. A reader key stays a reader key after its author becomes an admin.
  const grant = await resolveApiKeyGrant(db, req);
  if (grant?.team) {
    if (!can(grant.scope as TeamScope, action)) {
      return {
        ok: false,
        response: NextResponse.json({ error: refusal(grant.scope as TeamScope, action) }, { status: 403 }),
      };
    }
    return {
      ok: true,
      grant: { user: grant.user, team: grant.team as TeamRow, scope: grant.scope as TeamScope, via: "api_key" },
    };
  }

  const caller = await getOwnerFromRequest(db, req);
  if (!caller) {
    return {
      ok: false,
      response: NextResponse.json({ error: unauthenticated }, { status: 401 }),
    };
  }
  // CHE-261: an API-key caller has no browser and therefore no cookie — it
  // acts for the team its key belongs to, which resolves to that owner's
  // personal team today and becomes the key's own team in T10.
  const preferred = caller.via === "clerk" ? await preferredTeamId() : null;
  const { team, scope } = await activeTeamContext(db, caller.user, preferred);
  if (!can(scope, action)) {
    return {
      ok: false,
      response: NextResponse.json({ error: refusal(scope, action) }, { status: 403 }),
    };
  }
  return { ok: true, grant: { user: caller.user, team, scope, via: caller.via } };
}

// For server actions, where there is no Response to return and an
// unauthenticated caller is redirected to sign in by requireUser. A refusal
// throws with the same sentence the API would have answered: a server action
// that quietly did nothing would be the dead control this product flags on
// other people's apps (CHE-108).
export async function requireActionScope(action: TeamAction) {
  const { user, db, team, scope } = await requireUser();
  if (!can(scope, action)) throw new Error(refusal(scope, action) ?? "Not allowed");
  return { user, db, team, scope };
}

// CHE-316: which team a caller spends, for a route that also serves strangers
// (POST /api/checks). A key acts for its OWN team, as requireScope already
// answers — not for the minter's personal team, which is where a cookie-less
// caller used to land. That mattered little while only Business teams could
// mint keys; with a key on every plan it decides whether a Free team's key is
// held to that team's quota or quietly spends a different team's plan.
// A legacy key with no team falls back to the minter's context, as before.
export async function callerTeamContext(
  db: PrismaClient,
  req: Request,
  caller: { user: ScopeGrant["user"]; via: "clerk" | "api_key" } | null,
): Promise<TeamContext | null> {
  if (!caller) return null;
  if (caller.via === "api_key") {
    const grant = await resolveApiKeyGrant(db, req);
    if (grant?.team) return { team: grant.team as TeamRow, scope: grant.scope as TeamScope };
  }
  const preferred = caller.via === "clerk" ? await preferredTeamId() : null;
  return activeTeamContext(db, caller.user, preferred);
}

// CHE-265: who is calling, for a route that also serves strangers.
//
// Returns null when nobody is signed in. An API key answers with the KEY's
// scope — not its minter's, which is the whole point of T10 — and a browser
// session answers with the person's scope in their active team.
export async function callerScope(db: PrismaClient, req: Request): Promise<TeamScope | null> {
  const grant = await resolveApiKeyGrant(db, req);
  if (grant?.team) return grant.scope as TeamScope;
  const user = await getOptionalUser(db);
  if (!user) return null;
  const { scope } = await activeTeamContext(db, user, await preferredTeamId());
  return scope;
}
