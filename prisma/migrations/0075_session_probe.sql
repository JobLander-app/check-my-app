-- CHE-464: one line per hourly look at a team's Shopify admin from the team's
-- session browser (src/agent/session-runner.ts).
CREATE TABLE "SessionProbe" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamId" TEXT NOT NULL,
    "appId" TEXT,
    "at" DATETIME NOT NULL,
    "state" TEXT NOT NULL,
    "urlHost" TEXT,
    "urlPath" TEXT,
    "ms" INTEGER NOT NULL,
    "challenge" TEXT,
    "detail" TEXT,
    "proxyStatus" INTEGER,
    "notified" BOOLEAN,
    "notifyError" TEXT
);
CREATE INDEX "SessionProbe_teamId_at_idx" ON "SessionProbe"("teamId", "at");
