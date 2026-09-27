-- CHE-322: an app can hold several named test accounts ("admin", "free user").
--
-- App.testEmail / App.testPasswordEnc stay exactly as they are and ARE the
-- account called "default". This table holds only the others, and "default" is
-- never written to it — so there is no backfill: copying the columns in here
-- would leave two stored copies of one password, and the next edit would update
-- one of them. src/lib/test-accounts.ts has the reasoning in full.
--
-- teamId is stamped on every row so a query for a credential says whose it is
-- without joining through App (CHE-256, scripts/verify-tenant-db.ts).

CREATE TABLE "TestAccount" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "appId"       TEXT NOT NULL,
  "teamId"      TEXT NOT NULL,
  -- Normalized lower case; unique per app below.
  "label"       TEXT NOT NULL,
  "email"       TEXT NOT NULL,
  -- Encrypted (src/lib/crypto), never returned by any read path.
  "passwordEnc" TEXT NOT NULL,
  "createdAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   DATETIME NOT NULL,
  CONSTRAINT "TestAccount_appId_fkey" FOREIGN KEY ("appId")
    REFERENCES "App" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TestAccount_teamId_fkey" FOREIGN KEY ("teamId")
    REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TestAccount_appId_label_key" ON "TestAccount" ("appId", "label");
CREATE INDEX "TestAccount_teamId_idx" ON "TestAccount" ("teamId");

-- What a run signs in as: the extras as they were when it was created, JSON
-- [{label, email, passwordEnc}]. Cleared of passwords with testPasswordEnc when
-- a one-off run ends.
ALTER TABLE "Run" ADD COLUMN "testAccounts" TEXT;

-- Which of those accounts an auth endpoint turned away (CHE-100), JSON string[]
-- of labels. credentialsRejected stays the "any of them" flag.
ALTER TABLE "Run" ADD COLUMN "rejectedAccounts" TEXT;
