-- CHE-426: one browser per team on the session host. A slot is one Chrome
-- there (its own OS user, profile and DevTools port — spikes/shopify-session);
-- a team holds at most one, and a slot at most one team. "main" is the browser
-- the host had before slots, ours (the Securify admin app lives in it).
CREATE TABLE "SessionSlot" (
    "slot" TEXT NOT NULL PRIMARY KEY,
    "teamId" TEXT,
    "assignedAt" DATETIME
);
-- No foreign key to Team: the seed below names our team by id, and a fresh
-- database (the guards' real D1) has no such row.
CREATE UNIQUE INDEX "SessionSlot_teamId_key" ON "SessionSlot"("teamId");

-- The slots the host is provisioned with (SLOTS=3 → 1, 2, 3); "main" is ours.
INSERT INTO "SessionSlot" ("slot", "teamId", "assignedAt") VALUES ('main', 'team_cmt63nqx60000xm1op5202kif', CURRENT_TIMESTAMP);
INSERT INTO "SessionSlot" ("slot", "teamId", "assignedAt") VALUES ('1', NULL, NULL);
INSERT INTO "SessionSlot" ("slot", "teamId", "assignedAt") VALUES ('2', NULL, NULL);
INSERT INTO "SessionSlot" ("slot", "teamId", "assignedAt") VALUES ('3', NULL, NULL);
