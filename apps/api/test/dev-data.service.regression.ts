import assert from "node:assert/strict";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExecutionContext } from "@nestjs/common";
import * as jwt from "jsonwebtoken";
import { lastValueFrom, throwError } from "rxjs";
import { LEASE_GRACE_SECONDS } from "../src/modules/common/runtime-session.utils";
import { RuntimeSessionService } from "../src/modules/common/runtime-session.service";
import { DevDataService } from "../src/modules/common/dev-data.service";
import { AdminSubscriptionService } from "../src/modules/common/admin-subscription.service";
import { AdminNodeService } from "../src/modules/common/admin-node.service";
import { ClientAccessService } from "../src/modules/common/client-access.service";
import { UsageSyncService } from "../src/modules/usage/usage-sync.service";
import { ReleaseCenterService } from "../src/modules/common/release-center.service";
import { RuntimeComponentsService } from "../src/modules/common/runtime-components.service";
import { ImageBedService } from "../src/modules/common/image-bed.service";
import {
  assertReleaseArtifactClientUsable,
  fetchExternalReleaseArtifactMetadata,
  resolveReleaseArtifactAbsolutePath,
  resolveReleaseArtifactForClient
} from "../src/modules/common/release-center.utils";
import { XuiService } from "../src/modules/xui/xui.service";
import { AuthSessionService } from "../src/modules/common/auth-session.service";
import { ClientRuntimeEventsService } from "../src/modules/common/client-runtime-events.service";
import { ClientAuthGuard } from "../src/modules/common/client-auth.guard";
import { UploadedTempFileCleanupInterceptor } from "../src/modules/common/uploaded-temp-file-cleanup.interceptor";
import { ClientTicketService } from "../src/modules/common/client-ticket.service";
import {
  UpdateAnnouncementDto,
  UpdateNodeDto,
  UpdatePolicyDto,
  UpdateReleaseArtifactDto,
  UpdateReleaseDto,
  UpdateRuntimeComponentDto,
  UpdateTeamDto,
  UpdateUserDto
} from "../src/modules/admin/admin.dto";
import { isAllowedCorsOrigin } from "../src/cors";
import { normalizePanelApiBasePath } from "../src/modules/common/node-import.utils";
import { moveUploadedFile } from "../src/modules/common/upload-file.utils";
import { AnnouncementPolicyService } from "../src/modules/common/announcement-policy.service";
import { runWithSubscriptionUsageLock } from "../src/modules/common/usage-lock.utils";

const GB_IN_BYTES = 1024 ** 3;
const ZIP_CRC32_TABLE = Array.from({ length: 256 }, (_unused, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function createInstance<T>(prototype: object, overrides: Record<string, unknown> = {}) {
  return Object.assign(Object.create(prototype), overrides) as T & Record<string, unknown>;
}

async function testSubscriptionUsageLockIsReentrantForNestedPanelSync() {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  let innerRan = false;

  try {
    const result = await Promise.race([
      runWithSubscriptionUsageLock("subscription_reentrant", async () =>
        runWithSubscriptionUsageLock("subscription_reentrant", async () => {
          innerRan = true;
          return "ok";
        })
      ),
      new Promise<string>((_resolve, reject) => {
        setTimeout(() => reject(new Error("nested subscription usage lock timed out")), 250);
      })
    ]);

    assert.equal(result, "ok");
    assert.equal(innerRan, true);
  } finally {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  }
}

async function testPanelSyncJobRemoteCallDoesNotWaitForSubscriptionUsageLock() {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  let releaseOuterLock!: () => void;
  let ensureCalled = false;
  let completed = false;

  const heldLock = runWithSubscriptionUsageLock(
    "subscription_panel_job",
    async () =>
      new Promise<void>((resolve) => {
        releaseOuterLock = resolve;
      })
  );

  try {
    for (let attempt = 0; !releaseOuterLock && attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const service = createRuntimeSessionService({
      logger: {
        warn: () => undefined
      },
      prisma: {
        subscription: {
          findUnique: async () => ({ expireAt: new Date(Date.now() + 86_400_000) })
        },
        panelClientBinding: {
          update: async () => ({})
        },
        panelSyncJob: {
          update: async () => {
            completed = true;
            return {};
          }
        },
        $transaction: async (operations: Array<Promise<unknown>>) => Promise.all(operations)
      },
      xuiService: {
        ensureClient: async () => {
          ensureCalled = true;
          return { uuid: "panel_client_1", inboundId: 100 };
        }
      }
    });

    const result = await Promise.race([
      (service as any).runPanelSyncJob({
        id: "job_1",
        action: "ensure_client",
        attempts: 0,
        subscriptionId: "subscription_panel_job",
        userId: "user_1",
        teamId: null,
        nodeId: "node_1",
        bindingId: "binding_1",
        panelClientEmail: "user@example.com",
        panelClientId: "panel_client_1",
        panelInboundId: 100,
        panelBaseUrl: "https://panel.example.com",
        panelApiBasePath: "/panel",
        panelUsername: "admin",
        panelPassword: "secret",
        node: {
          id: "node_1",
          name: "Node 1",
          flow: "",
          isActive: true,
          panelEnabled: true,
          panelBaseUrl: "https://panel.example.com",
          panelApiBasePath: "/panel",
          panelUsername: "admin",
          panelPassword: "secret",
          panelInboundId: 100
        },
        binding: {
          status: "active"
        }
      }).then(() => "completed"),
      new Promise<string>((_resolve, reject) => {
        setTimeout(() => reject(new Error("panel sync job waited for subscription usage lock")), 250);
      })
    ]);

    assert.equal(result, "completed");
    assert.equal(ensureCalled, true);
    assert.equal(completed, true);
  } finally {
    if (releaseOuterLock) {
      releaseOuterLock();
    }
    await heldLock;
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  }
}

async function testUpdateNodeAccessAllowsNestedPanelAccessSyncLock() {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const createdRows: Array<Record<string, any>> = [];
  const node = {
    id: "node_1",
    name: "node",
    countryCode: "US",
    region: "Los Angeles",
    provider: "provider",
    tags: [],
    isActive: true,
    recommended: true,
    latencyMs: 0,
    probeLatencyMs: null,
    protocol: "vless",
    security: "reality"
  };

  try {
    const service = createDevDataService({
      logger: {
        warn: () => undefined
      },
      requireSubscription: async () => ({
        id: "subscription_nested_sync",
        userId: "user_1",
        teamId: null
      }),
      prisma: {
        subscriptionNodeAccess: {
          findMany: async (payload: { select?: unknown }) => {
            if (payload.select) {
              return [];
            }
            return [{ nodeId: "node_1", node }];
          },
          createMany: async (payload: Record<string, any>) => {
            createdRows.push(payload);
          }
        },
        node: {
          findMany: async () => [node]
        }
      },
      runtimeSessionService: {
        syncSubscriptionPanelAccess: async (subscriptionId: string) =>
          runWithSubscriptionUsageLock(subscriptionId, async () => 0)
      },
      publishNodeAccessUpdatedEvent: async () => undefined
    });

    const result = await Promise.race([
      service.updateSubscriptionNodeAccess("subscription_nested_sync", { nodeIds: ["node_1"] }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("updateSubscriptionNodeAccess nested panel sync lock timed out")), 250);
      })
    ]);

    assert.equal(createdRows.length, 1);
    assert.deepEqual(result.nodeIds, ["node_1"]);
  } finally {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  }
}

function createDevDataService(overrides: Record<string, unknown> = {}) {
  return createInstance<DevDataService>(DevDataService.prototype, overrides);
}

function createRuntimeSessionService(overrides: Record<string, unknown> = {}) {
  return createInstance<RuntimeSessionService>(RuntimeSessionService.prototype, overrides);
}

function createUsageSyncService(overrides: Record<string, unknown> = {}) {
  return createInstance<UsageSyncService>(UsageSyncService.prototype, overrides);
}

function createReleaseCenterService(overrides: Record<string, unknown> = {}) {
  return createInstance<ReleaseCenterService>(ReleaseCenterService.prototype, overrides);
}

function createRuntimeComponentsService(overrides: Record<string, unknown> = {}) {
  return createInstance<RuntimeComponentsService>(RuntimeComponentsService.prototype, overrides);
}

function createClientTicketService(overrides: Record<string, unknown> = {}) {
  return createInstance<ClientTicketService>(ClientTicketService.prototype, overrides);
}

function createAdminSubscriptionService(overrides: Record<string, unknown> = {}) {
  return createInstance<AdminSubscriptionService>(AdminSubscriptionService.prototype, overrides);
}

function createBasicTeamRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "team_1",
    name: "Team",
    ownerUserId: "owner_1",
    status: "active",
    createdAt: now,
    updatedAt: now,
    owner: {
      displayName: "Owner",
      email: "owner@example.com"
    },
    members: [],
    subscriptions: [],
    trafficLedgerEntries: [],
    ...overrides
  };
}

function createAuthSessionService(overrides: Record<string, unknown> = {}) {
  return createInstance<AuthSessionService>(AuthSessionService.prototype, overrides);
}

function createClientRuntimeEventsService(overrides: Record<string, unknown> = {}) {
  return createInstance<ClientRuntimeEventsService>(ClientRuntimeEventsService.prototype, overrides);
}

function createAdminNodeService(overrides: Record<string, unknown> = {}) {
  return createInstance<AdminNodeService>(AdminNodeService.prototype, overrides);
}

function createAnnouncementPolicyService(overrides: Record<string, unknown> = {}) {
  return createInstance<AnnouncementPolicyService>(AnnouncementPolicyService.prototype, overrides);
}

function createClientAccessService(overrides: Record<string, unknown> = {}) {
  return createInstance<ClientAccessService>(ClientAccessService.prototype, overrides);
}

function testCrc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ ZIP_CRC32_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZipWithSingleEntry(entryName: string, data: Buffer) {
  const name = Buffer.from(entryName);
  const crc = testCrc32(data);
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(data.length, 18);
  localHeader.writeUInt32LE(data.length, 22);
  localHeader.writeUInt16LE(name.length, 26);

  const centralDirectory = Buffer.alloc(46);
  centralDirectory.writeUInt32LE(0x02014b50, 0);
  centralDirectory.writeUInt16LE(20, 4);
  centralDirectory.writeUInt16LE(20, 6);
  centralDirectory.writeUInt16LE(0, 8);
  centralDirectory.writeUInt16LE(0, 10);
  centralDirectory.writeUInt32LE(crc, 16);
  centralDirectory.writeUInt32LE(data.length, 20);
  centralDirectory.writeUInt32LE(data.length, 24);
  centralDirectory.writeUInt16LE(name.length, 28);

  const centralDirectoryOffset = localHeader.length + name.length + data.length;
  const centralDirectorySize = centralDirectory.length + name.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralDirectorySize, 12);
  end.writeUInt32LE(centralDirectoryOffset, 16);

  return Buffer.concat([localHeader, name, data, centralDirectory, name, end]);
}

async function withPrivateRemoteUrlsAllowed<T>(task: () => Promise<T>) {
  const previous = process.env.CHORDV_ALLOW_PRIVATE_REMOTE_URLS;
  process.env.CHORDV_ALLOW_PRIVATE_REMOTE_URLS = "true";
  try {
    return await task();
  } finally {
    if (previous === undefined) {
      delete process.env.CHORDV_ALLOW_PRIVATE_REMOTE_URLS;
    } else {
      process.env.CHORDV_ALLOW_PRIVATE_REMOTE_URLS = previous;
    }
  }
}

function assertDtoRejectsFieldNull(dtoClass: new () => object, field: string) {
  const errors = validateSync(plainToInstance(dtoClass, { [field]: null }));
  assert(
    errors.some((error) => error.property === field),
    `${dtoClass.name}.${field} must reject null instead of letting service code fail later`
  );
}

