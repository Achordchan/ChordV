import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildExternalArtifactPayload } from "../src/features/releases/artifactPayloads";
import { buildCreateReleasePayload, buildUpdateReleasePayload, emptyReleaseEditorForm } from "../src/features/releases/types";

const releaseRecordCardSource = readFileSync(resolve(import.meta.dirname, "../src/features/releases/ReleaseRecordCard.tsx"), "utf8");

function testCreateReleasePayloadKeepsReleaseFieldsSimple() {
  const form = {
    ...emptyReleaseEditorForm("windows"),
    version: " 1.2.0 ",
    title: "  Windows 1.2.0  ",
    changelog: "Support release publishing\n\nFix admin release flow"
  };

  const payload = buildCreateReleasePayload(form);

  assert.deepEqual(payload, {
    platform: "windows",
    status: "draft",
    version: "1.2.0",
    title: "Windows 1.2.0",
    changelog: ["Support release publishing", "Fix admin release flow"]
  });
  assert.equal("minimumVersion" in payload, false, "backend should default minimumVersion to the release version");
  assert.equal("forceUpgrade" in payload, false, "forceUpgrade must not be required for ordinary releases");
}

function testCreateReleasePayloadOmitsOptionalPublishingFlags() {
  const form = {
    ...emptyReleaseEditorForm("macos"),
    version: " 2.0.1 ",
    title: "",
    changelog: ""
  };

  const payload = buildCreateReleasePayload(form);

  assert.equal(payload.title, undefined);
  assert.equal("minimumVersion" in payload, false);
  assert.equal("forceUpgrade" in payload, false);
}

function testUpdateReleasePayloadDoesNotSendVersionOrPublishingFlags() {
  const form = {
    ...emptyReleaseEditorForm("windows"),
    version: "1.1.7",
    title: "  Windows 1.1.7  ",
    changelog: "Fix admin release\n\nImprove download"
  };

  const payload = buildUpdateReleasePayload(form);

  assert.deepEqual(payload, {
    title: "Windows 1.1.7",
    changelog: ["Fix admin release", "Improve download"]
  });
  assert.equal("version" in payload, false, "release edits must not send the immutable version field");
  assert.equal("minimumVersion" in payload, false, "simple release edits must not change minimumVersion");
  assert.equal("forceUpgrade" in payload, false, "simple release edits must not change forceUpgrade");
}

function testBlankUpdateReleaseTitleDoesNotFallbackToVersion() {
  const form = {
    ...emptyReleaseEditorForm("windows"),
    version: "1.1.7",
    title: "  ",
    changelog: ""
  };

  const payload = buildUpdateReleasePayload(form);

  assert.deepEqual(payload, {
    title: "",
    changelog: []
  });
  assert.equal("version" in payload, false, "blank title edits must not silently reuse version as display title");
}

function testWindowsZipExternalArtifactCanStayExternalDownload() {
  const payload = buildExternalArtifactPayload(
    "windows",
    " https://cdn.example.com/ChordV_1.1.6_x64-full.zip ",
    true,
    "external_download"
  );

  assert.equal(payload.source, "external");
  assert.equal(payload.type, "external");
  assert.equal(payload.deliveryMode, "external_download");
  assert.equal(payload.downloadUrl, "https://cdn.example.com/ChordV_1.1.6_x64-full.zip");
  assert.equal(payload.fileName, "ChordV_1.1.6_x64-full.zip");
  assert.equal(payload.isPrimary, true);
}

function testWindowsZipExternalArtifactCanBeFullReplaceWhenExplicit() {
  const payload = buildExternalArtifactPayload(
    "windows",
    "https://cdn.example.com/ChordV_1.1.6_x64-full.zip",
    true,
    "windows_full_replace_zip"
  );

  assert.equal(payload.source, "external");
  assert.equal(payload.type, "zip");
  assert.equal(payload.deliveryMode, "desktop_full_replace");
}

function testWindowsNonZipExternalArtifactCanBeFullReplaceWhenExplicit() {
  const payload = buildExternalArtifactPayload(
    "windows",
    " https://cdn.example.com/download?id=ChordV_1.1.6_x64-full ",
    true,
    "windows_full_replace_zip"
  );

  assert.equal(payload.source, "external");
  assert.equal(payload.type, "zip");
  assert.equal(payload.deliveryMode, "desktop_full_replace");
  assert.equal(payload.downloadUrl, "https://cdn.example.com/download?id=ChordV_1.1.6_x64-full");
  assert.equal(payload.isPrimary, true);
}

function testReleaseArtifactLongDownloadUrlDoesNotForceWideCards() {
  assert.match(releaseRecordCardSource, /lineClamp=\{2\}/);
  assert.match(releaseRecordCardSource, /overflowWrap: "anywhere"/);
}

testCreateReleasePayloadKeepsReleaseFieldsSimple();
testCreateReleasePayloadOmitsOptionalPublishingFlags();
testUpdateReleasePayloadDoesNotSendVersionOrPublishingFlags();
testBlankUpdateReleaseTitleDoesNotFallbackToVersion();
testWindowsZipExternalArtifactCanStayExternalDownload();
testWindowsZipExternalArtifactCanBeFullReplaceWhenExplicit();
testWindowsNonZipExternalArtifactCanBeFullReplaceWhenExplicit();
testReleaseArtifactLongDownloadUrlDoesNotForceWideCards();

console.log("release admin regression checks passed");
