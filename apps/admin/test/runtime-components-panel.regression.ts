import assert from "node:assert/strict";
import { getRuntimeComponentDeliveryState } from "../src/features/runtime-components/delivery-state";
import type { AdminRuntimeComponentRecordDto } from "../src/api/client";

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

testEnabledRemotePendingValidationIsNotShownAsDeliverable();
testEnabledRemoteHashMismatchIsShownAsBlocked();
testDeliverableComponentIsShownAsDeliverable();
testMissingDeliveryFieldsAreShownAsUnknown();

console.log("runtime components panel regression checks passed");