async function testImageBedListRejectsSuccessFalsePayload() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ success: false, message: "bad token" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    const service = createInstance<ImageBedService>(ImageBedService.prototype, {
      prisma: {
        systemSetting: {
          findUnique: async () => ({
            value: {
              baseUrl: `http://127.0.0.1:${address.port}`,
              apiToken: "test-token"
            },
            updatedAt: new Date("2026-01-01T00:00:00.000Z")
          })
        }
      }
    });

    await assert.rejects(
      () => service.listAdminFiles(),
      /bad token/,
      "image bed list must reject HTTP 200 business failures instead of showing an empty list"
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testImageBedUploadRejectsSuccessFalsePayload() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        success: false,
        message: "upload rejected",
        fileUrl: "/file/support-tickets/rejected.png"
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");

  const tempDir = await mkdtemp(path.join(tmpdir(), "image-bed-upload-"));
  const filePath = path.join(tempDir, "rejected.png");
  await writeFile(filePath, "image");
  try {
    const service = createInstance<ImageBedService>(ImageBedService.prototype, {
      prisma: {
        systemSetting: {
          findUnique: async () => ({
            value: {
              baseUrl: `http://127.0.0.1:${address.port}`,
              apiToken: "test-token"
            },
            updatedAt: new Date("2026-01-01T00:00:00.000Z")
          })
        }
      }
    });

    await assert.rejects(
      () =>
        service.uploadSupportTicketAttachment({
          path: filePath,
          originalname: "rejected.png",
          mimetype: "image/png",
          size: 5
        }),
      /upload rejected/,
      "image bed upload must reject HTTP 200 business failures even when a URL is present"
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testImageBedDeleteReturnsStructuredBusinessFailure() {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/manage/delete/support-tickets/missing.png");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        success: false,
        fileId: "support-tickets/missing.png",
        deleted: [],
        failed: ["support-tickets/missing.png"]
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    const service = createInstance<ImageBedService>(ImageBedService.prototype, {
      prisma: {
        systemSetting: {
          findUnique: async () => ({
            value: {
              baseUrl: `http://127.0.0.1:${address.port}`,
              apiToken: "test-token"
            },
            updatedAt: new Date("2026-01-01T00:00:00.000Z")
          })
        }
      }
    });

    const result = await service.deleteAdminFile({ path: "support-tickets/missing.png" });

    assert.equal(result.success, false);
    assert.equal(result.fileId, "support-tickets/missing.png");
    assert.deepEqual(result.failed, ["support-tickets/missing.png"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testImageBedAttachmentCleanupLogsDeleteFailure() {
  const warnings: string[] = [];
  const service = createInstance<ImageBedService>(ImageBedService.prototype, {
    logger: {
      warn: (message: string) => warnings.push(message)
    },
    deleteAdminFile: async () => {
      throw new Error("delete failed");
    }
  });

  await service.deleteUploadedSupportTicketAttachmentBestEffort({
    url: "https://image.example.com/file/support-tickets/failed.png",
    providerFileId: "support-tickets/failed.png",
    fileName: "failed.png",
    mimeType: "image/png",
    fileSizeBytes: 123n
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /support-tickets\/failed\.png/);
  assert.match(warnings[0], /delete failed/);
}

async function testUpdateUserPasswordRevokesExistingSessions() {
  const revokeCalls: string[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const service = createAdminSubscriptionService({
    ensureUserExists: async () => ({
      id: "user_1",
      role: "user",
      status: "active"
    }),
    prisma: {
      user: {
        update: async (payload: Record<string, unknown>) => {
          updates.push(payload);
        }
      }
    },
    authSessionService: {
      revokeAllUserSessions: async (userId: string) => {
        revokeCalls.push(userId);
      }
    },
    requireAdminUserRecord: async (userId: string) => ({ id: userId })
  });

  await service.updateUser("user_1", { password: "new-password" });

  assert.equal(updates.length, 1, "admin password reset should update the user row");
  assert.deepEqual(revokeCalls, ["user_1"], "admin password reset must revoke existing access and refresh tokens");
}

async function testUpdateUserRoleRevokesExistingSessions() {
  const revokeCalls: string[] = [];
  const service = createAdminSubscriptionService({
    ensureUserExists: async () => ({
      id: "user_1",
      role: "user",
      status: "active"
    }),
    prisma: {
      user: {
        update: async () => undefined
      }
    },
    authSessionService: {
      revokeAllUserSessions: async (userId: string) => {
        revokeCalls.push(userId);
      }
    },
    requireAdminUserRecord: async (userId: string) => ({ id: userId })
  });

  await service.updateUser("user_1", { role: "admin" });

  assert.deepEqual(revokeCalls, ["user_1"], "role changes must not upgrade existing tokens in-place");
}

async function testUpdateUserKeepsLocalSaveWhenSessionRevocationFails() {
  const updates: Array<Record<string, unknown>> = [];
  const service = createAdminSubscriptionService({
    logger: {
      warn: () => undefined
    },
    ensureUserExists: async () => ({
      id: "user_1",
      role: "user",
      status: "active"
    }),
    prisma: {
      user: {
        update: async (payload: Record<string, unknown>) => {
          updates.push(payload);
        }
      }
    },
    authSessionService: {
      revokeAllUserSessions: async () => {
        throw new Error("session store unavailable");
      }
    },
    requireAdminUserRecord: async (userId: string) => ({ id: userId })
  });

  const result = await service.updateUser("user_1", { role: "admin" });

  assert.equal(updates.length, 1, "local user update must be saved before best-effort session revocation");
  assert.equal(result.id, "user_1");
}

async function testUpdateUserReturnsPendingWhenResponseRefreshFails() {
  const updates: Array<Record<string, unknown>> = [];
  const service = createAdminSubscriptionService({
    logger: {
      warn: () => undefined
    },
    ensureUserExists: async () => ({
      id: "user_1",
      email: "user@example.com",
      displayName: "User",
      role: "user",
      status: "active",
      lastSeenAt: new Date("2026-01-01T00:00:00.000Z"),
      maxConcurrentSessionsOverride: null
    }),
    prisma: {
      user: {
        update: async (payload: Record<string, unknown>) => {
          updates.push(payload);
          return {
            id: "user_1",
            email: "user@example.com",
            displayName: "Renamed",
            role: "user",
            status: "active",
            lastSeenAt: new Date("2026-01-01T00:00:00.000Z"),
            maxConcurrentSessionsOverride: null
          };
        }
      }
    },
    requireAdminUserRecord: async () => {
      throw new Error("user list refresh failed");
    }
  });

  const result = await service.updateUser("user_1", { displayName: "Renamed" });

  assert.equal(updates.length, 1, "local user update must be saved before response refresh");
  assert.equal(result.id, "user_1");
  assert.equal(result.displayName, "Renamed");
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /user list refresh failed/);
}

async function testRefreshTokenLogoutRevokesOnlyCurrentRefreshToken() {
  const refreshUpdates: Array<Record<string, any>> = [];
  const service = createAuthSessionService({
    prisma: {
      refreshToken: {
        findUnique: async (payload: Record<string, any>) => ({
          id: "refresh_1",
          userId: "user_1",
          revokedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
          requestedTokenHash: payload.where.tokenHash
        }),
        updateMany: async (payload: Record<string, any>) => {
          refreshUpdates.push(payload);
        }
      }
    }
  });

  await service.revokeByRefreshToken("refresh-token");

  assert.equal(refreshUpdates.length, 1, "refresh-token logout must revoke the current refresh token");
  assert.equal(refreshUpdates[0].where.id, "refresh_1");
  assert.equal(refreshUpdates[0].where.revokedAt, null);
  assert.ok(refreshUpdates[0].where.expiresAt.gt instanceof Date);
}

async function testAccessTokenLogoutRevokesOnlyBoundSession() {
  const secret = "test-secret-for-auth-session-regression";
  const issuer = "chordv-test";
  const accessToken = jwt.sign(
    {
      sub: "user_1",
      email: "user@example.com",
      role: "user",
      ver: 3,
      sid: "refresh_1"
    },
    secret,
    { issuer, expiresIn: 60 }
  );
  const refreshUpdates: Array<Record<string, any>> = [];
  const service = createAuthSessionService({
    jwtSecret: secret,
    jwtIssuer: issuer,
    prisma: {
      refreshToken: {
        updateMany: async (payload: Record<string, any>) => {
          refreshUpdates.push(payload);
          return { count: 1 };
        }
      }
    }
  });

  await service.revokeByAccessOrRefreshToken(`Bearer ${accessToken}`);

  assert.equal(refreshUpdates.length, 1, "access-token logout must revoke the refresh session bound to that access token");
  assert.equal(refreshUpdates[0].where.id, "refresh_1");
  assert.equal(refreshUpdates[0].where.userId, "user_1");
  assert.equal(refreshUpdates[0].where.revokedAt, null);
  assert.ok(refreshUpdates[0].where.expiresAt.gt instanceof Date);
}

async function testAccessTokenAuthenticationRequiresActiveBoundSession() {
  const secret = "test-secret-for-auth-session-regression";
  const issuer = "chordv-test";
  const accessToken = jwt.sign(
    {
      sub: "user_1",
      email: "user@example.com",
      role: "user",
      ver: 3,
      sid: "refresh_1"
    },
    secret,
    { issuer, expiresIn: 60 }
  );
  const user = {
    id: "user_1",
    email: "user@example.com",
    displayName: "User",
    role: "user" as const,
    status: "active" as const,
    lastSeenAt: new Date(),
    authVersion: 3
  };
  let refreshRow: Record<string, any> | null = {
    userId: "user_1",
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000)
  };
  const service = createAuthSessionService({
    jwtSecret: secret,
    jwtIssuer: issuer,
    prisma: {
      user: {
        findUnique: async () => user
      },
      refreshToken: {
        findUnique: async () => refreshRow
      }
    }
  });

  const profile = await service.authenticateAccessToken(`Bearer ${accessToken}`);
  assert.equal(profile.id, "user_1");

  refreshRow = {
    userId: "user_1",
    revokedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000)
  };
  await assert.rejects(
    () => service.authenticateAccessToken(`Bearer ${accessToken}`),
    /Login session expired/,
    "revoked refresh session must invalidate its already-issued access token"
  );
}

function testRuntimeEventStreamReplaysAfterLastEventId() {
  const service = createClientRuntimeEventsService({
    instanceId: "instance_1",
    subscribers: new Map(),
    replayEventsByUser: new Map(),
    eventSequence: 0,
    prisma: {
      $executeRaw: async () => undefined
    }
  });

  service.publishToUser("user_1", {
    type: "version_updated",
    occurredAt: new Date().toISOString(),
    latestVersion: "1.1.3"
  });
  service.publishToUser("user_1", {
    type: "subscription_updated",
    occurredAt: new Date().toISOString(),
    subscriptionId: "sub_1",
    state: "active"
  });

  const replayStore = (service as any).replayEventsByUser.get("user_1") as Array<{ id: string; data: string }>;
  assert.equal(replayStore.length, 2);
  const received: Array<{ id?: string; data: string }> = [];
  const subscription = service.streamForUser("user_1", { lastEventId: replayStore[0].id }).subscribe((event) => {
    received.push(event as { id?: string; data: string });
  });
  subscription.unsubscribe();

  assert.equal(received[0].id, replayStore[1].id, "stream reconnect must replay events after Last-Event-ID");
  assert.equal(JSON.parse(received[0].data).type, "subscription_updated");
}

async function testRuntimeEventStreamValidatesBeforeDispatch() {
  const service = createClientRuntimeEventsService({
    instanceId: "instance_1",
    subscribers: new Map(),
    replayEventsByUser: new Map(),
    eventSequence: 0,
    prisma: {
      $executeRaw: async () => undefined
    }
  });
  let valid = true;
  const received: Array<{ id?: string; data: string }> = [];
  const errors: Error[] = [];
  const subscription = service.streamForUser("user_1", {
    validate: () => {
      if (!valid) {
        throw new Error("session revoked");
      }
    }
  }).subscribe({
    next: (event) => {
      received.push(event as { id?: string; data: string });
    },
    error: (error) => {
      errors.push(error);
    }
  });
  received.length = 0;
  valid = false;

  service.publishToUser("user_1", {
    type: "version_updated",
    occurredAt: new Date().toISOString(),
    latestVersion: "1.1.3"
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  subscription.unsubscribe();

  assert.equal(received.length, 0, "revoked SSE sessions must not receive business events before the keepalive tick");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /session revoked/);
}

async function testRuntimeEventStreamPreservesOrderWithAsyncValidation() {
  const service = createClientRuntimeEventsService({
    instanceId: "instance_1",
    subscribers: new Map(),
    replayEventsByUser: new Map(),
    eventSequence: 0,
    prisma: {
      $executeRaw: async () => undefined
    }
  });
  let validateCount = 0;
  const receivedTypes: string[] = [];
  const subscription = service.streamForUser("user_1", {
    validate: async () => {
      validateCount += 1;
      if (validateCount === 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }).subscribe((event) => {
    receivedTypes.push(JSON.parse((event as { data: string }).data).type);
  });
  receivedTypes.length = 0;

  service.publishToUser("user_1", {
    type: "version_updated",
    occurredAt: new Date().toISOString(),
    latestVersion: "1.1.3"
  });
  service.publishToUser("user_1", {
    type: "subscription_updated",
    occurredAt: new Date().toISOString(),
    subscriptionId: "sub_1",
    state: "active"
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  subscription.unsubscribe();

  assert.deepEqual(receivedTypes, ["version_updated", "subscription_updated"], "async SSE validation must not reorder business events");
}

function testReleaseArtifactPathTraversalIsRejected() {
  assert.throws(
    () => resolveReleaseArtifactAbsolutePath("../secret.bin"),
    /outside the release storage root/,
    "stored release artifact paths must stay inside the configured storage root"
  );
}

function testUploadedReleaseArtifactDoesNotUseClientMirror() {
  const resolved = resolveReleaseArtifactForClient(
    {
      id: "artifact_1",
      releaseId: "release_1",
      source: "uploaded",
      type: "zip",
      deliveryMode: "desktop_full_replace",
      downloadUrl: "/api/downloads/releases/artifact_1",
      defaultMirrorPrefix: null,
      allowClientMirror: true,
      fileName: "ChordV_1.1.6_x64-full.zip",
      fileSizeBytes: 1024n,
      fileHash: "a".repeat(64),
      isPrimary: true,
      isFullPackage: true,
      createdAt: new Date(),
      updatedAt: new Date()
    },
    "https://mirror.example.com/"
  );

  assert.equal(resolved.downloadUrl, "/api/downloads/releases/artifact_1");
  assert.equal(resolved.allowClientMirror, false);
}

function testReleaseArtifactClientUsableRequiresHashForInstallerDownloads() {
  assert.throws(
    () =>
      assertReleaseArtifactClientUsable(
        {
          id: "artifact_1",
          releaseId: "release_1",
          source: "external",
          type: "setup_exe",
          deliveryMode: "desktop_installer_download",
          downloadUrl: "https://example.com/ChordV-setup.exe",
          originDownloadUrl: null,
          defaultMirrorPrefix: null,
          allowClientMirror: false,
          fileName: "ChordV-setup.exe",
          fileSizeBytes: 1024n,
          fileHash: null,
          isPrimary: true,
          isFullPackage: false,
          createdAt: new Date(),
          updatedAt: new Date()
        },
        "windows"
      ),
    /SHA256/,
    "desktop installer artifacts must not be client-visible without SHA256 metadata"
  );
}

async function testExternalReleaseMetadataRejectsPrivateNetworkUrl() {
  await assert.rejects(
    () => fetchExternalReleaseArtifactMetadata("http://127.0.0.1:9/ChordV-full.zip"),
    /private or reserved/,
    "server-side release artifact probes must not access private network URLs"
  );
}

async function testReleaseDownloadRejectsDraftArtifacts() {
  const service = createReleaseCenterService({
    prisma: {
      releaseArtifact: {
        findUnique: async () => ({
          source: "uploaded",
          storedFilePath: "release_1/artifact_1/file.zip",
          release: { status: "draft" }
        })
      }
    }
  });

  await assert.rejects(
    () => service.getReleaseArtifactDownloadDescriptor("artifact_1"),
    undefined,
    "download descriptor must not expose unpublished release artifacts"
  );
}

async function testReleaseDownloadRejectsUploadedArtifactWithStaleMetadata() {
  const previousReleaseStorageRoot = process.env.CHORDV_RELEASE_STORAGE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), "chordv-release-download-"));
  const storedFilePath = path.join("release_1", "artifact_1", "ChordV.zip");
  process.env.CHORDV_RELEASE_STORAGE_ROOT = tempDir;
  const absolutePath = resolveReleaseArtifactAbsolutePath(storedFilePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, "tampered-package");
  try {
    const service = createReleaseCenterService({
      prisma: {
        releaseArtifact: {
          findUnique: async () => ({
            id: "artifact_1",
            releaseId: "release_1",
            source: "uploaded",
            type: "zip",
            deliveryMode: "desktop_full_replace",
            downloadUrl: "/api/downloads/releases/artifact_1",
            defaultMirrorPrefix: null,
            allowClientMirror: false,
            fileName: "ChordV.zip",
            storedFilePath,
            fileSizeBytes: 1n,
            fileHash: "a".repeat(64),
            isPrimary: true,
            isFullPackage: true,
            createdAt: new Date(),
            updatedAt: new Date(),
            release: { status: "published" }
          })
        }
      }
    });

    await assert.rejects(
      () => service.getReleaseArtifactDownloadDescriptor("artifact_1"),
      /metadata/,
      "download descriptor must not serve tampered uploaded release artifacts"
    );
  } finally {
    if (previousReleaseStorageRoot === undefined) {
      delete process.env.CHORDV_RELEASE_STORAGE_ROOT;
    } else {
      process.env.CHORDV_RELEASE_STORAGE_ROOT = previousReleaseStorageRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testRuntimeDownloadRejectsDisabledComponents() {
  const service = createRuntimeComponentsService({
    prisma: {
      runtimeComponent: {
        findUnique: async () => ({
          source: "uploaded",
          storedFilePath: "component_1/file.zip",
          enabled: false
        })
      }
    }
  });

  await assert.rejects(
    () => service.getRuntimeComponentDownloadDescriptor("component_1"),
    undefined,
    "download descriptor must not expose disabled runtime components"
  );
}

async function testRuntimeDownloadRejectsUploadedComponentWithStaleMetadata() {
  const previousReleaseStorageRoot = process.env.CHORDV_RELEASE_STORAGE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), "chordv-runtime-download-"));
  const storedFilePath = path.join("component_1", "xray.exe");
  process.env.CHORDV_RELEASE_STORAGE_ROOT = tempDir;
  const absolutePath = path.resolve(tempDir, "runtime-components", storedFilePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, "tampered-runtime");
  try {
    const service = createRuntimeComponentsService({
      prisma: {
        runtimeComponent: {
          findUnique: async () => ({
            source: "uploaded",
            storedFilePath,
            enabled: true,
            fileName: "xray.exe",
            fileSizeBytes: 1n,
            fileHash: "a".repeat(64),
            expectedHash: "a".repeat(64)
          })
        }
      }
    });

    await assert.rejects(
      () => service.getRuntimeComponentDownloadDescriptor("component_1"),
      /metadata/,
      "runtime download descriptor must not serve tampered uploaded components"
    );
  } finally {
    if (previousReleaseStorageRoot === undefined) {
      delete process.env.CHORDV_RELEASE_STORAGE_ROOT;
    } else {
      process.env.CHORDV_RELEASE_STORAGE_ROOT = previousReleaseStorageRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testUpdateReleaseDelegatesToReleaseCenter() {
  const calls: Array<{ releaseId: string; input: Record<string, unknown> }> = [];
  const service = createDevDataService({
    releaseCenterService: {
      updateRelease: async (releaseId: string, input: Record<string, unknown>) => {
        calls.push({ releaseId, input });
        return {
          id: releaseId,
          displayTitle: input.displayTitle,
          status: input.status
        };
      }
    }
  });

  const result = await service.updateRelease("release_1", {
    status: "published",
    displayTitle: "版本一"
  });

  assert.equal(calls.length, 1, "DevDataService.updateRelease 应该转发到 releaseCenterService");
  assert.deepEqual(calls[0], {
    releaseId: "release_1",
    input: {
      status: "published",
      displayTitle: "版本一"
    }
  });
  assert.equal(result.id, "release_1");
}

async function testAdminReleaseListAppliesFilters() {
  const findManyPayloads: Array<Record<string, any>> = [];
  const service = createReleaseCenterService({
    prisma: {
      release: {
        findMany: async (payload: Record<string, any>) => {
          findManyPayloads.push(payload);
          return [];
        }
      }
    }
  });

  await service.listAdminReleases({ platform: "windows", status: "published" });

  assert.equal(findManyPayloads.length, 1);
  assert.deepEqual(findManyPayloads[0].where, {
    platform: "windows",
    status: "published"
  });
}

async function testPublishReleaseKeepsLocalSaveWhenVersionEventFails() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const updates: Array<Record<string, any>> = [];
  const service = createReleaseCenterService({
    logger: {
      warn: () => undefined
    },
    assertReleasePublishable: async () => undefined,
    clientEventsPublisher: {
      publishVersionUpdated: async () => {
        throw new Error("version event failed");
      }
    },
    prisma: {
      release: {
        update: async (payload: Record<string, any>) => {
          updates.push(payload);
          return {
            id: "release_1",
            platform: "windows",
            channel: "stable",
            version: "1.1.6",
            displayTitle: "ChordV 1.1.6",
            changelog: [],
            minimumVersion: "1.1.0",
            forceUpgrade: false,
            status: "published",
            publishedAt: now,
            createdAt: now,
            updatedAt: now,
            artifacts: []
          };
        }
      }
    }
  });

  const result = await service.publishRelease("release_1");

  assert.equal(updates.length, 1);
  assert.equal(result.status, "published");
}

async function testCreateReleaseArtifactDelegatesToReleaseCenter() {
  const calls: Array<{ releaseId: string; input: Record<string, unknown> }> = [];
  const service = createDevDataService({
    releaseCenterService: {
      createReleaseArtifact: async (releaseId: string, input: Record<string, unknown>) => {
        calls.push({ releaseId, input });
        return {
          id: releaseId,
          artifacts: [input]
        };
      }
    }
  });

  const result = await service.createReleaseArtifact("release_1", {
    source: "external",
    type: "setup.exe",
    downloadUrl: "https://example.com/ChordV_1.0.6_x64-setup.exe"
  });

  assert.equal(calls.length, 1, "DevDataService.createReleaseArtifact 应该转发到 releaseCenterService");
  assert.equal(calls[0]?.releaseId, "release_1");
  assert.equal(result.id, "release_1");
}

async function testConvertToTeamDelegatesToAdminSubscriptionService() {
  const calls: Array<{ subscriptionId: string; input: Record<string, unknown> }> = [];
  const service = createDevDataService({
    adminSubscriptionService: {
      convertPersonalSubscriptionToTeam: async (subscriptionId: string, input: Record<string, unknown>) => {
        calls.push({ subscriptionId, input });
        return {
          sourceSubscriptionId: subscriptionId,
          targetTeamId: input.targetTeamId
        };
      }
    }
  });

  const result = await service.convertPersonalSubscriptionToTeam("sub_personal", { targetTeamId: "team_1" });
  assert.deepEqual(calls, [
    {
      subscriptionId: "sub_personal",
      input: { targetTeamId: "team_1" }
    }
  ]);
  assert.equal(result.sourceSubscriptionId, "sub_personal");
}

async function testValidateReleaseArtifactDelegatesToReleaseCenter() {
  const calls: Array<{ releaseId: string; artifactId: string }> = [];
  const service = createDevDataService({
    releaseCenterService: {
      validateReleaseArtifact: async (releaseId: string, artifactId: string) => {
        calls.push({ releaseId, artifactId });
        return {
          status: "ready",
          artifactId,
          releaseId
        };
      }
    }
  });

  const result = await service.validateReleaseArtifact("release_1", "artifact_1");
  assert.equal(result.status, "ready");
  assert.deepEqual(calls, [{ releaseId: "release_1", artifactId: "artifact_1" }]);
}

async function testHeartbeatWithinTtlSucceeds() {
  const updates: Array<Record<string, unknown>> = [];
  const service = createRuntimeSessionService({
    resolveActiveUserFromToken: async () => ({ id: "user_1" }),
    assertLeaseCanHeartbeat: async () => undefined,
    logLeaseWarning: () => undefined,
    prisma: {
      nodeSessionLease: {
        findUnique: async () => ({
          id: "lease_1",
          sessionId: "session_1",
          userId: "user_1",
          subscriptionId: "sub_1",
          nodeId: "node_1",
          status: "active",
          expiresAt: new Date(Date.now() + 20_000),
          revokedReason: null,
          xrayUserEmail: "demo@example.com",
          xrayUserUuid: "uuid_1",
          node: { id: "node_1", flow: "" }
        }),
        updateMany: async (payload: Record<string, unknown>) => {
          updates.push(payload);
          return { count: 1 };
        }
      }
    }
  });

  const result = await service.heartbeatSession("session_1");

  assert.equal(result.status, "active");
  assert.equal(updates.length, 1, "TTL 内心跳应该成功续租");
  assert.equal(updates[0]?.data?.status, "active");
  assert.equal(updates[0]?.data?.revokedReason, null);
  assert.ok(
    new Date(String(result.leaseExpiresAt)).getTime() > Date.now(),
    "续租后的过期时间应该晚于当前时间"
  );
}

async function testHeartbeatWithinGraceStillSucceeds() {
  const updates: Array<Record<string, unknown>> = [];
  const service = createRuntimeSessionService({
    resolveActiveUserFromToken: async () => ({ id: "user_1" }),
    assertLeaseCanHeartbeat: async () => undefined,
    logLeaseWarning: () => undefined,
    prisma: {
      nodeSessionLease: {
        findUnique: async () => ({
          id: "lease_2",
          sessionId: "session_2",
          userId: "user_1",
          subscriptionId: "sub_1",
          nodeId: "node_1",
          status: "active",
          expiresAt: new Date(Date.now() - 5_000),
          revokedReason: null,
          xrayUserEmail: "demo@example.com",
          xrayUserUuid: "uuid_2",
          node: { id: "node_1", flow: "" }
        }),
        updateMany: async (payload: Record<string, unknown>) => {
          updates.push(payload);
          return { count: 1 };
        }
      }
    }
  });

  const result = await service.heartbeatSession("session_2");

  assert.equal(result.status, "active");
  assert.equal(updates.length, 1, "超过 TTL 但仍在 grace 内时，心跳应继续成功");
  assert.equal(updates[0]?.data?.status, "active");
  assert.equal(updates[0]?.data?.revokedReason, null);
}

async function testHeartbeatBeyondGraceFailsWithLeaseExpired() {
  const revoked: Array<{ leaseId: string; reason: string }> = [];
  const service = createRuntimeSessionService({
    resolveActiveUserFromToken: async () => ({ id: "user_1" }),
    assertLeaseCanHeartbeat: async () => undefined,
    logLeaseWarning: () => undefined,
    revokeLease: async (leaseId: string, _node: unknown, reason: string) => {
      revoked.push({ leaseId, reason });
    },
    prisma: {
      nodeSessionLease: {
        findUnique: async () => ({
          id: "lease_3",
          sessionId: "session_3",
          userId: "user_1",
          subscriptionId: "sub_1",
          nodeId: "node_1",
          status: "active",
          expiresAt: new Date(Date.now() - (LEASE_GRACE_SECONDS * 1000 + 5_000)),
          revokedReason: null,
          xrayUserEmail: "demo@example.com",
          xrayUserUuid: "uuid_3",
          node: { id: "node_1", flow: "" }
        })
      }
    }
  });

  await assert.rejects(() => service.heartbeatSession("session_3"), /会话已过期/);

  assert.deepEqual(revoked, [{ leaseId: "lease_3", reason: "lease_expired" }], "超过 TTL + grace 后，心跳应走统一回收逻辑");
}

async function testGetActiveRuntimeRebuildsXuiLeaseFromDatabaseTruth() {
  const service = createRuntimeSessionService({
    resolveActiveUserFromToken: async () => ({ id: "user_1" }),
    prisma: {
      nodeSessionLease: {
        findFirst: async () => ({
          id: "lease_xui",
          sessionId: "session_xui",
          userId: "user_1",
          subscriptionId: "sub_1",
          nodeId: "node_1",
          status: "active",
          lastHeartbeatAt: new Date("2026-03-26T10:00:00.000Z"),
          expiresAt: new Date(Date.now() + 20_000),
          updatedAt: new Date("2026-03-26T10:00:00.000Z"),
          revokedReason: null,
          xrayUserEmail: "user@example.com",
          xrayUserUuid: "panel_uuid",
          node: {
            id: "node_1",
            name: "节点一",
            region: "香港",
            provider: "demo",
            tags: [],
            recommended: true,
            latencyMs: 20,
            protocol: "vless",
            security: "reality",
            serverHost: "xui.example.com",
            serverPort: 443,
            flow: "xtls-rprx-vision",
            realityPublicKey: "pub",
            shortId: "sid",
            serverName: "sn",
            fingerprint: "chrome",
            spiderX: "/"
          }
        })
      },
      subscription: {
        findUnique: async () => ({
          id: "sub_1",
          userId: "user_1",
          teamId: null,
          state: "active",
          remainingTrafficGb: 10,
          expireAt: new Date(Date.now() + 86_400_000),
          user: { id: "user_1", status: "active" },
          team: null,
          nodeAccesses: [{ nodeId: "node_1" }]
        })
      },
      panelClientBinding: {
        findFirst: async () => ({
          id: "binding_1",
          subscriptionId: "sub_1",
          userId: "user_1",
          nodeId: "node_1",
          status: "active",
          panelClientEmail: "user@example.com",
          panelClientId: "panel_uuid"
        })
      },
      policyProfile: {
        findUnique: async () => ({
          blockAds: true,
          chinaDirect: false,
          aiServicesProxy: true
        })
      }
    }
  });

  const result = await service.getActiveRuntime("session_xui");

  assert.ok(result, "xui 会话应该支持按数据库恢复");
  assert.equal(result?.sessionId, "session_xui");
  assert.equal(result?.outbound.server, "xui.example.com");
  assert.equal(result?.outbound.uuid, "panel_uuid");
}

async function testGetActiveRuntimeRevokesDisabledUserLease() {
  const revoked: Array<{ leaseId: string; reason: string }> = [];
  const service = createRuntimeSessionService({
    logger: {
      warn: () => undefined
    },
    resolveActiveUserFromToken: async () => ({ id: "user_1" }),
    revokeLease: async (leaseId: string, _node: unknown, reason: string) => {
      revoked.push({ leaseId, reason });
    },
    prisma: {
      nodeSessionLease: {
        findFirst: async () => ({
          id: "lease_disabled",
          sessionId: "session_disabled",
          userId: "user_1",
          subscriptionId: "sub_1",
          nodeId: "node_1",
          status: "active",
          lastHeartbeatAt: new Date("2026-03-26T10:00:00.000Z"),
          expiresAt: new Date(Date.now() + 20_000),
          updatedAt: new Date("2026-03-26T10:00:00.000Z"),
          revokedReason: null,
          xrayUserEmail: "user@example.com",
          xrayUserUuid: "panel_uuid",
          node: { id: "node_1", flow: "" }
        })
      },
      subscription: {
        findUnique: async () => ({
          id: "sub_1",
          userId: "user_1",
          teamId: null,
          state: "active",
          remainingTrafficGb: 10,
          expireAt: new Date(Date.now() + 86_400_000),
          user: { id: "user_1", status: "disabled" },
          team: null,
          nodeAccesses: [{ nodeId: "node_1" }]
        })
      }
    }
  });

  const result = await service.getActiveRuntime("session_disabled");

  assert.equal(result, null, "disabled user must not keep an active runtime after process restart");
  assert.deepEqual(revoked, [{ leaseId: "lease_disabled", reason: "subscription_user_disabled" }]);
}

async function testHeartbeatUpdatesCachedRuntimeLeaseExpiry() {
  const service = createRuntimeSessionService({
    activeRuntime: {
      sessionId: "session_cache",
      leaseId: "lease_cache",
      leaseExpiresAt: new Date(Date.now() + 5_000).toISOString(),
      leaseHeartbeatIntervalSeconds: 30,
      leaseGraceSeconds: 300,
      node: {
        id: "node_1",
        name: "节点一",
        region: "香港",
        provider: "demo",
        tags: [],
        recommended: true,
        latencyMs: 20,
        protocol: "vless",
        security: "reality"
      },
      mode: "rule",
      localHttpPort: 17890,
      localSocksPort: 17891,
      routingProfile: "managed-rule-default",
      generatedAt: new Date("2026-03-26T10:00:00.000Z").toISOString(),
      features: {
        blockAds: true,
        chinaDirect: true,
        aiServicesProxy: true
      },
      outbound: {
        protocol: "vless",
        server: "xui.example.com",
        port: 443,
        uuid: "panel_uuid",
        flow: "xtls-rprx-vision",
        realityPublicKey: "pub",
        shortId: "sid",
        serverName: "sn",
        fingerprint: "chrome",
        spiderX: "/"
      }
    },
    resolveActiveUserFromToken: async () => ({ id: "user_1" }),
    assertLeaseCanHeartbeat: async () => undefined,
    logLeaseWarning: () => undefined,
    prisma: {
      nodeSessionLease: {
        findUnique: async () => ({
          id: "lease_cache",
          sessionId: "session_cache",
          userId: "user_1",
          subscriptionId: "sub_1",
          nodeId: "node_1",
          status: "active",
          expiresAt: new Date(Date.now() + 5_000),
          revokedReason: null,
          xrayUserEmail: "demo@example.com",
          xrayUserUuid: "panel_uuid",
          node: { id: "node_1", flow: "" }
        }),
        updateMany: async () => ({ count: 1 })
      }
    }
  });

  const result = await service.heartbeatSession("session_cache");
  const cached = service["activeRuntime"];

  assert.ok(cached, "成功续租后应该保留缓存运行态");
  assert.equal(cached?.sessionId, "session_cache");
  assert.equal(cached?.leaseExpiresAt, result.leaseExpiresAt, "缓存过期时间应该与心跳结果保持一致");
}

async function testRevokeLeaseClearsCachedRuntime() {
  const service = createRuntimeSessionService({
    activeRuntime: {
      sessionId: "session_revoke",
      leaseId: "lease_revoke",
      leaseExpiresAt: new Date(Date.now() + 5_000).toISOString(),
      leaseHeartbeatIntervalSeconds: 30,
      leaseGraceSeconds: 300,
      node: {
        id: "node_1",
        name: "节点一",
        region: "香港",
        provider: "demo",
        tags: [],
        recommended: true,
        latencyMs: 20,
        protocol: "vless",
        security: "reality"
      },
      mode: "rule",
      localHttpPort: 17890,
      localSocksPort: 17891,
      routingProfile: "managed-rule-default",
      generatedAt: new Date("2026-03-26T10:00:00.000Z").toISOString(),
      features: {
        blockAds: true,
        chinaDirect: true,
        aiServicesProxy: true
      },
      outbound: {
        protocol: "vless",
        server: "xui.example.com",
        port: 443,
        uuid: "panel_uuid",
        flow: "xtls-rprx-vision",
        realityPublicKey: "pub",
        shortId: "sid",
        serverName: "sn",
        fingerprint: "chrome",
        spiderX: "/"
      }
    },
    activeRuntimeUsageContext: {
      subscriptionId: "sub_1",
      nodeId: "node_1",
      userId: "user_1",
      teamId: null
    },
    clientRuntimeEventsService: {
      publishToUser: () => undefined
    },
    prisma: {
      nodeSessionLease: {
        findUnique: async () => ({
          id: "lease_revoke",
          sessionId: "session_revoke",
          userId: "user_1",
          subscriptionId: "sub_1",
          nodeId: "node_1",
          status: "active"
        }),
        updateMany: async () => ({ count: 1 })
      },
      securityEvent: {
        create: async () => undefined
      }
    }
  });

  await service["revokeLease"]("lease_revoke", { id: "node_1", flow: "" }, "revoked_by_client");

  assert.equal(service["activeRuntime"], undefined, "revoke 后应该清空缓存运行态");
  assert.equal(service.getActiveRuntimeUsageContext(), null, "revoke 后应该清空缓存使用上下文");
}

async function testDisconnectDoesNotExposeOtherUsersCachedRuntime() {
  const service = createRuntimeSessionService({
    activeRuntime: {
      sessionId: "session_user_a"
    },
    activeRuntimeUsageContext: {
      subscriptionId: "sub_a",
      nodeId: "node_a",
      userId: "user_a",
      teamId: null
    },
    resolveActiveUserFromToken: async () => ({ id: "user_b" }),
    prisma: {
      nodeSessionLease: {
        findUnique: async () => null
      }
    }
  });

  const result = await service.disconnect("any_other_session", "Bearer token");

  assert.equal(result.previousSessionId, null, "disconnect must not leak another user's cached session id");
  assert.equal(service["activeRuntime"]?.sessionId, "session_user_a", "disconnect must not clear another user's cached runtime");
}

async function testSweepExpiredLeasesDoesNotRevokeTooEarly() {
  const revokedLeaseIds: string[] = [];
  const softExpiredLease = {
    id: "lease_soft",
    sessionId: "session_soft",
    status: "active",
    expiresAt: new Date(Date.now() - Math.max(1_000, Math.floor((LEASE_GRACE_SECONDS * 1000) / 2))),
    lastHeartbeatAt: new Date(),
    revokedReason: null,
    node: { id: "node_1", flow: "" }
  };
  const hardExpiredLease = {
    id: "lease_hard",
    sessionId: "session_hard",
    status: "active",
    expiresAt: new Date(Date.now() - (LEASE_GRACE_SECONDS * 1000 + 5_000)),
    lastHeartbeatAt: new Date(),
    revokedReason: null,
    node: { id: "node_1", flow: "" }
  };

  const service = createRuntimeSessionService({
    logLeaseWarning: () => undefined,
    revokeLease: async (leaseId: string) => {
      revokedLeaseIds.push(leaseId);
    },
    prisma: {
      nodeSessionLease: {
        findMany: async ({ where }: { where: { expiresAt: { lt: Date } } }) => {
          const cutoff = where.expiresAt.lt.getTime();
          return [softExpiredLease, hardExpiredLease].filter((lease) => lease.expiresAt.getTime() < cutoff);
        }
      }
    }
  });

  await service.sweepExpiredLeases();

  assert.deepEqual(revokedLeaseIds, ["lease_hard"], "sweepExpiredLeases 只能回收超过 TTL + grace 的租约");
}

async function testPanelDisableJobDoesNotPreDisableBinding() {
  let bindingUpdateManyCalled = false;
  const upserts: Array<Record<string, unknown>> = [];
  const service = createRuntimeSessionService({
    prisma: {
      panelClientBinding: {
        findMany: async () => [
          {
            id: "binding_1",
            subscriptionId: "sub_1",
            userId: "user_1",
            teamId: null,
            nodeId: "node_1",
            panelClientEmail: "user@example.com",
            panelClientId: "panel_client_1",
            panelInboundId: 1
          }
        ],
        updateMany: async () => {
          bindingUpdateManyCalled = true;
          return { count: 1 };
        }
      },
      panelSyncJob: {
        upsert: async (payload: Record<string, unknown>) => {
          upserts.push(payload);
          return {};
        }
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          panelClientBinding: {
            findMany: async () => [
              {
                id: "binding_1",
                subscriptionId: "sub_1",
                userId: "user_1",
                teamId: null,
                nodeId: "node_1",
                panelClientEmail: "user@example.com",
                panelClientId: "panel_client_1",
                panelInboundId: 1
              }
            ]
          },
          panelSyncJob: {
            upsert: async (payload: Record<string, unknown>) => {
              upserts.push(payload);
              return {};
            }
          }
        })
    }
  });

  const count = await service.markPanelBindingsDisabledForSubscription("sub_1");

  assert.equal(count, 1);
  assert.equal(bindingUpdateManyCalled, false, "disable queue must not mark binding disabled before 3x-ui confirms it");
  assert.equal(upserts.length, 1);
}

async function testLeaseRevocationKeepsLocalStateWhenRuntimeEventPublishFails() {
  const updates: Array<Record<string, unknown>> = [];
  const securityEvents: Array<Record<string, unknown>> = [];
  const service = createRuntimeSessionService({
    logger: {
      warn: () => undefined
    },
    clientRuntimeEventsService: {
      publishToUser: () => {
        throw new Error("sse unavailable");
      }
    },
    prisma: {
      nodeSessionLease: {
        findMany: async () => [
          {
            id: "lease_1",
            userId: "user_1",
            subscriptionId: "sub_1",
            nodeId: "node_1",
            sessionId: "session_1",
            status: "active",
            expiresAt: new Date(Date.now() + 60_000),
            node: { id: "node_1", flow: "" }
          }
        ],
        findUnique: async () => ({
          id: "lease_1",
          userId: "user_1",
          subscriptionId: "sub_1",
          nodeId: "node_1",
          sessionId: "session_1",
          status: "active"
        }),
        updateMany: async (payload: Record<string, unknown>) => {
          updates.push(payload);
          return { count: 1 };
        }
      },
      securityEvent: {
        create: async (payload: Record<string, unknown>) => {
          securityEvents.push(payload);
          return {};
        }
      }
    }
  });

  const count = await service.revokeSubscriptionLeases("sub_1", "node_access_revoked", { nodeIds: ["node_1"] });

  assert.equal(count, 1);
  assert.equal(updates.length, 1, "lease must be locally revoked before runtime event publish");
  assert.equal(securityEvents.length, 1, "security event must be recorded even when runtime event publish fails");
}

async function testPanelDisableJobCallsXuiEvenWhenNodeInactive() {
  const xuiCalls: Array<{ panelClientId: string; enabled: boolean }> = [];
  const bindingUpdates: Array<Record<string, unknown>> = [];
  const jobUpdates: Array<Record<string, unknown>> = [];
  const service = createRuntimeSessionService({
    xuiService: {
      setClientEnabled: async (_node: unknown, panelClientId: string, _email: string, enabled: boolean) => {
        xuiCalls.push({ panelClientId, enabled });
      }
    },
    prisma: {
      panelClientBinding: {
        update: async (payload: Record<string, unknown>) => {
          bindingUpdates.push(payload);
          return {};
        }
      },
      panelSyncJob: {
        findUnique: async () => ({
          id: "job_1",
          userId: "user_1",
          teamId: null,
          binding: {
            status: "active",
            user: { status: "active" }
          },
          node: {
            isActive: false,
            panelEnabled: false
          },
          subscription: {
            userId: "user_1",
            teamId: null,
            state: "active",
            expireAt: new Date(Date.now() + 86_400_000),
            remainingTrafficGb: 10,
            user: { status: "active" },
            team: null,
            nodeAccesses: []
          }
        }),
        update: async (payload: Record<string, unknown>) => {
          jobUpdates.push(payload);
          return {};
        }
      },
      $transaction: async (operations: Array<Promise<unknown>>) => {
        await Promise.all(operations);
      }
    }
  });

  await service["runPanelSyncJob"]({
    id: "job_1",
    action: "disable_client",
    attempts: 0,
    bindingId: "binding_1",
    subscriptionId: "sub_1",
    nodeId: "node_1",
    panelClientEmail: "user@example.com",
    panelClientId: "panel_client_1",
    node: {
      id: "node_1",
      isActive: false,
      panelEnabled: false,
      panelBaseUrl: "https://panel.example.com",
      panelApiBasePath: "/",
      panelUsername: "admin",
      panelPassword: "password",
      panelInboundId: 1
    },
    binding: {
      status: "active"
    }
  });

  assert.deepEqual(xuiCalls, [{ panelClientId: "panel_client_1", enabled: false }]);
  assert.equal(bindingUpdates.length, 1, "binding status should change only after 3x-ui disable succeeds");
  assert.equal(jobUpdates.length, 1, "panel sync job should be completed after remote disable succeeds");
}

async function testPanelDisableJobRechecksEligibilityBeforeRemoteDisable() {
  const xuiCalls: Array<{ panelClientId: string; enabled: boolean }> = [];
  const jobUpdates: Array<Record<string, unknown>> = [];
  const freshJobs = [
    {
      id: "job_1",
      userId: "user_1",
      teamId: null,
      binding: {
        status: "active",
        user: { status: "active" }
      },
      node: {
        isActive: false,
        panelEnabled: false
      },
      subscription: {
        userId: "user_1",
        teamId: null,
        state: "active",
        expireAt: new Date(Date.now() + 86_400_000),
        remainingTrafficGb: 10,
        user: { status: "active" },
        team: null,
        nodeAccesses: []
      }
    },
    {
      id: "job_1",
      userId: "user_1",
      teamId: null,
      binding: {
        status: "active",
        user: { status: "active" }
      },
      node: {
        isActive: true,
        panelEnabled: true
      },
      subscription: {
        userId: "user_1",
        teamId: null,
        state: "active",
        expireAt: new Date(Date.now() + 86_400_000),
        remainingTrafficGb: 10,
        user: { status: "active" },
        team: null,
        nodeAccesses: [{ nodeId: "node_1" }]
      }
    }
  ];
  const service = createRuntimeSessionService({
    xuiService: {
      setClientEnabled: async (_node: unknown, panelClientId: string, _email: string, enabled: boolean) => {
        xuiCalls.push({ panelClientId, enabled });
      }
    },
    prisma: {
      panelSyncJob: {
        findUnique: async () => freshJobs.shift(),
        update: async (payload: Record<string, unknown>) => {
          jobUpdates.push(payload);
          return {};
        }
      }
    }
  });

  await service["runPanelSyncJob"]({
    id: "job_1",
    action: "disable_client",
    attempts: 0,
    bindingId: "binding_1",
    subscriptionId: "sub_1",
    nodeId: "node_1",
    panelClientEmail: "user@example.com",
    panelClientId: "panel_client_1",
    panelInboundId: 7,
    node: {
      id: "node_1",
      isActive: false,
      panelEnabled: false,
      panelBaseUrl: "https://panel.example.com",
      panelApiBasePath: "/",
      panelUsername: "admin",
      panelPassword: "password",
      panelInboundId: 7
    },
    binding: {
      status: "active"
    }
  });

  assert.deepEqual(xuiCalls, [], "restored node access must stop a stale disable job before the remote panel call");
  assert.equal((jobUpdates[0] as any)?.data?.status, "completed");
}

async function testLeaseRevocationJobQueuePersistsRevocationTarget() {
  const upserts: Array<Record<string, any>> = [];
  const service = createRuntimeSessionService({});

  await service.queueLeaseRevocationJobsForSubscriptionTx(
    {
      leaseRevocationJob: {
        upsert: async (payload: Record<string, any>) => {
          upserts.push(payload);
        }
      }
    },
    "sub_1",
    "node_access_revoked",
    { userId: "user_1", nodeIds: ["node_1"] }
  );

  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].create.subscriptionId, "sub_1");
  assert.equal(upserts[0].create.userId, "user_1");
  assert.equal(upserts[0].create.nodeId, "node_1");
  assert.equal(upserts[0].create.reason, "node_access_revoked");
}

async function testLeaseRevocationJobRetriesFailedRevocation() {
  const updates: Array<Record<string, any>> = [];
  const service = createRuntimeSessionService({
    logger: {
      warn: () => undefined
    },
    revokeSubscriptionLeases: async () => {
      throw new Error("lease store unavailable");
    },
    prisma: {
      leaseRevocationJob: {
        update: async (payload: Record<string, any>) => {
          updates.push(payload);
        }
      }
    }
  });

  await service["runLeaseRevocationJob"]({
    id: "lease_job_1",
    attempts: 0,
    subscriptionId: "sub_1",
    userId: "user_1",
    nodeId: "node_1",
    reason: "node_access_revoked"
  });

  assert.equal(updates[0].data.status, "failed");
  assert.match(updates[0].data.lastError, /lease store unavailable/);
}

async function testClearPendingPanelDisableJobsOnlyClearsRestoredNodeAccess() {
  let clearedIds: string[] = [];
  const service = createRuntimeSessionService({
    prisma: {
      panelSyncJob: {
        findMany: async () => [
          {
            id: "job_restored",
            userId: "user_1",
            teamId: null,
            binding: {
              status: "active",
              user: { status: "active" }
            },
            node: {
              isActive: true,
              panelEnabled: true
            },
            subscription: {
              userId: "user_1",
              teamId: null,
              state: "active",
              expireAt: new Date(Date.now() + 86_400_000),
              remainingTrafficGb: 10,
              user: { status: "active" },
              team: null,
              nodeAccesses: [{ nodeId: "node_1" }]
            }
          },
          {
            id: "job_user_disabled",
            userId: "user_2",
            teamId: null,
            binding: {
              status: "active",
              user: { status: "disabled" }
            },
            node: {
              isActive: true,
              panelEnabled: true
            },
            subscription: {
              userId: "user_2",
              teamId: null,
              state: "active",
              expireAt: new Date(Date.now() + 86_400_000),
              remainingTrafficGb: 10,
              user: { status: "disabled" },
              team: null,
              nodeAccesses: [{ nodeId: "node_1" }]
            }
          }
        ],
        updateMany: async (payload: { where: { id: { in: string[] } } }) => {
          clearedIds = payload.where.id.in;
          return { count: clearedIds.length };
        }
      },
      teamMember: {
        findMany: async () => []
      }
    }
  });

  const count = await service.clearPendingPanelDisableJobsForNode("node_1");

  assert.equal(count, 1);
  assert.deepEqual(clearedIds, ["job_restored"], "unsafe disable jobs must stay queued for remote 3x-ui cleanup");
}

async function testExistingBindingMissingSnapshotUsesBindingCountersAsBaseline() {
  const snapshotUpserts: Array<Record<string, unknown>> = [];
  const bindingUpdates: Array<Record<string, unknown>> = [];
  const panelSyncUpserts: Array<Record<string, any>> = [];
  const service = createRuntimeSessionService({
    xuiService: {
      ensureClient: async () => ({ uuid: "panel_uuid", inboundId: 1 }),
      getClientUsage: async () => ({
        uplinkBytes: BigInt(2 * GB_IN_BYTES),
        downlinkBytes: BigInt(4 * GB_IN_BYTES),
        sampledAt: new Date().toISOString()
      })
    },
    prisma: {
      panelClientBinding: {
        findFirst: async () => ({
          id: "binding_1",
          subscriptionId: "sub_1",
          userId: "user_1",
          teamId: null,
          nodeId: "node_1",
          panelClientEmail: "user@example.com",
          panelClientId: "panel_uuid",
          panelInboundId: 1,
          status: "active",
          lastUplinkBytes: BigInt(2 * GB_IN_BYTES),
          lastDownlinkBytes: BigInt(3 * GB_IN_BYTES),
          lastSyncedAt: new Date("2026-03-26T10:00:00.000Z")
        }),
        update: async (payload: Record<string, unknown>) => {
          bindingUpdates.push(payload);
          return {
            id: "binding_1",
            subscriptionId: "sub_1",
            userId: "user_1",
            teamId: null,
            nodeId: "node_1",
            panelClientEmail: "user@example.com",
            panelClientId: "panel_uuid",
            panelInboundId: 1,
            status: "active"
          };
        }
      },
      trafficSnapshot: {
        findUnique: async () => null,
        upsert: async (payload: Record<string, unknown>) => {
          snapshotUpserts.push(payload);
          return {};
        }
      },
      panelSyncJob: {
        upsert: async (payload: Record<string, any>) => {
          panelSyncUpserts.push(payload);
          return {};
        }
      }
    }
  });

  await service["ensurePanelClientBinding"]({
    node: {
      id: "node_1",
      name: "node",
      flow: "",
      panelBaseUrl: "https://panel.example.com",
      panelApiBasePath: "/",
      panelUsername: "admin",
      panelPassword: "password",
      panelInboundId: 1,
      panelEnabled: true
    },
    subscriptionId: "sub_1",
    userId: "user_1",
    teamId: null,
    userEmail: "user@example.com",
    userDisplayName: "User",
    expireAt: new Date(Date.now() + 86_400_000)
  });

  assert.equal(bindingUpdates.length, 1);
  assert.equal(snapshotUpserts.length, 1);
  assert.equal((snapshotUpserts[0].create as { totalBytes: bigint }).totalBytes, BigInt(5 * GB_IN_BYTES));
  assert.equal(panelSyncUpserts[0].create.action, "ensure_client");
}

async function testUsageTriggeredInvalidationUsesUnifiedRevokePath() {
  let updateManyCalled = false;
  const panelQueueCalls: string[] = [];
  const revokeCalls: Array<{ subscriptionId: string; reason: string }> = [];
  const publishedStates: string[] = [];

  const service = createUsageSyncService({
    runtimeSessionService: {
      markPanelBindingsDisabledForSubscription: async (subscriptionId: string) => {
        panelQueueCalls.push(subscriptionId);
        return 1;
      },
      revokeSubscriptionLeases: async (subscriptionId: string, reason: string) => {
        revokeCalls.push({ subscriptionId, reason });
        return 1;
      }
    },
    clientEventsPublisher: {
      publishSubscriptionUpdated: async ({ state }: { state: string }) => {
        publishedStates.push(state);
      }
    },
    prisma: {
      $transaction: async (
        callback: (tx: {
          subscription: {
            findUnique: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
            update: (payload: Record<string, unknown>) => Promise<void>;
          };
          trafficSnapshot: {
            update: (payload: Record<string, unknown>) => Promise<void>;
            upsert: (payload: Record<string, unknown>) => Promise<void>;
          };
          panelClientBinding: { updateMany: (payload: Record<string, unknown>) => Promise<void> };
          trafficLedger: { create: (payload: Record<string, unknown>) => Promise<void> };
        }) => Promise<void>
      ) =>
        callback({
          subscription: {
            findUnique: async () => ({
              id: "sub_1",
              state: "active",
              expireAt: new Date(Date.now() - 60_000),
              usedTrafficGb: 1,
              totalTrafficGb: 10,
              remainingTrafficGb: 9
            }),
            update: async () => undefined
          },
          trafficSnapshot: {
            update: async () => undefined,
            upsert: async () => undefined
          },
          panelClientBinding: {
            updateMany: async () => undefined
          },
          trafficLedger: {
            create: async () => undefined
          }
        }),
      nodeSessionLease: {
        updateMany: async () => {
          updateManyCalled = true;
          return { count: 1 };
        }
      }
    }
  });

  await service["applyUsageDelta"]({
    nodeId: "node_1",
    snapshotKey: "node_1:sub_1:user_1",
    snapshotMode: "update",
    subscriptionId: "sub_1",
    teamId: null,
    userId: "user_1",
    bindingId: "binding_1",
    uplinkBytes: 0n,
    downlinkBytes: BigInt(GB_IN_BYTES),
    totalBytes: BigInt(GB_IN_BYTES),
    deltaBytes: BigInt(GB_IN_BYTES),
    sampledAt: new Date()
  });

  assert.equal(updateManyCalled, false, "usage 失效不应该再裸调用 nodeSessionLease.updateMany");
  assert.deepEqual(panelQueueCalls, ["sub_1"]);
  assert.deepEqual(revokeCalls, [{ subscriptionId: "sub_1", reason: "subscription_expired" }]);
  assert.deepEqual(publishedStates, ["expired"]);
}

async function testUsageTriggeredInvalidationPublishesWhenPanelAndLeaseEffectsFail() {
  const warnings: string[] = [];
  const publishedStates: string[] = [];
  const subscriptionUpdates: Array<Record<string, unknown>> = [];
  const service = createUsageSyncService({
    logger: {
      warn: (message: string) => warnings.push(message)
    },
    runtimeSessionService: {
      markPanelBindingsDisabledForSubscription: async () => {
        throw new Error("panel queue failed");
      },
      revokeSubscriptionLeases: async () => {
        throw new Error("lease revoke failed");
      }
    },
    clientEventsPublisher: {
      publishSubscriptionUpdated: async ({ state }: { state: string }) => {
        publishedStates.push(state);
      }
    },
    prisma: {
      $transaction: async (
        callback: (tx: {
          subscription: {
            findUnique: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
            update: (payload: Record<string, unknown>) => Promise<void>;
          };
          trafficSnapshot: {
            update: (payload: Record<string, unknown>) => Promise<void>;
            upsert: (payload: Record<string, unknown>) => Promise<void>;
          };
          panelClientBinding: { updateMany: (payload: Record<string, unknown>) => Promise<void> };
          trafficLedger: { create: (payload: Record<string, unknown>) => Promise<void> };
        }) => Promise<void>
      ) =>
        callback({
          subscription: {
            findUnique: async () => ({
              id: "sub_1",
              state: "active",
              expireAt: new Date(Date.now() + 60_000),
              usedTrafficGb: 9,
              totalTrafficGb: 10,
              remainingTrafficGb: 1
            }),
            update: async (payload: Record<string, unknown>) => {
              subscriptionUpdates.push(payload);
            }
          },
          trafficSnapshot: {
            update: async () => undefined,
            upsert: async () => undefined
          },
          panelClientBinding: {
            updateMany: async () => undefined
          },
          trafficLedger: {
            create: async () => undefined
          }
        })
    }
  });

  await service["applyUsageDelta"]({
    nodeId: "node_1",
    snapshotKey: "node_1:sub_1:user_1",
    snapshotMode: "update",
    subscriptionId: "sub_1",
    teamId: null,
    userId: "user_1",
    bindingId: "binding_1",
    uplinkBytes: 0n,
    downlinkBytes: BigInt(2 * GB_IN_BYTES),
    totalBytes: BigInt(2 * GB_IN_BYTES),
    deltaBytes: BigInt(2 * GB_IN_BYTES),
    sampledAt: new Date()
  });

  assert.equal(subscriptionUpdates.length, 1, "local usage/subscription state must be saved before best-effort effects");
  assert.equal((subscriptionUpdates[0].data as { state: string }).state, "exhausted");
  assert.deepEqual(publishedStates, ["exhausted"], "SSE publish must still happen when panel/lease side effects fail");
  assert.equal(warnings.length, 2);
  assert.match(warnings.join("\n"), /panel queue failed/);
  assert.match(warnings.join("\n"), /lease revoke failed/);
}

async function testUsageDeltaKeepsLocalUsageWhenPublishFails() {
  const warnings: string[] = [];
  const subscriptionUpdates: Array<Record<string, unknown>> = [];
  const snapshotUpdates: Array<Record<string, unknown>> = [];
  const bindingUpdates: Array<Record<string, unknown>> = [];
  const service = createUsageSyncService({
    logger: {
      warn: (message: string) => warnings.push(message)
    },
    runtimeSessionService: {
      markPanelBindingsDisabledForSubscription: async () => 0,
      revokeSubscriptionLeases: async () => 0
    },
    clientEventsPublisher: {
      publishSubscriptionUpdated: async () => {
        throw new Error("sse publish failed");
      }
    },
    prisma: {
      $transaction: async (
        callback: (tx: {
          subscription: {
            findUnique: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
            update: (payload: Record<string, unknown>) => Promise<void>;
          };
          trafficSnapshot: {
            update: (payload: Record<string, unknown>) => Promise<void>;
            upsert: (payload: Record<string, unknown>) => Promise<void>;
          };
          panelClientBinding: { updateMany: (payload: Record<string, unknown>) => Promise<void> };
          trafficLedger: { create: (payload: Record<string, unknown>) => Promise<void> };
        }) => Promise<void>
      ) =>
        callback({
          subscription: {
            findUnique: async () => ({
              id: "sub_1",
              state: "active",
              expireAt: new Date(Date.now() + 60_000),
              usedTrafficGb: 1,
              totalTrafficGb: 10,
              remainingTrafficGb: 9
            }),
            update: async (payload: Record<string, unknown>) => {
              subscriptionUpdates.push(payload);
            }
          },
          trafficSnapshot: {
            update: async (payload: Record<string, unknown>) => {
              snapshotUpdates.push(payload);
            },
            upsert: async (payload: Record<string, unknown>) => {
              snapshotUpdates.push(payload);
            }
          },
          panelClientBinding: {
            updateMany: async (payload: Record<string, unknown>) => {
              bindingUpdates.push(payload);
            }
          },
          trafficLedger: {
            create: async () => undefined
          }
        })
    }
  });

  await service["applyUsageDelta"]({
    nodeId: "node_1",
    snapshotKey: "node_1:sub_1:user_1",
    snapshotMode: "update",
    subscriptionId: "sub_1",
    teamId: null,
    userId: "user_1",
    bindingId: "binding_1",
    uplinkBytes: 0n,
    downlinkBytes: BigInt(GB_IN_BYTES),
    totalBytes: BigInt(GB_IN_BYTES),
    deltaBytes: BigInt(GB_IN_BYTES),
    sampledAt: new Date()
  });

  assert.equal(subscriptionUpdates.length, 1);
  assert.equal(snapshotUpdates.length, 1);
  assert.equal(bindingUpdates.length, 1);
  assert.equal((subscriptionUpdates[0].data as { state: string }).state, "active");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /sse publish failed/);
}

async function testInitialUsageDeltaUsesBindingCountersForUuidMapping() {
  const snapshotCreates: Array<Record<string, unknown>> = [];
  const subscriptionUpdates: Array<Record<string, unknown>> = [];
  const bindingUpdates: Array<Record<string, unknown>> = [];
  const publishedStates: string[] = [];
  const service = createUsageSyncService({
    prisma: {
      panelClientBinding: {
        findMany: async () => [
          {
            id: "binding_1",
            panelClientEmail: "user@example.com",
            panelClientId: "panel_uuid",
            subscriptionId: "sub_1",
            userId: "user_1",
            teamId: null,
            lastSyncedAt: new Date(Date.now() - 120_000),
            lastUplinkBytes: BigInt(2 * GB_IN_BYTES),
            lastDownlinkBytes: BigInt(3 * GB_IN_BYTES)
          }
        ],
        updateMany: async (payload: Record<string, unknown>) => {
          bindingUpdates.push(payload);
          return { count: 1 };
        }
      },
      trafficSnapshot: {
        findUnique: async () => null,
        findMany: async () => []
      },
      $transaction: async (
        callback: (tx: {
          subscription: {
            findUnique: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
            update: (payload: Record<string, unknown>) => Promise<void>;
          };
          trafficSnapshot: {
            upsert: (payload: Record<string, unknown>) => Promise<void>;
            update: (payload: Record<string, unknown>) => Promise<void>;
          };
          panelClientBinding: { updateMany: (payload: Record<string, unknown>) => Promise<void> };
          trafficLedger: { create: (payload: Record<string, unknown>) => Promise<void> };
        }) => Promise<void>
      ) =>
        callback({
          subscription: {
            findUnique: async () => ({
              id: "sub_1",
              state: "active",
              usedTrafficGb: 4,
              totalTrafficGb: 10,
              expireAt: new Date(Date.now() + 86_400_000)
            }),
            update: async (payload: Record<string, unknown>) => {
              subscriptionUpdates.push(payload);
            }
          },
          trafficSnapshot: {
            upsert: async (payload: Record<string, unknown>) => {
              snapshotCreates.push(payload);
            },
            update: async () => undefined
          },
          panelClientBinding: {
            updateMany: async (payload: Record<string, unknown>) => {
              bindingUpdates.push(payload);
            }
          },
          trafficLedger: {
            create: async () => undefined
          }
        })
    },
    meteringIncidentService: {
      open: async () => undefined,
      resolve: async () => undefined
    },
    clientEventsPublisher: {
      publishSubscriptionUpdated: async (payload: { state: string }) => {
        publishedStates.push(payload.state);
      }
    },
    runtimeSessionService: {
      markPanelBindingsDisabledForSubscription: async () => 0,
      revokeSubscriptionLeases: async () => 0
    }
  });

  const context = await service["loadNodeSyncContext"]("node_1");
  await service["applyNodeSamples"](
    "node_1",
    [
      {
        xrayUserEmail: "user@example.com",
        xrayUserUuid: "panel_uuid",
        uplinkBytes: BigInt(2 * GB_IN_BYTES),
        downlinkBytes: BigInt(4 * GB_IN_BYTES),
        sampledAt: new Date().toISOString()
      }
    ],
    context
  );

  assert.equal(snapshotCreates.length, 1, "first UUID-mapped sample should create the missing snapshot");
  assert.equal(subscriptionUpdates.length, 1, "first UUID-mapped positive delta should update subscription usage");
  assert.equal(subscriptionUpdates[0].data.usedTrafficGb, 5, "delta should be 1GB from binding counters, not 6GB from zero");
  assert.equal(subscriptionUpdates[0].data.remainingTrafficGb, 5);
  assert.deepEqual(publishedStates, ["active"]);
  assert.equal(bindingUpdates.length, 1);
}

async function testRenewSubscriptionResetTrafficClearsPanelBaselines() {
  const resetCalls: string[] = [];
  const snapshotUpserts: Array<Record<string, any>> = [];
  const bindingUpdates: Array<Record<string, any>> = [];
  const panelSyncUpserts: Array<Record<string, any>> = [];
  const ledgerDeletes: Array<Record<string, any>> = [];
  const subscriptionUpdates: Array<Record<string, any>> = [];
  let aggregateCalled = false;
  const nextExpireAt = new Date(Date.now() + 86_400_000);
  const lockedSubscription = {
    id: "sub_team",
    userId: null,
    teamId: "team_1",
    planId: "plan_team",
    totalTrafficGb: 10,
    usedTrafficGb: 7,
    remainingTrafficGb: 3,
    expireAt: new Date(Date.now() - 86_400_000),
    state: "exhausted" as const,
    renewable: true,
    sourceAction: "created" as const,
    lastSyncedAt: new Date("2026-01-01T00:00:00.000Z"),
    plan: { name: "Team Plan" },
    user: null,
    team: { name: "Team" },
    nodeAccesses: []
  };

  const service = createAdminSubscriptionService({
    requireSubscription: async () => lockedSubscription,
    xuiService: {
      resetClientTraffic: async (_node: unknown, email: string) => {
        resetCalls.push(email);
        return true;
      },
      getClientUsage: async () => ({
        uplinkBytes: 0n,
        downlinkBytes: 0n,
        sampledAt: new Date().toISOString()
      })
    },
    runtimeSessionService: {
      syncActiveLeasesForSubscription: async () => undefined,
      syncSubscriptionPanelAccess: async () => undefined
    },
    clientRuntimeEventsService: {
      publishToUsers: () => undefined
    },
    prisma: {
      panelClientBinding: {
        findMany: async (payload: Record<string, any>) => {
          assert.equal(payload.where.subscriptionId, "sub_team");
          assert.equal("userId" in payload.where, false, "team-wide renew reset must not filter by a single user");
          return [
            {
              id: "binding_1",
              subscriptionId: "sub_team",
              userId: "user_1",
              teamId: "team_1",
              nodeId: "node_1",
              panelClientEmail: "user1@example.com",
              panelClientId: "client_1",
              panelInboundId: 7,
              node: {
                id: "node_1",
                panelBaseUrl: "https://panel.example.com",
                panelApiBasePath: "/",
                panelUsername: "admin",
                panelPassword: "password"
              }
            },
            {
              id: "binding_2",
              subscriptionId: "sub_team",
              userId: "user_2",
              teamId: "team_1",
              nodeId: "node_1",
              panelClientEmail: "user2@example.com",
              panelClientId: "client_2",
              panelInboundId: 7,
              node: {
                id: "node_1",
                panelBaseUrl: "https://panel.example.com",
                panelApiBasePath: "/",
                panelUsername: "admin",
                panelPassword: "password"
              }
            }
          ];
        }
      },
      teamMember: {
        findMany: async () => [{ userId: "user_1" }, { userId: "user_2" }]
      },
      panelSyncJob: {
        upsert: async (payload: Record<string, any>) => {
          panelSyncUpserts.push(payload);
          return {};
        }
      },
      $transaction: async (callback: (tx: any) => Promise<any>) =>
        callback({
          subscription: {
            findUnique: async () => lockedSubscription,
            update: async (payload: Record<string, any>) => {
              subscriptionUpdates.push(payload);
              return {
                ...lockedSubscription,
                ...payload.data
              };
            }
          },
          trafficSnapshot: {
            upsert: async (payload: Record<string, any>) => {
              snapshotUpserts.push(payload);
            }
          },
          panelClientBinding: {
            update: async (payload: Record<string, any>) => {
              bindingUpdates.push(payload);
            }
          },
          trafficLedger: {
            deleteMany: async (payload: Record<string, any>) => {
              ledgerDeletes.push(payload);
            },
            aggregate: async () => {
              aggregateCalled = true;
              return { _sum: { usedTrafficGb: 99 } };
            }
          }
        })
    }
  });

  const record = await service.renewSubscription("sub_team", {
    resetTraffic: true,
    totalTrafficGb: 20,
    expireAt: nextExpireAt.toISOString()
  });

  assert.deepEqual(resetCalls.sort(), [], "renew reset must queue panel resets instead of calling 3x-ui inline");
  assert.equal(snapshotUpserts.length, 2, "renew reset must rewrite traffic baselines for each panel binding");
  assert.equal(bindingUpdates.length, 2, "renew reset must update binding counters after panel reset");
  assert.deepEqual(
    panelSyncUpserts.map((item) => item.create.action),
    ["reset_client_traffic", "reset_client_traffic"],
    "renew reset must queue panel reset jobs for each binding"
  );
  assert.equal(ledgerDeletes.length, 1, "team-wide renew reset must clear all team ledger entries for the subscription");
  assert.equal("userId" in ledgerDeletes[0].where, false, "team-wide renew reset must not keep per-user ledger remnants");
  assert.equal(aggregateCalled, false, "team-wide renew reset should not re-aggregate old member usage");
  assert.equal(subscriptionUpdates[0].data.usedTrafficGb, 0);
  assert.equal(subscriptionUpdates[0].data.remainingTrafficGb, 20);
  assert.equal(subscriptionUpdates[0].data.sourceAction, "renewed");
  assert.equal(record.usedTrafficGb, 0);
  assert.equal(record.remainingTrafficGb, 20);
}

async function testRenewSubscriptionResetTrafficQueueFailureStillClearsLocalUsage() {
  let transactionCalled = false;
  let leaseSyncCalled = false;
  const lockedSubscription = {
    id: "sub_1",
    userId: "user_1",
    teamId: null,
    planId: "plan_1",
    totalTrafficGb: 10,
    usedTrafficGb: 8,
    remainingTrafficGb: 2,
    expireAt: new Date(Date.now() + 86_400_000),
    state: "active" as const,
    renewable: true,
    sourceAction: "created" as const,
    lastSyncedAt: new Date(),
    plan: { name: "Plan" },
    user: { email: "user@example.com", displayName: "User" },
    team: null,
    nodeAccesses: []
  };

  const service = createAdminSubscriptionService({
    requireSubscription: async () => lockedSubscription,
    xuiService: {
      resetClientTraffic: async () => false
    },
    runtimeSessionService: {
      syncActiveLeasesForSubscription: async () => {
        leaseSyncCalled = true;
      },
      syncSubscriptionPanelAccess: async () => undefined
    },
    prisma: {
      panelClientBinding: {
        findMany: async () => [
          {
            id: "binding_1",
            subscriptionId: "sub_1",
            userId: "user_1",
            teamId: null,
            nodeId: "node_1",
            panelClientEmail: "user@example.com",
            panelClientId: "client_1",
            panelInboundId: 7,
            node: {
              id: "node_1",
              panelBaseUrl: "https://panel.example.com",
              panelApiBasePath: "/",
              panelUsername: "admin",
              panelPassword: "password"
            }
          }
        ]
      },
      $transaction: async (callback: (tx: any) => Promise<any>) => {
        transactionCalled = true;
        return callback({
          subscription: {
            findUnique: async () => lockedSubscription,
            update: async (payload: Record<string, any>) => ({
              ...lockedSubscription,
              ...payload.data
            })
          },
          trafficSnapshot: {
            upsert: async () => ({})
          },
          panelClientBinding: {
            update: async () => ({})
          }
        });
      },
      panelSyncJob: {
        upsert: async () => {
          throw new Error("panel sync queue unavailable");
        }
      }
    }
  });

  const record = await service.renewSubscription("sub_1", { resetTraffic: true });

  assert.equal(transactionCalled, true, "DB-first reset should enter the local transaction even if queue write later fails");
  assert.equal(leaseSyncCalled, true, "successful local renewal should continue best-effort lease reconciliation");
  assert.equal(record.usedTrafficGb, 0);
  assert.equal(record.remainingTrafficGb, 10);
  assert.equal(record.panelSyncStatus, "pending");
  assert.match(record.panelSyncMessage ?? "", /panel sync queue unavailable/);
}

async function testRenewSubscriptionReturnsPendingWhenLeaseAndPanelSyncFail() {
  const updates: Array<Record<string, any>> = [];
  const now = new Date("2026-01-01T00:00:00.000Z");
  const current = {
    id: "sub_1",
    userId: "user_1",
    teamId: null,
    planId: "plan_1",
    totalTrafficGb: 10,
    usedTrafficGb: 4,
    remainingTrafficGb: 6,
    expireAt: new Date(Date.now() + 86_400_000),
    state: "active",
    renewable: true,
    sourceAction: "created",
    lastSyncedAt: now,
    plan: { name: "Plan", maxConcurrentSessions: 3 },
    user: { email: "user@example.com", displayName: "User" },
    team: null,
    nodeAccesses: []
  };
  const service = createAdminSubscriptionService({
    requireSubscription: async () => current,
    runtimeSessionService: {
      syncActiveLeasesForSubscription: async () => {
        throw new Error("lease sync failed");
      },
      queueSubscriptionPanelAccessSync: async () => {
        throw new Error("panel sync failed");
      },
      syncSubscriptionPanelAccess: async () => {
        throw new Error("usage-locking panel sync must not run");
      }
    },
    publishSubscriptionUpdatedEvent: async () => undefined,
    prisma: {
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          subscription: {
            update: async (payload: Record<string, any>) => {
              updates.push(payload);
              return {
                ...current,
                ...payload.data,
                updatedAt: new Date("2026-01-01T00:01:00.000Z")
              };
            }
          }
        })
    }
  });

  const record = await service.renewSubscription("sub_1", { totalTrafficGb: 20 });

  assert.equal(updates.length, 1, "local renewal must save before lease/panel follow-up sync");
  assert.equal(updates[0].data.totalTrafficGb, 20);
  assert.equal(record.totalTrafficGb, 20);
  assert.equal(record.remainingTrafficGb, 16);
  assert.equal(record.panelSyncStatus, "pending");
  assert.match(record.panelSyncMessage ?? "", /lease sync failed/);
  assert.match(record.panelSyncMessage ?? "", /panel sync failed/);
}

async function testResetSubscriptionTrafficRejectsNonStringUserId() {
  const service = createAdminSubscriptionService({
    requireSubscription: async () => ({
      id: "subscription_1"
    }),
    resetSubscriptionTrafficCounters: async () => {
      throw new Error("reset should not run for invalid userId");
    }
  });

  await assert.rejects(
    () => service.resetSubscriptionTraffic("subscription_1", { userId: 1 } as any),
    /userId must be a string/,
    "reset-traffic must reject non-string userId with 400 instead of throwing TypeError later"
  );
}

async function testResetSubscriptionTrafficReturnsPendingWhenQueueAndUserRefreshFail() {
  let transactionCalled = false;
  const subscriptionUpdates: Array<Record<string, any>> = [];
  const lockedSubscription = {
    id: "sub_1",
    userId: "user_1",
    teamId: null,
    planId: "plan_1",
    totalTrafficGb: 10,
    usedTrafficGb: 8,
    remainingTrafficGb: 2,
    expireAt: new Date(Date.now() + 86_400_000),
    state: "active" as const,
    renewable: true,
    sourceAction: "created" as const,
    lastSyncedAt: new Date(),
    plan: { name: "Plan" },
    user: { email: "user@example.com", displayName: "User" },
    team: null,
    nodeAccesses: []
  };

  const service = createAdminSubscriptionService({
    logger: {
      warn: () => undefined
    },
    requireSubscription: async () => lockedSubscription,
    publishSubscriptionUpdatedEvent: async () => undefined,
    requireAdminUserRecord: async () => {
      throw new Error("user refresh failed");
    },
    prisma: {
      panelClientBinding: {
        findMany: async () => [
          {
            id: "binding_1",
            subscriptionId: "sub_1",
            userId: "user_1",
            teamId: null,
            nodeId: "node_1",
            panelClientEmail: "user@example.com",
            panelClientId: "client_1",
            panelInboundId: 7,
            lastUplinkBytes: 8n,
            lastDownlinkBytes: 0n,
            lastSyncedAt: new Date(),
            node: {
              id: "node_1",
              panelBaseUrl: "https://panel.example.com",
              panelApiBasePath: "/",
              panelUsername: "admin",
              panelPassword: "password"
            }
          }
        ]
      },
      $transaction: async (callback: (tx: any) => Promise<any>) => {
        transactionCalled = true;
        return callback({
          subscription: {
            findUnique: async () => lockedSubscription,
            update: async (payload: Record<string, any>) => {
              subscriptionUpdates.push(payload);
              return {
                ...lockedSubscription,
                ...payload.data
              };
            }
          },
          trafficSnapshot: {
            upsert: async () => ({})
          },
          panelClientBinding: {
            update: async () => ({})
          },
          trafficLedger: {
            deleteMany: async () => ({}),
            aggregate: async () => ({ _sum: { usedTrafficGb: 0 } })
          }
        });
      },
      panelSyncJob: {
        upsert: async () => {
          throw new Error("panel reset queue failed");
        }
      }
    }
  });

  const result = await service.resetSubscriptionTraffic("sub_1");

  assert.equal(result.ok, true);
  assert.equal(transactionCalled, true, "local traffic reset transaction must complete even if follow-up work fails");
  assert.equal(subscriptionUpdates.length, 1);
  assert.equal(subscriptionUpdates[0].data.usedTrafficGb, 0);
  assert.equal(subscriptionUpdates[0].data.remainingTrafficGb, 10);
  assert.equal(result.subscription.usedTrafficGb, 0);
  assert.equal(result.subscription.remainingTrafficGb, 10);
  assert.equal(result.user, null, "response should fall back when refreshed admin user cannot be loaded");
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /panel reset queue failed/);
  assert.match(result.panelSyncMessage ?? "", /user refresh failed/);
}

async function testRenewSubscriptionPartialPanelResetPersistsSuccessfulBaselines() {
  const snapshotUpserts: Array<Record<string, any>> = [];
  const bindingUpdates: Array<Record<string, any>> = [];
  const panelSyncUpserts: Array<Record<string, any>> = [];
  const subscriptionUpdates: Array<Record<string, any>> = [];
  const resetCalls: string[] = [];
  const lockedSubscription = {
    id: "sub_1",
    userId: "user_1",
    teamId: null,
    planId: "plan_1",
    totalTrafficGb: 10,
    usedTrafficGb: 8,
    remainingTrafficGb: 2,
    expireAt: new Date(Date.now() + 86_400_000),
    state: "active" as const,
    renewable: true,
    sourceAction: "created" as const,
    lastSyncedAt: new Date(),
    plan: { name: "Plan" },
    user: { email: "user@example.com", displayName: "User" },
    team: null,
    nodeAccesses: []
  };

  const service = createAdminSubscriptionService({
    requireSubscription: async () => lockedSubscription,
    xuiService: {
      resetClientTraffic: async (_node: unknown, email: string) => {
        resetCalls.push(email);
        return email === "ok@example.com";
      },
      getClientUsage: async () => ({
        uplinkBytes: 10n,
        downlinkBytes: 20n,
        sampledAt: new Date("2026-01-01T00:00:00.000Z").toISOString()
      })
    },
    runtimeSessionService: {
      syncActiveLeasesForSubscription: async () => undefined,
      syncSubscriptionPanelAccess: async () => undefined
    },
    clientRuntimeEventsService: {
      publishToUsers: () => undefined
    },
    prisma: {
      panelClientBinding: {
        findMany: async () => [
          {
            id: "binding_ok",
            subscriptionId: "sub_1",
            userId: "user_1",
            teamId: null,
            nodeId: "node_1",
            panelClientEmail: "ok@example.com",
            panelClientId: "client_ok",
            panelInboundId: 7,
            node: {
              id: "node_1",
              panelBaseUrl: "https://panel.example.com",
              panelApiBasePath: "/",
              panelUsername: "admin",
              panelPassword: "password"
            }
          },
          {
            id: "binding_failed",
            subscriptionId: "sub_1",
            userId: "user_1",
            teamId: null,
            nodeId: "node_2",
            panelClientEmail: "failed@example.com",
            panelClientId: "client_failed",
            panelInboundId: 8,
            node: {
              id: "node_2",
              panelBaseUrl: "https://panel.example.com",
              panelApiBasePath: "/",
              panelUsername: "admin",
              panelPassword: "password"
            }
          }
        ]
      },
      panelSyncJob: {
        upsert: async (payload: Record<string, any>) => {
          panelSyncUpserts.push(payload);
          return {};
        }
      },
      $transaction: async (callback: (tx: any) => Promise<any>) =>
        callback({
          trafficSnapshot: {
            upsert: async (payload: Record<string, any>) => {
              snapshotUpserts.push(payload);
            }
          },
          panelClientBinding: {
            update: async (payload: Record<string, any>) => {
              bindingUpdates.push(payload);
            }
          },
          subscription: {
            findUnique: async () => lockedSubscription,
            update: async (payload: Record<string, any>) => {
              subscriptionUpdates.push(payload);
              return lockedSubscription;
            }
          }
        })
    }
  });

  await service.renewSubscription("sub_1", { resetTraffic: true });

  assert.equal(resetCalls.length, 0, "DB-first reset must not call remote panel reset inline");
  assert.equal(snapshotUpserts.length, 2, "all local baselines must be rewritten before panel retry");
  assert.equal(bindingUpdates.length, 2);
  assert.deepEqual(
    panelSyncUpserts.map((item) => item.create.action),
    ["reset_client_traffic", "reset_client_traffic"]
  );
  assert.equal(subscriptionUpdates[0].data.usedTrafficGb, 0, "local subscription usage must reset even when a panel is offline");
}

async function testStaleUsageSampleAfterResetDoesNotReapplyOldTraffic() {
  const subscriptionUpdates: Array<Record<string, unknown>> = [];
  const snapshotUpdates: Array<Record<string, unknown>> = [];
  const sampleBeforeReset = new Date("2026-01-01T00:00:00.000Z");
  const resetBaselineAt = new Date("2026-01-01T00:00:05.000Z");

  const service = createUsageSyncService({
    prisma: {
      panelClientBinding: {
        findMany: async () => [
          {
            id: "binding_1",
            panelClientEmail: "user@example.com",
            panelClientId: "panel_uuid",
            subscriptionId: "sub_1",
            userId: "user_1",
            teamId: null,
            lastSyncedAt: resetBaselineAt,
            lastUplinkBytes: 0n,
            lastDownlinkBytes: 0n
          }
        ]
      },
      trafficSnapshot: {
        findUnique: async () => ({
          snapshotKey: "node_1:sub_1:user_1",
          totalBytes: 0n,
          sampledAt: resetBaselineAt
        }),
        findMany: async () => [],
        update: async (payload: Record<string, unknown>) => {
          snapshotUpdates.push(payload);
        }
      },
      $transaction: async (
        callback: (tx: {
          subscription: {
            findUnique: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
            update: (payload: Record<string, unknown>) => Promise<void>;
          };
          trafficSnapshot: {
            upsert: (payload: Record<string, unknown>) => Promise<void>;
            update: (payload: Record<string, unknown>) => Promise<void>;
          };
          panelClientBinding: { updateMany: (payload: Record<string, unknown>) => Promise<void> };
          trafficLedger: { create: (payload: Record<string, unknown>) => Promise<void> };
        }) => Promise<void>
      ) =>
        callback({
          subscription: {
            findUnique: async () => ({
              id: "sub_1",
              state: "active",
              usedTrafficGb: 0,
              totalTrafficGb: 10,
              expireAt: new Date(Date.now() + 86_400_000)
            }),
            update: async (payload: Record<string, unknown>) => {
              subscriptionUpdates.push(payload);
            }
          },
          trafficSnapshot: {
            upsert: async () => undefined,
            update: async (payload: Record<string, unknown>) => {
              snapshotUpdates.push(payload);
            }
          },
          panelClientBinding: {
            updateMany: async () => undefined
          },
          trafficLedger: {
            create: async () => undefined
          }
        })
    },
    meteringIncidentService: {
      open: async () => undefined,
      resolve: async () => undefined
    },
    clientEventsPublisher: {
      publishSubscriptionUpdated: async () => undefined
    },
    runtimeSessionService: {
      markPanelBindingsDisabledForSubscription: async () => 0,
      revokeSubscriptionLeases: async () => 0
    }
  });

  const context = await service["loadNodeSyncContext"]("node_1");
  await service["applyNodeSamples"](
    "node_1",
    [
      {
        xrayUserEmail: "user@example.com",
        xrayUserUuid: "panel_uuid",
        uplinkBytes: 0n,
        downlinkBytes: BigInt(8 * GB_IN_BYTES),
        sampledAt: sampleBeforeReset.toISOString()
      }
    ],
    context
  );

  assert.equal(subscriptionUpdates.length, 0, "stale pre-reset samples must not add traffic after reset baseline");
  assert.equal(snapshotUpdates.length, 0, "stale pre-reset samples must not move the reset baseline");
}

async function testDeleteNodeStopsBeforeLocalDeleteWhenPanelCleanupFails() {
  let nodeDeleted = false;
  let bindingsQueuedForDelete = false;
  const nodeUpdates: Array<Record<string, any>> = [];
  const calls: string[] = [];
  const service = createAdminNodeService({
    clientEventsPublisher: {
      resolveUserIdsForNodeAccess: async () => ["user_1"],
      publishNodeAccessUpdatedToUsers: () => undefined
    },
    runtimeSessionService: {
      revokeNodeLeases: async () => {
        calls.push("revoke_leases");
        return 1;
      },
      removePanelBindingsForNode: async () => {
        calls.push("queue_panel_delete");
        bindingsQueuedForDelete = true;
        throw new Error("panel cleanup queue failed");
      }
    },
    prisma: {
      panelClientBinding: {
        findMany: async () => [{ subscriptionId: "sub_1" }]
      },
      node: {
        findUnique: async () => ({ id: "node_1" }),
        update: async (payload: Record<string, any>) => {
          calls.push("local_update");
          nodeUpdates.push(payload);
          return {};
        },
        delete: async () => {
          nodeDeleted = true;
        }
      }
    }
  });

  const result = await service.deleteNode("node_1");

  assert.equal(result.ok, true);
  assert.equal(bindingsQueuedForDelete, true, "delete must queue remote panel cleanup without waiting for the panel");
  assert.deepEqual(calls, ["local_update", "revoke_leases", "queue_panel_delete"]);
  assert.equal(nodeUpdates[0].data.isActive, false, "node must be hidden locally before remote cleanup completes");
  assert.equal(nodeUpdates[0].data.panelStatus, "offline");
  assert.equal(nodeDeleted, false, "node row must be kept for queued panel cleanup jobs");
}

async function testProbeAllNodesContinuesWhenSingleNodeProbeFails() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const makeNode = (id: string) => ({
    id,
    name: id,
    countryCode: "US",
    region: "Los Angeles",
    provider: "provider",
    tags: [],
    isActive: true,
    recommended: false,
    latencyMs: 0,
    probeLatencyMs: null,
    protocol: "vless",
    security: "reality",
    serverHost: "node.example.com",
    serverPort: 443,
    serverName: "node.example.com",
    shortId: "short",
    spiderX: "/",
    mldsa65Verify: null,
    subscriptionUrl: null,
    statsLastSyncedAt: null,
    panelBaseUrl: "https://panel.example.com",
    panelApiBasePath: "/",
    panelUsername: "admin",
    panelPassword: "password",
    panelInboundId: 1,
    panelEnabled: true,
    panelStatus: "online" as const,
    panelLastSyncedAt: null,
    panelError: null,
    probeStatus: "unknown" as const,
    probeCheckedAt: null,
    probeError: null,
    createdAt: now,
    updatedAt: now
  });
  const nodes = [makeNode("node_bad"), makeNode("node_good")];
  const probed: string[] = [];
  const service = createAdminNodeService({
    logger: {
      warn: () => undefined
    },
    probeNode: async (nodeId: string) => {
      probed.push(nodeId);
      if (nodeId === "node_bad") {
        throw new Error("panel unavailable");
      }
      return {
        id: nodeId,
        probeStatus: "healthy",
        panelStatus: "online"
      };
    },
    prisma: {
      node: {
        findMany: async () => nodes,
        update: async (payload: Record<string, any>) => ({
          ...nodes.find((node) => node.id === payload.where.id),
          ...payload.data,
          updatedAt: new Date("2026-01-01T00:01:00.000Z")
        })
      }
    }
  });

  const result = await service.probeAllNodes();

  assert.deepEqual(probed, ["node_bad", "node_good"], "bulk probe must continue after one node fails");
  assert.deepEqual(result.map((item) => item.id), ["node_bad", "node_good"]);
  assert.equal(result[0]?.probeStatus, "offline");
  assert.equal(result[0]?.panelStatus, "degraded");
  assert.match(result[0]?.probeError ?? "", /panel unavailable/);
  assert.equal(result[1]?.probeStatus, "healthy");
}

async function testRetryPanelSyncJobRequeuesWithoutRunningRemoteSync() {
  const updates: Array<Record<string, any>> = [];
  const now = new Date("2026-01-01T00:00:00.000Z");
  const service = createAdminNodeService({
    prisma: {
      panelSyncJob: {
        updateMany: async (payload: Record<string, any>) => {
          updates.push(payload);
          return { count: 1 };
        },
        findMany: async () => [
          {
            id: "job_1",
            action: "disable_client",
            status: "pending",
            nodeId: "node_1",
            node: { name: "Node" },
            panelClientEmail: "user@example.com",
            attempts: 0,
            nextRunAt: now,
            lockedAt: null,
            lastError: null,
            completedAt: null,
            createdAt: now,
            updatedAt: now
          }
        ]
      }
    }
  });

  const result = await service.retryPanelSyncJob("job_1");

  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.where.id, "job_1");
  assert.equal(updates[0]?.data.status, "pending");
  assert.equal(updates[0]?.data.lockedAt, null);
  assert.equal(updates[0]?.data.lastError, null);
  assert.deepEqual(result.map((job) => job.id), ["job_1"]);
}

