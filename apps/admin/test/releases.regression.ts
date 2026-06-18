import assert from "node:assert/strict";
import { buildUpdateReleasePayload, emptyReleaseEditorForm } from "../src/features/releases/types";

function testUpdateReleasePayloadDoesNotSendVersion() {
  const form = {
    ...emptyReleaseEditorForm("windows"),
    version: "1.1.7",
    title: "  Windows 1.1.7  ",
    changelog: " 修复后台发布 \n\n 优化下载 "
  };

  const payload = buildUpdateReleasePayload(form);

  assert.deepEqual(payload, {
    title: "Windows 1.1.7",
    changelog: ["修复后台发布", "优化下载"]
  });
  assert.equal("version" in payload, false, "release edits must not send the immutable version field");
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

testUpdateReleasePayloadDoesNotSendVersion();
testBlankUpdateReleaseTitleDoesNotFallbackToVersion();

console.log("release admin regression checks passed");
