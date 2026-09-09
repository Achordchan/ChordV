-- R3: 3X-UI 全链路退役（PRD 2.5/2.7）。一次性切换清理：面板时代的节点与其
-- 全部从属行在此清空；用户/订阅/套餐/流量台账完整保留——台账条目的
-- nodeId 置空（SetNull），安全审计事件同理。此后新节点全部经 agent 原生
-- 链路创建。
DELETE FROM "Node";

DROP TABLE "PanelSyncJob";

ALTER TABLE "Node" DROP COLUMN "panelBaseUrl";
ALTER TABLE "Node" DROP COLUMN "panelApiBasePath";
ALTER TABLE "Node" DROP COLUMN "panelUsername";
ALTER TABLE "Node" DROP COLUMN "panelPassword";
ALTER TABLE "Node" DROP COLUMN "panelInboundId";
ALTER TABLE "Node" DROP COLUMN "panelEnabled";
ALTER TABLE "Node" DROP COLUMN "panelStatus";
ALTER TABLE "Node" DROP COLUMN "panelLastSyncedAt";
ALTER TABLE "Node" DROP COLUMN "panelError";

DROP TYPE "XuiPanelStatus";

-- direct 成为唯一控制模式；列保留（agent 协议仍携带 controlMode）。
ALTER TABLE "Node" ALTER COLUMN "controlMode" SET DEFAULT 'direct_primary';
