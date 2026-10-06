-- CHE-369: the GitHub App. An installation per account (owned by the team that
-- connected it), the repositories it can see and which app each one's deploys
-- check, every delivery GitHub sent (its id is the dedupe key), and one row
-- per GitHub Deployment that reached us — the claim that makes "one deploy,
-- one run" true however many statuses arrive.
--
-- New tables only; nothing the running worker reads changes shape.
CREATE TABLE "GitHubInstallation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "installationId" INTEGER NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "connectedById" TEXT NOT NULL,
    "suspendedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GitHubInstallation_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GitHubInstallation_installationId_key" ON "GitHubInstallation"("installationId");
CREATE INDEX "GitHubInstallation_teamId_idx" ON "GitHubInstallation"("teamId");

CREATE TABLE "GitHubRepo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "installationId" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "repoId" INTEGER NOT NULL,
    "appId" TEXT,
    "policy" TEXT NOT NULL DEFAULT 'production',
    "productionEnvs" TEXT NOT NULL DEFAULT 'production,Production',
    "teamId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GitHubRepo_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "GitHubInstallation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GitHubRepo_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GitHubRepo_installationId_repoFullName_key" ON "GitHubRepo"("installationId", "repoFullName");
CREATE INDEX "GitHubRepo_teamId_idx" ON "GitHubRepo"("teamId");
CREATE INDEX "GitHubRepo_repoFullName_idx" ON "GitHubRepo"("repoFullName");

CREATE TABLE "GitHubDelivery" (
    "deliveryId" TEXT NOT NULL PRIMARY KEY,
    "event" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "GitHubDeploymentCheck" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repoId" TEXT NOT NULL,
    "deploymentId" INTEGER NOT NULL,
    "environment" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "runId" TEXT,
    "githubCheckId" INTEGER,
    "refusal" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GitHubDeploymentCheck_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "GitHubRepo" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GitHubDeploymentCheck_repoId_deploymentId_key" ON "GitHubDeploymentCheck"("repoId", "deploymentId");
CREATE INDEX "GitHubDeploymentCheck_runId_idx" ON "GitHubDeploymentCheck"("runId");
