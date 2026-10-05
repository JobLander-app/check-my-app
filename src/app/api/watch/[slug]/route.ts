import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { requireScope } from "@/lib/team-auth";
import { configureWatch } from "@/lib/watch-enable";
import { updateWatchSchema } from "@/lib/validation";
import { isSelfCheckRequest, selfCheckReadOnlyResponse } from "@/lib/self-check";
import { alreadyScoped, teamOwned } from "@/lib/tenant-db";

// Resolve the team's Watch for an app slug (CHE-33 tenant-scoped; CHE-417: the
// team's app, whoever added it — the scope gate decides who may change it).
// Null if not signed in or the app/watch isn't the team's.
async function ownWatch(slug: string, req: Request) {
  const db = await getDbFromContext();
  // CHE-255: configuring a watch is `watch.configure` — a reader may read this
  // page and may not change what it costs the team.
  const decision = await requireScope(db, req, "watch.configure");
  if (!decision.ok) return { db, user: null, team: null, watch: null, refusal: decision.response, unauthorized: true as const };
  const { user, team } = decision.grant;
  const app = await db.app.findFirst({
    where: { ...teamOwned(team.id), appSlug: slug },
    orderBy: { createdAt: "asc" },
    include: { watch: true },
  });
  return { db, user, team, watch: app?.watch ?? null, unauthorized: false as const };
}

// PATCH /api/watch/{slug} — Screen 4 settings: frequency, notify rule, pause/resume.
export async function PATCH(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  // CHE-193: our own checker never changes a watch (CHE-98 was exactly this:
  // the agent pressed resume while exploring). First, before anything else.
  if (isSelfCheckRequest(req.headers)) return selfCheckReadOnlyResponse();
  const json = await req.json().catch(() => null);
  const parsed = updateWatchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const { db, user, team, watch, unauthorized, refusal } = await ownWatch((await params).slug, req);
  if (unauthorized) return refusal ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!watch) return NextResponse.json({ error: "Watch not found" }, { status: 404 });

  // CHE-315: the gate and the write are shared with the MCP watch tools
  // (src/lib/watch-enable.ts), so resuming from here and from an agent pass the
  // same plan check.
  const result = await configureWatch(db, { teamId: team?.id ?? "", plan: team?.plan ?? "free" }, watch, parsed.data);
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 403 });
  const updated = result.watch;
  return NextResponse.json({
    slug: updated.appSlug,
    active: updated.active,
    frequency: updated.frequency,
    notifyOnChangeOnly: updated.notifyOnChangeOnly,
    nextRunAt: updated.nextRunAt,
  });
}

// DELETE /api/watch/{slug} — cancel the watch. Runs keep their history; retained
// credentials are dropped with the watch (privacy §5).
export async function DELETE(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  // CHE-193: our own checker never cancels a watch. First, before anything else.
  if (isSelfCheckRequest(_req.headers)) return selfCheckReadOnlyResponse();
  const { db, watch, unauthorized, refusal } = await ownWatch((await params).slug, _req);
  if (unauthorized) return refusal ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!watch) return NextResponse.json({ error: "Watch not found" }, { status: 404 });

  await db.run.updateMany({ ...alreadyScoped("already read in this request"), where: { watchId: watch.id }, data: { watchId: null } });
  await db.watch.delete({ ...alreadyScoped("already read in this request"), where: { id: watch.id } });
  return NextResponse.json({ ok: true });
}
