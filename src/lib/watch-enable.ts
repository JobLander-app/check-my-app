// Enable Daily Watch from a verdict (Loop B). Shared by the API route and the
// verdict page's server action (CHE-75) so both paths create identical watches:
// find-or-create the owner's App for the run's target, upsert the owned Watch,
// adopt the source run as baseline.

import type { PrismaClient } from "@/generated/prisma/client";
import type { UserPlan, WatchFrequency } from "@/lib/enums";
import { TRIAL_ENDED_REASON, assertCanAddWatch, shouldSkipWatch, watchTrialEnd } from "@/lib/plans";
import { alreadyScoped, publicRow, teamOwned } from "@/lib/tenant-db";
import { isPrivateTarget, PRIVATE_TARGET_MESSAGE } from "@/lib/private-target";

export type EnableWatchResult =
  | { kind: "unauthenticated" }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  // CHE-202: an ephemeral run (a PR preview) never becomes an App.
  | { kind: "ephemeral" }
  | { kind: "gated"; reason: string }
  // trialEndsAt: when a Free plan's watch stops being run by itself (CHE-54);
  // null on a paid plan. Said to the caller because nothing else says it since
  // the apps moved to Health → All apps (CHE-348): the card shows "Daily" for a
  // trial and for a paid watch alike, and a trial that was never stamped would
  // run forever and look the same (Codex on #270).
  | { kind: "ok"; slug: string; trialEndsAt: Date | null };

export const EPHEMERAL_WATCH_REFUSAL =
  "This check was of a temporary preview, so there is nothing to keep watching. " +
  "Enable Daily Watch on a check of the app's real address.";

