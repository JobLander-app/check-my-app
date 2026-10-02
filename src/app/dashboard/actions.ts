"use server";

import { startSavedApp } from "@/lib/start-saved-app";
import { requireActionScope } from "@/lib/team-auth";
import { extensionOptionsFromForm } from "@/lib/validation";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { isSelfCheckRequest, selfCheckRedirectPath } from "@/lib/self-check";
import { requireUser } from "@/lib/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { discoverPostHog, revokeToken } from "@/lib/posthog/oauth";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { generateApiKey, hashApiKey } from "@/lib/apiKeys";
import { updateAppForTeam, type AppSettingsPatch } from "@/lib/app-settings";
import { testAccountsFromForm } from "@/lib/test-accounts";
import { TEAM_SCOPES, mintRefusal, type TeamScope } from "@/lib/scopes";
import { recordTeamEvent } from "@/lib/team-events";
import type { UserPlan } from "@/lib/enums";
import { alreadyScoped, teamOwned } from "@/lib/tenant-db";
import { appPath } from "@/lib/app-shell";

// Re-point an app's tracker to a different team (CHE-31 team picker). The default
// at connect time is the first team; JobLander must target the JobLander team,
// not whatever happens to be first.
export async function setTrackerTeam(appId: string, teamId: string, teamName: string) {
  const { user, db, team } = await requireActionScope("integration.connect");
  const app = await db.app.findFirst({
    where: { ...teamOwned(team.id), id: appId, ownerId: user.id },
    include: { tracker: true },
  });
  if (!app?.tracker) throw new Error("tracker not connected");
  await db.trackerIntegration.update({
    where: { appId },
    data: { teamId, externalOrg: teamName },
  });
  await recordTeamEvent(db, {
    teamId: team.id,
    actorUserId: user.id,
    action: "integration.connected",
    subject: app.appSlug,
    summary: `pointed ${app.appSlug}'s tickets at ${teamName}`,
  });
}

// Outbound integrations (CHE-53): generic webhook + Slack incoming webhook,
// fired after every completed watch run. Blank URL = disable. The signing
// secret is write-only: blank keeps the current one, and it's dropped with the
// webhook URL so a disabled endpoint leaves no secret behind.
export async function setIntegrationEndpoints(appId: string, formData: FormData) {
  const { user, db, team } = await requireActionScope("integration.connect");
  const app = await db.app.findFirst({
    where: { ...teamOwned(team.id), id: appId, ownerId: user.id },
    select: { id: true },
  });
  if (!app) throw new Error("app not found");

  const webhookUrl = String(formData.get("webhookUrl") ?? "").trim() || null;
  const slackWebhookUrl = String(formData.get("slackWebhookUrl") ?? "").trim() || null;
  const webhookSecret = String(formData.get("webhookSecret") ?? "").trim();
  for (const url of [webhookUrl, slackWebhookUrl]) {
    if (url && !/^https:\/\/.+/.test(url)) {
      throw new Error("Webhook URLs must be https://");
    }
  }

  const data: { webhookUrl: string | null; slackWebhookUrl: string | null; webhookSecretEnc?: string | null } = {
    webhookUrl,
    slackWebhookUrl,
  };
  if (!webhookUrl) data.webhookSecretEnc = null;
  else if (webhookSecret) data.webhookSecretEnc = encryptSecret(webhookSecret);

  await db.app.update({ ...alreadyScoped("already read in this request"), where: { id: appId }, data });
  revalidatePath("/home");
  revalidatePath(appPath.settings(appId));
}

