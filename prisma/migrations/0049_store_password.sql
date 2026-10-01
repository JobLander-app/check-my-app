-- CHE-372: a store password is an access input, like a test login.
--
-- A password-protected Shopify store redirects every storefront page to
-- /password ("Enter store password"). Runs #281–#283 stopped there and, since
-- CHE-365, come back Not verified. The store password is what lets a check
-- past that page, so it is stored the way the test password is: encrypted
-- (src/lib/crypto), on the App, mirrored onto its Watch, copied onto every Run
-- and cleared from a one-off run when it ends (clearedCredentials). The
-- PendingCheck of a paid one-off check parks it encrypted while the visitor
-- pays, and drops it the moment the run exists.

ALTER TABLE "App" ADD COLUMN "storePasswordEnc" TEXT;
ALTER TABLE "Watch" ADD COLUMN "storePasswordEnc" TEXT;
ALTER TABLE "Run" ADD COLUMN "storePasswordEnc" TEXT;
ALTER TABLE "PendingCheck" ADD COLUMN "storePasswordEnc" TEXT;

-- The store's password page turned the password away. One attempt per run,
-- like Run.credentialsRejected (CHE-100): once set, no later phase submits it.
ALTER TABLE "Run" ADD COLUMN "storePasswordRejected" BOOLEAN NOT NULL DEFAULT false;
