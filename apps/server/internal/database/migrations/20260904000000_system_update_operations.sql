-- CreateEnum
CREATE TYPE "SystemUpdateOperationKind" AS ENUM ('update', 'rollback', 'restart');

-- CreateEnum
CREATE TYPE "SystemUpdateOperationStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'rolled_back');

-- CreateTable
CREATE TABLE "SystemUpdateOperation" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "kind" "SystemUpdateOperationKind" NOT NULL,
    "status" "SystemUpdateOperationStatus" NOT NULL DEFAULT 'pending',
    "actorUserId" TEXT,
    "actorLabel" TEXT,
    "fromVersion" TEXT,
    "toVersion" TEXT,
    "failureReason" TEXT,
    "migrationApplied" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemUpdateOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SystemUpdateOperation_operationId_key" ON "SystemUpdateOperation"("operationId");

-- CreateIndex
CREATE INDEX "SystemUpdateOperation_status_startedAt_idx" ON "SystemUpdateOperation"("status", "startedAt");

-- CreateIndex
CREATE INDEX "SystemUpdateOperation_startedAt_idx" ON "SystemUpdateOperation"("startedAt");
