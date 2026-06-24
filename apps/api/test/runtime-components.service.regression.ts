import "reflect-metadata";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

async function testUploadedRuntimeComponentPatchUsesActualFileHashWhenExpectedHashDiffers() {
  const updates: Array<Record<string, any>> = [];
  const current = makeUploadedComponent();
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

  const result = await service.updateAdminRuntimeComponent("component_1", { expectedHash: "b".repeat(64) });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.expectedHash, "a".repeat(64));
  assert.equal(updates[0].data.fileHash, undefined, "metadata save must not clear uploaded file metadata");
  assert.equal(result.expectedHash, "a".repeat(64));
  assert.equal(result.fileHash, "a".repeat(64));
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

async function testUploadedRuntimeComponentUploadUsesActualHashWhenExpectedHashDiffers() {
  const actualHash = "a".repeat(64);
  let createdData: Record<string, any> | null = null;
  let cleanupCalled = false;
  const preparedFile = {
    absolutePath: "C:/tmp/xray.zip",
    storedFilePath: "component_1/xray.zip",
    fileName: "xray.zip",
    fileSizeBytes: 1024n,
    fileHash: actualHash,
    downloadUrl: "/api/downloads/runtime-components/component_1"
  };
  const service = createRuntimeComponentsService({
    prepareUploadedRuntimeComponentFile: async () => preparedFile,
    withRuntimeComponentIdentityConflictGuard: async (task: () => Promise<unknown>) => task(),
    prisma: {
      runtimeComponent: {
        create: async (payload: Record<string, any>) => {
          createdData = payload.data;
          return makeUploadedComponent(payload.data);
        }
      }
    },
    startSharedRulesetDuplicatesCleanup: () => undefined,
    removeRuntimeComponentFileBestEffort: async () => {
      cleanupCalled = true;
    }
  });

  const result = await service.uploadAdminRuntimeComponent(
    {
      platform: "windows",
      architecture: "x64",
      kind: "xray",
      fileName: "xray.zip",
      expectedHash: "b".repeat(64),
      enabled: true
    },
    {
      path: "C:/tmp/upload.tmp",
      originalname: "xray.zip",
      size: 1024
    }
  );

  assert.equal(cleanupCalled, false, "mismatched expectedHash must not fail upload and clean the uploaded file");
  assert.equal(createdData?.expectedHash, actualHash);
  assert.equal(createdData?.fileHash, actualHash);
  assert.equal(result.expectedHash, actualHash);
}

async function testUploadedRuntimeComponentDeliverableIgnoresStaleExpectedHashMismatch() {
  const previousRoot = process.env.CHORDV_RELEASE_STORAGE_ROOT;
  const storageRoot = await fs.mkdtemp(path.join(tmpdir(), "chordv-runtime-components-"));
  try {
    process.env.CHORDV_RELEASE_STORAGE_ROOT = storageRoot;
    const storedFilePath = path.join("component_1", "xray.zip");
    const absolutePath = path.join(storageRoot, "runtime-components", storedFilePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, Buffer.alloc(1024));

    const service = createRuntimeComponentsService({
      prisma: makeRuntimeComponentListPrisma([
        makeUploadedComponent({
          storedFilePath,
          expectedHash: "b".repeat(64)
        })
      ])
    });

    const [result] = await service.listAdminRuntimeComponents();

    assert.equal(result.clientDeliverable, true);
    assert.equal(result.clientDeliveryStatus, "ready");
  } finally {
    if (previousRoot === undefined) {
      delete process.env.CHORDV_RELEASE_STORAGE_ROOT;
    } else {
      process.env.CHORDV_RELEASE_STORAGE_ROOT = previousRoot;
    }
    await fs.rm(storageRoot, { recursive: true, force: true });
  }
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

async function testRemoteRuntimeComponentBackgroundValidationPublishesAdminRefreshEvent() {
  let published = false;
  const publishedPromise = new Promise<void>((resolve) => {
    const service = createRuntimeComponentsService({
      logger: {
        warn: () => undefined
      },
      validateRemoteRuntimeComponentHash: async () => ({
        componentId: "component_1",
        status: "ready",
        message: "ready",
        finalUrlPreview: "https://cdn.example.com/xray.exe"
      }),
      adminRuntimeEventsService: {
        publishRuntimeComponentUpdated: () => {
          published = true;
          resolve();
        }
      }
    });

    service["startRemoteRuntimeComponentValidation"](
      "component_1",
      "https://cdn.example.com/xray.exe",
      "a".repeat(64),
      null
    );
  });

  await Promise.race([
    publishedPromise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("runtime component refresh event timed out")), 250))
  ]);

  assert.equal(published, true, "background validation completion should notify admin pages to refresh runtime components");
}

