import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { requireScope } from "@/lib/team-auth";
import { getOptionalUser } from "@/lib/auth";
import { optionalTeamContext } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { GitHubError, validateRepoAccess } from "@/lib/github";
import { connectGithubSchema } from "@/lib/validation";
import { alreadyScoped, publicRow } from "@/lib/tenant-db";
import { isSelfCheckRequest, selfCheckReadOnlyResponse } from "@/lib/self-check";

// POST /api/integrations/github — connect a repo for spec export from a verdict.
// v1 is a fine-grained PAT (no GitHub OAuth app yet): validated against the
// repo, then stored encrypted per App. Mirrors the Watch adoption pattern
// (CHE-33): a signed-in user connecting from an anonymous run's verdict
// find-or-creates their App for that target and adopts the run.
export async function POST(req: Request) {
  if (isSelfCheckRequest(req.headers)) return selfCheckReadOnlyResponse();
  const db = await getDbFromContext();
  const decision = await requireScope(db, req, "integration.connect");
  if (!decision.ok) return decision.response;
  const { user, team } = decision.grant;
  const context = { team };
  if (!user) {
    return NextResponse.json({ error: "Sign in to connect GitHub" }, { status: 401 });
  }

  const json = await req.json().catch(() => null);
  const parsed = connectGithubSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const run = await db.run.findUnique({ ...publicRow(),
    where: { publicId: parsed.data.runId },
    select: { id: true, ownerId: true, appId: true, appSlug: true, targetUrl: true, targetKind: true, extensionId: true, extensionConfig: true, ephemeral: true },
  });
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if (run.ownerId && run.ownerId !== user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  // CHE-202: the upsert below would register the preview hostname as an App.
  if (run.ephemeral) {
    return NextResponse.json(
      { error: "Connect GitHub from a check of the app's real address, not a preview.", code: "ephemeral_run" },
      { status: 409 },
    );
  }

  // Prove the token works on this repo before persisting anything.
  let defaultBranch: string;
  try {
    ({ defaultBranch } = await validateRepoAccess(parsed.data.token, parsed.data.repo));
  } catch (e) {
    if (e instanceof GitHubError) {
      const msg =
        e.status === 401
          ? "GitHub rejected the token — check it hasn't expired."
          : e.status === 404
            ? "Repo not found — check owner/repo and that the token is scoped to it."
            : e.message;
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    throw e;
  }

  const app = await db.app.upsert({ ...alreadyScoped("the unique key names the owner"),
    where: { ownerId_appSlug: { ownerId: user.id, appSlug: run.appSlug } },
    update: {},
    create: {
      ownerId: user.id,
      teamId: context?.team.id ?? null,
      targetUrl: run.targetUrl,
      appSlug: run.appSlug,
      targetKind: run.targetKind,
      extensionId: run.extensionId,
      extensionConfig: run.extensionConfig,
    },
  });

  const tokenEnc = encryptSecret(parsed.data.token);
  await db.repoIntegration.upsert({
    where: { appId: app.id },
    create: {
      appId: app.id,
      provider: "github",
      tokenEnc,
      repoFullName: parsed.data.repo,
      defaultBranch,
    },
    update: { tokenEnc, repoFullName: parsed.data.repo, defaultBranch },
  });

  // Adopt the source run so the verdict page renders as owned from now on.
  if (!run.ownerId || run.appId !== app.id) {
    await db.run.update({ ...alreadyScoped("already read in this request"), where: { id: run.id }, data: { ownerId: user.id, appId: app.id } });
  }

  return NextResponse.json(
    { repoFullName: parsed.data.repo, defaultBranch },
    { status: 201 },
  );
}

// DELETE /api/integrations/github?runId={publicId} — disconnect the repo for
// the run's target app (drops the stored token).
export async function DELETE(req: Request) {
  if (isSelfCheckRequest(req.headers)) return selfCheckReadOnlyResponse();
  const db = await getDbFromContext();
  const user = await getOptionalUser(db);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const runId = new URL(req.url).searchParams.get("runId");
  if (!runId) return NextResponse.json({ error: "runId required" }, { status: 400 });

  const run = await db.run.findUnique({ ...publicRow(),
    where: { publicId: runId },
    select: { appSlug: true },
  });
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const app = await db.app.findUnique({ ...alreadyScoped("the unique key names the owner"),
    where: { ownerId_appSlug: { ownerId: user.id, appSlug: run.appSlug } },
    select: { id: true },
  });
  if (app) await db.repoIntegration.deleteMany({ where: { appId: app.id } });

  return NextResponse.json({ ok: true });
}
