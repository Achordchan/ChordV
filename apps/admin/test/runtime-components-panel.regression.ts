import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyRuntimeComponentValidationToDelivery, getRuntimeComponentDeliveryState } from "../src/features/runtime-components/delivery-state";
import type { AdminRuntimeComponentRecordDto, AdminRuntimeComponentValidationDto } from "../src/api/client";

const runtimeComponentsPanelSource = readFileSync(resolve(import.meta.dirname, "../src/features/runtime-components/RuntimeComponentsPanel.tsx"), "utf8");

function extractAsyncFunctionBody(source: string, functionName: string) {
  const signature = `async function ${functionName}`;
  const signatureIndex = source.indexOf(signature);
  assert.notEqual(signatureIndex, -1, `${functionName} should exist`);

  const bodyStart = source.indexOf("{", signatureIndex);
  assert.notEqual(bodyStart, -1, `${functionName} should have a body`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bodyStart + 1, index);
      }
    }
  }

  assert.fail(`${functionName} body should be closed`);
}

function makeRuntimeComponent(overrides: Partial<AdminRuntimeComponentRecordDto> = {}): AdminRuntimeComponentRecordDto {
  return {
    id: "component_1",
    platform: "windows",
    architecture: "x64",
    kind: "xray",
    source: "custom_remote",
    originUrl: "https://cdn.example.com/xray.exe",
    defaultMirrorPrefix: null,
    allowClientMirror: false,
    fileName: "xray.exe",
    archiveEntryName: null,
    expectedHash: null,
    fileSizeBytes: null,
    fileHash: null,
    enabled: true,
    clientDeliverable: false,
    clientDeliveryStatus: "pending_validation",
    clientDeliveryMessage: "远程直链还没有校验结果，不会下发给客户端。",
    finalUrlPreview: "https://cdn.example.com/xray.exe",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function testEnabledRemotePendingValidationIsNotShownAsDeliverable() {
  const state = getRuntimeComponentDeliveryState(makeRuntimeComponent());

  assert.equal(state.color, "yellow");
  assert.equal(state.label, "待校验");
  assert.match(state.description, /不会下发/);
}

function testEnabledRemoteHashMismatchIsShownAsBlocked() {
  const state = getRuntimeComponentDeliveryState(
    makeRuntimeComponent({
      clientDeliveryStatus: "metadata_mismatch",
      clientDeliveryMessage: "远程文件 Hash 与预期不一致，不会下发给客户端。"
    })
  );

  assert.equal(state.color, "red");
  assert.equal(state.label, "Hash 不一致");
  assert.match(state.description, /不会下发/);
}

function testSaveFailedIsNotShownAsHashMismatch() {
  const state = getRuntimeComponentDeliveryState(
    makeRuntimeComponent({
      clientDeliveryStatus: "save_failed",
      clientDeliveryMessage: "远程组件可访问且 Hash 匹配，但保存校验结果失败。"
    })
  );

  assert.equal(state.color, "red");
  assert.equal(state.label, "保存失败");
  assert.doesNotMatch(state.label, /Hash/);
}

function testUnreachableIsShownAsBlocked() {
  const state = getRuntimeComponentDeliveryState(
    makeRuntimeComponent({
      clientDeliveryStatus: "unreachable",
      clientDeliveryMessage: "远程组件当前不可访问。"
    })
  );

  assert.equal(state.color, "red");
  assert.equal(state.label, "无法访问");
}

function testDeliverableComponentIsShownAsDeliverable() {
  const state = getRuntimeComponentDeliveryState(
    makeRuntimeComponent({
      clientDeliverable: true,
      clientDeliveryStatus: "ready",
      clientDeliveryMessage: "远程直链已校验通过，可下发给客户端。"
    })
  );

  assert.equal(state.color, "green");
  assert.equal(state.label, "可下发");
  assert.match(state.description, /可下发/);
}

function testMissingDeliveryFieldsAreShownAsUnknown() {
  const state = getRuntimeComponentDeliveryState(
    makeRuntimeComponent({
      clientDeliverable: undefined,
      clientDeliveryStatus: undefined,
      clientDeliveryMessage: undefined
    })
  );

  assert.equal(state.color, "gray");
  assert.equal(state.label, "状态未知");
}

function testReadyValidationUpdatesDeliveryState() {
  const hash = "c".repeat(64);
  const next = applyRuntimeComponentValidationToDelivery(
    makeRuntimeComponent(),
    {
      componentId: "component_1",
      status: "ready",
      message: "校验通过",
      finalUrlPreview: "https://cdn.example.com/xray.exe",
      actualFileSizeBytes: "2048",
      actualFileHash: hash
    } satisfies AdminRuntimeComponentValidationDto
  );

  assert.equal(next.clientDeliverable, true);
  assert.equal(next.clientDeliveryStatus, "ready");
  assert.equal(next.fileSizeBytes, "2048");
  assert.equal(next.fileHash, hash);
  assert.equal(getRuntimeComponentDeliveryState(next).label, "可下发");
}

function testFailedValidationBlocksDeliveryState() {
  const next = applyRuntimeComponentValidationToDelivery(
    makeRuntimeComponent({
      clientDeliverable: true,
      clientDeliveryStatus: "ready",
      clientDeliveryMessage: "旧状态可下发"
    }),
    {
      componentId: "component_1",
      status: "save_failed",
      message: "保存校验结果失败",
      finalUrlPreview: "https://cdn.example.com/xray.exe"
    } satisfies AdminRuntimeComponentValidationDto
  );

  assert.equal(next.clientDeliverable, false);
  assert.equal(next.clientDeliveryStatus, "save_failed");
  assert.equal(getRuntimeComponentDeliveryState(next).label, "保存失败");
}

function testRuntimeComponentsTableKeepsReadableMinimumWidth() {
  assert.match(runtimeComponentsPanelSource, /<ScrollArea>/);
  assert.match(runtimeComponentsPanelSource, /<Box style={{ minWidth: 1200 }}>/);
}

function testUploadedRuntimeComponentSaveDoesNotSubmitExpectedHash() {
  const uploadedBranchStart = runtimeComponentsPanelSource.indexOf("const uploadPayload");
  const remoteBranchStart = runtimeComponentsPanelSource.indexOf("} else {", uploadedBranchStart);
  assert.ok(uploadedBranchStart >= 0 && remoteBranchStart > uploadedBranchStart);
  const uploadedBranchSource = runtimeComponentsPanelSource.slice(uploadedBranchStart, remoteBranchStart);
  assert.doesNotMatch(uploadedBranchSource, /expectedHash:/);
}

function testRuntimeComponentMutationsAlwaysReleaseBusyState() {
  assert.match(
    extractAsyncFunctionBody(runtimeComponentsPanelSource, "saveComponent"),
    /finally\s*{[\s\S]*?savingRef\.current = false;[\s\S]*?onSavingChange\(false\);[\s\S]*?}/,
    "runtime component save must release busy state after success, validation failure, or request failure"
  );
  assert.match(
    extractAsyncFunctionBody(runtimeComponentsPanelSource, "verifyComponent"),
    /finally\s*{[\s\S]*?if \(verifyingRef\.current === record\.id\) {[\s\S]*?verifyingRef\.current = null;[\s\S]*?setVerifyingId\(null\);[\s\S]*?}/,
    "runtime component verify must release only the matching verifying state"
  );
  assert.match(
    extractAsyncFunctionBody(runtimeComponentsPanelSource, "removeComponent"),
    /finally\s*{[\s\S]*?deletingRef\.current\.delete\(record\.id\);[\s\S]*?savingRef\.current = false;[\s\S]*?onSavingChange\(false\);[\s\S]*?}/,
    "runtime component delete must release row and page busy state"
  );
}

function testRuntimeComponentUncertainMutationsRefreshSilently() {
  for (const functionName of ["saveComponent", "verifyComponent", "removeComponent"]) {
    const body = extractAsyncFunctionBody(runtimeComponentsPanelSource, functionName);
    assert.match(
      body,
      /if \(result\.uncertain\) {[\s\S]*?void onRefresh\(\{ silent: true \}\);[\s\S]*?}/,
      `${functionName} should refresh silently when the backend result is uncertain`
    );
  }
}

testEnabledRemotePendingValidationIsNotShownAsDeliverable();
testEnabledRemoteHashMismatchIsShownAsBlocked();
testSaveFailedIsNotShownAsHashMismatch();
testUnreachableIsShownAsBlocked();
testDeliverableComponentIsShownAsDeliverable();
testMissingDeliveryFieldsAreShownAsUnknown();
testReadyValidationUpdatesDeliveryState();
testFailedValidationBlocksDeliveryState();
testRuntimeComponentsTableKeepsReadableMinimumWidth();
testUploadedRuntimeComponentSaveDoesNotSubmitExpectedHash();
testRuntimeComponentMutationsAlwaysReleaseBusyState();
testRuntimeComponentUncertainMutationsRefreshSilently();

console.log("runtime components panel regression checks passed");
