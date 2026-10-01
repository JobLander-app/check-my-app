-- The sidebar shows, on every signed-in page, each app's latest verdict
-- (src/lib/shell-data.ts, CHE-351). With this index that is one seek per app
-- — the newest finished check of (team, app) — instead of a pass over the
-- team's whole history. Checks that predate their app (appId NULL) sit together
-- under (teamId, NULL) and are found the same way.

CREATE INDEX IF NOT EXISTS "Run_teamId_appId_completedAt_idx" ON "Run"("teamId", "appId", "completedAt");
