-- Additive only: existing nodes and their agent identities remain unchanged.
ALTER TABLE "Node" ADD COLUMN "onboardingSpec" JSONB;
