import assert from "node:assert/strict";
import {
  basenamePath,
  buildXrayContentKey,
  buildXrayInstalledIdentityFromPlan,
  isXrayIdentityCurrent,
  resolveXrayVersionLabel,
  type XrayInstalledIdentity
} from "../src/lib/xrayInstall.ts";
import type { RuntimeComponentDownloadItem } from "../src/lib/runtimeComponents.ts";

function makeXrayItem(overrides: Partial<RuntimeComponentDownloadItem> = {}): RuntimeComponentDownloadItem {
  return {
    id: "rtcomp_1",
    component: "xray",
    fileName: "Xray-windows-64-v1.8.0.zip",
    fileSizeBytes: 12_000_000,
    sourceFormat: "zip_entry",
    archiveEntryName: "xray.exe",
    checksumSha256: null,
    candidates: [
      {
        label: "origin",
        url: "https://cdn.example.com/xray/v1.8.0/Xray-windows-64-v1.8.0.zip",
        source: "origin"
      }
    ],
    selectedUrl: null,
    displayName: "Xray",
    ...overrides
  };
}

function testBasenameSupportsWindowsPaths() {
  assert.equal(basenamePath("C:\\Users\\a\\xray.exe"), "xray.exe");
  assert.equal(basenamePath("/tmp/runtime/xray"), "xray");
  assert.equal(basenamePath(""), "xray");
}

function testGenericFileNameIsNotVersion() {
  assert.equal(resolveXrayVersionLabel({ fileName: "xray.exe" }), null);
  assert.equal(resolveXrayVersionLabel({ fileName: "Xray-windows-64-v1.8.24.zip" }), "1.8.24");
}

function testSameComponentIdDifferentContentIsNotCurrent() {
  const installed: XrayInstalledIdentity = buildXrayInstalledIdentityFromPlan(
    makeXrayItem({
      fileName: "Xray-windows-64-v1.8.0.zip",
      candidates: [
        {
          label: "origin",
          url: "https://cdn.example.com/xray/v1.8.0/Xray-windows-64-v1.8.0.zip",
          source: "origin"
        }
      ]
    }),
    20_000_000
  );
  const remote = makeXrayItem({
    id: "rtcomp_1",
    fileName: "Xray-windows-64-v1.9.0.zip",
    candidates: [
      {
        label: "origin",
        url: "https://cdn.example.com/xray/v1.9.0/Xray-windows-64-v1.9.0.zip",
        source: "origin"
      }
    ]
  });
  assert.equal(
    isXrayIdentityCurrent(installed, remote, 20_000_000),
    false,
    "same component id with different content must not be treated as current"
  );
  assert.notEqual(buildXrayContentKey(makeXrayItem()), buildXrayContentKey(remote));
}


function testMirrorOnlyChangeStaysCurrent() {
  const item = makeXrayItem({
    selectedUrl: "https://mirror.example.com/xray/v1.8.0/Xray-windows-64-v1.8.0.zip",
    candidates: [
      {
        label: "client_override",
        url: "https://mirror.example.com/xray/v1.8.0/Xray-windows-64-v1.8.0.zip",
        source: "client_override"
      },
      {
        label: "origin",
        url: "https://cdn.example.com/xray/v1.8.0/Xray-windows-64-v1.8.0.zip",
        source: "origin"
      }
    ]
  });
  const installed = buildXrayInstalledIdentityFromPlan(item, 20_000_000);
  const sameContentDifferentMirror = makeXrayItem({
    selectedUrl: "https://other-mirror.example.com/xray/v1.8.0/Xray-windows-64-v1.8.0.zip",
    candidates: [
      {
        label: "server_mirror",
        url: "https://other-mirror.example.com/xray/v1.8.0/Xray-windows-64-v1.8.0.zip",
        source: "server_mirror"
      },
      {
        label: "origin",
        url: "https://cdn.example.com/xray/v1.8.0/Xray-windows-64-v1.8.0.zip",
        source: "origin"
      }
    ]
  });
  assert.equal(
    buildXrayContentKey(item),
    buildXrayContentKey(sameContentDifferentMirror),
    "contentKey must ignore mirror-only URL changes"
  );
  assert.equal(
    isXrayIdentityCurrent(installed, sameContentDifferentMirror, 20_000_000),
    true,
    "mirror-only change must stay current"
  );
}

function testLocalSizeMismatchIsNotCurrent() {
  const item = makeXrayItem();
  const installed = buildXrayInstalledIdentityFromPlan(item, 20_000_000);
  assert.equal(
    isXrayIdentityCurrent(installed, item, 19_000_000),
    false,
    "same contentKey with different local size must not be treated as current"
  );
  assert.equal(
    isXrayIdentityCurrent(installed, item, null),
    false,
    "missing local size must not be treated as current"
  );
}

function testMatchingContentKeyIsCurrent() {
  const item = makeXrayItem();
  const installed = buildXrayInstalledIdentityFromPlan(item, 20_000_000);
  assert.equal(isXrayIdentityCurrent(installed, item, 20_000_000), true);
}

function testLegacyIdOnlyRecordIsNotCurrent() {
  const remote = makeXrayItem();
  const legacy: XrayInstalledIdentity = {
    componentId: "rtcomp_1",
    versionLabel: null,
    fileName: null,
    originUrl: null,
    contentKey: null,
    installedSizeBytes: 20_000_000,
    installedAt: Date.now()
  };
  assert.equal(
    isXrayIdentityCurrent(legacy, remote, 20_000_000),
    false,
    "legacy id-only records must not claim current"
  );
}

function main() {
  testBasenameSupportsWindowsPaths();
  testGenericFileNameIsNotVersion();
  testSameComponentIdDifferentContentIsNotCurrent();
  testMirrorOnlyChangeStaysCurrent();
  testLocalSizeMismatchIsNotCurrent();
  testMatchingContentKeyIsCurrent();
  testLegacyIdOnlyRecordIsNotCurrent();
  console.log("xray install regression checks passed");
}

main();
