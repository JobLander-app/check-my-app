-- CHE-428: which ended sign-in the app's people were last mailed about.
ALTER TABLE "App" ADD COLUMN "signedOutToldFor" TEXT;
