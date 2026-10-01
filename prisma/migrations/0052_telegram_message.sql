-- CHE-375: the owner's Telegram chat with @checkmyapp_bot is a production
-- record. Every message in it — what he writes (stored by the webhook at
-- /api/webhooks/telegram) and what we send (scripts/tg-send.ts) — is a row here.
--
-- Operator data, not a team's: no teamId. updateId is Telegram's update_id as
-- text and is unique, because Telegram retries a delivery until it is
-- acknowledged; it is NULL for a message we sent (SQLite allows many NULLs
-- under a unique index).

CREATE TABLE "TelegramMessage" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "updateId"    TEXT,
  "messageId"   TEXT,
  "chatId"      TEXT NOT NULL,
  "direction"   TEXT NOT NULL,
  "fromName"    TEXT,
  "text"        TEXT NOT NULL,
  "replyToText" TEXT,
  "edited"      BOOLEAN NOT NULL DEFAULT false,
  "sentAt"      DATETIME NOT NULL,
  "createdAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "TelegramMessage_updateId_key" ON "TelegramMessage" ("updateId");
CREATE INDEX "TelegramMessage_chatId_createdAt_idx" ON "TelegramMessage" ("chatId", "createdAt");