// Disconnect analytics (CHE-236). Two things happen, in this order, and the
// second is the one a flag-flipping implementation skips:
//
//   1. the grant is revoked at PostHog, so the customer's own "apps with
//      access" list stops naming us — otherwise we have told them we stopped
//      reading while their screen says we can;
//   2. the row is DELETED. Not `active: false`, not `revokedAt`: a stored
//      token that nothing reads is still a stored token, and "disconnect"
//      means the credential is gone, not shelved.
//
// Revocation is attempted first but cannot block deletion. If PostHog is down,
// the person still asked us to stop reading their analytics, and we stop.
export async function disconnectPostHog(): Promise<void> {
  const { user, db, team } = await requireActionScope("integration.connect");
  const row = await db.postHogIntegration.findFirst({ where: { ...teamOwned(team.id) } });
  if (!row) return;

  const { env } = getCloudflareContext();
  const appUrl = ((env as Record<string, string | undefined>).APP_URL ?? "https://checkmyapp.dev").replace(/\/+$/, "");
  try {
    const endpoints = await discoverPostHog();
    const clientId = `${appUrl}/.well-known/posthog-client.json`;
    // The refresh token is the grant; revoking it is what ends the access
    // rather than just retiring one short-lived token.
    if (row.refreshTokenEnc) {
      await revokeToken({ endpoints, clientId, token: decryptSecret(row.refreshTokenEnc), hint: "refresh_token" });
    }
    await revokeToken({ endpoints, clientId, token: decryptSecret(row.accessTokenEnc), hint: "access_token" });
  } catch (err) {
    console.warn(`[posthog-oauth] revoke on disconnect failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  await db.postHogIntegration.deleteMany({ where: { ...teamOwned(team.id), id: row.id } });
  // CHE-264: "why did the funnel numbers stop" has an answer, and it is a name
  // and a date rather than a reconstruction.
  await recordTeamEvent(db, {
    teamId: team.id,
    actorUserId: user.id,
    action: "integration.disconnected",
    subject: row.organizationName ?? "PostHog",
    summary: `disconnected PostHog${row.organizationName ? ` (${row.organizationName})` : ""}`,
  });
  revalidatePath("/settings/integrations");
  revalidatePath("/home");
}

// Owner API keys (CHE-52). The raw key exists only in this return value — the
// DB keeps its SHA-256 hash, so this is the one time the owner can copy it.
export async function createApiKey(
  name: string,
  keyScope: string = "member",
): Promise<{ id: string; name: string; rawKey: string }> {
  // CHE-253: the plan is the team's, and so is the key — a CI hook does not
  // stop working because the person who minted it left. Who minted it stays on
  // ownerId as attribution.
  // CHE-316: no plan check — every plan, Free included, may mint a key. Runs
  // started with it spend the key's team's quota like any other run.
  const { user, db, team, scope } = await requireActionScope("apikey.manage");
  // CHE-263: a key carries a scope, and never one above its minter's — a member
  // who could mint an admin key would make the scope table a suggestion.
  const wanted = (TEAM_SCOPES as string[]).includes(keyScope) ? (keyScope as TeamScope) : "member";
  const refusal = mintRefusal(scope, wanted);
  if (refusal) throw new Error(refusal);

  const rawKey = generateApiKey();
  // recorded after the row exists, below
  const key = await db.apiKey.create({ ...alreadyScoped("created with its team"),
    data: {
      ownerId: user.id,
      teamId: team.id,
      scope: wanted,
      name: name.trim().slice(0, 100) || "API key",
      keyHash: await hashApiKey(rawKey),
    },
  });
  await recordTeamEvent(db, {
    teamId: team.id,
    actorUserId: user.id,
    action: "apikey.created",
    subject: key.name,
    summary: `created a ${wanted} API key called "${key.name}"`,
  });
  return { id: key.id, name: key.name, rawKey };
}

// Revoke = delete the row; the key stops resolving on the next request.
// deleteMany scoped to the owner so one tenant can't revoke another's key.
export async function revokeApiKey(id: string): Promise<void> {
  const { user, db, team } = await requireActionScope("apikey.manage");
  await db.apiKey.deleteMany({ where: { ...teamOwned(team.id), id, ownerId: user.id } });
  await recordTeamEvent(db, {
    teamId: team.id,
    actorUserId: user.id,
    action: "apikey.revoked",
    subject: id,
    summary: "revoked an API key",
  });
}

// Edit an app's settings after onboarding (CHE-64). Mirrors createApp's field →
// record mapping EXACTLY so the settings page and onboarding write the same
// places: creds/scope/notes on App (test creds also mirrored onto Watch, as
// onboarding does), cadence + notify email on Watch, ticket params on
// TicketPolicy. The password is write-only: a blank submission leaves
// testPasswordEnc untouched on both records.
//
// CHE-315: the rules are in src/lib/app-settings.ts, shared with the MCP
// update_app tool; this action reads its form.
//
// CHE-359: the settings are sections, each its own form, and a form saves its
// own section and nothing else. The section is bound into the action by the
// page (never read from the form), and decides which fields are read at all:
// a field the patch does not name is kept (updateAppForTeam's rule), so the
// "What we check" form cannot blank a password and the accounts form cannot
// untick write mode. Within its section a blank box still clears its field, as
// it always did — except a password, whose blank box means "keep".
//
// A refusal (a cadence the plan does not allow, a bad account) goes back to
// the section as a sentence, where the form is — it used to be thrown, and the
// reader got an error page.
export async function updateAppSettings(appId: string, section: string, formData: FormData) {
  const { user, db, team } = await requireActionScope("app.settings.write");
  const text = (name: string) => String(formData.get(name) ?? "");
  const list = (name: string) =>
    text(name)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const patch: AppSettingsPatch | null =
    section === "scope"
      ? {
          focusAreas: text("focusAreas"),
          writeMode: formData.get("writeMode") === "create_cleanup" ? "create_cleanup" : "read_only",
          scopeHints: text("scopeHints"),
          userNotes: text("userNotes"),
          extension: extensionOptionsFromForm(formData),
        }
      : section === "accounts"
        ? {
            testEmail: text("testEmail"),
            testPassword: text("testPassword") || undefined,
            // CHE-322: the named accounts' rows, saved with the default login.
            testAccounts: testAccountsFromForm(formData),
          }
        : section === "notifications"
          ? { notifyEmail: text("notifyEmail") }
          : section === "integrations"
            ? { pickupLabels: list("pickupLabels"), repoLabel: text("repoLabel"), urgentJourneys: list("urgentJourneys") }
            : null;
  if (!patch) throw new Error("unknown settings section");

  const result = await updateAppForTeam(db, { userId: user.id, teamId: team.id, plan: team.plan as UserPlan }, appId, patch);
  const back = appPath.section(appId, section);
  if ("error" in result) redirect(`${back}?error=${encodeURIComponent(result.error)}`);

  revalidatePath("/home");
  revalidatePath(appPath.settings(result.app.id), "layout");
  redirect(`${back}?saved=1`);
}

// Remove an app the owner no longer wants watched (CHE-95). Our own check
// found this missing: you could add an app and never get rid of it, which
// also meant a free plan could be permanently stuck at its one-watch cap.
//
// Verdicts are NOT deleted. Their URLs are shareable and often the only record
// of what a product looked like on a given day; the runs are detached from the
// app instead, so the history survives while the app stops being watched and
// stops counting against the plan.
export type DeleteAppResult = { error: string } | null;

export async function deleteApp(
  appId: string,
  _prev: DeleteAppResult,
  formData: FormData,
): Promise<DeleteAppResult> {
  const { user, db, team } = await requireActionScope("app.delete");
  const app = await db.app.findFirst({
    where: { ...teamOwned(team.id), id: appId, ownerId: user.id },
    select: { id: true, appSlug: true },
  });
  if (!app) return { error: "App not found." };

  // Typing the name is the confirmation: no modal to mis-click, and it cannot
  // be triggered by a stray form submit.
  const typed = String(formData.get("confirmSlug") ?? "").trim();
  if (typed !== app.appSlug) {
    return { error: `Type ${app.appSlug} to confirm removal.` };
  }

  await db.run.updateMany({ ...alreadyScoped("already read in this request"), where: { appId: app.id }, data: { appId: null, watchId: null } });
  await db.createdResource.updateMany({ where: { appId: app.id }, data: { appId: null } });
  await db.issueLink.deleteMany({ where: { appId: app.id } });
  await db.watch.deleteMany({ ...alreadyScoped("already read in this request"), where: { appId: app.id } });
  await db.ticketPolicy.deleteMany({ where: { appId: app.id } });
  await db.trackerIntegration.deleteMany({ where: { appId: app.id } });
  await db.repoIntegration.deleteMany({ where: { appId: app.id } });
  // CHE-322: the named test accounts' passwords go with the app, stated rather
  // than left to the foreign key's cascade.
  await db.testAccount.deleteMany({ where: { ...teamOwned(team.id), appId: app.id } });
  await db.app.delete({ ...alreadyScoped("already read in this request"), where: { id: app.id } });
  await recordTeamEvent(db, {
    teamId: team.id,
    actorUserId: user.id,
    action: "app.deleted",
    subject: app.appSlug,
    summary: `deleted ${app.appSlug} — its verdicts were kept`,
  });

  // The app is in the sidebar of every signed-in page, so the whole shell.
  revalidatePath("/", "layout");
  redirect(`/home?removed=${encodeURIComponent(app.appSlug)}`);
}

export async function runSavedApp(appId: string, _previous: { error: string } | null) {
  if (isSelfCheckRequest(await headers())) redirect(selfCheckRedirectPath(appPath.settings(appId)));
  const { user, db, team } = await requireActionScope("run.start");
  const result = await startSavedApp(db, { id: user.id, teamId: team.id, plan: team.plan as UserPlan }, appId);
  if ("error" in result) return result;
  redirect(`/run/${result.publicId}`);
}

// CHE-262: who on the team is told about this app's verdicts.
//
// Two doors on purpose. An admin or member sets the list for everybody
// (`app.settings.write`); anybody on the team, including a reader, can add or
// remove THEMSELVES — a reader who joined to read what breaks should not have
// to ask an admin to be allowed to hear about it.
// Which PostHog project holds this app's data (CHE-237). Asked once, stored,
// never asked again.
//
// The name is stored beside the id deliberately: the id is the only thing ever
// sent to PostHog, and the name is a label cached at the moment of choosing, so
// the settings page still reads correctly when the connection has expired. The
// name is taken from the form rather than looked up again because the form is
// what the owner was looking at when they chose — a fresh lookup could disagree
// with what they saw and silently relabel their choice.
//
// Clearing it is a first-class option, not an omission: an app with no project
// keeps our own estimate, which is a legitimate state to return to.
export async function setAppPosthogProject(appId: string, formData: FormData): Promise<void> {
  const { user, db, team } = await requireActionScope("app.settings.write");
  const app = await db.app.findFirst({
    where: { ...teamOwned(team.id), id: appId },
    select: { id: true, appSlug: true, posthogProjectName: true },
  });
  if (!app) throw new Error("App not found.");

  // "<id>:<name>", or "" for none. One field rather than two because a hidden
  // name field cannot follow a <select> without client JS, and would quietly
  // store a label belonging to a different project than the one chosen.
  const raw = String(formData.get("posthogProject") ?? "").trim();
  const at = raw.indexOf(":");
  const projectId = at === -1 ? raw : raw.slice(0, at);
  const projectName = at === -1 ? "" : raw.slice(at + 1).trim();

  // A project id is PostHog's own numeric id. Refusing anything else keeps a
  // hand-edited form from writing a value that would fail far away, inside a
  // query, where the error would read as "no data" rather than "bad input".
  if (projectId && !/^\d{1,20}$/.test(projectId)) {
    throw new Error("That does not look like a PostHog project id.");
  }

  await db.app.update({
    ...alreadyScoped("already read in this request"),
    where: { id: appId },
    data: {
      posthogProjectId: projectId || null,
      posthogProjectName: projectId ? projectName.slice(0, 200) || `Project ${projectId}` : null,
    },
  });

  await recordTeamEvent(db, {
    teamId: team.id,
    actorUserId: user.id,
    action: "app.settings_changed",
    subject: app.appSlug,
    summary: projectId
      ? `pointed ${app.appSlug} at the PostHog project "${projectName || projectId}"`
      : `stopped reading a PostHog project for ${app.appSlug}`,
  });
  revalidatePath(appPath.settings(appId));
  revalidatePath("/home");
}

export async function setAppNotifiers(appId: string, formData: FormData): Promise<void> {
  const { user, db, team } = await requireActionScope("app.settings.write");
  const app = await db.app.findFirst({ where: { ...teamOwned(team.id), id: appId }, select: { id: true } });
  if (!app) throw new Error("App not found.");

  const wanted = new Set(formData.getAll("notifier").map(String));
  const members = await db.membership.findMany({ where: { teamId: team.id }, select: { userId: true } });
  const valid = members.map((m) => m.userId).filter((id) => wanted.has(id));

  // Replace rather than diff: the form carries the whole answer, and a diff
  // would need the previous state to be what we think it is.
  await db.appNotifier.deleteMany({ where: { appId } });
  for (const userId of valid) {
    await db.appNotifier.create({ data: { appId, userId } });
  }
  await recordTeamEvent(db, {
    teamId: team.id,
    actorUserId: user.id,
    action: "app.notifiers_changed",
    subject: appId,
    summary: valid.length
      ? `set who hears about this app: ${valid.length} ${valid.length === 1 ? "person" : "people"}`
      : "cleared who hears about this app — verdicts go to the team's admins again",
  });
  revalidatePath(appPath.settings(appId));
}

// The self-service half: any scope, your own subscription only.
export async function toggleOwnNotifications(appId: string): Promise<void> {
  const { user, db, team } = await requireActionScope("read");
  const app = await db.app.findFirst({ where: { ...teamOwned(team.id), id: appId }, select: { id: true } });
  if (!app) throw new Error("App not found.");

  const existing = await db.appNotifier.findFirst({ where: { appId, userId: user.id }, select: { id: true } });
  if (existing) await db.appNotifier.deleteMany({ where: { appId, userId: user.id } });
  else await db.appNotifier.create({ data: { appId, userId: user.id } });
  revalidatePath(appPath.settings(appId));
  revalidatePath("/settings/account");
}
