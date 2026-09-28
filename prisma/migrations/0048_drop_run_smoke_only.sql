-- Run.smokeOnly (CHE-106) marked a run downgraded to a smoke pass because the
-- app's daily agent budget was spent. CHE-327 replaced that budget with the
-- team's dollar balance; #194 stopped writing and reading the column and #196
-- took it out of the Prisma schema. It could not go in the same change: CI
-- migrates before it deploys the workers, and the worker still running then
-- selected every Run column. #196 is deployed (01e738a), so no live client
-- selects it any more.
ALTER TABLE "Run" DROP COLUMN "smokeOnly";
