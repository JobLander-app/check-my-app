-- CHE-369: the repository an app is deployed from is the app's own setting,
-- one per app (owner, 2026-10-06). The index makes it a fact rather than a
-- habit of the one writer (saveAppRepo, which clears the app's old repository
-- before linking the new one). SQLite lets any number of NULLs share a unique
-- column, so unmapped repositories are unaffected. Prod held 0 GitHubRepo rows
-- when this was written (2026-10-06), so no existing pair can collide.
CREATE UNIQUE INDEX "GitHubRepo_appId_key" ON "GitHubRepo"("appId");
