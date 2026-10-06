// What one GitHub delivery does to the database (CHE-369). The route
// (src/app/api/webhooks/github/route.ts) verifies the signature and hands the
// parsed body here; everything that talks to GitHub or starts a run goes
// through `deps`, so scripts/verify-github-app.ts walks every path with no
// network and a real D1.
//
// Two dedupe keys, both unique columns, both claimed by insert-first:
//   - GitHubDelivery.deliveryId — GitHub redelivers under the same id;
//   - GitHubDeploymentCheck (repoId, deploymentId) — one deployment reports
//     several statuses, and the one we act on may itself arrive twice.
// A unique violation is the other arrival winning, which is the outcome we
// wanted; it is never an error.

import type { PrismaClient } from "@/generated/prisma/client";
import type { UserPlan } from "@/lib/enums";
import { isUniqueViolation } from "@/lib/telegram";
import { startSavedApp } from "@/lib/start-saved-app";
import { captureServer } from "@/lib/analytics-server";
import { effectiveSiteCap } from "@/lib/site-cap";
import { triggerRun } from "@/lib/trigger";
import { alreadyScoped } from "@/lib/tenant-db";
import {
  type Fetch,
  type GitHubAppEnv,
  appConfigured,
  createCheckRun,
  deploymentWanted,
  installationRepos,
  installationToken,
  parseDeploymentStatus,
  reviewUrl,
} from "@/lib/github-app";

export interface Delivery {
  deliveryId: string;
  event: string;
  payload: unknown;
}

export interface WebhookDeps {
  trigger: (runId: string) => Promise<void>;
  siteCap: () => number;
  capture?: typeof captureServer;
  fetch: Fetch;
  baseUrl: string;
}

export const defaultWebhookDeps = (baseUrl: string): WebhookDeps => ({
  trigger: triggerRun,
  siteCap: effectiveSiteCap,
  capture: captureServer,
  fetch: (url, init) => fetch(url, init),
  baseUrl,
});

export type DeliveryOutcome =
  | "duplicate-delivery"
  | "ignored"
  | "not-a-deployment"
  | "unmapped"
  | "not-wanted"
  | "suspended"
  | "duplicate-deployment"
  | "started"
  | "refused"
  | "installation-updated"
  | "installation-removed"
  | "repos-updated";

// The one sentence a refused start leaves on the commit, so a deploy that was
// not checked never reads as a deploy that passed.
export function refusalTitle(reason: string): string {
  return `Not checked — ${reason.replace(/\.$/, "")}`;
}

export async function handleDelivery(db: PrismaClient, env: GitHubAppEnv, delivery: Delivery, deps: WebhookDeps): Promise<DeliveryOutcome> {
  // The claim. A delivery already on record and finished is a repeat; one on
  // record but unfinished is GitHub retrying what threw last time, and it is
  // handled again (the deployment row below keeps that from starting a
  // second run).
  try {
    await db.gitHubDelivery.create({ data: { deliveryId: delivery.deliveryId, event: delivery.event } });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const row = await db.gitHubDelivery.findUnique({ where: { deliveryId: delivery.deliveryId }, select: { handledAt: true } });
    if (row?.handledAt) return "duplicate-delivery";
  }
  const outcome = await dispatch(db, env, delivery, deps);
  await db.gitHubDelivery.update({ where: { deliveryId: delivery.deliveryId }, data: { handledAt: new Date() } });
  return outcome;
}

function dispatch(db: PrismaClient, env: GitHubAppEnv, delivery: Delivery, deps: WebhookDeps): Promise<DeliveryOutcome> {
  switch (delivery.event) {
    case "deployment_status":
      return onDeploymentStatus(db, env, delivery.payload, deps);
    case "installation":
      return onInstallation(db, delivery.payload);
    case "installation_repositories":
      return onInstallationRepositories(db, env, delivery.payload, deps);
    default:
      return Promise.resolve("ignored");
  }
}

