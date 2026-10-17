// Does the tracker still answer the team's grant? (CHE-469, Codex on #347.)
//
// A grant revoked on the provider's side keeps its refresh token here, so the
// stored health reads ok while every call fails. The team's page asks the
// tracker itself: a Linear workspace always has a team, and a Jira grant
// reaches at least one site — none means the grant is no use, and the answer
// is Reconnect. Free of Next imports.

import type { PrismaClient } from "@/generated/prisma/client";
import { connectionGrant, type TeamTracker, type TrackerKind } from "./connection";
import { freshJiraToken, jiraSites } from "./jira";
import { fetchTeams } from "./linear-oauth";
import { freshLinearToken } from "./token";
import type { TrackerCreds } from "./factory";

export async function trackerAnswers(db: PrismaClient, kind: TrackerKind, connection: TeamTracker, creds: TrackerCreds, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    if (kind === "jira") return (await jiraSites(await freshJiraToken(db, connectionGrant(connection), creds.jira, fetchImpl), fetchImpl)).length > 0;
    return (await fetchTeams(await freshLinearToken(db, connectionGrant(connection), creds.linear))).length > 0;
  } catch {
    return false;
  }
}
