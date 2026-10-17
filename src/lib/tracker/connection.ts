// CHE-469: a team connects a tracker once.
//
// The owner, 2026-10-13: "integrations are team wide, if there is integration
// connected to one app, lets use it, dont ask second time". The grant — the
// OAuth tokens — is the team's TrackerConnection, one per team and kind. An
// app's TrackerIntegration says only where its tickets go (a Linear team, a
// Jira site and project) and which connection files them. Every token read and
// refresh comes through here, from the web app and the agent worker alike, so
// filing, reconciling, the pages and MCP all use the same grant. Free of Next
// imports.
//
// Rows made before this existed are linked the first time they are read: the
// team's freshest grant of that kind becomes the connection, and every app of
// the team on that kind points at it. Freshest = the latest expiry, i.e. the
// grant refreshed last, the one most surely alive. On the day, prod had one
// Jira site connected twice and one Linear workspace three times.
//
// Expand step. The release before this one reads and refreshes the token
// columns of TrackerIntegration itself, and it serves pages for the minutes
// between this release's agent deploy and its web deploy. Both providers
// rotate refresh tokens, so two diverging copies of one grant kill each other.
// Until the contract step drops those columns:
//   - whatever is stored here is mirrored onto every row of the team on that
//     kind, so the older code reads the current tokens and never refreshes
//     with a rotated-out one;
//   - a row fresher than its connection (the older code refreshed it) is
//     taken back into the connection when it is read.

import type { PrismaClient } from "@/generated/prisma/client";
import { alreadyScoped, teamOwned } from "@/lib/tenant-db";
import { retireTrackerLinks } from "./provider-switch";

export type TrackerKind = "linear" | "jira";
export const TRACKER_KINDS: TrackerKind[] = ["linear", "jira"];

/** The tokens a call is made with, and the row that keeps them. */
export interface Grant {
  /** A team's connection; or, for an app that belongs to no team, its own row. */
  holder: "connection" | "integration";
  id: string;
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date | null;
}

export type GrantTokens = Pick<Grant, "accessTokenEnc" | "refreshTokenEnc" | "tokenExpiresAt">;

export interface TeamTracker extends GrantTokens {
  id: string;
  teamId: string;
  type: string;
  createdAt: Date;
}

/** An app's tracker row, as every consumer already reads it (include: { tracker: true }). */
export interface AppTrackerRow extends GrantTokens {
  id: string;
  appId?: string;
  connectionId?: string | null;
}

export function connectionGrant(c: Pick<TeamTracker, "id"> & GrantTokens): Grant {
  return { holder: "connection", id: c.id, accessTokenEnc: c.accessTokenEnc, refreshTokenEnc: c.refreshTokenEnc, tokenExpiresAt: c.tokenExpiresAt };
}

const tokensOf = (g: GrantTokens): GrantTokens => ({ accessTokenEnc: g.accessTokenEnc, refreshTokenEnc: g.refreshTokenEnc, tokenExpiresAt: g.tokenExpiresAt });
const stamp = (g: GrantTokens) => g.tokenExpiresAt?.getTime() ?? Number.NEGATIVE_INFINITY;

// The team's rows of one kind, linked or not yet. Filtered through the app's
// team, never by a list of ids: D1 caps a statement's bound values.
const teamRows = (teamId: string, kind: TrackerKind) => ({ type: kind, app: { ...teamOwned(teamId) } });

/**
 * The team's connection of this kind, or null when the team has none. Links
 * the team's rows that are not linked yet, and takes in a fresher grant from
 * any of them (expand step).
 */
export async function teamConnection(db: PrismaClient, teamId: string, kind: TrackerKind): Promise<TeamTracker | null> {
  const [existing, rows] = await Promise.all([
    db.trackerConnection.findUnique({ ...alreadyScoped("the unique key names the owner"), where: { teamId_type: { teamId, type: kind } } }),
    db.trackerIntegration.findMany({
      where: teamRows(teamId, kind),
      select: { connectionId: true, accessTokenEnc: true, refreshTokenEnc: true, tokenExpiresAt: true },
    }),
  ]);
  if (!existing && rows.length === 0) return null;
  const freshest = rows.reduce<GrantTokens | null>((best, r) => (best === null || stamp(r) > stamp(best) ? r : best), null);
  const loose = rows.some((r) => r.connectionId !== existing?.id);
  if (existing && !loose && (freshest === null || stamp(freshest) <= stamp(existing))) return existing;
  const tokens = existing && (freshest === null || stamp(freshest) <= stamp(existing)) ? tokensOf(existing) : tokensOf(freshest!);
  return putConnection(db, teamId, kind, tokens);
}

/** Both kinds, for the pages that show what the team has connected. */
export async function teamConnections(db: PrismaClient, teamId: string): Promise<Record<TrackerKind, TeamTracker | null>> {
  const [linear, jira] = await Promise.all(TRACKER_KINDS.map((k) => teamConnection(db, teamId, k)));
  return { linear, jira };
}

/**
 * Store a grant as the team's connection of this kind — a connect, a
 * reconnect, or a fresher grant taken in — and point every row of the team on
 * that kind at it, with its tokens mirrored (expand step).
 */
