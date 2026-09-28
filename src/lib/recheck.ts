// Re-check a run with the same params (Journey 7). Shared by the API route and
// the verdict page's server action (CHE-73) so both spawn identical runs: same
// target/credentials/owner, previous run as baseline for the verdict diff.

import type { PrismaClient } from "@/generated/prisma/client";
import type { UserPlan } from "@/lib/enums";
import { nextRunNumber } from "@/lib/db";
import { canMutateOwned } from "@/lib/auth";
import { assertCanStartRun } from "@/lib/plans";
import { captureServer } from "@/lib/analytics-server";
import { captureBalanceExhausted, isBalanceExhausted } from "@/lib/balance-events";
import { effectiveEphemeralTtlDays, effectiveSiteCap } from "@/lib/site-cap";
import { ephemeralExpiry } from "@/lib/ephemeral";
import { triggerRun } from "@/lib/trigger";
import { alreadyScoped, publicRow, teamOwned } from "@/lib/tenant-db";
import { snapshotAppAccounts } from "@/lib/test-accounts";
import { failedPaidCheck } from "@/lib/failed-run";

export type RecheckResult =
  | { kind: "not_found" }
  | { kind: "unauthorized" }
  // `code` is the gate's (src/lib/plans.ts RunGate), so a caller can tell an
  // empty balance — which gets the top-up and upgrade links — from the
  // anonymous funnel's caps.
  | { kind: "quota"; reason: string; code?: string }
  | { kind: "reused"; publicId: string }
  | { kind: "ok"; publicId: string };

// The pieces of createRecheckRun that reach outside the database (Clerk, the
// Workflow binding, the worker env). Production callers pass none and get the
// real ones; the verify script passes stubs, so the gate can be exercised
// without a request context.
export interface RecheckDeps {
  canMutate: (db: PrismaClient, row: { ownerId: string | null; teamId?: string | null }) => Promise<boolean>;
  trigger: (runId: string) => Promise<void>;
  siteCap: () => number;
  now: () => Date;
  // CHE-202: a re-check of an ephemeral run is ephemeral too, with its own
  // fresh expiry — the preview is still up, the verdict is still about it.
  ephemeralTtlDays: () => number;
  // CHE-327: where an empty-balance refusal is counted (balance_exhausted).
  // Absent in a verify script's deps → nothing is sent.
  capture?: typeof captureServer;
  source?: "ui" | "api";
}

// How long an anonymous visitor gets the existing verdict instead of a new run
// (CHE-94). A verdict page URL is public by design, so an unguarded re-check
// button is an open tap on our LLM spend: one shared link, one bot, unlimited
// $0.30-$2.30 runs. Owners are unaffected — they may re-check whenever their
// team's balance allows (CHE-327).
const ANON_REUSE_WINDOW_MS = 6 * 60 * 60 * 1000;

