import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { RuntimeComponentLocalInfo } from "../src/lib/geoUpdate";
import { extractRuntimeAssetsErrorCode, resolveUnconfiguredRuntimeAssets } from "../src/lib/runtimeAssetsState";
import { downloadProgressPresentation } from "../src/lib/downloadProgressPresentation";
import { formatRuntimeAssetsMessage, formatRuntimeAssetsTitle } from "../src/lib/runtimeComponents";

function local(kind: RuntimeComponentLocalInfo["kind"], sizeBytes = 1024): RuntimeComponentLocalInfo {
  return { kind, exists: true, verified: true, path: `/test-only/runtime/${kind}`, sizeBytes, checksumSha256: "a".repeat(64), versionLabel: null };
}
const missing = { xray: null, geoip: null, geosite: null };
const installed = { xray: local("xray"), geoip: local("geoip"), geosite: local("geosite") };

test("缺少来源及本地组件是未配置状态，不伪造下载失败或可更新版本", () => {
  const result = resolveUnconfiguredRuntimeAssets({ local: missing, xrayVersion: null, geoVersion: null, blocking: false });
  assert.equal(result.ready, false); assert.equal(result.state.phase, "unconfigured");
  assert.equal(result.sourceConfigured, false); assert.equal(result.current, false);
  assert.equal(result.state.errorCode, null); assert.equal(result.state.errorMessage, null);
  assert.equal(result.state.downloadedBytes, 0); assert.equal(result.state.totalBytes, null);
  assert.equal(result.xray.available, false); assert.equal(result.geo.available, false);
  assert.equal(result.xray.current, false); assert.equal(result.geo.current, false);
  assert.equal(formatRuntimeAssetsTitle(result.state), "未配置组件来源");
  assert.match(formatRuntimeAssetsMessage(result.state), /未配置组件来源/);
  assert.deepEqual(downloadProgressPresentation(result.state), { title: "未配置组件来源", amount: "组件未安装", percent: null, percentLabel: null, processing: false, cancelled: false });
});

test("没有远端来源不能废掉已安装组件，也不能声称远端已是最新", () => {
  const result = resolveUnconfiguredRuntimeAssets({ local: installed, xrayVersion: "26.11.9", geoVersion: "20261115", blocking: true });
  assert.equal(result.ready, true); assert.equal(result.state.phase, "ready"); assert.equal(result.state.blocking, false);
  assert.equal(result.xray.localVersion, "26.11.9"); assert.equal(result.geo.localVersion, "20261115");
  assert.equal(result.xray.remoteVersion, null); assert.equal(result.geo.remoteVersion, null);
  assert.equal(result.current, false); assert.equal(result.xray.current, false); assert.equal(result.geo.current, false);
  assert.match(result.state.message!, /继续使用已安装组件/);
});

test("部分安装保留本地版本事实，缺件和零长度文件始终不能作为已就绪", () => {
  for (const localFiles of [{ ...installed, geoip: null }, { ...installed, geosite: local("geosite", 0) }, { ...installed, xray: local("xray", -1) }]) {
    const result = resolveUnconfiguredRuntimeAssets({ local: localFiles, xrayVersion: "26.11.9", geoVersion: "20261115", blocking: true });
    assert.equal(result.ready, false); assert.equal(result.state.phase, "unconfigured"); assert.equal(result.state.blocking, true);
    assert.equal(result.xray.available, false); assert.equal(result.geo.available, false);
  }
  const partial = resolveUnconfiguredRuntimeAssets({ local: { ...missing, xray: installed.xray }, xrayVersion: "26.11.9", geoVersion: null, blocking: false });
  assert.equal(partial.xray.localVersion, "26.11.9"); assert.equal(partial.geo.localVersion, null);
  assert.match(partial.xray.message, /继续使用本地 Xray/); assert.match(partial.geo.message, /未完整安装/);
});

test("物理存在但缺少明确校验通过结论时不能就绪或报告安装版本", () => {
  for (const kind of ["xray", "geoip", "geosite"] as const) {
    for (const verified of [false, undefined]) {
      // Undefined deliberately represents an older/malformed native wire response.
      const unverified = { ...installed[kind], verified } as RuntimeComponentLocalInfo;
      const result = resolveUnconfiguredRuntimeAssets({ local: { ...installed, [kind]: unverified },
        xrayVersion: "invalid-record-label", geoVersion: "cached-invalid-label", blocking: true });
      assert.equal(result.ready, false);
      assert.equal(result.state.phase, "unconfigured");
      assert.equal(result.state.blocking, true);
      assert.equal(result.state.errorCode, null);
      assert.match(result.state.message!, /本地.*校验|安装记录/);
      assert.equal(kind === "xray" ? result.xray.localVersion : result.geo.localVersion, null);
    }
  }
});

test("真实下载失败仍保持失败语义，不因新增配置状态被掩盖", () => {
  const state = resolveUnconfiguredRuntimeAssets({ local: missing, xrayVersion: null, geoVersion: null, blocking: true }).state;
  const actualFailure = downloadProgressPresentation({ ...state, phase: "failed", currentComponent: "xray", errorCode: "download_failed", downloadedBytes: 512 });
  assert.equal(actualFailure.title, "Xray 内核下载未完成"); assert.equal(actualFailure.amount, "请重试或查看详情");
});

test("生产hook在任何远端计划读取前处理配置前置条件，UI不提供虚假重新下载", () => {
  const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
  const hook = read("hooks/useRuntimeAssets.ts");
  assert.ok(hook.indexOf("readGitHubReleaseConfiguration();") < hook.indexOf("await fetchGitHubRuntimeComponentsPlan()"));
  assert.match(hook, /setRuntimeAssets\(unavailable\.state\);\s*return unavailable\.ready;/);
  assert.match(read("components/RuntimeAssetsBanner.tsx"), /action=\{failed && onRetry/);
  assert.match(read("components/RuntimeAssetsBanner.tsx"), /state\.phase === "idle" \|\| state\.phase === "ready" \|\| state\.phase === "unconfigured"\) return null/, "未配置只是前置条件，不能渲染下载面板");
  assert.match(read("components/ControlPanel.tsx"), /runtimeAssetsPhase === "unconfigured"\) return "组件未安装"/);
  assert.match(read("lib/appState.ts"), /runtimeAssets\.phase === "unconfigured"\) return "未配置组件来源"/);
  const app = read("App.tsx");
  assert.match(app, /mainLayoutReady && session && bootstrap && runtimeAssets\.phase !== "idle" && runtimeAssets\.phase !== "ready" && runtimeAssets\.phase !== "unconfigured"/, "登录页及未配置来源状态不能留下组件提示的空overlay");
  assert.match(app, /mainLayoutReady && session && bootstrap \? <RuntimeAssetsBanner\b[^>]*\/> : null/, "即使设备级组件状态保留，退出后的登录界面也不显示组件banner");
});

test("应用更新未完成时，组件提示不误报网络下载失败", () => {
  const errorCode = extractRuntimeAssetsErrorCode("Error: mac_update_pending: 发现未完成的应用更新");
  assert.equal(errorCode, "mac_update_pending");
  const state = resolveUnconfiguredRuntimeAssets({ local:missing, xrayVersion:null, geoVersion:null, blocking:false }).state;
  const view = downloadProgressPresentation({ ...state, phase:"failed", errorCode });
  assert.equal(view.title, "组件更新已暂停"); assert.equal(view.amount, "请先完成应用更新");
});