async function onDeploymentStatus(db: PrismaClient, env: GitHubAppEnv, payload: unknown, deps: WebhookDeps): Promise<DeliveryOutcome> {
  const event = parseDeploymentStatus(payload);
  if (!event) return "not-a-deployment";
  // The repository under the installation that delivered it, by GitHub's id:
  // a name changes on a rename (and is not unique across installations — a
  // fork, a transfer); the id is the repository. The name is refreshed from
  // the delivery so the mapping screen shows the current one.
  if (!event.installationId) return "unmapped";
  const repo = await db.gitHubRepo.findFirst({ ...alreadyScoped("a signed GitHub delivery names the installation"),
    where: { repoId: event.repoId, installation: { installationId: event.installationId } },
    select: {
      id: true, appId: true, policy: true, productionEnvs: true, teamId: true, repoFullName: true,
      installation: { select: { installationId: true, connectedById: true, suspendedAt: true, team: { select: { plan: true } } } },
    },
  });
  if (!repo) return "unmapped";
  if (repo.repoFullName !== event.repoFullName) await db.gitHubRepo.update({ where: { id: repo.id }, data: { repoFullName: event.repoFullName } });
  if (!deploymentWanted(event, repo)) return "not-wanted";
  if (repo.installation.suspendedAt) return "suspended";
  const appId = repo.appId!;

  let claim: { id: string };
  try {
    claim = await db.gitHubDeploymentCheck.create({
      data: { repoId: repo.id, deploymentId: event.deploymentId, environment: event.environment, sha: event.sha },
      select: { id: true },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // The claim exists. Finished — a run or a refusal on it — means this
    // status is a repeat. Unfinished means the first attempt threw between
    // the claim and its outcome (the route answered 500, GitHub retried):
    // the work resumes on the same row rather than being skipped.
    const existing = await db.gitHubDeploymentCheck.findUnique({
      where: { repoId_deploymentId: { repoId: repo.id, deploymentId: event.deploymentId } },
      select: { id: true, runId: true, refusal: true },
    });
    if (!existing || existing.runId !== null || existing.refusal !== null) return "duplicate-deployment";
    claim = { id: existing.id };
  }

  const started = await startSavedApp(
    db,
    { id: repo.installation.connectedById, teamId: repo.teamId, plan: repo.installation.team.plan as UserPlan },
    appId,
    { trigger: deps.trigger, siteCap: deps.siteCap, capture: deps.capture, source: "github" },
    { deploy: { sha: event.sha, env: event.environment } },
  );

  const refusal =
    "error" in started
      ? started.error
      : started.alreadyRunning
        ? "a check of this app was already running; this deploy was not checked separately"
        : null;
  const runId = "error" in started || started.alreadyRunning ? null : (started.id ?? null);
  await db.gitHubDeploymentCheck.update({ where: { id: claim.id }, data: { runId, refusal } });

  // The answer on the commit. GitHub being unreachable must not undo the run
  // that already started: the Check Run is created when it can be, and the
  // run's own answer step completes it; without one, the review page is
  // still the record.
  if (appConfigured(env)) {
    try {
      const token = await installationToken(env, repo.installation.installationId, deps.fetch);
      const detailsUrl = runId
        ? reviewUrl(deps.baseUrl, (await db.run.findUnique({ ...alreadyScoped("created with its team"), where: { id: runId }, select: { publicId: true } }))?.publicId ?? "")
        : `${deps.baseUrl}/settings/integrations`;
      const check = refusal
        ? await createCheckRun(token, event.repoFullName, { headSha: event.sha, detailsUrl, status: "completed", conclusion: "neutral", output: { title: refusalTitle(refusal), summary: `${refusal}.` } }, deps.fetch)
        : await createCheckRun(token, event.repoFullName, { headSha: event.sha, detailsUrl, status: "in_progress", output: { title: "Checking this deploy…", summary: `A check of this deploy is running. The verdict lands here when it ends — and at ${detailsUrl}.` } }, deps.fetch);
      await db.gitHubDeploymentCheck.update({ where: { id: claim.id }, data: { githubCheckId: check.id } });
    } catch (err) {
      console.warn(`[github-app] check run for ${event.repoFullName}@${event.sha.slice(0, 7)} not created: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return refusal ? "refused" : "started";
}

interface InstallationPayload {
  action?: string;
  installation?: { id?: number };
  repositories_added?: Array<{ id: number; full_name: string }>;
  repositories_removed?: Array<{ id: number; full_name: string }>;
}

async function onInstallation(db: PrismaClient, payload: unknown): Promise<DeliveryOutcome> {
  const p = (payload ?? {}) as InstallationPayload;
  const installationId = p.installation?.id;
  if (typeof installationId !== "number") return "ignored";
  const row = await db.gitHubInstallation.findUnique({ ...alreadyScoped("a signed GitHub delivery names the installation"), where: { installationId }, select: { id: true } });
  if (!row) return "ignored";
  switch (p.action) {
    case "deleted":
      await db.gitHubInstallation.delete({ where: { id: row.id } });
      return "installation-removed";
    case "suspend":
      await db.gitHubInstallation.update({ where: { id: row.id }, data: { suspendedAt: new Date() } });
      return "installation-updated";
    case "unsuspend":
      await db.gitHubInstallation.update({ where: { id: row.id }, data: { suspendedAt: null } });
      return "installation-updated";
    default:
      return "ignored";
  }
}

async function onInstallationRepositories(db: PrismaClient, env: GitHubAppEnv, payload: unknown, deps: WebhookDeps): Promise<DeliveryOutcome> {
  const p = (payload ?? {}) as InstallationPayload;
  const installationId = p.installation?.id;
  if (typeof installationId !== "number") return "ignored";
  const row = await db.gitHubInstallation.findUnique({ ...alreadyScoped("a signed GitHub delivery names the installation"), where: { installationId }, select: { id: true, teamId: true } });
  if (!row) return "ignored";
  for (const r of p.repositories_added ?? []) {
    await db.gitHubRepo.upsert({
      where: { installationId_repoId: { installationId: row.id, repoId: r.id } },
      create: { installationId: row.id, repoFullName: r.full_name, repoId: r.id, teamId: row.teamId },
      update: { repoFullName: r.full_name },
    });
  }
  const removed = (p.repositories_removed ?? []).map((r) => r.id);
  if (removed.length) await db.gitHubRepo.deleteMany({ where: { installationId: row.id, repoId: { in: removed } } });
  // "all repositories" installs list nothing in the payload; the whole set is
  // re-read from GitHub when the App can ask.
  if (!p.repositories_added?.length && !removed.length && appConfigured(env)) await syncInstallationRepos(db, env, installationId, deps.fetch);
  return "repos-updated";
}

// The repositories an installation can see, as GitHub lists them now: rows
// added for new ones, kept (with their mapping) for known ones, removed for
// ones the App can no longer see.
export async function syncInstallationRepos(db: PrismaClient, env: GitHubAppEnv, installationId: number, fetchImpl: Fetch): Promise<number> {
  if (!appConfigured(env)) return 0;
  const row = await db.gitHubInstallation.findUnique({ ...alreadyScoped("a signed GitHub delivery names the installation"), where: { installationId }, select: { id: true, teamId: true } });
  if (!row) return 0;
  const token = await installationToken(env, installationId, fetchImpl);
  const { repos, complete } = await installationRepos(token, fetchImpl);
  for (const r of repos) {
    await db.gitHubRepo.upsert({
      where: { installationId_repoId: { installationId: row.id, repoId: r.id } },
      create: { installationId: row.id, repoFullName: r.full_name, repoId: r.id, teamId: row.teamId },
      update: { repoFullName: r.full_name },
    });
  }
  // Only a complete listing says what is gone; a partial one would delete
  // mappings that merely sit beyond the last page read.
  if (!complete) return repos.length;
  // Up to D1's parameter cap per statement; an installation with more
  // repositories than that is deleted-from in chunks.
  const keep = repos.map((r) => r.id);
  const current = await db.gitHubRepo.findMany({ where: { installationId: row.id }, select: { id: true, repoId: true } });
  const gone = current.filter((c) => !keep.includes(c.repoId)).map((c) => c.id);
  for (let i = 0; i < gone.length; i += 90) await db.gitHubRepo.deleteMany({ where: { id: { in: gone.slice(i, i + 90) } } });
  return repos.length;
}