async function testXuiPanelLocationDoesNotDuplicateBasePath() {
  const service = new XuiService();
  const calls: Array<{ panelBaseUrl: string; panelApiBasePath: string; path: string }> = [];
  service["login"] = async () => undefined;
  service["performRequest"] = async (
    node: { panelBaseUrl: string; panelApiBasePath: string },
    path: string
  ) => {
    calls.push({
      panelBaseUrl: node.panelBaseUrl,
      panelApiBasePath: node.panelApiBasePath,
      path
    });
    return new Response(
      JSON.stringify({
        success: true,
        obj: [
          {
            id: 1,
            remark: "inbound",
            port: 443,
            protocol: "vless",
            settings: JSON.stringify({ clients: [] })
          }
        ]
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
  };

  const inbounds = await service.listInbounds({
    id: "node_1",
    panelBaseUrl: "https://panel.example.com/custom-path/",
    panelApiBasePath: "/custom-path",
    panelUsername: "admin",
    panelPassword: "password",
    panelInboundId: null
  });

  assert.equal(inbounds.length, 1);
  assert.equal(calls[0].panelBaseUrl, "https://panel.example.com");
  assert.equal(calls[0].panelApiBasePath, "/custom-path", "panel base path must not be duplicated");
  assert.equal(calls[0].path, "/panel/api/inbounds/list");
}

async function testXuiPanelLocationStripsApiPathSuffix() {
  const service = new XuiService();
  const calls: Array<{ panelBaseUrl: string; panelApiBasePath: string; path: string }> = [];
  service["login"] = async () => undefined;
  service["performRequest"] = async (
    node: { panelBaseUrl: string; panelApiBasePath: string },
    path: string
  ) => {
    calls.push({
      panelBaseUrl: node.panelBaseUrl,
      panelApiBasePath: node.panelApiBasePath,
      path
    });
    return new Response(
      JSON.stringify({
        success: true,
        obj: [
          {
            id: 1,
            remark: "inbound",
            port: 443,
            protocol: "vless",
            settings: JSON.stringify({ clients: [] })
          }
        ]
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
  };

  await service.listInbounds({
    id: "node_1",
    panelBaseUrl: "https://panel.example.com/secret/panel/api",
    panelApiBasePath: "/panel/api",
    panelUsername: "admin",
    panelPassword: "password",
    panelInboundId: null
  });

  assert.equal(calls[0].panelBaseUrl, "https://panel.example.com");
  assert.equal(calls[0].panelApiBasePath, "/secret", "API suffix must be stripped from panel base path");
}

async function testXuiPanelLocationAcceptsFullUrlAsApiBasePath() {
  const service = new XuiService();
  const calls: Array<{ panelBaseUrl: string; panelApiBasePath: string; path: string }> = [];
  service["login"] = async () => undefined;
  service["performRequest"] = async (
    node: { panelBaseUrl: string; panelApiBasePath: string },
    path: string
  ) => {
    calls.push({
      panelBaseUrl: node.panelBaseUrl,
      panelApiBasePath: node.panelApiBasePath,
      path
    });
    return new Response(
      JSON.stringify({
        success: true,
        obj: [
          {
            id: 1,
            remark: "inbound",
            port: 443,
            protocol: "vless",
            settings: JSON.stringify({ clients: [] })
          }
        ]
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
  };

  await service.listInbounds({
    id: "node_1",
    panelBaseUrl: "https://panel.example.com",
    panelApiBasePath: "https://panel.example.com/secret/panel/api",
    panelUsername: "admin",
    panelPassword: "password",
    panelInboundId: null
  });

  assert.equal(calls[0].panelBaseUrl, "https://panel.example.com");
  assert.equal(calls[0].panelApiBasePath, "/secret", "full URL API path input must be normalized to pathname only");
  assert.equal(calls[0].path, "/panel/api/inbounds/list");
}

function testAdminNodePanelApiPathAcceptsFullUrl() {
  assert.equal(
    normalizePanelApiBasePath("https://panel.example.com/secret/panel/api"),
    "/secret",
    "stored panel API base path must never include a full URL"
  );
  assert.equal(normalizePanelApiBasePath("https://panel.example.com/secret/"), "/secret");
}

async function testXuiBusinessNotFoundFallsBackToInboundDelete() {
  const service = new XuiService();
  const calls: string[] = [];
  service["login"] = async () => undefined;
  service["performRequest"] = async (_node: unknown, path: string) => {
    calls.push(path);
    if (path.startsWith("/panel/api/clients/del/")) {
      return new Response(JSON.stringify({ success: false, msg: "record not found" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (path === "/panel/api/inbounds/get/1") {
      return new Response(
        JSON.stringify({
          success: true,
          obj: {
            id: 1,
            settings: JSON.stringify({
              clients: [{ id: "client_uuid", email: "user@example.com", enable: true }]
            })
          }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
    if (path.includes("/panel/api/inbounds/1/delClient/client_uuid")) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ success: false, msg: `unexpected ${path}` }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const result = await service.removeClient(
    {
      id: "node_1",
      panelBaseUrl: "https://panel.example.com",
      panelApiBasePath: "/",
      panelUsername: "admin",
      panelPassword: "password",
      panelInboundId: 1
    },
    "client_uuid",
    "user@example.com"
  );

  assert.equal(result, "deleted");
  assert.ok(
    calls.some((path) => path.includes("/panel/api/inbounds/1/delClient/client_uuid")),
    "business record not found from /clients/del must still try legacy inbound deletion"
  );
}

function testXuiSettingsClientStatsTakePrecedenceOverZeroClientFallback() {
  const service = createInstance<XuiService>(XuiService.prototype, {});
  const stats = service["extractClientStats"]({
    id: 1,
    remark: "inbound",
    protocol: "vless",
    port: 443,
    settings: JSON.stringify({
      clients: [
        {
          id: "client_uuid",
          email: "user@example.com",
          enable: true
        }
      ],
      clientStats: [
        {
          email: "user@example.com",
          uuid: "client_uuid",
          up: "123",
          down: "456",
          total: "579"
        }
      ]
    })
  });

  assert.equal(stats[0].email, "user@example.com");
  assert.equal(stats[0].up, "123", "settings.clientStats must not be masked by zeroed settings.clients fallback");
  assert.equal(stats[0].down, "456");
}

async function testXuiInboundRuntimeReadsMldsa65Verify() {
  const service = new XuiService();
  service["login"] = async () => undefined;
  service["request"] = async () => ({
    success: true,
    obj: {
      id: 3,
      remark: "new 3x-ui reality",
      port: 57794,
      protocol: "vless",
      listen: "",
      settings: {
        clients: [
          {
            id: "client_uuid",
            email: "user@example.com",
            enable: true,
            flow: "xtls-rprx-vision"
          }
        ]
      },
      streamSettings: {
        network: "tcp",
        security: "reality",
        realitySettings: {
          target: "aws.amazon.com:443",
          serverNames: ["aws.amazon.com"],
          shortIds: ["67"],
          settings: {
            publicKey: "public_key",
            fingerprint: "chrome",
            serverName: "aws.amazon.com",
            spiderX: "/",
            mldsa65Verify: "mldsa_verify_value"
          }
        }
      }
    }
  });

  const runtime = await service.getInboundRuntime({
    id: "node_1",
    panelBaseUrl: "https://panel.example.com/custom",
    panelApiBasePath: "/custom",
    panelUsername: "admin",
    panelPassword: "password",
    panelInboundId: 3
  });

  assert.equal(runtime.mldsa65Verify, "mldsa_verify_value");
  assert.equal(runtime.realityPublicKey, "public_key");
  assert.equal(runtime.shortId, "67");
}

async function testXuiInboundRuntimeReadsPqvAlias() {
  const service = new XuiService();
  service["login"] = async () => undefined;
  service["request"] = async () => ({
    success: true,
    obj: {
      id: 3,
      remark: "new 3x-ui pq reality",
      port: 57794,
      protocol: "vless",
      listen: "",
      settings: {
        clients: [
          {
            id: "client_uuid",
            email: "user@example.com",
            enable: true,
            flow: "xtls-rprx-vision"
          }
        ]
      },
      streamSettings: {
        network: "tcp",
        security: "reality",
        realitySettings: {
          target: "aws.amazon.com:443",
          serverNames: ["aws.amazon.com"],
          shortIds: ["67"],
          settings: {
            publicKey: "public_key",
            fingerprint: "chrome",
            serverName: "aws.amazon.com",
            spiderX: "/",
            pqv: "pqv_verify_value"
          }
        }
      }
    }
  });

  const runtime = await service.getInboundRuntime({
    id: "node_1",
    panelBaseUrl: "https://panel.example.com/custom",
    panelApiBasePath: "/custom",
    panelUsername: "admin",
    panelPassword: "password",
    panelInboundId: 3
  });

  assert.equal(runtime.mldsa65Verify, "pqv_verify_value");
}

async function testXuiInboundRuntimeRejectsMissingRealityPublicKey() {
  const service = new XuiService();
  service["login"] = async () => undefined;
  service["request"] = async () => ({
    success: true,
    obj: {
      id: 3,
      remark: "broken reality",
      port: 57794,
      protocol: "vless",
      listen: "",
      settings: {
        clients: [
          {
            id: "client_uuid",
            email: "user@example.com",
            enable: true,
            flow: "xtls-rprx-vision"
          }
        ]
      },
      streamSettings: {
        network: "tcp",
        security: "reality",
        realitySettings: {
          serverNames: ["aws.amazon.com"],
          shortIds: ["67"],
          settings: {
            fingerprint: "chrome",
            serverName: "aws.amazon.com"
          }
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.getInboundRuntime({
        id: "node_1",
        panelBaseUrl: "https://panel.example.com/custom",
        panelApiBasePath: "/custom",
        panelUsername: "admin",
        panelPassword: "password",
        panelInboundId: 3
      }),
    /publicKey/
  );
}

async function testUpdateNodeAccessKeepsLocalSaveWhenPanelPresyncFails() {
  const createdRows: Array<Record<string, any>> = [];
  let published = false;
  const node = {
    id: "node_1",
    name: "node",
    countryCode: "US",
    region: "Los Angeles",
    provider: "provider",
    tags: [],
    isActive: true,
    recommended: true,
    latencyMs: 0,
    probeLatencyMs: null,
    protocol: "vless",
    security: "reality"
  };
  const service = createDevDataService({
    logger: {
      warn: () => undefined
    },
    requireSubscription: async () => ({
      id: "sub_1",
      userId: "user_1",
      teamId: null
    }),
    prisma: {
      subscriptionNodeAccess: {
        findMany: async (payload: { select?: unknown }) => {
          if (payload.select) {
            return [];
          }
          return [{ nodeId: "node_1", node }];
        },
        createMany: async (payload: Record<string, any>) => {
          createdRows.push(payload);
        }
      },
      node: {
        findMany: async () => [node]
      }
    },
    runtimeSessionService: {
      syncSubscriptionPanelAccess: async () => {
        throw new Error("3x-ui 面板接口路径错误，请检查面板地址或 API 基础路径");
      }
    },
    publishNodeAccessUpdatedEvent: async () => {
      published = true;
    }
  });

  const result = await service.updateSubscriptionNodeAccess("sub_1", { nodeIds: ["node_1"] });

  assert.equal(createdRows.length, 1, "local node authorization must be saved before panel pre-sync");
  assert.equal(published, true, "clients must still be notified after local authorization changes");
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /面板接口路径错误/);
  assert.match(result.message ?? "", /节点授权已保存/);
}

async function testUpdateNodeAccessKeepsLocalSaveWhenPublishFails() {
  const createdRows: Array<Record<string, any>> = [];
  const node = {
    id: "node_1",
    name: "node",
    countryCode: "US",
    region: "Los Angeles",
    provider: "provider",
    tags: [],
    isActive: true,
    recommended: true,
    latencyMs: 0,
    probeLatencyMs: null,
    protocol: "vless",
    security: "reality"
  };
  const service = createDevDataService({
    logger: {
      warn: () => undefined
    },
    requireSubscription: async () => ({
      id: "sub_1",
      userId: "user_1",
      teamId: null
    }),
    prisma: {
      subscriptionNodeAccess: {
        findMany: async (payload: { select?: unknown }) => {
          if (payload.select) {
            return [];
          }
          return [{ nodeId: "node_1", node }];
        },
        createMany: async (payload: Record<string, any>) => {
          createdRows.push(payload);
        }
      },
      node: {
        findMany: async () => [node]
      }
    },
    runtimeSessionService: {
      syncSubscriptionPanelAccess: async () => undefined
    },
    clientEventsPublisher: {
      publishNodeAccessUpdated: async () => {
        throw new Error("sse publish failed");
      }
    }
  });

  const result = await service.updateSubscriptionNodeAccess("sub_1", { nodeIds: ["node_1"] });

  assert.equal(createdRows.length, 1, "local node authorization must be saved even when publish fails");
  assert.deepEqual(result.nodeIds, ["node_1"]);
}

async function testUpdateNodeAccessReportsPendingWhenPanelDisableQueueFails() {
  const oldNode = {
    id: "node_old",
    name: "old",
    countryCode: "US",
    region: "Los Angeles",
    provider: "provider",
    tags: [],
    isActive: true,
    recommended: true,
    latencyMs: 0,
    probeLatencyMs: null,
    protocol: "vless",
    security: "reality"
  };
  const newNode = {
    ...oldNode,
    id: "node_new",
    name: "new"
  };
  let accessRows = [{ id: "access_old", nodeId: "node_old" }];
  const service = createDevDataService({
    logger: {
      warn: () => undefined
    },
    requireSubscription: async () => ({
      id: "sub_1",
      userId: "user_1",
      teamId: null
    }),
    prisma: {
      subscriptionNodeAccess: {
        findMany: async (payload: { select?: unknown }) => {
          if (payload.select) {
            return accessRows;
          }
          return [{ nodeId: "node_new", node: newNode }];
        },
        deleteMany: async () => {
          accessRows = accessRows.filter((row) => row.nodeId !== "node_old");
        },
        createMany: async () => {
          accessRows.push({ id: "access_new", nodeId: "node_new" });
        }
      },
      node: {
        findMany: async () => [newNode]
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          subscriptionNodeAccess: {
            deleteMany: async () => {
              accessRows = accessRows.filter((row) => row.nodeId !== "node_old");
            },
            createMany: async () => {
              accessRows.push({ id: "access_new", nodeId: "node_new" });
            }
          }
        })
    },
    runtimeSessionService: {
      markPanelBindingsDisabledForSubscription: async () => {
        throw new Error("panel job write failed");
      },
      queuePanelDisableJobsForSubscriptionTx: async () => {
        throw new Error("panel job write failed");
      },
      queueLeaseRevocationJobsForSubscriptionTx: async () => undefined,
      revokeSubscriptionLeases: async () => {
        throw new Error("lease revoke failed");
      },
      syncSubscriptionPanelAccess: async () => undefined
    },
    publishNodeAccessUpdatedEvent: async () => undefined
  });

  const result = await service.updateSubscriptionNodeAccess("sub_1", { nodeIds: ["node_new"] });

  assert.deepEqual(accessRows.map((row) => row.nodeId), ["node_new"], "local node access must save even when panel disable queueing fails");
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /panel job write failed/);
}

async function testClearNodeAccessReportsPendingWhenPanelDisableQueueFails() {
  const oldNode = {
    id: "node_old",
    name: "old",
    countryCode: "US",
    region: "Los Angeles",
    provider: "provider",
    tags: [],
    isActive: true,
    recommended: true,
    latencyMs: 0,
    probeLatencyMs: null,
    protocol: "vless",
    security: "reality"
  };
  let accessRows = [{ id: "access_old", nodeId: "node_old", node: oldNode }];
  const service = createDevDataService({
    logger: {
      warn: () => undefined
    },
    requireSubscription: async () => ({
      id: "sub_1",
      userId: "user_1",
      teamId: null
    }),
    prisma: {
      subscriptionNodeAccess: {
        findMany: async (payload: { select?: unknown }) => {
          if (payload.select) {
            return accessRows.map((row) => ({ id: row.id, nodeId: row.nodeId }));
          }
          return accessRows;
        },
        deleteMany: async () => {
          accessRows = [];
        }
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          subscriptionNodeAccess: {
            deleteMany: async () => {
              accessRows = [];
            }
          }
        })
    },
    runtimeSessionService: {
      markPanelBindingsDisabledForSubscription: async () => {
        throw new Error("panel job write failed");
      },
      queuePanelDisableJobsForSubscriptionTx: async () => {
        throw new Error("panel job write failed");
      },
      queueLeaseRevocationJobsForSubscriptionTx: async () => undefined,
      revokeSubscriptionLeases: async () => {
        throw new Error("lease revoke failed");
      }
    },
    publishNodeAccessUpdatedEvent: async () => undefined
  });

  const result = await service.updateSubscriptionNodeAccess("sub_1", { nodeIds: [] });

  assert.deepEqual(accessRows, [], "local node access must be cleared even when panel disable queueing fails");
  assert.deepEqual(result.nodeIds, []);
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /panel job write failed/);
  assert.match(result.panelSyncMessage ?? "", /lease revoke failed/);
}

async function testClearNodeAccessReturnsPendingWhenRevocationFollowUpStalls() {
  const oldNode = {
    id: "node_offline",
    name: "offline",
    countryCode: "US",
    region: "Los Angeles",
    provider: "provider",
    tags: [],
    isActive: true,
    recommended: true,
    latencyMs: 0,
    probeLatencyMs: null,
    protocol: "vless",
    security: "reality"
  };
  let accessRows = [{ id: "access_old", nodeId: "node_offline", node: oldNode }];
  let disableQueueStarted = false;
  const service = createDevDataService({
    logger: {
      warn: () => undefined
    },
    requireSubscription: async () => ({
      id: "sub_1",
      userId: "user_1",
      teamId: null
    }),
    prisma: {
      subscriptionNodeAccess: {
        findMany: async (payload: { select?: unknown }) => {
          if (payload.select) {
            return accessRows.map((row) => ({ id: row.id, nodeId: row.nodeId }));
          }
          return accessRows;
        },
        deleteMany: async () => {
          accessRows = [];
        }
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          subscriptionNodeAccess: {
            deleteMany: async () => {
              accessRows = [];
            }
          }
        })
    },
    runtimeSessionService: {
      markPanelBindingsDisabledForSubscription: async () => {
        disableQueueStarted = true;
        return new Promise<number>(() => undefined);
      },
      queueLeaseRevocationJobsForSubscriptionTx: async () => undefined,
      revokeSubscriptionLeases: async () => 0
    },
    publishNodeAccessUpdatedEvent: async () => undefined
  });

  const result = await Promise.race([
    service.updateSubscriptionNodeAccess("sub_1", { nodeIds: [] }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("clear node access waited for stalled revocation follow-up")), 750);
    })
  ]);

  assert.equal(disableQueueStarted, true);
  assert.deepEqual(accessRows, [], "local node access must be cleared before stalled follow-up finishes");
  assert.deepEqual(result.nodeIds, []);
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /still running in background/);
}

async function testClearNodeAccessDoesNotWaitForHeldUsageLock() {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  const oldNode = {
    id: "node_offline",
    name: "offline",
    countryCode: "US",
    region: "Los Angeles",
    provider: "provider",
    tags: [],
    isActive: true,
    recommended: true,
    latencyMs: 0,
    probeLatencyMs: null,
    protocol: "vless",
    security: "reality"
  };
  let releaseOuterLock!: () => void;
  let accessRows = [{ id: "access_old", nodeId: "node_offline", node: oldNode }];
  let queuedDisableJobs = 0;
  const heldLock = runWithSubscriptionUsageLock(
    "sub_held_lock",
    async () =>
      new Promise<void>((resolve) => {
        releaseOuterLock = resolve;
      })
  );

  try {
    for (let attempt = 0; !releaseOuterLock && attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const service = createDevDataService({
      logger: {
        warn: () => undefined
      },
      requireSubscription: async () => ({
        id: "sub_held_lock",
        userId: "user_1",
        teamId: null
      }),
      prisma: {
        subscriptionNodeAccess: {
          findMany: async (payload: { select?: unknown }) => {
            if (payload.select) {
              return accessRows.map((row) => ({ id: row.id, nodeId: row.nodeId }));
            }
            return accessRows;
          },
          deleteMany: async () => {
            accessRows = [];
          }
        },
        $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
          task({
            subscriptionNodeAccess: {
              deleteMany: async () => {
                accessRows = [];
              }
            }
          })
      },
      runtimeSessionService: {
        markPanelBindingsDisabledForSubscription: async () => {
          queuedDisableJobs += 1;
          return 1;
        },
        queueLeaseRevocationJobsForSubscriptionTx: async () => undefined,
        revokeSubscriptionLeases: async () => 0
      },
      publishNodeAccessUpdatedEvent: async () => undefined
    });

    const result = await Promise.race([
      service.updateSubscriptionNodeAccess("sub_held_lock", { nodeIds: [] }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("node access update waited for usage lock")), 250);
      })
    ]);

    assert.deepEqual(accessRows, [], "local node access must be cleared without waiting for usage sync lock");
    assert.equal(queuedDisableJobs, 1, "offline panel disable work must be queued after local revoke");
    assert.equal(result.panelSyncStatus, "pending");
    assert.deepEqual(result.nodeIds, []);
  } finally {
    if (releaseOuterLock) {
      releaseOuterLock();
    }
    await heldLock;
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  }
}

async function testRemoveSingleNodeAccessDoesNotWaitForHeldUsageLock() {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  const offlineNode = {
    id: "node_offline",
    name: "offline",
    countryCode: "US",
    region: "Los Angeles",
    provider: "provider",
    tags: [],
    isActive: true,
    recommended: false,
    latencyMs: 0,
    probeLatencyMs: null,
    protocol: "vless",
    security: "reality"
  };
  const keepNode = {
    ...offlineNode,
    id: "node_keep",
    name: "keep",
    recommended: true
  };
  let releaseOuterLock!: () => void;
  let accessRows = [
    { id: "access_offline", nodeId: "node_offline" },
    { id: "access_keep", nodeId: "node_keep" }
  ];
  let syncCalls = 0;
  let disableFilter: { nodeIds?: string[] } | undefined;
  const heldLock = runWithSubscriptionUsageLock(
    "sub_held_lock",
    async () =>
      new Promise<void>((resolve) => {
        releaseOuterLock = resolve;
      })
  );

  try {
    for (let attempt = 0; !releaseOuterLock && attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const service = createDevDataService({
      logger: {
        warn: () => undefined
      },
      requireSubscription: async () => ({
        id: "sub_held_lock",
        userId: "user_1",
        teamId: null
      }),
      prisma: {
        subscriptionNodeAccess: {
          findMany: async (payload: { select?: unknown }) => {
            if (payload.select) {
              return accessRows;
            }
            return accessRows.map((row) => ({
              ...row,
              node: row.nodeId === "node_keep" ? keepNode : offlineNode
            }));
          },
          deleteMany: async () => {
            accessRows = accessRows.filter((row) => row.nodeId !== "node_offline");
          }
        },
        node: {
          findMany: async () => [keepNode]
        },
        $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
          task({
            subscriptionNodeAccess: {
              deleteMany: async () => {
                accessRows = accessRows.filter((row) => row.nodeId !== "node_offline");
              }
            }
          })
      },
      runtimeSessionService: {
        markPanelBindingsDisabledForSubscription: async (_subscriptionId: string, filter?: { nodeIds?: string[] }) => {
          disableFilter = filter;
          return 1;
        },
        queueLeaseRevocationJobsForSubscriptionTx: async () => undefined,
        revokeSubscriptionLeases: async () => 0,
        syncSubscriptionPanelAccess: async () => {
          syncCalls += 1;
          throw new Error("removal-only access update must not full-sync remote panels");
        }
      },
      publishNodeAccessUpdatedEvent: async () => undefined
    });

    const result = await Promise.race([
      service.updateSubscriptionNodeAccess("sub_held_lock", { nodeIds: ["node_keep"] }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("single node access removal waited for usage lock")), 250);
      })
    ]);

    assert.deepEqual(accessRows.map((row) => row.nodeId), ["node_keep"]);
    assert.deepEqual(disableFilter, { nodeIds: ["node_offline"] });
    assert.equal(syncCalls, 0, "removing one node must not run full panel sync");
    assert.deepEqual(result.nodeIds, ["node_keep"]);
    assert.equal(result.panelSyncStatus, "pending");
    assert.match(result.panelSyncMessage ?? "", /disable job queued/);
  } finally {
    if (releaseOuterLock) {
      releaseOuterLock();
    }
    await heldLock;
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  }
}

async function testRemoveSingleNodeAccessReturnsPendingWhenRevocationFollowUpStalls() {
  const offlineNode = {
    id: "node_offline",
    name: "offline",
    countryCode: "US",
    region: "Los Angeles",
    provider: "provider",
    tags: [],
    isActive: true,
    recommended: false,
    latencyMs: 0,
    probeLatencyMs: null,
    protocol: "vless",
    security: "reality"
  };
  const keepNode = {
    ...offlineNode,
    id: "node_keep",
    name: "keep",
    recommended: true
  };
  let accessRows = [
    { id: "access_offline", nodeId: "node_offline" },
    { id: "access_keep", nodeId: "node_keep" }
  ];
  let disableFilter: { nodeIds?: string[] } | undefined;
  const service = createDevDataService({
    logger: {
      warn: () => undefined
    },
    requireSubscription: async () => ({
      id: "sub_1",
      userId: "user_1",
      teamId: null
    }),
    prisma: {
      subscriptionNodeAccess: {
        findMany: async (payload: { select?: unknown }) => {
          if (payload.select) {
            return accessRows;
          }
          return accessRows.map((row) => ({
            ...row,
            node: row.nodeId === "node_keep" ? keepNode : offlineNode
          }));
        },
        deleteMany: async () => {
          accessRows = accessRows.filter((row) => row.nodeId !== "node_offline");
        }
      },
      node: {
        findMany: async () => [keepNode]
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          subscriptionNodeAccess: {
            deleteMany: async () => {
              accessRows = accessRows.filter((row) => row.nodeId !== "node_offline");
            }
          }
        })
    },
    runtimeSessionService: {
      markPanelBindingsDisabledForSubscription: async (_subscriptionId: string, filter?: { nodeIds?: string[] }) => {
        disableFilter = filter;
        return new Promise<number>(() => undefined);
      },
      queueLeaseRevocationJobsForSubscriptionTx: async () => undefined,
      revokeSubscriptionLeases: async () => 0,
      syncSubscriptionPanelAccess: async () => {
        throw new Error("removal-only access update must not full-sync remote panels");
      }
    },
    publishNodeAccessUpdatedEvent: async () => undefined
  });

  const result = await Promise.race([
    service.updateSubscriptionNodeAccess("sub_1", { nodeIds: ["node_keep"] }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("single node removal waited for stalled revocation follow-up")), 750);
    })
  ]);

  assert.deepEqual(accessRows.map((row) => row.nodeId), ["node_keep"]);
  assert.deepEqual(disableFilter, { nodeIds: ["node_offline"] });
  assert.deepEqual(result.nodeIds, ["node_keep"]);
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /still running in background/);
}

async function testReplaceNodeAccessDoesNotWaitForHeldUsageLock() {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  const offlineNode = {
    id: "node_offline",
    name: "offline",
    countryCode: "US",
    region: "Los Angeles",
    provider: "provider",
    tags: [],
    isActive: true,
    recommended: false,
    latencyMs: 0,
    probeLatencyMs: null,
    protocol: "vless",
    security: "reality"
  };
  const newNode = {
    ...offlineNode,
    id: "node_new",
    name: "new",
    recommended: true
  };
  let releaseOuterLock!: () => void;
  let accessRows = [{ id: "access_offline", nodeId: "node_offline" }];
  let queuedAccessSync = 0;
  let syncCalls = 0;
  let disableFilter: { nodeIds?: string[] } | undefined;
  const heldLock = runWithSubscriptionUsageLock(
    "sub_held_lock",
    async () =>
      new Promise<void>((resolve) => {
        releaseOuterLock = resolve;
      })
  );

  try {
    for (let attempt = 0; !releaseOuterLock && attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const service = createDevDataService({
      logger: {
        warn: () => undefined
      },
      requireSubscription: async () => ({
        id: "sub_held_lock",
        userId: "user_1",
        teamId: null
      }),
      prisma: {
        subscriptionNodeAccess: {
          findMany: async (payload: { select?: unknown }) => {
            if (payload.select) {
              return accessRows;
            }
            return accessRows.map((row) => ({
              ...row,
              node: row.nodeId === "node_new" ? newNode : offlineNode
            }));
          },
          deleteMany: async () => {
            accessRows = accessRows.filter((row) => row.nodeId !== "node_offline");
          },
          createMany: async () => {
            accessRows.push({ id: "access_new", nodeId: "node_new" });
          }
        },
        node: {
          findMany: async () => [newNode]
        },
        $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
          task({
            subscriptionNodeAccess: {
              deleteMany: async () => {
                accessRows = accessRows.filter((row) => row.nodeId !== "node_offline");
              },
              createMany: async () => {
                accessRows.push({ id: "access_new", nodeId: "node_new" });
              }
            }
          })
      },
      runtimeSessionService: {
        markPanelBindingsDisabledForSubscription: async (_subscriptionId: string, filter?: { nodeIds?: string[] }) => {
          disableFilter = filter;
          return 1;
        },
        queueLeaseRevocationJobsForSubscriptionTx: async () => undefined,
        revokeSubscriptionLeases: async () => 0,
        queueSubscriptionPanelAccessSync: async () => {
          queuedAccessSync += 1;
          return 1;
        },
        syncSubscriptionPanelAccess: async () => {
          syncCalls += 1;
          throw new Error("node access replacement must not wait for the usage lock");
        }
      },
      publishNodeAccessUpdatedEvent: async () => undefined
    });

    const result = await Promise.race([
      service.updateSubscriptionNodeAccess("sub_held_lock", { nodeIds: ["node_new"] }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("node access replacement waited for usage lock")), 250);
      })
    ]);

    assert.deepEqual(accessRows.map((row) => row.nodeId), ["node_new"]);
    assert.deepEqual(disableFilter, { nodeIds: ["node_offline"] });
    assert.equal(queuedAccessSync, 1, "newly authorized nodes must queue panel access sync without taking the usage lock");
    assert.equal(syncCalls, 0, "node access replacement must not use the usage-locking panel sync path");
    assert.deepEqual(result.nodeIds, ["node_new"]);
    assert.equal(result.panelSyncStatus, "pending");
    assert.match(result.panelSyncMessage ?? "", /disable job queued/);
    assert.match(result.panelSyncMessage ?? "", /panel sync queued/);
  } finally {
    if (releaseOuterLock) {
      releaseOuterLock();
    }
    await heldLock;
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  }
}

