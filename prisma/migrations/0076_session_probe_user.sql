-- CHE-482: a Shopify session is one person's in one team, so a probe line says
-- whose sign-in it looked at. Null on the lines written while a team had one
-- shared session (before 2026-10-14).
ALTER TABLE "SessionProbe" ADD COLUMN "userId" TEXT;
CREATE INDEX "SessionProbe_teamId_userId_at_idx" ON "SessionProbe"("teamId", "userId", "at");