async function testRuntimeComponentMutationsPublishAdminRefreshEvent() {
  let publishedCount = 0;
  const created = makeRemoteComponent({ id: "component_created", expectedHash: "a".repeat(64) });
  const updated = makeRemoteComponent({ id: "component_1", fileName: "xray-new.exe", expectedHash: "b".repeat(64) });
  const service = createRuntimeComponentsService({
    prisma: {
      runtimeComponent: {
        create: async (payload: Record<string, any>) => makeRemoteComponent(payload.data),
        update: async (payload: Record<string, any>) => ({ ...updated, ...payload.data }),
        delete: async () => ({ id: "component_1" })
      }
    },
    adminRuntimeEventsService: {
      publishRuntimeComponentUpdated: () => {
        publishedCount += 1;
      }
    },
    withRuntimeComponentIdentityConflictGuard: async (task: () => Promise<unknown>) => task(),
    ensureRuntimeComponentExists: async () => makeRemoteComponent({ id: "component_1", expectedHash: "a".repeat(64) }),
    findSharedRulesetRecord: async () => null,
    startSharedRulesetDuplicatesCleanup: () => undefined,
    startRuntimeComponentStoredFileCleanupBestEffort: () => undefined
  });

  await service.createAdminRuntimeComponent({
    platform: "windows",
    architecture: "x64",
    kind: "xray",
    source: "custom_remote",
    originUrl: created.originUrl,
    fileName: created.fileName,
    expectedHash: created.expectedHash
  });
  await service.updateAdminRuntimeComponent("component_1", {
    originUrl: "https://cdn.example.com/xray-new.exe",
    fileName: "xray-new.exe",
    expectedHash: "b".repeat(64)
  });
  await service.deleteAdminRuntimeComponent("component_1");

  assert.equal(publishedCount, 3, "runtime component create, update, and delete should notify admin pages");
}

async function main() {
  await testUploadedRuntimeComponentPatchUsesActualFileHashWhenExpectedHashDiffers();
  await testUploadedRuntimeComponentAcceptsMatchingExpectedHashOnPatch();
  await testUploadedRuntimeComponentUploadUsesActualHashWhenExpectedHashDiffers();
  await testUploadedRuntimeComponentDeliverableIgnoresStaleExpectedHashMismatch();
  await testAdminRuntimeComponentMarksUnverifiedRemoteAsNotDeliverable();
  await testAdminRuntimeComponentMarksMissingUploadedFileAsNotDeliverable();
  await testAdminRuntimeComponentMarksVerifiedRemoteAsDeliverable();
  await testAdminRuntimeComponentMarksRemoteHashMismatchAsNotDeliverable();
  await testAdminRuntimeComponentShowsFreshBackgroundValidationFailure();
  await testAdminRuntimeComponentIgnoresStaleBackgroundValidationFailure();
  await testRemoteRuntimeComponentValidationReturnsPendingWithoutWaitingForHashDownload();
  await testRemoteRuntimeComponentBackgroundValidationPublishesAdminRefreshEvent();
  await testRuntimeComponentMutationsPublishAdminRefreshEvent();
  console.log("runtime component service regression checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