async function testUpdateNodeAccessDoesNotFullSyncWhenOnlyRemovingNodes() {
  const oldNode = {
    id: "node_old",
    name: "old",
    countryCode: "US",
    region: "Los Angeles",
    provider: "provider",
    tags: [],
    isActive: true,
    recommended: false,
    latencyMs: 0,
    probeLatencyMs: null,
    protocol: "vless",
    security: "reality"
  };
  const newNode = {
    ...oldNode,
    id: "node_new",
    name: "new",
    recommended: true
  };
  let syncCalls = 0;
  let accessRows = [
    { id: "access_old", nodeId: "node_old" },
    { id: "access_new", nodeId: "node_new" }
  ];
  const service = createDevDataService({
    logger: {
      warn: () => undefined
    },
    requireSubscription: async () => ({
      id: "sub_1",
      userId: "user_1",
      teamId: null
    }),
    prisma: {
      subscriptionNodeAccess: {
        findMany: async (payload: { select?: unknown }) => {
          if (payload.select) {
            return accessRows;
          }
          return [{ nodeId: "node_new", node: newNode }];
        },
        deleteMany: async () => {
          accessRows = accessRows.filter((row) => row.nodeId !== "node_old");
        }
      },
      node: {
        findMany: async () => [newNode]
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          subscriptionNodeAccess: {
            deleteMany: async () => {
              accessRows = accessRows.filter((row) => row.nodeId !== "node_old");
            }
          }
        })
    },
    runtimeSessionService: {
      markPanelBindingsDisabledForSubscription: async () => 1,
      queuePanelDisableJobsForSubscriptionTx: async () => 1,
      queueLeaseRevocationJobsForSubscriptionTx: async () => undefined,
      revokeSubscriptionLeases: async () => 0,
      syncSubscriptionPanelAccess: async () => {
        syncCalls += 1;
        throw new Error("full subscription sync must not run for removal-only access updates");
      }
    },
    publishNodeAccessUpdatedEvent: async () => undefined
  });

  const result = await service.updateSubscriptionNodeAccess("sub_1", { nodeIds: ["node_new"] });

  assert.equal(syncCalls, 0, "removing a node must not full-sync the subscription in the request");
  assert.deepEqual(accessRows.map((row) => row.nodeId), ["node_new"]);
  assert.deepEqual(result.nodeIds, ["node_new"]);
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /disable job queued/);
}

async function testUpdateNodeAccessReportsPendingWhenLeaseRevocationFailsAfterPanelQueue() {
  const oldNode = {
    id: "node_old",
    name: "old",
    countryCode: "US",
    region: "Los Angeles",
    provider: "provider",
    tags: [],
    isActive: true,
    recommended: true,
    latencyMs: 0,
    probeLatencyMs: null,
    protocol: "vless",
    security: "reality"
  };
  const newNode = {
    ...oldNode,
    id: "node_new",
    name: "new"
  };
  let accessRows = [{ id: "access_old", nodeId: "node_old" }];
  const service = createDevDataService({
    logger: {
      warn: () => undefined
    },
    requireSubscription: async () => ({
      id: "sub_1",
      userId: "user_1",
      teamId: null
    }),
    prisma: {
      subscriptionNodeAccess: {
        findMany: async (payload: { select?: unknown }) => {
          if (payload.select) {
            return accessRows;
          }
          return [{ nodeId: "node_new", node: newNode }];
        },
        deleteMany: async () => {
          accessRows = accessRows.filter((row) => row.nodeId !== "node_old");
        },
        createMany: async () => {
          accessRows.push({ id: "access_new", nodeId: "node_new" });
        }
      },
      node: {
        findMany: async () => [newNode]
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          subscriptionNodeAccess: {
            deleteMany: async () => {
              accessRows = accessRows.filter((row) => row.nodeId !== "node_old");
            },
            createMany: async () => {
              accessRows.push({ id: "access_new", nodeId: "node_new" });
            }
          }
        })
    },
    runtimeSessionService: {
      markPanelBindingsDisabledForSubscription: async () => 1,
      queuePanelDisableJobsForSubscriptionTx: async () => 1,
      queueLeaseRevocationJobsForSubscriptionTx: async () => undefined,
      revokeSubscriptionLeases: async () => {
        throw new Error("lease revoke failed");
      },
      syncSubscriptionPanelAccess: async () => undefined
    },
    publishNodeAccessUpdatedEvent: async () => undefined
  });

  const result = await service.updateSubscriptionNodeAccess("sub_1", { nodeIds: ["node_new"] });

  assert.deepEqual(accessRows.map((row) => row.nodeId), ["node_new"], "local node access replacement can commit after disable jobs are durable");
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /disable job queued/);
  assert.match(result.panelSyncMessage ?? "", /lease revoke failed/);
}

async function testUpdateNodeAccessKeepsLocalSaveWhenResponseRefreshFails() {
  const oldNode = {
    id: "node_old",
    name: "old",
    countryCode: "US",
    region: "Los Angeles",
    provider: "provider",
    tags: [],
    isActive: true,
    recommended: true,
    latencyMs: 0,
    probeLatencyMs: null,
    protocol: "vless",
    security: "reality"
  };
  const newNode = {
    ...oldNode,
    id: "node_new",
    name: "new"
  };
  let accessRows = [{ id: "access_old", nodeId: "node_old" }];
  const service = createDevDataService({
    logger: {
      warn: () => undefined
    },
    requireSubscription: async () => ({
      id: "sub_1",
      userId: "user_1",
      teamId: null
    }),
    prisma: {
      subscriptionNodeAccess: {
        findMany: async (payload: { select?: unknown }) => {
          if (payload.select) {
            return accessRows;
          }
          throw new Error("response refresh failed");
        },
        deleteMany: async () => {
          accessRows = accessRows.filter((row) => row.nodeId !== "node_old");
        },
        createMany: async () => {
          accessRows.push({ id: "access_new", nodeId: "node_new" });
        }
      },
      node: {
        findMany: async () => [newNode]
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          subscriptionNodeAccess: {
            deleteMany: async () => {
              accessRows = accessRows.filter((row) => row.nodeId !== "node_old");
            },
            createMany: async () => {
              accessRows.push({ id: "access_new", nodeId: "node_new" });
            }
          }
        })
    },
    runtimeSessionService: {
      markPanelBindingsDisabledForSubscription: async () => 1,
      queuePanelDisableJobsForSubscriptionTx: async () => 1,
      queueLeaseRevocationJobsForSubscriptionTx: async () => undefined,
      revokeSubscriptionLeases: async () => 0,
      syncSubscriptionPanelAccess: async () => 0
    },
    publishNodeAccessUpdatedEvent: async () => undefined
  });

  const result = await service.updateSubscriptionNodeAccess("sub_1", { nodeIds: ["node_new"] });

  assert.deepEqual(accessRows.map((row) => row.nodeId), ["node_new"], "local authorization replacement must stay saved");
  assert.deepEqual(result.nodeIds, ["node_new"], "response should fall back to requested node ids after refresh failure");
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /response refresh failed/);
}

async function testKickTeamMemberReportsPendingWhenPanelOrLeaseSyncFails() {
  const service = createAdminSubscriptionService({
    requireTeamMember: async () => ({
      id: "member_1",
      teamId: "team_1",
      userId: "user_1",
      role: "member"
    }),
    findCurrentTeamSubscription: async () => ({
      id: "sub_team",
      teamId: "team_1",
      state: "active",
      remainingTrafficGb: 10,
      expireAt: new Date(Date.now() + 86_400_000)
    }),
    runtimeSessionService: {
      markPanelBindingsDisabledForSubscription: async () => {
        throw new Error("panel queue failed");
      },
      revokeSubscriptionLeases: async () => {
        throw new Error("lease revoke failed");
      }
    },
    requireTeamRecord: async () => ({
      id: "team_1",
      name: "Team",
      status: "active",
      ownerUserId: "owner_1",
      ownerName: "Owner",
      ownerEmail: "owner@example.com",
      memberCount: 1,
      subscription: null,
      members: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
  });

  const result = await service.kickTeamMember("team_1", "member_1", { disableAccount: false });

  assert.equal(result.ok, true);
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /panel queue failed/);
  assert.match(result.panelSyncMessage ?? "", /lease revoke failed/);
}

async function testKickTeamMemberReturnsPendingWhenTeamRecordRefreshFails() {
  const service = createAdminSubscriptionService({
    logger: {
      warn: () => undefined
    },
    requireTeamMember: async () => ({
      id: "member_1",
      teamId: "team_1",
      userId: "user_1",
      role: "member"
    }),
    findCurrentTeamSubscription: async () => null,
    requireTeamRecord: async () => {
      throw new Error("team list refresh failed");
    },
    prisma: {
      team: {
        findUnique: async () => createBasicTeamRow()
      }
    }
  });

  const result = await service.kickTeamMember("team_1", "member_1", { disableAccount: false });

  assert.equal(result.ok, true);
  assert.equal(result.team.id, "team_1");
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /team list refresh failed/);
}

async function testKickTeamMemberReturnsRevokedCountAndDisableAccountPending() {
  const service = createAdminSubscriptionService({
    requireTeamMember: async () => ({
      id: "member_1",
      teamId: "team_1",
      userId: "user_1",
      role: "member"
    }),
    findCurrentTeamSubscription: async () => ({
      id: "sub_team",
      teamId: "team_1",
      state: "active",
      remainingTrafficGb: 10,
      expireAt: new Date(Date.now() + 86_400_000)
    }),
    runtimeSessionService: {
      markPanelBindingsDisabledForSubscription: async () => 0,
      revokeSubscriptionLeases: async () => 2
    },
    updateUser: async () => ({
      id: "user_1",
      email: "user@example.com",
      displayName: "User",
      role: "customer",
      status: "disabled",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      subscriptions: [],
      teamMemberships: [],
      panelSyncStatus: "pending",
      panelSyncMessage: "disable account panel sync queued"
    }),
    requireTeamRecord: async () => ({
      id: "team_1",
      name: "Team",
      status: "active",
      ownerUserId: "owner_1",
      ownerName: "Owner",
      ownerEmail: "owner@example.com",
      memberCount: 1,
      subscription: null,
      members: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
  });

  const result = await service.kickTeamMember("team_1", "member_1", { disableAccount: true });

  assert.equal(result.disconnectedSessionCount, 2);
  assert.equal(result.accountDisabled, true);
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /disable account panel sync queued/);
}

async function testConvertPersonalSubscriptionToTeamReportsPendingWhenOldLeaseRevocationFails() {
  const archivedSubscriptions: Array<Record<string, any>> = [];
  const deletedSubscriptions: string[] = [];
  const service = createAdminSubscriptionService({
    requireSubscription: async () => ({
      id: "sub_personal",
      userId: "user_1",
      teamId: null
    }),
    ensureUserExists: async () => ({
      id: "user_1",
      status: "active"
    }),
    requireTeam: async () => ({
      id: "team_1",
      status: "active"
    }),
    getUserMembership: async () => null,
    findCurrentTeamSubscription: async () => ({
      id: "sub_team",
      teamId: "team_1",
      state: "active",
      remainingTrafficGb: 10,
      expireAt: new Date(Date.now() + 86_400_000)
    }),
    closePersonalSupportTicketsForUser: async () => undefined,
    requireTeamRecord: async () => ({
      id: "team_1",
      name: "Team"
    }),
    publishSubscriptionUpdatedEvent: async () => undefined,
    runtimeSessionService: {
      syncSubscriptionPanelAccess: async () => 0,
      revokeSubscriptionLeases: async () => {
        throw new Error("old lease revoke failed");
      },
      removePanelBindingsForSubscription: async () => ({ requested: 1, updated: 1, failed: [] }),
      assertPanelBindingMutation: () => undefined
    },
    prisma: {
      teamMember: {
        create: async () => ({}),
        deleteMany: async () => ({ count: 0 })
      },
      subscription: {
        update: async (payload: Record<string, any>) => {
          archivedSubscriptions.push(payload);
        },
        delete: async (payload: Record<string, any>) => {
          deletedSubscriptions.push(payload.where.id);
        }
      }
    }
  });

  const result = await service.convertPersonalSubscriptionToTeam("sub_personal", { targetTeamId: "team_1" });

  assert.equal(result.ok, true);
  assert.deepEqual(deletedSubscriptions, [], "converted personal subscription must stay in DB so queued panel cleanup jobs are not cascaded away");
  assert.equal(archivedSubscriptions.length, 1);
  assert.equal(archivedSubscriptions[0].where.id, "sub_personal");
  assert.equal(archivedSubscriptions[0].data.state, "expired");
  assert.equal(archivedSubscriptions[0].data.remainingTrafficGb, 0);
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /old lease revoke failed/);
}

async function testConvertPersonalSubscriptionToTeamReturnsPendingWhenTeamRefreshFails() {
  const archivedSubscriptions: Array<Record<string, any>> = [];
  const service = createAdminSubscriptionService({
    logger: {
      warn: () => undefined
    },
    requireSubscription: async () => ({
      id: "sub_personal",
      userId: "user_1",
      teamId: null
    }),
    ensureUserExists: async () => ({
      id: "user_1",
      status: "active"
    }),
    requireTeam: async () => ({
      id: "team_1",
      status: "active"
    }),
    getUserMembership: async () => null,
    findCurrentTeamSubscription: async () => ({
      id: "sub_team",
      teamId: "team_1",
      state: "active",
      remainingTrafficGb: 10,
      expireAt: new Date(Date.now() + 86_400_000)
    }),
    closePersonalSupportTicketsForUserBestEffort: async () => undefined,
    requireTeamRecord: async () => {
      throw new Error("team list refresh failed");
    },
    publishSubscriptionUpdatedEvent: async () => undefined,
    runtimeSessionService: {
      syncSubscriptionPanelAccess: async () => 0,
      revokeSubscriptionLeases: async () => 0,
      removePanelBindingsForSubscription: async () => ({ requested: 0, updated: 0, failed: [] }),
      assertPanelBindingMutation: () => undefined
    },
    prisma: {
      team: {
        findUnique: async () => createBasicTeamRow({ name: "Converted Team" })
      },
      teamMember: {
        create: async () => ({}),
        deleteMany: async () => ({ count: 0 })
      },
      subscription: {
        update: async (payload: Record<string, any>) => {
          archivedSubscriptions.push(payload);
        }
      }
    }
  });

  const result = await service.convertPersonalSubscriptionToTeam("sub_personal", { targetTeamId: "team_1" });

  assert.equal(result.ok, true);
  assert.equal(archivedSubscriptions.length, 1, "local personal subscription archive must save before team response refresh");
  assert.equal(result.teamName, "Converted Team");
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /team list refresh failed/);
}

async function testAdminListsSurfacePersistentPanelSyncPendingState() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const panelSyncJobs = [
    {
      subscriptionId: "sub_1",
      userId: "user_1",
      teamId: "team_1",
      status: "failed",
      lastError: "panel offline",
      updatedAt: now
    }
  ];
  const subscription = {
    id: "sub_1",
    userId: "user_1",
    teamId: null,
    planId: "plan_1",
    totalTrafficGb: 100,
    usedTrafficGb: 1,
    remainingTrafficGb: 99,
    expireAt: new Date(Date.now() + 60_000),
    state: "active",
    renewable: true,
    sourceAction: "created",
    lastSyncedAt: now,
    plan: { name: "Personal" },
    user: { email: "user@example.com", displayName: "User" },
    team: null,
    nodeAccesses: []
  };
  const service = createAdminSubscriptionService({
    prisma: {
      user: {
        findMany: async () => [
          {
            id: "user_1",
            email: "user@example.com",
            displayName: "User",
            role: "user",
            status: "active",
            lastSeenAt: now,
            maxConcurrentSessionsOverride: null,
            subscriptions: [subscription],
            teamMemberships: []
          }
        ]
      },
      subscription: {
        findMany: async () => [subscription]
      },
      team: {
        findMany: async () => [
          {
            id: "team_1",
            name: "Team",
            ownerUserId: "user_1",
            status: "active",
            createdAt: now,
            updatedAt: now,
            owner: { displayName: "User", email: "user@example.com" },
            members: [],
            subscriptions: []
          }
        ]
      },
      trafficLedger: {
        groupBy: async () => []
      },
      node: {
        findMany: async () => []
      },
      panelSyncJob: {
        findMany: async () => panelSyncJobs
      }
    }
  });

  const [users, subscriptions, teams] = await Promise.all([
    service.listAdminUsers(),
    service.listAdminSubscriptions(),
    service.listAdminTeams()
  ]);

  assert.equal(users[0].panelSyncStatus, "pending");
  assert.match(users[0].panelSyncMessage ?? "", /失败 1/);
  assert.match(users[0].panelSyncMessage ?? "", /panel offline/);
  assert.equal(subscriptions[0].panelSyncStatus, "pending");
  assert.match(subscriptions[0].panelSyncMessage ?? "", /失败 1/);
  assert.equal(teams[0].panelSyncStatus, "pending");
  assert.match(teams[0].panelSyncMessage ?? "", /失败 1/);
}

