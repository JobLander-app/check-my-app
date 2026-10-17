-- CHE-469: a team connects a tracker once. The grant moves to the team's
-- TrackerConnection; an app's TrackerIntegration points at it. Rows are linked
-- the first time the code reads them (src/lib/tracker/connection.ts), so the
-- release before this one keeps working on its own columns meanwhile.
CREATE TABLE "TrackerConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT,
    "tokenExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TrackerConnection_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TrackerConnection_teamId_type_key" ON "TrackerConnection"("teamId", "type");

ALTER TABLE "TrackerIntegration" ADD COLUMN "connectionId" TEXT REFERENCES "TrackerConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "TrackerIntegration_connectionId_idx" ON "TrackerIntegration"("connectionId");
