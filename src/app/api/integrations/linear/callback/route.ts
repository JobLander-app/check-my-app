// Linear OAuth callback (CHE-31). Verifies CSRF state, exchanges the code for an
// access token, and stores it (encrypted) as the App's TrackerIntegration.
import { NextResponse, type NextRequest } from "next/server";
import { can, refusal } from "@/lib/scopes";
import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireUser } from "@/lib/auth";
import { activeTeamContext } from "@/lib/teams";
import { exchangeCode, fetchFirstTeam } from "@/lib/tracker/linear-oauth";
import { encryptSecret } from "@/lib/crypto";
import { teamOwned } from "@/lib/tenant-db";
import { appPath } from "@/lib/app-shell";

// Every exit lands on a sentence from src/lib/integration-notice.ts (CHE-67):
// on the app's Integrations section, where Connect was pressed, once the app is
// known from the state; on Today before that — never a raw JSON error or an
// opaque status code.
function back(req: NextRequest, outcome: "linear_connected" | "linear_failed", appId?: string) {
  const page = appId ? appPath.section(appId, "integrations") : "/home";
  return NextResponse.redirect(new URL(`${page}?integration=${outcome}`, req.nextUrl.origin));
}

function fail(req: NextRequest, appId?: string) {
  return back(req, "linear_failed", appId);
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (!code || !state) return fail(req);

  let appId: string;
  let stated: string | undefined;
  let nonce: string;
  try {
    ({ appId, teamId: stated, nonce } = JSON.parse(Buffer.from(state, "base64url").toString()));
  } catch {
    return fail(req);
  }
  if (typeof appId !== "string" || typeof nonce !== "string" || (stated !== undefined && typeof stated !== "string")) return fail(req);

  const jar = await cookies();
  if (jar.get("linear_oauth_nonce")?.value !== nonce) return fail(req);
  jar.delete("linear_oauth_nonce");

  // The team is the one the connect was started for (in the state), not the
  // one active now — a switch in another tab while Linear asks for consent
  // must not turn a valid authorization into "failed" (CHE-417). The caller's
  // scope is read in that team: activeTeamContext falls back to another team
  // for a non-member, so the id is compared, not assumed. A state minted
  // before the team travelled in it (the nonce cookie lives ten minutes, so
  // only across the deploy that introduced this) is the active team's.
  const { user, db, team: active } = await requireUser();
  const teamId = stated ?? active.id;
  const context = await activeTeamContext(db, user, teamId);
  if (context.team.id !== teamId) return fail(req);
  if (!can(context.scope, "integration.connect")) {
    return NextResponse.json({ error: refusal(context.scope, "integration.connect") }, { status: 403 });
  }
  // CHE-417: the team's app, whoever added it — the scope gate above decided.
  const app = await db.app.findFirst({ where: { ...teamOwned(teamId), id: appId } });
  if (!app) return fail(req);

  const { env } = getCloudflareContext();
  const e = env as Record<string, string | undefined>;
  if (!e.LINEAR_CLIENT_ID || !e.LINEAR_CLIENT_SECRET) return fail(req, app.id);

  let token;
  try {
    token = await exchangeCode({
      code,
      redirectUri: `${req.nextUrl.origin}/api/integrations/linear/callback`,
      clientId: e.LINEAR_CLIENT_ID,
      clientSecret: e.LINEAR_CLIENT_SECRET,
    });
  } catch {
    return fail(req, app.id);
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

  return back(req, "linear_connected", app.id);
}
