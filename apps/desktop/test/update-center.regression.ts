import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildAppUpdateCenterItem,
  createDefaultUpdateCenterItems,
  formatUpdateCenterItemMessage
} from "../src/lib/updateCenter.ts";
import { cleanChangelogItem } from "../src/lib/updateState.ts";
import { formatVersionWithBuild, parseBuildNumber } from "../src/lib/buildInfo.ts";
import { hasActionableUpdate } from "../src/hooks/useUpdateFlow.ts";

function testChangelogDropsGithubAttribution() {
  assert.equal(cleanChangelogItem("修复客户端更新缓存与异常下载残留清理 by @Achordchan in #59"), "修复客户端更新缓存与异常下载残留清理");
  assert.equal(cleanChangelogItem("chore: 发布后台 0.0.22 by @dependabot[bot] in https://github.com/Achordchan/ChordV/pull/63"), "chore: 发布后台 0.0.22");
  assert.equal(cleanChangelogItem("  支持 by 关键字的规则  "), "支持 by 关键字的规则", "only the trailing attribution is removed");
}

function testReleaseHistoryEntry() {
  const modal = readFileSync(new URL("../src/components/UpdateCenterModal.tsx", import.meta.url), "utf8");
  const history = readFileSync(new URL("../src/components/ReleaseHistory.tsx", import.meta.url), "utf8");
  const client = readFileSync(new URL("../src/api/client.ts", import.meta.url), "utf8");
  assert.match(modal, /查看更新日志/);
  assert.match(modal, /<ReleaseHistory channel=\{props\.betaChannel \? "beta" : "stable"\}/, "history follows the update channel");
  assert.match(history, /cleanChangelogItem/, "history strips GitHub attribution like the update dialog");
  assert.match(client, /\/client\/releases\/history\?/);
  assert.match(client, /fetchReleaseHistory[\s\S]*?isApiStatusError\(reason, 404, 405\)\) \{\s*return null;/, "older servers degrade to an explanatory message");
}

function testSameVersionBuilds() {
  const update = { hasUpdate: true, forceUpgrade: false, currentVersion: "1.1.10", latestVersion: "1.1.10", latestBuild: 42, minimumVersion: "0.0.0" } as any;
  assert.equal(hasActionableUpdate(update, "1.1.10", 41), true, "a newer build of the installed version is an update");
  assert.equal(hasActionableUpdate(update, "1.1.10", 42), false, "the installed build is not offered again");
  assert.equal(hasActionableUpdate(update, "1.1.10", null), false, "without a local build only versions count");
  assert.equal(hasActionableUpdate({ ...update, latestBuild: null }, "1.1.10", 41), false);
  assert.equal(hasActionableUpdate({ ...update, latestVersion: "1.1.10" }, "1.1.9", null), true, "1.1.9 still moves to 1.1.10");
  assert.equal(parseBuildNumber("42"), 42);
  assert.equal(parseBuildNumber(""), null);
  assert.equal(parseBuildNumber("0"), null);
  assert.equal(formatVersionWithBuild("1.1.10", 42), "1.1.10 · 构建 42");
  assert.equal(formatVersionWithBuild("1.1.10", null), "1.1.10");
  const item = buildAppUpdateCenterItem({ appVersion: "1.1.10", update, hasActionableUpdate: true });
  assert.equal(item.remoteVersion, "1.1.10 · 构建 42", "same-version updates are labelled by build");
}

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
  testChangelogDropsGithubAttribution();
  testReleaseHistoryEntry();
  testSameVersionBuilds();
  console.log("desktop update center regression checks passed");
}

main();
