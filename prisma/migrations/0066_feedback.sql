-- CHE-434: a team's comments and corrections on an app, a scenario or a run.
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "runId" TEXT,
    "findingId" TEXT,
    "stepId" TEXT,
    "appJourneyId" TEXT,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'comment',
    "text" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "issueIdentifier" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "Feedback_teamId_appId_idx" ON "Feedback"("teamId", "appId");
CREATE INDEX "Feedback_runId_idx" ON "Feedback"("runId");
CREATE INDEX "Feedback_appJourneyId_idx" ON "Feedback"("appJourneyId");
CREATE INDEX "Feedback_status_idx" ON "Feedback"("status");
