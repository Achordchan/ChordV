import assert from "node:assert/strict";
import {
  buildAppUpdateCenterItem,
  createDefaultUpdateCenterItems,
  formatUpdateCenterItemMessage
} from "../src/lib/updateCenter.ts";

function testDefaultItems() {
  const items = createDefaultUpdateCenterItems();
  assert.deepEqual(items.map((item) => item.key), ["app", "xray", "geo"]);
}

function testAppItemAvailable() {
  const item = buildAppUpdateCenterItem({
    appVersion: "1.1.7",
    update: {
      hasUpdate: true,
      forceUpgrade: false,
      currentVersion: "1.1.7",
      latestVersion: "1.2.0",
      minimumVersion: "1.0.0",
      title: "发现新版本",
      changelog: [],
      downloadUrl: "https://example.com/app.zip",
      deliveryMode: "desktop_full_replace",
      channel: "stable",
      artifact: null
    } as any,
    hasActionableUpdate: true
  });
  assert.equal(item.status, "available");
  assert.equal(item.canUpdate, true);
  assert.match(formatUpdateCenterItemMessage(item), /1\.2\.0/);
}

function testAppItemCurrent() {
  const item = buildAppUpdateCenterItem({
    appVersion: "1.1.7",
    update: {
      hasUpdate: false,
      forceUpgrade: false,
      currentVersion: "1.1.7",
      latestVersion: "1.1.7",
      minimumVersion: "1.0.0",
      title: "当前已是最新",
      changelog: [],
      downloadUrl: null,
      deliveryMode: "desktop_full_replace",
      channel: "stable",
      artifact: null
    } as any,
    hasActionableUpdate: false
  });
  assert.equal(item.status, "current");
  assert.equal(item.canUpdate, false);
}

function main() {
  testDefaultItems();
  testAppItemAvailable();
  testAppItemCurrent();
  console.log("desktop update center regression checks passed");
}

main();
