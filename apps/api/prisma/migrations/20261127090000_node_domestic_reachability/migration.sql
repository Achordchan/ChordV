-- Reachability from mainland China, reported by the domestic probe.
ALTER TABLE "Node" ADD COLUMN "domesticStatus" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "Node" ADD COLUMN "domesticLatencyMs" INTEGER;
ALTER TABLE "Node" ADD COLUMN "domesticCheckedAt" TIMESTAMP(3);
ALTER TABLE "Node" ADD COLUMN "domesticFailStreak" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Node" ADD COLUMN "domesticError" TEXT;
ALTER TABLE "Node" ADD COLUMN "domesticScheduledAt" TIMESTAMP(3);
ALTER TABLE "Node" ADD COLUMN "domesticEndpoint" TEXT;
