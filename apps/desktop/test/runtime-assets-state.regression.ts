import assert from "node:assert/strict";
import { normalizeRuntimeAssetsDownloadedBytes, normalizeRuntimeAssetsProgress, resolveRuntimeComponentCandidate } from "../src/lib/runtimeAssetsState";
import { createIdleRuntimeAssetsState, formatRuntimeAssetsTitle, type RuntimeComponentDownloadItem } from "../src/lib/runtimeComponents";

function createComponent(originUrl: string): RuntimeComponentDownloadItem {
  return {
    id: "runtime_xray_windows_x64",
    revision: null,
    versionLabel: null,
    component: "xray",
    fileName: "xray.zip",
    fileSizeBytes: null,
    sourceFormat: "direct",
    archiveEntryName: null,
    checksumSha256: null,
    selectedUrl: originUrl,
    displayName: "Xray",
    candidates: [
      {
        label: "Origin",
        source: "origin",
        url: originUrl
      }
    ]
  };
}

function testRuntimeComponentMirrorPrefixSupportsUrlPlaceholder() {
  const component = createComponent("https://v.baymaxgroup.com/runtime/xray.zip");
  const candidate = resolveRuntimeComponentCandidate(component, "https://mirror.example.com/fetch?url={url}");

  assert.equal(candidate?.source, "client_override");
  assert.equal(candidate?.url, "https://mirror.example.com/fetch?url=https://v.baymaxgroup.com/runtime/xray.zip");
}

function testRuntimeComponentMirrorPrefixMatchesUpdateDownloadRule() {
  const component = createComponent("/runtime/xray.zip");
  const candidate = resolveRuntimeComponentCandidate(component, "https://mirror.example.com");

  assert.equal(candidate?.source, "client_override");
  assert.equal(candidate?.url, "https://mirror.example.com/runtime/xray.zip");
}

function testRuntimeComponentRetryResetsProgress() {
  assert.equal(normalizeRuntimeAssetsDownloadedBytes(10_472_922, 0, "downloading"), 0);
  assert.equal(normalizeRuntimeAssetsDownloadedBytes(5_000_000, 2_000_000, "downloading"), 5_000_000);
  assert.equal(normalizeRuntimeAssetsDownloadedBytes(5_000_000, 0, "failed"), 5_000_000);
}

function testOptionalUpdateProgressStaysNonBlocking() {
  const initial = {
    ...createIdleRuntimeAssetsState(),
    phase: "downloading" as const,
    currentComponent: "xray" as const,
    blocking: false
  };
  const failed = normalizeRuntimeAssetsProgress(initial, {
    phase: "failed",
    component: "xray",
    fileName: "Xray-windows-64.zip",
    downloadedBytes: 1024,
    totalBytes: 2048,
    message: "下载已取消"
  });
  assert.equal(failed.blocking, false);
  assert.equal(formatRuntimeAssetsTitle(failed), "组件更新未完成");
}

function main() {
  testRuntimeComponentMirrorPrefixSupportsUrlPlaceholder();
  testRuntimeComponentMirrorPrefixMatchesUpdateDownloadRule();
  testRuntimeComponentRetryResetsProgress();
  testOptionalUpdateProgressStaysNonBlocking();
  console.log("desktop runtime assets state regression checks passed");
}

main();
