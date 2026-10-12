// What the Jira callback and the project picker do once the request is known
// to be the team's (CHE-438), apart from Next so the guard drives them against
// a fake Atlassian.

import type { PrismaClient } from "@/generated/prisma/client";
import { encryptSecret } from "@/lib/crypto";
import { alreadyScoped } from "@/lib/tenant-db";
import { exchangeJiraCode, freshJiraToken, jiraProjects, jiraSites, type JiraCreds, type JiraTokenRow } from "./jira";
import { retireTrackerLinks } from "./provider-switch";

export type JiraConnectOutcome = "jira_connected" | "jira_failed" | "jira_no_site" | "jira_no_project";

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
    const token = await exchangeJiraCode(opts, fetchImpl);
    const sites = await jiraSites(token.access_token, fetchImpl);
    const existing = await db.trackerIntegration.findUnique({ where: { appId: opts.appId } });
    // A reconnect keeps the site and project the team chose; a first connect
    // takes the grant's first site and that site's first project, and the
    // Integrations card offers every other one right after.
    const site = (existing?.type === "jira" && sites.find((s) => s.cloudId === existing.externalOrg)) || sites[0];
    if (!site) return "jira_no_site";
    const projects = await jiraProjects(token.access_token, site.cloudId, fetchImpl);
    const project = (existing?.type === "jira" && existing.externalOrg === site.cloudId && projects.find((p) => p.key === existing.teamId)) || projects[0];
    if (!project) return "jira_no_project";
    // Moving from Linear, or to another Jira site: the old keys mean nothing here.
    if (existing && (existing.type !== "jira" || existing.externalOrg !== site.cloudId)) {
      const app = await appRef(db, opts.appId);
      if (app) await retireTrackerLinks(db, app);
    }
    const data = {
      type: "jira",
      accessTokenEnc: encryptSecret(token.access_token),
      refreshTokenEnc: token.refresh_token ? encryptSecret(token.refresh_token) : null,
      tokenExpiresAt: token.expires_in ? new Date(now + token.expires_in * 1000) : null,
      teamId: project.key,
      externalOrg: site.cloudId,
      externalUrl: site.url,
    };
    await db.trackerIntegration.upsert({ where: { appId: opts.appId }, create: { appId: opts.appId, ...data }, update: data });
    return "jira_connected";
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
export async function jiraChoices(db: PrismaClient, row: JiraTokenRow, creds: JiraCreds, fetchImpl: typeof fetch = fetch): Promise<JiraChoice[]> {
  const token = await freshJiraToken(db, row, creds, fetchImpl);
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

export type JiraChoiceOutcome = "chosen" | "not_jira" | "unknown_choice";

/**
 * Point the app's Jira at the project the team picked. The choice is checked
 * against what the grant reaches right now, never taken from the client as
 * is. Another site retires the old site's links (provider-switch.ts).
 */
export async function chooseJiraProject(
  db: PrismaClient,
  appId: string,
  value: string,
  creds: JiraCreds,
  fetchImpl: typeof fetch = fetch,
): Promise<JiraChoiceOutcome> {
  const row = await db.trackerIntegration.findUnique({ where: { appId } });
  if (!row || row.type !== "jira") return "not_jira";
  const choice = (await jiraChoices(db, row, creds, fetchImpl)).find((c) => c.value === value);
  if (!choice) return "unknown_choice";
  if (choice.cloudId !== row.externalOrg) {
    const app = await appRef(db, appId);
    if (app) await retireTrackerLinks(db, app);
  }
  await db.trackerIntegration.update({
    where: { appId },
    data: { teamId: choice.projectKey, externalOrg: choice.cloudId, externalUrl: choice.siteUrl },
  });
  return "chosen";
}
