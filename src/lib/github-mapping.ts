// Which app each repository deploys, and whether its deploys are checked
// (CHE-369, part B). The GitHub App knows the repositories an installation can
// see; only the team can say which of its apps a repository ships — so the
// mapping is the team's, set on Integrations, one row per repository.
//
// The price sits next to the switch: an owner turning on "every production
// deploy" is told what one check of that app usually costs, so a busy week of
// deploys is never a surprise (CLAUDE.md §10: the price, never our cost).

import type { PrismaClient } from "@/generated/prisma/client";
import type { UserPlan } from "@/lib/enums";
import { appPriceRange, typicalPriceRange } from "@/lib/plans";
import { teamOwned } from "@/lib/tenant-db";

// What the switch offers today. "all" (previews too) exists in the schema and
// arrives with ephemeral preview runs; until then it is not offered, so the
// screen never promises a check that does not happen.
export const OFFERED_POLICIES = ["production", "off"] as const;
export type OfferedPolicy = (typeof OFFERED_POLICIES)[number];

export const POLICY_LABELS: Record<OfferedPolicy, string> = {
  production: "Every production deploy",
  off: "Off",
};

export interface MappedRepo {
  id: string;
  repoFullName: string;
  appId: string | null;
  policy: OfferedPolicy;
}

export interface TeamGitHub {
  installations: Array<{ id: string; accountLogin: string; suspended: boolean; repos: MappedRepo[] }>;
  apps: Array<{ id: string; appSlug: string; priceLine: string }>;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

// "usually $0.48–$0.80 a check" from the app's own recent checks, or the
// plan's typical range for an app with fewer than three.
export function priceLine(own: { low: number; high: number } | null, typical: { low: number; high: number }): string {
  if (own) return own.low === own.high ? `usually ${usd(own.low)} a check` : `usually ${usd(own.low)}–${usd(own.high)} a check`;
  return `a check is typically ${usd(typical.low)}–${usd(typical.high)}`;
}

function offered(policy: string): OfferedPolicy {
  return (OFFERED_POLICIES as readonly string[]).includes(policy) ? (policy as OfferedPolicy) : "production";
}

export async function teamGitHub(db: PrismaClient, team: { id: string; plan: UserPlan }): Promise<TeamGitHub> {
  const [installations, apps] = await Promise.all([
    db.gitHubInstallation.findMany({
      where: { ...teamOwned(team.id) },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        accountLogin: true,
        suspendedAt: true,
        repos: { orderBy: { repoFullName: "asc" }, select: { id: true, repoFullName: true, appId: true, policy: true } },
      },
    }),
    db.app.findMany({
      where: { ...teamOwned(team.id), targetKind: "website" },
      orderBy: { appSlug: "asc" },
      select: { id: true, appSlug: true },
    }),
  ]);
  const typical = typicalPriceRange(team.plan);
  const priced = await Promise.all(
    apps.map(async (a) => ({ id: a.id, appSlug: a.appSlug, priceLine: priceLine(await appPriceRange(db, team, a.appSlug), typical) })),
  );
  return {
    installations: installations.map((i) => ({
      id: i.id,
      accountLogin: i.accountLogin,
      suspended: i.suspendedAt !== null,
      repos: i.repos.map((r) => ({ id: r.id, repoFullName: r.repoFullName, appId: r.appId, policy: offered(r.policy) })),
    })),
    apps: priced,
  };
}

export type MappingInput = { repoId: string; appId: string | null; policy: OfferedPolicy };

// The form → a mapping, or the reason it is not one. An empty app means
// "not mapped" (nothing happens on its deploys).
export function mappingFromForm(form: FormData): MappingInput | { error: string } {
  const repoId = String(form.get("repoId") ?? "");
  const appId = String(form.get("appId") ?? "");
  const policy = String(form.get("policy") ?? "");
  if (!repoId) return { error: "No repository was named." };
  if (!(OFFERED_POLICIES as readonly string[]).includes(policy)) return { error: "Choose when this repository's deploys are checked." };
  return { repoId, appId: appId || null, policy: policy as OfferedPolicy };
}

// Saves one row, refusing a repository or an app of another team.
export async function saveRepoMapping(db: PrismaClient, teamId: string, input: MappingInput): Promise<{ ok: true; repoFullName: string; appSlug: string | null } | { error: string }> {
  const repo = await db.gitHubRepo.findFirst({ where: { ...teamOwned(teamId), id: input.repoId }, select: { id: true, repoFullName: true } });
  if (!repo) return { error: "That repository is not connected to this team." };
  let appSlug: string | null = null;
  if (input.appId) {
    const app = await db.app.findFirst({ where: { ...teamOwned(teamId), id: input.appId }, select: { appSlug: true } });
    if (!app) return { error: "That app is not one of this team's." };
    appSlug = app.appSlug;
  }
  await db.gitHubRepo.update({ where: { id: repo.id }, data: { appId: input.appId, policy: input.policy } });
  return { ok: true, repoFullName: repo.repoFullName, appSlug };
}
