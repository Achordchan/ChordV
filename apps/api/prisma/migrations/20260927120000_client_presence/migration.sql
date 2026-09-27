-- 客户端在线状态：由已登录客户端的事件推送连接维护，每位用户一条。
-- CreateTable
CREATE TABLE "UserClientPresence" (
    "userId" TEXT NOT NULL,
    "online" BOOLEAN NOT NULL DEFAULT false,
    "onlineSince" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserClientPresence_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "UserClientPresence" ADD CONSTRAINT "UserClientPresence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 连接时选择的模式；已有连接保持为空。
-- AlterTable
ALTER TABLE "NodeSessionLease" ADD COLUMN "connectionMode" TEXT;

-- 后台在线列表按“活跃且近期有心跳”的连接查询。
-- CreateIndex
CREATE INDEX "NodeSessionLease_status_lastHeartbeatAt_idx" ON "NodeSessionLease"("status", "lastHeartbeatAt");
