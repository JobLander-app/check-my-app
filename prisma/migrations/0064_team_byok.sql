-- CHE-436: a team that brings its own OpenRouter key pays the model from their
-- account; their checks are free on our balance (price $0). The key is stored
-- encrypted like test credentials (AES-256-GCM via src/lib/crypto.ts) and
-- copied onto the Run row when the run is created, so the agent worker can
-- decrypt and use it without reading from the web worker's D1.

ALTER TABLE "Team" ADD COLUMN "openrouterKeyEnc" TEXT;
ALTER TABLE "Run"  ADD COLUMN "byokKeyEnc" TEXT;
