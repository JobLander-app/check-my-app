-- CHE-315: every Watch carries the team of the App it watches.
--
-- 0032 backfilled Watch.teamId once, but onboarding kept creating watches
-- through a nested write that never stamped it — so every app added since then
-- has a watch with teamId NULL. assertCanAddWatch (src/lib/plans.ts) counts a
-- team's active watches by teamId, which means those watches were invisible to
-- the plan's watch cap. createAppForTeam (src/lib/app-settings.ts) now stamps
-- the team on create; this copies it onto the rows already written, from the
-- App they belong to (a watch's team is its app's team by definition).
--
-- Legacy ownerless watches (appId NULL) are left alone: they have no app to
-- inherit a team from, and NULL is their documented state.

UPDATE "Watch"
SET "teamId" = (SELECT "App"."teamId" FROM "App" WHERE "App"."id" = "Watch"."appId")
WHERE "teamId" IS NULL AND "appId" IS NOT NULL;
