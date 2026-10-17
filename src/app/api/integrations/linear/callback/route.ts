// Linear OAuth callback (CHE-31). Verifies CSRF state, exchanges the code for an
// access token, and stores it (encrypted) as the team's Linear connection, with
// the app filing into it (CHE-469).
import { NextResponse, type NextRequest } from "next/server";
import { can, refusal } from "@/lib/scopes";
import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireUser } from "@/lib/auth";
import { activeTeamContext } from "@/lib/teams";
import { exchangeCode, fetchTeams } from "@/lib/tracker/linear-oauth";
import { saveLinearGrant } from "@/lib/tracker/linear-connect";
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

  // The grant stored as the team's (CHE-469), the team kept on a reconnect,
  // the type set on a switch from Jira, and the Jira links retired:
  // src/lib/tracker/linear-connect.ts (CHE-438).
  await saveLinearGrant(db, app, token, () => fetchTeams(token.access_token));

  return back(req, "linear_connected", app.id);
}
