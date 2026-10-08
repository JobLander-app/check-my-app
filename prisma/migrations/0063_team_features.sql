-- CHE-433: what a team has been given beyond its plan (src/lib/team-features.ts).
-- Replaces the SESSION_TEAMS env list: the two teams it named get "shopify".

ALTER TABLE "Team" ADD COLUMN "features" TEXT;

UPDATE "Team" SET "features" = '["shopify"]'
  WHERE "id" IN ('team_cmt63nqx60000xm1op5202kif', 'team_cmumxo96y0000x31oqtgy50to');
