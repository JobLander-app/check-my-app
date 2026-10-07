-- CHE-428: a team whose Shopify sign-in ended is told by mail, once per ended
-- sign-in. This names the ended sign-in the app's verdict recipients were last
-- mailed about (src/agent/signed-out.ts, signedOutSendId).

ALTER TABLE "App" ADD COLUMN "sessionEndedTold" TEXT;
