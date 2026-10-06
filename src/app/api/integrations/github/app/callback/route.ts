// Where GitHub sends the person after installing the App (CHE-369): binds the
// installation to the team the install was started for, reads the
// repositories it can see, and lands on Integrations with a sentence.
//
// GitHub puts `installation_id`, `setup_action` and our `state` on the App's
// setup URL (/settings/integrations); that page forwards them here. An
// install begun on GitHub itself arrives with no state: it binds to the
// active team — the person is signed in there and holds the scope — after the
// App has confirmed the installation exists.
import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireUser } from "@/lib/auth";
import { activeTeamContext } from "@/lib/teams";
import { can, refusal } from "@/lib/scopes";
import { GITHUB_INSTALL_NONCE_COOKIE, appConfigured, getGitHubAppEnv, installationInfo } from "@/lib/github-app";
import { syncInstallationRepos } from "@/lib/github-webhook";
import { alreadyScoped } from "@/lib/tenant-db";

function back(req: NextRequest, outcome: "github_installed" | "github_failed" | "github_unconfigured") {
  return NextResponse.redirect(new URL(`/settings/integrations?integration=${outcome}`, req.nextUrl.origin));
}

export async function GET(req: NextRequest) {
  const installationId = Number(req.nextUrl.searchParams.get("installation_id"));
  const state = req.nextUrl.searchParams.get("state");
  if (!Number.isInteger(installationId) || installationId <= 0) return back(req, "github_failed");

  let stated: string | undefined;
  if (state) {
    let nonce: string | undefined;
    try {
      ({ teamId: stated, nonce } = JSON.parse(Buffer.from(state, "base64url").toString()));
    } catch {
      return back(req, "github_failed");
    }
    if (typeof stated !== "string" || typeof nonce !== "string") return back(req, "github_failed");
    const jar = await cookies();
    const givenNonce = jar.get(GITHUB_INSTALL_NONCE_COOKIE)?.value;
    if (givenNonce !== nonce) return back(req, "github_failed");
    jar.delete(GITHUB_INSTALL_NONCE_COOKIE);
  }

  const { user, db, team: active } = await requireUser();
  const teamId = stated ?? active.id;
  const context = await activeTeamContext(db, user, teamId);
  if (context.team.id !== teamId) return back(req, "github_failed");
  if (!can(context.scope, "integration.connect")) {
    return NextResponse.json({ error: refusal(context.scope, "integration.connect") }, { status: 403 });
  }

  const { env } = getCloudflareContext();
  const app = getGitHubAppEnv(env as Record<string, unknown>);
  if (!appConfigured(app)) return back(req, "github_unconfigured");

  // The App itself says whether this installation is real and whose account
  // it is on; a guessed id in the URL binds nothing.
  let info;
  try {
    info = await installationInfo(app, installationId, (url, init) => fetch(url, init));
  } catch {
    return back(req, "github_failed");
  }

  // A reinstall on the same account keeps its mapping (the rows beneath); a
  // second team claiming someone else's installation is refused — the
  // installation belongs to whoever connected it first.
  const existing = await db.gitHubInstallation.findUnique({ ...alreadyScoped("a signed GitHub delivery names the installation"), where: { installationId }, select: { teamId: true } });
  if (existing && existing.teamId !== teamId) return back(req, "github_failed");
  await db.gitHubInstallation.upsert({
    where: { installationId },
    create: { installationId, accountLogin: info.account.login, accountType: info.account.type, teamId, connectedById: user.id, suspendedAt: null },
    update: { accountLogin: info.account.login, accountType: info.account.type, suspendedAt: null },
  });
  try {
    await syncInstallationRepos(db, app, installationId, (url, init) => fetch(url, init));
  } catch (err) {
    // The installation is bound; the repository list arrives with the next
    // delivery or the next visit. Not a failure the person can act on.
    console.warn(`[github-app] repositories of installation ${installationId} not listed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return back(req, "github_installed");
}
