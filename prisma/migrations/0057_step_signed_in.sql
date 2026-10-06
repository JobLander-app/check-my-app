-- CHE-393: the walk records, per step, whether it ran signed in — read at the
-- moment the step is reported, from where the walk stands (a person's session,
-- a test account it signed in as and was not turned away, a sign-out control on
-- the page), not inferred afterwards from a credential placeholder in the
-- recorded actions. NULL on rows written before the column; the Release lens
-- and Issues fall back to the old inference for those.
--
-- Adding a nullable column is safe under the worker still running when CI
-- migrates before deploying.
ALTER TABLE "Step" ADD COLUMN "signedIn" BOOLEAN;
