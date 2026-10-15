-- CHE-482: a Shopify session is one person's in one team, so a probe line says
-- whose sign-in it looked at. Null on the lines written while a team had one
-- shared session (before 2026-10-14).
ALTER TABLE "SessionProbe" ADD COLUMN "userId" TEXT;
CREATE INDEX "SessionProbe_teamId_userId_at_idx" ON "SessionProbe"("teamId", "userId", "at");

-- The slot a Shopify check took its lease in, kept on the run (Codex on #351):
-- a stopped check whose store is removed before the next tick still gives the
-- browser back.
ALTER TABLE "Run" ADD COLUMN "sessionSlot" TEXT;
