-- CHE-434: where CheckMyApp got a check wrong, reported by the team it checked.
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "runId" TEXT,
    "findingId" TEXT,
    "journeyId" TEXT,
    "stepId" TEXT,
    "appJourneyId" TEXT,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "claimedAt" DATETIME,
    "issueIdentifier" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "Feedback_teamId_appId_idx" ON "Feedback"("teamId", "appId");
CREATE INDEX "Feedback_runId_idx" ON "Feedback"("runId");
CREATE INDEX "Feedback_appJourneyId_idx" ON "Feedback"("appJourneyId");
CREATE INDEX "Feedback_status_idx" ON "Feedback"("status");
