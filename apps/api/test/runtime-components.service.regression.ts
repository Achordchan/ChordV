import "reflect-metadata";
import assert from "node:assert/strict";
import { BadRequestException } from "@nestjs/common";
import { RuntimeComponentsService } from "../src/modules/common/runtime-components.service";

function createRuntimeComponentsService(overrides: Record<string, unknown>) {
  return Object.assign(Object.create(RuntimeComponentsService.prototype), overrides) as RuntimeComponentsService;
}

function makeUploadedComponent(overrides: Record<string, unknown> = {}) {
  return {
    id: "component_1",
    platform: "windows",
    architecture: "x64",
    kind: "xray",
    source: "uploaded",
    originUrl: "/api/downloads/runtime-components/component_1",
    defaultMirrorPrefix: null,
    allowClientMirror: false,
    fileName: "xray.zip",
    storedFilePath: "component_1/xray.zip",
    fileSizeBytes: 1024n,
    fileHash: "a".repeat(64),
    archiveEntryName: null,
    expectedHash: "a".repeat(64),
    enabled: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides
  };
}

function makeRemoteComponent(overrides: Record<string, unknown> = {}) {
  return makeUploadedComponent({
    source: "custom_remote",
    originUrl: "https://cdn.example.com/xray.exe",
    storedFilePath: null,
    fileSizeBytes: null,
    fileHash: null,
    expectedHash: null,
    ...overrides
  });
}

function makeRuntimeComponentListPrisma(rows: Array<Record<string, unknown>>, failureReports: Array<Record<string, unknown>> = []) {
  return {
    runtimeComponent: {
      findMany: async () => rows
    },
    runtimeComponentFailureReport: {
      findMany: async () => failureReports
    }
  };
}

async function testUploadedRuntimeComponentRejectsMismatchedExpectedHashOnPatch() {
  let updateCalled = false;
  const service = createRuntimeComponentsService({
    ensureRuntimeComponentExists: async () => makeUploadedComponent(),
    prisma: {
      runtimeComponent: {
        update: async () => {
          updateCalled = true;
          throw new Error("update should not run when expectedHash mismatches current fileHash");
        }
      }
    }
  });

  await assert.rejects(
    () => service.updateAdminRuntimeComponent("component_1", { expectedHash: "b".repeat(64) }),
    (error) =>
      error instanceof BadRequestException &&
      /expectedHash/.test(error.message) &&
      /SHA256/.test(error.message),
    "uploaded runtime component PATCH must reject expectedHash that differs from current fileHash"
  );
  assert.equal(updateCalled, false, "mismatched expectedHash must be rejected before saving");
}

async function testUploadedRuntimeComponentAcceptsMatchingExpectedHashOnPatch() {
  const updates: Array<Record<string, any>> = [];
  const current = makeUploadedComponent({ expectedHash: null });
  const service = createRuntimeComponentsService({
    ensureRuntimeComponentExists: async () => current,
    prisma: {
      runtimeComponent: {
        update: async (payload: Record<string, any>) => {
          updates.push(payload);
          return {
            ...current,
            ...payload.data,
            updatedAt: new Date("2026-01-01T00:01:00.000Z")
          };
        }
      }
    },
    startSharedRulesetDuplicatesCleanup: () => undefined,
    startRuntimeComponentStoredFileCleanupBestEffort: () => undefined
  });

  const result = await service.updateAdminRuntimeComponent("component_1", { expectedHash: "A".repeat(64) });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.expectedHash, "a".repeat(64));
  assert.equal(updates[0].data.fileHash, undefined, "matching expectedHash must not clear uploaded file metadata");
  assert.equal(result.expectedHash, "a".repeat(64));
  assert.equal(result.fileHash, "a".repeat(64));
}

async function testAdminRuntimeComponentMarksUnverifiedRemoteAsNotDeliverable() {
  const service = createRuntimeComponentsService({
    prisma: makeRuntimeComponentListPrisma([makeRemoteComponent({ expectedHash: null })])
  });

  const [result] = await service.listAdminRuntimeComponents();

  assert.equal(result.clientDeliverable, false);
  assert.equal(result.clientDeliveryStatus, "pending_validation");
  assert.match(result.clientDeliveryMessage, /不会下发|校验/);
}

async function testAdminRuntimeComponentMarksMissingUploadedFileAsNotDeliverable() {
  const service = createRuntimeComponentsService({
    prisma: makeRuntimeComponentListPrisma([
      makeUploadedComponent({
        storedFilePath: "component_1/definitely-missing.zip"
      })
    ])
  });

  const [result] = await service.listAdminRuntimeComponents();

  assert.equal(result.clientDeliverable, false);
  assert.equal(result.clientDeliveryStatus, "missing_file");
  assert.match(result.clientDeliveryMessage, /文件不可用|不会下发/);
}

