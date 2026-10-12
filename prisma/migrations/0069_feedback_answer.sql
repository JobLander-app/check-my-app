-- CHE-441: a report's outcome goes back to its author. The answer is what we
-- found when the check was right; answeredAt is when the author was told.
ALTER TABLE "Feedback" ADD COLUMN "answer" TEXT;
ALTER TABLE "Feedback" ADD COLUMN "answeredAt" DATETIME;
