-- CHE-441: a report's outcome goes back to its author. The answer is what we
-- found when the check was right; answeredAt is when the author was told.
ALTER TABLE "Feedback" ADD COLUMN "answer" TEXT;
ALTER TABLE "Feedback" ADD COLUMN "answeredAt" DATETIME;
-- When a tick last looked at the row: the tick takes the rows looked at
-- longest ago, so twenty that never settle cannot hide a newer one.
ALTER TABLE "Feedback" ADD COLUMN "checkedAt" DATETIME;
