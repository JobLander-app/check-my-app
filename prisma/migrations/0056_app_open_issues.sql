-- CHE-399: the number beside Issues in the menu and the Issues page count the
-- same thing from one stored figure. Written where it changes (a check
-- finishing, a mark, a ticket's state — src/lib/open-issues.ts); null until the
-- first of those for an app, and the sidebar counts for itself meanwhile.
-- The version is bumped by every write, so a recount that read an older
-- state than the one on the row does not land last.
ALTER TABLE "App" ADD COLUMN "openIssues" INTEGER;
ALTER TABLE "App" ADD COLUMN "openIssuesVersion" INTEGER NOT NULL DEFAULT 0;