export async function putConnection(db: PrismaClient, teamId: string, kind: TrackerKind, tokens: GrantTokens): Promise<TeamTracker> {
  const data = tokensOf(tokens);
  let connection: TeamTracker;
  try {
    connection = await db.trackerConnection.upsert({
      ...alreadyScoped("the unique key names the owner"),
      where: { teamId_type: { teamId, type: kind } },
      create: { teamId, type: kind, ...data },
      update: data,
    });
  } catch (err) {
    // Two first reads of the same team at once: one creates, the other finds.
    const found = await db.trackerConnection.findUnique({ ...alreadyScoped("the unique key names the owner"), where: { teamId_type: { teamId, type: kind } } });
    if (!found) throw err;
    connection = await db.trackerConnection.update({ ...alreadyScoped("the unique key names the owner"), where: { id: found.id }, data });
  }
  await db.trackerIntegration.updateMany({ where: teamRows(teamId, kind), data: { connectionId: connection.id, ...data } });
  return connection;
}

/**
 * The grant an app's tracker row files with: its team's connection. An app
 * that belongs to no team (none in prod; the schema still allows it) keeps
 * its own row's tokens.
 */
export async function grantFor(db: PrismaClient, row: AppTrackerRow, kind: TrackerKind): Promise<Grant> {
  const own: Grant = { holder: "integration", id: row.id, ...tokensOf(row) };
  if (!row.appId) return own;
  const app = await db.app.findUnique({ ...alreadyScoped("the caller resolved this app"), where: { id: row.appId }, select: { teamId: true } });
  if (!app?.teamId) return own;
  const connection = await teamConnection(db, app.teamId, kind);
  return connection ? connectionGrant(connection) : own;
}

/** The grant as stored now: a page may hold one read before a refresh. */
export async function liveGrant(db: PrismaClient, grant: Grant): Promise<Grant> {
  const row =
    grant.holder === "connection"
      ? await db.trackerConnection.findUnique({ ...alreadyScoped("already read in this request"), where: { id: grant.id } })
      : await db.trackerIntegration.findUnique({ where: { id: grant.id } });
  return row ? { holder: grant.holder, id: grant.id, ...tokensOf(row) } : grant;
}

/** A refreshed grant, written where it is kept and mirrored onto the rows that use it (expand step). */
export async function storeGrant(db: PrismaClient, grant: Grant, tokens: Partial<GrantTokens>): Promise<void> {
  if (grant.holder === "integration") {
    await db.trackerIntegration.update({ where: { id: grant.id }, data: tokens });
    return;
  }
  await db.trackerConnection.update({ ...alreadyScoped("already read in this request"), where: { id: grant.id }, data: tokens });
  await db.trackerIntegration.updateMany({ where: { connectionId: grant.id }, data: tokens });
}

/** Where an app's tickets go, in its tracker's own terms. */
export interface Routing {
  teamId: string | null;
  externalOrg: string | null;
  externalUrl: string | null;
}

/**
 * Point an app at its team's connection: the app files into that tracker,
 * where `routing` says. Retiring the links of the tracker or site it leaves is
 * the caller's, who knows what it was (provider-switch.ts).
 */
export async function routeApp(
  db: PrismaClient,
  appId: string,
  connection: Pick<TeamTracker, "id" | "type">,
  routing: Routing,
): Promise<void> {
  // The tokens as stored now (a refresh may have happened since the caller
  // read the connection); the column is required until the contract step.
  const live = await db.trackerConnection.findUnique({ ...alreadyScoped("already read in this request"), where: { id: connection.id } });
  if (!live) throw new Error("the team's tracker connection is gone");
  const data = { type: connection.type, connectionId: connection.id, ...routing, ...tokensOf(live) };
  await db.trackerIntegration.upsert({ where: { appId }, create: { appId, ...data }, update: data });
}

/** The apps of the team that file with this connection, for the team page and a disconnect. */
export async function connectionApps(db: PrismaClient, teamId: string, kind: TrackerKind) {
  return db.trackerIntegration.findMany({
    where: teamRows(teamId, kind),
    select: { appId: true, teamId: true, externalOrg: true, externalUrl: true, app: { select: { id: true, teamId: true, ownerId: true, appSlug: true, name: true, targetUrl: true, targetKind: true } } },
  });
}

/**
 * Disconnect the team's tracker of this kind: the grant is deleted, and every
 * app that filed with it stops — its row goes, and its in-flight links are
 * retired (an issue key means nothing in whatever is connected next). Returns
 * the apps that stopped, or null when there was nothing to disconnect.
 */
export async function disconnectTeamTracker(db: PrismaClient, teamId: string, kind: TrackerKind): Promise<string[] | null> {
  const connection = await teamConnection(db, teamId, kind);
  if (!connection) return null;
  const apps = await connectionApps(db, teamId, kind);
  for (const { app } of apps) await retireTrackerLinks(db, app);
  await db.trackerIntegration.deleteMany({ where: teamRows(teamId, kind) });
  await db.trackerConnection.deleteMany({ where: { ...teamOwned(teamId), type: kind } });
  return apps.map(({ app }) => app.appSlug);
}
