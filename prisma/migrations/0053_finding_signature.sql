-- CHE-354: one problem keeps one identity across checks, even when its title is
-- reworded.
--
-- meetbashar.com reported one dead YouTube video in seven checks under seven
-- titles, its severity flipping between high and medium. The ticket key hashes
-- title + severity when no request is named, so nothing could say "this has
-- been here for seven checks". `signature` is that identity, built from what
-- does not get reworded (src/lib/finding-signature.ts) and written with every
-- finding by the agent.
--
-- Nullable, no default: rows written before this column are filled by
-- scripts/backfill-finding-signature.ts, and src/lib/recurring.ts computes the
-- value itself for any row still NULL, so nothing depends on the backfill
-- having run.

ALTER TABLE "Finding" ADD COLUMN "signature" TEXT;

CREATE INDEX "Finding_signature_idx" ON "Finding" ("signature");
