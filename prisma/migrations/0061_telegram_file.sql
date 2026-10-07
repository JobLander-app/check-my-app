-- CHE-427: a photo the owner sent to @checkmyapp_bot was stored as "<media>"
-- and lost. An incoming file now keeps Telegram's file id, which field it came
-- in, and the R2 key of the copy the webhook made (src/lib/telegram.ts).

ALTER TABLE "TelegramMessage" ADD COLUMN "fileId" TEXT;
ALTER TABLE "TelegramMessage" ADD COLUMN "fileKind" TEXT;
ALTER TABLE "TelegramMessage" ADD COLUMN "fileKey" TEXT;
