-- 新版客户端最近一次主动上报在线的时间；旧客户端不上报，已有记录保持为空。
-- AlterTable
ALTER TABLE "UserClientPresence" ADD COLUMN "lastPingAt" TIMESTAMP(3);
