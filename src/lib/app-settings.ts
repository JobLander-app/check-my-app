// Creating and editing an App — one implementation behind the onboarding
// wizard (src/app/onboarding/actions.ts), the app settings page
// (src/app/dashboard/actions.ts) and the MCP tools create_app / update_app
// (src/lib/mcp/tools.ts, CHE-315).
//
// Before CHE-315 these rules lived inside the two server actions, parsed out of
// a FormData. An agent managing the product through MCP would have needed a
// third copy of "the password is write-only", "test credentials are mirrored
// onto the Watch" and "a cadence the plan does not allow is refused" — and a
// third copy is the one that drifts. So the actions now parse their forms and
// call these, and so does MCP.
//
// Business outcomes (plan cap, duplicate app, bad URL) are RETURNED as
// `{ error }`, never thrown (CHE-84): each caller decides how to show a refusal.

import type { PrismaClient } from "@/generated/prisma/client";
import type { SafeParseReturnType } from "zod";
import type { UserPlan, WatchFrequency } from "@/lib/enums";
import type { TeamAction } from "@/lib/scopes";
import { assertCanAddWatch, watchTrialEnd } from "@/lib/plans";
import { credentialFingerprint, encryptSecret } from "@/lib/crypto";
import { appSlugFromUrl } from "@/lib/utils";
import { createCheckSchema } from "@/lib/validation";
import { extensionColumns, parseExtensionLink, type ExtensionOptions } from "@/lib/extension-target";
import { recordTeamEvent } from "@/lib/team-events";
import { parseAllowedOriginsInput, serializeAllowedOrigins } from "@/lib/allowed-origins";
import { alreadyScoped, teamOwned } from "@/lib/tenant-db";
import {
  planAccountEdits,
  writeAccountEdits,
  type AccountChangeSummary,
  type TestAccountsPatch,
} from "@/lib/test-accounts";

// The person acting and the team whose plan and apps they act on (CHE-253).
export interface AppActor {
  userId: string;
  teamId: string;
  plan: UserPlan;
}

type ExtensionParse = SafeParseReturnType<unknown, ExtensionOptions>;

export interface CreateAppInput {
  targetUrl: string;
  // The onboarding wizard's extension tab says what it expects; a website
  // link submitted there is refused rather than silently registered as a site.
  expectExtension?: boolean;
  extension?: ExtensionParse;
  testEmail?: string | null;
  testPassword?: string | null;
  // CHE-322: named accounts besides the default one above.
  testAccounts?: { label: string; email: string; password: string }[];
  // CHE-372: a password-protected store's storefront password.
  storePassword?: string | null;
  focusAreas?: string | null;
  writeMode?: "read_only" | "create_cleanup";
  scopeHints?: string | null;
  userNotes?: string | null;
  // CHE-373: https origins a check may act on besides the app's own.
  allowedOrigins?: string[];
  // CHE-333: an app checked inside a signed-in Shopify admin. Its slug is the
  // store (and, once chosen, the app's handle) — every such app's address is on
  // admin.shopify.com, so the host would make the second a duplicate of the
  // first. Its watch waits until the app is chosen: a daily check of a store
  // with no app picked would check the admin's home page.
  session?: { slug: string };
  frequency?: WatchFrequency;
  pickupLabels?: string[];
  repoLabel?: string | null;
  urgentJourneys?: string[];
}

// CHE-322: the extension runner replays a sign-in with the one account it is
// handed (src/agent/extension-replay.ts). A second login stored for an
// extension would be one no run of it ever uses — refused, not kept silently.
export const EXTENSION_ONE_ACCOUNT = "An extension check signs in with one test account. Set it with the test email and password.";

// The sentence is for a person; the code is for a machine caller, which should
// branch on "the plan is spent" rather than parse English.
export type AppRefusal = { error: string; code: "invalid_input" | "plan_limit" | "duplicate" | "not_found" };

export const DUPLICATE_APP ="You already have this app — manage it from your dashboard.";

