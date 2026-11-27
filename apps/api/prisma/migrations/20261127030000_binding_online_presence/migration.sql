-- 订阅链接（第三方客户端）在线状态：节点 Agent 心跳上报 Xray 在线账号，记在节点账号绑定上。只新增可空列与索引。
-- AlterTable
ALTER TABLE "PanelClientBinding" ADD COLUMN "directOnlineSince" TIMESTAMP(3),
ADD COLUMN "directLastOnlineAt" TIMESTAMP(3),
ADD COLUMN "directOnlineIpCount" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "PanelClientBinding_directLastOnlineAt_idx" ON "PanelClientBinding"("directLastOnlineAt");