async function testConvertPersonalSubscriptionToTeamKeepsLocalFailureWhenRollbackPanelSyncFails() {
  const deletedMemberships: string[] = [];
  const service = createAdminSubscriptionService({
    logger: {
      warn: () => undefined
    },
    requireSubscription: async () => ({
      id: "sub_personal",
      userId: "user_1",
      teamId: null
    }),
    ensureUserExists: async () => ({
      id: "user_1",
      status: "active"
    }),
    requireTeam: async () => ({
      id: "team_1",
      status: "active"
    }),
    getUserMembership: async () => null,
    findCurrentTeamSubscription: async () => ({
      id: "sub_team",
      teamId: "team_1",
      state: "active",
      remainingTrafficGb: 10,
      expireAt: new Date(Date.now() + 86_400_000)
    }),
    closePersonalSupportTicketsForUserBestEffort: async () => undefined,
    runtimeSessionService: {
      syncSubscriptionPanelAccess: async () => {
        throw new Error("panel rollback failed");
      },
      revokeSubscriptionLeases: async () => 0,
      removePanelBindingsForSubscription: async () => ({ requested: 0, updated: 0, failed: [] }),
      assertPanelBindingMutation: () => undefined
    },
    prisma: {
      teamMember: {
        create: async () => ({}),
        deleteMany: async (payload: Record<string, any>) => {
          deletedMemberships.push(payload.where.id);
          return { count: 1 };
        }
      },
      subscription: {
        update: async () => {
          throw new Error("local archive failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.convertPersonalSubscriptionToTeam("sub_personal", { targetTeamId: "team_1" }),
    /local archive failed/
  );
  assert.equal(deletedMemberships.length, 1, "created team membership must be rolled back after local conversion failure");
}

async function testDisableNodeQueuesPanelSyncWithoutBlockingLocalSave() {
  const now = new Date();
  const currentNode = {
    id: "node_1",
    name: "node",
    countryCode: "US",
    region: "Los Angeles",
    provider: "provider",
    tags: [],
    isActive: true,
    recommended: true,
    latencyMs: 0,
    probeLatencyMs: null,
    protocol: "vless",
    security: "reality",
    serverHost: "node.example.com",
    serverPort: 443,
    serverName: "node.example.com",
    shortId: "abc",
    spiderX: "/",
    subscriptionUrl: null,
    statsLastSyncedAt: null,
    panelBaseUrl: "https://panel.example.com",
    panelApiBasePath: "/",
    panelUsername: "admin",
    panelPassword: "password",
    panelInboundId: 1,
    panelEnabled: true,
    panelStatus: "online" as const,
    panelLastSyncedAt: now,
    panelError: null,
    probeStatus: "unknown" as const,
    probeCheckedAt: null,
    probeError: null,
    createdAt: now,
    updatedAt: now
  };
  let updatedData: Record<string, any> | null = null;
  let queuedNodeId: string | null = null;
  let remoteDisableCalled = false;
  const service = createAdminNodeService({
    runtimeSessionService: {
      revokeNodeLeases: async () => 1,
      disablePanelBindingsForNode: async () => {
        remoteDisableCalled = true;
        throw new Error("remote panel disable must not run inline");
      },
      markPanelBindingsDisabledForNode: async (nodeId: string) => {
        queuedNodeId = nodeId;
        return 1;
      },
      clearPendingPanelDisableJobsForNode: async () => 0,
      syncPanelAccessForNode: async () => ({ requested: 0, updated: 0, failed: [] })
    },
    clientEventsPublisher: {
      publishNodeAccessUpdatedForNode: async () => undefined
    },
    prisma: {
      node: {
        findUnique: async () => currentNode,
        update: async (payload: Record<string, any>) => {
          updatedData = payload.data;
          return { ...currentNode, ...payload.data, updatedAt: now };
        }
      }
    }
  });

  const result = await service.updateNode("node_1", { isActive: false });

  assert.equal(result.isActive, false);
  assert.equal(updatedData?.isActive, false, "local node state must be saved even when panel disable is pending");
  assert.equal(queuedNodeId, "node_1", "failed remote disable must leave a retry job instead of blocking the save");
  assert.equal(remoteDisableCalled, false, "node disable must queue panel sync instead of waiting for remote panel calls");
}

async function testDisableNodeKeepsLocalSaveWhenEffectsFail() {
  const now = new Date();
  const currentNode = {
    id: "node_1",
    name: "node",
    countryCode: "US",
    region: "Los Angeles",
    provider: "provider",
    tags: [],
    isActive: true,
    recommended: true,
    latencyMs: 0,
    probeLatencyMs: null,
    protocol: "vless",
    security: "reality",
    serverHost: "node.example.com",
    serverPort: 443,
    serverName: "node.example.com",
    shortId: "abc",
    spiderX: "/",
    subscriptionUrl: null,
    statsLastSyncedAt: null,
    panelBaseUrl: "https://panel.example.com",
    panelApiBasePath: "/",
    panelUsername: "admin",
    panelPassword: "password",
    panelInboundId: 1,
    panelEnabled: true,
    panelStatus: "online" as const,
    panelLastSyncedAt: now,
    panelError: null,
    probeStatus: "unknown" as const,
    probeCheckedAt: null,
    probeError: null,
    createdAt: now,
    updatedAt: now
  };
  let updatedData: Record<string, any> | null = null;
  const service = createAdminNodeService({
    runtimeSessionService: {
      revokeNodeLeases: async () => {
        throw new Error("lease revoke failed");
      },
      markPanelBindingsDisabledForNode: async () => {
        throw new Error("panel queue failed");
      },
      clearPendingPanelDisableJobsForNode: async () => 0,
      syncPanelAccessForNode: async () => 0
    },
    clientEventsPublisher: {
      publishNodeAccessUpdatedForNode: async () => {
        throw new Error("publish failed");
      }
    },
    prisma: {
      node: {
        findUnique: async () => currentNode,
        update: async (payload: Record<string, any>) => {
          updatedData = payload.data;
          return { ...currentNode, ...payload.data, updatedAt: now };
        }
      }
    }
  });

  const result = await service.updateNode("node_1", { isActive: false });

  assert.equal(result.isActive, false);
  assert.equal(updatedData?.isActive, false, "local node state must save even when revoke, queue, and publish fail");
}

async function testPanelDisableJobUpsertResetsStaleFailureState() {
  const upserts: Array<Record<string, any>> = [];
  const service = createRuntimeSessionService({
    prisma: {
      panelClientBinding: {
        findMany: async () => [
          {
            id: "binding_1",
            subscriptionId: "sub_1",
            userId: "user_1",
            teamId: null,
            nodeId: "node_1",
            panelClientEmail: "user@example.com",
            panelClientId: "panel_client_1",
            panelInboundId: 7
          }
        ]
      },
      panelSyncJob: {
        upsert: async (payload: Record<string, any>) => {
          upserts.push(payload);
          return {};
        }
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          panelClientBinding: {
            findMany: async () => [
              {
                id: "binding_1",
                subscriptionId: "sub_1",
                userId: "user_1",
                teamId: null,
                nodeId: "node_1",
                panelClientEmail: "user@example.com",
                panelClientId: "panel_client_1",
                panelInboundId: 7
              }
            ]
          },
          panelSyncJob: {
            upsert: async (payload: Record<string, any>) => {
              upserts.push(payload);
              return {};
            }
          }
        })
    }
  });

  await service.markPanelBindingsDisabledForSubscription("sub_1");

  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].update.attempts, 0, "re-queued disable jobs must reset stale retry attempts");
  assert.equal(upserts[0].update.lastError, null, "re-queued disable jobs must clear stale errors");
  assert.equal(upserts[0].update.panelClientEmail, "user@example.com", "re-queued disable jobs must refresh client email");
  assert.equal(upserts[0].update.panelClientId, "panel_client_1", "re-queued disable jobs must refresh client id");
  assert.equal(upserts[0].update.panelInboundId, 7, "re-queued disable jobs must refresh binding inbound id");
}

async function testPanelDisableJobStoresAndUsesPanelSnapshot() {
  const upserts: Array<Record<string, any>> = [];
  const disabledConfigs: Array<Record<string, any>> = [];
  const service = createRuntimeSessionService({
    xuiService: {
      setClientEnabled: async (node: Record<string, any>) => {
        disabledConfigs.push(node);
      }
    },
    prisma: {
      panelClientBinding: {
        findMany: async () => [
          {
            id: "binding_1",
            subscriptionId: "sub_1",
            userId: "user_1",
            teamId: null,
            nodeId: "node_1",
            panelClientEmail: "user@example.com",
            panelClientId: "panel_client_1",
            panelInboundId: 7,
            node: {
              panelBaseUrl: "https://old-panel.example.com",
              panelApiBasePath: "/old",
              panelUsername: "old-user",
              panelPassword: "old-pass"
            }
          }
        ],
        update: async () => ({})
      },
      panelSyncJob: {
        findUnique: async () => ({
          id: "job_1",
          userId: "user_1",
          teamId: null,
          binding: {
            status: "active",
            user: { status: "active" }
          },
          node: {
            isActive: false,
            panelEnabled: false
          },
          subscription: {
            userId: "user_1",
            teamId: null,
            state: "active",
            expireAt: new Date(Date.now() + 86_400_000),
            remainingTrafficGb: 10,
            user: { status: "active" },
            team: null,
            nodeAccesses: []
          }
        }),
        upsert: async (payload: Record<string, any>) => {
          upserts.push(payload);
          return {};
        },
        update: async () => ({})
      },
      $transaction: async (input: Array<Promise<unknown>> | ((tx: Record<string, any>) => Promise<unknown>)) => {
        if (typeof input === "function") {
          return input({
            panelClientBinding: {
              findMany: async () => [
                {
                  id: "binding_1",
                  subscriptionId: "sub_1",
                  userId: "user_1",
                  teamId: null,
                  nodeId: "node_1",
                  panelClientEmail: "user@example.com",
                  panelClientId: "panel_client_1",
                  panelInboundId: 7,
                  node: {
                    panelBaseUrl: "https://old-panel.example.com",
                    panelApiBasePath: "/old",
                    panelUsername: "old-user",
                    panelPassword: "old-pass"
                  }
                }
              ]
            },
            panelSyncJob: {
              upsert: async (payload: Record<string, any>) => {
                upserts.push(payload);
                return {};
              }
            }
          });
        }
        await Promise.all(input);
      }
    }
  });

  await service.markPanelBindingsDisabledForSubscription("sub_1");
  assert.equal(upserts[0].create.panelBaseUrl, "https://old-panel.example.com");
  assert.equal(upserts[0].create.panelApiBasePath, "/old");

  await service["runPanelSyncJob"]({
    id: "job_1",
    action: "disable_client",
    attempts: 0,
    bindingId: "binding_1",
    subscriptionId: "sub_1",
    nodeId: "node_1",
    panelClientEmail: "user@example.com",
    panelClientId: "panel_client_1",
    panelInboundId: 7,
    panelBaseUrl: "https://old-panel.example.com",
    panelApiBasePath: "/old",
    panelUsername: "old-user",
    panelPassword: "old-pass",
    node: {
      id: "node_1",
      isActive: true,
      panelEnabled: true,
      panelBaseUrl: "https://new-panel.example.com",
      panelApiBasePath: "/new",
      panelUsername: "new-user",
      panelPassword: "new-pass",
      panelInboundId: 9
    },
    binding: {
      status: "active"
    }
  });

  assert.equal(disabledConfigs[0].panelBaseUrl, "https://old-panel.example.com");
  assert.equal(disabledConfigs[0].panelApiBasePath, "/old");
  assert.equal(disabledConfigs[0].panelUsername, "old-user");
  assert.equal(disabledConfigs[0].panelInboundId, 7);
}

async function testPanelDisableJobCompletionDoesNotResolveUsageIncident() {
  const panelJobUpdates: Array<Record<string, any>> = [];
  let meteringIncidentTouched = false;
  const service = createRuntimeSessionService({
    prisma: {
      panelSyncJob: {
        update: async (payload: Record<string, any>) => {
          panelJobUpdates.push(payload);
        }
      },
      meteringIncident: {
        updateMany: async () => {
          meteringIncidentTouched = true;
          throw new Error("usage incidents must not be resolved by panel disable jobs");
        }
      }
    }
  });

  await service["completePanelSyncJob"]({
    id: "job_1",
    subscriptionId: "sub_1",
    nodeId: "node_1"
  });

  assert.equal(panelJobUpdates.length, 1);
  assert.equal(panelJobUpdates[0].data.status, "completed");
  assert.equal(meteringIncidentTouched, false);
}

async function testDeletedPanelBindingDoesNotReuseOldInboundId() {
  const updates: Array<Record<string, any>> = [];
  const panelSyncUpserts: Array<Record<string, any>> = [];
  const baseline = {
    uplinkBytes: 0n,
    downlinkBytes: 0n,
    sampledAt: new Date("2026-01-01T00:00:00.000Z")
  };
  const service = createRuntimeSessionService({
    xuiService: {
      ensureClient: async () => {
        throw new Error("remote panel ensure must not run inline");
      }
    },
    readPanelClientBaseline: async () => baseline,
    ensureTrafficSnapshotBaseline: async () => undefined,
    prisma: {
      panelClientBinding: {
        findFirst: async () => ({
          id: "binding_1",
          subscriptionId: "sub_1",
          userId: "user_1",
          teamId: null,
          nodeId: "node_1",
          panelClientEmail: "user@example.com",
          panelClientId: "old-panel-client",
          panelInboundId: 7,
          status: "deleted",
          lastUplinkBytes: 0n,
          lastDownlinkBytes: 0n,
          lastSyncedAt: baseline.sampledAt,
          createdAt: baseline.sampledAt,
          updatedAt: baseline.sampledAt
        }),
        update: async (payload: Record<string, any>) => {
          updates.push(payload);
          return {
            id: "binding_1",
            subscriptionId: "sub_1",
            userId: "user_1",
            teamId: null,
            nodeId: "node_1",
            panelClientEmail: payload.data.panelClientEmail,
            panelClientId: payload.data.panelClientId,
            panelInboundId: payload.data.panelInboundId,
            status: payload.data.status,
            lastUplinkBytes: payload.data.lastUplinkBytes,
            lastDownlinkBytes: payload.data.lastDownlinkBytes,
            lastSyncedAt: payload.data.lastSyncedAt
          };
        }
      },
      trafficSnapshot: {
        findUnique: async () => null
      },
      panelSyncJob: {
        upsert: async (payload: Record<string, any>) => {
          panelSyncUpserts.push(payload);
          return {};
        }
      }
    }
  });

  const binding = await service["ensurePanelClientBinding"]({
    node: {
      id: "node_1",
      name: "Node 1",
      flow: "xtls-rprx-vision",
      panelBaseUrl: "https://panel.example.com/new-path",
      panelApiBasePath: "/",
      panelUsername: "admin",
      panelPassword: "password",
      panelInboundId: null,
      panelEnabled: true
    },
    subscriptionId: "sub_1",
    userId: "user_1",
    teamId: null,
    userEmail: "user@example.com",
    userDisplayName: "User",
    expireAt: new Date("2026-02-01T00:00:00.000Z")
  });

  assert.equal(updates[0].data.panelInboundId, 0, "locally recreated binding must not reuse the deleted binding inbound id");
  assert.equal(binding.panelInboundId, 0);
  assert.equal(panelSyncUpserts[0].create.action, "ensure_client");
  assert.equal(panelSyncUpserts[0].create.panelInboundId, 0);
}

async function testDisablePanelBindingUsesStoredInboundId() {
  const upserts: Array<Record<string, any>> = [];
  let xuiCalled = false;
  const service = createRuntimeSessionService({
    xuiService: {
      setClientEnabled: async () => {
        xuiCalled = true;
        throw new Error("remote panel disable must not run inline");
      }
    },
    prisma: {
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          panelClientBinding: {
            findMany: async () => [
              {
                id: "binding_1",
                subscriptionId: "sub_1",
                userId: "user_1",
                teamId: null,
                nodeId: "node_1",
                panelClientEmail: "user@example.com",
                panelClientId: "panel_client_1",
                panelInboundId: 7,
                node: {
                  panelBaseUrl: "https://panel.example.com",
                  panelApiBasePath: "/",
                  panelUsername: "admin",
                  panelPassword: "password"
                }
              }
            ]
          },
          panelSyncJob: {
            upsert: async (payload: Record<string, any>) => {
              upserts.push(payload);
              return {};
            }
          }
        })
    }
  });

  const result = await service.disablePanelBindingsForSubscription("sub_1");

  assert.equal(result.failed.length, 0);
  assert.equal(result.updated, 1);
  assert.equal(xuiCalled, false, "disable must queue panel sync instead of waiting for remote panel calls");
  assert.equal(upserts[0].create.panelInboundId, 7, "disable job must use the binding inbound id captured at provision time");
}

async function testUsageSyncUsesStoredInboundIdGroups() {
  const inboundIds: Array<number | null> = [];
  const appliedEmails: string[][] = [];
  const service = createUsageSyncService({
    xuiService: {
      listNodeUsage: async (node: { panelInboundId: number | null }) => {
        inboundIds.push(node.panelInboundId);
        return [
          {
            xrayUserEmail: node.panelInboundId === 7 ? "alpha@example.com" : "beta@example.com",
            xrayUserUuid: "",
            uplinkBytes: 0n,
            downlinkBytes: 0n,
            sampledAt: new Date().toISOString()
          }
        ];
      }
    },
    prisma: {
      panelClientBinding: {
        findMany: async () => [
          {
            id: "binding_1",
            subscriptionId: "sub_1",
            userId: "user_1",
            teamId: null,
            nodeId: "node_1",
            panelClientEmail: "alpha@example.com",
            panelClientId: "panel_client_1",
            panelInboundId: 7,
            node: {
              id: "node_1",
              panelBaseUrl: "https://panel.example.com",
              panelApiBasePath: "/",
              panelUsername: "admin",
              panelPassword: "password",
              panelInboundId: 99
            }
          },
          {
            id: "binding_2",
            subscriptionId: "sub_2",
            userId: "user_2",
            teamId: null,
            nodeId: "node_1",
            panelClientEmail: "beta@example.com",
            panelClientId: "panel_client_2",
            panelInboundId: 8,
            node: {
              id: "node_1",
              panelBaseUrl: "https://panel.example.com",
              panelApiBasePath: "/",
              panelUsername: "admin",
              panelPassword: "password",
              panelInboundId: 99
            }
          }
        ]
      },
      node: {
        update: async () => undefined
      }
    },
    loadNodeSyncContext: async () => ({}),
    applyNodeSamples: async (_nodeId: string, records: Array<{ xrayUserEmail: string }>) => {
      appliedEmails.push(records.map((record) => record.xrayUserEmail));
    },
    resolveIncidentForSubscriptions: async () => undefined,
    openIncidentForSubscriptions: async () => undefined
  });

  await service["syncXuiUsage"]();

  assert.deepEqual(inboundIds.sort((left, right) => Number(left) - Number(right)), [7, 8]);
  assert.deepEqual(appliedEmails, [["alpha@example.com"], ["beta@example.com"]]);
}

async function testUsageSyncKeepsNodeDegradedWhenAnyInboundFails() {
  const nodeUpdates: Array<Record<string, any>> = [];
  const openedIncidents: Array<{ subscriptionIds: string[]; nodeId: string; detail: string }> = [];
  const resolvedIncidents: Array<{ subscriptionIds: string[]; nodeId: string }> = [];
  const makeBinding = (id: string, subscriptionId: string, email: string, panelInboundId: number) => ({
    id,
    subscriptionId,
    userId: `user_${id}`,
    teamId: null,
    nodeId: "node_1",
    panelClientEmail: email,
    panelClientId: `client_${id}`,
    panelInboundId,
    node: {
      id: "node_1",
      panelBaseUrl: "https://panel.example.com",
      panelApiBasePath: "/",
      panelUsername: "admin",
      panelPassword: "password",
      panelInboundId: 99
    }
  });
  const service = createUsageSyncService({
    warningTimestamps: new Map<string, number>(),
    logger: {
      warn: () => undefined
    },
    xuiService: {
      listNodeUsage: async (node: { panelInboundId: number | null }) => {
        if (node.panelInboundId === 7) {
          throw new Error("inbound 7 failed");
        }
        return [
          {
            xrayUserEmail: "beta@example.com",
            xrayUserUuid: "",
            uplinkBytes: 0n,
            downlinkBytes: 0n,
            sampledAt: new Date().toISOString()
          }
        ];
      }
    },
    prisma: {
      panelClientBinding: {
        findMany: async () => [
          makeBinding("1", "sub_1", "alpha@example.com", 7),
          makeBinding("2", "sub_2", "beta@example.com", 8)
        ]
      },
      node: {
        update: async (payload: Record<string, any>) => {
          nodeUpdates.push(payload.data);
        }
      }
    },
    loadNodeSyncContext: async () => ({}),
    applyNodeSamples: async () => undefined,
    openIncidentForSubscriptions: async (subscriptionIds: string[], nodeId: string, _reason: string, detail: string) => {
      openedIncidents.push({ subscriptionIds, nodeId, detail });
    },
    resolveIncidentForSubscriptions: async (subscriptionIds: string[], nodeId: string) => {
      resolvedIncidents.push({ subscriptionIds, nodeId });
    }
  });

  await service["syncXuiUsage"]();

  assert.equal(openedIncidents.length, 1);
  assert.equal(resolvedIncidents.length, 0, "one successful inbound must not resolve the node incident while another inbound failed");
  assert.deepEqual(
    nodeUpdates.map((item) => item.panelStatus),
    ["degraded"],
    "node status must remain degraded when any inbound sync fails"
  );
  assert.match(nodeUpdates[0].panelError, /inbound 7 failed/);
}

async function testUpdateNodeUsesExplicitClearedInboundIdForPanelRefresh() {
  const capturedInboundIds: Array<number | null> = [];
  const now = new Date();
  const currentNode = {
    id: "node_1",
    name: "node",
    countryCode: "US",
    region: "Los Angeles",
    provider: "provider",
    tags: [],
    isActive: true,
    recommended: true,
    latencyMs: 0,
    probeLatencyMs: null,
    protocol: "vless",
    security: "reality",
    serverHost: "old.example.com",
    serverPort: 443,
    uuid: "uuid",
    flow: "xtls-rprx-vision",
    realityPublicKey: "public_key",
    shortId: "short_id",
    serverName: "old.example.com",
    fingerprint: "chrome",
    spiderX: "/",
    subscriptionUrl: null,
    statsLastSyncedAt: null,
    panelBaseUrl: "https://panel.example.com",
    panelApiBasePath: "/",
    panelUsername: "admin",
    panelPassword: "password",
    panelInboundId: 99,
    panelEnabled: true,
    panelStatus: "online" as const,
    panelLastSyncedAt: null,
    panelError: null,
    probeStatus: "unknown" as const,
    probeCheckedAt: null,
    probeError: null,
    createdAt: now,
    updatedAt: now
  };
  const service = createAdminNodeService({
    xuiService: {
      getInboundRuntime: async (node: { panelInboundId: number | null }) => {
        capturedInboundIds.push(node.panelInboundId);
        return {
          inboundId: 7,
          name: "node",
          serverHost: "new.example.com",
          serverPort: 443,
          uuid: "uuid",
          flow: "xtls-rprx-vision",
          realityPublicKey: "public_key",
          shortId: "short_id",
          serverName: "new.example.com",
          fingerprint: "chrome",
          spiderX: "/"
        };
      }
    },
    runtimeSessionService: {
      revokeNodeLeases: async () => 0,
      removePanelBindingsForNode: async () => ({ requested: 0, updated: 0, failed: [] }),
      assertPanelBindingMutation: () => undefined,
      syncPanelAccessForNode: async () => 0
    },
    clientEventsPublisher: {
      publishNodeAccessUpdatedForNode: async () => undefined
    },
    prisma: {
      node: {
        findUnique: async () => currentNode,
        update: async (payload: { data: Record<string, unknown> }) => ({
          ...currentNode,
          ...payload.data,
          updatedAt: new Date()
        })
      }
    }
  });

  const record = await service.updateNode("node_1", { panelInboundId: null });

  assert.deepEqual(capturedInboundIds, [null], "panel refresh must respect explicit inbound-id clearing");
  assert.equal(record.panelInboundId, null);
}

