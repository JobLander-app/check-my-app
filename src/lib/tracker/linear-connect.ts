// What the Linear callback stores once the code is exchanged (CHE-31), apart
// from Next so scripts/verify-jira.ts drives a Jira → Linear switch on a real D1.

import type { PrismaClient } from "@/generated/prisma/client";
import { encryptSecret } from "@/lib/crypto";
import { retireTrackerLinks } from "./provider-switch";

export async function saveLinearGrant(
  db: PrismaClient,
  app: { id: string; teamId: string | null; ownerId: string | null; appSlug: string },
  token: { access_token: string; refresh_token?: string; expires_in?: number },
  firstTeam: () => Promise<{ id: string; name: string } | null>,
  now = Date.now(),
): Promise<void> {
  const expiresAt = token.expires_in ? new Date(now + token.expires_in * 1000) : null;
  const accessTokenEnc = encryptSecret(token.access_token);
  // Without the refresh token the integration dies when the 24h access token
  // does (CHE-68) — freshLinearToken needs it to renew silently.
  const refreshTokenEnc = token.refresh_token ? encryptSecret(token.refresh_token) : null;

  // A reconnect must not clobber the owner's chosen team: the first-team
  // default is for first connects only (resetting joblander → first workspace
  // team on 2026-08-25 is how this line got here). Only a Linear row has a
  // Linear team to keep: a Jira row's teamId is a project key (CHE-438).
  const existing = await db.trackerIntegration.findUnique({ where: { appId: app.id } });
  const team = existing?.type === "linear" && existing.teamId
    ? { id: existing.teamId, name: existing.externalOrg ?? undefined }
    : await firstTeam();

  // Moving from Jira back to Linear: Jira's keys mean nothing in Linear.
  if (existing && existing.type !== "linear") await retireTrackerLinks(db, app);

  const data = {
    type: "linear",
    accessTokenEnc,
    refreshTokenEnc,
    teamId: team?.id ?? null,
    externalOrg: team?.name ?? null,
    externalUrl: null,
    tokenExpiresAt: expiresAt,
  };
  await db.trackerIntegration.upsert({ where: { appId: app.id }, create: { appId: app.id, ...data }, update: data });
}
