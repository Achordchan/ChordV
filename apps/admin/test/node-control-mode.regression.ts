import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  agentStatusColor,
  nodeControlModeColor,
  translateAgentStatus,
  translateNodeControlMode,
  translateXrayStatus
} from "../src/utils/admin-translate";

const nodesPageSource = readFileSync(resolve(import.meta.dirname, "../src/pages/NodesPage.tsx"), "utf8");
const nodeEditorSource = readFileSync(resolve(import.meta.dirname, "../src/features/editors/NodeEditorSection.tsx"), "utf8");
const nodeControlSource = readFileSync(resolve(import.meta.dirname, "../src/features/nodes/NodeControlCenter.tsx"), "utf8");
const nodesApiSource = readFileSync(resolve(import.meta.dirname, "../src/api/nodes.ts"), "utf8");
const overviewSource = readFileSync(resolve(import.meta.dirname, "../src/pages/OverviewPage.tsx"), "utf8");

assert.equal(translateNodeControlMode("xui_primary"), "3X-UI 主控");
assert.equal(translateNodeControlMode("shadow_direct"), "Agent 影子计量");
assert.equal(translateNodeControlMode("direct_primary"), "Agent 主控");
assert.equal(translateNodeControlMode("rollback_pending"), "回退处理中");
assert.equal(nodeControlModeColor("rollback_pending"), "orange");
assert.equal(translateAgentStatus("online"), "在线");
assert.equal(translateAgentStatus(null), "等待心跳");
assert.equal(agentStatusColor("offline"), "red");
assert.equal(translateXrayStatus("healthy"), "正常");

assert.match(nodesPageSource, /<NodeControlCell node=\{item\} onOpen=/);
assert.match(nodesPageSource, /<NodeControlDrawer/);
assert.match(nodesPageSource, /title="打开节点控制器"/);
assert.match(nodesPageSource, /onSwitchMode=\{props\.onSwitchNodeControlMode\}/);

assert.match(nodeEditorSource, /controlMode === "xui_primary" \? \(/);
assert.match(nodeEditorSource, /控制模式、Agent 健康度和迁移操作请在节点列表的“节点控制器”中管理/);
assert.match(nodeEditorSource, /迁移与回退：保留的 3X-UI 配置/);
assert.match(nodeEditorSource, /<Accordion\.Panel>[\s\S]*?<PanelConfigurationFields/);
assert.doesNotMatch(nodeEditorSource, /function AgentControlOverview/);

assert.match(nodeControlSource, /xui_primary:[\s\S]*3X-UI 是唯一用户写入方和计费来源/);
assert.match(nodeControlSource, /shadow_direct:[\s\S]*Agent 只读采样/);
assert.match(nodeControlSource, /direct_primary:[\s\S]*Agent 是唯一用户写入方和计费来源/);
assert.match(nodeControlSource, /rollback_pending:[\s\S]*人工回退窗口/);
assert.match(nodeControlSource, /lastAckSequence[\s\S]*lastSequence/);
assert.match(nodeControlSource, /queueDepth/);
assert.match(nodeControlSource, /configRevision/);
assert.match(nodeControlSource, /requiresDirectConfirmation: true/);
assert.match(nodeControlSource, /requiresRollbackConfirmation: true/);
assert.match(nodeControlSource, /requiresXuiCalibration: true/);
assert.match(nodeControlSource, /确认 3X-UI 已使用相同 UUID\/email 完成用户校准/);
assert.match(nodesApiSource, /\/admin\/nodes\/\$\{nodeId\}\/control-mode/);

assert.match(overviewSource, /const controlMode = item\.controlMode \?\? "xui_primary";/);
assert.match(overviewSource, /buildNodeControlText\(item\)/);

console.log("node-control-mode.regression.ts passed");