function makeAdminNodeRow(overrides: Record<string, any> = {}) {
  const now = new Date();
  return {
    id: "node_1",
    name: "node",
    countryCode: "US",
    region: "Los Angeles",
    provider: "provider",
    tags: [],
    isActive: true,
    recommended: true,
    latencyMs: 0,
    probeLatencyMs: null,
    protocol: "vless",
    security: "reality",
    serverHost: "old.example.com",
    serverPort: 443,
    uuid: "uuid",
    flow: "xtls-rprx-vision",
    realityPublicKey: "public_key",
    shortId: "short_id",
    serverName: "old.example.com",
    fingerprint: "chrome",
    spiderX: "/",
    subscriptionUrl: null,
    statsLastSyncedAt: null,
    panelBaseUrl: "https://old-panel.example.com",
    panelApiBasePath: "/old",
    panelUsername: "admin",
    panelPassword: "password",
    panelInboundId: 99,
    panelEnabled: true,
    panelStatus: "online" as const,
    panelLastSyncedAt: null,
    panelError: null,
    probeStatus: "unknown" as const,
    probeCheckedAt: null,
    probeError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

async function testUpdateNodePanelMigrationPersistsNewConfigWhenOldCleanupFails() {
  const currentNode = makeAdminNodeRow();
  const updates: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  let cleanupPanelConfig: Record<string, unknown> | undefined;
  const service = createAdminNodeService({
    xuiService: {
      getInboundRuntime: async () => ({
        inboundId: 7,
        name: "node",
        serverHost: "new.example.com",
        serverPort: 443,
        uuid: "uuid",
        flow: "xtls-rprx-vision",
        realityPublicKey: "public_key",
        shortId: "short_id",
        serverName: "new.example.com",
        fingerprint: "chrome",
        spiderX: "/"
      })
    },
    runtimeSessionService: {
      revokeNodeLeases: async () => {
        calls.push("revoke");
        return 1;
      },
      removePanelBindingsForNode: async (_nodeId: string, panelConfig: Record<string, unknown>) => {
        cleanupPanelConfig = panelConfig;
        calls.push("remove_old");
        return {
          requested: 1,
          updated: 0,
          failed: [
            {
              bindingId: "binding_1",
              nodeId: "node_1",
              nodeName: "node",
              panelClientEmail: "user@example.com",
              error: "old panel path failed"
            }
          ]
        };
      },
      markPanelBindingsDeletedForNode: async () => {
        calls.push("mark_deleted");
        return 1;
      },
      syncPanelAccessForNode: async () => {
        calls.push("sync_new");
        return 1;
      }
    },
    clientEventsPublisher: {
      publishNodeAccessUpdatedForNode: async () => undefined
    },
    prisma: {
      node: {
        findUnique: async () => currentNode,
        update: async (payload: { data: Record<string, unknown> }) => {
          updates.push(payload.data);
          return {
            ...currentNode,
            ...payload.data,
            updatedAt: new Date()
          };
        }
      }
    }
  });

  const record = await service.updateNode("node_1", {
    panelBaseUrl: "https://new-panel.example.com",
    panelApiBasePath: "/new"
  });

  assert.equal(record.panelBaseUrl, "https://new-panel.example.com");
  assert.equal(record.panelApiBasePath, "/new");
  assert.deepEqual(calls, ["revoke", "remove_old", "mark_deleted", "sync_new"]);
  assert.equal(updates[0].panelBaseUrl, "https://new-panel.example.com");
  assert.equal(cleanupPanelConfig?.panelBaseUrl, "https://old-panel.example.com");
  assert.equal(cleanupPanelConfig?.panelApiBasePath, "/old");
}

async function testUpdateNodePanelMigrationKeepsLocalConfigWhenNewPanelReadFails() {
  const currentNode = makeAdminNodeRow();
  const updates: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  const service = createAdminNodeService({
    logger: {
      warn: () => undefined
    },
    xuiService: {
      getInboundRuntime: async () => {
        throw new Error("new panel offline");
      }
    },
    runtimeSessionService: {
      revokeNodeLeases: async () => {
        calls.push("revoke");
        return 1;
      },
      removePanelBindingsForNode: async () => {
        calls.push("remove_old");
        return { requested: 1, updated: 1, failed: [] };
      },
      syncPanelAccessForNode: async () => {
        calls.push("sync_new");
        return 1;
      }
    },
    clientEventsPublisher: {
      publishNodeAccessUpdatedForNode: async () => undefined
    },
    prisma: {
      node: {
        findUnique: async () => currentNode,
        update: async (payload: { data: Record<string, unknown> }) => {
          updates.push(payload.data);
          return {
            ...currentNode,
            ...payload.data,
            updatedAt: new Date()
          };
        }
      }
    }
  });

  const record = await service.updateNode("node_1", {
    panelBaseUrl: "https://new-panel.example.com",
    panelApiBasePath: "/new"
  });

  assert.equal(record.panelBaseUrl, "https://new-panel.example.com");
  assert.equal(record.panelApiBasePath, "/new");
  assert.equal(record.panelStatus, "degraded");
  assert.equal(updates[0].panelError, "new panel offline");
  assert.deepEqual(calls, ["revoke", "remove_old", "sync_new"]);
}

async function testUpdateNodePanelMigrationDoesNotCleanupOldPanelWhenLocalSaveFails() {
  const currentNode = makeAdminNodeRow();
  const calls: string[] = [];
  const service = createAdminNodeService({
    xuiService: {
      getInboundRuntime: async () => ({
        inboundId: 7,
        name: "node",
        serverHost: "new.example.com",
        serverPort: 443,
        uuid: "uuid",
        flow: "xtls-rprx-vision",
        realityPublicKey: "public_key",
        shortId: "short_id",
        serverName: "new.example.com",
        fingerprint: "chrome",
        spiderX: "/"
      })
    },
    runtimeSessionService: {
      revokeNodeLeases: async () => {
        calls.push("revoke");
      },
      removePanelBindingsForNode: async () => {
        calls.push("remove_old");
        return { requested: 0, updated: 0, failed: [] };
      },
      markPanelBindingsDeletedForNode: async () => {
        calls.push("mark_deleted");
      },
      syncPanelAccessForNode: async () => {
        calls.push("sync_new");
      }
    },
    clientEventsPublisher: {
      publishNodeAccessUpdatedForNode: async () => undefined
    },
    prisma: {
      node: {
        findUnique: async () => currentNode,
        update: async () => {
          throw new Error("local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.updateNode("node_1", {
        panelBaseUrl: "https://new-panel.example.com",
        panelApiBasePath: "/new"
      }),
    /local save failed/,
    "panel migration must not remove old remote clients before local node save succeeds"
  );
  assert.deepEqual(calls, []);
}

async function testUpdateNodeDisablingPanelForcesOfflineStatus() {
  const currentNode = makeAdminNodeRow();
  const service = createAdminNodeService({
    runtimeSessionService: {
      revokeNodeLeases: async () => 0,
      markPanelBindingsDisabledForNode: async () => 0
    },
    clientEventsPublisher: {
      publishNodeAccessUpdatedForNode: async () => undefined
    },
    prisma: {
      node: {
        findUnique: async () => currentNode,
        update: async (payload: { data: Record<string, unknown> }) => ({
          ...currentNode,
          ...payload.data,
          updatedAt: new Date()
        })
      }
    }
  });

  const record = await service.updateNode("node_1", { panelEnabled: false });

  assert.equal(record.panelEnabled, false);
  assert.equal(record.panelStatus, "offline");
  assert.equal(record.panelError, null);
}

async function testClientNodesRequirePanelEnabled() {
  const capturedWhere: Array<Record<string, any>> = [];
  const now = new Date();
  const service = createClientAccessService({
    authSessionService: {
      authenticateAccessToken: async () => ({ id: "user_1" })
    },
    resolveSubscriptionAccessForUser: async () => ({
      subscription: {
        id: "sub_1",
        planId: "plan_1",
        totalTrafficGb: 100,
        usedTrafficGb: 0,
        remainingTrafficGb: 100,
        expireAt: new Date(Date.now() + 86_400_000),
        state: "active",
        renewable: true,
        lastSyncedAt: now,
        plan: { name: "plan", maxConcurrentSessions: 2 },
        user: { id: "user_1", status: "active" },
        team: null
      },
      team: null,
      memberRole: null,
      memberUsedTrafficGb: null
    }),
    prisma: {
      subscriptionNodeAccess: {
        findMany: async (payload: Record<string, any>) => {
          capturedWhere.push(payload.where);
          return [
            {
              nodeId: "node_enabled",
              node: {
                id: "node_enabled",
                name: "node",
                countryCode: "US",
                region: "Los Angeles",
                provider: "provider",
                tags: [],
                isActive: true,
                panelEnabled: true,
                recommended: true,
                latencyMs: 0,
                probeLatencyMs: null,
                protocol: "vless",
                security: "reality"
              }
            }
          ];
        }
      }
    }
  });

  const nodes = await service.getNodes("Bearer token");

  assert.equal(capturedWhere[0].node.panelEnabled, true, "client node list must filter out panel-disabled nodes");
  assert.equal(nodes.length, 1);
}

async function testConnectRejectsPanelDisabledNode() {
  const service = createRuntimeSessionService({
    prisma: {
      node: {
        findUnique: async () => ({
          id: "node_1",
          isActive: true,
          panelEnabled: false
        })
      }
    }
  });

  await assert.rejects(
    () => service.connect({ nodeId: "node_1", mode: "rule" }, "Bearer token"),
    /未启用面板接入/,
    "connect must reject panel-disabled nodes before creating leases"
  );
}

async function testRemovePanelBindingQueuesDeleteWithoutRemoteCall() {
  const upserts: Array<Record<string, any>> = [];
  const bindingUpdates: Array<Record<string, any>> = [];
  const deletedSnapshots: Array<Record<string, any>> = [];
  let xuiCalled = false;
  const service = createRuntimeSessionService({
    xuiService: {
      removeClient: async () => {
        xuiCalled = true;
        throw new Error("remote panel delete must not run inline");
      }
    },
    prisma: {
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          panelClientBinding: {
            findMany: async () => [
              {
                id: "binding_1",
                subscriptionId: "sub_1",
                userId: "user_1",
                teamId: null,
                nodeId: "node_1",
                panelClientEmail: "user@example.com",
                panelClientId: "panel_client_1",
                panelInboundId: 7,
                node: {
                  panelBaseUrl: "https://panel.example.com",
                  panelApiBasePath: "/",
                  panelUsername: "admin",
                  panelPassword: "password"
                }
              }
            ],
            updateMany: async (payload: Record<string, any>) => {
              bindingUpdates.push(payload);
              return { count: 1 };
            }
          },
          panelSyncJob: {
            upsert: async (payload: Record<string, any>) => {
              upserts.push(payload);
              return {};
            }
          },
          trafficSnapshot: {
            deleteMany: async (payload: Record<string, any>) => {
              deletedSnapshots.push(payload);
              return { count: 1 };
            }
          }
        })
    }
  });

  const result = await service.removePanelBindingsForSubscription("sub_1");

  assert.equal(result.updated, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(xuiCalled, false, "delete must queue panel sync instead of waiting for remote panel calls");
  assert.equal(upserts[0].create.action, "delete_client");
  assert.equal(upserts[0].create.panelInboundId, 7);
  assert.equal(bindingUpdates[0].data.status, "deleted", "local binding must be deleted before remote panel cleanup completes");
  assert.equal(deletedSnapshots.length, 1, "local traffic baseline must be cleared with the local delete");
}

async function testPanelDeleteJobUsesStoredSnapshotAndCompletes() {
  const removedConfigs: Array<Record<string, any>> = [];
  const bindingUpdates: Array<Record<string, any>> = [];
  const deletedSnapshots: Array<Record<string, any>> = [];
  const jobUpdates: Array<Record<string, any>> = [];
  const service = createRuntimeSessionService({
    xuiService: {
      removeClient: async (node: Record<string, any>) => {
        removedConfigs.push(node);
        return "deleted";
      }
    },
    prisma: {
      trafficSnapshot: {
        deleteMany: async (payload: Record<string, any>) => {
          deletedSnapshots.push(payload);
          return { count: 1 };
        }
      },
      panelClientBinding: {
        update: async (payload: Record<string, any>) => {
          bindingUpdates.push(payload);
          return {};
        }
      },
      panelSyncJob: {
        update: async (payload: Record<string, any>) => {
          jobUpdates.push(payload);
          return {};
        }
      },
      $transaction: async (operations: Array<Promise<unknown>>) => {
        await Promise.all(operations);
      }
    }
  });

  await service["runPanelSyncJob"]({
    id: "job_1",
    action: "delete_client",
    attempts: 0,
    bindingId: "binding_1",
    subscriptionId: "sub_1",
    userId: "user_1",
    teamId: null,
    nodeId: "node_1",
    panelClientEmail: "user@example.com",
    panelClientId: "panel_client_1",
    panelInboundId: 7,
    panelBaseUrl: "https://old-panel.example.com",
    panelApiBasePath: "/old",
    panelUsername: "old-user",
    panelPassword: "old-pass",
    node: {
      id: "node_1",
      isActive: true,
      panelEnabled: true,
      panelBaseUrl: "https://new-panel.example.com",
      panelApiBasePath: "/new",
      panelUsername: "new-user",
      panelPassword: "new-pass",
      panelInboundId: 9
    },
    binding: {
      status: "deleted"
    }
  });

  assert.equal(removedConfigs[0].panelBaseUrl, "https://old-panel.example.com");
  assert.equal(removedConfigs[0].panelApiBasePath, "/old");
  assert.equal(removedConfigs[0].panelUsername, "old-user");
  assert.equal(removedConfigs[0].panelInboundId, 7);
  assert.equal(bindingUpdates[0].data.status, "deleted");
  assert.equal(deletedSnapshots.length, 1);
  assert.equal(jobUpdates[0].data.status, "completed");
}

async function testRuntimePlanRequiresCompleteComponentSet() {
  const service = createRuntimeComponentsService({
    prisma: {
      runtimeComponent: {
        findMany: async (payload: { where: { kind?: string | { in: string[] } } }) => {
          if (payload.where.kind === "xray") {
            return [];
          }
          return [
            {
              id: "geoip_1",
              platform: "macos",
              architecture: "arm64",
              kind: "geoip",
              source: "github_remote",
              originUrl: "https://example.com/geoip.dat",
              defaultMirrorPrefix: null,
              allowClientMirror: true,
              fileName: "geoip.dat",
              fileSizeBytes: null,
              archiveEntryName: null,
              expectedHash: null
            }
          ];
        }
      }
    }
  });

  const plan = await service.getClientRuntimeComponentsPlan({
    platform: "windows",
    architecture: "x64"
  });

  assert.equal(plan.components.length, 0, "client plan must not expose a partial runtime component set");
}

async function testRuntimeComponentCreateRejectsUploadedSource() {
  const service = createRuntimeComponentsService({
    prisma: {
      runtimeComponent: {
        create: async () => {
          throw new Error("create should not be called");
        }
      }
    }
  });

  await assert.rejects(
    () => service.createAdminRuntimeComponent({
      platform: "windows",
      architecture: "x64",
      kind: "xray",
      source: "uploaded",
      originUrl: "https://example.com/xray.zip",
      fileName: "xray.zip"
    } as any),
    /upload endpoint/,
    "ordinary runtime component create must not create uploaded records"
  );
}

async function testRuntimeComponentCreateRequiresHttpUrl() {
  const service = createRuntimeComponentsService({
    prisma: {
      runtimeComponent: {
        create: async () => {
          throw new Error("create should not be called");
        }
      }
    }
  });

  await assert.rejects(
    () => service.createAdminRuntimeComponent({
      platform: "windows",
      architecture: "x64",
      kind: "xray",
      source: "custom_remote",
      originUrl: "ftp://example.com/xray.zip",
      fileName: "xray.zip"
    }),
    /HTTP\(S\)/,
    "remote runtime component create must enforce HTTP(S) URLs"
  );
}

async function testRuntimeFailureReportLimitRejectsInvalidValues() {
  const service = createRuntimeComponentsService({
    prisma: {
      runtimeComponentFailureReport: {
        findMany: async () => {
          throw new Error("query should not run for invalid limit");
        }
      }
    }
  });

  await assert.rejects(() => service.listRuntimeComponentFailureReports(Number.NaN), /limit/);
  await assert.rejects(() => service.listRuntimeComponentFailureReports(1000), /limit/);
}

async function testRuntimeComponentFailureRejectsUnknownComponentId() {
  let createCalled = false;
  const service = createRuntimeComponentsService({
    authSessionService: {
      authenticateAccessToken: async () => ({ id: "user_1" })
    },
    prisma: {
      runtimeComponent: {
        findUnique: async () => null
      },
      runtimeComponentFailureReport: {
        create: async () => {
          createCalled = true;
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.reportRuntimeComponentFailure(
        {
          componentId: "missing_component",
          platform: "windows",
          architecture: "x64",
          kind: "xray",
          reason: "download_failed"
        },
        "Bearer token"
      ),
    /does not exist/,
    "unknown runtime component ids should be rejected before Prisma foreign key enforcement"
  );
  assert.equal(createCalled, false);
}

async function testRemoteRuntimeValidationRejectsPrivateNetworkUrl() {
  const service = createRuntimeComponentsService({
    prisma: {
      runtimeComponent: {
        findUnique: async () => ({
          id: "component_1",
          platform: "windows",
          architecture: "x64",
          kind: "xray",
          source: "custom_remote",
          originUrl: "http://127.0.0.1:9/xray.exe",
          defaultMirrorPrefix: null,
          allowClientMirror: false,
          fileName: "xray.exe",
          archiveEntryName: null,
          storedFilePath: null,
          fileSizeBytes: null,
          fileHash: null,
          expectedHash: "a".repeat(64),
          enabled: true
        })
      }
    }
  });

  const result = await service.validateAdminRuntimeComponent("component_1");

  assert.equal(result.status, "unreachable");
  assert.match(result.message, /private or reserved/);
}

async function testRemoteRuntimeValidationRejectsMissingExpectedHash() {
  const service = createRuntimeComponentsService({
    prisma: {
      runtimeComponent: {
        findUnique: async () => ({
          id: "component_1",
          platform: "windows",
          architecture: "x64",
          kind: "xray",
          source: "custom_remote",
          originUrl: "https://example.com/xray.exe",
          defaultMirrorPrefix: null,
          allowClientMirror: false,
          fileName: "xray.exe",
          archiveEntryName: null,
          storedFilePath: null,
          fileSizeBytes: null,
          fileHash: null,
          expectedHash: null,
          enabled: true
        })
      }
    }
  });

  const result = await service.validateAdminRuntimeComponent("component_1");

  assert.equal(result.status, "metadata_mismatch");
  assert.match(result.message, /expectedHash/);
}

async function testRuntimeComponentUploadRejectsExpectedHashMismatch() {
  const service = createRuntimeComponentsService({
    prepareUploadedRuntimeComponentFile: async () => ({
      absolutePath: "missing-prepared-runtime.bin",
      storedFilePath: "component/file.bin",
      fileName: "xray.zip",
      fileSizeBytes: 1n,
      fileHash: "a".repeat(64),
      downloadUrl: "/api/downloads/runtime-components/component_1"
    }),
    prisma: {
      runtimeComponent: {
        create: async () => {
          throw new Error("create should not be called");
        }
      }
    }
  });

  await assert.rejects(
    () => service.uploadAdminRuntimeComponent(
      {
        platform: "windows",
        architecture: "x64",
        kind: "xray",
        expectedHash: "b".repeat(64)
      },
      {
        path: "missing-upload-runtime.bin",
        originalname: "xray.zip",
        size: 1
      }
    ),
    /expectedHash/,
    "runtime upload must reject files whose actual hash differs from expectedHash"
  );
}

async function testRuntimeComponentUploadKeepsSavedFileWhenSharedCleanupFails() {
  const tempDir = await mkdtemp(path.join(tmpdir(), "runtime-cleanup-"));
  const preparedPath = path.join(tempDir, "geoip.dat");
  const sourcePath = path.join(tempDir, "upload.tmp");
  await writeFile(preparedPath, "geoip");
  await writeFile(sourcePath, "source");
  try {
    const fileHash = createHash("sha256").update("geoip").digest("hex");
    const service = createRuntimeComponentsService({
      logger: {
        warn: () => undefined
      },
      findSharedRulesetRecord: async () => null,
      prepareUploadedRuntimeComponentFile: async () => ({
        absolutePath: preparedPath,
        storedFilePath: "geoip/geoip.dat",
        fileName: "geoip.dat",
        fileSizeBytes: 5n,
        fileHash,
        downloadUrl: "/api/downloads/runtime-components/component_1"
      }),
      cleanupSharedRulesetDuplicates: async () => {
        throw new Error("duplicate cleanup failed");
      },
      prisma: {
        runtimeComponent: {
          create: async (payload: Record<string, any>) => ({
            id: payload.data.id,
            platform: payload.data.platform,
            architecture: payload.data.architecture,
            kind: payload.data.kind,
            source: payload.data.source,
            originUrl: payload.data.originUrl,
            defaultMirrorPrefix: payload.data.defaultMirrorPrefix,
            allowClientMirror: payload.data.allowClientMirror,
            fileName: payload.data.fileName,
            storedFilePath: payload.data.storedFilePath,
            fileSizeBytes: payload.data.fileSizeBytes,
            fileHash: payload.data.fileHash,
            archiveEntryName: payload.data.archiveEntryName,
            expectedHash: payload.data.expectedHash,
            enabled: payload.data.enabled,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z")
          })
        }
      }
    });

    const result = await service.uploadAdminRuntimeComponent(
      {
        platform: "macos",
        architecture: "arm64",
        kind: "geoip",
        source: "uploaded",
        expectedHash: fileHash
      },
      {
        path: sourcePath,
        originalname: "geoip.dat",
        size: 5
      }
    );

    assert.equal(result.kind, "geoip");
    assert.equal(existsSync(preparedPath), true, "saved runtime file must not be removed after DB create succeeds");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testRemoteSharedRulesetCreateKeepsSaveWhenCleanupFails() {
  const expectedHash = "a".repeat(64);
  let cleanupCalls = 0;
  const service = createRuntimeComponentsService({
    logger: {
      warn: () => undefined
    },
    findSharedRulesetRecord: async () => ({
      id: "component_existing"
    }),
    cleanupSharedRulesetDuplicates: async () => {
      cleanupCalls += 1;
      throw new Error("duplicate cleanup failed");
    },
    prisma: {
      runtimeComponent: {
        update: async (payload: Record<string, any>) => ({
          id: payload.where.id,
          platform: payload.data.platform,
          architecture: payload.data.architecture,
          kind: payload.data.kind,
          source: payload.data.source,
          originUrl: payload.data.originUrl,
          defaultMirrorPrefix: payload.data.defaultMirrorPrefix,
          allowClientMirror: payload.data.allowClientMirror,
          fileName: payload.data.fileName,
          storedFilePath: payload.data.storedFilePath,
          fileSizeBytes: payload.data.fileSizeBytes,
          fileHash: payload.data.fileHash,
          archiveEntryName: payload.data.archiveEntryName,
          expectedHash: payload.data.expectedHash,
          enabled: payload.data.enabled,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z")
        })
      }
    }
  });

  const result = await service.createAdminRuntimeComponent({
    platform: "windows",
    architecture: "x64",
    kind: "geosite",
    source: "custom_remote",
    originUrl: "https://example.com/geosite.dat",
    fileName: "geosite.dat",
    expectedHash
  });

  assert.equal(result.id, "component_existing");
  assert.equal(result.kind, "geosite");
  assert.equal(result.expectedHash, expectedHash);
  assert.equal(cleanupCalls, 1, "shared ruleset cleanup should still be attempted");
}

async function testRemoteRuntimeValidationChecksExpectedHashWithGet() {
  const body = Buffer.from("runtime-binary");
  const expectedHash = createHash("sha256").update("different-binary").digest("hex");
  const methods: string[] = [];
  const server = createServer((request, response) => {
    methods.push(request.method ?? "");
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const service = createRuntimeComponentsService({
      prisma: {
        runtimeComponent: {
          findUnique: async () => ({
            id: "component_1",
            platform: "windows",
            architecture: "x64",
            kind: "xray",
            source: "custom_remote",
            originUrl: `http://127.0.0.1:${address.port}/xray.exe`,
            defaultMirrorPrefix: null,
            allowClientMirror: false,
            fileName: "xray.exe",
            archiveEntryName: null,
            storedFilePath: null,
            fileSizeBytes: null,
            fileHash: null,
            expectedHash,
            enabled: true
          })
        }
      }
    });

    const result = await withPrivateRemoteUrlsAllowed(() => service.validateAdminRuntimeComponent("component_1"));

    assert.equal(result.status, "metadata_mismatch");
    assert.deepEqual(methods, ["GET"], "remote expectedHash validation must download bytes instead of only checking HEAD");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function testRemoteRuntimeValidationPersistsDownloadMetadata() {
  const body = Buffer.from("runtime-binary");
  const expectedHash = createHash("sha256").update(body).digest("hex");
  const updates: Array<Record<string, any>> = [];
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const service = createRuntimeComponentsService({
      prisma: {
        runtimeComponent: {
          findUnique: async () => ({
            id: "component_1",
            platform: "windows",
            architecture: "x64",
            kind: "xray",
            source: "custom_remote",
            originUrl: `http://127.0.0.1:${address.port}/xray.exe`,
            defaultMirrorPrefix: null,
            allowClientMirror: false,
            fileName: "xray.exe",
            archiveEntryName: null,
            storedFilePath: null,
            fileSizeBytes: null,
            fileHash: null,
            expectedHash,
            enabled: true
          }),
          update: async (payload: Record<string, any>) => {
            updates.push(payload);
            return payload;
          }
        }
      }
    });

    const result = await withPrivateRemoteUrlsAllowed(() => service.validateAdminRuntimeComponent("component_1"));

    assert.equal(result.status, "ready");
    assert.equal(updates.length, 1, "successful remote validation must persist metadata required by desktop downloads");
    assert.equal(updates[0].data.fileSizeBytes, BigInt(body.byteLength));
    assert.equal(updates[0].data.fileHash, expectedHash);
    assert.equal(updates[0].data.expectedHash, expectedHash);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function testRemoteRuntimeZipEntryValidationUsesExtractedEntryHash() {
  const entry = Buffer.from("runtime-entry-binary");
  const zip = createStoredZipWithSingleEntry("xray.exe", entry);
  const entryHash = createHash("sha256").update(entry).digest("hex");
  const zipHash = createHash("sha256").update(zip).digest("hex");
  const updates: Array<Record<string, any>> = [];
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/zip",
      "content-length": String(zip.byteLength)
    });
    response.end(zip);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const service = createRuntimeComponentsService({
      prisma: {
        runtimeComponent: {
          findUnique: async () => ({
            id: "component_1",
            platform: "windows",
            architecture: "x64",
            kind: "xray",
            source: "custom_remote",
            originUrl: `http://127.0.0.1:${address.port}/xray.zip`,
            defaultMirrorPrefix: null,
            allowClientMirror: false,
            fileName: "xray.exe",
            archiveEntryName: "xray.exe",
            storedFilePath: null,
            fileSizeBytes: null,
            fileHash: null,
            expectedHash: entryHash,
            enabled: true
          }),
          update: async (payload: Record<string, any>) => {
            updates.push(payload);
            return payload;
          }
        }
      }
    });

    const result = await withPrivateRemoteUrlsAllowed(() => service.validateAdminRuntimeComponent("component_1"));

    assert.equal(result.status, "ready");
    assert.notEqual(zipHash, entryHash, "test must prove archive hash differs from extracted entry hash");
    assert.equal(updates[0].data.fileSizeBytes, BigInt(zip.byteLength));
    assert.equal(updates[0].data.fileHash, entryHash);
    assert.equal(updates[0].data.expectedHash, entryHash);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function testRemoteRuntimeValidationRejectsOversizeExpectedHashResponse() {
  const previousMaxBytes = process.env.CHORDV_RUNTIME_REMOTE_HASH_MAX_BYTES;
  process.env.CHORDV_RUNTIME_REMOTE_HASH_MAX_BYTES = "10";
  const updates: Array<Record<string, any>> = [];
  const body = Buffer.from("runtime-binary-is-too-large");
  const expectedHash = createHash("sha256").update(body).digest("hex");
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(body.byteLength)
    });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const service = createRuntimeComponentsService({
      prisma: {
        runtimeComponent: {
          findUnique: async () => ({
            id: "component_1",
            platform: "windows",
            architecture: "x64",
            kind: "xray",
            source: "custom_remote",
            originUrl: `http://127.0.0.1:${address.port}/xray.exe`,
            defaultMirrorPrefix: null,
            allowClientMirror: false,
            fileName: "xray.exe",
            archiveEntryName: null,
            storedFilePath: null,
            fileSizeBytes: null,
            fileHash: null,
            expectedHash,
            enabled: true
          }),
          update: async (payload: Record<string, any>) => {
            updates.push(payload);
            return payload;
          }
        }
      }
    });

    const result = await withPrivateRemoteUrlsAllowed(() => service.validateAdminRuntimeComponent("component_1"));

    assert.equal(result.status, "metadata_mismatch");
    assert.equal(updates.length, 0, "oversize remote validation must not persist metadata");
  } finally {
    if (previousMaxBytes === undefined) {
      delete process.env.CHORDV_RUNTIME_REMOTE_HASH_MAX_BYTES;
    } else {
      process.env.CHORDV_RUNTIME_REMOTE_HASH_MAX_BYTES = previousMaxBytes;
    }
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function testRemoteRuntimeValidationRejectsIdleTimeoutExpectedHashResponse() {
  const previousIdleTimeout = process.env.CHORDV_RUNTIME_REMOTE_HASH_IDLE_TIMEOUT_MS;
  const previousTotalTimeout = process.env.CHORDV_RUNTIME_REMOTE_HASH_TOTAL_TIMEOUT_MS;
  process.env.CHORDV_RUNTIME_REMOTE_HASH_IDLE_TIMEOUT_MS = "25";
  process.env.CHORDV_RUNTIME_REMOTE_HASH_TOTAL_TIMEOUT_MS = "1000";
  const sockets = new Set<{ destroy: () => void }>();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.write("partial");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const service = createRuntimeComponentsService({
      prisma: {
        runtimeComponent: {
          findUnique: async () => ({
            id: "component_1",
            platform: "windows",
            architecture: "x64",
            kind: "xray",
            source: "custom_remote",
            originUrl: `http://127.0.0.1:${address.port}/xray.exe`,
            defaultMirrorPrefix: null,
            allowClientMirror: false,
            fileName: "xray.exe",
            archiveEntryName: null,
            storedFilePath: null,
            fileSizeBytes: null,
            fileHash: null,
            expectedHash: "a".repeat(64),
            enabled: true
          })
        }
      }
    });

    const result = await withPrivateRemoteUrlsAllowed(() => service.validateAdminRuntimeComponent("component_1"));

    assert.equal(result.status, "unreachable");
    assert.match(result.message, /idle/);
  } finally {
    if (previousIdleTimeout === undefined) {
      delete process.env.CHORDV_RUNTIME_REMOTE_HASH_IDLE_TIMEOUT_MS;
    } else {
      process.env.CHORDV_RUNTIME_REMOTE_HASH_IDLE_TIMEOUT_MS = previousIdleTimeout;
    }
    if (previousTotalTimeout === undefined) {
      delete process.env.CHORDV_RUNTIME_REMOTE_HASH_TOTAL_TIMEOUT_MS;
    } else {
      process.env.CHORDV_RUNTIME_REMOTE_HASH_TOTAL_TIMEOUT_MS = previousTotalTimeout;
    }
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function testRemoteRuntimeValidationRejectsTotalTimeoutExpectedHashResponse() {
  const previousIdleTimeout = process.env.CHORDV_RUNTIME_REMOTE_HASH_IDLE_TIMEOUT_MS;
  const previousTotalTimeout = process.env.CHORDV_RUNTIME_REMOTE_HASH_TOTAL_TIMEOUT_MS;
  process.env.CHORDV_RUNTIME_REMOTE_HASH_IDLE_TIMEOUT_MS = "1000";
  process.env.CHORDV_RUNTIME_REMOTE_HASH_TOTAL_TIMEOUT_MS = "30";
  const sockets = new Set<{ destroy: () => void }>();
  let interval: ReturnType<typeof setInterval> | null = null;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    interval = setInterval(() => response.write("x"), 5);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const service = createRuntimeComponentsService({
      prisma: {
        runtimeComponent: {
          findUnique: async () => ({
            id: "component_1",
            platform: "windows",
            architecture: "x64",
            kind: "xray",
            source: "custom_remote",
            originUrl: `http://127.0.0.1:${address.port}/xray.exe`,
            defaultMirrorPrefix: null,
            allowClientMirror: false,
            fileName: "xray.exe",
            archiveEntryName: null,
            storedFilePath: null,
            fileSizeBytes: null,
            fileHash: null,
            expectedHash: "a".repeat(64),
            enabled: true
          })
        }
      }
    });

    const result = await withPrivateRemoteUrlsAllowed(() => service.validateAdminRuntimeComponent("component_1"));

    assert.equal(result.status, "unreachable");
    assert.match(result.message, /total/);
  } finally {
    if (interval) {
      clearInterval(interval);
    }
    if (previousIdleTimeout === undefined) {
      delete process.env.CHORDV_RUNTIME_REMOTE_HASH_IDLE_TIMEOUT_MS;
    } else {
      process.env.CHORDV_RUNTIME_REMOTE_HASH_IDLE_TIMEOUT_MS = previousIdleTimeout;
    }
    if (previousTotalTimeout === undefined) {
      delete process.env.CHORDV_RUNTIME_REMOTE_HASH_TOTAL_TIMEOUT_MS;
    } else {
      process.env.CHORDV_RUNTIME_REMOTE_HASH_TOTAL_TIMEOUT_MS = previousTotalTimeout;
    }
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function testRuntimePlanSkipsRemoteRowsMissingDownloadMetadata() {
  const makeRemoteComponent = (id: string, kind: "xray" | "geoip" | "geosite") => ({
    id,
    platform: kind === "xray" ? "windows" : "macos",
    architecture: kind === "xray" ? "x64" : "arm64",
    kind,
    source: "custom_remote",
    originUrl: `https://example.com/${kind}.dat`,
    defaultMirrorPrefix: null,
    allowClientMirror: true,
    fileName: `${kind}.dat`,
    storedFilePath: null,
    fileSizeBytes: null,
    fileHash: null,
    archiveEntryName: null,
    expectedHash: "a".repeat(64)
  });
  const service = createRuntimeComponentsService({
    prisma: {
      runtimeComponent: {
        findMany: async (payload: { where: { kind?: string | { in: string[] } } }) => {
          if (payload.where.kind === "xray") {
            return [makeRemoteComponent("xray_1", "xray")];
          }
          return [makeRemoteComponent("geoip_1", "geoip"), makeRemoteComponent("geosite_1", "geosite")];
        }
      }
    }
  });

  const plan = await service.getClientRuntimeComponentsPlan({
    platform: "windows",
    architecture: "x64"
  });

  assert.equal(plan.components.length, 0, "client plan must not expose remote runtime components without size metadata");
}

async function testRuntimePlanSkipsUploadedRowsMissingFiles() {
  const service = createRuntimeComponentsService({
    prisma: {
      runtimeComponent: {
        findMany: async (payload: { where: { kind?: string | { in: string[] } } }) => {
          if (payload.where.kind === "xray") {
            return [
              {
                id: "xray_1",
                platform: "windows",
                architecture: "x64",
                kind: "xray",
                source: "uploaded",
                originUrl: "/api/downloads/runtime-components/xray_1",
                defaultMirrorPrefix: null,
                allowClientMirror: false,
                fileName: "xray.zip",
                storedFilePath: null,
                fileSizeBytes: null,
                fileHash: null,
                archiveEntryName: null,
                expectedHash: null
              }
            ];
          }
          return [
            {
              id: "geoip_1",
              platform: "macos",
              architecture: "arm64",
              kind: "geoip",
              source: "github_remote",
              originUrl: "https://example.com/geoip.dat",
              defaultMirrorPrefix: null,
              allowClientMirror: true,
              fileName: "geoip.dat",
              storedFilePath: null,
              fileSizeBytes: null,
              fileHash: null,
              archiveEntryName: null,
              expectedHash: null
            },
            {
              id: "geosite_1",
              platform: "macos",
              architecture: "arm64",
              kind: "geosite",
              source: "github_remote",
              originUrl: "https://example.com/geosite.dat",
              defaultMirrorPrefix: null,
              allowClientMirror: true,
              fileName: "geosite.dat",
              storedFilePath: null,
              fileSizeBytes: null,
              fileHash: null,
              archiveEntryName: null,
              expectedHash: null
            }
          ];
        }
      }
    }
  });

  const plan = await service.getClientRuntimeComponentsPlan({
    platform: "windows",
    architecture: "x64"
  });

  assert.equal(plan.components.length, 0, "client plan must not expose uploaded runtime components without stored files");
}

async function testRuntimePlanSkipsUploadedRowsWithStaleMetadata() {
  const previousReleaseStorageRoot = process.env.CHORDV_RELEASE_STORAGE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), "chordv-runtime-plan-"));
  process.env.CHORDV_RELEASE_STORAGE_ROOT = tempDir;
  const files = {
    xray: Buffer.from("xray-tampered"),
    geoip: Buffer.from("geoip-ok"),
    geosite: Buffer.from("geosite-ok")
  };
  const storedPaths = {
    xray: path.join("xray_1", "xray.exe"),
    geoip: path.join("geoip_1", "geoip.dat"),
    geosite: path.join("geosite_1", "geosite.dat")
  };
  for (const [kind, data] of Object.entries(files)) {
    const storedFilePath = storedPaths[kind as keyof typeof storedPaths];
    const absolutePath = path.resolve(tempDir, "runtime-components", storedFilePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, data);
  }
  const makeUploadedComponent = (kind: "xray" | "geoip" | "geosite") => {
    const data = files[kind];
    const hash = createHash("sha256").update(data).digest("hex");
    return {
      id: `${kind}_1`,
      platform: kind === "xray" ? "windows" : "macos",
      architecture: kind === "xray" ? "x64" : "arm64",
      kind,
      source: "uploaded",
      originUrl: `/api/downloads/runtime-components/${kind}_1`,
      defaultMirrorPrefix: null,
      allowClientMirror: false,
      fileName: kind === "xray" ? "xray.exe" : `${kind}.dat`,
      storedFilePath: storedPaths[kind],
      fileSizeBytes: kind === "xray" ? 1n : BigInt(data.byteLength),
      fileHash: kind === "xray" ? "a".repeat(64) : hash,
      archiveEntryName: null,
      expectedHash: kind === "xray" ? "a".repeat(64) : hash
    };
  };
  try {
    const service = createRuntimeComponentsService({
      prisma: {
        runtimeComponent: {
          findMany: async (payload: { where: { kind?: string | { in: string[] } } }) => {
            if (payload.where.kind === "xray") {
              return [makeUploadedComponent("xray")];
            }
            return [makeUploadedComponent("geoip"), makeUploadedComponent("geosite")];
          }
        }
      }
    });

    const plan = await service.getClientRuntimeComponentsPlan({
      platform: "windows",
      architecture: "x64"
    });

    assert.equal(plan.components.length, 0, "client plan must not expose uploaded runtime components with stale metadata");
  } finally {
    if (previousReleaseStorageRoot === undefined) {
      delete process.env.CHORDV_RELEASE_STORAGE_ROOT;
    } else {
      process.env.CHORDV_RELEASE_STORAGE_ROOT = previousReleaseStorageRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testRuntimeComponentPatchCannotSwitchToUploadedSource() {
  const service = createRuntimeComponentsService({
    ensureRuntimeComponentExists: async () => ({
      id: "component_1",
      platform: "windows",
      architecture: "x64",
      kind: "xray",
      source: "github_remote",
      originUrl: "https://example.com/xray.zip",
      defaultMirrorPrefix: null,
      allowClientMirror: true,
      fileName: "xray.zip",
      storedFilePath: null,
      fileSizeBytes: null,
      fileHash: null,
      archiveEntryName: null,
      expectedHash: null,
      enabled: true
    })
  });

  await assert.rejects(
    () => service.updateAdminRuntimeComponent("component_1", { source: "uploaded" }),
    /upload endpoint/,
    "ordinary PATCH must not create semantic uploaded records without a stored file"
  );
}

async function testRuntimeComponentPatchInvalidatesRemoteMetadata() {
  const current = {
    id: "component_1",
    platform: "windows" as const,
    architecture: "x64" as const,
    kind: "xray" as const,
    source: "custom_remote" as const,
    originUrl: "https://example.com/old-xray.zip",
    defaultMirrorPrefix: null,
    allowClientMirror: true,
    fileName: "xray.zip",
    storedFilePath: null,
    fileSizeBytes: 1024n,
    fileHash: "a".repeat(64),
    archiveEntryName: null,
    expectedHash: "a".repeat(64),
    enabled: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z")
  };
  const updates: Array<Record<string, any>> = [];
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
    }
  });

  await service.updateAdminRuntimeComponent("component_1", {
    originUrl: "https://example.com/new-xray.zip"
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.storedFilePath, null);
  assert.equal(updates[0].data.fileSizeBytes, null);
  assert.equal(updates[0].data.fileHash, null);
}

async function testRuntimeComponentPatchDeletesOldUploadWhenSwitchingToRemote() {
  const previousReleaseStorageRoot = process.env.CHORDV_RELEASE_STORAGE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), "chordv-runtime-patch-"));
  const storedFilePath = path.join("component_1", "xray.exe");
  process.env.CHORDV_RELEASE_STORAGE_ROOT = tempDir;
  const absolutePath = path.resolve(tempDir, "runtime-components", storedFilePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, "old-upload");
  const current = {
    id: "component_1",
    platform: "windows" as const,
    architecture: "x64" as const,
    kind: "xray" as const,
    source: "uploaded" as const,
    originUrl: "/api/downloads/runtime-components/component_1",
    defaultMirrorPrefix: null,
    allowClientMirror: false,
    fileName: "xray.exe",
    storedFilePath,
    fileSizeBytes: 10n,
    fileHash: "a".repeat(64),
    archiveEntryName: null,
    expectedHash: "a".repeat(64),
    enabled: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z")
  };
  try {
    const service = createRuntimeComponentsService({
      ensureRuntimeComponentExists: async () => current,
      prisma: {
        runtimeComponent: {
          update: async (payload: Record<string, any>) => ({
            ...current,
            ...payload.data,
            updatedAt: new Date("2026-01-01T00:01:00.000Z")
          })
        }
      }
    });

    await service.updateAdminRuntimeComponent("component_1", {
      source: "custom_remote",
      originUrl: "https://example.com/xray.exe",
      expectedHash: "b".repeat(64)
    });

    assert.equal(existsSync(absolutePath), false, "old uploaded runtime file must be removed after switching to remote");
  } finally {
    if (previousReleaseStorageRoot === undefined) {
      delete process.env.CHORDV_RELEASE_STORAGE_ROOT;
    } else {
      process.env.CHORDV_RELEASE_STORAGE_ROOT = previousReleaseStorageRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testSubscriptionNodeAccessConcurrentReplaceIsSerialized() {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const access = new Set(["node_a"]);
  const makeNode = (id: string) => ({
    id,
    name: id,
    countryCode: "US",
    region: "US",
    provider: "test",
    tags: [],
    isActive: true,
    recommended: false,
    latencyMs: 10,
    probeLatencyMs: null,
    protocol: "vless",
    security: "reality"
  });
  try {
    const service = createDevDataService({
      requireSubscription: async () => ({
        id: "subscription_1",
        userId: "user_1",
        teamId: null
      }),
      prisma: {
        subscriptionNodeAccess: {
          findMany: async (payload: Record<string, any>) => {
            if (payload.select) {
              await new Promise((resolve) => setTimeout(resolve, 10));
              return [...access].map((nodeId) => ({ id: `access_${nodeId}`, nodeId }));
            }
            return [...access].map((nodeId) => ({
              id: `access_${nodeId}`,
              nodeId,
              node: makeNode(nodeId)
            }));
          },
          deleteMany: (payload: Record<string, any>) => {
            const nodeIds = payload.where.nodeId?.in as string[] | undefined;
            if (nodeIds) {
              for (const nodeId of nodeIds) {
                access.delete(nodeId);
              }
            } else {
              access.clear();
            }
            return Promise.resolve({ count: nodeIds?.length ?? 0 });
          },
          createMany: (payload: Record<string, any>) => {
            for (const row of payload.data as Array<{ nodeId: string }>) {
              access.add(row.nodeId);
            }
            return Promise.resolve({ count: payload.data.length });
          }
        },
        node: {
          findMany: async (payload: Record<string, any>) => payload.where.id.in.map((nodeId: string) => makeNode(nodeId))
        },
        $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
          task({
            subscriptionNodeAccess: {
              deleteMany: (payload: Record<string, any>) => {
                const nodeIds = payload.where.nodeId?.in as string[] | undefined;
                if (nodeIds) {
                  for (const nodeId of nodeIds) {
                    access.delete(nodeId);
                  }
                } else {
                  access.clear();
                }
                return Promise.resolve({ count: nodeIds?.length ?? 0 });
              },
              createMany: (payload: Record<string, any>) => {
                for (const row of payload.data as Array<{ nodeId: string }>) {
                  access.add(row.nodeId);
                }
                return Promise.resolve({ count: payload.data.length });
              }
            }
          })
      },
      runtimeSessionService: {
        syncSubscriptionPanelAccess: async () => undefined,
        queuePanelDisableJobsForSubscriptionTx: async () => 0,
        queueLeaseRevocationJobsForSubscriptionTx: async () => undefined,
        revokeSubscriptionLeases: async () => 0
      },
      clientEventsPublisher: {
        publishNodeAccessUpdated: async () => undefined
      }
    });

    const [first, second] = await Promise.all([
      service.updateSubscriptionNodeAccess("subscription_1", { nodeIds: ["node_b"] }),
      service.updateSubscriptionNodeAccess("subscription_1", { nodeIds: ["node_c"] })
    ]);

    const finalNodeIds = [...access].sort();
    assert.equal(first.nodeIds.length, 1);
    assert.equal(second.nodeIds.length, 1);
    assert.deepEqual(finalNodeIds, ["node_c"], "concurrent node access PUT requests must resolve as serialized replacements");
  } finally {
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  }
}

async function testRuntimeComponentPatchInvalidatesMetadataWhenExpectedHashChanges() {
  const current = {
    id: "component_1",
    platform: "windows" as const,
    architecture: "x64" as const,
    kind: "xray" as const,
    source: "custom_remote" as const,
    originUrl: "https://example.com/xray.zip",
    defaultMirrorPrefix: null,
    allowClientMirror: true,
    fileName: "xray.zip",
    storedFilePath: null,
    fileSizeBytes: 1024n,
    fileHash: "a".repeat(64),
    archiveEntryName: null,
    expectedHash: "a".repeat(64),
    enabled: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z")
  };
  const updates: Array<Record<string, any>> = [];
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
    }
  });

  await service.updateAdminRuntimeComponent("component_1", {
    expectedHash: "b".repeat(64)
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.expectedHash, "b".repeat(64));
  assert.equal(updates[0].data.storedFilePath, null);
  assert.equal(updates[0].data.fileSizeBytes, null);
  assert.equal(updates[0].data.fileHash, null);
}

async function testReleaseArtifactPatchCannotRewriteUploadedUrl() {
  const service = createReleaseCenterService({
    ensureReleaseExists: async () => ({
      id: "release_1",
      platform: "windows",
      status: "draft",
      version: "1.1.3",
      minimumVersion: "1.1.0"
    }),
    assertReleaseArtifactsMutable: () => undefined,
    prisma: {
      releaseArtifact: {
        findFirst: async () => ({
          id: "artifact_1",
          releaseId: "release_1",
          source: "uploaded",
          type: "zip",
          deliveryMode: "desktop_full_replace",
          downloadUrl: "/api/downloads/releases/artifact_1",
          defaultMirrorPrefix: null,
          allowClientMirror: false,
          fileName: "ChordV_1.1.3_x64-full.zip",
          storedFilePath: "release_1/artifact_1/file.zip",
          fileSizeBytes: 1n,
          fileHash: "a".repeat(64),
          isPrimary: true,
          isFullPackage: true
        })
      },
      $transaction: async () => {
        throw new Error("transaction should not be called");
      }
    }
  });

  await assert.rejects(
    () => service.updateReleaseArtifact("release_1", "artifact_1", {
      downloadUrl: "https://example.com/other.zip"
    }),
    /upload endpoint/,
    "uploaded release artifact download URLs must remain upload-managed"
  );
}

async function testUpdateCheckSkipsUploadedArtifactMissingStoredFile() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const service = createReleaseCenterService({
    findLatestPublishedRelease: async () => ({
      id: "release_1",
      platform: "windows",
      channel: "stable",
      version: "1.1.3",
      displayTitle: "ChordV 1.1.3",
      changelog: ["Full replace"],
      minimumVersion: "1.1.0",
      forceUpgrade: false,
      status: "published",
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
      artifacts: [
        {
          id: "artifact_missing",
          releaseId: "release_1",
          source: "uploaded",
          type: "zip",
          deliveryMode: "desktop_full_replace",
          downloadUrl: "/api/downloads/releases/artifact_missing",
          defaultMirrorPrefix: null,
          allowClientMirror: false,
          fileName: "ChordV_1.1.3_x64-full.zip",
          storedFilePath: `missing-${Date.now()}/ChordV_1.1.3_x64-full.zip`,
          fileSizeBytes: 1024n,
          fileHash: "a".repeat(64),
          isPrimary: true,
          isFullPackage: true,
          createdAt: now,
          updatedAt: now
        }
      ]
    })
  });

  const result = await service.checkClientUpdate({
    currentVersion: "1.1.2",
    platform: "windows",
    channel: "stable",
    artifactType: "zip"
  });

  assert.equal(result.hasUpdate, false, "client update check must not announce an update whose uploaded file is missing");
  assert.equal(result.recommendedArtifact, null);
  assert.equal(result.downloadUrl, null);
}

async function testUpdateCheckSkipsUploadedArtifactWithStaleMetadata() {
  const previousReleaseStorageRoot = process.env.CHORDV_RELEASE_STORAGE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), "chordv-release-storage-"));
  const storedFilePath = path.join("release_1", "artifact_stale", "ChordV_1.1.3_x64-full.zip");
  process.env.CHORDV_RELEASE_STORAGE_ROOT = tempDir;
  const absolutePath = resolveReleaseArtifactAbsolutePath(storedFilePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, "actual-package-bytes");
  const now = new Date("2026-01-01T00:00:00.000Z");
  try {
    const service = createReleaseCenterService({
      findLatestPublishedRelease: async () => ({
        id: "release_1",
        platform: "windows",
        channel: "stable",
        version: "1.1.3",
        displayTitle: "ChordV 1.1.3",
        changelog: ["Full replace"],
        minimumVersion: "1.1.0",
        forceUpgrade: false,
        status: "published",
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
        artifacts: [
          {
            id: "artifact_stale",
            releaseId: "release_1",
            source: "uploaded",
            type: "zip",
            deliveryMode: "desktop_full_replace",
            downloadUrl: "/api/downloads/releases/artifact_stale",
            defaultMirrorPrefix: null,
            allowClientMirror: false,
            fileName: "ChordV_1.1.3_x64-full.zip",
            storedFilePath,
            fileSizeBytes: 1024n,
            fileHash: "a".repeat(64),
            isPrimary: true,
            isFullPackage: true,
            createdAt: now,
            updatedAt: now
          }
        ]
      })
    });

    const result = await service.checkClientUpdate({
      currentVersion: "1.1.2",
      platform: "windows",
      channel: "stable",
      artifactType: "zip"
    });

    assert.equal(result.hasUpdate, false, "client update check must not announce stale uploaded package metadata");
    assert.equal(result.recommendedArtifact, null);
    assert.equal(result.downloadUrl, null);
  } finally {
    if (previousReleaseStorageRoot === undefined) {
      delete process.env.CHORDV_RELEASE_STORAGE_ROOT;
    } else {
      process.env.CHORDV_RELEASE_STORAGE_ROOT = previousReleaseStorageRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testMoveUploadedFileCleansTargetWhenCrossDeviceUnlinkFails() {
  const calls: string[] = [];
  await assert.rejects(
    () =>
      moveUploadedFile("upload.tmp", "stored.bin", {
        rename: async () => {
          const error = new Error("cross-device rename") as Error & { code: string };
          error.code = "EXDEV";
          throw error;
        },
        copyFile: async (sourcePath: string, targetPath: string) => {
          calls.push(`copy:${sourcePath}:${targetPath}`);
        },
        unlink: async () => {
          calls.push("unlink");
          throw new Error("unlink failed");
        },
        rm: async (targetPath: string, options?: { force?: boolean }) => {
          calls.push(`rm:${targetPath}:${options?.force === true}`);
        }
      }),
    /unlink failed/,
    "EXDEV fallback must not leave the copied target when removing the upload temp file fails"
  );
  assert.deepEqual(calls, ["copy:upload.tmp:stored.bin", "unlink", "rm:stored.bin:true"]);
}

async function testWindowsUpdateCheckIgnoresInstallerArtifactRequest() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const service = createReleaseCenterService({
    findLatestPublishedRelease: async () => ({
      id: "release_1",
      platform: "windows",
      channel: "stable",
      version: "1.1.3",
      displayTitle: "ChordV 1.1.3",
      changelog: ["Full replace"],
      minimumVersion: "1.1.0",
      forceUpgrade: false,
      status: "published",
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
      artifacts: [
        {
          id: "artifact_setup",
          releaseId: "release_1",
          source: "external",
          type: "setup_exe",
          deliveryMode: "desktop_installer_download",
          downloadUrl: "https://example.com/ChordV-setup.exe",
          defaultMirrorPrefix: null,
          allowClientMirror: false,
          fileName: "ChordV-setup.exe",
          storedFilePath: null,
          fileSizeBytes: 1024n,
          fileHash: "b".repeat(64),
          isPrimary: true,
          isFullPackage: true,
          createdAt: now,
          updatedAt: now
        },
        {
          id: "artifact_zip",
          releaseId: "release_1",
          source: "external",
          type: "zip",
          deliveryMode: "desktop_full_replace",
          downloadUrl: "https://example.com/ChordV_1.1.3_x64-full.zip",
          defaultMirrorPrefix: null,
          allowClientMirror: false,
          fileName: "ChordV_1.1.3_x64-full.zip",
          storedFilePath: null,
          fileSizeBytes: 2048n,
          fileHash: "a".repeat(64),
          isPrimary: false,
          isFullPackage: true,
          createdAt: now,
          updatedAt: now
        }
      ]
    })
  });

  const result = await service.checkClientUpdate({
    currentVersion: "1.1.2",
    platform: "windows",
    channel: "stable",
    artifactType: "setup.exe"
  });

  assert.equal(result.hasUpdate, true);
  assert.equal(result.deliveryMode, "desktop_full_replace");
  assert.equal(result.recommendedArtifact?.type, "zip");
  assert.equal(result.fileName, "ChordV_1.1.3_x64-full.zip");
}

async function testCurrentSubscriptionPrefersEffectiveSubscription() {
  const futureExpired = {
    id: "sub_expired",
    state: "expired",
    expireAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    remainingTrafficGb: 100
  };
  const activeSooner = {
    id: "sub_active",
    state: "active",
    expireAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    remainingTrafficGb: 100
  };
  const service = createClientAccessService({
    prisma: {
      subscription: {
        findMany: async () => [futureExpired, activeSooner]
      }
    }
  });

  const result = await service["findCurrentPersonalSubscription"]("user_1");

  assert.equal(result?.id, "sub_active", "current subscription lookup must prefer effective active subscriptions");
}

async function testClientVersionDoesNotUseCrossPlatformReleaseWithoutPlatform() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const releaseQueries: Array<Record<string, any>> = [];
  const service = createClientAccessService({
    prisma: {
      policyProfile: {
        findUnique: async () => ({
          id: "default",
          currentVersion: "1.1.2",
          minimumVersion: "1.1.0",
          forceUpgrade: false,
          changelog: ["Policy version"],
          downloadUrl: "https://example.com/download"
        })
      },
      release: {
        findMany: async (payload: Record<string, any>) => {
          releaseQueries.push(payload);
          return [
            {
              id: "release_windows",
              platform: "windows",
              channel: "stable",
              version: "1.1.3",
              minimumVersion: "1.1.0",
              forceUpgrade: false,
              changelog: ["Windows"],
              publishedAt: now,
              createdAt: now,
              updatedAt: now,
              artifacts: [
                {
                  id: "artifact_zip",
                  releaseId: "release_windows",
                  source: "external",
                  type: "zip",
                  deliveryMode: "desktop_full_replace",
                  downloadUrl: "https://example.com/ChordV_1.1.3_x64-full.zip",
                  defaultMirrorPrefix: null,
                  allowClientMirror: false,
                  fileName: "ChordV_1.1.3_x64-full.zip",
                  fileSizeBytes: 2048n,
                  fileHash: "a".repeat(64),
                  isPrimary: true,
                  isFullPackage: true,
                  createdAt: now,
                  updatedAt: now
                }
              ]
            }
          ];
        }
      }
    }
  });

  const fallback = await service.getClientVersion();
  assert.equal(fallback.currentVersion, "1.1.2");
  assert.equal(releaseQueries.length, 0, "version without platform must not select the highest release across all platforms");

  const windows = await service.getClientVersion("windows");
  assert.equal(windows.currentVersion, "1.1.3");
  assert.equal(releaseQueries[0].where.platform, "windows");
}

async function testCreateTeamMemberRejectsOwnerRole() {
  const service = createAdminSubscriptionService({
    requireTeam: async () => ({ id: "team_1" }),
    assertUserCanJoinTeam: async () => {
      throw new Error("join validation should not be reached for owner role");
    }
  });

  await assert.rejects(
    () => service.createTeamMember("team_1", { userId: "user_1", role: "owner" }),
    /owner transfer/,
    "adding a team member must not silently create another owner"
  );
}

async function testUpdatePlanRejectsScopeChangeWhenUsed() {
  const service = createAdminSubscriptionService({
    ensurePlanExists: async () => ({
      id: "plan_1",
      name: "Personal",
      scope: "personal",
      totalTrafficGb: 100,
      renewable: true,
      maxConcurrentSessions: 3,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date()
    }),
    prisma: {
      subscription: {
        count: async () => 1
      },
      plan: {
        update: async () => {
          throw new Error("plan update should not be called");
        }
      }
    }
  });

  await assert.rejects(
    () => service.updatePlan("plan_1", { scope: "team" }),
    /scope cannot be changed/,
    "plan scope changes must be blocked when existing subscriptions use the plan"
  );
}

function testAdminPatchDtosRejectNullForNonNullableFields() {
  assertDtoRejectsFieldNull(UpdateUserDto, "displayName");
  assertDtoRejectsFieldNull(UpdateTeamDto, "name");
  assertDtoRejectsFieldNull(UpdateTeamDto, "status");
  assertDtoRejectsFieldNull(UpdateNodeDto, "name");
  assertDtoRejectsFieldNull(UpdateNodeDto, "subscriptionUrl");
  assertDtoRejectsFieldNull(UpdateNodeDto, "isActive");
  assertDtoRejectsFieldNull(UpdateNodeDto, "recommended");
  assertDtoRejectsFieldNull(UpdateNodeDto, "panelEnabled");
  assertDtoRejectsFieldNull(UpdateAnnouncementDto, "title");
  assertDtoRejectsFieldNull(UpdateReleaseDto, "displayTitle");
  assertDtoRejectsFieldNull(UpdateReleaseArtifactDto, "downloadUrl");
  assertDtoRejectsFieldNull(UpdateRuntimeComponentDto, "source");
  assertDtoRejectsFieldNull(UpdateRuntimeComponentDto, "fileName");
  assertDtoRejectsFieldNull(UpdatePolicyDto, "defaultMode");
  assertDtoRejectsFieldNull(UpdatePolicyDto, "blockAds");
  assertDtoRejectsFieldNull(UpdatePolicyDto, "chinaDirect");
  assertDtoRejectsFieldNull(UpdatePolicyDto, "aiServicesProxy");
}

async function testUpdateUserSecurityReconcilesActiveLeases() {
  const enforced: Array<{ userId: string; limit: number }> = [];
  const service = createAdminSubscriptionService({
    ensureUserExists: async () => ({ id: "user_1" }),
    requireAdminUserRecord: async (userId: string) => ({ id: userId }),
    runtimeSessionService: {
      enforceUserConcurrentLeaseLimit: async (userId: string, limit: number) => {
        enforced.push({ userId, limit });
      }
    },
    prisma: {
      user: {
        update: async () => ({
          id: "user_1",
          maxConcurrentSessionsOverride: 1
        })
      }
    }
  });

  await service.updateUserSecurity("user_1", { maxConcurrentSessionsOverride: 1 });

  assert.deepEqual(enforced, [{ userId: "user_1", limit: 1 }]);
}

async function testUpdateUserSecurityKeepsLocalSaveWhenLeaseEnforcementFails() {
  const updates: Array<Record<string, any>> = [];
  const service = createAdminSubscriptionService({
    logger: {
      warn: () => undefined
    },
    ensureUserExists: async () => ({ id: "user_1" }),
    requireAdminUserRecord: async (userId: string) => ({ id: userId }),
    runtimeSessionService: {
      enforceUserConcurrentLeaseLimit: async () => {
        throw new Error("lease enforcement failed");
      }
    },
    prisma: {
      user: {
        update: async (payload: Record<string, any>) => {
          updates.push(payload);
          return {
            id: "user_1",
            maxConcurrentSessionsOverride: 1
          };
        }
      }
    }
  });

  const result = await service.updateUserSecurity("user_1", { maxConcurrentSessionsOverride: 1 });

  assert.equal(updates.length, 1);
  assert.equal((result as { id: string }).id, "user_1");
}

async function testUpdateUserSecurityReturnsPendingWhenLeaseAndRefreshFail() {
  const updates: Array<Record<string, any>> = [];
  const service = createAdminSubscriptionService({
    logger: {
      warn: () => undefined
    },
    ensureUserExists: async () => ({ id: "user_1" }),
    requireAdminUserRecord: async () => {
      throw new Error("user refresh failed");
    },
    runtimeSessionService: {
      enforceUserConcurrentLeaseLimit: async () => {
        throw new Error("lease enforcement failed");
      }
    },
    prisma: {
      user: {
        update: async (payload: Record<string, any>) => {
          updates.push(payload);
          return {
            id: "user_1",
            email: "user@example.com",
            displayName: "User",
            role: "user",
            status: "active",
            lastSeenAt: new Date("2026-01-01T00:00:00.000Z"),
            maxConcurrentSessionsOverride: 1
          };
        }
      }
    }
  });

  const result = await service.updateUserSecurity("user_1", { maxConcurrentSessionsOverride: 1 });

  assert.equal(updates.length, 1, "local security update must survive lease and response refresh failures");
  assert.equal(result.id, "user_1");
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /lease enforcement failed/);
  assert.match(result.panelSyncMessage ?? "", /user refresh failed/);
}

async function testUpdatePlanSecurityReconcilesUsersWithoutOverrides() {
  const enforced: Array<{ userId: string; limit: number }> = [];
  const service = createAdminSubscriptionService({
    ensurePlanExists: async () => ({ id: "plan_1" }),
    runtimeSessionService: {
      enforceUserConcurrentLeaseLimit: async (userId: string, limit: number) => {
        enforced.push({ userId, limit });
      }
    },
    prisma: {
      plan: {
        update: async () => ({
          id: "plan_1",
          name: "Personal",
          scope: "personal",
          totalTrafficGb: 100,
          renewable: true,
          maxConcurrentSessions: 1,
          isActive: true,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z")
        })
      },
      subscription: {
        count: async () => 2,
        findMany: async () => [
          { userId: "user_1", team: null },
          { userId: null, team: { members: [{ userId: "user_2" }, { userId: "user_3" }] } }
        ]
      },
      user: {
        findMany: async () => [
          { id: "user_1", maxConcurrentSessionsOverride: null },
          { id: "user_2", maxConcurrentSessionsOverride: 5 },
          { id: "user_3", maxConcurrentSessionsOverride: null }
        ]
      }
    }
  });

  await service.updatePlanSecurity("plan_1", { maxConcurrentSessions: 1 });

  assert.deepEqual(enforced, [
    { userId: "user_1", limit: 1 },
    { userId: "user_3", limit: 1 }
  ]);
}

async function testUpdatePlanReconcilesConcurrencyWhenLimitChanges() {
  const enforced: Array<{ userId: string; limit: number }> = [];
  const service = createAdminSubscriptionService({
    ensurePlanExists: async () => ({
      id: "plan_1",
      name: "Personal",
      scope: "personal",
      totalTrafficGb: 100,
      renewable: true,
      maxConcurrentSessions: 3,
      isActive: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    }),
    runtimeSessionService: {
      enforceUserConcurrentLeaseLimit: async (userId: string, limit: number) => {
        enforced.push({ userId, limit });
      }
    },
    prisma: {
      plan: {
        update: async () => ({
          id: "plan_1",
          name: "Personal",
          scope: "personal",
          totalTrafficGb: 100,
          renewable: true,
          maxConcurrentSessions: 1,
          isActive: true,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z")
        })
      },
      subscription: {
        count: async () => 1,
        findMany: async () => [{ userId: "user_1", team: null }]
      },
      user: {
        findMany: async () => [{ id: "user_1", maxConcurrentSessionsOverride: null }]
      }
    }
  });

  await service.updatePlan("plan_1", { maxConcurrentSessions: 1 });

  assert.deepEqual(enforced, [{ userId: "user_1", limit: 1 }]);
}

async function testUpdateSubscriptionReturnsPendingWhenPanelDisableQueueFails() {
  const updates: Array<Record<string, any>> = [];
  const now = new Date("2026-01-01T00:00:00.000Z");
  const current = {
    id: "subscription_1",
    userId: "user_1",
    teamId: null,
    planId: "plan_1",
    totalTrafficGb: 100,
    usedTrafficGb: 1,
    remainingTrafficGb: 99,
    expireAt: new Date(Date.now() + 60_000),
    state: "active",
    renewable: true,
    sourceAction: "created",
    lastSyncedAt: now,
    plan: { name: "Personal" },
    user: { email: "user@example.com", displayName: "User" },
    team: null,
    nodeAccesses: []
  };
  const service = createAdminSubscriptionService({
    requireSubscription: async () => current,
    runtimeSessionService: {
      queuePanelDisableJobsForSubscriptionTx: async () => {
        throw new Error("panel queue failed");
      },
      queueLeaseRevocationJobsForSubscriptionTx: async () => undefined
    },
    prisma: {
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          panelClientBinding: {
            findMany: async () => [
              {
                id: "binding_1",
                subscriptionId: "subscription_1",
                userId: "user_1",
                teamId: null,
                nodeId: "node_1",
                panelClientEmail: "user@example.com",
                panelClientId: "panel_client_1",
                panelInboundId: 7
              }
            ]
          },
          panelSyncJob: {
            upsert: async () => {
              throw new Error("panel queue failed");
            }
          },
          subscription: {
            update: async (payload: Record<string, any>) => {
              updates.push(payload);
              return { ...current, ...payload.data };
            }
          }
        })
    }
  });

  const result = await service.updateSubscription("subscription_1", { state: "paused" });

  assert.equal(updates.length, 1, "local subscription state must save even when panel disable queueing fails");
  assert.equal(updates[0].data.state, "paused");
  assert.equal(result.state, "paused");
  assert.equal(result.panelSyncStatus, "pending");
}

async function testUpdateSubscriptionReturnsPendingWhenLeaseRevocationFailsAfterPanelQueue() {
  const calls: string[] = [];
  const now = new Date("2026-01-01T00:00:00.000Z");
  const current = {
    id: "subscription_1",
    userId: "user_1",
    teamId: null,
    planId: "plan_1",
    totalTrafficGb: 100,
    usedTrafficGb: 1,
    remainingTrafficGb: 99,
    expireAt: new Date(Date.now() + 60_000),
    state: "active",
    renewable: true,
    sourceAction: "created",
    lastSyncedAt: now,
    plan: { name: "Personal" },
    user: { email: "user@example.com", displayName: "User" },
    team: null,
    nodeAccesses: []
  };
  const service = createAdminSubscriptionService({
    requireSubscription: async () => current,
    runtimeSessionService: {
      markPanelBindingsDisabledForSubscription: async () => {
        calls.push("queue_panel_disabled");
        return 1;
      },
      queueLeaseRevocationJobsForSubscriptionTx: async () => {
        calls.push("queue_lease_revocation");
        return 1;
      },
      syncActiveLeasesForSubscription: async () => {
        calls.push("revoke_leases");
        throw new Error("lease revoke failed");
      },
      syncSubscriptionPanelAccess: async () => {
        calls.push("sync_panel");
      }
    },
    publishSubscriptionUpdatedEvent: async () => {
      calls.push("publish_subscription");
    },
    prisma: {
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          panelClientBinding: {
            findMany: async () => [
              {
                id: "binding_1",
                subscriptionId: "subscription_1",
                userId: "user_1",
                teamId: null,
                nodeId: "node_1",
                panelClientEmail: "user@example.com",
                panelClientId: "panel_client_1",
                panelInboundId: 7
              }
            ]
          },
          panelSyncJob: {
            upsert: async () => {
              calls.push("queue_panel_disabled");
            }
          },
          subscription: {
            update: async (payload: Record<string, any>) => {
              calls.push("update_subscription");
              return {
                ...current,
                ...payload.data,
                state: payload.data.state,
                updatedAt: new Date("2026-01-01T00:01:00.000Z")
              };
            }
          }
        })
    }
  });

  const result = await service.updateSubscription("subscription_1", { state: "paused" });

  assert.deepEqual(calls, [
    "update_subscription",
    "revoke_leases",
    "sync_panel",
    "publish_subscription"
  ]);
  assert.equal(result.state, "paused");
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /lease revoke failed/);
}

async function testChangeSubscriptionPlanReconcilesNewConcurrencyLimit() {
  const enforced: Array<{ userId: string; limit: number }> = [];
  const now = new Date("2026-01-01T00:00:00.000Z");
  const current = {
    id: "subscription_1",
    userId: "user_1",
    teamId: null,
    planId: "plan_old",
    totalTrafficGb: 100,
    usedTrafficGb: 1,
    remainingTrafficGb: 99,
    expireAt: new Date(Date.now() + 60_000),
    state: "active",
    renewable: true,
    sourceAction: "created",
    lastSyncedAt: now,
    plan: { name: "Old", maxConcurrentSessions: 3 },
    user: { email: "user@example.com", displayName: "User" },
    team: null,
    nodeAccesses: []
  };
  const nextPlan = {
    id: "plan_new",
    name: "New",
    scope: "personal",
    totalTrafficGb: 100,
    renewable: true,
    maxConcurrentSessions: 1,
    isActive: true
  };
  const service = createAdminSubscriptionService({
    requireSubscription: async () => current,
    ensurePlanExists: async () => nextPlan,
    runtimeSessionService: {
      enforceUserConcurrentLeaseLimit: async (userId: string, limit: number) => {
        enforced.push({ userId, limit });
      },
      syncActiveLeasesForSubscription: async () => undefined,
      syncSubscriptionPanelAccess: async () => undefined
    },
    publishSubscriptionUpdatedEvent: async () => undefined,
    prisma: {
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          subscription: {
            update: async (payload: Record<string, any>) => ({
              ...current,
              ...payload.data,
              planId: nextPlan.id,
              plan: nextPlan,
              updatedAt: new Date("2026-01-01T00:01:00.000Z")
            })
          }
        }),
      user: {
        findMany: async () => [{ id: "user_1", maxConcurrentSessionsOverride: null }]
      }
    }
  });

  await service.changeSubscriptionPlan("subscription_1", { planId: "plan_new" });

  assert.deepEqual(enforced, [{ userId: "user_1", limit: 1 }]);
}