export async function createAppForTeam(
  db: PrismaClient,
  actor: AppActor,
  input: CreateAppInput,
): Promise<{ ok: true; app: { id: string; appSlug: string; isExtension: boolean } } | AppRefusal> {
  const target = createCheckSchema.shape.url.safeParse(input.targetUrl);
  if (!target.success) return { error: "Enter your app URL or a Chrome Web Store extension link.", code: "invalid_input" };
  const targetUrl = target.data;
  const isExtension = Boolean(parseExtensionLink(targetUrl));
  if (input.expectExtension && !isExtension) return { error: "Enter a Chrome Web Store extension link.", code: "invalid_input" };
  const extension = input.extension;
  if (isExtension && extension && !extension.success) return { error: extension.error.issues[0].message, code: "invalid_input" };
  if (input.session && isExtension) return { error: "Enter your store.", code: "invalid_input" };
  const appSlug = input.session?.slug ?? appSlugFromUrl(targetUrl);

  const testEmail = input.testEmail?.trim() || null;
  const testPasswordEnc = input.testPassword ? encryptSecret(input.testPassword) : null;
  const storePasswordEnc = input.storePassword ? encryptSecret(input.storePassword) : null;
  const frequency = input.frequency ?? "daily";

  // CHE-322: checked before the app exists, so a bad account refuses the whole
  // create instead of leaving an app with half its logins.
  const accounts = input.testAccounts?.length ? planAccountEdits([], { set: input.testAccounts }) : null;
  if (accounts && isExtension) return { error: EXTENSION_ONE_ACCOUNT, code: "invalid_input" };
  if (accounts && !accounts.ok) return { error: accounts.error, code: "invalid_input" };
  const origins = parseAllowedOriginsInput(input.allowedOrigins ?? []);
  if (!origins.ok) return { error: origins.error, code: "invalid_input" };

  // One App per (team, slug) — CHE-417: an address a teammate already added is
  // the team's app, not a second row beside it. Asked before the plan cap, so
  // a Free team at its one watch hears "you already have this app", not "the
  // plan is full" (Codex on #273). Pre-check for a clear message; the
  // (owner, slug) unique key still catches a double-submit race (D1 has no
  // transactions) rather than surfacing a raw 500 — two members adding one
  // address in the same instant is the gap that key does not close, and a
  // (team, slug) key is CHE-404's migration.
  const dupe = await db.app.findFirst({
    where: { ...teamOwned(actor.teamId), appSlug },
    select: { id: true },
  });
  if (dupe) return { error: DUPLICATE_APP, code: "duplicate" };

  // Tier gate (CHE-34): Daily Watch availability + cadence + count per plan.
  const gate = isExtension ? { ok: true as const } : await assertCanAddWatch(db, {
    teamId: actor.teamId,
    plan: actor.plan,
    frequency,
  });
  if (!gate.ok) return { error: gate.reason, code: "plan_limit" };

  // Who hears about the app's first verdict (src/lib/recipients.ts): the team's
  // admins, unless somebody was chosen. A member who is not an admin and adds
  // an app is told "you'll get an email" — and would get nothing, since no row
  // chooses them (Codex on #263). So the person who asked is chosen for their
  // own app; an admin already hears by the floor rule, and a row for them would
  // silence the other admins.
  const admin = await db.membership.findFirst({
    where: { teamId: actor.teamId, userId: actor.userId, scope: "admin" },
    select: { id: true },
  });

  try {
    const app = await db.app.create({ ...alreadyScoped("created with its team"),
      data: {
        ownerId: actor.userId,
        teamId: actor.teamId,
        targetUrl,
        ...extensionColumns(targetUrl, extension?.success ? extension.data : undefined),
        ...(input.session ? { targetKind: "session" } : {}),
        appSlug,
        testEmail,
        testPasswordEnc,
        storePasswordEnc,
        scopeHints: input.scopeHints?.trim() || null,
        userNotes: input.userNotes?.trim() || null,
        focusAreas: input.focusAreas?.trim() || null,
        allowedOrigins: serializeAllowedOrigins(origins.origins),
        // CHE-91: creation is opt-in AND only meaningful with a test account —
        // the run-time gate enforces the second half, this records consent.
        writeMode: input.writeMode === "create_cleanup" ? "create_cleanup" : "read_only",
        watch: isExtension ? undefined : {
          create: {
            appSlug,
            targetUrl,
            frequency,
            ownerId: actor.userId,
            teamId: actor.teamId,
            testEmail,
            testPasswordEnc,
            storePasswordEnc,
            ...(input.session ? { active: false } : {}),
            // CHE-54: a watch enabled on Free is a 7-day trial. Enabling from a
            // verdict stamped it; adding the app here did not, so a Free team's
            // one onboarded watch ran with no end at all.
            trialEndsAt: watchTrialEnd(actor.plan),
          },
        },
        policy: {
          create: {
            pickupLabels: JSON.stringify(input.pickupLabels ?? []),
            repoLabel: input.repoLabel?.trim() || null,
            priorityRule: JSON.stringify({ urgent: input.urgentJourneys ?? [] }),
          },
        },
        notifiers: admin ? undefined : { create: { userId: actor.userId } },
      },
      select: { id: true, appSlug: true },
    });
    if (accounts?.ok) {
      const written = await writeAccountEdits(db, { id: app.id, teamId: actor.teamId }, accounts, []);
      await recordAccountEvents(db, actor, app.appSlug, written);
    }
    return { ok: true, app: { ...app, isExtension } };
  } catch (err) {
    if (err instanceof Error && err.message.includes("Unique constraint")) return { error: DUPLICATE_APP, code: "duplicate" };
    throw err;
  }
}