export async function createRecheckRun(
  prisma: PrismaClient,
  publicId: string,
  opts: { full?: boolean; anonKeyHash?: string | null } = {},
  // CHE-263: a caller may override just the authorization half — the recheck
  // route does, so an API key is answered the same way a session is.
  overrides: Partial<RecheckDeps> = {},
  deps: RecheckDeps = {
    canMutate: (db, row) => canMutateOwned(db, row.ownerId),
    trigger: triggerRun,
    siteCap: effectiveSiteCap,
    now: () => new Date(),
    ephemeralTtlDays: effectiveEphemeralTtlDays,
    capture: captureServer,
    source: "ui",
    ...overrides,
  },
): Promise<RecheckResult> {
  const prev = await prisma.run.findUnique({ ...publicRow(),
    where: { publicId },
    select: {
      id: true,
      targetUrl: true,
      targetKind: true,
      extensionId: true,
      extensionConfig: true,
      appSlug: true,
      testEmail: true,
      testPasswordEnc: true,
      testAccounts: true,
      scopeHints: true,
      userNotes: true,
      focusAreas: true,
      notifyEmail: true,
      watchId: true,
      appId: true,
      ownerId: true,
      ephemeral: true,
      teamId: true,
      status: true,
      paidCheckoutSessionId: true,
      // CHE-253: the plan is the TEAM's — the person who clicks may not be the
      // one who pays. CHE-137: the CURRENT plan decides the allowance,
      // so an upgrade takes effect on the next click with nothing to sync.
      team: { select: { plan: true } },
    },
  });
  if (!prev) return { kind: "not_found" };

  // A recheck spends money + may touch the owner's app — owned runs require the
  // owner; anonymous runs are authorized by the unguessable publicId (CHE-33).
  if (!(await deps.canMutate(prisma, { ownerId: prev.ownerId, teamId: prev.teamId })))
    return { kind: "unauthorized" };

  // CHE-94. Everything below is about the ANONYMOUS path: the caller proved
  // nothing except that they have the link.
  const isAnonymous = !prev.ownerId;
  // CHE-327: an owner's re-check — regular or full, website or extension —
  // spends the team's balance like any other check. There is no separate
  // allowance for full re-checks any more: a full walk simply costs what it
  // walks, and the price says so.
  if (prev.ownerId && prev.teamId) {
    const gate = await assertCanStartRun(
      prisma,
      // CHE-260: the run's TEAM pays for it, whoever pressed the button.
      { id: prev.teamId, plan: (prev.team?.plan ?? "free") as UserPlan },
      null,
      { siteCap: deps.siteCap(), appSlug: prev.appSlug, now: deps.now() },
    );
    if (!gate.ok) {
      if (isBalanceExhausted(gate.code)) {
        await captureBalanceExhausted(deps.capture, {
          distinctId: prev.ownerId,
          teamId: prev.teamId,
          plan: prev.team?.plan ?? "free",
          source: deps.source ?? "ui",
        });
      }
      return { kind: "quota", reason: gate.reason, code: gate.code };
    }
  }
  // CHE-335: a $1 check that ended failed bought a verdict it never got. Its
  // one re-check is owed, not granted: no reuse window, no free-funnel cap
  // (the cap was already spent, which is why they paid), and it does not eat
  // the visitor's own free check either. Once — the re-check names this run as
  // its baseline, and a second press goes through the gates like any other.
  const owedRetry = isAnonymous && !opts.full && (await paidRetryOwed(prisma, prev));
  if (isAnonymous && !owedRetry) {
    // A full walk is the expensive mode and exists for owners who just shipped
    // something. Nobody holding a public link gets to spend that.
    if (opts.full) {
      return {
        kind: "quota",
        reason: "A full re-check is available to the owner of this app. Sign in to run one.",
      };
    }
    const fresh = await prisma.run.findFirst({ ...publicRow(),
      where: {
        appSlug: prev.appSlug,
        status: "completed",
        completedAt: { gte: new Date(deps.now().getTime() - ANON_REUSE_WINDOW_MS) },
      },
      orderBy: { completedAt: "desc" },
      select: { publicId: true },
    });
    if (fresh) return { kind: "reused", publicId: fresh.publicId };

    // No fresh verdict to hand back, so this WOULD spend money. The submission
    // form has counted anonymous runs since CHE-40; the re-check button never
    // did, which left the same tap open one step further down the funnel — a
    // shared link could produce a run every time the reuse window lapsed.
    const gate = await assertCanStartRun(prisma, null, opts.anonKeyHash ?? null, {
      siteCap: deps.siteCap(),
    });
    if (!gate.ok) return { kind: "quota", reason: gate.reason, code: gate.code };
  }

  // On-demand runs discard their password after completion. Only the same
  // owner's saved extension may supply credentials for the next explicit run.
  const saved = prev.targetKind === "extension" && prev.appId && prev.ownerId
    ? await prisma.app.findFirst({ ...alreadyScoped("the previous run names its own app"), where: { id: prev.appId, ownerId: prev.ownerId, targetKind: "extension", extensionId: prev.extensionId },
      select: { testEmail: true, testPasswordEnc: true, extensionConfig: true, userNotes: true } }) : null;
  // CHE-322: a re-check of a saved website's run signs in as the app does NOW —
  // its default login and every named account. The run being re-checked lost
  // its passwords when it ended (workflow.ts "cleanup") unless a watch kept
  // them, so copying them forward re-checked a signed-in app signed out, and
  // would carry no named account at all. Only the credentials come from the
  // app: this run's notes and scope stay the ones it was started with.
  const appLogin = !saved && prev.targetKind !== "extension" && prev.appId && prev.ownerId && prev.teamId
    ? await prisma.app.findFirst({ where: { ...teamOwned(prev.teamId), id: prev.appId },
      select: { id: true, teamId: true, targetKind: true, testEmail: true, testPasswordEnc: true } }) : null;
  const login = saved ?? appLogin ?? prev;
  const run = await prisma.run.create({ ...alreadyScoped("created with its team"),
    data: {
      runNumber: await nextRunNumber(prisma),
      targetUrl: prev.targetUrl,
      targetKind: prev.targetKind,
      extensionId: prev.extensionId,
      extensionConfig: saved?.extensionConfig ?? prev.extensionConfig,
      appSlug: prev.appSlug,
      testEmail: login.testEmail,
      testPasswordEnc: login.testPasswordEnc,
      testAccounts: appLogin ? await snapshotAppAccounts(prisma, appLogin) : saved ? null : prev.testAccounts,
      scopeHints: prev.scopeHints,
      userNotes: saved ? saved.userNotes : prev.userNotes,
      focusAreas: prev.focusAreas,
      notifyEmail: prev.notifyEmail,
      watchId: prev.watchId,
      appId: prev.appId,
      ownerId: prev.ownerId,
      teamId: prev.teamId,
      baselineRunId: prev.id,
      // CHE-74: an explicit full re-check must not be eaten by smoke/partial.
      forceFull: opts.full ?? false,
      startedVia: prev.ownerId ? (deps.source ?? "ui") : "anon",
      // Anonymous re-checks count against the same daily allowance as
      // anonymous submissions (CHE-97).
      anonKeyHash: prev.ownerId || owedRetry ? null : (opts.anonKeyHash ?? null),
      // CHE-202: ephemeral begets ephemeral. An ephemeral run is always owned
      // (the API refuses anonymous ones), so it never reaches the anonymous
      // path above; and it has no appId/watchId to copy — they are null.
      ephemeral: prev.ephemeral,
      expiresAt: prev.ephemeral ? ephemeralExpiry(deps.now(), deps.ephemeralTtlDays()) : null,
      status: "queued",
    },
    select: { id: true, publicId: true },
  });

  await deps.trigger(run.id);
  return { kind: "ok", publicId: run.publicId };
}

// Whether a failed run is a paid $1 check whose one re-check has not been
// started yet (CHE-335). The failed-run page asks the same question to say so.
export async function paidRetryOwed(
  prisma: PrismaClient,
  run: { id: string; status: string; paidCheckoutSessionId: string | null },
): Promise<boolean> {
  if (!failedPaidCheck(run)) return false;
  const retried = await prisma.run.findFirst({ ...publicRow(), where: { baselineRunId: run.id }, select: { id: true } });
  return !retried;
}
