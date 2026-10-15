// The one place that turns an app's TrackerIntegration into a Tracker
// (CHE-438). Before Jira, every site said `new LinearTracker(...)`; now the
// integration's type decides. Free of Next imports — the agent worker uses it.
//
// Linear: teamId = the Linear team, externalOrg = its name.
// Jira:   teamId = the project key, externalOrg = the site's cloudId,
//         externalUrl = the site (https://<name>.atlassian.net).
//
// Our own board (capability-gaps.ts ourBoard) is Linear by construction and
// does not come through here.

import type { PrismaClient } from "@/generated/prisma/client";
import { LinearTracker } from "./linear";
import { freshLinearToken, type LinearOAuthCreds } from "./token";
import { JiraTracker, freshJiraToken, type JiraCreds } from "./jira";
import type { Tracker } from "./types";

export interface TrackerRow {
  id: string;
  type: string;
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date | null;
  teamId: string | null;
  externalOrg: string | null;
  externalUrl?: string | null;
}

export interface TrackerCreds {
  linear: LinearOAuthCreds;
  jira: JiraCreds;
}

/** The bindings or env the credentials live in, by their names. */
export function trackerCreds(env: Record<string, unknown>): TrackerCreds {
  const s = (k: string) => (typeof env[k] === "string" ? (env[k] as string) : undefined);
  return {
    linear: { clientId: s("LINEAR_CLIENT_ID"), clientSecret: s("LINEAR_CLIENT_SECRET") },
    jira: { clientId: s("JIRA_CLIENT_ID"), clientSecret: s("JIRA_CLIENT_SECRET") },
  };
}

/** The tracker an app files into, or null when it has nowhere to file (no team / project). */
export async function trackerFor(db: PrismaClient, row: TrackerRow, creds: TrackerCreds, fetchImpl: typeof fetch = fetch): Promise<Tracker | null> {
  if (!row.teamId) return null;
  if (row.type === "jira") {
    if (!row.externalOrg) return null;
    const token = await freshJiraToken(db, row, creds.jira, fetchImpl);
    return new JiraTracker(token, row.externalOrg, row.teamId, row.externalUrl ?? "", fetchImpl);
  }
  return new LinearTracker(await freshLinearToken(db, row, creds.linear), row.teamId);
}

export { trackerName } from "./name";