async function testChangeSubscriptionPlanReturnsPendingWhenConcurrencyLookupFails() {
  const updates: Array<Record<string, any>> = [];
  const now = new Date("2026-01-01T00:00:00.000Z");
  const current = {
    id: "subscription_1",
    userId: "user_1",
    teamId: null,
    planId: "plan_old",
    totalTrafficGb: 100,
    usedTrafficGb: 1,
    remainingTrafficGb: 99,
    expireAt: new Date(Date.now() + 60_000),
    state: "active",
    renewable: true,
    sourceAction: "created",
    lastSyncedAt: now,
    plan: { name: "Old", maxConcurrentSessions: 3 },
    user: { email: "user@example.com", displayName: "User" },
    team: null,
    nodeAccesses: []
  };
  const nextPlan = {
    id: "plan_new",
    name: "New",
    scope: "personal",
    totalTrafficGb: 100,
    renewable: true,
    maxConcurrentSessions: 1,
    isActive: true
  };
  const service = createAdminSubscriptionService({
    requireSubscription: async () => current,
    ensurePlanExists: async () => nextPlan,
    runtimeSessionService: {
      syncActiveLeasesForSubscription: async () => undefined,
      queueSubscriptionPanelAccessSync: async () => 0,
      syncSubscriptionPanelAccess: async () => {
        throw new Error("usage-locking panel sync must not run");
      }
    },
    publishSubscriptionUpdatedEvent: async () => undefined,
    prisma: {
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          subscription: {
            update: async (payload: Record<string, any>) => {
              updates.push(payload);
              return {
                ...current,
                ...payload.data,
                planId: nextPlan.id,
                plan: nextPlan,
                updatedAt: new Date("2026-01-01T00:01:00.000Z")
              };
            }
          }
        }),
      user: {
        findMany: async () => {
          throw new Error("user lookup failed");
        }
      }
    }
  });

  const result = await service.changeSubscriptionPlan("subscription_1", { planId: "plan_new" });

  assert.equal(updates.length, 1, "local plan change must save before lease concurrency reconciliation");
  assert.equal(result.planId, "plan_new");
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /user lookup failed/);
}

async function testCreateSubscriptionReturnsPendingWhenPanelSyncFails() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const service = createAdminSubscriptionService({
    ensureUserExists: async () => ({
      id: "user_1",
      email: "user@example.com",
      displayName: "User",
      status: "active"
    }),
    getUserMembership: async () => null,
    findCurrentPersonalSubscription: async () => null,
    ensurePlanExists: async () => ({
      id: "plan_1",
      name: "Personal",
      scope: "personal",
      totalTrafficGb: 100,
      renewable: true,
      isActive: true
    }),
    closeTeamSupportTicketsForUserBestEffort: async () => undefined,
    runtimeSessionService: {
      syncSubscriptionPanelAccess: async () => {
        throw new Error("panel add failed");
      }
    },
    publishSubscriptionUpdatedEvent: async () => undefined,
    prisma: {
      subscription: {
        create: async () => ({
          id: "sub_1",
          userId: "user_1",
          teamId: null,
          planId: "plan_1",
          totalTrafficGb: 100,
          usedTrafficGb: 0,
          remainingTrafficGb: 100,
          expireAt: new Date(Date.now() + 60_000),
          state: "active",
          renewable: true,
          sourceAction: "created",
          lastSyncedAt: now,
          plan: { name: "Personal" },
          user: { email: "user@example.com", displayName: "User" },
          team: null,
          nodeAccesses: []
        })
      }
    }
  });

  const result = await service.createSubscription({
    userId: "user_1",
    planId: "plan_1",
    expireAt: new Date(Date.now() + 60_000).toISOString()
  });

  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /panel add failed/);
  assert.match(result.message ?? "", /订阅已创建/);
}

async function testCreateSubscriptionPanelSyncDoesNotWaitForHeldUsageLock() {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  let releaseOuterLock!: () => void;
  let queuedPanelSync = 0;
  let usageLockingSyncCalls = 0;
  const heldLock = runWithSubscriptionUsageLock(
    "sub_held_lock",
    async () =>
      new Promise<void>((resolve) => {
        releaseOuterLock = resolve;
      })
  );

  try {
    for (let attempt = 0; !releaseOuterLock && attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const now = new Date("2026-01-01T00:00:00.000Z");
    const service = createAdminSubscriptionService({
      ensureUserExists: async () => ({
        id: "user_1",
        email: "user@example.com",
        displayName: "User",
        status: "active"
      }),
      getUserMembership: async () => null,
      findCurrentPersonalSubscription: async () => null,
      ensurePlanExists: async () => ({
        id: "plan_1",
        name: "Personal",
        scope: "personal",
        totalTrafficGb: 100,
        renewable: true,
        isActive: true
      }),
      closeTeamSupportTicketsForUserBestEffort: async () => undefined,
      runtimeSessionService: {
        queueSubscriptionPanelAccessSync: async () => {
          queuedPanelSync += 1;
          return 1;
        },
        syncSubscriptionPanelAccess: async (subscriptionId: string) => {
          usageLockingSyncCalls += 1;
          return runWithSubscriptionUsageLock(subscriptionId, async () => 0);
        }
      },
      publishSubscriptionUpdatedEvent: async () => undefined,
      prisma: {
        subscription: {
          create: async () => ({
            id: "sub_held_lock",
            userId: "user_1",
            teamId: null,
            planId: "plan_1",
            totalTrafficGb: 100,
            usedTrafficGb: 0,
            remainingTrafficGb: 100,
            expireAt: new Date(Date.now() + 60_000),
            state: "active",
            renewable: true,
            sourceAction: "created",
            lastSyncedAt: now,
            plan: { name: "Personal" },
            user: { email: "user@example.com", displayName: "User" },
            team: null,
            nodeAccesses: []
          })
        }
      }
    });

    const result = await Promise.race([
      service.createSubscription({
        userId: "user_1",
        planId: "plan_1",
        expireAt: new Date(Date.now() + 60_000).toISOString()
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("createSubscription panel sync waited for usage lock")), 250);
      })
    ]);

    assert.equal(queuedPanelSync, 1);
    assert.equal(usageLockingSyncCalls, 0, "createSubscription must not use usage-locking panel sync after local save");
    assert.equal(result.panelSyncStatus, "pending");
  } finally {
    if (releaseOuterLock) {
      releaseOuterLock();
    }
    await heldLock;
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  }
}

async function testCreateSubscriptionKeepsLocalSaveWhenTicketCleanupFails() {
  let createdSubscription = false;
  let syncCalled = false;
  const now = new Date("2026-01-01T00:00:00.000Z");
  const service = createAdminSubscriptionService({
    logger: {
      warn: () => undefined
    },
    ensureUserExists: async () => ({
      id: "user_1",
      email: "user@example.com",
      displayName: "User",
      status: "active"
    }),
    getUserMembership: async () => null,
    findCurrentPersonalSubscription: async () => null,
    ensurePlanExists: async () => ({
      id: "plan_1",
      name: "Personal",
      scope: "personal",
      totalTrafficGb: 100,
      renewable: true,
      isActive: true
    }),
    closeSupportTicketsForUser: async () => {
      throw new Error("ticket cleanup failed");
    },
    runtimeSessionService: {
      syncSubscriptionPanelAccess: async () => {
        syncCalled = true;
        return 0;
      }
    },
    publishSubscriptionUpdatedEvent: async () => undefined,
    prisma: {
      subscription: {
        create: async () => {
          createdSubscription = true;
          return {
            id: "sub_1",
            userId: "user_1",
            teamId: null,
            planId: "plan_1",
            totalTrafficGb: 100,
            usedTrafficGb: 0,
            remainingTrafficGb: 100,
            expireAt: new Date(Date.now() + 60_000),
            state: "active",
            renewable: true,
            sourceAction: "created",
            lastSyncedAt: now,
            plan: { name: "Personal" },
            user: { email: "user@example.com", displayName: "User" },
            team: null,
            nodeAccesses: []
          };
        }
      }
    }
  });

  const result = await service.createSubscription({
    userId: "user_1",
    planId: "plan_1",
    expireAt: new Date(Date.now() + 60_000).toISOString()
  });

  assert.equal(createdSubscription, true);
  assert.equal(syncCalled, true, "panel sync should still run after best-effort ticket cleanup fails");
  assert.equal(result.id, "sub_1");
}

async function testCreateTeamSubscriptionReturnsPendingWhenPanelSyncFails() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const service = createAdminSubscriptionService({
    requireTeam: async () => ({
      id: "team_1",
      name: "Team",
      status: "active"
    }),
    findCurrentTeamSubscription: async () => null,
    ensurePlanExists: async () => ({
      id: "plan_team",
      name: "Team Plan",
      scope: "team",
      totalTrafficGb: 500,
      renewable: true,
      isActive: true
    }),
    runtimeSessionService: {
      syncSubscriptionPanelAccess: async () => {
        throw new Error("panel sync failed");
      }
    },
    publishSubscriptionUpdatedEvent: async () => undefined,
    prisma: {
      subscription: {
        create: async () => ({
          id: "sub_team",
          userId: null,
          teamId: "team_1",
          planId: "plan_team",
          totalTrafficGb: 500,
          usedTrafficGb: 0,
          remainingTrafficGb: 500,
          expireAt: new Date(Date.now() + 60_000),
          state: "active",
          renewable: true,
          sourceAction: "created",
          lastSyncedAt: now,
          plan: { name: "Team Plan" },
          user: null,
          team: { name: "Team" },
          nodeAccesses: []
        })
      }
    }
  });

  const result = await service.createTeamSubscription("team_1", {
    planId: "plan_team",
    expireAt: new Date(Date.now() + 60_000).toISOString()
  });

  assert.equal(result.id, "sub_team");
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /panel sync failed/);
}

async function testDisableUserReturnsPendingWhenPanelDisconnectFails() {
  const updates: Array<Record<string, any>> = [];
  const service = createAdminSubscriptionService({
    logger: {
      warn: () => undefined
    },
    ensureUserExists: async () => ({
      id: "user_1",
      email: "user@example.com",
      displayName: "User",
      role: "user",
      status: "active"
    }),
    findCurrentPersonalSubscription: async () => ({
      id: "sub_1"
    }),
    requireAdminUserRecord: async () => ({
      id: "user_1",
      email: "user@example.com",
      displayName: "User",
      role: "user",
      status: "disabled",
      lastSeenAt: new Date().toISOString(),
      accountType: "personal",
      teamId: null,
      teamName: null,
      subscriptionCount: 1,
      activeSubscriptionCount: 0,
      currentSubscription: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }),
    prisma: {
      user: {
        update: async (payload: Record<string, any>) => {
          updates.push(payload);
        }
      },
      teamMember: {
        findMany: async () => []
      },
      $transaction: async () => {
        throw new Error("lease job queue failed");
      }
    },
    runtimeSessionService: {
      markPanelBindingsDisabledForSubscription: async () => {
        throw new Error("panel queue failed");
      },
      revokeSubscriptionLeases: async () => {
        throw new Error("lease revoke failed");
      }
    },
    authSessionService: {
      revokeAllUserSessions: async () => undefined
    },
    clientRuntimeEventsService: {
      publishToUser: () => undefined
    }
  });

  const result = await service.updateUser("user_1", { status: "disabled" });

  assert.equal(updates.length, 1, "user status must save before panel disconnect side effects");
  assert.equal(updates[0].data.status, "disabled");
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /panel queue failed/);
  assert.match(result.panelSyncMessage ?? "", /lease job queue failed/);
  assert.match(result.panelSyncMessage ?? "", /lease revoke failed/);
}

async function testDisableTeamReturnsPendingWhenPanelDisconnectFails() {
  const teamUpdates: Array<Record<string, any>> = [];
  const service = createAdminSubscriptionService({
    logger: {
      warn: () => undefined
    },
    requireTeam: async () => ({
      id: "team_1",
      name: "Team",
      ownerUserId: "owner_1",
      status: "active"
    }),
    findCurrentTeamSubscription: async () => ({
      id: "sub_team",
      teamId: "team_1",
      state: "active"
    }),
    requireTeamRecord: async () => ({
      id: "team_1",
      name: "Team",
      ownerUserId: "owner_1",
      ownerName: "Owner",
      ownerEmail: "owner@example.com",
      status: "disabled",
      memberCount: 1,
      subscription: null,
      members: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }),
    prisma: {
      team: {
        update: async (payload: Record<string, any>) => {
          teamUpdates.push(payload);
        }
      },
      $transaction: async () => {
        throw new Error("lease job queue failed");
      }
    },
    runtimeSessionService: {
      markPanelBindingsDisabledForSubscription: async () => {
        throw new Error("panel queue failed");
      },
      revokeSubscriptionLeases: async () => {
        throw new Error("lease revoke failed");
      }
    },
    publishSubscriptionUpdatedEvent: async () => undefined
  });

  const result = await service.updateTeam("team_1", { status: "disabled" });

  assert.equal(teamUpdates.length, 1, "team status must save before panel disconnect side effects");
  assert.equal(teamUpdates[0].data.status, "disabled");
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /panel queue failed/);
  assert.match(result.panelSyncMessage ?? "", /lease job queue failed/);
  assert.match(result.panelSyncMessage ?? "", /lease revoke failed/);
}

async function testUpdateTeamReturnsPendingWhenRecordRefreshFails() {
  const teamUpdates: Array<Record<string, any>> = [];
  const service = createAdminSubscriptionService({
    logger: {
      warn: () => undefined
    },
    requireTeam: async () => ({
      id: "team_1",
      name: "Team",
      ownerUserId: "owner_1",
      status: "active"
    }),
    findCurrentTeamSubscription: async () => null,
    requireTeamRecord: async () => {
      throw new Error("team list refresh failed");
    },
    prisma: {
      team: {
        update: async (payload: Record<string, any>) => {
          teamUpdates.push(payload);
          return {};
        },
        findUnique: async () => createBasicTeamRow({ name: "Renamed Team" })
      }
    }
  });

  const result = await service.updateTeam("team_1", { name: "Renamed Team" });

  assert.equal(teamUpdates.length, 1, "local team update must save before response refresh");
  assert.equal(teamUpdates[0].data.name, "Renamed Team");
  assert.equal(result.name, "Renamed Team");
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /team list refresh failed/);
}

async function testCreateTeamCreatesTeamAndOwnerInSingleTransaction() {
  const transactionCalls: Array<unknown[]> = [];
  const teamCreates: Array<Record<string, any>> = [];
  const memberCreates: Array<Record<string, any>> = [];
  const service = createAdminSubscriptionService({
    ensureUserExists: async () => ({
      id: "user_1",
      status: "active"
    }),
    assertUserCanJoinTeam: async () => undefined,
    closePersonalSupportTicketsForUser: async () => 0,
    requireTeamRecord: async (teamId: string) => ({
      id: teamId,
      name: "Team",
      ownerUserId: "user_1",
      ownerEmail: "user@example.com",
      ownerDisplayName: "User",
      status: "active",
      memberCount: 1,
      members: [],
      currentSubscription: null
    }),
    prisma: {
      team: {
        create: async (payload: Record<string, any>) => {
          teamCreates.push(payload);
          return {};
        }
      },
      teamMember: {
        create: async (payload: Record<string, any>) => {
          memberCreates.push(payload);
          return {};
        }
      },
      $transaction: async (operations: unknown[]) => {
        transactionCalls.push(operations);
        await Promise.all(operations as Array<Promise<unknown>>);
      }
    }
  });

  await service.createTeam({
    name: "Team",
    ownerUserId: "user_1"
  });

  assert.equal(transactionCalls.length, 1, "team and owner member must be created in one transaction");
  assert.equal(transactionCalls[0].length, 2);
  assert.equal(teamCreates.length, 1);
  assert.equal(memberCreates.length, 1);
  assert.equal(memberCreates[0].data.role, "owner");
}

async function testCreateTeamReturnsPendingWhenRecordRefreshFails() {
  const teamCreates: Array<Record<string, any>> = [];
  const service = createAdminSubscriptionService({
    logger: {
      warn: () => undefined
    },
    ensureUserExists: async () => ({
      id: "owner_1",
      status: "active"
    }),
    assertUserCanJoinTeam: async () => undefined,
    closePersonalSupportTicketsForUserBestEffort: async () => undefined,
    requireTeamRecord: async () => {
      throw new Error("team list refresh failed");
    },
    prisma: {
      team: {
        create: async (payload: Record<string, any>) => {
          teamCreates.push(payload);
          return {};
        },
        findUnique: async () => createBasicTeamRow({ name: "Created Team" })
      },
      teamMember: {
        create: async () => ({})
      },
      $transaction: async (operations: unknown[]) => {
        await Promise.all(operations as Array<Promise<unknown>>);
      }
    }
  });

  const result = await service.createTeam({
    name: "Created Team",
    ownerUserId: "owner_1"
  });

  assert.equal(teamCreates.length, 1, "local team create must commit before response refresh");
  assert.equal(result.id, "team_1");
  assert.equal(result.name, "Created Team");
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /team list refresh failed/);
}

async function testCreateTeamMemberKeepsMemberWhenTicketCleanupFails() {
  const createdMemberIds: string[] = [];
  const service = createAdminSubscriptionService({
    logger: {
      warn: () => undefined
    },
    requireTeam: async () => ({ id: "team_1" }),
    assertUserCanJoinTeam: async () => undefined,
    closePersonalSupportTicketsForUser: async () => {
      throw new Error("ticket cleanup failed");
    },
    findCurrentTeamSubscription: async () => null,
    requireTeamRecord: async (teamId: string) => ({ id: teamId }),
    prisma: {
      teamMember: {
        create: async () => {
          createdMemberIds.push("member_1");
          return { id: "member_1" };
        }
      }
    }
  });

  const result = await service.createTeamMember("team_1", { userId: "user_1", role: "member" });

  assert.deepEqual(createdMemberIds, ["member_1"]);
  assert.equal((result as { id: string }).id, "team_1");
}

async function testCreateTeamMemberReturnsPendingWhenPanelSyncFails() {
  const service = createAdminSubscriptionService({
    requireTeam: async () => ({ id: "team_1" }),
    assertUserCanJoinTeam: async () => undefined,
    findCurrentTeamSubscription: async () => ({
      id: "sub_team",
      teamId: "team_1",
      state: "active"
    }),
    runtimeSessionService: {
      syncSubscriptionPanelAccess: async () => {
        throw new Error("panel sync failed");
      }
    },
    publishSubscriptionUpdatedEvent: async () => undefined,
    requireTeamRecord: async (teamId: string) => ({ id: teamId }),
    prisma: {
      teamMember: {
        create: async () => ({
          id: "member_1",
          teamId: "team_1",
          userId: "user_1",
          role: "member"
        })
      }
    }
  });

  const result = await service.createTeamMember("team_1", { userId: "user_1", role: "member" });

  assert.equal((result as { id: string }).id, "team_1");
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /panel sync failed/);
}

async function testCreateTeamMemberKeepsMemberWhenSubscriptionLookupFails() {
  const createdMembers: string[] = [];
  const service = createAdminSubscriptionService({
    requireTeam: async () => ({ id: "team_1" }),
    assertUserCanJoinTeam: async () => undefined,
    closePersonalSupportTicketsForUserBestEffort: async () => undefined,
    findCurrentTeamSubscription: async () => {
      throw new Error("team subscription lookup failed");
    },
    requireTeamRecord: async (teamId: string) => ({ id: teamId }),
    prisma: {
      teamMember: {
        create: async () => {
          createdMembers.push("member_1");
          return {
            id: "member_1",
            teamId: "team_1",
            userId: "user_1",
            role: "member"
          };
        }
      }
    }
  });

  const result = await service.createTeamMember("team_1", { userId: "user_1", role: "member" });

  assert.deepEqual(createdMembers, ["member_1"]);
  assert.equal((result as { id: string }).id, "team_1");
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /team subscription lookup failed/);
}

async function testUpdateTeamMemberReturnsPendingWhenRecordRefreshFails() {
  const memberUpdates: Array<Record<string, any>> = [];
  const service = createAdminSubscriptionService({
    logger: {
      warn: () => undefined
    },
    requireTeamMember: async () => ({
      id: "member_1",
      teamId: "team_1",
      userId: "user_1",
      role: "member"
    }),
    requireTeamRecord: async () => {
      throw new Error("team list refresh failed");
    },
    prisma: {
      teamMember: {
        update: async (payload: Record<string, any>) => {
          memberUpdates.push(payload);
          return {};
        }
      },
      team: {
        findUnique: async () =>
          createBasicTeamRow({
            members: [
              {
                id: "member_1",
                teamId: "team_1",
                userId: "user_1",
                role: "member",
                createdAt: new Date("2026-01-01T00:00:00.000Z"),
                user: {
                  email: "user@example.com",
                  displayName: "User"
                }
              }
            ]
          })
      }
    }
  });

  const result = await service.updateTeamMember("team_1", "member_1", { role: "member" });

  assert.equal(memberUpdates.length, 1, "local team member update must save before response refresh");
  assert.equal(result.id, "team_1");
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /team list refresh failed/);
}

async function testTeamMemberMutationRejectsMismatchedTeamRoute() {
  const service = createAdminSubscriptionService({
    requireTeamMember: async () => ({
      id: "member_1",
      teamId: "team_real",
      userId: "user_1",
      role: "member"
    })
  });

  await assert.rejects(
    () => service.updateTeamMember("team_route", "member_1", { role: "member" }),
    /requested team/,
    "team member mutations must validate the team id from the route"
  );
}

async function testTeamMemberMutationRejectsOwnerDemotion() {
  const service = createAdminSubscriptionService({
    requireTeamMember: async () => ({
      id: "member_owner",
      teamId: "team_1",
      userId: "user_owner",
      role: "owner"
    }),
    prisma: {
      teamMember: {
        update: async () => {
          throw new Error("owner demotion update should not be called");
        }
      }
    }
  });

  await assert.rejects(
    () => service.updateTeamMember("team_1", "member_owner", { role: "member" }),
    /owner transfer/,
    "team owner role must not be demoted without transferring ownership"
  );
}

async function testClientAuthGuardRejectsAdminTokens() {
  const guard = new ClientAuthGuard({
    authenticateAccessToken: async () => ({
      id: "admin_1",
      email: "admin@example.com",
      displayName: "Admin",
      role: "admin",
      status: "active",
      lastSeenAt: new Date().toISOString()
    })
  } as any);
  const request: { headers: { authorization: string }; authUser?: unknown } = {
    headers: { authorization: "Bearer admin-token" }
  };
  const context = {
    switchToHttp: () => ({
      getRequest: () => request
    })
  } as unknown as ExecutionContext;

  await assert.rejects(
    () => guard.canActivate(context),
    /normal user/,
    "admin access tokens must not be accepted by client-only endpoints"
  );
  assert.equal(request.authUser, undefined);
}

