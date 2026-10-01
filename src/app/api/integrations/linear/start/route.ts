// Begin Linear OAuth for an App (CHE-31). Authed; verifies the App belongs to
// the caller, then redirects to Linear's consent screen with a CSRF state.
import { NextResponse, type NextRequest } from "next/server";
import { can, refusal } from "@/lib/scopes";
import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { requireUser } from "@/lib/auth";
import { PLAN_LIMITS } from "@/lib/plans";
import type { UserPlan } from "@/lib/enums";
import { buildAuthorizeUrl } from "@/lib/tracker/linear-oauth";
import { teamOwned } from "@/lib/tenant-db";

export async function GET(req: NextRequest) {
  const appId = req.nextUrl.searchParams.get("appId");
  if (!appId) return NextResponse.json({ error: "appId required" }, { status: 400 });

  // CHE-253: the plan that carries tracker integrations is the team's.
  const { user, db, team, scope } = await requireUser();
  // CHE-255: connecting a tracker stores a token for the whole team.
  if (!can(scope, "integration.connect")) {
    return NextResponse.json({ error: refusal(scope, "integration.connect") }, { status: 403 });
  }
  if (!PLAN_LIMITS[team.plan as UserPlan].trackerIntegration) {
    return NextResponse.json({ error: "Tracker integrations require a paid plan." }, { status: 403 });
  }
  const app = await db.app.findFirst({ where: { ...teamOwned(team.id), id: appId, ownerId: user.id } });
  if (!app) return NextResponse.json({ error: "app not found" }, { status: 404 });

  const { env } = getCloudflareContext();
  const clientId = (env as Record<string, string | undefined>).LINEAR_CLIENT_ID;
  if (!clientId) {
    // OAuth env not set yet (owner step). Send the user who clicked "Connect
    // Linear" back to a friendly dashboard notice instead of a raw JSON 503.
    return NextResponse.redirect(new URL("/home?integration=linear_unconfigured", req.url));
  }

  // CSRF: random nonce in an httpOnly cookie; appId travels in the signed-ish state.
  const nonce = crypto.randomUUID();
  const state = Buffer.from(JSON.stringify({ appId, nonce })).toString("base64url");
  const jar = await cookies();
  jar.set("linear_oauth_nonce", nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.nextUrl.protocol === "https:",
    path: "/",
    maxAge: 600,
  });

  const redirectUri = `${req.nextUrl.origin}/api/integrations/linear/callback`;
  return NextResponse.redirect(buildAuthorizeUrl({ clientId, redirectUri, state }));
}
