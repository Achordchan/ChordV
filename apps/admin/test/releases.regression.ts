import assert from "node:assert/strict";
import { buildCreateReleasePayload, buildUpdateReleasePayload, emptyReleaseEditorForm } from "../src/features/releases/types";

function testCreateReleasePayloadKeepsReleaseFieldsSimple() {
  const form = {
    ...emptyReleaseEditorForm("windows"),
    version: " 1.2.0 ",
    minimumVersion: " 1.0.0 ",
    forceUpgrade: true,
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
    minimumVersion: "   ",
    forceUpgrade: false,
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
    minimumVersion: " 1.1.0 ",
    forceUpgrade: true,
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
    minimumVersion: "",
    forceUpgrade: false,
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

testCreateReleasePayloadKeepsReleaseFieldsSimple();
testCreateReleasePayloadOmitsOptionalPublishingFlags();
testUpdateReleasePayloadDoesNotSendVersionOrPublishingFlags();
testBlankUpdateReleaseTitleDoesNotFallbackToVersion();

console.log("release admin regression checks passed");
