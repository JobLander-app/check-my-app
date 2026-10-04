import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getOptionalUser } from "@/lib/auth";
import { LinearTracker } from "@/lib/tracker/linear";
import { freshLinearToken } from "@/lib/tracker/token";
import { decideTicketAction } from "@/lib/tracker/decision";
import { draftForFinding, dedupKeyForFinding, ticketPriority } from "@/lib/tracker/file";
import { PRIORITY_META } from "@/lib/issue-priority";
import { isSelfCheckRequest, selfCheckReadOnlyResponse } from "@/lib/self-check";
import { alreadyScoped } from "@/lib/tenant-db";

// POST /api/findings/{id}/ticket — file this finding into the owner's tracker
// using the parameters they set at onboarding (TicketPolicy) and their Linear
// OAuth connection (TrackerIntegration). Owner-only; idempotent per finding via
// IssueLink dedup (re-click comments on the open issue instead of refiling).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  // CHE-193: our own checker never files a ticket. First, before anything else.
  if (isSelfCheckRequest(_req.headers)) return selfCheckReadOnlyResponse();
  const prisma = await getDbFromContext();
  const user = await getOptionalUser(prisma);
  if (!user) {
    return NextResponse.json({ error: "Sign in to create tickets." }, { status: 401 });
  }

  const finding = await prisma.finding.findUnique({
    where: { id: (await params).id },
    include: { run: true, evidence: true },
  });
  if (!finding) return NextResponse.json({ error: "Finding not found" }, { status: 404 });

  const app = await prisma.app.findUnique({ ...alreadyScoped("the unique key names the owner"),
    where: { ownerId_appSlug: { ownerId: user.id, appSlug: finding.run.appSlug } },
    include: { tracker: true, policy: true },
  });
  if (!app || (finding.run.ownerId && finding.run.ownerId !== user.id)) {
    return NextResponse.json({ error: "Only the app owner can create tickets." }, { status: 403 });
  }
  if (!app.tracker) {
    return NextResponse.json(
      { error: "linear_not_connected", message: "Connect Linear from your dashboard first." },
      { status: 409 },
    );
  }
  if (!app.tracker.teamId) {
    return NextResponse.json(
      { error: "no_team", message: "Pick a Linear team on your dashboard first." },
      { status: 409 },
    );
  }

  const policy = app.policy;

  const cfEnv = getCloudflareContext().env as Record<string, string | undefined>;
  const tracker = new LinearTracker(
    await freshLinearToken(prisma, app.tracker, {
      clientId: cfEnv.LINEAR_CLIENT_ID,
      clientSecret: cfEnv.LINEAR_CLIENT_SECRET,
    }),
    app.tracker.teamId,
  );
  const dedupKey = dedupKeyForFinding(finding, finding.run);

  try {
    const existing = await prisma.issueLink.findUnique({
      where: { appId_dedupKey: { appId: app.id, dedupKey } },
    });
    const action = decideTicketAction(
      existing
        ? {
            status: existing.status,
            occurrences: existing.occurrences,
            escalatedAt: existing.escalatedAt,
          }
        : null,
      policy?.escalateAfterRuns ?? 3,
    );
    // Same draft the agent's auto-file pass builds (CHE-50) — one ticket shape,
    // one dedup namespace, one priority (CHE-413, this occurrence counted) —
    // whether the owner clicked or the Watch found it.
    const priority = await ticketPriority(prisma, finding, action.kind === "comment" && existing ? existing.occurrences + 1 : 1);
    const draft = draftForFinding({ ...finding, priority }, finding.run, policy, `${new URL(_req.url).origin}/verdict/${finding.run.publicId}`);

    if (action.kind === "comment" && existing) {
      await tracker.addComment(
        existing.externalIssueId,
        `Re-filed from CheckMyApp — still present in run #${finding.run.runNumber} (${draft.title}).\n` +
          `**Priority:** ${priority} — ${PRIORITY_META[priority].meaning}`,
      );
      await prisma.issueLink.update({
        where: { id: existing.id },
        data: { occurrences: { increment: 1 }, lastSeenAt: new Date() },
      });
      return NextResponse.json({ identifier: existing.externalIssueId, commented: true });
    }

    const issue = await tracker.createIssue(draft);
    await prisma.issueLink.upsert({
      where: { appId_dedupKey: { appId: app.id, dedupKey } },
      create: {
        appId: app.id,
        dedupKey,
        externalIssueId: issue.identifier,
        firstSeenRunId: finding.runId,
      },
      update: { externalIssueId: issue.identifier, status: "open", lastSeenAt: new Date() },
    });
    return NextResponse.json({ identifier: issue.identifier, url: issue.url }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Tracker call failed" },
      { status: 502 },
    );
  }
}
