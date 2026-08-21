import assert from "node:assert/strict";
import { buildDirectUserQuotaPayload } from "../src/modules/common/runtime-session.service";
import {
  compareRestartAwareShadowUsage,
  compareShadowUsage,
  createUsageBatchFixture,
  duplicateAndReorderBatches,
  reconcileNodeUsers,
  simulateIdempotentBatchAcceptance,
  type BindingRecord,
  type RemoteUserRecord,
  type ShadowCounterSample,
  type ShadowUsageDelta
} from "../../../scripts/agent-migration/index.ts";

const uuid = "123e4567-e89b-42d3-a456-426614174000";
const generatedAt = "2026-07-26T00:00:00.000Z";
const binding: BindingRecord = { nodeId: "node_1", email: "User@Example.Invalid", uuid, status: "active" };
const remote: RemoteUserRecord = { nodeId: "node_1", email: "user@example.invalid", uuid: uuid.toUpperCase(), enabled: true };

const cleanReport = reconcileNodeUsers(
  { bindings: [binding], xuiUsers: [remote], xrayUsers: [remote] },
  generatedAt
);
assert.equal(cleanReport.readyForShadow, true);
assert.equal(cleanReport.counts.issues, 0);
assert.equal(cleanReport.generatedAt, generatedAt);

const brokenReport = reconcileNodeUsers(
  {
    bindings: [binding, { ...binding }],
    xuiUsers: [{ ...remote, uuid: "223e4567-e89b-42d3-a456-426614174000" }],
    xrayUsers: []
  },
  generatedAt
);
assert.equal(brokenReport.readyForShadow, false);
assert(brokenReport.issues.some((issue) => issue.code === "DUPLICATE_EMAIL" && issue.source === "binding"));
assert(brokenReport.issues.some((issue) => issue.code === "DUPLICATE_UUID" && issue.source === "binding"));
assert(brokenReport.issues.some((issue) => issue.code === "UUID_MISMATCH"));
assert(brokenReport.issues.some((issue) => issue.code === "MISSING_IN_XRAY"));

const usageBase = {
  nodeId: "node_1",
  email: "user@example.invalid",
  uuid,
  windowStartedAt: "2026-07-26T00:00:00.000Z",
  windowEndedAt: "2026-07-26T00:05:00.000Z"
};
const xuiUsage: ShadowUsageDelta = {
  ...usageBase,
  uplinkBytes: "9007199254740993000",
  downlinkBytes: "1000"
};
const directUsage: ShadowUsageDelta = {
  ...usageBase,
  uplinkBytes: "9007199254740992900",
  downlinkBytes: "1000"
};
const shadowReport = compareShadowUsage([xuiUsage], [directUsage], { absoluteBytes: "1048576", relativePercent: 0.1 }, generatedAt);
assert.equal(shadowReport.readyForDirect, true);
assert.equal(shadowReport.differences[0]?.differenceBytes, "100");
assert.equal(shadowReport.differences[0]?.xuiBytes, "9007199254740994000");

const overThresholdReport = compareShadowUsage(
  [{ ...usageBase, uplinkBytes: "1000000", downlinkBytes: "0" }],
  [{ ...usageBase, uplinkBytes: "1010001", downlinkBytes: "0" }],
  { absoluteBytes: "10000", relativePercent: 0.1 },
  generatedAt
);
assert.equal(overThresholdReport.readyForDirect, false);
assert.equal(overThresholdReport.counts.overThresholdUsers, 1);
assert.equal(overThresholdReport.differences[0]?.allowedDifferenceBytes, "10000");

const missingShadowReport = compareShadowUsage([xuiUsage], [], { absoluteBytes: "1048576", relativePercent: 0.1 }, generatedAt);
assert.equal(missingShadowReport.readyForDirect, false);
assert.deepEqual(missingShadowReport.counts, {
  xuiUsers: 1,
  directUsers: 0,
  comparedUsers: 0,
  missingUsers: 1,
  overThresholdUsers: 0
});

const batches = [1, 2, 3].map((sequence) => createUsageBatchFixture(sequence));
const repeated = Array.from({ length: 100 }, (_, index) => structuredClone(batches[index % batches.length]!));
const acceptedRepeated = simulateIdempotentBatchAcceptance(repeated);
assert.equal(acceptedRepeated.accepted.length, 3);
assert.deepEqual(acceptedRepeated.accepted.map((batch) => batch.sequence), [1, 2, 3]);
assert.deepEqual(acceptedRepeated.conflicts, []);

const acceptedOutOfOrder = simulateIdempotentBatchAcceptance(duplicateAndReorderBatches(batches));
assert.deepEqual(acceptedOutOfOrder.accepted.map((batch) => batch.sequence), [1, 2, 3]);
assert.deepEqual(acceptedOutOfOrder.conflicts, []);

const conflict = createUsageBatchFixture(2, { payloadHash: "f".repeat(64) });
const acceptedConflict = simulateIdempotentBatchAcceptance([...batches, conflict]);
assert.equal(acceptedConflict.accepted.length, 3);
assert.equal(acceptedConflict.conflicts.length, 1);

assert.throws(
  () => compareShadowUsage([{ ...xuiUsage, uplinkBytes: "1.5" }], [directUsage], { absoluteBytes: "1", relativePercent: 0.1 }),
  /非负十进制整数字符串/
);
assert.throws(
  () =>
    compareShadowUsage(
      [xuiUsage],
      [{ ...directUsage, windowEndedAt: "2026-07-26T00:06:00.000Z" }],
      { absoluteBytes: "1", relativePercent: 0.1 }
    ),
  /采样窗口不一致/
);

