import assert from "node:assert/strict";
import { buildCreateReleasePayload, buildUpdateReleasePayload, emptyReleaseEditorForm } from "../src/features/releases/types";

function testCreateReleasePayloadUsesMinimumVersionAndForceUpgradeFromForm() {
  const form = {
    ...emptyReleaseEditorForm("windows"),
    version: " 1.2.0 ",
    minimumVersion: " 1.0.0 ",
    forceUpgrade: true,
    title: "  Windows 1.2.0  ",
    changelog: " 支持强制升级 \n\n 修复后台发布 "
  };

  const payload = buildCreateReleasePayload(form);

  assert.deepEqual(payload, {
    platform: "windows",
    status: "draft",
    version: "1.2.0",
    minimumVersion: "1.0.0",
    forceUpgrade: true,
    title: "Windows 1.2.0",
    changelog: ["支持强制升级", "修复后台发布"]
  });
}

function testCreateReleasePayloadFallsBackMinimumVersionToVersion() {
  const form = {
    ...emptyReleaseEditorForm("macos"),
    version: " 2.0.1 ",
    minimumVersion: "   ",
    forceUpgrade: false,
    title: "",
    changelog: ""
  };

  const payload = buildCreateReleasePayload(form);

  assert.equal(payload.minimumVersion, "2.0.1");
  assert.equal(payload.forceUpgrade, false);
  assert.equal(payload.title, undefined);
}

function testUpdateReleasePayloadDoesNotSendVersion() {
  const form = {
    ...emptyReleaseEditorForm("windows"),
    version: "1.1.7",
    minimumVersion: " 1.1.0 ",
    forceUpgrade: true,
    title: "  Windows 1.1.7  ",
    changelog: " 修复后台发布 \n\n 优化下载 "
  };

  const payload = buildUpdateReleasePayload(form);

  assert.deepEqual(payload, {
    title: "Windows 1.1.7",
    changelog: ["修复后台发布", "优化下载"],
    minimumVersion: "1.1.0",
    forceUpgrade: true
  });
  assert.equal("version" in payload, false, "release edits must not send the immutable version field");
}

function testBlankUpdateReleaseTitleDoesNotFallbackToVersion() {
  const form = {
    ...emptyReleaseEditorForm("windows"),
    version: "1.1.7",
    minimumVersion: "",
    forceUpgrade: false,
    title: "  ",
    changelog: ""
  };

  const payload = buildUpdateReleasePayload(form);

  assert.deepEqual(payload, {
    title: "",
    changelog: [],
    minimumVersion: "1.1.7",
    forceUpgrade: false
  });
  assert.equal("version" in payload, false, "blank title edits must not silently reuse version as display title");
}

testCreateReleasePayloadUsesMinimumVersionAndForceUpgradeFromForm();
testCreateReleasePayloadFallsBackMinimumVersionToVersion();
testUpdateReleasePayloadDoesNotSendVersion();
testBlankUpdateReleaseTitleDoesNotFallbackToVersion();

console.log("release admin regression checks passed");
