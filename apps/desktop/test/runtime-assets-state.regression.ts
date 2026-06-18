import assert from "node:assert/strict";
import { resolveRuntimeComponentCandidate } from "../src/lib/runtimeAssetsState";
import type { RuntimeComponentDownloadItem } from "../src/lib/runtimeComponents";

function createComponent(originUrl: string): RuntimeComponentDownloadItem {
  return {
    id: "runtime_xray_windows_x64",
    component: "xray",
    version: "1.0.0",
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

function main() {
  testRuntimeComponentMirrorPrefixSupportsUrlPlaceholder();
  testRuntimeComponentMirrorPrefixMatchesUpdateDownloadRule();
  console.log("desktop runtime assets state regression checks passed");
}

main();
