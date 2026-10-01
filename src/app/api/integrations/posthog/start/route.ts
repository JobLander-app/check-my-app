// Begin PostHog OAuth for a team (CHE-236).
//
// Unlike the Linear pair this mirrors, there is no appId: the connection is the
// team's, and every app it watches uses it. And unlike Linear there is no
// client secret — our client_id is the URL of a document we host, so PKCE is
// what proves the code was redeemed by whoever started the flow. The verifier
// lives in an httpOnly cookie and never reaches the browser's JavaScript.
//
// Every failure here ends on the dashboard with something readable. A person
// who clicked "Connect analytics" and lands on raw JSON has been told nothing.

import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireUser } from "@/lib/auth";
import { can, refusal } from "@/lib/scopes";
import {
  buildAuthorizeUrl,
  challengeFor,
  createVerifier,
  discoverPostHog,
  unsupportedScopes,
} from "@/lib/posthog/oauth";

/** Ten minutes: long enough to read a consent screen, short enough to matter. */
const FLOW_TTL_SECONDS = 600;

export async function GET(req: NextRequest) {
  const { team, scope, user } = await requireUser();

  // CHE-255: connecting analytics stores a token the whole team reads from.
  if (!can(scope, "integration.connect")) {
    return NextResponse.json({ error: refusal(scope, "integration.connect") }, { status: 403 });
  }

  const { env } = getCloudflareContext();
  const appUrl = ((env as Record<string, string | undefined>).APP_URL ?? req.nextUrl.origin).replace(/\/+$/, "");
  // The client_id IS the metadata document's URL, and it must be the same
  // origin PostHog will fetch it from — so it comes from configuration, never
  // from the incoming request (a Host header is attacker-controlled).
  const clientId = `${appUrl}/.well-known/posthog-client.json`;
  const redirectUri = `${appUrl}/api/integrations/posthog/callback`;

  let endpoints;
  try {
    endpoints = await discoverPostHog();
  } catch (err) {
    // The provider could not tell us where its endpoints are. Say so plainly
    // rather than starting a flow against a guessed URL that would fail in
    // front of the customer.
    console.warn(`[posthog-oauth] discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.redirect(new URL("/settings/integrations?integration=posthog_unavailable", req.url));
  }

  const missing = unsupportedScopes(endpoints);
  if (missing.length > 0) {
    // Asking for a scope the server does not offer fails at consent, and the
    // person reads PostHog's error rather than ours.
    console.warn(`[posthog-oauth] provider no longer offers: ${missing.join(", ")}`);
    return NextResponse.redirect(new URL("/settings/integrations?integration=posthog_scopes", req.url));
  }

  const verifier = createVerifier();
  const challenge = await challengeFor(verifier);
  const nonce = crypto.randomUUID();
  const state = Buffer.from(JSON.stringify({ teamId: team.id, nonce })).toString("base64url");

  const jar = await cookies();
  const secure = req.nextUrl.protocol === "https:";
  // Two cookies, both httpOnly: the nonce answers "did this browser start the
  // flow", the verifier answers "is this the same flow". Neither is readable
  // by page scripts, and both expire with the flow.
  jar.set("posthog_oauth_nonce", nonce, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: FLOW_TTL_SECONDS });
  jar.set("posthog_oauth_verifier", verifier, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: FLOW_TTL_SECONDS });
  // Who pressed Connect, for attribution on the row the callback writes.
  jar.set("posthog_oauth_actor", user.id, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: FLOW_TTL_SECONDS });

  return NextResponse.redirect(buildAuthorizeUrl({ endpoints, clientId, redirectUri, state, challenge }));
}
