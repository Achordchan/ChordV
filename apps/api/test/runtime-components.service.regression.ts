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
    prisma: {
      runtimeComponent: {
        findMany: async () => [makeRemoteComponent({ expectedHash: null })]
      }
    }
  });

  const [result] = await service.listAdminRuntimeComponents();

  assert.equal(result.clientDeliverable, false);
  assert.equal(result.clientDeliveryStatus, "pending_validation");
  assert.match(result.clientDeliveryMessage, /不会下发|校验/);
}

async function testAdminRuntimeComponentMarksMissingUploadedFileAsNotDeliverable() {
  const service = createRuntimeComponentsService({
    prisma: {
      runtimeComponent: {
        findMany: async () => [
          makeUploadedComponent({
            storedFilePath: "component_1/definitely-missing.zip"
          })
        ]
      }
    }
  });

  const [result] = await service.listAdminRuntimeComponents();

  assert.equal(result.clientDeliverable, false);
  assert.equal(result.clientDeliveryStatus, "missing_file");
  assert.match(result.clientDeliveryMessage, /文件不可用|不会下发/);
}

async function testAdminRuntimeComponentMarksVerifiedRemoteAsDeliverable() {
  const hash = "a".repeat(64);
  const service = createRuntimeComponentsService({
    prisma: {
      runtimeComponent: {
        findMany: async () => [
          makeRemoteComponent({
            fileSizeBytes: 1024n,
            fileHash: hash.toUpperCase(),
            expectedHash: hash
          })
        ]
      }
    }
  });

  const [result] = await service.listAdminRuntimeComponents();

  assert.equal(result.clientDeliverable, true);
  assert.equal(result.clientDeliveryStatus, "ready");
  assert.match(result.clientDeliveryMessage, /可下发/);
}

async function testAdminRuntimeComponentMarksRemoteHashMismatchAsNotDeliverable() {
  const service = createRuntimeComponentsService({
    prisma: {
      runtimeComponent: {
        findMany: async () => [
          makeRemoteComponent({
            fileSizeBytes: 1024n,
            fileHash: "b".repeat(64),
            expectedHash: "a".repeat(64)
          })
        ]
      }
    }
  });

  const [result] = await service.listAdminRuntimeComponents();

  assert.equal(result.clientDeliverable, false);
  assert.equal(result.clientDeliveryStatus, "metadata_mismatch");
  assert.match(result.clientDeliveryMessage, /Hash/);
}

async function main() {
  await testUploadedRuntimeComponentRejectsMismatchedExpectedHashOnPatch();
  await testUploadedRuntimeComponentAcceptsMatchingExpectedHashOnPatch();
  await testAdminRuntimeComponentMarksUnverifiedRemoteAsNotDeliverable();
  await testAdminRuntimeComponentMarksMissingUploadedFileAsNotDeliverable();
  await testAdminRuntimeComponentMarksVerifiedRemoteAsDeliverable();
  await testAdminRuntimeComponentMarksRemoteHashMismatchAsNotDeliverable();
  console.log("runtime component service regression checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
