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
    expectedHash: "a".repeat(64),
    fileSizeBytes: 1024,
    fileHash: "a".repeat(64),
    enabled: true,
    clientDeliverable: true,
    clientDeliveryStatus: "ready",
    clientDeliveryMessage: "远程更新地址有效，可下发给客户端。",
    finalUrlPreview: "https://cdn.example.com/xray.exe",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function testEnabledRemotePendingValidationIsNotShownAsDeliverable() {
  const state = getRuntimeComponentDeliveryState(
    makeRuntimeComponent({
      clientDeliverable: false,
      clientDeliveryStatus: "pending_validation",
      clientDeliveryMessage: "状态待确认"
    })
  );

  assert.equal(state.color, "yellow");
  assert.equal(state.label, "待确认");
  assert.match(state.description, /待确认/);
}

function testEnabledRemoteHashMismatchIsShownAsBlocked() {
  const state = getRuntimeComponentDeliveryState(
    makeRuntimeComponent({
      clientDeliverable: false,
      clientDeliveryStatus: "metadata_mismatch",
      clientDeliveryMessage: "远程文件内容异常，不会下发给客户端。"
    })
  );

  assert.equal(state.color, "red");
  assert.equal(state.label, "内容异常");
  assert.match(state.description, /不会下发/);
}

function testSaveFailedIsNotShownAsHashMismatch() {
  const state = getRuntimeComponentDeliveryState(
    makeRuntimeComponent({
      clientDeliverable: false,
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
      clientDeliverable: false,
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
  assert.equal(getRuntimeComponentDeliveryState(next).label, "可下发");
}

function testFailedValidationBlocksDeliveryState() {
  const next = applyRuntimeComponentValidationToDelivery(
    makeRuntimeComponent({
      source: "uploaded",
      clientDeliverable: true,
      clientDeliveryStatus: "ready",
      clientDeliveryMessage: "旧状态可下发"
    }),
    {
      componentId: "component_1",
      status: "save_failed",
      message: "保存检测结果失败",
      finalUrlPreview: "https://cdn.example.com/xray.exe"
    } satisfies AdminRuntimeComponentValidationDto
  );

  assert.equal(next.clientDeliverable, false);
  assert.equal(next.clientDeliveryStatus, "save_failed");
  assert.equal(getRuntimeComponentDeliveryState(next).label, "保存失败");
}

function testRemoteFailedValidationKeepsDeliverable() {
  const next = applyRuntimeComponentValidationToDelivery(
    makeRuntimeComponent({
      source: "custom_remote",
      clientDeliverable: true,
      clientDeliveryStatus: "ready",
      clientDeliveryMessage: "远程更新地址有效，可下发给客户端。"
    }),
    {
      componentId: "component_1",
      status: "unreachable",
      message: "当前链接不可访问",
      finalUrlPreview: "https://cdn.example.com/xray.exe"
    } satisfies AdminRuntimeComponentValidationDto
  );

  assert.equal(next.clientDeliverable, true);
  assert.equal(next.clientDeliveryStatus, "ready");
}

function testRuntimeComponentsPanelUsesSlotCardsInsteadOfWideTable() {
  assert.match(runtimeComponentsPanelSource, /RuntimeComponentSlotCard/);
  assert.match(runtimeComponentsPanelSource, /全局加速镜像/);
  assert.match(runtimeComponentsPanelSource, /runtimeComponentSlots/);
  assert.match(runtimeComponentsPanelSource, /title="配置"/);
  assert.match(runtimeComponentsPanelSource, /复制下载地址/);
  assert.doesNotMatch(runtimeComponentsPanelSource, /<ScrollArea>/);
  assert.doesNotMatch(runtimeComponentsPanelSource, /minWidth: 1200/);
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

function testPendingValidationNotificationIsNotShownAsFailure() {
  assert.match(
    extractAsyncFunctionBody(runtimeComponentsPanelSource, "verifyComponent"),
    /result\.status === "disabled" \|\| result\.status === "pending_validation" \? "yellow" : "red"/,
    "runtime component pending validation should be shown as a yellow pending state, not a red failure"
  );
}

testEnabledRemotePendingValidationIsNotShownAsDeliverable();
testEnabledRemoteHashMismatchIsShownAsBlocked();
testSaveFailedIsNotShownAsHashMismatch();
testUnreachableIsShownAsBlocked();
testDeliverableComponentIsShownAsDeliverable();
testMissingDeliveryFieldsAreShownAsUnknown();
testReadyValidationUpdatesDeliveryState();
testFailedValidationBlocksDeliveryState();
testRuntimeComponentsPanelUsesSlotCardsInsteadOfWideTable();
testUploadedRuntimeComponentSaveDoesNotSubmitExpectedHash();
testRuntimeComponentMutationsAlwaysReleaseBusyState();
testRuntimeComponentUncertainMutationsRefreshSilently();
testPendingValidationNotificationIsNotShownAsFailure();

console.log("runtime components panel regression checks passed");
