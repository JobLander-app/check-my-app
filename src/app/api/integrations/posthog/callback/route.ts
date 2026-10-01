// PostHog OAuth callback (CHE-236).
//
// Three things have to be true before a token is stored, and each is checked
// against something the browser cannot forge:
//
//   1. the state's nonce matches the httpOnly cookie  — this browser started it;
//   2. the PKCE verifier from the cookie redeems the code — this flow, not another;
//   3. the signed-in team matches the team the flow started for — a code issued
//      for one team cannot be planted into another's row.
//
// The third is the one a mirrored implementation usually drops. Without it,
// anyone who can get a victim to visit a crafted callback while signed in
// connects their own analytics account to the victim's team, and the victim's
// runs start reading someone else's numbers.
//
// Every failure lands on the dashboard with a readable notice: a person who
// clicked "Connect analytics" and gets raw JSON has been told nothing.

import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireUser } from "@/lib/auth";
import { can, refusal } from "@/lib/scopes";
import { encryptSecret } from "@/lib/crypto";
import { discoverPostHog, exchangeCode } from "@/lib/posthog/oauth";
import { findAccount } from "@/lib/posthog/api";
import { recordTeamEvent } from "@/lib/team-events";

function fail(req: NextRequest, why: string) {
  return NextResponse.redirect(new URL(`/settings/integrations?integration=posthog_${why}`, req.nextUrl.origin));
}

/** Clear the flow's cookies whatever happens — they are single-use by design. */
async function clearFlow() {
  const jar = await cookies();
  jar.delete("posthog_oauth_nonce");
  jar.delete("posthog_oauth_verifier");
  jar.delete("posthog_oauth_actor");
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  // The person said no on the consent screen. Not a failure — say so quietly.
  if (params.get("error") === "access_denied") {
    await clearFlow();
    return NextResponse.redirect(new URL("/settings/integrations?integration=posthog_declined", req.nextUrl.origin));
  }

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) {
    await clearFlow();
    return fail(req, "failed");
  }

  let teamId: string;
  let nonce: string;
  try {
    ({ teamId, nonce } = JSON.parse(Buffer.from(state, "base64url").toString()) as { teamId: string; nonce: string });
  } catch {
    await clearFlow();
    return fail(req, "failed");
  }

  const jar = await cookies();
  const cookieNonce = jar.get("posthog_oauth_nonce")?.value;
  const verifier = jar.get("posthog_oauth_verifier")?.value;
  const actor = jar.get("posthog_oauth_actor")?.value ?? null;
  if (!cookieNonce || cookieNonce !== nonce || !verifier) {
    await clearFlow();
    return fail(req, "failed");
  }

  const { team, scope, db } = await requireUser();
  if (!can(scope, "integration.connect")) {
    await clearFlow();
    return NextResponse.json({ error: refusal(scope, "integration.connect") }, { status: 403 });
  }
  // The flow was started for a team; this browser is signed into a team. If they
  // differ, something is being planted rather than connected.
  if (team.id !== teamId) {
    await clearFlow();
    return fail(req, "failed");
  }

  const { env } = getCloudflareContext();
  const appUrl = ((env as Record<string, string | undefined>).APP_URL ?? req.nextUrl.origin).replace(/\/+$/, "");

  let tokens;
  let regionHint: string | null = null;
  try {
    const endpoints = await discoverPostHog();
    regionHint = endpoints.regionHint;
    tokens = await exchangeCode({
      endpoints,
      clientId: `${appUrl}/.well-known/posthog-client.json`,
      redirectUri: `${appUrl}/api/integrations/posthog/callback`,
      code,
      verifier,
    });
  } catch (err) {
    console.warn(`[posthog-oauth] exchange failed: ${err instanceof Error ? err.message : String(err)}`);
    await clearFlow();
    return fail(req, "failed");
  }
  await clearFlow();

  // Before the row exists, find out whether this token can read anything, and
  // from which region. A connection that says "Connected" over a token that
  // answers nothing is the failure this integration was written to avoid: it
  // stays quiet until somebody wonders why no numbers ever arrived. Better to
  // say it now, at the moment the person is looking at the screen.
  let account;
  try {
    account = await findAccount(tokens.accessToken, { hint: regionHint });
  } catch (err) {
    console.warn(`[posthog-oauth] connected token could not read its organisation: ${err instanceof Error ? err.message : String(err)}`);
    return fail(req, "unreadable");
  }

  // Reconnecting replaces the tokens rather than adding a row: one connection
  // per team is the database's rule, and this is the path that would otherwise
  // try to break it.
  const stored = {
    connectedByUserId: actor,
    accessTokenEnc: encryptSecret(tokens.accessToken),
    refreshTokenEnc: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
    expiresAt: tokens.expiresAt,
    scope: tokens.scope,
    organizationId: account.organizationId,
    organizationName: account.organizationName,
    region: account.region,
  };
  await db.postHogIntegration.upsert({
    where: { teamId: team.id },
    create: { teamId: team.id, ...stored },
    update: stored,
  });

  // CHE-264: connecting a team's analytics is a change to what the team can
  // read, and it is answerable by name rather than by reconstruction.
  await recordTeamEvent(db, {
    teamId: team.id,
    actorUserId: actor,
    action: "integration.connected",
    subject: account.organizationName,
    summary: `connected PostHog (${account.organizationName}, ${account.region.toUpperCase()}), read-only`,
  });

  return NextResponse.redirect(new URL("/settings/integrations?integration=posthog_connected", req.nextUrl.origin));
}
