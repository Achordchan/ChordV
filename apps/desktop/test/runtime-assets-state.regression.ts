import { githubTransportUrls } from "../src/lib/githubReleaseSource";
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

function testComponentUsesControlledSignedCandidates() {
  const origin = "https://github.com/fixture/releases/releases/download/v2.0.0/xray.zip";
  const component = createComponent(origin);
  const urls = githubTransportUrls(origin, { repository: "fixture/releases", publicKey: "test-only-pinned-key" });
  component.candidates = urls.map(url => ({ label: url === origin ? "GitHub" : "GitHub 加速", source: url === origin ? "origin" : "mirror", url }));
  component.selectedUrl = urls[0];
  assert.deepEqual(resolveRuntimeComponentCandidate(component), { url: `https://ghfast.top/${origin}`, source: "mirror" });
  component.selectedUrl = "not-in-the-verified-plan";
  assert.equal(resolveRuntimeComponentCandidate(component)?.url, component.candidates[0].url);
  assert.equal(resolveRuntimeComponentCandidate({ ...component, candidates: [] }), null);
}

function testComponentWithoutSigningKeyUsesDirectGitHub() {
  const origin = "https://github.com/fixture/releases/releases/download/v2.0.0/xray.zip";
  const urls = githubTransportUrls(origin, { repository: "fixture/releases", publicKey: "" });
  assert.deepEqual(urls, [origin]);
  assert.deepEqual(resolveRuntimeComponentCandidate(createComponent(origin)), { url: origin, source: "origin" });
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
  testComponentUsesControlledSignedCandidates();
  testComponentWithoutSigningKeyUsesDirectGitHub();
  testRuntimeComponentRetryResetsProgress();
  testOptionalUpdateProgressStaysNonBlocking();
  console.log("desktop runtime assets state regression checks passed");
}

main();
