// Linear OAuth callback (CHE-31). Verifies CSRF state, exchanges the code for an
// access token, and stores it (encrypted) as the App's TrackerIntegration.
import { NextResponse, type NextRequest } from "next/server";
import { can, refusal } from "@/lib/scopes";
import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireUser } from "@/lib/auth";
import { exchangeCode, fetchFirstTeam } from "@/lib/tracker/linear-oauth";
import { encryptSecret } from "@/lib/crypto";
import { alreadyScoped } from "@/lib/tenant-db";

function back(req: NextRequest, status: string) {
  return NextResponse.redirect(new URL(`/home?linear=${status}`, req.nextUrl.origin));
}

// Any error along the OAuth callback lands the user on a friendly notice on
// Today (CHE-67) rather than a raw JSON error or an opaque status code.
function fail(req: NextRequest) {
  return NextResponse.redirect(new URL("/home?integration=linear_failed", req.nextUrl.origin));
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (!code || !state) return fail(req);

  let appId: string;
  let nonce: string;
  try {
    ({ appId, nonce } = JSON.parse(Buffer.from(state, "base64url").toString()));
  } catch {
    return fail(req);
  }

  const jar = await cookies();
  if (jar.get("linear_oauth_nonce")?.value !== nonce) return fail(req);
  jar.delete("linear_oauth_nonce");

  const { user, db, scope } = await requireUser();
  if (!can(scope, "integration.connect")) {
    return NextResponse.json({ error: refusal(scope, "integration.connect") }, { status: 403 });
  }
  const app = await db.app.findFirst({ ...alreadyScoped("the unique key names the owner"), where: { id: appId, ownerId: user.id } });
  if (!app) return fail(req);

  const { env } = getCloudflareContext();
  const e = env as Record<string, string | undefined>;
  if (!e.LINEAR_CLIENT_ID || !e.LINEAR_CLIENT_SECRET) return fail(req);

  let token;
  try {
    token = await exchangeCode({
      code,
      redirectUri: `${req.nextUrl.origin}/api/integrations/linear/callback`,
      clientId: e.LINEAR_CLIENT_ID,
      clientSecret: e.LINEAR_CLIENT_SECRET,
    });
  } catch {
    return fail(req);
  }

  const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null;
  const accessTokenEnc = encryptSecret(token.access_token);
  // Without the refresh token the integration dies when the 24h access token
  // does (CHE-68) — freshLinearToken needs it to renew silently.
  const refreshTokenEnc = token.refresh_token ? encryptSecret(token.refresh_token) : null;

  // A reconnect must not clobber the owner's chosen team: the first-team
  // default is for first connects only (resetting joblander → first workspace
  // team on 2026-08-25 is how this line got here).
  const existing = await db.trackerIntegration.findUnique({ where: { appId } });
  const team = existing?.teamId
    ? { id: existing.teamId, name: existing.externalOrg ?? undefined }
    : await fetchFirstTeam(token.access_token);

  await db.trackerIntegration.upsert({
    where: { appId },
    create: {
      appId,
      type: "linear",
      accessTokenEnc,
      refreshTokenEnc,
      teamId: team?.id ?? null,
      externalOrg: team?.name ?? null,
      tokenExpiresAt: expiresAt,
    },
    update: {
      accessTokenEnc,
      refreshTokenEnc,
      teamId: team?.id ?? null,
      externalOrg: team?.name ?? null,
      tokenExpiresAt: expiresAt,
    },
  });

  return back(req, "connected");
}