// A partial edit: a field left `undefined` is not touched. The settings page
// sends every field (so a blank there clears it, as it always did); MCP sends
// only what the agent named.
//
// The password is write-only in both directions it can travel: `undefined`
// keeps it, a non-empty string replaces it, and `null` or "" removes it — the
// settings form maps its blank box to `undefined`, so a person saving other
// settings never clears it by accident.
export interface AppSettingsPatch {
  testEmail?: string | null;
  testPassword?: string | null;
  // CHE-322: add, rename, re-password or remove named accounts. Passwords here
  // are write-only exactly like the default's.
  testAccounts?: TestAccountsPatch;
  // CHE-372: write-only exactly like testPassword — undefined keeps it, a
  // string replaces it, null or "" removes it, on the App and its Watch.
  storePassword?: string | null;
  focusAreas?: string | null;
  writeMode?: "read_only" | "create_cleanup";
  scopeHints?: string | null;
  userNotes?: string | null;
  // CHE-373: replaces the list; [] clears it.
  allowedOrigins?: string[];
  frequency?: WatchFrequency;
  pickupLabels?: string[];
  repoLabel?: string | null;
  urgentJourneys?: string[];
  extension?: ExtensionParse;
}

const orNull = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);

// Which scope a patch needs (src/lib/scopes.ts): a login — the default test
// account, the named ones, the store password — is `app.credentials.write`,
// which an admin has and a member does not; everything else is
// `app.settings.write`. Decided from the patch, not from the form or the tool,
// so the settings page and MCP update_app ask the same question (Codex on
// #273: with the app the team's, a member could otherwise replace a
// teammate's stored passwords under the settings scope).
export function settingsActionFor(patch: AppSettingsPatch): TeamAction {
  const writesLogin =
    patch.testEmail !== undefined ||
    patch.testPassword !== undefined ||
    patch.storePassword !== undefined ||
    Boolean(patch.testAccounts?.set?.length || patch.testAccounts?.remove?.length) ||
    // The allowed origins are where the stored login is typed (CHE-373:
    // src/agent/instructions.ts, fillSecret in src/agent/tools.ts). Adding
    // an origin is handing the password to that host — a credentials write
    // (Codex round 3 on #273).
    patch.allowedOrigins !== undefined;
  return writesLogin ? "app.credentials.write" : "app.settings.write";
}

