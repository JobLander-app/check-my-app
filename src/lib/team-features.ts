// CHE-433: what a team has been given beyond its plan. The Securify pilot
// (CHE-432) puts everything Shopify — connecting an app, members' feedback,
// team scenarios, a team's own model key — behind one flag, per team. The
// env list of team ids it replaces (CHE-333) could name teams but not say what
// they were given, and changing it was a deploy.
//
// The list is closed: an unknown name in the column is ignored, never trusted.
// Set by us (`npm run team:feature`), never by a customer.

import type { PrismaClient } from "@/generated/prisma/client";

export const TEAM_FEATURES = ["shopify"] as const;
export type TeamFeature = (typeof TEAM_FEATURES)[number];

/** Team.features as stored (a JSON array of names) → the known features in it. */
export function parseTeamFeatures(raw: string | null | undefined): TeamFeature[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return TEAM_FEATURES.filter((f) => parsed.includes(f));
}

export function hasFeature(features: readonly string[] | null | undefined, feature: TeamFeature): boolean {
  return Boolean(features?.includes(feature));
}

/** The team's features, read from its row; none for a team that does not exist. */
export async function teamFeatures(db: PrismaClient, teamId: string): Promise<TeamFeature[]> {
  const team = await db.team.findUnique({ where: { id: teamId }, select: { features: true } });
  return parseTeamFeatures(team?.features);
}

export async function teamHasFeature(db: PrismaClient, teamId: string, feature: TeamFeature): Promise<boolean> {
  return hasFeature(await teamFeatures(db, teamId), feature);
}

/** What `features` becomes when `change` is applied ("+shopify" / "-shopify"). */
export function withFeatureChange(current: readonly TeamFeature[], change: string): TeamFeature[] | null {
  const m = /^([+-])([a-z_]+)$/.exec(change.trim());
  if (!m) return null;
  const feature = TEAM_FEATURES.find((f) => f === m[2]);
  if (!feature) return null;
  const set = new Set(current);
  if (m[1] === "+") set.add(feature);
  else set.delete(feature);
  return TEAM_FEATURES.filter((f) => set.has(f));
}
