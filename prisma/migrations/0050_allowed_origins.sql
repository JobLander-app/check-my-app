-- CHE-373: an app embedded in another product's page (a Shopify app inside
-- admin.shopify.com, rendered in an iframe from its own origin) lives on two
-- origins. App.allowedOrigins names the extra ones a check may navigate to and
-- act on; Run.allowedOrigins is the copy a run was created with, like
-- scopeHints. JSON array of https origins; NULL = the target's origin only,
-- which is every existing row.
--
-- Numbered 0050, not 0049: 0049 is being added concurrently (store password).
-- wrangler applies migrations by name, so the order the two merge in does not
-- matter, and adding a nullable column is safe under the worker still running
-- when CI migrates before deploying.
ALTER TABLE "App" ADD COLUMN "allowedOrigins" TEXT;
ALTER TABLE "Run" ADD COLUMN "allowedOrigins" TEXT;
