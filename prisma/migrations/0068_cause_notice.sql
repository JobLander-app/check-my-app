-- CHE-443: one mail per new cause per app. The admin of a team hears once that a
-- cause keeps part of an app from being checked (a store password that is
-- missing, a rule that stops a check on purpose); the same cause on the next run
-- sends nothing. The unique pair is what makes "once" true when two runs of one
-- app finish together. A row with no sentAt is a mail that did not go.
--
-- Re-runnable, like the migrations before it.

CREATE TABLE IF NOT EXISTS "CauseNotice" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "appId" TEXT NOT NULL,
  "cause" TEXT NOT NULL,
  "firstRunId" TEXT NOT NULL,
  "sentAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CauseNotice_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "CauseNotice_appId_cause_key" ON "CauseNotice"("appId", "cause");
CREATE INDEX IF NOT EXISTS "CauseNotice_appId_idx" ON "CauseNotice"("appId");
