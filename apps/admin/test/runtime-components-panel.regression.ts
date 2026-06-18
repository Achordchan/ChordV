import assert from "node:assert/strict";
import { applyRuntimeComponentValidationToDelivery, getRuntimeComponentDeliveryState } from "../src/features/runtime-components/delivery-state";
import type { AdminRuntimeComponentRecordDto, AdminRuntimeComponentValidationDto } from "../src/api/client";

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
      status: "metadata_mismatch",
      message: "Hash 不一致",
      finalUrlPreview: "https://cdn.example.com/xray.exe"
    } satisfies AdminRuntimeComponentValidationDto
  );

  assert.equal(next.clientDeliverable, false);
  assert.equal(next.clientDeliveryStatus, "metadata_mismatch");
  assert.equal(getRuntimeComponentDeliveryState(next).label, "Hash 不一致");
}

testEnabledRemotePendingValidationIsNotShownAsDeliverable();
testEnabledRemoteHashMismatchIsShownAsBlocked();
testDeliverableComponentIsShownAsDeliverable();
testMissingDeliveryFieldsAreShownAsUnknown();
testReadyValidationUpdatesDeliveryState();
testFailedValidationBlocksDeliveryState();

console.log("runtime components panel regression checks passed");
