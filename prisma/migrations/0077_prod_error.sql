-- CHE-486 part 3: errors in production, one row per signature
-- (src/lib/prod-error.ts, src/agent/prod-errors.ts).
CREATE TABLE "ProdError" (
    "signature" TEXT NOT NULL PRIMARY KEY,
    "script" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "frame" TEXT,
    "path" TEXT,
    "count" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" DATETIME NOT NULL,
    "lastSeenAt" DATETIME NOT NULL,
    "issueIdentifier" TEXT,
    "lastToldAt" DATETIME,
    "settled" BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX "ProdError_lastSeenAt_idx" ON "ProdError"("lastSeenAt");
