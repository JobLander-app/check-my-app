import { NextResponse } from "next/server";
import { getDbFromContext } from "@/lib/db";
import { getOwnerFromRequest } from "@/lib/auth";
import { callerScope, callerTeamContext } from "@/lib/team-auth";
import { funnelAllows, refusal } from "@/lib/scopes";
import { hashClientKey } from "@/lib/crypto";
import { assertCanStartRun } from "@/lib/plans";
import { effectiveEphemeralTtlDays, effectiveSiteCap } from "@/lib/site-cap";
import { ephemeralExpiry, ephemeralGate } from "@/lib/ephemeral";
import { startCheck } from "@/lib/start-check";
import { distinctIdFromCookies } from "@/lib/analytics-server";
import { appSlugFromUrl } from "@/lib/utils";
import { createCheckSchema } from "@/lib/validation";
import { verifyTurnstile } from "@/lib/turnstile";
import { isSelfCheckRequest, selfCheckReadOnlyResponse } from "@/lib/self-check";
import type { UserPlan } from "@/lib/enums";
import { publicRow } from "@/lib/tenant-db";

// POST /api/checks — create a run from a submission and trigger it.
export async function POST(req: Request) {
  // CHE-193: our own checker never creates a run. First, before anything else.
  if (isSelfCheckRequest(req.headers)) return selfCheckReadOnlyResponse();
  const prisma = await getDbFromContext();
  const json = (await req.json().catch(() => null)) as { turnstileToken?: string } | null;
  const clientIp = req.headers.get("cf-connecting-ip");

  // Attribute the run to the caller (if any) so it's tenant-scoped and shows on
  // their dashboard: a Clerk session or an owner API key (CHE-52). Anonymous
  // free-run funnel keeps ownerId null.
  const auth = await getOwnerFromRequest(prisma, req);
  const owner = auth?.user ?? null;

  // Bot protection (enforced only when TURNSTILE_SECRET is configured).
  // API-key callers are machine-to-machine (CI hooks, MCP clients) — a valid
  // key already proves they're a real account, and they can't run a browser
  // Turnstile challenge, so the check applies to browser paths only.
  if (auth?.via !== "api_key") {
    const ok = await verifyTurnstile(json?.turnstileToken, clientIp ?? undefined);
    if (!ok) {
      // `code` is for machine callers (the MCP server, CI): without a key they
      // land here every time, and the code names the fix — an API key.
      return NextResponse.json(
        { error: "Verification failed — please retry.", code: "turnstile_failed" },
        { status: 403 },
      );
    }
  }

  const parsed = createCheckSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const input = parsed.data;

  // CHE-202: an ephemeral run (a PR preview) is an owner's run — private, no
  // App row, deleted after its TTL. An anonymous request for one is refused
  // with a code, never downgraded into a public check of a preview URL.
  const ephemeral = ephemeralGate(input.ephemeral, owner);
  if (!ephemeral.ok) {
    return NextResponse.json({ error: ephemeral.reason, code: ephemeral.code }, { status: 400 });
  }
  const expiresAt = ephemeral.ephemeral
    ? ephemeralExpiry(new Date(), effectiveEphemeralTtlDays())
    : null;

  // Anonymous same-domain reuse (CHE-80). Six anonymous example.com runs in 30
  // minutes (2026-08-26, distributed IPs) each burned real LLM spend on a
  // target we had just verified. Anonymous runs are public anyway (owner call,
  // CHE-39), so an anon re-submission of a domain with a fresh completed
  // verdict gets that verdict instead of a new run. Owners always get a real
  // run — they may be testing a deploy that just went out.
  if (!owner) {
    const fresh = await prisma.run.findFirst({ ...publicRow(),
      where: {
        appSlug: appSlugFromUrl(input.url),
        status: "completed",
        completedAt: { gte: new Date(Date.now() - 6 * 60 * 60 * 1000) },
      },
      orderBy: { completedAt: "desc" },
      select: { publicId: true },
    });
    if (fresh) {
      return NextResponse.json({ id: fresh.publicId, reused: true }, { status: 200 });
    }
  }

  // Run quota (CHE-40). Checked after Turnstile so bot floods never burn a real
  // client's allowance, and before the insert so a rejected run is never billed.
  const anonKeyHash = owner ? null : await hashClientKey(clientIp);
  // CHE-253: the quota is the team's, not the person's — inviting a colleague
  // must not mint a second allowance. CHE-316: a key caller spends its key's
  // team, so a Free team's key meets quota_free exactly as the dashboard does.
  const context = await callerTeamContext(prisma, req, auth);
  // CHE-265: a stranger is welcome here; somebody signed in is judged by their
  // own scope. A reader-scope key started a check in production before this
  // existed — authentication had made the caller LESS restricted, because
  // "public" had only one meaning.
  const scope = await callerScope(prisma, req);
  if (!funnelAllows(scope, "run.start")) {
    return NextResponse.json({ error: refusal(scope!, "run.start") }, { status: 403 });
  }
  const gate = await assertCanStartRun(
    prisma,
    context ? { id: context.team.id, plan: context.team.plan as UserPlan } : null,
    anonKeyHash,
    { siteCap: effectiveSiteCap() },
  );
  if (!gate.ok) {
    return NextResponse.json({ error: gate.reason, code: gate.code }, { status: 429 });
  }

  // Insert + hand-off to the agent, shared with the paid one-off check. The
  // browser's PostHog id rides along so `run_created` joins its own events.
  const run = await startCheck(prisma, {
    input,
    ownerId: owner?.id ?? null,
    teamId: context?.team.id ?? null,
    anonKeyHash,
    ephemeral: expiresAt ? { expiresAt } : undefined,
    distinctId: distinctIdFromCookies(req.headers.get("cookie")),
  });

  // The /run/{id} URL uses the unguessable public id. An ephemeral run also
  // says when it will be gone, so a CI log can carry the date.
  return NextResponse.json(
    expiresAt ? { id: run.publicId, ephemeral: true, expiresAt } : { id: run.publicId },
    { status: 201 },
  );
}
