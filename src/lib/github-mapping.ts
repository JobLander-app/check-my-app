// Which app each repository deploys, and whether its deploys are checked
// (CHE-369, part B). The GitHub App knows the repositories an installation can
// see; only the team can say which of its apps a repository ships — so the
// mapping is the team's, set per app on that app's Integrations section, one
// row per repository.
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
  production: "Production deploys",
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

// What the team's Integrations panel needs: the team's installations and the
// repositories they can see. The mapping is set per app on the app's own
// Integrations section (src/components/app-github-repo.tsx), so this no longer
// returns apps or their price lines.
export async function teamGitHub(db: PrismaClient, team: { id: string }): Promise<TeamGitHub> {
  const installations = await db.gitHubInstallation.findMany({
    where: { ...teamOwned(team.id) },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      accountLogin: true,
      suspendedAt: true,
      repos: { orderBy: { repoFullName: "asc" }, select: { id: true, repoFullName: true, appId: true, policy: true } },
    },
  });
  return {
    installations: installations.map((i) => ({
      id: i.id,
      accountLogin: i.accountLogin,
      suspended: i.suspendedAt !== null,
      repos: i.repos.map((r) => ({ id: r.id, repoFullName: r.repoFullName, appId: r.appId, policy: offered(r.policy) })),
    })),
  };
}

// What one app's Integrations section needs: whether GitHub is connected at
// all, every repository of the team's installations, the one (if any) mapped
// to this app, and the price line under the switch. One repository per app:
// setting `current` clears any other row that pointed at this app.
export async function appGitHub(
  db: PrismaClient,
  team: { id: string; plan: UserPlan },
  appId: string,
): Promise<{ installed: boolean; repos: Array<{ id: string; repoFullName: string; appId: string | null }>; current: { repoId: string; policy: OfferedPolicy; suspended: boolean } | null; priceLine: string }> {
  const installationRows = await db.gitHubInstallation.findMany({
    where: { ...teamOwned(team.id) },
    orderBy: { createdAt: "asc" },
    select: { id: true, suspendedAt: true, repos: { orderBy: { repoFullName: "asc" }, select: { id: true, repoFullName: true, appId: true, policy: true } } },
  });
  // Each repository carries its installation's suspension: a suspended one
  // starts nothing (github-webhook.ts), so its line must not promise a check.
  const repos = installationRows.flatMap((i) => i.repos.map((r) => ({ ...r, suspended: i.suspendedAt !== null })));
  // One at most: GitHubRepo.appId is unique (0059).
  const currentRow = repos.find((r) => r.appId === appId) ?? null;
  const installed = installationRows.length > 0;
  const app = await db.app.findFirst({ where: { ...teamOwned(team.id), id: appId }, select: { appSlug: true } });
  const line = app ? priceLine(await appPriceRange(db, team, app.appSlug), typicalPriceRange(team.plan)) : priceLine(null, typicalPriceRange(team.plan));
  return {
    installed,
    repos: repos.map((r) => ({ id: r.id, repoFullName: r.repoFullName, appId: r.appId })),
    current: currentRow ? { repoId: currentRow.id, policy: offered(currentRow.policy), suspended: currentRow.suspended } : null,
    priceLine: line,
  };
}

// Every sentence the GitHub App panel shows (src/components/github-app-panel.tsx),
// here so scripts/verify-github-app.ts can run them through the verdict's own
// language gates (CODE_STANDARDS R18).
export const GITHUB_PANEL_COPY = {
  title: "GitHub App",
  tagline: "checks from your deploys, no YAML",
  installedIntro:
    "GitHub is connected. Each app picks its repository on its own Integrations section.",
  emptyIntro:
    "Install it on the GitHub account your apps deploy from. A successful production deploy then starts a check, and the verdict appears on the commit.",
  install: "Install →",
  addAccount: "Add an account →",
  unavailable: "The GitHub App isn't available yet.",
  adminInstalls: "An admin of the team installs it.",
  suspended: "suspended on GitHub — nothing is checked",
  noRepos: "No repositories yet — choose them in the App's settings on GitHub.",
  repoCount: "repositories",
} as const;

// Every sentence the per-app GitHub repo picker shows (src/components/app-github-repo.tsx).
export const APP_GITHUB_COPY = {
  title: "GitHub repository",
  tagline: "where this app is deployed from",
  notInstalled: "Connect GitHub on the team's Integrations first.",
  connectLink: "Integrations →",
  repoLabel: "Repository this app is deployed from",
  none: "None",
  policyLabel: "When its deploys are checked",
  save: "Save",
} as const;

