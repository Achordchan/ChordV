import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { AdminNodeRecordDto } from "@chordv/shared";
import { compactNodeStatus } from "../src/utils/node-status";

const adminRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function read(path: string) {
  return readFileSync(path, "utf8");
}

const overviewPage = read(join(adminRoot, "src", "pages", "OverviewPage.tsx"));
const app = read(join(adminRoot, "src", "App.tsx"));

assert.match(overviewPage, /待处理事项/);
assert.match(overviewPage, /待回复工单/);
assert.match(overviewPage, /后台同步任务/);
assert.match(overviewPage, /异常节点/);
assert.match(overviewPage, /onOpenTickets: \(\) => void/);
assert.match(overviewPage, /onOpenSyncQueue: \(\) => void/);
assert.ok(
  overviewPage.indexOf("待处理事项") < overviewPage.indexOf("用户数"),
  "overview should show actionable work before passive metrics"
);
assert.match(app, /onOpenTickets=\{\(\) => selectSection\("tickets"\)\}/);
assert.match(app, /onOpenSyncQueue=\{\(\) => openLeaseRevocationQueue\(\)\}/);

// The badge must not hide an unhealthy agent behind a healthy TCP probe: the
// control connection is what can act on the node, and the overview's
// abnormal-node count already treats that combination as abnormal. Whichever
// signal is unhealthy wins.
function node(overrides: Partial<AdminNodeRecordDto>): AdminNodeRecordDto {
  return {
    isActive: true,
    probeStatus: "healthy",
    controlStatus: "online",
    ...overrides
  } as unknown as AdminNodeRecordDto;
}

assert.deepEqual(compactNodeStatus(node({})), { color: "green", label: "Agent 在线" });
assert.deepEqual(
  compactNodeStatus(node({ controlStatus: "offline", probeStatus: "healthy" })),
  { color: "red", label: "Agent 离线" },
  "Agent 离线时不得显示为健康探测"
);
assert.deepEqual(
  compactNodeStatus(node({ controlStatus: "degraded", probeStatus: "healthy" })),
  { color: "yellow", label: "Agent 异常" },
  "Agent 异常时不得显示为健康探测"
);
assert.deepEqual(
  compactNodeStatus(node({ probeStatus: "offline" })),
  { color: "red", label: "离线" },
  "Agent 在线但探测失败时必须显示探测异常"
);
assert.deepEqual(compactNodeStatus(node({ isActive: false })), { color: "gray", label: "已禁用" });
assert.deepEqual(
  compactNodeStatus(node({ controlStatus: undefined })),
  { color: "gray", label: "Agent 等待心跳" },
  "从未上报的节点按等待心跳展示"
);
assert.match(overviewPage, /from "\.\.\/utils\/node-status"/, "概览页必须使用共享的节点状态判定");

console.log("admin overview page regression checks passed");