function nextRunFrom(frequency: WatchFrequency): Date | null {
  if (frequency === "manual") return null;
  const hours = frequency === "daily" ? 24 : 6;
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

// CHE-253: the caller passes the person AND the team they are acting for. The
// plan being gated against is the team's — a person does not have a plan — and
// the App, Watch and adopted Run are stamped with the team that will pay for
// them.
export async function enableWatchForRun(
  db: PrismaClient,
  user: { id: string; teamId: string; plan: string } | null,
  opts: { runPublicId: string; frequency: WatchFrequency; notifyOnChangeOnly: boolean },
): Promise<EnableWatchResult> {
  if (!user) return { kind: "unauthenticated" };

  const run = await db.run.findUnique({ ...publicRow(),
    where: { publicId: opts.runPublicId },
    select: {
      id: true,
      ownerId: true,
      appSlug: true,
      targetUrl: true,
      targetKind: true,
      extensionId: true,
      extensionConfig: true,
      testEmail: true,
      testPasswordEnc: true,
      storePasswordEnc: true,
      scopeHints: true,
      userNotes: true,
      ephemeral: true,
    },
  });
  if (!run) return { kind: "not_found" };

  // Don't let one owner adopt another owner's run (CHE-33). Adoption is only
  // valid for an anonymous run or one already theirs.
  if (run.ownerId && run.ownerId !== user.id) return { kind: "forbidden" };

  // CHE-202: the upsert below would register a preview hostname as an App and
  // schedule a daily walk of a deploy that is about to disappear. Refused
  // before any row is written.
  if (run.ephemeral) return { kind: "ephemeral" };
  if (run.targetKind === "extension") return { kind: "gated", reason: EXTENSION_ON_DEMAND };
  // CHE-390: a check from before private addresses were refused must not
  // become an app and a daily schedule on an address nothing can open.
  if (isPrivateTarget(run.targetUrl)) return { kind: "gated", reason: PRIVATE_TARGET_MESSAGE };

  // Find-or-create the owner's App for this target. upsert is race-safe under
  // D1 (no transactions) vs a check-then-create double-submit window.
  const app = await db.app.upsert({ ...alreadyScoped("the unique key names the owner"),
    where: { ownerId_appSlug: { ownerId: user.id, appSlug: run.appSlug } },
    update: {},
    create: {
      ownerId: user.id,
      teamId: user.teamId,
      targetUrl: run.targetUrl,
      targetKind: run.targetKind,
      extensionId: run.extensionId,
      extensionConfig: run.extensionConfig,
      appSlug: run.appSlug,
      testEmail: run.testEmail,
      testPasswordEnc: run.testPasswordEnc,
      storePasswordEnc: run.storePasswordEnc,
      scopeHints: run.scopeHints,
      userNotes: run.userNotes,
    },
  });

  // A one-off run loses its passwords when it ends (clearedCredentials), so by
  // the time anyone presses "Watch this app" the run's copy is usually gone
  // while the App — saved before or after it — still holds one. The watch is
  // seeded from whichever still has it, the login as a pair (an email with
  // the other source's password would be a login nobody has), the store
  // password on its own. Before CHE-372 the test login was lost this way too:
  // the App kept it and every daily run walked signed out.
  const login = run.testPasswordEnc ? run : app.testPasswordEnc ? app : run;
  const enabled = await upsertWatch(db, user, app, {
    frequency: opts.frequency,
    notifyOnChangeOnly: opts.notifyOnChangeOnly,
    seed: {
      testEmail: login.testEmail,
      testPasswordEnc: login.testPasswordEnc,
      storePasswordEnc: run.storePasswordEnc ?? app.storePasswordEnc,
    },
  });
  if (!enabled.ok) return { kind: "gated", reason: enabled.reason };
  const watch = enabled.watch;

  // Adopt the source run into the owner's app + watch (becomes the baseline).
  await db.run.update({ ...alreadyScoped("already read in this request"),
    where: { id: run.id },
    data: { watchId: watch.id, ownerId: user.id, teamId: user.teamId, appId: app.id },
  });

  return { kind: "ok", slug: watch.appSlug, trialEndsAt: watch.trialEndsAt };
}

// CHE-315: the gate every path that turns a watch ON asks — enabling from a
// verdict, resuming from the watch settings, and the MCP enable_watch tool.
//
// Updating a watch that is already running does not count against the cap
// (CHE-34). Resuming a PAUSED one does: a paused watch is not in the count
// (assertCanAddWatch counts active rows), so treating its resume as a mere
// update let a team pause, add a watch, and resume past its plan's cap. The
// resume path used to check only the cadence for exactly that reason.
async function watchGate(
  db: PrismaClient,
  team: { teamId: string; plan: string },
  frequency: WatchFrequency,
  existing: { id: string; active: boolean } | null,
) {
  return assertCanAddWatch(db, {
    teamId: team.teamId,
    plan: team.plan as UserPlan,
    frequency,
    existingWatchId: existing?.active ? existing.id : null,
  });
}

// Create the app's watch, or switch its existing one on at `frequency`.
async function upsertWatch(
  db: PrismaClient,
  user: { id: string; teamId: string; plan: string },
  app: {
    id: string;
    appSlug: string;
    targetUrl: string;
    testEmail: string | null;
    testPasswordEnc: string | null;
    storePasswordEnc: string | null;
  },
  opts: {
    frequency: WatchFrequency;
    notifyOnChangeOnly?: boolean;
    // What a NEW watch starts with. Enabling from a verdict carries that run's
    // credentials; enabling an app carries the app's own. Who hears about its
    // checks is the app's list of team members, never a seed (CHE-413).
    seed?: {
      testEmail: string | null;
      testPasswordEnc: string | null;
      storePasswordEnc: string | null;
    };
    // The clock the trial is read against; the MCP server passes its own.
    now?: Date;
  },
) {
  const existing = await db.watch.findUnique({ ...alreadyScoped("the App was just scoped to this team"),
    where: { appId: app.id },
    select: { id: true, active: true, trialEndsAt: true },
  });
  // CHE-325: a Free watch past its trial stays switched on and never runs
  // (shouldSkipWatch — the scheduler's own rule). Enabling it again used to
  // answer "on" all the same; the person heard the watch was running and it
  // was not. The trial clock is never restarted (see `update` below), so the
  // honest answer is the refusal, with the way forward.
  if (existing && shouldSkipWatch(existing, user.plan as UserPlan, opts.now)) {
    return { ok: false as const, reason: TRIAL_ENDED_REASON };
  }
  const gate = await watchGate(db, user, opts.frequency, existing);
  if (!gate.ok) return { ok: false as const, reason: gate.reason };

  const seed = opts.seed ?? {
    testEmail: app.testEmail,
    testPasswordEnc: app.testPasswordEnc,
    storePasswordEnc: app.storePasswordEnc,
  };
  const watch = await db.watch.upsert({ ...alreadyScoped("the App was just scoped to this team"),
    where: { appId: app.id },
    create: {
      appId: app.id,
      ownerId: user.id,
      teamId: user.teamId,
      appSlug: app.appSlug,
      targetUrl: app.targetUrl,
      frequency: opts.frequency,
      notifyOnChangeOnly: opts.notifyOnChangeOnly ?? true,
      testEmail: seed.testEmail,
      testPasswordEnc: seed.testPasswordEnc,
      storePasswordEnc: seed.storePasswordEnc,
      nextRunAt: nextRunFrom(opts.frequency),
      // CHE-54: Free enables a 7-day trial watch; paid plans get null (no expiry).
      trialEndsAt: watchTrialEnd(user.plan as UserPlan),
    },
    update: {
      active: true,
      // trialEndsAt is deliberately absent: reconfiguring or resuming an
      // existing watch must not restart its trial clock.
      frequency: opts.frequency,
      notifyOnChangeOnly: opts.notifyOnChangeOnly,
      nextRunAt: nextRunFrom(opts.frequency),
    },
  });
  return { ok: true as const, watch };
}

// Enable (or resume) the watch of an app the caller already has — the MCP
// enable_watch tool (CHE-315). Same App lookup as the dashboard's settings:
// the team's app, whoever added it (CHE-417); the caller asked the scope
// table (watch.configure) first.
export async function enableWatchForApp(
  db: PrismaClient,
  user: { id: string; teamId: string; plan: string },
  appId: string,
  opts: { frequency: WatchFrequency; notifyOnChangeOnly?: boolean; now?: Date },
): Promise<EnableWatchResult> {
  const app = await db.app.findFirst({
    where: { ...teamOwned(user.teamId), id: appId },
    select: { id: true, appSlug: true, targetUrl: true, targetKind: true, testEmail: true, testPasswordEnc: true, storePasswordEnc: true },
  });
  if (!app) return { kind: "not_found" };
  if (app.targetKind === "extension") return { kind: "gated", reason: EXTENSION_ON_DEMAND };
  const enabled = await upsertWatch(db, user, app, opts);
  if (!enabled.ok) return { kind: "gated", reason: enabled.reason };
  return { kind: "ok", slug: enabled.watch.appSlug, trialEndsAt: enabled.watch.trialEndsAt };
}

// PATCH /api/watch/{slug} and the MCP disable_watch tool: frequency, notify
// rule, pause/resume on a watch the caller has already resolved as theirs.
export async function configureWatch(
  db: PrismaClient,
  team: { teamId: string; plan: string },
  watch: { id: string; active: boolean; frequency: string },
  patch: { frequency?: WatchFrequency; notifyOnChangeOnly?: boolean; active?: boolean },
) {
  // Tier gate (CHE-34): a faster cadence (or reactivating) must fit the plan —
  // otherwise the create-time gate is bypassable via update.
  const frequency = (patch.frequency ?? watch.frequency) as WatchFrequency;
  const turningOn = patch.active === true || (patch.active === undefined && watch.active);
  if (patch.frequency || patch.active === true) {
    const gate = turningOn
      ? await watchGate(db, team, frequency, watch)
      : await assertCanAddWatch(db, { teamId: team.teamId, plan: team.plan as UserPlan, frequency, existingWatchId: watch.id });
    if (!gate.ok) return { ok: false as const, reason: gate.reason };
  }

  const data: Record<string, unknown> = { ...patch };
  if (patch.frequency || patch.active === true) data.nextRunAt = nextRunFrom(frequency);

  const updated = await db.watch.update({ ...alreadyScoped("already read in this request"), where: { id: watch.id }, data });
  return { ok: true as const, watch: updated };
}

export const EXTENSION_ON_DEMAND = "Extension checks run on demand. Add this extension to your dashboard to run another check.";
