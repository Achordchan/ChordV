import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

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
assert.match(app, /onOpenSyncQueue=\{\(\) => openPanelSyncQueue\(\)\}/);

console.log("admin overview page regression checks passed");
