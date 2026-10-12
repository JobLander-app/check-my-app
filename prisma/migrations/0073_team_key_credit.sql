-- CHE-458: a team's own OpenRouter key with no credit pauses its checks, and says so.
ALTER TABLE "Team" ADD COLUMN "openrouterKeyNoCreditAt" DATETIME;
ALTER TABLE "Team" ADD COLUMN "openrouterKeyCheckedAt" DATETIME;
