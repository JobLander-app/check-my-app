// What the Jira callback and the project picker do once the request is known
// to be the team's (CHE-438), apart from Next so the guard drives them against
// a fake Atlassian.
//
// CHE-469: the grant is the team's. A connect from any app stores it as the
// team's Jira connection; every other app of the team then picks a project
// from it with no second consent.

import type { PrismaClient } from "@/generated/prisma/client";
import { encryptSecret } from "@/lib/crypto";
import { alreadyScoped } from "@/lib/tenant-db";
import { JiraTracker, exchangeJiraCode, freshJiraToken, jiraProjects, jiraSites, type JiraCreds } from "./jira";
import { retireTrackerLinks } from "./provider-switch";
import { connectionApps, connectionGrant, putConnection, routeApp, teamConnection, type Grant } from "./connection";

export type JiraConnectOutcome = "jira_connected" | "jira_choose_project" | "jira_failed" | "jira_no_site" | "jira_no_project";

type AppRef = { id: string; teamId: string | null; ownerId: string | null; appSlug: string };

async function appRef(db: PrismaClient, appId: string): Promise<AppRef | null> {
  return db.app.findUnique({ ...alreadyScoped("the caller resolved this app"),
    where: { id: appId },
    select: { id: true, teamId: true, ownerId: true, appSlug: true },
  });
}

export async function connectJira(
  db: PrismaClient,
  opts: { appId: string; code: string; redirectUri: string; clientId: string; clientSecret: string },
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<JiraConnectOutcome> {
  try {
    const app = await appRef(db, opts.appId);
    if (!app?.teamId) return "jira_failed";
    const token = await exchangeJiraCode(opts, fetchImpl);
    const sites = await jiraSites(token.access_token, fetchImpl);
    if (sites.length === 0) return "jira_no_site";
    const existing = await db.trackerIntegration.findUnique({ where: { appId: opts.appId } });
    const options = (
      await Promise.all(sites.map(async (site) => (await jiraProjects(token.access_token, site.cloudId, fetchImpl)).map((p) => ({ site, key: p.key }))))
    ).flat();
    if (options.length === 0) return "jira_no_project";
    const reaches = (row: { externalOrg: string | null; teamId: string | null }) => options.some((o) => o.site.cloudId === row.externalOrg && o.key === row.teamId);
    // A reconnect keeps the site and project the team chose. Otherwise a grant
    // that reaches exactly one project files there; one that reaches several
    // files nowhere until the team picks one on the Integrations card — a guess
    // could send findings to a project other people read (Codex on #319).
    const kept = existing?.type === "jira" ? options.find((o) => o.site.cloudId === existing.externalOrg && o.key === existing.teamId) : undefined;
    const chosen = kept ?? (options.length === 1 ? options[0] : null);
    // Moving from Linear, or to another Jira site: the old keys mean nothing here.
    if (existing && (existing.type !== "jira" || existing.externalOrg !== (chosen?.site.cloudId ?? null))) {
      await retireTrackerLinks(db, app);
    }

    // The team's grant: every app of the team on Jira files with it from now on.
    const connection = await putConnection(db, app.teamId, "jira", {
      accessTokenEnc: encryptSecret(token.access_token),
      refreshTokenEnc: token.refresh_token ? encryptSecret(token.refresh_token) : null,
      tokenExpiresAt: token.expires_in ? new Date(now + token.expires_in * 1000) : null,
    });
    await routeApp(db, app.id, connection, { teamId: chosen?.key ?? null, externalOrg: chosen?.site.cloudId ?? null, externalUrl: chosen?.site.url ?? null });

    // The team's other apps on Jira keep their projects where the new grant
    // reaches them. One it does not reach files nowhere until a project is
    // chosen again; one whose site it does not reach loses that site's links.
    for (const other of await connectionApps(db, app.teamId, "jira")) {
      if (other.appId === app.id || !other.teamId || reaches(other)) continue;
      const siteGone = !sites.some((s) => s.cloudId === other.externalOrg);
      if (siteGone) await retireTrackerLinks(db, other.app);
      await db.trackerIntegration.update({
        where: { appId: other.appId },
        data: siteGone ? { teamId: null, externalOrg: null, externalUrl: null } : { teamId: null },
      });
    }
    return chosen ? "jira_connected" : "jira_choose_project";
  } catch (err) {
    console.warn(`[jira] connect failed for ${opts.appId}: ${err instanceof Error ? err.message : String(err)}`);
    return "jira_failed";
  }
}

export interface JiraChoice {
  /** `${cloudId}/${projectKey}` — what the picker sends back. */
  value: string;
  cloudId: string;
  siteUrl: string;
  projectKey: string;
  label: string;
}

/** Every project on every site this grant reaches, for the picker. */
export async function jiraChoices(db: PrismaClient, grant: Grant, creds: JiraCreds, fetchImpl: typeof fetch = fetch): Promise<JiraChoice[]> {
  const token = await freshJiraToken(db, grant, creds, fetchImpl);
  const sites = await jiraSites(token, fetchImpl);
  const perSite = await Promise.all(
    sites.map(async (site) =>
      (await jiraProjects(token, site.cloudId, fetchImpl)).map((p) => ({
        value: `${site.cloudId}/${p.key}`,
        cloudId: site.cloudId,
        siteUrl: site.url,
        projectKey: p.key,
        label: sites.length > 1 ? `${p.name} (${p.key}) · ${site.url.replace(/^https?:\/\//, "")}` : `${p.name} (${p.key})`,
      })),
    ),
  );
  return perSite.flat();
}

/**
 * Required fields of the chosen project that a ticket of ours cannot fill, for
 * the Integrations card: a project that would refuse every ticket is said to
 * be one before a finding is lost to it.
 */
export async function jiraProjectBlockers(
  db: PrismaClient,
  grant: Grant,
  routing: { teamId: string | null; externalOrg: string | null; externalUrl: string | null },
  creds: JiraCreds,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  if (!routing.teamId || !routing.externalOrg) return [];
  const token = await freshJiraToken(db, grant, creds, fetchImpl);
  return new JiraTracker(token, routing.externalOrg, routing.teamId, routing.externalUrl ?? "", fetchImpl).blockers();
}

export type JiraChoiceOutcome = "chosen" | "not_jira" | "unknown_choice";

/**
 * Point the app's tickets at the project the team picked, in the team's Jira.
 * The app need not have filed into Jira before (CHE-469): the team's grant is
 * the app's as soon as a project is chosen. The choice is checked against what
 * the grant reaches right now, never taken from the client as is. Another
 * tracker, or another site, retires the old links (provider-switch.ts).
 */
export async function chooseJiraProject(
  db: PrismaClient,
  appId: string,
  value: string,
  creds: JiraCreds,
  fetchImpl: typeof fetch = fetch,
): Promise<JiraChoiceOutcome> {
  const app = await appRef(db, appId);
  if (!app?.teamId) return "not_jira";
  const connection = await teamConnection(db, app.teamId, "jira");
  if (!connection) return "not_jira";
  const choice = (await jiraChoices(db, connectionGrant(connection), creds, fetchImpl)).find((c) => c.value === value);
  if (!choice) return "unknown_choice";
  const row = await db.trackerIntegration.findUnique({ where: { appId } });
  if (row && (row.type !== "jira" || row.externalOrg !== choice.cloudId)) await retireTrackerLinks(db, app);
  await routeApp(db, appId, connection, { teamId: choice.projectKey, externalOrg: choice.cloudId, externalUrl: choice.siteUrl });
  return "chosen";
}
