import assert from "node:assert/strict";
import ts from "typescript";
import { sumNodeCommandSummaries } from "../src/utils/node-command-summary";
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
assert.match(overviewPage, /后台同步/);
assert.match(overviewPage, /异常节点/);
assert.match(overviewPage, /onOpenTickets: \(\) => void/);
assert.match(overviewPage, /onOpenSyncQueue: \(\) => void/);
assert.ok(
  overviewPage.indexOf("待处理事项") < overviewPage.indexOf("className={styles.metrics}"),
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

const tree = ts.createSourceFile("OverviewPage.tsx", overviewPage, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let attention = "", count = "";
function visit(n: ts.Node) {
  if (ts.isFunctionDeclaration(n) && n.name?.text === "nodeAttention") attention = n.getText(tree);
  if (ts.isVariableDeclaration(n) && n.name.getText(tree) === "queueCount") count = n.initializer!.getText(tree);
  ts.forEachChild(n, visit);
}
visit(tree);
assert.ok(attention && count);
const classify = new Function(ts.transpileModule(attention, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText + ";return nodeAttention;")();
assert.equal(classify(node({})), 2);
assert.equal(classify(node({probeStatus:"offline"})), 0);
assert.equal(classify(node({controlStatus:"offline"})), 0);
assert.equal(classify(node({isActive:false,controlStatus:"offline"})), 3);
assert.equal(classify(node({controlStatus:undefined})), 1);
const queue = new Function("snapshot", "sumNodeCommandSummaries", "return " + count);
const snapshot = {leaseRevocationJobs:["pending","running","failed","completed","cancelled"].map(status=>({status})), nodeCommandQueue:{summaries:{nodes:[{key:"a",total:5},{key:"b",total:7}]}}};
assert.equal(queue(snapshot,sumNodeCommandSummaries),15,"只统计可处理撤销任务，并使用节点命令精确聚合");
console.log("admin overview page regression checks passed");
