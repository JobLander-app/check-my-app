// What the Jira callback does once the request is known to be the team's
// (CHE-438), apart from Next so the guard drives it against a fake Atlassian.

import type { PrismaClient } from "@/generated/prisma/client";
import { encryptSecret } from "@/lib/crypto";
import { exchangeJiraCode, jiraProjects, jiraSites } from "./jira";

export type JiraConnectOutcome = "jira_connected" | "jira_failed" | "jira_no_site" | "jira_no_project";

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
    // takes the grant's first site and that site's first project.
    const site = (existing?.type === "jira" && sites.find((s) => s.cloudId === existing.externalOrg)) || sites[0];
    if (!site) return "jira_no_site";
    const projects = await jiraProjects(token.access_token, site.cloudId, fetchImpl);
    const project = (existing?.type === "jira" && existing.externalOrg === site.cloudId && projects.find((p) => p.key === existing.teamId)) || projects[0];
    if (!project) return "jira_no_project";
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
