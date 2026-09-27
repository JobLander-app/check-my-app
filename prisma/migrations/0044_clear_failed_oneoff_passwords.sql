-- A one-off run keeps its test password only while it runs (Run model
-- comment; the home form says "deleted after the run"). The workflow cleared
-- it only on the success path, so every one-off run that FAILED kept the
-- encrypted password indefinitely — 15 such rows in production on 2026-09-27,
-- plus 5 completed one-off runs from 2026-08-27..30 that predate or skipped
-- the cleanup step. The workflow now clears it on failure too; this removes
-- what was left behind.
--
-- Only terminal runs with no watch: a watch run keeps its credentials for the
-- next tick, and a run still in flight still needs its password. Saved apps
-- keep their own copy on App.testPasswordEnc, which this does not touch.
UPDATE "Run"
SET "testPasswordEnc" = NULL
WHERE "testPasswordEnc" IS NOT NULL
  AND "watchId" IS NULL
  AND "status" IN ('completed', 'partial', 'failed', 'canceled');
