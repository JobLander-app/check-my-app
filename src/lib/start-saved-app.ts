import type { PrismaClient } from "@/generated/prisma/client";
import { TERMINAL_RUN_STATUSES, type UserPlan } from "./enums";
import { assertCanStartRun, type RunGate } from "./plans";
import { captureServer } from "./analytics-server";
import { captureBalanceExhausted, isBalanceExhausted } from "./balance-events";

type RunRefusalCode = Extract<RunGate, { ok: false }>["code"];
import { nextRunNumber } from "./db";
import { triggerRun } from "./trigger";
import { effectiveSiteCap } from "./site-cap";
import { alreadyScoped, teamOwned } from "@/lib/tenant-db";
import { snapshotAppAccounts } from "@/lib/test-accounts";

// What one run of a saved app may add on top of the app's own settings. The
// dashboard's button sends none of it; an agent starting the run after a deploy
// (the MCP `start_check {app_id}`, CHE-315) names the build and what just
// shipped, exactly as a URL-started check can (CHE-56).
export interface SavedAppRunExtras {
  notes?: string;
  deploy?: { sha: string; env?: string };
}

// CHE-253: `owner` is the person acting and the team they act for. The quota
// and the plan are the team's; ownerId on the new run stays the person, because
// attribution is what isOwnRun (src/agent/notify-verdict.ts) reads to decide
// whether a verdict about one of our own hosts is silenced.
//
// CHE-315: one implementation behind the dashboard's "Run" and the MCP
// `start_check {app_id}` — both read the app's stored credentials, scope and
// notes the same way, and both pass the same quota.
export async function startSavedApp(
  db: PrismaClient,
  owner: { id: string; teamId: string; plan: UserPlan },
  appId: string,
  deps: { trigger: (runId: string) => Promise<void>; siteCap: () => number; capture?: typeof captureServer; source?: "ui" | "mcp" | "api" } = {
    trigger: triggerRun,
    siteCap: effectiveSiteCap,
    capture: captureServer,
    source: "ui",
  },
  extras: SavedAppRunExtras = {},
): Promise<{ publicId: string; alreadyRunning?: true } | { error: string; code?: RunRefusalCode }> {
  const app = await db.app.findFirst({ where: { ...teamOwned(owner.teamId), id: appId, ownerId: owner.id } });
  if (!app) return { error: "App not found." };
  // Terminal from the one table (src/lib/enums.ts). The hand-kept list here
  // omitted `canceled`, so an app whose last run was stopped deliberately
  // answered every later start with that stopped run.
  const active = await db.run.findFirst({
    where: { ...teamOwned(owner.teamId), appId, ownerId: owner.id, status: { notIn: TERMINAL_RUN_STATUSES } },
    select: { publicId: true },
  });
  // Said, not implied: a caller that named a build must be able to tell that
  // the run it got back was started before that build and is not bound to it.
  if (active) return { publicId: active.publicId, alreadyRunning: true };
  const gate = await assertCanStartRun(db, { id: owner.teamId, plan: owner.plan }, null, {
    siteCap: deps.siteCap(),
    appSlug: app.appSlug,
  });
  // The code rides along for machine callers (MCP), so "stop, the plan is
  // spent" is a branch rather than a parsed sentence; the dashboard shows the
  // sentence and ignores it.
  if (!gate.ok) {
    if (isBalanceExhausted(gate.code)) {
      await captureBalanceExhausted(deps.capture, { distinctId: owner.id, teamId: owner.teamId, plan: owner.plan, source: deps.source ?? "ui" });
    }
    return { error: gate.reason, code: gate.code };
  }
  // The app's standing notes come first; this run's focus is added after, so
  // a note like "do not delete the test account" is never displaced by it.
  const userNotes = [app.userNotes, extras.notes?.trim()].filter(Boolean).join("\n\n") || null;
  const run = await db.run.create({ ...alreadyScoped("created with its team"),
    data: {
      runNumber: await nextRunNumber(db), ownerId: owner.id, teamId: owner.teamId, appId: app.id,
      targetUrl: app.targetUrl, appSlug: app.appSlug, targetKind: app.targetKind,
      extensionId: app.extensionId, extensionConfig: app.extensionConfig,
      testEmail: app.testEmail, testPasswordEnc: app.testPasswordEnc,
      // CHE-322: and every named account, as they are right now.
      testAccounts: await snapshotAppAccounts(db, app),
      // CHE-372: and the store password, for a password-protected store.
      storePasswordEnc: app.storePasswordEnc,
      scopeHints: app.scopeHints, userNotes, focusAreas: app.focusAreas,
      deploySha: extras.deploy?.sha ?? null, deployEnv: extras.deploy?.env || null,
      startedVia: deps.source ?? "ui",
      forceFull: app.targetKind === "extension", status: "queued",
    },
    select: { id: true, publicId: true },
  });
  await deps.trigger(run.id);
  return { publicId: run.publicId };
}