// The same question of a new app: one added with a login stores a credential
// the moment it exists, and one added with origins names where a login will
// be typed. A form's empty login boxes are no login.
export function createActionFor(input: CreateAppInput): TeamAction {
  const writesLogin = Boolean(
    input.testEmail?.trim() || input.testPassword || input.storePassword || input.testAccounts?.length || input.allowedOrigins?.length,
  );
  return writesLogin ? "app.credentials.write" : "app.settings.write";
}

export async function updateAppForTeam(
  db: PrismaClient,
  actor: AppActor,
  appId: string,
  patch: AppSettingsPatch,
): Promise<{ ok: true; app: { id: string; appSlug: string } } | AppRefusal> {
  // CHE-417: the app is the team's, whoever added it. Who may write its
  // settings is the scope table's answer (app.settings.write), asked by every
  // caller before this; ownerId is attribution, not access.
  const app = await db.app.findFirst({
    where: { ...teamOwned(actor.teamId), id: appId },
    include: { watch: true, policy: true },
  });
  if (!app) return { error: "app not found", code: "not_found" };

  // Cadence gate (CHE-34): editing an existing watch doesn't count against the
  // per-plan cap, but the tier still can't select a faster cadence than allowed.
  if (patch.frequency !== undefined && app.targetKind !== "extension") {
    const gate = await assertCanAddWatch(db, {
      teamId: actor.teamId,
      plan: actor.plan,
      frequency: patch.frequency,
      existingWatchId: app.watch?.id ?? null,
    });
    if (!gate.ok) return { error: gate.reason, code: "plan_limit" };
  }

  if (app.targetKind === "extension" && patch.extension && !patch.extension.success) {
    return { error: patch.extension.error.issues[0].message, code: "invalid_input" };
  }
  const extensionUpdate = app.targetKind === "extension" && patch.extension?.success
    ? { extensionConfig: JSON.stringify(patch.extension.data) } : {};

  // CHE-322: every account edit is checked against the final set before any
  // row — accounts or settings — is written (D1 has no transactions).
  const wantsAccounts = Boolean(patch.testAccounts?.set?.length || patch.testAccounts?.remove?.length);
  const storedAccounts = wantsAccounts
    ? await db.testAccount.findMany({ where: { ...teamOwned(actor.teamId), appId: app.id }, select: { id: true, label: true, email: true } })
    : [];
  const accountPlan = wantsAccounts ? planAccountEdits(storedAccounts, patch.testAccounts!) : null;
  if (accountPlan && app.targetKind === "extension" && accountPlan.ok && (accountPlan.creates.length || accountPlan.updates.length)) {
    return { error: EXTENSION_ONE_ACCOUNT, code: "invalid_input" };
  }
  if (accountPlan && !accountPlan.ok) return { error: accountPlan.error, code: "invalid_input" };
  const origins = patch.allowedOrigins === undefined ? null : parseAllowedOriginsInput(patch.allowedOrigins);
  if (origins && !origins.ok) return { error: origins.error, code: "invalid_input" };

  const passwordUpdate =
    patch.testPassword === undefined
      ? {}
      : { testPasswordEnc: patch.testPassword ? encryptSecret(patch.testPassword) : null };
  if (patch.testPassword) {
    console.log(`[settings] test password saved for app ${app.id}: ${credentialFingerprint(patch.testPassword)}`);
  }
  const storeUpdate =
    patch.storePassword === undefined
      ? {}
      : { storePasswordEnc: patch.storePassword ? encryptSecret(patch.storePassword) : null };
  const testEmail = orNull(patch.testEmail);

  // App — creds/scope/notes (source of record for test creds).
  await db.app.update({ ...alreadyScoped("already read in this request"),
    where: { id: app.id },
    data: {
      testEmail,
      scopeHints: orNull(patch.scopeHints),
      userNotes: orNull(patch.userNotes),
      focusAreas: orNull(patch.focusAreas),
      allowedOrigins: origins?.ok ? serializeAllowedOrigins(origins.origins) : undefined,
      writeMode: patch.writeMode === undefined ? undefined : patch.writeMode === "create_cleanup" ? "create_cleanup" : "read_only",
      ...passwordUpdate,
      ...storeUpdate,
      ...extensionUpdate,
    },
  });

  // Watch — cadence; test creds mirrored here exactly as onboarding's nested
  // create does (recurring runs read them off the Watch).
  if (app.watch) {
    await db.watch.update({ ...alreadyScoped("already read in this request"),
      where: { id: app.watch.id },
      data: { frequency: patch.frequency, testEmail, ...passwordUpdate, ...storeUpdate },
    });
  }

  // TicketPolicy — the pickup contract with the owner's automation.
  if (app.policy && (patch.pickupLabels || patch.repoLabel !== undefined || patch.urgentJourneys)) {
    await db.ticketPolicy.update({
      where: { appId: app.id },
      data: {
        pickupLabels: patch.pickupLabels ? JSON.stringify(patch.pickupLabels) : undefined,
        repoLabel: orNull(patch.repoLabel),
        priorityRule: patch.urgentJourneys ? JSON.stringify({ urgent: patch.urgentJourneys }) : undefined,
      },
    });
  }

  // CHE-264: one line for the settings, and a separate one for a credential —
  // the credential change is the one an admin will most want to trace later,
  // and it should not hide inside "settings changed".
  await recordTeamEvent(db, {
    teamId: actor.teamId,
    actorUserId: actor.userId,
    action: "app.settings_changed",
    subject: app.appSlug,
    summary: `changed settings for ${app.appSlug}`,
  });
  if (patch.testPassword !== undefined && (patch.testPassword || app.testPasswordEnc)) {
    await recordTeamEvent(db, {
      teamId: actor.teamId,
      actorUserId: actor.userId,
      action: "app.credentials_written",
      subject: app.appSlug,
      summary: patch.testPassword
        ? `replaced the test password for ${app.appSlug}`
        : `removed the test password for ${app.appSlug}`,
    });
  }
  if (patch.storePassword !== undefined && (patch.storePassword || app.storePasswordEnc)) {
    await recordTeamEvent(db, {
      teamId: actor.teamId,
      actorUserId: actor.userId,
      action: "app.credentials_written",
      subject: app.appSlug,
      summary: patch.storePassword
        ? `replaced the store password for ${app.appSlug}`
        : `removed the store password for ${app.appSlug}`,
    });
  }
  if (accountPlan?.ok) {
    const written = await writeAccountEdits(db, { id: app.id, teamId: actor.teamId }, accountPlan, storedAccounts);
    await recordAccountEvents(db, actor, app.appSlug, written);
  }

  return { ok: true, app: { id: app.id, appSlug: app.appSlug } };
}

// CHE-264: a credential change is the one an admin most wants to trace later,
// so each named account gets its own line, by label — never the password.
async function recordAccountEvents(db: PrismaClient, actor: AppActor, appSlug: string, s: AccountChangeSummary) {
  const lines = [
    ...s.added.map((l) => `added the test account "${l}" for ${appSlug}`),
    ...s.changed.map((l) => `changed the test account "${l}" for ${appSlug}`),
    ...s.passwordsReplaced.map((l) => `replaced the password of the test account "${l}" for ${appSlug}`),
    ...s.removed.map((l) => `removed the test account "${l}" from ${appSlug}`),
  ];
  for (const summary of lines) {
    await recordTeamEvent(db, { teamId: actor.teamId, actorUserId: actor.userId, action: "app.credentials_written", subject: appSlug, summary });
  }
}

// CHE-322: what the settings page and list_apps show of the named accounts —
// label and email, never the password in any form.
export async function listTestAccounts(db: PrismaClient, teamId: string, appId: string) {
  return db.testAccount.findMany({
    where: { ...teamOwned(teamId), appId },
    orderBy: { createdAt: "asc" },
    select: { id: true, label: true, email: true },
  });
}
