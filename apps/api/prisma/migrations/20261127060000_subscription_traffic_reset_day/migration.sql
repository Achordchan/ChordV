-- 每月流量重置日：只新增可空列与索引。老订阅保持为空（不自动重置），由管理员逐个设置。
-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN "trafficResetDay" INTEGER,
ADD COLUMN "nextTrafficResetAt" TIMESTAMP(3),
ADD COLUMN "lastTrafficAutoResetAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Subscription_nextTrafficResetAt_idx" ON "Subscription"("nextTrafficResetAt");