async function testAdminRuntimeComponentMarksVerifiedRemoteAsDeliverable() {
  const hash = "a".repeat(64);
  const service = createRuntimeComponentsService({
    prisma: makeRuntimeComponentListPrisma([
      makeRemoteComponent({
        fileSizeBytes: 1024n,
        fileHash: hash.toUpperCase(),
        expectedHash: hash
      })
    ])
  });

  const [result] = await service.listAdminRuntimeComponents();

  assert.equal(result.clientDeliverable, true);
  assert.equal(result.clientDeliveryStatus, "ready");
  assert.match(result.clientDeliveryMessage, /可下发/);
}

async function testAdminRuntimeComponentMarksRemoteHashMismatchAsNotDeliverable() {
  const service = createRuntimeComponentsService({
    prisma: makeRuntimeComponentListPrisma([
      makeRemoteComponent({
        fileSizeBytes: 1024n,
        fileHash: "b".repeat(64),
        expectedHash: "a".repeat(64)
      })
    ])
  });

  const [result] = await service.listAdminRuntimeComponents();

  assert.equal(result.clientDeliverable, false);
  assert.equal(result.clientDeliveryStatus, "metadata_mismatch");
  assert.match(result.clientDeliveryMessage, /Hash/);
}

async function testAdminRuntimeComponentShowsFreshBackgroundValidationFailure() {
  const service = createRuntimeComponentsService({
    prisma: makeRuntimeComponentListPrisma(
      [
        makeRemoteComponent({
          expectedHash: "a".repeat(64),
          updatedAt: new Date("2026-01-01T00:00:00.000Z")
        })
      ],
      [
        {
          componentId: "component_1",
          reason: "unreachable",
          message: "Remote validation timed out",
          effectiveUrl: "https://cdn.example.com/xray.exe",
          createdAt: new Date("2026-01-01T00:01:00.000Z")
        }
      ]
    )
  });

  const [result] = await service.listAdminRuntimeComponents();

  assert.equal(result.clientDeliverable, false);
  assert.equal(result.clientDeliveryStatus, "unreachable");
  assert.equal(result.clientDeliveryMessage, "Remote validation timed out");
}

async function testAdminRuntimeComponentIgnoresStaleBackgroundValidationFailure() {
  const service = createRuntimeComponentsService({
    prisma: makeRuntimeComponentListPrisma(
      [
        makeRemoteComponent({
          expectedHash: "a".repeat(64),
          updatedAt: new Date("2026-01-01T00:02:00.000Z")
        })
      ],
      [
        {
          componentId: "component_1",
          reason: "unreachable",
          message: "Old validation timed out",
          effectiveUrl: "https://cdn.example.com/xray.exe",
          createdAt: new Date("2026-01-01T00:01:00.000Z")
        }
      ]
    )
  });

  const [result] = await service.listAdminRuntimeComponents();

  assert.equal(result.clientDeliverable, false);
  assert.equal(result.clientDeliveryStatus, "pending_validation");
  assert.notEqual(result.clientDeliveryMessage, "Old validation timed out");
}

async function testRemoteRuntimeComponentValidationReturnsPendingWithoutWaitingForHashDownload() {
  let validationStarted = false;
  const service = createRuntimeComponentsService({
    prisma: {
      runtimeComponent: {
        findUnique: async () =>
          makeRemoteComponent({
            expectedHash: "a".repeat(64)
          })
      }
    },
    startRemoteRuntimeComponentValidation: () => {
      validationStarted = true;
    }
  });

  const startedAt = Date.now();
  const result = await service.validateAdminRuntimeComponent("component_1");

  assert.equal(validationStarted, true, "remote validation must be delegated to background work");
  assert.ok(Date.now() - startedAt < 100, "remote validation endpoint must return without waiting for remote download");
  assert.equal(result.status, "pending_validation");
  assert.equal(result.componentId, "component_1");
}

async function main() {
  await testUploadedRuntimeComponentRejectsMismatchedExpectedHashOnPatch();
  await testUploadedRuntimeComponentAcceptsMatchingExpectedHashOnPatch();
  await testAdminRuntimeComponentMarksUnverifiedRemoteAsNotDeliverable();
  await testAdminRuntimeComponentMarksMissingUploadedFileAsNotDeliverable();
  await testAdminRuntimeComponentMarksVerifiedRemoteAsDeliverable();
  await testAdminRuntimeComponentMarksRemoteHashMismatchAsNotDeliverable();
  await testAdminRuntimeComponentShowsFreshBackgroundValidationFailure();
  await testAdminRuntimeComponentIgnoresStaleBackgroundValidationFailure();
  await testRemoteRuntimeComponentValidationReturnsPendingWithoutWaitingForHashDownload();
  console.log("runtime component service regression checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