const counterSample = (
  checkpointId: string,
  counterGeneration: string,
  uplinkBytes: string,
  downlinkBytes: string,
  sampledAt: string
): ShadowCounterSample => ({
  nodeId: "node_1",
  email: "user@example.invalid",
  uuid,
  checkpointId,
  counterGeneration,
  uplinkBytes,
  downlinkBytes,
  sampledAt
});

const xuiSeries = [
  counterSample("a", "boot-a:0", "1000", "0", "2026-07-26T00:00:00.000Z"),
  counterSample("b", "boot-a:0", "1000", "0", "2026-07-26T00:00:05.000Z"),
  counterSample("c", "boot-a:0", "5000", "0", "2026-07-26T00:00:10.000Z"),
  counterSample("d", "boot-b:1", "5000", "0", "2026-07-26T00:00:15.000Z"),
  counterSample("e", "boot-b:1", "5000", "0", "2026-07-26T00:00:20.000Z"),
  counterSample("f", "boot-b:1", "7000", "0", "2026-07-26T00:00:25.000Z")
];
const directSeries = [
  counterSample("a", "boot-a:0", "1000", "0", "2026-07-26T00:00:00.000Z"),
  counterSample("b", "boot-a:0", "4000", "0", "2026-07-26T00:00:05.000Z"),
  counterSample("c", "boot-a:0", "8000", "0", "2026-07-26T00:00:10.000Z"),
  counterSample("d", "boot-b:1", "100", "0", "2026-07-26T00:00:15.000Z"),
  counterSample("e", "boot-b:1", "600", "0", "2026-07-26T00:00:20.000Z"),
  counterSample("f", "boot-b:1", "2600", "0", "2026-07-26T00:00:25.000Z")
];

const restartAwareReport = compareRestartAwareShadowUsage(
  xuiSeries,
  directSeries,
  { absoluteBytes: "0", relativePercent: 0 },
  1,
  generatedAt
);
assert.equal(restartAwareReport.readyForDirect, true);
assert.equal(restartAwareReport.counts.rebaselineBoundaries, 2);
assert.equal(restartAwareReport.counts.unresolvedBoundaries, 0);
assert.equal(restartAwareReport.counts.steadyWindows, 2);
assert.equal(restartAwareReport.differences.every((item) => item.differenceBytes === "0"), true);
assert.deepEqual(
  restartAwareReport.boundaries.map((item) => ({ reason: item.reason, classification: item.classification, gapBytes: item.gapBytes })),
  [
    { reason: "initial", classification: "XUI_FIRST_OBSERVATION_GAP", gapBytes: "3000" },
    { reason: "counter_generation_changed", classification: "XUI_FIRST_OBSERVATION_GAP", gapBytes: "500" }
  ]
);

const unresolvedRestart = compareRestartAwareShadowUsage(
  xuiSeries.slice(0, 4),
  directSeries.slice(0, 4),
  { absoluteBytes: "0", relativePercent: 0 },
  1,
  generatedAt
);
assert.equal(unresolvedRestart.readyForDirect, false);
assert.equal(unresolvedRestart.counts.unresolvedBoundaries, 1);

const insufficientSteady = compareRestartAwareShadowUsage(
  xuiSeries.slice(0, 3),
  directSeries.slice(0, 3),
  { absoluteBytes: "0", relativePercent: 0 },
  2,
  generatedAt
);
assert.equal(insufficientSteady.readyForDirect, false);
assert.equal(insufficientSteady.counts.insufficientSteadyUsers, 1);

const missingCheckpoint = compareRestartAwareShadowUsage(
  xuiSeries.slice(0, 3),
  directSeries.slice(0, 2),
  { absoluteBytes: "0", relativePercent: 0 },
  1,
  generatedAt
);
assert.equal(missingCheckpoint.readyForDirect, false);
assert.equal(missingCheckpoint.counts.missingCheckpoints, 1);

const emptySeries = compareRestartAwareShadowUsage([], [], { absoluteBytes: "0", relativePercent: 0 }, 1, generatedAt);
assert.equal(emptySeries.readyForDirect, false);
assert.equal(emptySeries.counts.identities, 0);

assert.throws(
  () => compareRestartAwareShadowUsage(
    [counterSample("a", "boot-a:0", "100", "0", "2026-07-26T00:00:00.000Z"), counterSample("b", "boot-a:0", "99", "0", "2026-07-26T00:00:05.000Z")],
    [counterSample("a", "boot-a:0", "100", "0", "2026-07-26T00:00:00.000Z"), counterSample("b", "boot-a:0", "101", "0", "2026-07-26T00:00:05.000Z")],
    { absoluteBytes: "0", relativePercent: 0 }
  ),
  /同一 counterGeneration 内计数回退/
);

const directEnsureQuota = buildDirectUserQuotaPayload({
  totalTrafficBytes: 1024n,
  usedTrafficBytes: 24n,
  remainingTrafficGb: 0
});
assert.equal(directEnsureQuota.quotaRemainingBytes, "1000", "新建 Direct 用户必须携带当前剩余配额");
assert.equal(directEnsureQuota.offlineAllowanceBytes, String(64n * 1024n * 1024n));

console.log("direct-metering-migration.regression.ts passed");
