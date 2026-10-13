// What the Linear callback and the team picker store (CHE-31), apart from Next
// so scripts/verify-jira.ts drives a Jira → Linear switch on a real D1.
//
// CHE-469: the grant is the team's. A connect from any app stores it as the
// team's Linear connection; every other app of the team then picks a Linear
// team from it with no second consent.

import type { PrismaClient } from "@/generated/prisma/client";
import { encryptSecret } from "@/lib/crypto";
import { alreadyScoped } from "@/lib/tenant-db";
import { retireTrackerLinks } from "./provider-switch";
import { connectionApps, putConnection, routeApp, teamConnection } from "./connection";

type LinearTeam = { id: string; name: string };

export async function saveLinearGrant(
  db: PrismaClient,
  app: { id: string; teamId: string | null; ownerId: string | null; appSlug: string },
  token: { access_token: string; refresh_token?: string; expires_in?: number },
  // Every team the grant reaches, in Linear's order. Empty when Linear did not
  // answer: then nothing already chosen is touched.
  linearTeams: () => Promise<LinearTeam[]>,
  now = Date.now(),
): Promise<void> {
  if (!app.teamId) throw new Error("the app belongs to no team");
  const reach = await linearTeams().catch(() => [] as LinearTeam[]);
  const reaches = (id: string | null) => id !== null && (reach.length === 0 || reach.some((t) => t.id === id));

  // A reconnect must not clobber the owner's chosen team: the first-team
  // default is for first connects only (resetting joblander → first workspace
  // team on 2026-08-25 is how this line got here) — unless the new grant no
  // longer reaches it. Only a Linear row has a Linear team to keep: a Jira
  // row's teamId is a project key (CHE-438).
  const existing = await db.trackerIntegration.findUnique({ where: { appId: app.id } });
  const keep = existing?.type === "linear" && reaches(existing.teamId);
  const team = keep ? { id: existing!.teamId!, name: existing!.externalOrg } : (reach[0] ?? null);

  // Moving from Jira back to Linear, or to a workspace the old team is not in:
  // the old keys mean nothing here.
  if (existing && (existing.type !== "linear" || (existing.teamId !== null && !keep))) await retireTrackerLinks(db, app);

  // The team's grant: every app of the team on Linear files with it from now on.
  const connection = await putConnection(db, app.teamId, "linear", {
    accessTokenEnc: encryptSecret(token.access_token),
    // Without the refresh token the integration dies when the 24h access token
    // does (CHE-68) — freshLinearToken needs it to renew silently.
    refreshTokenEnc: token.refresh_token ? encryptSecret(token.refresh_token) : null,
    tokenExpiresAt: token.expires_in ? new Date(now + token.expires_in * 1000) : null,
  });
  await routeApp(db, app.id, connection, { teamId: team?.id ?? null, externalOrg: team?.name ?? null, externalUrl: null });

  // The team's other apps on Linear keep their Linear team where the new
  // grant reaches it; one it does not reach files nowhere until a team is
  // chosen again, and its links (another workspace's keys) are retired.
  for (const other of await connectionApps(db, app.teamId, "linear")) {
    if (other.appId === app.id || other.teamId === null || reaches(other.teamId)) continue;
    await retireTrackerLinks(db, other.app);
    await db.trackerIntegration.update({ where: { appId: other.appId }, data: { teamId: null, externalOrg: null } });
  }
}

export type LinearChoiceOutcome = "chosen" | "not_linear";

/**
 * Point the app's tickets at a team in the team's Linear (CHE-31 team picker).
 * The app need not have filed into Linear before (CHE-469): the team's grant
 * is the app's as soon as a Linear team is chosen. Moving from Jira retires
 * the Jira links (provider-switch.ts).
 */
export async function chooseLinearTeam(db: PrismaClient, appId: string, linearTeam: LinearTeam): Promise<LinearChoiceOutcome> {
  const app = await db.app.findUnique({
    ...alreadyScoped("the caller resolved this app"),
    where: { id: appId },
    select: { id: true, teamId: true, ownerId: true, appSlug: true },
  });
  if (!app?.teamId) return "not_linear";
  const connection = await teamConnection(db, app.teamId, "linear");
  if (!connection) return "not_linear";
  const row = await db.trackerIntegration.findUnique({ where: { appId } });
  if (row && row.type !== "linear") await retireTrackerLinks(db, app);
  await routeApp(db, appId, connection, { teamId: linearTeam.id, externalOrg: linearTeam.name, externalUrl: null });
  return "chosen";
}
