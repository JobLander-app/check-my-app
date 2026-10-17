// Jira OAuth callback (CHE-438). Verifies the CSRF state, exchanges the code,
// picks the site the grant reaches and a project in it, and stores the grant
// (encrypted) as the team's Jira connection, with the app filing into it
// (CHE-469).
import { NextResponse, type NextRequest } from "next/server";
import { can, refusal } from "@/lib/scopes";
import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireUser } from "@/lib/auth";
import { activeTeamContext } from "@/lib/teams";
import { connectJira } from "@/lib/tracker/jira-connect";
import { teamOwned } from "@/lib/tenant-db";
import { appPath } from "@/lib/app-shell";

function back(req: NextRequest, outcome: string, appId?: string) {
  const page = appId ? appPath.section(appId, "integrations") : "/home";
  return NextResponse.redirect(new URL(`${page}?integration=${outcome}`, req.nextUrl.origin));
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (!code || !state) return back(req, "jira_failed");

  let appId: string;
  let teamId: string;
  let nonce: string;
  try {
    ({ appId, teamId, nonce } = JSON.parse(Buffer.from(state, "base64url").toString()));
  } catch {
    return back(req, "jira_failed");
  }
  if (typeof appId !== "string" || typeof teamId !== "string" || typeof nonce !== "string") return back(req, "jira_failed");

  const jar = await cookies();
  if (jar.get("jira_oauth_nonce")?.value !== nonce) return back(req, "jira_failed");
  jar.delete("jira_oauth_nonce");

  // The team the connect was started for, and the caller's scope in it.
  const { user, db } = await requireUser();
  const context = await activeTeamContext(db, user, teamId);
  if (context.team.id !== teamId) return back(req, "jira_failed");
  if (!can(context.scope, "integration.connect")) {
    return NextResponse.json({ error: refusal(context.scope, "integration.connect") }, { status: 403 });
  }
  const app = await db.app.findFirst({ where: { ...teamOwned(teamId), id: appId } });
  if (!app) return back(req, "jira_failed");

  const e = getCloudflareContext().env as Record<string, string | undefined>;
  if (!e.JIRA_CLIENT_ID || !e.JIRA_CLIENT_SECRET) return back(req, "jira_failed", app.id);

  const outcome = await connectJira(db, {
    appId: app.id,
    code,
    redirectUri: `${req.nextUrl.origin}/api/integrations/jira/callback`,
    clientId: e.JIRA_CLIENT_ID,
    clientSecret: e.JIRA_CLIENT_SECRET,
  });
  return back(req, outcome, app.id);
}
