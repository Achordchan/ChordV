-- 客户端最近在线记录：每位用户一条，记录本次在线开始时间与最近在线时间。
-- CreateTable
CREATE TABLE "UserClientPresence" (
    "userId" TEXT NOT NULL,
    "onlineSince" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserClientPresence_pkey" PRIMARY KEY ("userId")
);

-- 当前保持着的客户端推送连接：每个 API 进程、每位用户一条。
-- CreateTable
CREATE TABLE "UserClientPresenceStream" (
    "userId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserClientPresenceStream_pkey" PRIMARY KEY ("userId","instanceId")
);

-- CreateIndex
CREATE INDEX "UserClientPresenceStream_lastSeenAt_idx" ON "UserClientPresenceStream"("lastSeenAt");

-- AddForeignKey
ALTER TABLE "UserClientPresence" ADD CONSTRAINT "UserClientPresence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserClientPresenceStream" ADD CONSTRAINT "UserClientPresenceStream_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 连接时选择的模式；已有连接保持为空。
-- AlterTable
ALTER TABLE "NodeSessionLease" ADD COLUMN "connectionMode" TEXT;

-- 后台在线列表按“活跃且近期有心跳”的连接查询。
-- CreateIndex
CREATE INDEX "NodeSessionLease_status_lastHeartbeatAt_idx" ON "NodeSessionLease"("status", "lastHeartbeatAt");
