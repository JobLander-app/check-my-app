import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { requireScope } from "@/lib/team-auth";
import { getOptionalUser } from "@/lib/auth";
import { optionalTeamContext } from "@/lib/auth";
import { EPHEMERAL_WATCH_REFUSAL, enableWatchForRun } from "@/lib/watch-enable";
import { createWatchSchema } from "@/lib/validation";
import { isSelfCheckRequest, selfCheckReadOnlyResponse } from "@/lib/self-check";

// POST /api/watch — Loop B: enable Daily Watch from a verdict. Owner feature
// (CHE-33): requires auth; finds-or-creates the owner's App for the run's target,
// then upserts the owned Watch (keyed by appId, not the global appSlug — CHE-36).
// Logic shared with the verdict page's server action (CHE-75) in lib/watch-enable.
export async function POST(req: Request) {
  // CHE-193: our own checker never enables a watch. First, before anything else.
  if (isSelfCheckRequest(req.headers)) return selfCheckReadOnlyResponse();
  const db = await getDbFromContext();
  const decision = await requireScope(db, req, "watch.configure", "Sign in to enable Daily Watch");
  if (!decision.ok) return decision.response;
  const { user, team } = decision.grant;

  const json = await req.json().catch(() => null);
  const parsed = createWatchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const result = await enableWatchForRun(
    db,
    { id: user.id, teamId: team.id, plan: team.plan },
    {
      runPublicId: parsed.data.runId,
      frequency: parsed.data.frequency,
      notifyOnChangeOnly: parsed.data.notifyOnChangeOnly,
    },
  );
  switch (result.kind) {
    case "unauthenticated":
      return NextResponse.json({ error: "Sign in to enable Daily Watch" }, { status: 401 });
    case "not_found":
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    case "forbidden":
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    case "ephemeral":
      return NextResponse.json({ error: EPHEMERAL_WATCH_REFUSAL, code: "ephemeral_run" }, { status: 409 });
    case "gated":
      return NextResponse.json({ error: result.reason }, { status: 403 });
    case "ok":
      // trialEndsAt (ISO) on a Free plan's watch, null on a paid one — the one
      // place the trial stamp is readable since the apps moved to Health → All apps.
      return NextResponse.json({ slug: result.slug, trialEndsAt: result.trialEndsAt?.toISOString() ?? null }, { status: 201 });
  }
}
