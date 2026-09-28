-- CHE-327: one currency — a dollar balance. Every plan puts a credit on the
-- team's balance each UTC month (Free: $3, once), every check has its own price
-- (what it cost us × the plan's multiplier, src/lib/plans.ts), and a team can
-- top the balance up.
--
-- Run.priceUsd is what a check was priced at; the balance is a sum over the
-- rows, so the rows that already exist are priced here with the same rule
-- priceRun applies from now on — otherwise every team's spending would read
-- zero on deploy day and every Free team would get its credit again:
--
--   a team's finished run (completed / partial):  round(costUsd × multiplier, 2)
--   a team's failed or canceled run:              0   (our failure is free)
--   a run still in flight:                        NULL (priced when it ends)
--   an anonymous run:                             NULL (belongs to no balance)
--
-- The multipliers below are PLAN_LIMITS[plan].priceMultiplier as of this
-- migration, written out because SQL cannot import them; the team's current
-- plan prices its history, which is what the balance reads anyway.
--
-- Nobody is refused on deploy day by this: measured before the change
-- (2026-09-28), the busiest team (Business, $499 credit) had spent $28.12 of
-- cost this month — $56.24 at its multiplier — and the one paid Growth team
-- had no runs.

ALTER TABLE "Run" ADD COLUMN "priceUsd" REAL;
ALTER TABLE "Run" ADD COLUMN "priceFromTopupUsd" REAL NOT NULL DEFAULT 0;
-- A quick check's work, said next to its price: how many pages it opened.
ALTER TABLE "Run" ADD COLUMN "quickPagesOpened" INTEGER;
-- Which door started a check (watch / mcp / api / ui / anon), so the one
-- balance can be read by what it is spent on. Internal; NULL on older rows.
ALTER TABLE "Run" ADD COLUMN "startedVia" TEXT;

UPDATE "Run"
SET "priceUsd" = CASE
  WHEN "status" IN ('failed', 'canceled') THEN 0
  ELSE round(coalesce("costUsd", 0) * (
    SELECT CASE t."plan"
      WHEN 'free' THEN 3
      WHEN 'starter' THEN 3
      WHEN 'growth' THEN 2.5
      WHEN 'business' THEN 2
      ELSE 2
    END
    FROM "Team" t WHERE t."id" = "Run"."teamId"
  ), 2)
END
WHERE "teamId" IS NOT NULL
  AND "status" IN ('completed', 'partial', 'failed', 'canceled');

CREATE INDEX "Run_teamId_createdAt_idx" ON "Run" ("teamId", "createdAt");

ALTER TABLE "Team" ADD COLUMN "topupUsd" REAL NOT NULL DEFAULT 0;
ALTER TABLE "Team" ADD COLUMN "balanceNoticeSentAt" DATETIME;

CREATE TABLE "BalanceTopUp" (
  "id"                TEXT PRIMARY KEY NOT NULL,
  "checkoutSessionId" TEXT NOT NULL,
  "teamId"            TEXT NOT NULL,
  "amountUsd"         REAL NOT NULL,
  "credited"          BOOLEAN NOT NULL DEFAULT false,
  "createdAt"         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BalanceTopUp_teamId_fkey" FOREIGN KEY ("teamId")
    REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "BalanceTopUp_checkoutSessionId_key" ON "BalanceTopUp" ("checkoutSessionId");
CREATE INDEX "BalanceTopUp_teamId_idx" ON "BalanceTopUp" ("teamId");