async function testClientAuthGuardAllowsUserTokens() {
  const profile = {
    id: "user_1",
    email: "user@example.com",
    displayName: "User",
    role: "user",
    status: "active",
    lastSeenAt: new Date().toISOString()
  };
  const guard = new ClientAuthGuard({
    authenticateAccessToken: async () => profile
  } as any);
  const request: { headers: { authorization: string }; authUser?: unknown } = {
    headers: { authorization: "Bearer user-token" }
  };
  const context = {
    switchToHttp: () => ({
      getRequest: () => request
    })
  } as unknown as ExecutionContext;

  assert.equal(await guard.canActivate(context), true);
  assert.equal(request.authUser, profile);
}

function testCorsAllowsProductionAndConfiguredOrigins() {
  const previousCorsOrigins = process.env.CHORDV_CORS_ORIGINS;
  const previousAdminBaseUrl = process.env.CHORDV_ADMIN_BASE_URL;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAllowLocalDevOrigins = process.env.CHORDV_ALLOW_LOCAL_DEV_ORIGINS;
  try {
    process.env.CHORDV_CORS_ORIGINS = "https://admin.example.com,https://panel.example.com/app";
    process.env.CHORDV_ADMIN_BASE_URL = "https://ops.example.com/admin";
    process.env.NODE_ENV = "production";
    delete process.env.CHORDV_ALLOW_LOCAL_DEV_ORIGINS;

    assert.equal(isAllowedCorsOrigin("https://v.baymaxgroup.com"), true);
    assert.equal(isAllowedCorsOrigin("https://admin.example.com"), true);
    assert.equal(isAllowedCorsOrigin("https://panel.example.com"), true);
    assert.equal(isAllowedCorsOrigin("https://ops.example.com"), true);
    assert.equal(isAllowedCorsOrigin("http://localhost:5173"), false);
    assert.equal(isAllowedCorsOrigin("http://tauri.localhost"), true);
    assert.equal(isAllowedCorsOrigin("https://tauri.localhost"), true);
    assert.equal(isAllowedCorsOrigin("tauri://localhost"), true);
    process.env.CHORDV_ALLOW_LOCAL_DEV_ORIGINS = "true";
    assert.equal(isAllowedCorsOrigin("http://localhost:5173"), true);
    assert.equal(isAllowedCorsOrigin("http://tauri.localhost"), true);
    assert.equal(isAllowedCorsOrigin("https://evil.example.com"), false);
  } finally {
    if (previousCorsOrigins === undefined) {
      delete process.env.CHORDV_CORS_ORIGINS;
    } else {
      process.env.CHORDV_CORS_ORIGINS = previousCorsOrigins;
    }
    if (previousAdminBaseUrl === undefined) {
      delete process.env.CHORDV_ADMIN_BASE_URL;
    } else {
      process.env.CHORDV_ADMIN_BASE_URL = previousAdminBaseUrl;
    }
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
    if (previousAllowLocalDevOrigins === undefined) {
      delete process.env.CHORDV_ALLOW_LOCAL_DEV_ORIGINS;
    } else {
      process.env.CHORDV_ALLOW_LOCAL_DEV_ORIGINS = previousAllowLocalDevOrigins;
    }
  }
}

async function testCreateAnnouncementRejectsBlankTrimmedText() {
  const service = createAnnouncementPolicyService({
    prisma: {
      announcement: {
        create: async () => {
          throw new Error("announcement create should not be called");
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.createAnnouncement({
        title: "   ",
        body: "Body",
        level: "info"
      }),
    /title/,
    "blank announcement titles must be rejected after trimming"
  );
}

async function testCreateAnnouncementRejectsFractionalCountdown() {
  const service = createAnnouncementPolicyService({
    prisma: {
      announcement: {
        create: async () => {
          throw new Error("announcement create should not be called");
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.createAnnouncement({
        title: "Title",
        body: "Body",
        level: "info",
        displayMode: "modal_countdown",
        countdownSeconds: 1.5
      }),
    /countdownSeconds/,
    "announcement countdown must be a database-safe integer"
  );
}

async function testUpdateAnnouncementDefaultsCountdownWhenSwitchingMode() {
  const updates: Array<Record<string, any>> = [];
  const now = new Date("2026-01-01T00:00:00.000Z");
  const service = createAnnouncementPolicyService({
    publishAnnouncementUpdatedEvent: async () => undefined,
    prisma: {
      announcement: {
        findUnique: async () => ({
          id: "announcement_1",
          title: "Title",
          body: "Body",
          level: "info",
          publishedAt: now,
          isActive: true,
          displayMode: "passive",
          countdownSeconds: 0,
          createdAt: now,
          updatedAt: now
        }),
        update: async (payload: Record<string, any>) => {
          updates.push(payload);
          return {
            id: "announcement_1",
            title: "Title",
            body: "Body",
            level: "info",
            publishedAt: now,
            isActive: true,
            displayMode: payload.data.displayMode,
            countdownSeconds: payload.data.countdownSeconds,
            createdAt: now,
            updatedAt: now
          };
        }
      }
    }
  });

  const result = await service.updateAnnouncement("announcement_1", { displayMode: "modal_countdown" });

  assert.equal(updates[0].data.countdownSeconds, 5);
  assert.equal(result.countdownSeconds, 5);
}

async function testCreateAnnouncementKeepsLocalSaveWhenPublishFails() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const service = createAnnouncementPolicyService({
    logger: {
      warn: () => undefined
    },
    prisma: {
      announcement: {
        create: async () => ({
          id: "announcement_1",
          title: "Title",
          body: "Body",
          level: "info",
          publishedAt: now,
          isActive: true,
          displayMode: "passive",
          countdownSeconds: 0,
          createdAt: now,
          updatedAt: now
        })
      },
      user: {
        findMany: async () => {
          throw new Error("active user lookup failed");
        }
      }
    }
  });

  const result = await service.createAnnouncement({
    title: "Title",
    body: "Body",
    level: "info"
  });

  assert.equal(result.id, "announcement_1");
}

async function testUpdatePolicyRejectsDuplicateModes() {
  const service = createAnnouncementPolicyService({
    prisma: {
      policyProfile: {
        findUnique: async () => ({
          id: "default",
          defaultMode: "rule",
          modes: ["global", "rule"],
          blockAds: true,
          chinaDirect: true,
          aiServicesProxy: true
        }),
        update: async () => {
          throw new Error("policy update should not be called");
        }
      }
    }
  });

  await assert.rejects(
    () => service.updatePolicy({ modes: ["rule", "rule"] }),
    /duplicates/,
    "policy modes must not contain duplicates"
  );
}

async function testUpdatePolicyAllowsUnrelatedChangeWithHistoricalDuplicateModes() {
  const updates: Array<Record<string, any>> = [];
  const service = createAnnouncementPolicyService({
    publishPolicyUpdatedEvent: async () => undefined,
    getAdminPolicy: async () => ({
      defaultMode: "rule",
      modes: ["rule"],
      features: {
        blockAds: false,
        chinaDirect: true,
        aiServicesProxy: true
      }
    }),
    prisma: {
      policyProfile: {
        findUnique: async () => ({
          id: "default",
          defaultMode: "rule",
          modes: ["rule", "rule"],
          blockAds: true,
          chinaDirect: true,
          aiServicesProxy: true
        }),
        update: async (payload: Record<string, any>) => {
          updates.push(payload);
        }
      }
    }
  });

  await service.updatePolicy({ blockAds: false });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.blockAds, false);
  assert.equal("modes" in updates[0].data, false, "unrelated policy edits must not fail or rewrite historical duplicate modes implicitly");
}

async function testUpdatePolicyKeepsLocalSaveWhenPublishFails() {
  const updates: Array<Record<string, any>> = [];
  const service = createAnnouncementPolicyService({
    logger: {
      warn: () => undefined
    },
    prisma: {
      policyProfile: {
        findUnique: async () => ({
          id: "default",
          defaultMode: "rule",
          modes: ["rule"],
          blockAds: false,
          chinaDirect: true,
          aiServicesProxy: true
        }),
        update: async (payload: Record<string, any>) => {
          updates.push(payload);
        }
      },
      user: {
        findMany: async () => {
          throw new Error("active user lookup failed");
        }
      }
    }
  });

  const result = await service.updatePolicy({ blockAds: false });

  assert.equal(updates.length, 1);
  assert.equal(result.features.blockAds, false);
}

async function testDeleteTeamMemberKeepsLocalDeleteWhenTicketCleanupFails() {
  const calls: string[] = [];
  const service = createAdminSubscriptionService({
    logger: {
      warn: () => undefined
    },
    requireTeamMember: async () => ({
      id: "member_1",
      teamId: "team_1",
      userId: "user_1",
      role: "member"
    }),
    findCurrentTeamSubscription: async () => ({
      id: "subscription_1",
      teamId: "team_1",
      state: "active"
    }),
    closeSupportTicketsForUser: async () => {
      calls.push("close_tickets");
      throw new Error("ticket cleanup failed");
    },
    runtimeSessionService: {
      revokeSubscriptionLeases: async () => {
        calls.push("revoke_leases");
      },
      markPanelBindingsDisabledForSubscription: async () => {
        calls.push("mark_panel_disabled");
      }
    },
    prisma: {
      teamMember: {
        delete: async () => {
          calls.push("delete_member");
        }
      }
    }
  });

  const result = await service.deleteTeamMember("team_1", "member_1");

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["close_tickets", "delete_member", "mark_panel_disabled", "revoke_leases"]);
}

async function testDeleteTeamMemberKeepsPanelDisableDurableWhenLeaseRevocationFails() {
  const calls: string[] = [];
  const service = createAdminSubscriptionService({
    requireTeamMember: async () => ({
      id: "member_1",
      teamId: "team_1",
      userId: "user_1",
      role: "member"
    }),
    findCurrentTeamSubscription: async () => ({
      id: "subscription_1",
      teamId: "team_1",
      state: "active"
    }),
    closeSupportTicketsForUser: async () => {
      calls.push("close_tickets");
    },
    runtimeSessionService: {
      markPanelBindingsDisabledForSubscription: async () => {
        calls.push("queue_panel_disabled");
        return 1;
      },
      queueLeaseRevocationJobsForSubscriptionTx: async () => {
        calls.push("queue_lease_revocation");
        return 1;
      },
      revokeSubscriptionLeases: async () => {
        calls.push("revoke_leases");
        throw new Error("lease revoke failed");
      }
    },
    publishSubscriptionUpdatedEvent: async () => {
      calls.push("publish_subscription");
    },
    clientRuntimeEventsService: {
      publishToUser: () => {
        calls.push("publish_user");
      }
    },
    prisma: {
      $transaction: async (task: (tx: Record<string, any>) => Promise<void>) =>
        task({}),
      teamMember: {
        delete: async () => {
          calls.push("delete_member");
        }
      }
    }
  });

  const result = await service.deleteTeamMember("team_1", "member_1");

  assert.deepEqual(calls, [
    "close_tickets",
    "delete_member",
    "queue_panel_disabled",
    "queue_lease_revocation",
    "revoke_leases",
    "publish_subscription",
    "publish_user",
    "publish_user"
  ]);
  assert.equal(result.panelSyncStatus, "pending");
  assert.match(result.panelSyncMessage ?? "", /lease revoke failed/);
}

async function testUploadedTempFileCleanupInterceptorDeletesTempFileOnError() {
  const tempDir = await mkdtemp(path.join(tmpdir(), "chordv-upload-"));
  const filePath = path.join(tempDir, "artifact.zip");
  await writeFile(filePath, "payload");

  try {
    const request = {
      file: {
        path: filePath,
        originalname: "artifact.zip",
        size: 7
      }
    };
    const context = {
      switchToHttp: () => ({
        getRequest: () => request
      })
    } as unknown as ExecutionContext;
    const interceptor = new UploadedTempFileCleanupInterceptor();

    await assert.rejects(
      () =>
        lastValueFrom(
          interceptor.intercept(context, {
            handle: () => throwError(() => new Error("validation failed"))
          })
        ),
      /validation failed/,
      "uploaded temp files must be removed when validation rejects before controller ownership"
    );
    assert.equal(existsSync(filePath), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testAdminReplySupportTicketWithAttachmentCreatesAttachment() {
  const writes: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const publishedEvents: Array<{ userId: string; event: Record<string, unknown> }> = [];
  const uploadedFile = {
    url: "https://image.achord.cn/file/support-tickets/screenshot.png",
    providerFileId: "support-tickets/screenshot.png",
    fileName: "screenshot.png",
    mimeType: "image/png",
    fileSizeBytes: BigInt(1234)
  };

  const service = createDevDataService({
    prisma: {
      supportTicket: {
        findUnique: async () => ({ id: "ticket_1", status: "waiting_admin", userId: "user_1" })
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<void>) =>
        task({
          supportTicketMessage: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
              writes.push({ kind: "message", data });
              return { id: data.id };
            }
          },
          supportTicketAttachment: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
              writes.push({ kind: "attachment", data });
              return data;
            }
          },
          supportTicket: {
            update: async ({ data }: { data: Record<string, unknown> }) => {
              writes.push({ kind: "ticket", data });
              return data;
            }
          }
        })
    },
    imageBedService: {
      uploadSupportTicketAttachment: async (file: { originalname: string; mimetype: string; size: number }) => {
        assert.equal(file.originalname, "screenshot.png");
        assert.equal(file.mimetype, "image/png");
        assert.equal(file.size, 1234);
        return uploadedFile;
      }
    },
    clientRuntimeEventsService: {
      publishToUser: (userId: string, event: Record<string, unknown>) => {
        publishedEvents.push({ userId, event });
      }
    },
    getAdminSupportTicketDetail: async (ticketId: string) => ({ id: ticketId })
  });

  const result = await service.replyAdminSupportTicketWithAttachment(
    "ticket_1",
    { body: " 请查看截图 " },
    {
      path: path.join(tmpdir(), "screenshot.png"),
      originalname: "screenshot.png",
      mimetype: "image/png",
      size: 1234
    },
    "admin_1"
  );

  assert.equal((result as { id: string }).id, "ticket_1");
  const message = writes.find((item) => item.kind === "message")?.data;
  const attachment = writes.find((item) => item.kind === "attachment")?.data;
  const ticketUpdate = writes.find((item) => item.kind === "ticket")?.data;
  assert.equal(message?.body, "请查看截图");
  assert.equal(message?.authorRole, "admin");
  assert.equal(message?.authorUserId, "admin_1");
  assert.equal(attachment?.provider, "image-bed");
  assert.equal(attachment?.url, uploadedFile.url);
  assert.equal(attachment?.fileName, uploadedFile.fileName);
  assert.equal(attachment?.fileSizeBytes, uploadedFile.fileSizeBytes);
  assert.equal(ticketUpdate?.status, "waiting_user");
  assert.deepEqual(publishedEvents, [
    {
      userId: "user_1",
      event: {
        type: "ticket_updated",
        occurredAt: publishedEvents[0]?.event.occurredAt,
        ticketId: "ticket_1",
        ticketStatus: "waiting_user"
      }
    }
  ]);
}

async function testAdminReplySupportTicketAttachmentCleansUploadWhenTransactionFails() {
  const deletedUploads: string[] = [];
  const uploadedFile = {
    url: "https://image.achord.cn/file/support-tickets/orphan.png",
    providerFileId: "support-tickets/orphan.png",
    fileName: "orphan.png",
    mimeType: "image/png",
    fileSizeBytes: BigInt(1234)
  };

  const service = createDevDataService({
    prisma: {
      supportTicket: {
        findUnique: async () => ({ id: "ticket_1", status: "waiting_admin", userId: "user_1" })
      },
      $transaction: async () => {
        throw new Error("db write failed");
      }
    },
    imageBedService: {
      uploadSupportTicketAttachment: async () => uploadedFile,
      deleteUploadedSupportTicketAttachmentBestEffort: async (uploaded: { providerFileId: string | null; url: string }) => {
        deletedUploads.push(uploaded.providerFileId ?? uploaded.url);
      }
    }
  });

  await assert.rejects(
    () =>
      service.replyAdminSupportTicketWithAttachment(
        "ticket_1",
        { body: "" },
        {
          path: path.join(tmpdir(), "orphan.png"),
          originalname: "orphan.png",
          mimetype: "image/png",
          size: 1234
        },
        "admin_1"
      ),
    /db write failed/
  );
  assert.deepEqual(deletedUploads, ["support-tickets/orphan.png"]);
}

async function testAdminReplySupportTicketKeepsSaveWhenPublishFails() {
  const writes: string[] = [];
  const service = createDevDataService({
    logger: {
      warn: () => undefined
    },
    prisma: {
      supportTicket: {
        findUnique: async () => ({ id: "ticket_1", status: "waiting_admin", userId: "user_1" }),
        update: async () => {
          writes.push("ticket");
          return {};
        }
      },
      $transaction: async (operations: Array<Promise<unknown>>) => {
        await Promise.all(operations);
      },
      supportTicketMessage: {
        create: async () => {
          writes.push("message");
          return {};
        }
      }
    },
    clientRuntimeEventsService: {
      publishToUser: () => {
        throw new Error("sse unavailable");
      }
    },
    getAdminSupportTicketDetail: async (ticketId: string) => ({ id: ticketId })
  });

  const result = await service.replyAdminSupportTicket("ticket_1", { body: "reply" }, "admin_1");

  assert.deepEqual(writes.sort(), ["message", "ticket"]);
  assert.equal((result as { id: string }).id, "ticket_1");
}

async function testAdminReplySupportTicketReturnsFallbackWhenDetailRefreshFails() {
  const warnings: string[] = [];
  const writes: string[] = [];
  const ticketRow = {
    id: "ticket_1",
    title: "Need help",
    status: "waiting_admin",
    source: "desktop",
    userId: "user_1",
    subscriptionId: null,
    teamId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    user: {
      id: "user_1",
      email: "user@example.com",
      displayName: "User"
    },
    team: null
  };
  const service = createDevDataService({
    logger: {
      warn: (message: string) => warnings.push(message)
    },
    prisma: {
      supportTicket: {
        findUnique: async () => ticketRow,
        update: async () => {
          writes.push("ticket");
          return {};
        }
      },
      $transaction: async (operations: Array<Promise<unknown>>) => {
        await Promise.all(operations);
      },
      supportTicketMessage: {
        create: async () => {
          writes.push("message");
          return {};
        }
      }
    },
    clientRuntimeEventsService: {
      publishToUser: () => undefined
    },
    getAdminSupportTicketDetail: async () => {
      throw new Error("detail refresh failed");
    }
  });

  const result = await service.replyAdminSupportTicket("ticket_1", { body: "reply saved" }, "admin_1");

  assert.deepEqual(writes.sort(), ["message", "ticket"]);
  assert.equal(result.id, "ticket_1");
  assert.equal(result.status, "waiting_user");
  assert.equal(result.messages[0]?.body, "reply saved");
  assert.equal(result.messages[0]?.authorRole, "admin");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /detail refresh failed/);
}

async function testAdminReplySupportTicketAttachmentReturnsFallbackWhenDetailRefreshFails() {
  const warnings: string[] = [];
  const writes: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const uploadedFile = {
    url: "https://image.achord.cn/file/support-tickets/fallback.png",
    providerFileId: "support-tickets/fallback.png",
    fileName: "fallback.png",
    mimeType: "image/png",
    fileSizeBytes: BigInt(4321)
  };
  const ticketRow = {
    id: "ticket_1",
    title: "Need attachment",
    status: "waiting_admin",
    source: "desktop",
    userId: "user_1",
    subscriptionId: "sub_1",
    teamId: "team_1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    user: {
      id: "user_1",
      email: "user@example.com",
      displayName: "User"
    },
    team: {
      id: "team_1",
      name: "Team"
    }
  };
  const service = createDevDataService({
    logger: {
      warn: (message: string) => warnings.push(message)
    },
    prisma: {
      supportTicket: {
        findUnique: async () => ticketRow
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<void>) =>
        task({
          supportTicketMessage: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
              writes.push({ kind: "message", data });
              return { id: data.id };
            }
          },
          supportTicketAttachment: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
              writes.push({ kind: "attachment", data });
              return data;
            }
          },
          supportTicket: {
            update: async ({ data }: { data: Record<string, unknown> }) => {
              writes.push({ kind: "ticket", data });
              return data;
            }
          }
        })
    },
    imageBedService: {
      uploadSupportTicketAttachment: async () => uploadedFile
    },
    clientRuntimeEventsService: {
      publishToUser: () => undefined
    },
    getAdminSupportTicketDetail: async () => {
      throw new Error("detail refresh failed");
    }
  });

  const result = await service.replyAdminSupportTicketWithAttachment(
    "ticket_1",
    { body: "" },
    {
      path: path.join(tmpdir(), "fallback.png"),
      originalname: "fallback.png",
      mimetype: "image/png",
      size: 4321
    },
    "admin_1"
  );

  assert.equal(writes.some((item) => item.kind === "message"), true);
  assert.equal(writes.some((item) => item.kind === "attachment"), true);
  assert.equal(result.id, "ticket_1");
  assert.equal(result.ownerType, "team");
  assert.equal(result.messages[0]?.attachments[0]?.url, uploadedFile.url);
  assert.equal(result.messages[0]?.attachments[0]?.fileSizeBytes, uploadedFile.fileSizeBytes.toString());
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /detail refresh failed/);
}

async function testClientReplySupportTicketKeepsSaveWhenPublishFails() {
  const writes: string[] = [];
  const service = createClientTicketService({
    logger: {
      warn: () => undefined
    },
    authSessionService: {
      authenticateAccessToken: async () => ({ id: "user_1" })
    },
    prisma: {
      supportTicket: {
        findFirst: async () => ({ id: "ticket_1", status: "waiting_user" }),
        update: async () => {
          writes.push("ticket");
          return {};
        }
      },
      supportTicketMessage: {
        create: async () => {
          writes.push("message");
          return {};
        }
      },
      supportTicketReadState: {
        upsert: async () => {
          writes.push("read_state");
          return {};
        }
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          supportTicket: {
            update: async () => {
              writes.push("ticket");
              return {};
            }
          },
          supportTicketMessage: {
            create: async () => {
              writes.push("message");
              return {};
            }
          },
          supportTicketReadState: {
            upsert: async () => {
              writes.push("read_state");
              return {};
            }
          }
        })
    },
    clientRuntimeEventsService: {
      publishToUser: () => {
        throw new Error("sse unavailable");
      }
    },
    getClientSupportTicketDetail: async (ticketId: string) => ({ id: ticketId })
  });

  const result = await service.replyClientSupportTicket("ticket_1", { body: "reply" }, "token");

  assert.deepEqual(writes.sort(), ["message", "read_state", "ticket"]);
  assert.equal((result as { id: string }).id, "ticket_1");
}

async function testClientReplySupportTicketAttachmentCleansUploadWhenTransactionFails() {
  const deletedUploads: string[] = [];
  const uploadedFile = {
    url: "https://image.achord.cn/file/support-tickets/client-orphan.png",
    providerFileId: "support-tickets/client-orphan.png",
    fileName: "client-orphan.png",
    mimeType: "image/png",
    fileSizeBytes: BigInt(1234)
  };

  const service = createClientTicketService({
    authSessionService: {
      authenticateAccessToken: async () => ({ id: "user_1" })
    },
    prisma: {
      supportTicket: {
        findFirst: async () => ({ id: "ticket_1", status: "waiting_user" })
      },
      $transaction: async () => {
        throw new Error("db write failed");
      }
    },
    imageBedService: {
      uploadSupportTicketAttachment: async () => uploadedFile,
      deleteUploadedSupportTicketAttachmentBestEffort: async (uploaded: { providerFileId: string | null; url: string }) => {
        deletedUploads.push(uploaded.providerFileId ?? uploaded.url);
      }
    }
  });

  await assert.rejects(
    () =>
      service.replyClientSupportTicketWithAttachment(
        "ticket_1",
        { body: "" },
        {
          path: path.join(tmpdir(), "client-orphan.png"),
          originalname: "client-orphan.png",
          mimetype: "image/png",
          size: 1234
        },
        "token"
      ),
    /db write failed/
  );
  assert.deepEqual(deletedUploads, ["support-tickets/client-orphan.png"]);
}

async function main() {
  await testSubscriptionUsageLockIsReentrantForNestedPanelSync();
  await testPanelSyncJobRemoteCallDoesNotWaitForSubscriptionUsageLock();
  await testUpdateNodeAccessAllowsNestedPanelAccessSyncLock();
  await testClientAuthGuardRejectsAdminTokens();
  await testClientAuthGuardAllowsUserTokens();
  testCorsAllowsProductionAndConfiguredOrigins();
  await testUpdateUserPasswordRevokesExistingSessions();
  await testUpdateUserRoleRevokesExistingSessions();
  await testUpdateUserKeepsLocalSaveWhenSessionRevocationFails();
  await testUpdateUserReturnsPendingWhenResponseRefreshFails();
  await testRefreshTokenLogoutRevokesOnlyCurrentRefreshToken();
  await testAccessTokenLogoutRevokesOnlyBoundSession();
  await testAccessTokenAuthenticationRequiresActiveBoundSession();
  testRuntimeEventStreamReplaysAfterLastEventId();
  await testRuntimeEventStreamValidatesBeforeDispatch();
  await testRuntimeEventStreamPreservesOrderWithAsyncValidation();
  testReleaseArtifactPathTraversalIsRejected();
  testUploadedReleaseArtifactDoesNotUseClientMirror();
  testReleaseArtifactClientUsableRequiresHashForInstallerDownloads();
  await testExternalReleaseMetadataRejectsPrivateNetworkUrl();
  await testReleaseDownloadRejectsDraftArtifacts();
  await testReleaseDownloadRejectsUploadedArtifactWithStaleMetadata();
  await testRuntimeDownloadRejectsDisabledComponents();
  await testRuntimeDownloadRejectsUploadedComponentWithStaleMetadata();
  await testUpdateReleaseDelegatesToReleaseCenter();
  await testAdminReleaseListAppliesFilters();
  await testPublishReleaseKeepsLocalSaveWhenVersionEventFails();
  await testCreateReleaseArtifactDelegatesToReleaseCenter();
  await testConvertToTeamDelegatesToAdminSubscriptionService();
  await testValidateReleaseArtifactDelegatesToReleaseCenter();
  await testHeartbeatWithinTtlSucceeds();
  await testHeartbeatWithinGraceStillSucceeds();
  await testHeartbeatBeyondGraceFailsWithLeaseExpired();
  await testGetActiveRuntimeRebuildsXuiLeaseFromDatabaseTruth();
  await testGetActiveRuntimeRevokesDisabledUserLease();
  await testHeartbeatUpdatesCachedRuntimeLeaseExpiry();
  await testRevokeLeaseClearsCachedRuntime();
  await testDisconnectDoesNotExposeOtherUsersCachedRuntime();
  await testSweepExpiredLeasesDoesNotRevokeTooEarly();
  await testPanelDisableJobDoesNotPreDisableBinding();
  await testLeaseRevocationKeepsLocalStateWhenRuntimeEventPublishFails();
  await testPanelDisableJobCallsXuiEvenWhenNodeInactive();
  await testPanelDisableJobRechecksEligibilityBeforeRemoteDisable();
  await testLeaseRevocationJobQueuePersistsRevocationTarget();
  await testLeaseRevocationJobRetriesFailedRevocation();
  await testClearPendingPanelDisableJobsOnlyClearsRestoredNodeAccess();
  await testExistingBindingMissingSnapshotUsesBindingCountersAsBaseline();
  await testUsageTriggeredInvalidationUsesUnifiedRevokePath();
  await testUsageTriggeredInvalidationPublishesWhenPanelAndLeaseEffectsFail();
  await testUsageDeltaKeepsLocalUsageWhenPublishFails();
  await testInitialUsageDeltaUsesBindingCountersForUuidMapping();
  await testRenewSubscriptionResetTrafficClearsPanelBaselines();
  await testRenewSubscriptionResetTrafficQueueFailureStillClearsLocalUsage();
  await testRenewSubscriptionReturnsPendingWhenLeaseAndPanelSyncFail();
  await testResetSubscriptionTrafficRejectsNonStringUserId();
  await testResetSubscriptionTrafficReturnsPendingWhenQueueAndUserRefreshFail();
  await testRenewSubscriptionPartialPanelResetPersistsSuccessfulBaselines();
  await testStaleUsageSampleAfterResetDoesNotReapplyOldTraffic();
  await testDeleteNodeStopsBeforeLocalDeleteWhenPanelCleanupFails();
  await testProbeAllNodesContinuesWhenSingleNodeProbeFails();
  await testRetryPanelSyncJobRequeuesWithoutRunningRemoteSync();
  await testXuiPanelLocationDoesNotDuplicateBasePath();
  await testXuiPanelLocationStripsApiPathSuffix();
  await testXuiPanelLocationAcceptsFullUrlAsApiBasePath();
  testAdminNodePanelApiPathAcceptsFullUrl();
  await testXuiBusinessNotFoundFallsBackToInboundDelete();
  testXuiSettingsClientStatsTakePrecedenceOverZeroClientFallback();
  await testXuiInboundRuntimeReadsMldsa65Verify();
  await testXuiInboundRuntimeReadsPqvAlias();
  await testXuiInboundRuntimeRejectsMissingRealityPublicKey();
  await testUpdateNodeAccessKeepsLocalSaveWhenPanelPresyncFails();
  await testUpdateNodeAccessKeepsLocalSaveWhenPublishFails();
  await testUpdateNodeAccessReportsPendingWhenPanelDisableQueueFails();
  await testClearNodeAccessReportsPendingWhenPanelDisableQueueFails();
  await testClearNodeAccessReturnsPendingWhenRevocationFollowUpStalls();
  await testClearNodeAccessDoesNotWaitForHeldUsageLock();
  await testRemoveSingleNodeAccessDoesNotWaitForHeldUsageLock();
  await testRemoveSingleNodeAccessReturnsPendingWhenRevocationFollowUpStalls();
  await testReplaceNodeAccessDoesNotWaitForHeldUsageLock();
  await testUpdateNodeAccessDoesNotFullSyncWhenOnlyRemovingNodes();
  await testUpdateNodeAccessReportsPendingWhenLeaseRevocationFailsAfterPanelQueue();
  await testUpdateNodeAccessKeepsLocalSaveWhenResponseRefreshFails();
  await testKickTeamMemberReportsPendingWhenPanelOrLeaseSyncFails();
  await testKickTeamMemberReturnsPendingWhenTeamRecordRefreshFails();
  await testKickTeamMemberReturnsRevokedCountAndDisableAccountPending();
  await testConvertPersonalSubscriptionToTeamReportsPendingWhenOldLeaseRevocationFails();
  await testConvertPersonalSubscriptionToTeamReturnsPendingWhenTeamRefreshFails();
  await testAdminListsSurfacePersistentPanelSyncPendingState();
  await testConvertPersonalSubscriptionToTeamKeepsLocalFailureWhenRollbackPanelSyncFails();
  await testDisableNodeQueuesPanelSyncWithoutBlockingLocalSave();
  await testDisableNodeKeepsLocalSaveWhenEffectsFail();
  await testPanelDisableJobUpsertResetsStaleFailureState();
  await testPanelDisableJobStoresAndUsesPanelSnapshot();
  await testPanelDisableJobCompletionDoesNotResolveUsageIncident();
  await testDeletedPanelBindingDoesNotReuseOldInboundId();
  await testDisablePanelBindingUsesStoredInboundId();
  await testUsageSyncUsesStoredInboundIdGroups();
  await testUsageSyncKeepsNodeDegradedWhenAnyInboundFails();
  await testUpdateNodeUsesExplicitClearedInboundIdForPanelRefresh();
  await testUpdateNodePanelMigrationPersistsNewConfigWhenOldCleanupFails();
  await testUpdateNodePanelMigrationKeepsLocalConfigWhenNewPanelReadFails();
  await testUpdateNodePanelMigrationDoesNotCleanupOldPanelWhenLocalSaveFails();
  await testUpdateNodeDisablingPanelForcesOfflineStatus();
  await testClientNodesRequirePanelEnabled();
  await testConnectRejectsPanelDisabledNode();
  await testRemovePanelBindingQueuesDeleteWithoutRemoteCall();
  await testPanelDeleteJobUsesStoredSnapshotAndCompletes();
  await testRuntimePlanRequiresCompleteComponentSet();
  await testRuntimeComponentCreateRejectsUploadedSource();
  await testRuntimeComponentCreateRequiresHttpUrl();
  await testRuntimeFailureReportLimitRejectsInvalidValues();
  await testRuntimeComponentFailureRejectsUnknownComponentId();
  await testRemoteRuntimeValidationRejectsPrivateNetworkUrl();
  await testRemoteRuntimeValidationRejectsMissingExpectedHash();
  await testRuntimeComponentUploadRejectsExpectedHashMismatch();
  await testRuntimeComponentUploadKeepsSavedFileWhenSharedCleanupFails();
  await testRemoteSharedRulesetCreateKeepsSaveWhenCleanupFails();
  await testRemoteRuntimeValidationChecksExpectedHashWithGet();
  await testRemoteRuntimeValidationPersistsDownloadMetadata();
  await testRemoteRuntimeZipEntryValidationUsesExtractedEntryHash();
  await testRemoteRuntimeValidationRejectsOversizeExpectedHashResponse();
  await testRemoteRuntimeValidationRejectsIdleTimeoutExpectedHashResponse();
  await testRemoteRuntimeValidationRejectsTotalTimeoutExpectedHashResponse();
  await testRuntimePlanSkipsRemoteRowsMissingDownloadMetadata();
  await testRuntimePlanSkipsUploadedRowsMissingFiles();
  await testRuntimePlanSkipsUploadedRowsWithStaleMetadata();
  await testRuntimeComponentPatchCannotSwitchToUploadedSource();
  await testRuntimeComponentPatchInvalidatesRemoteMetadata();
  await testRuntimeComponentPatchDeletesOldUploadWhenSwitchingToRemote();
  await testSubscriptionNodeAccessConcurrentReplaceIsSerialized();
  await testRuntimeComponentPatchInvalidatesMetadataWhenExpectedHashChanges();
  await testReleaseArtifactPatchCannotRewriteUploadedUrl();
  await testUpdateCheckSkipsUploadedArtifactMissingStoredFile();
  await testUpdateCheckSkipsUploadedArtifactWithStaleMetadata();
  await testMoveUploadedFileCleansTargetWhenCrossDeviceUnlinkFails();
  await testWindowsUpdateCheckIgnoresInstallerArtifactRequest();
  await testCurrentSubscriptionPrefersEffectiveSubscription();
  await testClientVersionDoesNotUseCrossPlatformReleaseWithoutPlatform();
  await testCreateTeamMemberRejectsOwnerRole();
  await testUpdatePlanRejectsScopeChangeWhenUsed();
  testAdminPatchDtosRejectNullForNonNullableFields();
  await testImageBedListRejectsSuccessFalsePayload();
  await testImageBedUploadRejectsSuccessFalsePayload();
  await testImageBedDeleteReturnsStructuredBusinessFailure();
  await testImageBedAttachmentCleanupLogsDeleteFailure();
  await testUpdateUserSecurityReconcilesActiveLeases();
  await testUpdateUserSecurityKeepsLocalSaveWhenLeaseEnforcementFails();
  await testUpdateUserSecurityReturnsPendingWhenLeaseAndRefreshFail();
  await testUpdatePlanSecurityReconcilesUsersWithoutOverrides();
  await testUpdatePlanReconcilesConcurrencyWhenLimitChanges();
  await testUpdateSubscriptionReturnsPendingWhenPanelDisableQueueFails();
  await testUpdateSubscriptionReturnsPendingWhenLeaseRevocationFailsAfterPanelQueue();
  await testChangeSubscriptionPlanReconcilesNewConcurrencyLimit();
  await testChangeSubscriptionPlanReturnsPendingWhenConcurrencyLookupFails();
  await testCreateSubscriptionReturnsPendingWhenPanelSyncFails();
  await testCreateSubscriptionPanelSyncDoesNotWaitForHeldUsageLock();
  await testCreateSubscriptionKeepsLocalSaveWhenTicketCleanupFails();
  await testCreateTeamSubscriptionReturnsPendingWhenPanelSyncFails();
  await testDisableUserReturnsPendingWhenPanelDisconnectFails();
  await testDisableTeamReturnsPendingWhenPanelDisconnectFails();
  await testUpdateTeamReturnsPendingWhenRecordRefreshFails();
  await testCreateTeamCreatesTeamAndOwnerInSingleTransaction();
  await testCreateTeamReturnsPendingWhenRecordRefreshFails();
  await testCreateTeamMemberKeepsMemberWhenTicketCleanupFails();
  await testCreateTeamMemberReturnsPendingWhenPanelSyncFails();
  await testCreateTeamMemberKeepsMemberWhenSubscriptionLookupFails();
  await testUpdateTeamMemberReturnsPendingWhenRecordRefreshFails();
  await testTeamMemberMutationRejectsMismatchedTeamRoute();
  await testTeamMemberMutationRejectsOwnerDemotion();
  await testCreateAnnouncementRejectsBlankTrimmedText();
  await testCreateAnnouncementRejectsFractionalCountdown();
  await testUpdateAnnouncementDefaultsCountdownWhenSwitchingMode();
  await testCreateAnnouncementKeepsLocalSaveWhenPublishFails();
  await testUpdatePolicyRejectsDuplicateModes();
  await testUpdatePolicyAllowsUnrelatedChangeWithHistoricalDuplicateModes();
  await testUpdatePolicyKeepsLocalSaveWhenPublishFails();
  await testDeleteTeamMemberKeepsLocalDeleteWhenTicketCleanupFails();
  await testDeleteTeamMemberKeepsPanelDisableDurableWhenLeaseRevocationFails();
  await testAdminReplySupportTicketWithAttachmentCreatesAttachment();
  await testAdminReplySupportTicketAttachmentCleansUploadWhenTransactionFails();
  await testAdminReplySupportTicketKeepsSaveWhenPublishFails();
  await testAdminReplySupportTicketReturnsFallbackWhenDetailRefreshFails();
  await testAdminReplySupportTicketAttachmentReturnsFallbackWhenDetailRefreshFails();
  await testClientReplySupportTicketAttachmentCleansUploadWhenTransactionFails();
  await testClientReplySupportTicketKeepsSaveWhenPublishFails();
  await testUploadedTempFileCleanupInterceptorDeletesTempFileOnError();
  console.log("dev-data and usage regression checks passed");
}

void main();
