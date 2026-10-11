-- CHE-435 / CHE-434 B: a team edits the app's scenarios. A team scenario is an
-- AppJourney the team wrote; a daily one is in every check's focus.
ALTER TABLE "AppJourney" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'discovered';
ALTER TABLE "AppJourney" ADD COLUMN "description" TEXT;
ALTER TABLE "AppJourney" ADD COLUMN "daily" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "AppJourney" ADD COLUMN "authorId" TEXT;
