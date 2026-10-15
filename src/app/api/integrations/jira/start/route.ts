// Begin Jira OAuth for an App (CHE-438) — the Linear flow (CHE-31) for Jira
// Cloud. Authed, admin only, the team's app; then Atlassian's consent screen
// with a CSRF state.
import { NextResponse, type NextRequest } from "next/server";
import { can, refusal } from "@/lib/scopes";
import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireUser } from "@/lib/auth";
import { PLAN_LIMITS } from "@/lib/plans";
import type { UserPlan } from "@/lib/enums";
import { buildJiraAuthorizeUrl } from "@/lib/tracker/jira";
import { teamOwned } from "@/lib/tenant-db";
import { appPath } from "@/lib/app-shell";

export async function GET(req: NextRequest) {
  const appId = req.nextUrl.searchParams.get("appId");
  if (!appId) return NextResponse.json({ error: "appId required" }, { status: 400 });

  const { db, team, scope } = await requireUser();
  if (!can(scope, "integration.connect")) {
    return NextResponse.json({ error: refusal(scope, "integration.connect") }, { status: 403 });
  }
  if (!PLAN_LIMITS[team.plan as UserPlan].trackerIntegration) {
    return NextResponse.json({ error: "Tracker integrations require a paid plan." }, { status: 403 });
  }
  const app = await db.app.findFirst({ where: { ...teamOwned(team.id), id: appId } });
  if (!app) return NextResponse.json({ error: "app not found" }, { status: 404 });

  const { env } = getCloudflareContext();
  const clientId = (env as Record<string, string | undefined>).JIRA_CLIENT_ID;
  if (!clientId) {
    return NextResponse.redirect(new URL(`${appPath.section(app.id, "integrations")}?integration=jira_unconfigured`, req.url));
  }

  const nonce = crypto.randomUUID();
  const state = Buffer.from(JSON.stringify({ appId, teamId: team.id, nonce })).toString("base64url");
  const jar = await cookies();
  jar.set("jira_oauth_nonce", nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.nextUrl.protocol === "https:",
    path: "/",
    maxAge: 600,
  });

  const redirectUri = `${req.nextUrl.origin}/api/integrations/jira/callback`;
  return NextResponse.redirect(buildJiraAuthorizeUrl({ clientId, redirectUri, state }));
}
