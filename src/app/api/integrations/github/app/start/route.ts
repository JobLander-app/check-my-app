// Begin installing the GitHub App for the active team (CHE-369). Authed; the
// team the install was started for travels in the state with a nonce, so the
// callback binds the installation to that team and not to whichever team is
// active when GitHub comes back (the CHE-417 lesson).
import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireUser } from "@/lib/auth";
import { can, refusal } from "@/lib/scopes";
import { GITHUB_INSTALL_NONCE_COOKIE, getGitHubAppEnv, installUrl } from "@/lib/github-app";

export async function GET(req: NextRequest) {
  const { team, scope } = await requireUser();
  // Installing the App lets deploys of the team's repositories start checks
  // the team pays for: the same gate as connecting a tracker.
  if (!can(scope, "integration.connect")) {
    return NextResponse.json({ error: refusal(scope, "integration.connect") }, { status: 403 });
  }
  const { env } = getCloudflareContext();
  const app = getGitHubAppEnv(env as Record<string, unknown>);
  if (!app.GITHUB_APP_SLUG) {
    return NextResponse.redirect(new URL("/settings/integrations?integration=github_unconfigured", req.url));
  }
  const nonce = crypto.randomUUID();
  const state = Buffer.from(JSON.stringify({ teamId: team.id, nonce })).toString("base64url");
  const jar = await cookies();
  jar.set(GITHUB_INSTALL_NONCE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.nextUrl.protocol === "https:",
    path: "/",
    maxAge: 600,
  });
  return NextResponse.redirect(installUrl(app.GITHUB_APP_SLUG, state));
}
