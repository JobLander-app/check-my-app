-- CHE-420: a journey whose last walk left a step of ours unverified
-- (unverifiedReason = 'our_capability') is a record of our gap, not coverage of
-- the product. The catalog now says so, so the verdict neither carries it as
-- green nor lists it. Existing rows are set from the walk they point at.

ALTER TABLE "AppJourney" ADD COLUMN "lastWalkGap" BOOLEAN NOT NULL DEFAULT false;

UPDATE "AppJourney" SET "lastWalkGap" = 1
  WHERE EXISTS (
    SELECT 1 FROM "Journey" j
      JOIN "Step" s ON s."journeyId" = j."id"
     WHERE j."runId" = "AppJourney"."lastWalkedRunId"
       AND j."appJourneyId" = "AppJourney"."id"
       AND j."carriedFromRunId" IS NULL
       AND s."unverifiedReason" = 'our_capability'
  );
