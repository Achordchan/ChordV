import "reflect-metadata";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RuntimeComponentsService } from "../src/modules/common/runtime-components.service";

function createRuntimeComponentsService(overrides: Record<string, unknown>) {
  return Object.assign(
    Object.create(RuntimeComponentsService.prototype),
    {
      downloadMirrorService: {
        getEffectiveConfig: async () => ({
          defaultMirrorPrefix: null,
          allowClientMirror: true,
          updatedAt: null
        })
      }
    },
    overrides
  ) as RuntimeComponentsService;
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

async function testUploadedRuntimeComponentPatchIgnoresExpectedHash() {
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
  assert.equal(updates[0].data.expectedHash, null);
  assert.equal(updates[0].data.fileHash, undefined, "metadata save must not clear uploaded file metadata");
  assert.equal(result.expectedHash, null);
  assert.equal(result.fileHash, "a".repeat(64));
}

async function testUploadedRuntimeComponentUploadIgnoresExpectedHash() {
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

  assert.equal(cleanupCalled, false, "expectedHash must not fail upload");
  assert.equal(createdData?.expectedHash, null);
  assert.equal(createdData?.fileHash, actualHash);
  assert.equal(result.expectedHash, null);
}

async function testUploadedRuntimeComponentDeliverableIgnoresStaleExpectedHashMismatch() {
  const previousRoot = process.env.CHORDV_RELEASE_STORAGE_ROOT;
  const storageRoot = await fs.mkdtemp(path.join(tmpdir(), "chordv-runtime-components-"));
  try {
    process.env.CHORDV_RELEASE_STORAGE_ROOT = storageRoot;
    const storedFilePath = path.join("component_1", "xray.zip");
    const absolutePath = path.join(storageRoot, "runtime-components", storedFilePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    const body = Buffer.alloc(1024);
    await fs.writeFile(absolutePath, body);
    const actualHash = require("node:crypto").createHash("sha256").update(body).digest("hex");

    const service = createRuntimeComponentsService({
      prisma: makeRuntimeComponentListPrisma([
        makeUploadedComponent({
          storedFilePath,
          fileHash: actualHash,
          // stale expectedHash must not block uploaded deliverability when fileHash is valid
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

async function testAdminRuntimeComponentMarksUnverifiedRemoteAsDeliverable() {
  const service = createRuntimeComponentsService({
    prisma: makeRuntimeComponentListPrisma([makeRemoteComponent({ expectedHash: null, fileSizeBytes: null, fileHash: null })])
  });

  const [result] = await service.listAdminRuntimeComponents();

  assert.equal(result.clientDeliverable, false);
  assert.equal(result.clientDeliveryStatus, "missing_file");
  assert.match(result.clientDeliveryMessage, /SHA-256|校验|不会下发/);
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

async function testAdminRuntimeComponentMarksRemoteHashMismatchAsDeliverable() {
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

  assert.equal(result.clientDeliverable, true);
  assert.equal(result.clientDeliveryStatus, "ready");
  assert.match(result.clientDeliveryMessage, /可下发|有效/);
}

async function testAdminRuntimeComponentIgnoresBackgroundValidationFailureForDelivery() {
  const service = createRuntimeComponentsService({
    prisma: makeRuntimeComponentListPrisma(
      [
        makeRemoteComponent({
          expectedHash: "a".repeat(64)
        })
      ],
      [
        {
          reason: "unreachable",
          message: "远端不可达",
          effectiveUrl: "https://example.com/xray.exe",
          createdAt: new Date()
        }
      ]
    )
  });

  const [result] = await service.listAdminRuntimeComponents();

  assert.equal(result.clientDeliverable, true);
  assert.equal(result.clientDeliveryStatus, "ready");
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

  assert.equal(result.clientDeliverable, true);
  assert.equal(result.clientDeliveryStatus, "ready");
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

  assert.equal(validationStarted, false, "remote validation no longer downloads or hashes remote files");
  assert.ok(Date.now() - startedAt < 100, "remote validation endpoint must return immediately");
  assert.equal(result.status, "ready");
  assert.equal(result.componentId, "component_1");
}


async function testRemoteCreateRequiresValidExpectedHash() {
  const service = createRuntimeComponentsService({
    prisma: {
      runtimeComponent: {
        create: async () => {
          throw new Error("create should not run for invalid expectedHash");
        }
      }
    }
  });
  const input = {
    platform: "windows" as const,
    architecture: "x64" as const,
    kind: "xray" as const,
    source: "custom_remote" as const,
    originUrl: "https://cdn.example.com/xray.exe",
    fileName: "xray.exe"
  };

  await assert.rejects(
    () => service.createAdminRuntimeComponent(input),
    /64 位 SHA-256/
  );
  await assert.rejects(
    () => service.createAdminRuntimeComponent({ ...input, expectedHash: "invalid" }),
    /64 位 SHA-256/
  );
}

async function testRemoteUpdateRejectsInvalidExpectedHash() {
  const service = createRuntimeComponentsService({
    ensureRuntimeComponentExists: async () => makeRemoteComponent({ expectedHash: "a".repeat(64) }),
    prisma: {
      runtimeComponent: {
        update: async () => {
          throw new Error("update should not run for invalid expectedHash");
        }
      }
    }
  });

  await assert.rejects(
    () => service.updateAdminRuntimeComponent("component_1", { expectedHash: "invalid" }),
    /64 位 SHA-256/
  );
}

async function testLegacyRemoteWithoutHashAllowsUnrelatedPatch() {
  const updates: Array<Record<string, any>> = [];
  const current = makeRemoteComponent({ expectedHash: null });
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
    withRuntimeComponentIdentityConflictGuard: async (task: () => Promise<unknown>) => task(),
    startSharedRulesetDuplicatesCleanup: () => undefined,
    startRuntimeComponentStoredFileCleanupBestEffort: () => undefined,
    publishRuntimeComponentUpdatedBestEffort: () => undefined
  });

  const result = await service.updateAdminRuntimeComponent("component_1", {
    fileName: "xray-renamed.exe"
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.expectedHash, null);
  assert.equal(result.expectedHash, null);
  assert.equal(result.fileName, "xray-renamed.exe");
}
async function testRemoteOriginUrlChangeRequiresExpectedHash() {
  const service = createRuntimeComponentsService({
    prisma: {
      runtimeComponent: {
        update: async () => {
          throw new Error("update should not be called when expectedHash is missing");
        }
      }
    },
    ensureRuntimeComponentExists: async () =>
      makeRemoteComponent({
        id: "component_1",
        originUrl: "https://cdn.example.com/xray.exe",
        expectedHash: "a".repeat(64)
      }),
    withRuntimeComponentIdentityConflictGuard: async (task: () => Promise<unknown>) => task()
  });

  await assert.rejects(
    () =>
      service.updateAdminRuntimeComponent("component_1", {
        originUrl: "https://cdn.example.com/xray-new.exe"
      }),
    /expectedHash/
  );
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
  await testUploadedRuntimeComponentPatchIgnoresExpectedHash();
  await testUploadedRuntimeComponentUploadIgnoresExpectedHash();
  await testUploadedRuntimeComponentDeliverableIgnoresStaleExpectedHashMismatch();
  await testAdminRuntimeComponentMarksUnverifiedRemoteAsDeliverable();
  await testAdminRuntimeComponentMarksMissingUploadedFileAsNotDeliverable();
  await testAdminRuntimeComponentMarksVerifiedRemoteAsDeliverable();
  await testAdminRuntimeComponentMarksRemoteHashMismatchAsDeliverable();
  await testAdminRuntimeComponentIgnoresBackgroundValidationFailureForDelivery();
  await testAdminRuntimeComponentIgnoresStaleBackgroundValidationFailure();
  await testRemoteRuntimeComponentValidationReturnsPendingWithoutWaitingForHashDownload();
  await testRemoteCreateRequiresValidExpectedHash();
  await testRemoteUpdateRejectsInvalidExpectedHash();
  await testLegacyRemoteWithoutHashAllowsUnrelatedPatch();
  await testRemoteOriginUrlChangeRequiresExpectedHash();
  await testRuntimeComponentMutationsPublishAdminRefreshEvent();
  console.log("runtime component service regression checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