// The line under a repository's row: what its deploys do now. A suspended
// installation starts nothing, whatever the row says (src/lib/github-webhook.ts
// answers "suspended" before any run), so it never promises a check.
export function repoStatusLine(row: { appSlug: string | null; priceLine: string | null; policy: OfferedPolicy; suspended: boolean }): string {
  if (!row.appSlug) return "Not mapped — its deploys start nothing.";
  if (row.suspended) return `Deploys of ${row.appSlug} are not checked while the App is suspended on GitHub.`;
  // One check of an app at a time: a deploy that lands while one is running is
  // answered on its commit as not checked (src/lib/github-webhook.ts), so the
  // line says so instead of promising every deploy.
  if (row.policy === "production") return `A production deploy starts a check — ${row.priceLine}. One that lands while a check is still running is not checked separately.`;
  return `Deploys of ${row.appSlug} are not checked.`;
}

// What the server action can answer with, rendered on the page as a notice.
export const MAPPING_ERRORS = {
  noRepo: "No repository was named.",
  noPolicy: "Choose when this repository's deploys are checked.",
  otherRepo: "That repository is not connected to this team.",
  otherApp: "That app is not one of this team's websites.",
} as const;

export type MappingErrorCode = keyof typeof MAPPING_ERRORS;

// The page shows a refusal by its code, never by a sentence carried in the
// URL: a crafted ?error= must not put words under our name.
export function mappingErrorText(code: string | undefined): string | null {
  return code && Object.hasOwn(MAPPING_ERRORS, code) ? MAPPING_ERRORS[code as MappingErrorCode] : null;
}

// The team's activity log line for a saved row (/settings/team shows it). It
// records the setting, not an outcome the webhook does not guarantee.
export function mappingEventSummary(row: { repoFullName: string; appSlug: string | null; policy: OfferedPolicy }): string {
  if (!row.appSlug) return `unmapped ${row.repoFullName}`;
  if (row.policy === "production") return `set successful production deploys of ${row.repoFullName} to start checks of ${row.appSlug}`;
  return `mapped ${row.repoFullName} to ${row.appSlug}, its deploys start no checks`;
}

export function allPanelSentences(): string[] {
  return [
    ...Object.values(GITHUB_PANEL_COPY),
    ...Object.values(APP_GITHUB_COPY),
    ...Object.values(POLICY_LABELS),
    ...Object.values(MAPPING_ERRORS),
    mappingEventSummary({ repoFullName: "acme/shop", appSlug: null, policy: "production" }),
    mappingEventSummary({ repoFullName: "acme/shop", appSlug: "shop.example", policy: "production" }),
    mappingEventSummary({ repoFullName: "acme/shop", appSlug: "shop.example", policy: "off" }),
    repoStatusLine({ appSlug: null, priceLine: null, policy: "production", suspended: false }),
    repoStatusLine({ appSlug: "shop.example", priceLine: "usually $0.48–$0.80 a check", policy: "production", suspended: false }),
    repoStatusLine({ appSlug: "shop.example", priceLine: "usually $0.48–$0.80 a check", policy: "off", suspended: false }),
    repoStatusLine({ appSlug: "shop.example", priceLine: "usually $0.48–$0.80 a check", policy: "production", suspended: true }),
  ];
}

// The form → the row to save, or the reason it is not one. An empty
// repository means "not mapped" (nothing happens on this app's deploys).
export function appRepoFromForm(form: FormData): { repoId: string | null; policy: OfferedPolicy } | { error: MappingErrorCode } {
  const repoId = String(form.get("repoId") ?? "");
  const policy = String(form.get("policy") ?? "");
  if (!(OFFERED_POLICIES as readonly string[]).includes(policy)) return { error: "noPolicy" };
  return { repoId: repoId || null, policy: policy as OfferedPolicy };
}

// Saves one row to one app, refusing a repository of another team and any app
// that is not one of the team's websites — the form offers only those, and
// the action is an entry point anyone can post to, so the server says it
// again (a deploy cannot be checked as a Chrome extension).
export async function saveAppRepo(
  db: PrismaClient,
  teamId: string,
  appId: string,
  input: { repoId: string | null; policy: OfferedPolicy },
): Promise<{ ok: true; repoFullName: string | null; appSlug: string } | { error: MappingErrorCode }> {
  const app = await db.app.findFirst({ where: { ...teamOwned(teamId), id: appId, targetKind: "website" }, select: { appSlug: true } });
  if (!app) return { error: "otherApp" };
  if (input.repoId) {
    const repo = await db.gitHubRepo.findFirst({ where: { ...teamOwned(teamId), id: input.repoId }, select: { id: true, repoFullName: true } });
    if (!repo) return { error: "otherRepo" };
  }
  await db.gitHubRepo.updateMany({
    where: { ...teamOwned(teamId), appId, ...(input.repoId ? { id: { not: input.repoId } } : {}) },
    data: { appId: null },
  });
  let repoFullName: string | null = null;
  if (input.repoId) {
    const repo = await db.gitHubRepo.findFirst({ where: { ...teamOwned(teamId), id: input.repoId }, select: { repoFullName: true } });
    repoFullName = repo?.repoFullName ?? null;
    await db.gitHubRepo.update({ where: { id: input.repoId }, data: { appId, policy: input.policy } });
  }
  return { ok: true, repoFullName, appSlug: app.appSlug };
}
