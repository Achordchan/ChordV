-- CreateEnum
CREATE TYPE "NodeControlMode" AS ENUM ('xui_primary', 'shadow_direct', 'direct_primary', 'rollback_pending');

-- CreateEnum
CREATE TYPE "PanelClientSource" AS ENUM ('xui', 'direct');

-- CreateEnum
CREATE TYPE "TrafficSnapshotSource" AS ENUM ('xui', 'direct');

-- CreateEnum
CREATE TYPE "NodeAgentCommandType" AS ENUM ('ENSURE_USER', 'ENABLE_USER', 'DISABLE_USER', 'REMOVE_USER', 'RECONCILE_USERS', 'REFRESH_QUOTA');

-- CreateEnum
CREATE TYPE "NodeAgentJobStatus" AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled');

-- AlterTable
ALTER TABLE "Node"
  ADD COLUMN "controlMode" "NodeControlMode" NOT NULL DEFAULT 'xui_primary',
  ADD COLUMN "controlStatus" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "agentLastSeenAt" TIMESTAMP(3),
  ADD COLUMN "agentConfigRevision" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PanelClientBinding"
  ADD COLUMN "source" "PanelClientSource" NOT NULL DEFAULT 'xui',
  ADD COLUMN "directRevision" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "directDisabledAt" TIMESTAMP(3),
  ADD COLUMN "directDisableWatermarks" JSONB;

-- AlterTable
ALTER TABLE "TrafficSnapshot"
  ADD COLUMN "source" "TrafficSnapshotSource" NOT NULL DEFAULT 'xui',
  ADD COLUMN "counterGeneration" TEXT NOT NULL DEFAULT '0';

-- Add exact byte counters. Float GB fields remain compatibility projections only.
ALTER TABLE "Subscription"
  ADD COLUMN "totalTrafficBytes" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "usedTrafficBytes" BIGINT NOT NULL DEFAULT 0;
UPDATE "Subscription" SET
  "totalTrafficBytes" = ROUND(GREATEST("totalTrafficGb", 0) * 1073741824)::BIGINT,
  "usedTrafficBytes" = ROUND(GREATEST("usedTrafficGb", 0) * 1073741824)::BIGINT;

ALTER TABLE "TrafficLedger" ADD COLUMN "usedTrafficBytes" BIGINT NOT NULL DEFAULT 0;
UPDATE "TrafficLedger" SET "usedTrafficBytes" = ROUND(GREATEST("usedTrafficGb", 0) * 1073741824)::BIGINT;

-- CreateTable
CREATE TABLE "NodeAgent" (
  "id" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "tokenPrefix" TEXT NOT NULL,
  "version" TEXT,
  "status" TEXT NOT NULL DEFAULT 'offline',
  "bootId" TEXT,
  "lastSequence" BIGINT NOT NULL DEFAULT 0,
  "lastAckSequence" BIGINT NOT NULL DEFAULT 0,
  "configRevision" BIGINT NOT NULL DEFAULT 0,
  "queueDepth" INTEGER NOT NULL DEFAULT 0,
  "xrayStatus" TEXT NOT NULL DEFAULT 'unknown',
  "lastSeenAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NodeAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NodeCommandJob" (
  "id" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "agentId" TEXT,
  "commandType" "NodeAgentCommandType" NOT NULL,
  "targetRevision" BIGINT NOT NULL DEFAULT 0,
  "payload" JSONB NOT NULL,
  "status" "NodeAgentJobStatus" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "result" JSONB,
  "lastError" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NodeCommandJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NodeUsageBatch" (
  "id" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "bootId" TEXT NOT NULL,
  "sequence" BIGINT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "sampledAt" TIMESTAMP(3) NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "accountedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NodeUsageBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Node_controlMode_isActive_idx" ON "Node"("controlMode", "isActive");
CREATE INDEX "PanelClientBinding_nodeId_source_status_idx" ON "PanelClientBinding"("nodeId", "source", "status");
CREATE UNIQUE INDEX "NodeAgent_agentId_key" ON "NodeAgent"("agentId");
CREATE UNIQUE INDEX "NodeAgent_tokenHash_key" ON "NodeAgent"("tokenHash");
CREATE INDEX "NodeAgent_nodeId_revokedAt_lastSeenAt_idx" ON "NodeAgent"("nodeId", "revokedAt", "lastSeenAt");
CREATE INDEX "NodeAgent_status_lastSeenAt_idx" ON "NodeAgent"("status", "lastSeenAt");
CREATE UNIQUE INDEX "NodeCommandJob_dedupeKey_key" ON "NodeCommandJob"("dedupeKey");
CREATE INDEX "NodeCommandJob_nodeId_status_nextRunAt_idx" ON "NodeCommandJob"("nodeId", "status", "nextRunAt");
CREATE INDEX "NodeCommandJob_agentId_status_nextRunAt_idx" ON "NodeCommandJob"("agentId", "status", "nextRunAt");
CREATE UNIQUE INDEX "NodeUsageBatch_nodeId_bootId_sequence_key" ON "NodeUsageBatch"("nodeId", "bootId", "sequence");
CREATE INDEX "NodeUsageBatch_agentId_bootId_sequence_idx" ON "NodeUsageBatch"("agentId", "bootId", "sequence");
CREATE INDEX "NodeUsageBatch_nodeId_accountedAt_sampledAt_idx" ON "NodeUsageBatch"("nodeId", "accountedAt", "sampledAt");

-- AddForeignKey
ALTER TABLE "NodeAgent" ADD CONSTRAINT "NodeAgent_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NodeCommandJob" ADD CONSTRAINT "NodeCommandJob_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NodeCommandJob" ADD CONSTRAINT "NodeCommandJob_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "NodeAgent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NodeUsageBatch" ADD CONSTRAINT "NodeUsageBatch_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NodeUsageBatch" ADD CONSTRAINT "NodeUsageBatch_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "NodeAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
