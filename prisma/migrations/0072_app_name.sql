-- CHE-457: an app has a name of its own, apart from its address key.
ALTER TABLE "App" ADD COLUMN "name" TEXT;
