import "reflect-metadata";
import assert from "node:assert/strict";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { createHash } from "node:crypto";
import { existsSync, promises as fsForPatch } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Module,
  NotFoundException,
  ServiceUnavailableException,
  ValidationPipe,
  type ExecutionContext
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import * as bcrypt from "bcryptjs";
import * as jwt from "jsonwebtoken";
import { lastValueFrom, throwError } from "rxjs";
import { LEASE_GRACE_SECONDS } from "../src/modules/common/runtime-session.utils";
import { RuntimeSessionService } from "../src/modules/common/runtime-session.service";
import { DevDataService } from "../src/modules/common/dev-data.service";
import { AdminSubscriptionService } from "../src/modules/common/admin-subscription.service";
import { AdminNodeService } from "../src/modules/common/admin-node.service";
import { ClientAccessService } from "../src/modules/common/client-access.service";
import { ReleaseCenterService } from "../src/modules/common/release-center.service";
import { RuntimeComponentsService } from "../src/modules/common/runtime-components.service";
import { DownloadMirrorService } from "../src/modules/common/download-mirror.service";
import { ImageBedService } from "../src/modules/common/image-bed.service";
import {
  assertReleaseArtifactClientUsable,
  downloadExternalReleaseArtifactFileStrict,
  fetchExternalReleaseArtifactMetadata,
  resolveReleaseArtifactAbsolutePath,
  resolveReleaseArtifactForClient
} from "../src/modules/common/release-center.utils";
import { fetchPublicHttpUrl } from "../src/modules/common/remote-url.utils";
import { AuthSessionService } from "../src/modules/common/auth-session.service";
import { AdminAuthGuard } from "../src/modules/common/admin-auth.guard";
import { ClientRuntimeEventsService } from "../src/modules/common/client-runtime-events.service";
import { ClientAuthGuard } from "../src/modules/common/client-auth.guard";
import { UploadedTempFileCleanupInterceptor } from "../src/modules/common/uploaded-temp-file-cleanup.interceptor";
import { ClientTicketService } from "../src/modules/common/client-ticket.service";
import { AdminController } from "../src/modules/admin/admin.controller";
import { DownloadsController } from "../src/modules/client/downloads.controller";
import { LoggingExceptionFilter } from "../src/logging-exception.filter";
import { forceHttpsMiddleware } from "../src/https-enforcement";
import { AdminRuntimeEventsService } from "../src/modules/common/admin-runtime-events.service";
import {
  ImportNodeDto,
  UpdateCurrentAdminSecurityDto,
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
import { moveUploadedFile } from "../src/modules/common/upload-file.utils";
import { AnnouncementPolicyService } from "../src/modules/common/announcement-policy.service";
import { runWithSubscriptionOwnerLock, runWithSubscriptionUsageLock } from "../src/modules/common/usage-lock.utils";

const GB_IN_BYTES = 1024 ** 3;
const FETCH_FORBIDDEN_TEST_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080
]);
const ZIP_CRC32_TABLE = Array.from({ length: 256 }, (_unused, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function testCrc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ ZIP_CRC32_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createInstance<T>(prototype: object, overrides: Record<string, unknown> = {}) {
  return Object.assign(Object.create(prototype), overrides) as T & Record<string, unknown>;
}

function createDefaultDownloadMirrorService(overrides: Record<string, unknown> = {}) {
  return {
    getEffectiveConfig: async () => ({
      defaultMirrorPrefix: null,
      allowClientMirror: true,
      updatedAt: null
    }),
    getAdminConfig: async () => ({
      defaultMirrorPrefix: null,
      allowClientMirror: true,
      updatedAt: null
    }),
    ...overrides
  };
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

async function waitUntil(predicate: () => boolean, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createDevDataService(overrides: Record<string, unknown> = {}) {
  return createInstance<DevDataService>(DevDataService.prototype, {
    listAdminLeaseRevocationJobs: async () => [],
    getAdminNodeCommandQueue: async () => ({
      jobs: [],
      summaries: { nodes: [], subscriptions: [], users: [], teams: [] }
    }),
    ...overrides
  });
}

function createRuntimeSessionService(overrides: Record<string, unknown> = {}) {
  return createInstance<RuntimeSessionService>(RuntimeSessionService.prototype, overrides);
}

function createReleaseCenterService(overrides: Record<string, unknown> = {}) {
  const adminRuntimeEventsOverride =
    typeof overrides.adminRuntimeEventsService === "object" && overrides.adminRuntimeEventsService !== null
      ? (overrides.adminRuntimeEventsService as Record<string, unknown>)
      : {};
  const downloadMirrorOverride =
    typeof overrides.downloadMirrorService === "object" && overrides.downloadMirrorService !== null
      ? (overrides.downloadMirrorService as Record<string, unknown>)
      : {};
  return createInstance<ReleaseCenterService>(ReleaseCenterService.prototype, {
    logger: {
      warn: () => undefined
    },
    clientEventsPublisher: {
      publishVersionUpdated: async () => undefined
    },
    assertReleaseArtifactContentMatchesMetadata: async () => undefined,
    ...overrides,
    downloadMirrorService: createDefaultDownloadMirrorService(downloadMirrorOverride),
    adminRuntimeEventsService: {
      publishVersionUpdated: () => undefined,
      publishReleaseCenterUpdated: () => undefined,
      ...adminRuntimeEventsOverride
    }
  });
}

function createRuntimeComponentsService(overrides: Record<string, unknown> = {}) {
  const downloadMirrorOverride =
    typeof overrides.downloadMirrorService === "object" && overrides.downloadMirrorService !== null
      ? (overrides.downloadMirrorService as Record<string, unknown>)
      : {};
  return createInstance<RuntimeComponentsService>(RuntimeComponentsService.prototype, {
    ...overrides,
    downloadMirrorService: createDefaultDownloadMirrorService(downloadMirrorOverride)
  });
}

function createClientTicketService(overrides: Record<string, unknown> = {}) {
  const prismaOverride =
    typeof overrides.prisma === "object" && overrides.prisma !== null ? (overrides.prisma as Record<string, unknown>) : {};

  // Attachment quota/pending storage now lives in Postgres; keep in-memory defaults so unit
  // tests that never model those tables still exercise the happy path.
  const rateBuckets = new Map<string, { key: string; count: number; blockedUntil: Date | null }>();
  const pendingAttachments = new Map<string, Record<string, unknown>>();

  const defaultRateLimitBucket = {
    findUnique: async ({ where }: { where: { key: string } }) => rateBuckets.get(where.key) ?? null,
    upsert: async ({
      where,
      create,
      update
    }: {
      where: { key: string };
      create: { key: string; count: number };
      update: { count?: number | { increment?: number } };
    }) => {
      const existing = rateBuckets.get(where.key);
      if (!existing) {
        const created = { key: create.key, count: create.count, blockedUntil: null as Date | null };
        rateBuckets.set(where.key, created);
        return created;
      }
      const increment =
        update.count && typeof update.count === "object" && typeof update.count.increment === "number"
          ? update.count.increment
          : 0;
      const nextCount = typeof update.count === "number" ? update.count : existing.count + increment;
      const next = { ...existing, count: nextCount };
      rateBuckets.set(where.key, next);
      return next;
    },
    update: async ({
      where,
      data
    }: {
      where: { key: string };
      data: Partial<{ count: number; blockedUntil: Date | null }>;
    }) => {
      const existing = rateBuckets.get(where.key) ?? {
        key: where.key,
        count: 0,
        blockedUntil: null as Date | null
      };
      const next = { ...existing, ...data };
      rateBuckets.set(where.key, next);
      return next;
    },
    updateMany: async ({
      where,
      data
    }: {
      where: { key: string; count?: { lte?: number; gte?: number } };
      data: { count?: number | { increment?: number; decrement?: number } };
    }) => {
      const existing = rateBuckets.get(where.key);
      if (!existing) {
        return { count: 0 };
      }
      if (typeof where.count?.lte === "number" && existing.count > where.count.lte) {
        return { count: 0 };
      }
      if (typeof where.count?.gte === "number" && existing.count < where.count.gte) {
        return { count: 0 };
      }
      let nextCount = existing.count;
      if (typeof data.count === "number") {
        nextCount = data.count;
      } else if (typeof data.count?.increment === "number") {
        nextCount = existing.count + data.count.increment;
      } else if (typeof data.count?.decrement === "number") {
        nextCount = existing.count - data.count.decrement;
      }
      rateBuckets.set(where.key, { ...existing, count: nextCount });
      return { count: 1 };
    }
  };

  const defaultPendingAttachment = {
    findMany: async (args?: { where?: Record<string, unknown>; take?: number }) => {
      const rows = [...pendingAttachments.values()];
      const take = typeof args?.take === "number" ? args.take : rows.length;
      return rows.slice(0, take);
    },
    findUnique: async ({ where }: { where: { tokenId: string } }) => pendingAttachments.get(where.tokenId) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      pendingAttachments.set(String(data.tokenId), data);
      return data;
    },
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const tokenIds = Array.isArray((where as any)?.tokenId?.in)
        ? ((where as any).tokenId.in as string[])
        : where.tokenId
          ? [String(where.tokenId)]
          : [...pendingAttachments.keys()];
      let count = 0;
      for (const tokenId of tokenIds) {
        if (pendingAttachments.delete(String(tokenId))) {
          count += 1;
        }
      }
      return { count };
    },
    delete: async ({ where }: { where: { tokenId: string } }) => {
      const existing = pendingAttachments.get(where.tokenId) ?? null;
      pendingAttachments.delete(where.tokenId);
      return existing;
    }
  };

  const rateLimitBucket =
    (prismaOverride.rateLimitBucket as typeof defaultRateLimitBucket | undefined) ?? defaultRateLimitBucket;
  const supportTicketPendingAttachment =
    (prismaOverride.supportTicketPendingAttachment as typeof defaultPendingAttachment | undefined) ??
    defaultPendingAttachment;

  const defaultTx = {
    rateLimitBucket,
    supportTicketPendingAttachment,
    ...prismaOverride
  };

  const userTransaction =
    typeof prismaOverride.$transaction === "function"
      ? (prismaOverride.$transaction as (task: (tx: Record<string, unknown>) => unknown) => unknown)
      : null;

  const runWithAccessTracking = async (task: (tx: Record<string, unknown>) => unknown, tx: Record<string, unknown>) => {
    const accessed = new Set<string>();
    const proxy = new Proxy(tx, {
      get(target, prop, receiver) {
        if (typeof prop === "string") {
          accessed.add(prop);
        }
        return Reflect.get(target, prop, receiver);
      }
    });
    const result = await task(proxy);
    return { result, accessed };
  };

  const prisma = {
    rateLimitBucket,
    supportTicketPendingAttachment,
    ...prismaOverride,
    $transaction: async (task: (tx: Record<string, unknown>) => unknown) => {
      if (!userTransaction) {
        return task({
          ...defaultTx,
          rateLimitBucket,
          supportTicketPendingAttachment
        });
      }

      let invoked = false;
      try {
        return await userTransaction((tx) => {
          invoked = true;
          return task({
            ...defaultTx,
            ...tx,
            rateLimitBucket: (tx as any)?.rateLimitBucket ?? rateLimitBucket,
            supportTicketPendingAttachment:
              (tx as any)?.supportTicketPendingAttachment ?? supportTicketPendingAttachment
          });
        });
      } catch (error) {
        // Hard-fail stubs often throw without calling the callback. Allow attachment quota /
        // pending storage transactions to use defaults, but keep real write failures.
        if (invoked) {
          throw error;
        }
        try {
          const { result, accessed } = await runWithAccessTracking(task, {
            ...defaultTx,
            rateLimitBucket,
            supportTicketPendingAttachment
          });
          const businessAccess = [...accessed].some(
            (key) => key !== "rateLimitBucket" && key !== "supportTicketPendingAttachment"
          );
          if (businessAccess) {
            throw error;
          }
          return result;
        } catch {
          throw error;
        }
      }
    }
  };

  const imageBedOverride =
    typeof overrides.imageBedService === "object" && overrides.imageBedService !== null
      ? (overrides.imageBedService as Record<string, unknown>)
      : {};

  return createInstance<ClientTicketService>(ClientTicketService.prototype, {
    ...overrides,
    prisma,
    imageBedService: {
      assertSupportTicketAttachment: () => undefined,
      uploadSupportTicketAttachment: async () => {
        throw new Error("imageBedService.uploadSupportTicketAttachment is not mocked");
      },
      deleteUploadedSupportTicketAttachmentBestEffort: async () => undefined,
      ...imageBedOverride
    }
  });
}

function createAdminSubscriptionService(overrides: Record<string, unknown> = {}) {
  const runtimeSessionOverride =
    typeof overrides.runtimeSessionService === "object" && overrides.runtimeSessionService !== null
      ? (overrides.runtimeSessionService as Record<string, unknown>)
      : {};
  const prismaOverride =
    typeof overrides.prisma === "object" && overrides.prisma !== null ? (overrides.prisma as Record<string, unknown>) : {};
  const adminRuntimeEventsOverride =
    typeof overrides.adminRuntimeEventsService === "object" && overrides.adminRuntimeEventsService !== null
      ? (overrides.adminRuntimeEventsService as Record<string, unknown>)
      : {};
  return createInstance<AdminSubscriptionService>(AdminSubscriptionService.prototype, {
    ...overrides,
    prisma: {
      $transaction: async (task: (tx: Record<string, unknown>) => unknown) => task(prismaOverride),
      ...prismaOverride
    },
    runtimeSessionService: {
      queueActiveLeaseSyncForSubscription: async () => 0,
      queueDirectSubscriptionAccessSync: async () => 0,
      queueDirectSubscriptionAccessSync: async () => 0,
      quiesceDirectBindingsForTrafficReset: async () => [],
      queueLeaseRevocationJobsForSubscription: async () => 0,
      queueLeaseRevocationJobsForSubscriptionTx: async () => 0,
      ...runtimeSessionOverride
    },
    adminRuntimeEventsService: {
      publishSubscriptionUpdated: () => undefined,
      ...adminRuntimeEventsOverride
    }
  });
}

function createAuthSessionService(overrides: Record<string, unknown> = {}) {
  return createInstance<AuthSessionService>(AuthSessionService.prototype, overrides);
}

function createClientRuntimeEventsService(overrides: Record<string, unknown> = {}) {
  return createInstance<ClientRuntimeEventsService>(ClientRuntimeEventsService.prototype, overrides);
}

function createAdminRuntimeEventsService(overrides: Record<string, unknown> = {}) {
  return createInstance<AdminRuntimeEventsService>(AdminRuntimeEventsService.prototype, overrides);
}

function createAdminNodeService(overrides: Record<string, unknown> = {}) {
  const runtimeSessionOverride =
    typeof overrides.runtimeSessionService === "object" && overrides.runtimeSessionService !== null
      ? (overrides.runtimeSessionService as Record<string, unknown>)
      : {};
  return createInstance<AdminNodeService>(AdminNodeService.prototype, {
    ...overrides,
    runtimeSessionService: {
      revokeNodeLeases: async () => 0,
      queueLeaseRevocationJobForNode: async () => undefined,
      ...runtimeSessionOverride
    }
  });
}

function createAnnouncementPolicyService(overrides: Record<string, unknown> = {}) {
  return createInstance<AnnouncementPolicyService>(AnnouncementPolicyService.prototype, {
    adminRuntimeEventsService: {
      publish: () => undefined
    },
    ...overrides
  });
}

function createClientAccessService(overrides: Record<string, unknown> = {}) {
  return createInstance<ClientAccessService>(ClientAccessService.prototype, {
    releaseCenterService: {
      checkClientUpdate: async () => ({
        hasUpdate: false,
        forceUpgrade: false,
        blockedByMinimumVersion: false,
        forcedByRelease: false,
        updateRequirement: "optional",
        currentVersion: "0.0.0",
        latestVersion: "0.0.0",
        minimumVersion: "0.0.0",
        platform: "windows",
        channel: "stable",
        changelog: [],
        deliveryMode: "none",
        recommendedArtifact: null,
        downloadUrl: null,
        fileName: null,
        fileSizeBytes: null,
        fileHash: null,
        publishedAt: null
      })
    },
    clientRoutingRuleService: {
      listRulesForUserId: async () => []
    },
    ...overrides
  });
}

function createValidWindowsFullUpdateZip(version = "1.1.6") {
  return createStoredZipWithEntries([
    { entryName: "ChordV.exe", data: createTestWindowsPeData(version) },
    { entryName: "bin/xray.exe", data: createTestWindowsPeData(version) },
    { entryName: "bin/geoip.dat", data: Buffer.alloc(64 * 1024, 1) },
    { entryName: "bin/geosite.dat", data: Buffer.alloc(64 * 1024, 1) }
  ]);
}
function createStoredZipWithEntries(entries: Array<{ entryName: string; data: Buffer }>) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.entryName);
    const data = entry.data;
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
    centralDirectory.writeUInt32LE(offset, 42);

    localParts.push(localHeader, name, data);
    centralParts.push(centralDirectory, name);
    offset += localHeader.length + name.length + data.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectorySize = centralParts.reduce((total, item) => total + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectorySize, 12);
  end.writeUInt32LE(centralDirectoryOffset, 16);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

function createTestWindowsPeData(version = "1.1.6") {
  const data = Buffer.alloc(1024 * 1024, 0);
  data[0] = 0x4d;
  data[1] = 0x5a;
  data.writeUInt32LE(0x80, 0x3c);
  data.writeUInt32LE(0x00004550, 0x80);
  const [major, minor, patch] = version.split(".").map((part) => Number(part));
  data.writeUInt32LE(0xfeef04bd, 0x200);
  data.writeUInt32LE((major << 16) | minor, 0x210);
  data.writeUInt32LE((patch << 16) | 0, 0x214);
  return data;
}

function makeReleaseCenterTestRelease(overrides: Record<string, any> = {}) {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "release_1",
    platform: "windows",
    channel: "stable",
    version: "1.1.3",
    displayTitle: "ChordV 1.1.3",
    changelog: ["Full replacement"],
    minimumVersion: "1.1.0",
    forceUpgrade: false,
    status: "draft",
    publishedAt: null,
    createdAt: now,
    updatedAt: now,
    artifacts: [],
    ...overrides
  };
}

function makeReleaseCenterTestArtifact(overrides: Record<string, any> = {}) {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "artifact_1",
    releaseId: "release_1",
    source: "external",
    type: "zip",
    deliveryMode: "desktop_full_replace",
    downloadUrl: "https://example.com/ChordV_1.1.3_x64-full.zip",
    defaultMirrorPrefix: null,
    allowClientMirror: true,
    fileName: "ChordV_1.1.3_x64-full.zip",
    storedFilePath: null,
    fileSizeBytes: 1024n,
    fileHash: "a".repeat(64),
    isPrimary: true,
    isFullPackage: true,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function createInMemoryReleaseCenterHarness() {
  const releases: any[] = [];
  const artifacts: any[] = [];
  const hydrateRelease = (release: any) => ({
    ...release,
    artifacts: artifacts.filter((artifact) => artifact.releaseId === release.id)
  });
  const releaseDelegate = {
    create: async (payload: Record<string, any>) => {
      const now = new Date();
      const release = {
        ...payload.data,
        createdAt: now,
        updatedAt: now
      };
      releases.push(release);
      return payload.include?.artifacts ? hydrateRelease(release) : release;
    },
    findUnique: async (payload: Record<string, any>) => {
      const release = releases.find((item) => item.id === payload.where.id) ?? null;
      return release && payload.include?.artifacts ? hydrateRelease(release) : release;
    },
    findMany: async (payload: Record<string, any>) => {
      const rows = releases.filter((release) => {
        if (payload.where?.channel && release.channel !== payload.where.channel) return false;
        if (payload.where?.status && release.status !== payload.where.status) return false;
        if (payload.where?.platform && release.platform !== payload.where.platform) return false;
        return true;
      });
      return payload.include?.artifacts ? rows.map(hydrateRelease) : rows;
    },
    update: async (payload: Record<string, any>) => {
      const release = releases.find((item) => item.id === payload.where.id);
      if (!release) {
        throw new Error("release not found in in-memory test harness");
      }
      Object.assign(release, payload.data, { updatedAt: new Date() });
      return payload.include?.artifacts ? hydrateRelease(release) : release;
    }
  };
  const artifactDelegate = {
    create: async (payload: Record<string, any>) => {
      const now = new Date();
      const artifact = {
        ...payload.data,
        createdAt: now,
        updatedAt: now
      };
      artifacts.push(artifact);
      return artifact;
    },
    updateMany: async (payload: Record<string, any>) => {
      let count = 0;
      for (const artifact of artifacts) {
        if (!payload.where?.releaseId || artifact.releaseId === payload.where.releaseId) {
          Object.assign(artifact, payload.data, { updatedAt: new Date() });
          count += 1;
        }
      }
      return { count };
    },
    findUnique: async (payload: Record<string, any>) => {
      const artifact = artifacts.find((item) => item.id === payload.where.id) ?? null;
      if (!artifact || !payload.include?.release) {
        return artifact;
      }
      const release = releases.find((item) => item.id === artifact.releaseId) ?? null;
      return { ...artifact, release };
    }
  };
  const prisma = {
    release: releaseDelegate,
    releaseArtifact: artifactDelegate,
    $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
      task({
        release: releaseDelegate,
        releaseArtifact: artifactDelegate
      })
  };
  return {
    service: createReleaseCenterService({ prisma }),
    releases,
    artifacts
  };
}

async function listenOnFetchSafeLocalhost(server: Server) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
    const address = server.address();
    if (address && typeof address === "object" && !FETCH_FORBIDDEN_TEST_PORTS.has(address.port)) {
      return;
    }
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  throw new Error("Unable to allocate a fetch-safe localhost test port.");
}

async function listenOnFetchSafeNestApp(app: { init: () => Promise<unknown>; getHttpServer: () => Server }) {
  await app.init();
  await listenOnFetchSafeLocalhost(app.getHttpServer());
  const address = app.getHttpServer().address();
  assert.ok(address && typeof address === "object", "Nest HTTP regression server should be listening");
  return `http://127.0.0.1:${address.port}`;
}

async function testSubscriptionUsageLockTimesOutWithoutPoisoningLocalQueue() {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalLockTimeout = process.env.CHORDV_SUBSCRIPTION_LOCK_WAIT_TIMEOUT_MS;
  const originalLockRetry = process.env.CHORDV_SUBSCRIPTION_LOCK_RETRY_INTERVAL_MS;
  delete process.env.DATABASE_URL;
  process.env.CHORDV_SUBSCRIPTION_LOCK_WAIT_TIMEOUT_MS = "25";
  process.env.CHORDV_SUBSCRIPTION_LOCK_RETRY_INTERVAL_MS = "5";
  let releaseOuterLock!: () => void;

  const heldLock = runWithSubscriptionUsageLock(
    "subscription_lock_timeout",
    async () =>
      new Promise<void>((resolve) => {
        releaseOuterLock = resolve;
      })
  );

  try {
    for (let attempt = 0; !releaseOuterLock && attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await assert.rejects(
      () => runWithSubscriptionUsageLock("subscription_lock_timeout", async () => "late"),
      (error) => error instanceof ConflictException && /retry shortly/.test(error.message),
      "local subscription locks must fail as retryable conflict instead of waiting until the admin request times out"
    );

    releaseOuterLock();
    await heldLock;
    const result = await runWithSubscriptionUsageLock("subscription_lock_timeout", async () => "ok");
    assert.equal(result, "ok", "timed-out local lock waiters must not poison the lock queue");
  } finally {
    if (releaseOuterLock) {
      releaseOuterLock();
    }
    await heldLock.catch(() => undefined);
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    if (originalLockTimeout === undefined) {
      delete process.env.CHORDV_SUBSCRIPTION_LOCK_WAIT_TIMEOUT_MS;
    } else {
      process.env.CHORDV_SUBSCRIPTION_LOCK_WAIT_TIMEOUT_MS = originalLockTimeout;
    }
    if (originalLockRetry === undefined) {
      delete process.env.CHORDV_SUBSCRIPTION_LOCK_RETRY_INTERVAL_MS;
    } else {
      process.env.CHORDV_SUBSCRIPTION_LOCK_RETRY_INTERVAL_MS = originalLockRetry;
    }
  }
}

async function testSubscriptionOwnerLockTimesOutAsRetryableConflict() {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalLockTimeout = process.env.CHORDV_SUBSCRIPTION_LOCK_WAIT_TIMEOUT_MS;
  const originalLockRetry = process.env.CHORDV_SUBSCRIPTION_LOCK_RETRY_INTERVAL_MS;
  delete process.env.DATABASE_URL;
  process.env.CHORDV_SUBSCRIPTION_LOCK_WAIT_TIMEOUT_MS = "25";
  process.env.CHORDV_SUBSCRIPTION_LOCK_RETRY_INTERVAL_MS = "5";
  let releaseOuterLock!: () => void;

  const heldLock = runWithSubscriptionOwnerLock(
    "personal:user_lock_timeout",
    async () =>
      new Promise<void>((resolve) => {
        releaseOuterLock = resolve;
      })
  );

  try {
    for (let attempt = 0; !releaseOuterLock && attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await assert.rejects(
      () => runWithSubscriptionOwnerLock("personal:user_lock_timeout", async () => "late"),
      (error) => error instanceof ConflictException && /retry shortly/.test(error.message),
      "local owner locks must fail as retryable conflict instead of waiting until the admin request times out"
    );

    releaseOuterLock();
    await heldLock;
    const result = await runWithSubscriptionOwnerLock("personal:user_lock_timeout", async () => "ok");
    assert.equal(result, "ok", "timed-out local owner lock waiters must not poison the lock queue");
  } finally {
    if (releaseOuterLock) {
      releaseOuterLock();
    }
    await heldLock.catch(() => undefined);
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    if (originalLockTimeout === undefined) {
      delete process.env.CHORDV_SUBSCRIPTION_LOCK_WAIT_TIMEOUT_MS;
    } else {
      process.env.CHORDV_SUBSCRIPTION_LOCK_WAIT_TIMEOUT_MS = originalLockTimeout;
    }
    if (originalLockRetry === undefined) {
      delete process.env.CHORDV_SUBSCRIPTION_LOCK_RETRY_INTERVAL_MS;
    } else {
      process.env.CHORDV_SUBSCRIPTION_LOCK_RETRY_INTERVAL_MS = originalLockRetry;
    }
  }
}

async function testPublicRemoteUrlDnsLookupRespectsTimeout() {
  await assert.rejects(
    () =>
      Promise.race([
        fetchPublicHttpUrl("https://download.example.com/runtime.zip", {}, {
          errorPrefix: "Runtime component",
          dnsLookupTimeoutMs: 20,
          dnsLookup: async () => new Promise(() => undefined)
        }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("public remote URL DNS lookup ignored timeout")), 500);
        })
      ]),
    /Runtime component DNS lookup timed out after 20ms/
  );
}

async function testPublicRemoteUrlRejectsPrivateAddressOnConnectLookup() {
  let lookupCalls = 0;
  await assert.rejects(
    () =>
      fetchPublicHttpUrl("https://download.example.com/runtime.zip", {}, {
        errorPrefix: "Runtime component",
        dnsLookup: async () => {
          lookupCalls += 1;
          if (lookupCalls === 1) {
            return [{ address: "93.184.216.34", family: 4 }];
          }
          return [{ address: "127.0.0.1", family: 4 }];
        }
      }),
    /Runtime component resolves to a private or reserved address/
  );
  assert.ok(lookupCalls >= 2, "public remote URL protection must validate the actual connection lookup");
}

async function testImageBedListRejectsSuccessFalsePayload() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ success: false, message: "bad token" }));
  });
  await listenOnFetchSafeLocalhost(server);
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
      (error) =>
        error instanceof BadGatewayException &&
        /图床列表读取失败/.test(error.message) &&
        /HTTP 200/.test(error.message) &&
        /bad token/i.test(error.message),
      "image bed list must reject HTTP 200 business failures while preserving the provider reason"
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testImageBedListUsesShortManageTimeout() {
  const previousTimeout = process.env.CHORDV_IMAGE_BED_MANAGE_TIMEOUT_MS;
  process.env.CHORDV_IMAGE_BED_MANAGE_TIMEOUT_MS = "25";
  const server = createServer(() => {
    // Intentionally never respond; admin file management should fail on its own short budget.
  });
  await listenOnFetchSafeLocalhost(server);
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

    const startedAt = Date.now();
    await assert.rejects(
      () => service.listAdminFiles(),
      /图床服务请求超时，已等待 25ms/,
      "image bed file list should use the short management timeout"
    );
    assert.equal(Date.now() - startedAt < 1000, true, "image bed file list must not wait on the long upload timeout");
  } finally {
    if (previousTimeout === undefined) {
      delete process.env.CHORDV_IMAGE_BED_MANAGE_TIMEOUT_MS;
    } else {
      process.env.CHORDV_IMAGE_BED_MANAGE_TIMEOUT_MS = previousTimeout;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testImageBedListMapsResponseReadFailure() {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        text: async () => {
          throw new Error("socket body reset");
        }
      }) as Response) as typeof fetch;
    const service = createInstance<ImageBedService>(ImageBedService.prototype, {
      prisma: {
        systemSetting: {
          findUnique: async () => ({
            value: {
              baseUrl: "https://image.achord.cn",
              apiToken: "test-token"
            },
            updatedAt: new Date("2026-01-01T00:00:00.000Z")
          })
        }
      }
    });

    await assert.rejects(
      () => service.listAdminFiles(),
      (error) =>
        error instanceof BadGatewayException &&
        /图床服务响应读取失败/.test(error.message) &&
        !/socket body reset/i.test(error.message),
      "image bed response body read failures must return a controlled gateway error instead of HTTP 500"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testImageBedListDefaultsToUploadFolder() {
  let requestPath = "";
  const server = createServer((request, response) => {
    requestPath = request.url ?? "";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ success: true, files: [] }));
  });
  await listenOnFetchSafeLocalhost(server);
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    const service = createInstance<ImageBedService>(ImageBedService.prototype, {
      prisma: {
        systemSetting: {
          findUnique: async () => ({
            value: {
              baseUrl: `http://127.0.0.1:${address.port}`,
              apiToken: "test-token",
              uploadFolder: "support-tickets"
            },
            updatedAt: new Date("2026-01-01T00:00:00.000Z")
          })
        }
      }
    });

    await service.listAdminFiles();

    const url = new URL(requestPath, `http://127.0.0.1:${address.port}`);
    assert.equal(url.pathname, "/api/manage/list");
    assert.equal(url.searchParams.get("dir"), "support-tickets");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testImageBedListUsesProviderFileIdForNestedFiles() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        success: true,
        files: [
          {
            name: "screenshot.png",
            fullId: "support-tickets/screenshot.png",
            metadata: {
              "File-Mime": "image/png",
              "File-Size": "1234"
            }
          }
        ]
      })
    );
  });
  await listenOnFetchSafeLocalhost(server);
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    const service = createInstance<ImageBedService>(ImageBedService.prototype, {
      prisma: {
        systemSetting: {
          findUnique: async () => ({
            value: {
              baseUrl: `http://127.0.0.1:${address.port}`,
              apiToken: "test-token",
              uploadFolder: "support-tickets"
            },
            updatedAt: new Date("2026-01-01T00:00:00.000Z")
          })
        }
      }
    });

    const result = await service.listAdminFiles();

    assert.equal(result.files[0]?.name, "support-tickets/screenshot.png");
    assert.equal(result.files[0]?.url, `http://127.0.0.1:${address.port}/file/support-tickets/screenshot.png`);
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
  await listenOnFetchSafeLocalhost(server);
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
      (error) =>
        error instanceof BadGatewayException &&
        /图床上传失败/.test(error.message) &&
        /HTTP 200/.test(error.message) &&
        /upload rejected/i.test(error.message),
      "image bed upload must reject HTTP 200 business failures while preserving the provider reason"
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testImageBedUploadUsesCallerTimeout() {
  const server = createServer(() => {
    // Intentionally never respond; ticket replies pass a short upload budget.
  });
  await listenOnFetchSafeLocalhost(server);
  const address = server.address();
  assert(address && typeof address === "object");

  const tempDir = await mkdtemp(path.join(tmpdir(), "image-bed-upload-timeout-"));
  const filePath = path.join(tempDir, "timeout.png");
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

    const startedAt = Date.now();
    await assert.rejects(
      () =>
        service.uploadSupportTicketAttachment(
          {
            path: filePath,
            originalname: "timeout.png",
            mimetype: "image/png",
            size: 5
          },
          { timeoutMs: 25 }
        ),
      /图床服务请求超时，已等待 25ms/
    );
    assert.equal(Date.now() - startedAt < 1000, true, "image bed upload must respect the caller timeout");
    assert.equal(existsSync(filePath), false, "timed-out image bed uploads must remove the temporary file");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testImageBedUploadSuccessParsesUrlAndCleansTempFile() {
  let observedUrl = "";
  let observedAuthorization = "";
  const server = createServer((request, response) => {
    observedUrl = request.url ?? "";
    observedAuthorization = String(request.headers.authorization ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        success: true,
        fileUrl: "/file/support-tickets/screenshot.png",
        fullId: "support-tickets/screenshot.png"
      })
    );
  });
  await listenOnFetchSafeLocalhost(server);
  const address = server.address();
  assert(address && typeof address === "object");

  const tempDir = await mkdtemp(path.join(tmpdir(), "image-bed-upload-success-"));
  const filePath = path.join(tempDir, "screenshot original.png");
  await writeFile(filePath, Buffer.from("image"));
  try {
    const service = createInstance<ImageBedService>(ImageBedService.prototype, {
      prisma: {
        systemSetting: {
          findUnique: async () => ({
            value: {
              baseUrl: `http://127.0.0.1:${address.port}`,
              apiToken: "test-token",
              uploadFolder: "support-tickets",
              uploadChannel: "ticket-channel",
              channelName: "ticket-channel-name"
            },
            updatedAt: new Date("2026-01-01T00:00:00.000Z")
          })
        }
      }
    });

    const result = await service.uploadSupportTicketAttachment({
      path: filePath,
      originalname: "screen shot.png",
      mimetype: "image/png",
      size: 5
    });
    const requestUrl = new URL(observedUrl, `http://127.0.0.1:${address.port}`);

    assert.equal(requestUrl.pathname, "/upload");
    assert.equal(requestUrl.searchParams.get("returnFormat"), "full");
    assert.equal(requestUrl.searchParams.get("uploadFolder"), "support-tickets");
    assert.equal(requestUrl.searchParams.get("uploadChannel"), "ticket-channel");
    assert.equal(requestUrl.searchParams.get("channelName"), "ticket-channel-name");
    assert.equal(observedAuthorization, "Bearer test-token");
    assert.equal(result.url, `http://127.0.0.1:${address.port}/file/support-tickets/screenshot.png`);
    assert.equal(result.providerFileId, "support-tickets/screenshot.png");
    assert.equal(result.fileName, "screen shot.png");
    assert.equal(result.mimeType, "image/png");
    assert.equal(result.fileSizeBytes, 5n);
    assert.equal(existsSync(filePath), false, "successful image bed uploads must remove the temporary file");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testImageBedUploadMapsMissingTempFileToServiceUnavailable() {
  const missingPath = path.join(tmpdir(), `missing-image-bed-${Date.now()}.png`);
  const service = createInstance<ImageBedService>(ImageBedService.prototype, {
    prisma: {
      systemSetting: {
        findUnique: async () => ({
          value: {
            baseUrl: "https://image.achord.cn",
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
        path: missingPath,
        originalname: "missing.png",
        mimetype: "image/png",
        size: 5
      }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      /附件临时文件读取失败/.test(error.message) &&
      !/ENOENT|HTTP 500/i.test(error.message),
    "missing image bed temp files must return a controlled 503 instead of leaking fs errors"
  );
}

async function testImageBedUploadRejectsMalformedReturnedUrlAndCleansTempFile() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        success: true,
        fileUrl: "https://%"
      })
    );
  });
  await listenOnFetchSafeLocalhost(server);
  const address = server.address();
  assert(address && typeof address === "object");

  const tempDir = await mkdtemp(path.join(tmpdir(), "image-bed-upload-bad-url-"));
  const filePath = path.join(tempDir, "bad-url.png");
  await writeFile(filePath, Buffer.from("image"));
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
          originalname: "bad-url.png",
          mimetype: "image/png",
          size: 5
        }),
      (error) =>
        error instanceof BadGatewayException &&
        /图床上传响应缺少文件地址/.test(error.message) &&
        !/Invalid URL|HTTP 500/i.test(error.message),
      "malformed image bed upload URLs must return a controlled 502 instead of leaking URL parser errors"
    );
    assert.equal(existsSync(filePath), false, "failed image bed uploads with malformed URLs must remove the temporary file");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testImageBedUploadRejectsNonImageAndCleansTempFile() {
  const tempDir = await mkdtemp(path.join(tmpdir(), "image-bed-upload-invalid-"));
  const filePath = path.join(tempDir, "note.txt");
  await writeFile(filePath, "not image");
  try {
    const service = createInstance<ImageBedService>(ImageBedService.prototype, {
      prisma: {
        systemSetting: {
          findUnique: async () => {
            throw new Error("invalid attachment must be rejected before reading image bed config");
          }
        }
      }
    });

    await assert.rejects(
      () =>
        service.uploadSupportTicketAttachment({
          path: filePath,
          originalname: "note.txt",
          mimetype: "text/plain",
          size: 8
        }),
      /仅支持上传图片附件/
    );
    assert.equal(existsSync(filePath), false, "rejected image bed uploads must remove the temporary file");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
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
  await listenOnFetchSafeLocalhost(server);
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

async function testImageBedDeleteAcceptsDeletedListWithoutSuccessTrue() {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/manage/delete/support-tickets/removed.png");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        fileId: "support-tickets/removed.png",
        deleted: ["support-tickets/removed.png"]
      })
    );
  });
  await listenOnFetchSafeLocalhost(server);
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

    const result = await service.deleteAdminFile({ path: "support-tickets/removed.png" });

    assert.equal(result.success, true);
    assert.equal(result.fileId, "support-tickets/removed.png");
    assert.deepEqual(result.deleted, ["support-tickets/removed.png"]);
    assert.deepEqual(result.failed, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testImageBedDeleteUsesShortManageTimeout() {
  const previousTimeout = process.env.CHORDV_IMAGE_BED_MANAGE_TIMEOUT_MS;
  process.env.CHORDV_IMAGE_BED_MANAGE_TIMEOUT_MS = "25";
  const server = createServer(() => {
    // Intentionally never respond; admin delete should use the same short management budget as listing.
  });
  await listenOnFetchSafeLocalhost(server);
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

    const startedAt = Date.now();
    await assert.rejects(
      () => service.deleteAdminFile({ path: "support-tickets/stalled.png" }),
      /图床服务请求超时，已等待 25ms/,
      "image bed delete should use the short management timeout"
    );
    assert.equal(Date.now() - startedAt < 1000, true, "image bed delete must not wait on the long upload timeout");
  } finally {
    if (previousTimeout === undefined) {
      delete process.env.CHORDV_IMAGE_BED_MANAGE_TIMEOUT_MS;
    } else {
      process.env.CHORDV_IMAGE_BED_MANAGE_TIMEOUT_MS = previousTimeout;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testImageBedDeleteAllowsPlainPercentFilePath() {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/manage/delete/support-tickets/100%25%20legit.png");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        fileId: "support-tickets/100% legit.png",
        deleted: ["support-tickets/100% legit.png"]
      })
    );
  });
  await listenOnFetchSafeLocalhost(server);
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

    const result = await service.deleteAdminFile({ path: "support-tickets/100% legit.png" });

    assert.equal(result.success, true);
    assert.equal(result.fileId, "support-tickets/100% legit.png");
    assert.deepEqual(result.deleted, ["support-tickets/100% legit.png"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testImageBedDeleteRejectsMalformedPercentUrlPath() {
  const service = createInstance<ImageBedService>(ImageBedService.prototype, {
    prisma: {
      systemSetting: {
        findUnique: async () => {
          throw new Error("malformed file URL path must be rejected before loading image bed config");
        }
      }
    }
  });

  await assert.rejects(
    () => service.deleteAdminFile({ path: "https://image.achord.cn/file/support-tickets/100% legit.png" }),
    /图床文件路径无效/
  );
}

async function testUpdateImageBedConfigDoesNotValidateExternalImageBed() {
  const originalFetch = globalThis.fetch;
  let upsertPayload: Record<string, any> | null = null;
  let findUniqueCalls = 0;
  let storedValue: Record<string, unknown> = {
    baseUrl: "https://old.example.com",
    apiToken: "old-token"
  };
  try {
    globalThis.fetch = (() => {
      throw new Error("update config must not call external image bed");
    }) as typeof fetch;
    const service = createInstance<ImageBedService>(ImageBedService.prototype, {
      prisma: {
        systemSetting: {
          findUnique: async () => {
            findUniqueCalls += 1;
            if (findUniqueCalls > 1) {
              throw new Error("config was saved but refresh failed");
            }
            return {
              value: storedValue,
              updatedAt: new Date("2026-01-01T00:00:00.000Z")
            };
          },
          upsert: async (payload: Record<string, any>) => {
            upsertPayload = payload;
            storedValue = payload.update.value;
            return {
              value: storedValue,
              updatedAt: new Date("2026-01-01T00:01:00.000Z")
            };
          }
        }
      }
    });

    const result = await service.updateAdminConfig({
      baseUrl: "https://image.achord.cn/",
      apiToken: "imgbed_secret_token",
      uploadFolder: "support-tickets"
    });

    assert.ok(upsertPayload, "config must be persisted locally");
    assert.equal(findUniqueCalls, 1, "update must not do a second config refresh after saving");
    assert.equal(result.baseUrl, "https://image.achord.cn");
    assert.equal(result.hasToken, true);
    assert.equal(result.tokenSource, "database");
    assert.match(result.tokenPreview ?? "", /^imgb/);
    assert.doesNotMatch(result.tokenPreview ?? "", /secret_token/);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testImageBedMutationsPublishAdminRefreshEvent() {
  const adminEvents: string[] = [];
  const service = createInstance<ImageBedService>(ImageBedService.prototype, {
    adminRuntimeEventsService: {
      publishImageBedUpdated: () => {
        adminEvents.push("image_bed_updated");
      }
    },
    prisma: {
      systemSetting: {
        findUnique: async () => ({
          value: {
            baseUrl: "https://image.example.com",
            apiToken: "old-token"
          },
          updatedAt: new Date("2026-01-01T00:00:00.000Z")
        }),
        upsert: async (payload: Record<string, any>) => ({
          value: payload.update.value,
          updatedAt: new Date("2026-01-01T00:01:00.000Z")
        })
      }
    },
    loadEffectiveConfig: async () => ({
      baseUrl: "https://image.example.com",
      apiToken: "token",
      uploadFolder: "support-tickets",
      uploadChannel: null,
      channelName: null,
      tokenSource: "database",
      updatedAt: new Date("2026-01-01T00:01:00.000Z")
    }),
    requestImageBedJson: async () => ({
      success: true,
      fileId: "support-tickets/removed.png",
      deleted: ["support-tickets/removed.png"]
    })
  });

  await service.updateAdminConfig({
    baseUrl: "https://image.example.com",
    apiToken: "new-token"
  });
  await service.deleteAdminFile({ path: "support-tickets/removed.png" });

  assert.deepEqual(adminEvents, ["image_bed_updated", "image_bed_updated"]);
}

async function testUpdateImageBedConfigRejectsBaseUrlWithPath() {
  const service = createInstance<ImageBedService>(ImageBedService.prototype, {
    prisma: {
      systemSetting: {
        findUnique: async () => ({
          value: {},
          updatedAt: null
        }),
        upsert: async () => {
          throw new Error("baseUrl with path must be rejected before saving");
        }
      }
    }
  });

  await assert.rejects(
    () => service.updateAdminConfig({ baseUrl: "https://image.example.com/cfbed?token=abc" }),
    (error) =>
      error instanceof BadRequestException &&
      /只填写图床域名/.test(error.message),
    "image bed baseUrl with path must be rejected instead of being silently truncated"
  );
}

async function testGetImageBedConfigMapsLocalReadFailure() {
  const service = createInstance<ImageBedService>(ImageBedService.prototype, {
    prisma: {
      systemSetting: {
        findUnique: async () => {
          throw new Error("server closed the connection unexpectedly");
        }
      }
    }
  });

  await assert.rejects(
    () => service.getAdminConfig(),
    (error) =>
      error instanceof ServiceUnavailableException &&
      /图床配置读取失败/.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "image bed config read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testGetImageBedConfigTimesOutSlowLocalRead() {
  const previousTimeout = process.env.CHORDV_IMAGE_BED_CONFIG_READ_TIMEOUT_MS;
  process.env.CHORDV_IMAGE_BED_CONFIG_READ_TIMEOUT_MS = "25";
  const service = createInstance<ImageBedService>(ImageBedService.prototype, {
    prisma: {
      systemSetting: {
        findUnique: async () => new Promise(() => undefined)
      }
    }
  });
  const startedAt = Date.now();

  try {
    await assert.rejects(
      () => service.getAdminConfig(),
      (error) =>
        error instanceof ServiceUnavailableException &&
        /图床配置读取失败/.test(error.message) &&
        !/HTTP 500/i.test(error.message),
      "image bed config reads must fail fast with a controlled 503 when the database stalls"
    );
    assert.ok(Date.now() - startedAt < 500, "image bed config load must not wait for the full admin request timeout");
  } finally {
    if (previousTimeout === undefined) {
      delete process.env.CHORDV_IMAGE_BED_CONFIG_READ_TIMEOUT_MS;
    } else {
      process.env.CHORDV_IMAGE_BED_CONFIG_READ_TIMEOUT_MS = previousTimeout;
    }
  }
}

async function testUpdateImageBedConfigMapsLocalSaveFailure() {
  const service = createInstance<ImageBedService>(ImageBedService.prototype, {
    prisma: {
      systemSetting: {
        findUnique: async () => ({
          value: {},
          updatedAt: null
        }),
        upsert: async () => {
          throw new Error("server closed the connection unexpectedly");
        }
      }
    }
  });

  await assert.rejects(
    () => service.updateAdminConfig({ apiToken: "imgbed_token" }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      /图床配置保存失败/.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "image bed config save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testImageBedDeleteReturnsStructuredMessageWhenSuccessFalseWithoutFailedArray() {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/manage/delete/support-tickets/missing.png");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        success: false,
        fileId: "support-tickets/missing.png",
        message: "already deleted"
      })
    );
  });
  await listenOnFetchSafeLocalhost(server);
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
    assert.deepEqual(result.deleted, []);
    assert.deepEqual(result.failed, ["already deleted"]);
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

async function testImageBedAttachmentCleanupLogsBusinessDeleteFailure() {
  const warnings: string[] = [];
  const service = createInstance<ImageBedService>(ImageBedService.prototype, {
    logger: {
      warn: (message: string) => warnings.push(message)
    },
    deleteAdminFile: async () => ({
      success: false,
      fileId: "support-tickets/failed.png",
      deleted: [],
      failed: ["already deleted"]
    })
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
  assert.match(warnings[0], /already deleted/);
}

async function testImageBedAttachmentCleanupReturnsWhenDeleteStalls() {
  const warnings: string[] = [];
  const service = createInstance<ImageBedService>(ImageBedService.prototype, {
    logger: {
      warn: (message: string) => warnings.push(message)
    },
    deleteAdminFile: async () => new Promise(() => undefined)
  });

  const startedAt = Date.now();
  await Promise.race([
    service.deleteUploadedSupportTicketAttachmentBestEffort({
      url: "https://image.example.com/file/support-tickets/stalled.png",
      providerFileId: "support-tickets/stalled.png",
      fileName: "stalled.png",
      mimeType: "image/png",
      fileSizeBytes: 123n
    }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("attachment cleanup waited for stalled image bed delete")), 750);
    })
  ]);

  assert.ok(Date.now() - startedAt < 750, "attachment cleanup must respect its short best-effort budget");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /cleanup exceeded/);
  assert.match(warnings[0], /support-tickets\/stalled\.png/);
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

async function testUpdateUserCredentialChangePublishesAccountEvents() {
  const adminEvents: Array<Record<string, unknown>> = [];
  const clientEvents: Array<{ userId: string; event: Record<string, unknown> }> = [];
  const service = createAdminSubscriptionService({
    ensureUserExists: async () => ({
      id: "user_1",
      role: "user",
      status: "active"
    }),
    prisma: {
      user: {
        update: async () => ({
          id: "user_1",
          email: "user@example.com",
          displayName: "User",
          role: "user",
          status: "active",
          lastSeenAt: new Date("2026-01-01T00:00:00.000Z"),
          maxConcurrentSessionsOverride: null
        })
      }
    },
    authSessionService: {
      revokeAllUserSessions: async () => undefined
    },
    clientRuntimeEventsService: {
      publishToUser: (userId: string, event: Record<string, unknown>) => {
        clientEvents.push({ userId, event });
      }
    },
    adminRuntimeEventsService: {
      publish: (event: Record<string, unknown>) => {
        adminEvents.push(event);
      }
    },
    requireAdminUserRecord: async (userId: string) => ({ id: userId })
  });

  await service.updateUser("user_1", { password: "new-password" });

  assert.equal(adminEvents[0]?.type, "account_updated");
  assert.deepEqual(clientEvents.map((entry) => ({ userId: entry.userId, type: entry.event.type, reasonCode: entry.event.reasonCode })), [
    { userId: "user_1", type: "account_updated", reasonCode: "auth_invalid" }
  ]);
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

async function testListAdminUsersMapsLocalReadFailure() {
  const service = createAdminSubscriptionService({
    prisma: {
      user: {
        findMany: async () => {
          throw new Error("admin user list local read failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.listAdminUsers(),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/admin user list local read failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "admin user list local read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testCreateUserMapsPreflightEmailReadFailure() {
  const service = createAdminSubscriptionService({
    prisma: {
      user: {
        findUnique: async () => {
          throw new Error("create user email preflight read failed");
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.createUser({
        email: "new@example.com",
        password: "password123",
        displayName: "New User",
        role: "user"
      }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/create user email preflight read failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "create-user preflight email read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testCreateSubscriptionMapsPreflightUserReadFailure() {
  const service = createAdminSubscriptionService({
    prisma: {
      user: {
        findUnique: async () => {
          throw new Error("subscription preflight user read failed");
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.createSubscription({
        userId: "user_1",
        planId: "plan_1",
        expireAt: new Date(Date.now() + 86_400_000).toISOString()
      }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/subscription preflight user read failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "subscription preflight user read failures must return a controlled 503 instead of HTTP 500"
  );
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

async function testRefreshTokenRotationUsesExtendedTransactionTimeout() {
  const transactionCalls: Array<Record<string, any> | undefined> = [];
  const user = {
    id: "user_1",
    email: "user@example.com",
    displayName: "User",
    role: "user" as const,
    status: "active" as const,
    lastSeenAt: new Date(),
    authVersion: 1
  };
  const service = createAuthSessionService({
    jwtSecret: "test-secret-for-auth-session-regression",
    jwtIssuer: "chordv-test",
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 86_400,
    prisma: {
      refreshToken: {
        findUnique: async () => ({
          id: "refresh_1",
          userId: "user_1",
          revokedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
          user
        })
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>, options?: Record<string, any>) => {
        void task;
        transactionCalls.push(options);
        throw new Error("transaction stopped after options capture");
      }
    }
  });

  await assert.rejects(
    () => service.rotateRefreshToken("refresh-token"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/transaction stopped after options capture/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "refresh token rotation transaction failures must return a controlled 503 instead of HTTP 500"
  );

  assert.equal(transactionCalls.length, 1);
  assert.equal(transactionCalls[0]?.timeout, 15_000, "refresh rotation must not rely on Prisma's 5s default transaction timeout");
}

async function testIssueSessionMapsUserReadFailure() {
  const service = createAuthSessionService({
    prisma: {
      user: {
        findUnique: async () => {
          throw new Error("issue session user read failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.issueSession("user_1"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/issue session user read failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "issueSession user read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testIssueSessionMapsRefreshTokenSaveFailure() {
  const service = createAuthSessionService({
    jwtSecret: "test-secret-for-auth-session-regression",
    jwtIssuer: "chordv-test",
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 86_400,
    prisma: {
      user: {
        findUnique: async () => ({
          id: "user_1",
          email: "user@example.com",
          displayName: "User",
          role: "user",
          status: "active",
          lastSeenAt: new Date(),
          authVersion: 1
        })
      },
      refreshToken: {
        create: async () => {
          throw new Error("refresh token create failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.issueSession("user_1"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/refresh token create failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "issueSession refresh token write failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testRefreshTokenRotationMapsReadFailure() {
  const service = createAuthSessionService({
    prisma: {
      refreshToken: {
        findUnique: async () => {
          throw new Error("refresh token lookup failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.rotateRefreshToken("refresh-token"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/refresh token lookup failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "refresh token lookup failures must return a controlled 503 instead of HTTP 500"
  );
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

async function testAccessTokenLogoutMapsRefreshTokenSaveFailure() {
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
  const service = createAuthSessionService({
    jwtSecret: secret,
    jwtIssuer: issuer,
    prisma: {
      refreshToken: {
        updateMany: async () => {
          throw new Error("access token revoke failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.revokeByAccessToken(`Bearer ${accessToken}`),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/access token revoke failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "access-token session revoke failures must return a controlled 503 instead of HTTP 500"
  );
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
    /登录状态已过期/,
    "revoked refresh session must invalidate its already-issued access token"
  );
}

async function testAccessTokenAuthenticationMapsUserReadFailure() {
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
  const service = createAuthSessionService({
    jwtSecret: secret,
    jwtIssuer: issuer,
    prisma: {
      user: {
        findUnique: async () => {
          throw new Error("access token user read failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.authenticateAccessToken(`Bearer ${accessToken}`),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/access token user read failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "access-token user read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testAccessTokenAuthenticationMapsSessionReadFailure() {
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
  const service = createAuthSessionService({
    jwtSecret: secret,
    jwtIssuer: issuer,
    prisma: {
      user: {
        findUnique: async () => ({
          id: "user_1",
          email: "user@example.com",
          displayName: "User",
          role: "user",
          status: "active",
          lastSeenAt: new Date(),
          authVersion: 3
        })
      },
      refreshToken: {
        findUnique: async () => {
          throw new Error("access token session read failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.authenticateAccessToken(`Bearer ${accessToken}`),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/access token session read failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "access-token bound session read failures must return a controlled 503 instead of HTTP 500"
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
  await waitUntil(() => received.length >= 7);
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

async function testRuntimeEventReplayValidatesBeforeDispatch() {
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
    type: "subscription_updated",
    occurredAt: new Date().toISOString(),
    subscriptionId: "sub_1",
    state: "active"
  });

  const received: Array<{ id?: string; data: string }> = [];
  const errors: Error[] = [];
  const subscription = service.streamForUser("user_1", {
    lastEventId: "missing",
    validate: () => {
      throw new Error("session revoked");
    }
  }).subscribe({
    next: (event) => {
      received.push(event as { id?: string; data: string });
    },
    error: (error) => {
      errors.push(error);
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  subscription.unsubscribe();

  assert.equal(received.length, 0, "revoked SSE sessions must not receive replay events");
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
  await waitUntil(() => receivedTypes.length >= 7);
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

function testAdminRuntimeEventStreamOpensWithAnnouncementAndPolicyRefreshEvents() {
  const service = createAdminRuntimeEventsService({
    subscribers: new Set(),
    replayEvents: [],
    eventSequence: 0,
    prisma: {
      $executeRaw: async () => undefined
    }
  });
  const receivedTypes: string[] = [];
  const subscription = service.stream().subscribe((event) => {
    receivedTypes.push(JSON.parse((event as { data: string }).data).type);
  });
  subscription.unsubscribe();

  assert.ok(receivedTypes.includes("node_access_updated"), "admin SSE open must trigger node access refresh");
  assert.ok(receivedTypes.includes("announcement_updated"), "admin SSE open must trigger announcement refresh");
  assert.ok(receivedTypes.includes("policy_updated"), "admin SSE open must trigger policy refresh");
}

function testAdminRuntimeEventStreamReplaysAfterLastEventId() {
  const service = createAdminRuntimeEventsService({
    subscribers: new Set(),
    replayEvents: [],
    eventSequence: 0,
    prisma: {
      $executeRaw: async () => undefined
    }
  });
  service.publish({
    type: "version_updated",
    occurredAt: new Date().toISOString(),
    latestVersion: "1.1.3"
  });
  service.publish({
    type: "subscription_updated",
    occurredAt: new Date().toISOString(),
    subscriptionId: "sub_1",
    state: "active"
  });

  const replayStore = (service as any).replayEvents as Array<{ id: string; data: string }>;
  const received: Array<{ id?: string; data: string }> = [];
  const subscription = service.stream({ lastEventId: replayStore[0].id }).subscribe((event) => {
    received.push(event as { id?: string; data: string });
  });
  subscription.unsubscribe();

  assert.equal(received[0].id, replayStore[1].id, "admin stream reconnect must replay events after Last-Event-ID");
  assert.equal(JSON.parse(received[0].data).type, "subscription_updated");
}

async function testAdminRuntimeEventReplayValidatesBeforeDispatch() {
  const service = createAdminRuntimeEventsService({
    subscribers: new Set(),
    replayEvents: [],
    eventSequence: 0,
    prisma: {
      $executeRaw: async () => undefined
    }
  });
  service.publish({
    type: "version_updated",
    occurredAt: new Date().toISOString(),
    latestVersion: "1.1.3"
  });

  const received: Array<{ id?: string; data: string }> = [];
  const errors: Error[] = [];
  const subscription = service.stream({
    lastEventId: "missing",
    validate: () => {
      throw new Error("admin session revoked");
    }
  }).subscribe({
    next: (event) => {
      received.push(event as { id?: string; data: string });
    },
    error: (error) => {
      errors.push(error);
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  subscription.unsubscribe();

  assert.equal(received.length, 0, "revoked admin SSE sessions must not receive replay events");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /admin session revoked/);
}

async function testAdminRuntimeEventStreamPreservesOrderWithAsyncValidation() {
  const service = createAdminRuntimeEventsService({
    subscribers: new Set(),
    replayEvents: [],
    eventSequence: 0,
    prisma: {
      $executeRaw: async () => undefined
    }
  });
  let validateCount = 0;
  const receivedTypes: string[] = [];
  const subscription = service.stream({
    validate: async () => {
      validateCount += 1;
      if (validateCount === 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }).subscribe((event) => {
    receivedTypes.push(JSON.parse((event as { data: string }).data).type);
  });
  await waitUntil(() => receivedTypes.length >= 7);
  receivedTypes.length = 0;

  service.publish({
    type: "version_updated",
    occurredAt: new Date().toISOString(),
    latestVersion: "1.1.3"
  });
  service.publish({
    type: "subscription_updated",
    occurredAt: new Date().toISOString(),
    subscriptionId: "sub_1",
    state: "active"
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  subscription.unsubscribe();

  assert.deepEqual(receivedTypes, ["version_updated", "subscription_updated"], "admin async SSE validation must not reorder business events");
}

function testReleaseArtifactPathTraversalIsRejected() {
  assert.throws(
    () => resolveReleaseArtifactAbsolutePath("../secret.bin"),
    /存储目录/,
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

function testReleaseArtifactClientUsableRejectsWindowsInstallerDownloads() {
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
          fileSizeBytes: null,
          fileHash: null,
          isPrimary: true,
          isFullPackage: false,
          createdAt: new Date(),
          updatedAt: new Date()
        },
        "windows"
      ),
    /zip|external|支持/i,
    "Windows client-visible update artifacts must match the ZIP full-replacement updater"
  );
}

async function testExternalReleaseMetadataRejectsPrivateNetworkUrl() {
  await assert.rejects(
    () => fetchExternalReleaseArtifactMetadata("http://127.0.0.1:9/ChordV-full.zip"),
    /内网|保留地址/,
    "server-side release artifact probes must not access private network URLs"
  );
}

async function testExternalReleaseMetadataRejectsStalledResponse() {
  const previousAllowPrivate = process.env.CHORDV_ALLOW_PRIVATE_REMOTE_URLS;
  const previousTimeout = process.env.CHORDV_RELEASE_EXTERNAL_METADATA_TIMEOUT_MS;
  process.env.CHORDV_ALLOW_PRIVATE_REMOTE_URLS = "true";
  process.env.CHORDV_RELEASE_EXTERNAL_METADATA_TIMEOUT_MS = "25";
  const server = createServer((_request, _response) => {
    // Leave the response open to verify the application-level abort budget.
  });
  await listenOnFetchSafeLocalhost(server);
  const address = server.address();
  assert.equal(typeof address, "object");
  const port = address && typeof address === "object" ? address.port : 0;

  try {
    await assert.rejects(
      () => fetchExternalReleaseArtifactMetadata(`http://127.0.0.1:${port}/ChordV-full.zip`),
      /超时/,
      "external release metadata probes must fail on the app timeout instead of waiting for a stalled server"
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousAllowPrivate === undefined) {
      delete process.env.CHORDV_ALLOW_PRIVATE_REMOTE_URLS;
    } else {
      process.env.CHORDV_ALLOW_PRIVATE_REMOTE_URLS = previousAllowPrivate;
    }
    if (previousTimeout === undefined) {
      delete process.env.CHORDV_RELEASE_EXTERNAL_METADATA_TIMEOUT_MS;
    } else {
      process.env.CHORDV_RELEASE_EXTERNAL_METADATA_TIMEOUT_MS = previousTimeout;
    }
  }
}

async function testExternalReleaseMetadataMapsHttp500ToBadRequest() {
  const server = createServer((_request, response) => {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("upstream failed");
  });
  await listenOnFetchSafeLocalhost(server);
  const address = server.address();
  assert.equal(typeof address, "object");
  const port = address && typeof address === "object" ? address.port : 0;

  try {
    await withPrivateRemoteUrlsAllowed(() =>
      assert.rejects(
        () => fetchExternalReleaseArtifactMetadata(`http://127.0.0.1:${port}/ChordV-full.zip`),
        (error: unknown) => error instanceof BadRequestException && /HTTP 500/.test(error.message),
        "external release metadata HTTP 500 must return a controlled BadRequestException"
      )
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testExternalReleaseDownloadRejectsStalledBody() {
  const previousAllowPrivate = process.env.CHORDV_ALLOW_PRIVATE_REMOTE_URLS;
  const previousTotalTimeout = process.env.CHORDV_RELEASE_EXTERNAL_DOWNLOAD_TIMEOUT_MS;
  const previousIdleTimeout = process.env.CHORDV_RELEASE_EXTERNAL_DOWNLOAD_IDLE_TIMEOUT_MS;
  process.env.CHORDV_ALLOW_PRIVATE_REMOTE_URLS = "true";
  process.env.CHORDV_RELEASE_EXTERNAL_DOWNLOAD_TIMEOUT_MS = "5000";
  process.env.CHORDV_RELEASE_EXTERNAL_DOWNLOAD_IDLE_TIMEOUT_MS = "25";
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/zip",
      "content-length": "1024"
    });
    response.write(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });
  await listenOnFetchSafeLocalhost(server);
  const address = server.address();
  assert.equal(typeof address, "object");
  const port = address && typeof address === "object" ? address.port : 0;

  try {
    await assert.rejects(
      () => downloadExternalReleaseArtifactFileStrict(`http://127.0.0.1:${port}/ChordV-full.zip`),
      /没有返回数据/,
      "external release full ZIP downloads must fail on idle body timeout instead of waiting for total timeout"
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousAllowPrivate === undefined) {
      delete process.env.CHORDV_ALLOW_PRIVATE_REMOTE_URLS;
    } else {
      process.env.CHORDV_ALLOW_PRIVATE_REMOTE_URLS = previousAllowPrivate;
    }
    if (previousTotalTimeout === undefined) {
      delete process.env.CHORDV_RELEASE_EXTERNAL_DOWNLOAD_TIMEOUT_MS;
    } else {
      process.env.CHORDV_RELEASE_EXTERNAL_DOWNLOAD_TIMEOUT_MS = previousTotalTimeout;
    }
    if (previousIdleTimeout === undefined) {
      delete process.env.CHORDV_RELEASE_EXTERNAL_DOWNLOAD_IDLE_TIMEOUT_MS;
    } else {
      process.env.CHORDV_RELEASE_EXTERNAL_DOWNLOAD_IDLE_TIMEOUT_MS = previousIdleTimeout;
    }
  }
}

async function testExternalReleaseDownloadMapsHttp500ToBadRequest() {
  const server = createServer((_request, response) => {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("upstream failed");
  });
  await listenOnFetchSafeLocalhost(server);
  const address = server.address();
  assert.equal(typeof address, "object");
  const port = address && typeof address === "object" ? address.port : 0;

  try {
    await withPrivateRemoteUrlsAllowed(() =>
      assert.rejects(
        () => downloadExternalReleaseArtifactFileStrict(`http://127.0.0.1:${port}/ChordV-full.zip`),
        (error: unknown) => error instanceof BadRequestException && /HTTP 500/.test(error.message),
        "external release ZIP download HTTP 500 must return a controlled BadRequestException"
      )
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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

async function testReleaseDownloadAllowsUploadedArtifactWithStaleMetadata() {
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

    const descriptor = await service.getReleaseArtifactDownloadDescriptor("artifact_1");
    assert.equal(descriptor.absolutePath, absolutePath);
    assert.equal(descriptor.fileName, "ChordV.zip");
  } finally {
    if (previousReleaseStorageRoot === undefined) {
      delete process.env.CHORDV_RELEASE_STORAGE_ROOT;
    } else {
      process.env.CHORDV_RELEASE_STORAGE_ROOT = previousReleaseStorageRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testReleaseDownloadMissingUploadedFileReturnsNotFound() {
  const previousReleaseStorageRoot = process.env.CHORDV_RELEASE_STORAGE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), "chordv-release-missing-download-"));
  const storedFilePath = path.join("release_1", "artifact_1", "missing.zip");
  process.env.CHORDV_RELEASE_STORAGE_ROOT = tempDir;
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
      NotFoundException,
      "missing uploaded release artifacts must return a controlled 404 instead of leaking filesystem errors"
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

async function testReleaseDownloadUnreadableUploadedFileReturnsServiceUnavailable() {
  const originalAccess = fsForPatch.access;
  const previousReleaseStorageRoot = process.env.CHORDV_RELEASE_STORAGE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), "chordv-release-unreadable-download-"));
  const storedFilePath = path.join("release_1", "artifact_1", "unreadable.zip");
  process.env.CHORDV_RELEASE_STORAGE_ROOT = tempDir;
  (fsForPatch as any).access = async () => {
    throw Object.assign(new Error("permission denied"), { code: "EACCES" });
  };
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
      ServiceUnavailableException,
      "unreadable uploaded release artifacts must return a controlled 503 instead of pretending the file is missing"
    );
  } finally {
    (fsForPatch as any).access = originalAccess;
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
      /元数据/,
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

async function testRuntimeDownloadMissingUploadedFileReturnsNotFound() {
  const previousReleaseStorageRoot = process.env.CHORDV_RELEASE_STORAGE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), "chordv-runtime-missing-download-"));
  const storedFilePath = path.join("component_1", "missing-xray.exe");
  process.env.CHORDV_RELEASE_STORAGE_ROOT = tempDir;
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
      NotFoundException,
      "missing uploaded runtime components must return a controlled 404 instead of leaking filesystem errors"
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

async function testRuntimeDownloadUnreadableUploadedFileReturnsServiceUnavailable() {
  const originalAccess = fsForPatch.access;
  const previousReleaseStorageRoot = process.env.CHORDV_RELEASE_STORAGE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), "chordv-runtime-unreadable-download-"));
  const storedFilePath = path.join("component_1", "unreadable-xray.exe");
  process.env.CHORDV_RELEASE_STORAGE_ROOT = tempDir;
  (fsForPatch as any).access = async () => {
    throw Object.assign(new Error("permission denied"), { code: "EACCES" });
  };
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
      ServiceUnavailableException,
      "unreadable uploaded runtime components must return a controlled 503 instead of pretending the file is missing"
    );
  } finally {
    (fsForPatch as any).access = originalAccess;
    if (previousReleaseStorageRoot === undefined) {
      delete process.env.CHORDV_RELEASE_STORAGE_ROOT;
    } else {
      process.env.CHORDV_RELEASE_STORAGE_ROOT = previousReleaseStorageRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testRuntimeDownloadStatFailureReturnsServiceUnavailable() {
  const originalStat = fsForPatch.stat;
  const previousReleaseStorageRoot = process.env.CHORDV_RELEASE_STORAGE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), "chordv-runtime-stat-download-"));
  const storedFilePath = path.join("component_1", "stat-failure-xray.exe");
  process.env.CHORDV_RELEASE_STORAGE_ROOT = tempDir;
  const absolutePath = path.resolve(tempDir, "runtime-components", storedFilePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, "runtime");
  (fsForPatch as any).stat = async () => {
    throw Object.assign(new Error("stat permission denied"), { code: "EACCES" });
  };
  try {
    const service = createRuntimeComponentsService({
      prisma: {
        runtimeComponent: {
          findUnique: async () => ({
            source: "uploaded",
            storedFilePath,
            enabled: true,
            fileName: "xray.exe",
            fileSizeBytes: 7n,
            fileHash: "a".repeat(64),
            expectedHash: "a".repeat(64)
          })
        }
      }
    });

    await assert.rejects(
      () => service.getRuntimeComponentDownloadDescriptor("component_1"),
      (error) =>
        error instanceof ServiceUnavailableException &&
        !/stat permission denied/i.test(error.message) &&
        !/HTTP 500/i.test(error.message),
      "runtime download stat failures must return a controlled 503 instead of leaking filesystem errors"
    );
  } finally {
    (fsForPatch as any).stat = originalStat;
    if (previousReleaseStorageRoot === undefined) {
      delete process.env.CHORDV_RELEASE_STORAGE_ROOT;
    } else {
      process.env.CHORDV_RELEASE_STORAGE_ROOT = previousReleaseStorageRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testReleaseDownloadMapsSendFileMissingToNotFound() {
  const controller = new DownloadsController(
    {
      getReleaseArtifactDownloadDescriptor: async () => ({
        absolutePath: path.join(tmpdir(), "missing-release-artifact.zip"),
        fileName: "missing-release-artifact.zip"
      })
    } as any,
    {} as any
  );
  const response = {
    headersSent: false,
    download: (_absolutePath: string, _fileName: string, callback: (error?: Error & { code?: string }) => void) => {
      callback(Object.assign(new Error("missing file"), { code: "ENOENT" }));
    }
  };

  await assert.rejects(
    () => controller.downloadReleaseArtifact("artifact_1", response as any),
    NotFoundException,
    "release download send-file ENOENT races must return a controlled 404 instead of Express default handling"
  );
}

function testReleaseArtifactClientUsableRejectsHttpFullReplacementUrl() {
  assert.throws(
    () =>
      assertReleaseArtifactClientUsable(
        {
          id: "artifact_1",
          releaseId: "release_1",
          source: "external",
          type: "zip",
          deliveryMode: "desktop_full_replace",
          downloadUrl: "http://download.example.com/ChordV_1.1.6_x64-full.zip",
          originDownloadUrl: null,
          defaultMirrorPrefix: null,
          allowClientMirror: false,
          fileName: "ChordV_1.1.6_x64-full.zip",
          fileSizeBytes: 104857600n,
          fileHash: "a".repeat(64),
          isPrimary: true,
          isFullPackage: true,
          createdAt: new Date(),
          updatedAt: new Date()
        },
        "windows"
      ),
    /HTTPS/
  );
}

function testReleaseArtifactClientUsableAllowsMissingFileHash() {
  assert.doesNotThrow(() =>
    assertReleaseArtifactClientUsable(
      {
        id: "artifact_1",
        releaseId: "release_1",
        source: "external",
        type: "zip",
        deliveryMode: "desktop_full_replace",
        downloadUrl: "https://download.example.com/ChordV_1.1.6_x64-full.zip",
        originDownloadUrl: null,
        defaultMirrorPrefix: null,
        allowClientMirror: false,
        fileName: "ChordV_1.1.6_x64-full.zip",
        fileSizeBytes: 104857600n,
        fileHash: null,
        isPrimary: true,
        isFullPackage: true,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      "windows"
    )
  );
}

async function testRuntimeDownloadMapsSendFileFailureToServiceUnavailable() {
  const controller = new DownloadsController(
    {} as any,
    {
      getRuntimeComponentDownloadDescriptor: async () => ({
        absolutePath: path.join(tmpdir(), "runtime-component-denied.bin"),
        fileName: "runtime-component-denied.bin"
      })
    } as any
  );
  const response = {
    headersSent: false,
    download: (_absolutePath: string, _fileName: string, callback: (error?: Error & { code?: string }) => void) => {
      callback(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    }
  };

  await assert.rejects(
    () => controller.downloadRuntimeComponent("component_1", response as any),
    ServiceUnavailableException,
    "runtime component send-file failures must return a controlled 503 instead of Express default handling"
  );
}

async function testRuntimeDownloadIgnoresSendFileFailureAfterHeadersSent() {
  const controller = new DownloadsController(
    {} as any,
    {
      getRuntimeComponentDownloadDescriptor: async () => ({
        absolutePath: path.join(tmpdir(), "runtime-component-interrupted.bin"),
        fileName: "runtime-component-interrupted.bin"
      })
    } as any
  );
  const response = {
    headersSent: true,
    download: (_absolutePath: string, _fileName: string, callback: (error?: Error & { code?: string }) => void) => {
      callback(Object.assign(new Error("client aborted"), { code: "ECONNRESET" }));
    }
  };

  await assert.doesNotReject(
    () => controller.downloadRuntimeComponent("component_1", response as any),
    "download errors after headers are sent must not attempt a second error response"
  );
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

async function testCreateReleaseFallsBackToVersionWhenDisplayTitleIsBlank() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const createdPayloads: Array<Record<string, any>> = [];
  const service = createReleaseCenterService({
    prisma: {
      release: {
        create: async (payload: Record<string, any>) => {
          createdPayloads.push(payload);
          return {
            ...payload.data,
            createdAt: now,
            updatedAt: now,
            artifacts: []
          };
        }
      }
    }
  });

  const result = await service.createRelease({
    platform: "windows",
    channel: "stable",
    version: "1.1.6",
    displayTitle: "   ",
    changelog: [],
    minimumVersion: "1.1.0",
    forceUpgrade: false,
    status: "draft"
  });

  assert.equal(createdPayloads.length, 1);
  assert.equal(createdPayloads[0].data.displayTitle, "1.1.6");
  assert.equal(result.displayTitle, "1.1.6");
}

async function testCreateReleaseDefaultsMissingMinimumVersionToVersion() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const createdPayloads: Array<Record<string, any>> = [];
  const service = createReleaseCenterService({
    prisma: {
      release: {
        create: async (payload: Record<string, any>) => {
          createdPayloads.push(payload);
          return {
            ...payload.data,
            createdAt: now,
            updatedAt: now,
            artifacts: []
          };
        }
      }
    }
  });

  const result = await service.createRelease({
    platform: "windows",
    channel: "stable",
    version: "1.1.6"
  });

  assert.equal(createdPayloads.length, 1);
  assert.equal(createdPayloads[0].data.minimumVersion, "1.1.6");
  assert.equal(result.minimumVersion, "1.1.6");
}

async function testReleaseDraftMutationsPublishAdminRefreshEvent() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const adminEvents: string[] = [];
  const service = createReleaseCenterService({
    adminRuntimeEventsService: {
      publishReleaseCenterUpdated: () => {
        adminEvents.push("release_center_updated");
      }
    },
    prisma: {
      release: {
        create: async (payload: Record<string, any>) => ({
          ...payload.data,
          createdAt: now,
          updatedAt: now,
          artifacts: []
        }),
        findUnique: async () => ({
          id: "release_1",
          platform: "windows",
          channel: "stable",
          version: "1.1.6",
          displayTitle: "ChordV 1.1.6",
          changelog: [],
          minimumVersion: "1.1.0",
          forceUpgrade: false,
          status: "draft",
          publishedAt: null,
          createdAt: now,
          updatedAt: now,
          artifacts: []
        }),
        update: async (payload: Record<string, any>) => ({
          id: "release_1",
          platform: "windows",
          channel: "stable",
          version: "1.1.6",
          displayTitle: payload.data.displayTitle ?? "ChordV 1.1.6",
          changelog: payload.data.changelog ?? [],
          minimumVersion: payload.data.minimumVersion ?? "1.1.0",
          forceUpgrade: payload.data.forceUpgrade ?? false,
          status: "draft",
          publishedAt: null,
          createdAt: now,
          updatedAt: now,
          artifacts: []
        })
      }
    }
  });

  await service.createRelease({
    platform: "windows",
    channel: "stable",
    version: "1.1.7"
  });
  await service.updateRelease("release_1", {
    displayTitle: "ChordV 1.1.6 revised"
  });

  assert.deepEqual(adminEvents, ["release_center_updated", "release_center_updated"]);
}

async function testUpdateReleaseFallsBackToVersionWhenDisplayTitleIsBlank() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const updates: Array<Record<string, any>> = [];
  const service = createReleaseCenterService({
    prisma: {
      release: {
        findUnique: async () => ({
          id: "release_1",
          platform: "windows",
          channel: "stable",
          version: "1.1.6",
          displayTitle: "ChordV 1.1.6",
          changelog: [],
          minimumVersion: "1.1.0",
          forceUpgrade: false,
          status: "draft",
          publishedAt: null,
          createdAt: now,
          updatedAt: now,
          artifacts: []
        }),
        update: async (payload: Record<string, any>) => {
          updates.push(payload);
          return {
            id: "release_1",
            platform: "windows",
            channel: "stable",
            version: "1.1.6",
            displayTitle: payload.data.displayTitle,
            changelog: [],
            minimumVersion: "1.1.0",
            forceUpgrade: false,
            status: "draft",
            publishedAt: null,
            createdAt: now,
            updatedAt: now,
            artifacts: []
          };
        }
      }
    }
  });

  const result = await service.updateRelease("release_1", {
    displayTitle: "   "
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.displayTitle, "1.1.6");
  assert.equal(result.displayTitle, "1.1.6");
}

async function testCreateReleaseRejectsPublishedStatusWithoutArtifactFlow() {
  const service = createReleaseCenterService({
    prisma: {
      release: {
        create: async () => {
          throw new Error("published release create should be rejected before DB write");
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.createRelease({
        platform: "windows",
        channel: "stable",
        version: "1.1.6",
        displayTitle: "ChordV 1.1.6",
        changelog: [],
        minimumVersion: "1.1.0",
        forceUpgrade: false,
        status: "published"
      }),
    (error: unknown) => error instanceof BadRequestException,
    "release center should force drafts before publishing"
  );
}

async function testCreateReleaseWithInitialArtifactUsesSingleTransaction() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const calls: string[] = [];
  const service = createReleaseCenterService({
    prisma: {
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) => {
        calls.push("transaction");
        return task({
          release: {
            create: async (payload: Record<string, any>) => {
              calls.push("release.create");
              return {
                ...payload.data,
                createdAt: now,
                updatedAt: now,
                artifacts: []
              };
            }
          },
          releaseArtifact: {
            create: async (payload: Record<string, any>) => {
              calls.push("artifact.create");
              return makeReleaseCenterTestArtifact({
                id: payload.data.id,
                releaseId: payload.data.releaseId,
                source: payload.data.source,
                type: payload.data.type,
                deliveryMode: payload.data.deliveryMode,
                downloadUrl: payload.data.downloadUrl,
                defaultMirrorPrefix: payload.data.defaultMirrorPrefix,
                allowClientMirror: payload.data.allowClientMirror,
                fileName: payload.data.fileName,
                fileSizeBytes: payload.data.fileSizeBytes,
                fileHash: payload.data.fileHash,
                isPrimary: payload.data.isPrimary,
                isFullPackage: payload.data.isFullPackage
              });
            }
          }
        });
      },
      release: {
        findUnique: async () => {
          throw new Error("force fallback response to prove transaction result is usable");
        }
      }
    },
    logger: {
      warn: () => undefined
    }
  });

  const result = await service.createRelease({
    platform: "windows",
    channel: "stable",
    version: "1.1.6",
    displayTitle: "ChordV 1.1.6",
    changelog: ["Full replacement"],
    minimumVersion: "1.1.0",
    forceUpgrade: false,
    status: "draft",
    initialArtifact: {
      source: "external",
      type: "zip",
      deliveryMode: "desktop_full_replace",
      downloadUrl: "https://example.com/ChordV_1.1.6_x64-full.zip",
      isPrimary: true
    }
  });

  assert.deepEqual(calls, ["transaction", "release.create", "artifact.create"]);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0]?.isPrimary, true);
  assert.equal(result.artifacts[0]?.fileHash, null);
}

async function testCreateReleaseWithInitialExternalFullReplaceAllowsNonZipUrl() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  let createdArtifactData: Record<string, any> | null = null;
  const service = createReleaseCenterService({
    prisma: {
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          release: {
            create: async (payload: Record<string, any>) => ({
              ...payload.data,
              createdAt: now,
              updatedAt: now,
              artifacts: []
            })
          },
          releaseArtifact: {
            create: async (payload: Record<string, any>) => {
              createdArtifactData = payload.data;
              return makeReleaseCenterTestArtifact({
                id: payload.data.id,
                releaseId: payload.data.releaseId,
                source: payload.data.source,
                type: payload.data.type,
                deliveryMode: payload.data.deliveryMode,
                downloadUrl: payload.data.downloadUrl,
                defaultMirrorPrefix: payload.data.defaultMirrorPrefix,
                allowClientMirror: payload.data.allowClientMirror,
                fileName: payload.data.fileName,
                fileSizeBytes: payload.data.fileSizeBytes,
                fileHash: payload.data.fileHash,
                isPrimary: payload.data.isPrimary,
                isFullPackage: payload.data.isFullPackage
              });
            }
          }
        }),
      release: {
        findUnique: async () => {
          throw new Error("force fallback response to prove transaction result is usable");
        }
      }
    },
    logger: {
      warn: () => undefined
    }
  });

  const result = await service.createRelease({
    platform: "windows",
    channel: "stable",
    version: "1.1.6",
    changelog: ["Full replacement"],
    status: "draft",
    initialArtifact: {
      source: "external",
      type: "zip",
      deliveryMode: "desktop_full_replace",
      downloadUrl: "https://cdn.example.com/download?id=ChordV_1.1.6_x64-full",
      isPrimary: true
    }
  });

  assert.equal(createdArtifactData?.type, "zip");
  assert.equal(createdArtifactData?.deliveryMode, "desktop_full_replace");
  assert.equal(createdArtifactData?.downloadUrl, "https://cdn.example.com/download?id=ChordV_1.1.6_x64-full");
  assert.equal(createdArtifactData?.fileSizeBytes, null);
  assert.equal(createdArtifactData?.fileHash, null);
  assert.equal(result.artifacts[0]?.id, createdArtifactData?.id);
}

async function testCreateReleaseRejectsDuplicateVersionAsConflict() {
  const service = createReleaseCenterService({
    prisma: {
      release: {
        create: async () => {
          throw { code: "P2002" };
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.createRelease({
        platform: "windows",
        channel: "stable",
        version: "1.1.6",
        minimumVersion: "1.1.0"
      }),
    (error) => error instanceof ConflictException,
    "duplicate release versions must return a controlled conflict instead of HTTP 500"
  );
}

async function testCreateReleaseMapsLocalSaveFailure() {
  const service = createReleaseCenterService({
    prisma: {
      release: {
        create: async () => {
          throw new Error("release create local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.createRelease({
        platform: "windows",
        channel: "stable",
        version: "1.1.6",
        minimumVersion: "1.1.0"
      }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/release create local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "release create local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testPublishReleaseKeepsLocalSaveWhenVersionEventFails() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const updates: Array<Record<string, any>> = [];
  const adminEvents: Array<Record<string, any>> = [];
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
    adminRuntimeEventsService: {
      publishVersionUpdated: (event: Record<string, any>) => {
        adminEvents.push(event);
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
  assert.deepEqual(adminEvents, [{ platform: "windows", channel: "stable", latestVersion: null }]);
}

async function testPublishReleaseMapsLocalSaveFailure() {
  const service = createReleaseCenterService({
    assertReleasePublishable: async () => undefined,
    prisma: {
      release: {
        update: async () => {
          throw new Error("release publish local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.publishRelease("release_1"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/release publish local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "release publish local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testUpdateReleaseMapsLocalSaveFailure() {
  const service = createReleaseCenterService({
    prisma: {
      release: {
        findUnique: async () => makeReleaseCenterTestRelease(),
        update: async () => {
          throw new Error("release update local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.updateRelease("release_1", { displayTitle: "ChordV 1.1.7" }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/release update local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "release update local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testUnpublishReleaseClearsPublishedStateAndPublishesVersionEvent() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const updates: Array<Record<string, any>> = [];
  const publishedEvents: Array<{ platform: string; channel: string }> = [];
  const adminEvents: Array<Record<string, any>> = [];
  const service = createReleaseCenterService({
    clientEventsPublisher: {
      publishVersionUpdated: async (platform: string, channel: string) => {
        publishedEvents.push({ platform, channel });
      }
    },
    adminRuntimeEventsService: {
      publishVersionUpdated: (event: Record<string, any>) => {
        adminEvents.push(event);
      }
    },
    prisma: {
      release: {
        findUnique: async () =>
          makeReleaseCenterTestRelease({
            status: "published",
            publishedAt: now
          }),
        update: async (payload: Record<string, any>) => {
          updates.push(payload);
          return makeReleaseCenterTestRelease({
            status: payload.data.status,
            publishedAt: payload.data.publishedAt
          });
        }
      }
    }
  });

  const result = await service.unpublishRelease("release_1");

  assert.equal(updates.length, 1);
  assert.equal(updates[0].where.id, "release_1");
  assert.equal(updates[0].data.status, "draft");
  assert.equal(updates[0].data.publishedAt, null);
  assert.equal(result.status, "draft");
  assert.equal(result.publishedAt, null);
  assert.deepEqual(publishedEvents, [{ platform: "windows", channel: "stable" }]);
  assert.deepEqual(adminEvents, [{ platform: "windows", channel: "stable", latestVersion: null }]);
}

async function testUnpublishReleaseKeepsLocalSaveWhenVersionEventFails() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const warnings: string[] = [];
  const updates: Array<Record<string, any>> = [];
  const adminEvents: Array<Record<string, any>> = [];
  const service = createReleaseCenterService({
    logger: {
      warn: (message: string) => warnings.push(message)
    },
    clientEventsPublisher: {
      publishVersionUpdated: async () => {
        throw new Error("version event failed");
      }
    },
    adminRuntimeEventsService: {
      publishVersionUpdated: (event: Record<string, any>) => {
        adminEvents.push(event);
      }
    },
    prisma: {
      release: {
        findUnique: async () =>
          makeReleaseCenterTestRelease({
            status: "published",
            publishedAt: now
          }),
        update: async (payload: Record<string, any>) => {
          updates.push(payload);
          return makeReleaseCenterTestRelease({
            status: payload.data.status,
            publishedAt: payload.data.publishedAt
          });
        }
      }
    }
  });

  const result = await service.unpublishRelease("release_1");

  assert.equal(updates.length, 1);
  assert.equal(result.status, "draft");
  assert.equal(result.publishedAt, null);
  assert.deepEqual(adminEvents, [{ platform: "windows", channel: "stable", latestVersion: null }]);
  assert.match(warnings[0] ?? "", /version_updated publish failed/);
}

async function testUnpublishReleaseMapsLocalSaveFailure() {
  const service = createReleaseCenterService({
    prisma: {
      release: {
        findUnique: async () =>
          makeReleaseCenterTestRelease({
            status: "published"
          }),
        update: async () => {
          throw new Error("release unpublish local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.unpublishRelease("release_1"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/release unpublish local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "release unpublish local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testUnpublishReleaseRejectsArchivedReleaseBeforeDbWrite() {
  const updates: Array<Record<string, any>> = [];
  const service = createReleaseCenterService({
    prisma: {
      release: {
        findUnique: async () =>
          makeReleaseCenterTestRelease({
            status: "archived"
          }),
        update: async (payload: Record<string, any>) => {
          updates.push(payload);
          return makeReleaseCenterTestRelease(payload.data);
        }
      }
    }
  });

  await assert.rejects(
    () => service.unpublishRelease("release_1"),
    (error) => error instanceof BadRequestException,
    "archived releases must remain read-only when unpublishing"
  );
  assert.equal(updates.length, 0);
}

async function testAssertReleasePublishableAllowsExternalWindowsZipWithoutOptionalMetadata() {
  const primaryArtifact = makeReleaseCenterTestArtifact({
    id: "artifact_primary",
    source: "external",
    type: "zip",
    deliveryMode: "desktop_full_replace",
    isPrimary: true,
    fileName: "ChordV_1.1.6_windows.zip",
    downloadUrl: "https://example.com/ChordV_1.1.6_windows.zip",
    storedFilePath: null,
    fileHash: "a".repeat(64),
    fileSizeBytes: 104857600n,
    allowClientMirror: false
  });
  const secondaryArtifact = makeReleaseCenterTestArtifact({
    id: "artifact_secondary",
    source: "external",
    type: "external",
    deliveryMode: "desktop_installer_download",
    isPrimary: false,
    fileName: "ChordV_1.1.6_x64-setup.exe",
    downloadUrl: "https://example.com/ChordV_1.1.6_x64-setup.exe",
    storedFilePath: null,
    fileHash: null,
    fileSizeBytes: null,
    allowClientMirror: false
  });
  const service = createReleaseCenterService({
    prisma: {
      release: {
        findUnique: async () => ({
          id: "release_1",
          platform: "windows",
          channel: "stable",
          version: "1.1.6",
          minimumVersion: "1.1.0",
          status: "draft",
          artifacts: [primaryArtifact, secondaryArtifact]
        })
      }
    },
    assertReleaseRecordMutable: () => undefined
  });

  await service["assertReleasePublishable"]("release_1");
}

async function testPublishReleaseAllowsWindowsZipWithoutOptionalMetadata() {
  const previousReleaseStorageRoot = process.env.CHORDV_RELEASE_STORAGE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), "release-publish-valid-zip-"));
  const storedFilePath = path.join("release_1", "artifact_1", "ChordV_1.1.6_x64-full.zip");
  process.env.CHORDV_RELEASE_STORAGE_ROOT = tempDir;
  const absolutePath = resolveReleaseArtifactAbsolutePath(storedFilePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, createValidWindowsFullUpdateZip("1.1.6"));
  const release = makeReleaseCenterTestRelease({
    version: "1.1.6",
    artifacts: [
      makeReleaseCenterTestArtifact({
        source: "uploaded",
        type: "zip",
        deliveryMode: "desktop_full_replace",
        fileName: "ChordV_1.1.6_x64-full.zip",
        downloadUrl: "/api/downloads/releases/artifact_1",
        storedFilePath,
        fileSizeBytes: 104857600n,
        fileHash: "a".repeat(64),
        allowClientMirror: false
      })
    ]
  });
  try {
    const service = createReleaseCenterService({
      prisma: {
        release: {
          findUnique: async () => release
        }
      },
      assertReleaseRecordMutable: () => undefined
    });

    await service["assertReleasePublishable"]("release_1");
  } finally {
    if (previousReleaseStorageRoot === undefined) {
      delete process.env.CHORDV_RELEASE_STORAGE_ROOT;
    } else {
      process.env.CHORDV_RELEASE_STORAGE_ROOT = previousReleaseStorageRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testPublishReleaseAllowsReadableUploadedWindowsZipWithoutDeepInspection() {
  const previousReleaseStorageRoot = process.env.CHORDV_RELEASE_STORAGE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), "release-publish-invalid-zip-"));
  const storedFilePath = path.join("release_1", "artifact_1", "ChordV_1.1.6_x64-full.zip");
  process.env.CHORDV_RELEASE_STORAGE_ROOT = tempDir;
  const absolutePath = resolveReleaseArtifactAbsolutePath(storedFilePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, Buffer.from("not a zip"));
  const release = makeReleaseCenterTestRelease({
    version: "1.1.6",
    artifacts: [
      makeReleaseCenterTestArtifact({
        source: "uploaded",
        type: "zip",
        deliveryMode: "desktop_full_replace",
        fileName: "ChordV_1.1.6_x64-full.zip",
        downloadUrl: "/api/downloads/releases/artifact_1",
        storedFilePath,
        fileSizeBytes: 104857600n,
        fileHash: "a".repeat(64),
        allowClientMirror: false
      })
    ]
  });
  try {
    const service = createReleaseCenterService({
      prisma: {
        release: {
          findUnique: async () => release
        }
      },
      assertReleaseRecordMutable: () => undefined
    });

    await service["assertReleasePublishable"]("release_1");
  } finally {
    if (previousReleaseStorageRoot === undefined) {
      delete process.env.CHORDV_RELEASE_STORAGE_ROOT;
    } else {
      process.env.CHORDV_RELEASE_STORAGE_ROOT = previousReleaseStorageRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testPublishReleaseRejectsMissingUploadedArtifactFile() {
  const release = makeReleaseCenterTestRelease({
    artifacts: [
      makeReleaseCenterTestArtifact({
        source: "uploaded",
        type: "zip",
        deliveryMode: "desktop_full_replace",
        fileName: "ChordV_1.1.6_x64-full.zip",
        downloadUrl: "/api/downloads/releases/artifact_1",
        storedFilePath: null,
        fileSizeBytes: 104857600n,
        fileHash: null,
        allowClientMirror: false
      })
    ]
  });
  const service = createReleaseCenterService({
    prisma: {
      release: {
        findUnique: async () => release
      }
    },
    assertReleaseRecordMutable: () => undefined
  });

  await assert.rejects(
    () => service["assertReleasePublishable"]("release_1"),
    (error: unknown) => error instanceof BadRequestException,
    "published uploaded artifacts must still point to a readable local file"
  );
}

async function testPublishReleaseAllowsUsableExternalWhenSecondaryUploadIsMissing() {
  const release = makeReleaseCenterTestRelease({
    artifacts: [
      makeReleaseCenterTestArtifact({
        id: "artifact_external",
        source: "external",
        type: "zip",
        deliveryMode: "desktop_full_replace",
        fileName: "ChordV_1.1.6_x64-full.zip",
        downloadUrl: "https://cdn.example.com/ChordV_1.1.6_x64-full.zip",
        storedFilePath: null,
        fileSizeBytes: 104857600n,
        fileHash: "a".repeat(64),
        allowClientMirror: false,
        isPrimary: true
      }),
      makeReleaseCenterTestArtifact({
        id: "artifact_missing_upload",
        source: "uploaded",
        type: "setup.exe",
        deliveryMode: "desktop_installer_download",
        fileName: "ChordV_1.1.6_setup.exe",
        downloadUrl: "/api/downloads/releases/artifact_missing_upload",
        storedFilePath: null,
        fileSizeBytes: null,
        fileHash: null,
        allowClientMirror: false,
        isPrimary: false
      })
    ]
  });
  const service = createReleaseCenterService({
    prisma: {
      release: {
        findUnique: async () => release
      }
    },
    assertReleaseRecordMutable: () => undefined
  });

  await service["assertReleasePublishable"]("release_1");
}

async function testPublishReleaseAllowsWindowsExternalZipWithoutOptionalMetadata() {
  const release = makeReleaseCenterTestRelease({
    artifacts: [
      makeReleaseCenterTestArtifact({
        source: "external",
        type: "zip",
        deliveryMode: "desktop_full_replace",
        fileName: null,
        downloadUrl: "https://cdn.example.com/ChordV_1.1.6_x64-full.zip",
        defaultMirrorPrefix: null,
        storedFilePath: null,
        fileSizeBytes: 104857600n,
        fileHash: "a".repeat(64),
        allowClientMirror: false
      })
    ]
  });
  const service = createReleaseCenterService({
    prisma: {
      release: {
        findUnique: async () => release
      }
    },
    assertReleaseRecordMutable: () => undefined
  });

  await service["assertReleasePublishable"]("release_1");
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

async function testGetActiveRuntimeRevokesNodeAccessRevokedLease() {
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
          id: "lease_node_access_revoked",
          sessionId: "session_node_access_revoked",
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
          user: { id: "user_1", status: "active" },
          team: null,
          nodeAccesses: []
        })
      }
    }
  });

  const result = await service.getActiveRuntime("session_node_access_revoked");

  assert.equal(result, null, "revoked node access must invalidate cached/runtime leases even when panels are offline");
  assert.deepEqual(revoked, [{ leaseId: "lease_node_access_revoked", reason: "node_access_revoked" }]);
}

async function testGetActiveRuntimeRevokesRemovedTeamMemberLease() {
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
          id: "lease_removed_member",
          sessionId: "session_removed_member",
          userId: "user_1",
          subscriptionId: "sub_team",
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
          id: "sub_team",
          userId: null,
          teamId: "team_1",
          state: "active",
          remainingTrafficGb: 10,
          expireAt: new Date(Date.now() + 86_400_000),
          user: null,
          team: { id: "team_1", status: "active" },
          nodeAccesses: [{ nodeId: "node_1" }]
        })
      },
      teamMember: {
        findUnique: async () => null
      }
    }
  });

  const result = await service.getActiveRuntime("session_removed_member");

  assert.equal(result, null, "removed team members must lose active runtime access from database truth");
  assert.deepEqual(revoked, [{ leaseId: "lease_removed_member", reason: "team_membership_missing" }]);
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

async function testDisconnectRevokesOwnActiveLeaseAndClearsCachedRuntime() {
  const revoked: Array<{ leaseId: string; reason: string }> = [];
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
    resolveActiveUserFromToken: async () => ({ id: "user_a" }),
    revokeLease: async (leaseId: string, _node: unknown, reason: string) => {
      revoked.push({ leaseId, reason });
    },
    prisma: {
      nodeSessionLease: {
        findUnique: async () => ({
          id: "lease_user_a",
          sessionId: "session_user_a",
          userId: "user_a",
          subscriptionId: "sub_a",
          nodeId: "node_a",
          status: "active",
          node: { id: "node_a", flow: "" }
        })
      }
    }
  });

  const result = await service.disconnect("session_user_a", "Bearer token");

  assert.equal(result.previousSessionId, "session_user_a", "disconnect should report the cleared current session");
  assert.deepEqual(revoked, [{ leaseId: "lease_user_a", reason: "revoked_by_client" }]);
  assert.equal(service["activeRuntime"], undefined, "disconnect must clear the current user's cached runtime");
  assert.equal(service.getActiveRuntimeUsageContext(), null, "disconnect must clear cached runtime usage context");
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

async function testLeaseRevocationKeepsLocalStateWhenSecurityEventWriteFails() {
  const updates: Array<Record<string, unknown>> = [];
  const service = createRuntimeSessionService({
    logger: {
      warn: () => undefined
    },
    clientRuntimeEventsService: {
      publishToUser: () => undefined
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
        create: async () => {
          throw new Error("security event database unavailable");
        }
      }
    }
  });

  const count = await service.revokeSubscriptionLeases("sub_1", "node_access_revoked", { nodeIds: ["node_1"] });

  assert.equal(count, 1);
  assert.equal(updates.length, 1, "lease must remain locally revoked when security event write fails");
}

async function testLeaseRevocationContinuesWhenOneLocalRevokeFails() {
  const updates: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  const leases = [
    {
      id: "lease_fail",
      userId: "user_1",
      subscriptionId: "sub_1",
      nodeId: "node_1",
      sessionId: "session_fail",
      status: "active",
      expiresAt: new Date(Date.now() + 60_000),
      node: { id: "node_1", flow: "" }
    },
    {
      id: "lease_ok",
      userId: "user_1",
      subscriptionId: "sub_1",
      nodeId: "node_1",
      sessionId: "session_ok",
      status: "active",
      expiresAt: new Date(Date.now() + 60_000),
      node: { id: "node_1", flow: "" }
    }
  ];
  const service = createRuntimeSessionService({
    logger: {
      warn: (message: string) => warnings.push(message)
    },
    clientRuntimeEventsService: {
      publishToUser: () => undefined
    },
    prisma: {
      nodeSessionLease: {
        findMany: async () => leases,
        findUnique: async (payload: { where: { id: string } }) => leases.find((lease) => lease.id === payload.where.id) ?? null,
        updateMany: async (payload: { where: { id: string } }) => {
          if (payload.where.id === "lease_fail") {
            throw Object.assign(new Error("server closed the connection unexpectedly"), { code: "P2010" });
          }
          updates.push(payload);
          return { count: 1 };
        }
      },
      securityEvent: {
        create: async () => ({})
      }
    }
  });

  const count = await service.revokeSubscriptionLeases("sub_1", "node_access_revoked", { nodeIds: ["node_1"] });

  assert.equal(count, 1, "bulk lease revocation should report successfully revoked leases only");
  assert.deepEqual(
    updates.map((item) => (item.where as { id: string }).id),
    ["lease_ok"],
    "one failed lease must not stop revocation of later leases"
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /lease_fail/);
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

async function testNodeLeaseRevocationJobQueuePublishesSyncQueueEvent() {
  const createdJobs: Array<Record<string, any>> = [];
  const adminEvents: Array<Record<string, unknown>> = [];
  const service = createRuntimeSessionService({
    adminRuntimeEventsService: {
      publish: (event: Record<string, unknown>) => {
        adminEvents.push(event);
      }
    },
    prisma: {
      leaseRevocationJob: {
        updateMany: async () => ({ count: 0 }),
        findFirst: async () => null,
        createMany: async (payload: Record<string, any>) => {
          createdJobs.push(payload);
          return { count: 1 };
        }
      }
    }
  });

  await service.queueLeaseRevocationJobForNode("node_1", "node_disabled");

  assert.equal(createdJobs.length, 1);
  assert.equal(createdJobs[0]?.data?.nodeId, "node_1");
  assert.equal(createdJobs[0]?.data?.subscriptionId, null);
  assert.equal(createdJobs[0]?.data?.reason, "node_disabled");
  assert.equal(adminEvents.length, 1, "node-level lease revocation jobs must refresh admin sync queue subscribers");
  assert.equal(adminEvents[0]?.type, "sync_queue_updated");
  assert.equal(adminEvents[0]?.nodeId, "node_1");
}

async function testLeaseRevocationJobRetriesFailedRevocation() {
  const updates: Array<Record<string, any>> = [];
  const adminEvents: Array<Record<string, unknown>> = [];
  const service = createRuntimeSessionService({
    logger: {
      warn: () => undefined
    },
    adminRuntimeEventsService: {
      publish: (event: Record<string, unknown>) => {
        adminEvents.push(event);
      }
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
  assert.equal(adminEvents.length, 1);
  assert.equal(adminEvents[0].type, "sync_queue_updated");
  assert.equal(adminEvents[0].nodeId, "node_1");
}

async function testLeaseRevocationBatchContinuesAfterStalledJob() {
  const originalTimeout = process.env.CHORDV_LEASE_REVOCATION_JOB_TIMEOUT_MS;
  const originalConcurrency = process.env.CHORDV_LEASE_REVOCATION_JOB_CONCURRENCY;
  process.env.CHORDV_LEASE_REVOCATION_JOB_TIMEOUT_MS = "10";
  process.env.CHORDV_LEASE_REVOCATION_JOB_CONCURRENCY = "2";
  try {
    const updates: Array<Record<string, any>> = [];
    const revokedSubscriptions: string[] = [];
    const jobs = [
      {
        id: "lease_job_stalled",
        attempts: 0,
        subscriptionId: "sub_stalled",
        userId: "user_1",
        nodeId: "node_1",
        reason: "node_access_revoked",
        status: "pending",
        nextRunAt: new Date(Date.now() - 1000),
        lockedAt: null,
        createdAt: new Date(Date.now() - 2000)
      },
      {
        id: "lease_job_online",
        attempts: 0,
        subscriptionId: "sub_online",
        userId: "user_2",
        nodeId: "node_2",
        reason: "node_access_revoked",
        status: "pending",
        nextRunAt: new Date(Date.now() - 1000),
        lockedAt: null,
        createdAt: new Date(Date.now() - 1000)
      }
    ];
    const service = createRuntimeSessionService({
      logger: {
        warn: () => undefined
      },
      revokeSubscriptionLeases: async (subscriptionId: string) => {
        if (subscriptionId === "sub_stalled") {
          return new Promise(() => undefined);
        }
        revokedSubscriptions.push(subscriptionId);
      },
      prisma: {
        leaseRevocationJob: {
          findMany: async () => jobs,
          updateMany: async () => ({ count: 1 }),
          update: async (payload: Record<string, any>) => {
            updates.push(payload);
          }
        }
      }
    });

    await Promise.race([
      service.retryPendingLeaseRevocationJobs(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("lease revocation batch stalled behind one job")), 250);
      })
    ]);

    assert.deepEqual(revokedSubscriptions, ["sub_online"]);
    const statusById = new Map(updates.map((item) => [item.where.id, item.data.status]));
    assert.equal(statusById.get("lease_job_online"), "completed");
    assert.equal(statusById.get("lease_job_stalled"), "failed");
    const stalledUpdate = updates.find((item) => item.where.id === "lease_job_stalled");
    assert.match(stalledUpdate?.data.lastError ?? "", /timed out/);
  } finally {
    if (originalTimeout === undefined) {
      delete process.env.CHORDV_LEASE_REVOCATION_JOB_TIMEOUT_MS;
    } else {
      process.env.CHORDV_LEASE_REVOCATION_JOB_TIMEOUT_MS = originalTimeout;
    }
    if (originalConcurrency === undefined) {
      delete process.env.CHORDV_LEASE_REVOCATION_JOB_CONCURRENCY;
    } else {
      process.env.CHORDV_LEASE_REVOCATION_JOB_CONCURRENCY = originalConcurrency;
    }
  }
}

async function testLeaseRevocationBatchContinuesWhenFailurePersistFails() {
  const originalConcurrency = process.env.CHORDV_LEASE_REVOCATION_JOB_CONCURRENCY;
  process.env.CHORDV_LEASE_REVOCATION_JOB_CONCURRENCY = "1";
  const updates: Array<Record<string, any>> = [];
  const warnings: string[] = [];
  const revokedSubscriptions: string[] = [];
  const jobs = [
    {
      id: "lease_job_fail",
      attempts: 0,
      subscriptionId: "sub_fail",
      userId: "user_1",
      nodeId: "node_1",
      reason: "node_access_revoked",
      status: "pending",
      nextRunAt: new Date(Date.now() - 1000),
      lockedAt: null,
      createdAt: new Date(Date.now() - 2000)
    },
    {
      id: "lease_job_online",
      attempts: 0,
      subscriptionId: "sub_online",
      userId: "user_2",
      nodeId: "node_2",
      reason: "node_access_revoked",
      status: "pending",
      nextRunAt: new Date(Date.now() - 1000),
      lockedAt: null,
      createdAt: new Date(Date.now() - 1000)
    }
  ];
  const service = createRuntimeSessionService({
    logger: {
      warn: (message: string) => {
        warnings.push(message);
      }
    },
    revokeSubscriptionLeases: async (subscriptionId: string) => {
      if (subscriptionId === "sub_fail") {
        throw new Error("lease store unavailable");
      }
      revokedSubscriptions.push(subscriptionId);
    },
    prisma: {
      leaseRevocationJob: {
        findMany: async () => jobs,
        updateMany: async () => ({ count: 1 }),
        update: async (payload: Record<string, any>) => {
          if (payload.where.id === "lease_job_fail" && payload.data.status === "failed") {
            throw new Error("failed state write unavailable");
          }
          updates.push(payload);
          return {};
        }
      }
    }
  });

  try {
    await service.retryPendingLeaseRevocationJobs();
  } finally {
    if (originalConcurrency === undefined) {
      delete process.env.CHORDV_LEASE_REVOCATION_JOB_CONCURRENCY;
    } else {
      process.env.CHORDV_LEASE_REVOCATION_JOB_CONCURRENCY = originalConcurrency;
    }
  }

  assert.deepEqual(revokedSubscriptions, ["sub_online"]);
  assert.ok(warnings.some((message) => /failure state could not be saved/.test(message)));
  assert.ok(
    updates.some((item) => item.where.id === "lease_job_online" && item.data.status === "completed"),
    "online lease job must complete even when the previous failure state cannot be persisted"
  );
}

async function testLeaseRevocationWorkerBatchReturnsWhenInitialReadFails() {
  const warnings: string[] = [];
  const service = createRuntimeSessionService({
    logger: {
      warn: (message: string) => warnings.push(message)
    },
    prisma: {
      leaseRevocationJob: {
        findMany: async () => {
          throw new Error("lease queue read unavailable");
        }
      }
    }
  });

  await service.retryPendingLeaseRevocationJobs();

  assert.ok(warnings.some((message) => /Lease revocation worker batch failed/.test(message)));
  assert.ok(warnings.some((message) => /lease queue read unavailable/.test(message)));
}

async function testLeaseRevocationWorkerBatchContinuesWhenLockFails() {
  const warnings: string[] = [];
  const revokedSubscriptions: string[] = [];
  const service = createRuntimeSessionService({
    logger: {
      warn: (message: string) => warnings.push(message)
    },
    revokeSubscriptionLeases: async (subscriptionId: string) => {
      revokedSubscriptions.push(subscriptionId);
    },
    prisma: {
      leaseRevocationJob: {
        findMany: async () => [
          {
            id: "lease_job_locked_fail",
            attempts: 0,
            subscriptionId: "sub_fail",
            userId: "user_1",
            nodeId: "node_1",
            reason: "node_access_revoked",
            status: "pending",
            nextRunAt: new Date(Date.now() - 1000),
            lockedAt: null,
            createdAt: new Date(Date.now() - 1000)
          },
          {
            id: "lease_job_online",
            attempts: 0,
            subscriptionId: "sub_online",
            userId: "user_2",
            nodeId: "node_2",
            reason: "node_access_revoked",
            status: "pending",
            nextRunAt: new Date(Date.now() - 1000),
            lockedAt: null,
            createdAt: new Date(Date.now() - 1000)
          }
        ],
        updateMany: async (payload: Record<string, any>) => {
          if (payload.where.id === "lease_job_locked_fail") {
            throw new Error("lease queue lock unavailable");
          }
          return { count: 1 };
        },
        update: async () => {
          return {};
        }
      }
    }
  });

  await service.retryPendingLeaseRevocationJobs();

  assert.deepEqual(revokedSubscriptions, ["sub_online"]);
  assert.ok(warnings.some((message) => /could not lock job lease_job_locked_fail/.test(message)));
  assert.ok(warnings.some((message) => /lease queue lock unavailable/.test(message)));
}

async function testRenewSubscriptionReturnsWhenSubscriptionPublishStalls() {
  const updates: Array<Record<string, any>> = [];
  const current = {
    id: "sub_team",
    userId: null,
    teamId: "team_1",
    planId: "plan_1",
    totalTrafficGb: 10,
    usedTrafficGb: 4,
    remainingTrafficGb: 6,
    expireAt: new Date(Date.now() + 86_400_000),
    state: "active",
    renewable: true,
    sourceAction: "created",
    lastSyncedAt: new Date("2026-01-01T00:00:00.000Z"),
    plan: { name: "Team Plan", maxConcurrentSessions: 3 },
    user: null,
    team: { name: "Team" },
    nodeAccesses: []
  };
  let publishLookupStarted = false;
  const service = createAdminSubscriptionService({
    logger: {
      warn: () => undefined
    },
    requireSubscription: async () => current,
    runtimeSessionService: {
      syncActiveLeasesForSubscription: async () => undefined,
      queueDirectSubscriptionAccessSync: async () => 0
    },
    clientRuntimeEventsService: {
      publishToUsers: () => undefined
    },
    prisma: {
      teamMember: {
        findMany: async () => {
          publishLookupStarted = true;
          return new Promise<Array<{ userId: string }>>(() => undefined);
        }
      },
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

  const record = await Promise.race([
    service.renewSubscription("sub_team", { totalTrafficGb: 20 }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("renew subscription waited for stalled subscription_updated publish")), 750);
    })
  ]);

  assert.equal(publishLookupStarted, false, "renewal response must return before subscription_updated publish starts");
  await waitUntil(() => publishLookupStarted);
  assert.equal(publishLookupStarted, true, "subscription_updated publish should still start in background");
  assert.equal(updates.length, 1, "local renewal must save before stalled publish finishes");
  assert.equal(record.totalTrafficGb, 20);
  assert.equal(record.remainingTrafficGb, 16);
}

async function testChangeSubscriptionPlanReturnsWhenSubscriptionPublishStalls() {
  const updates: Array<Record<string, any>> = [];
  const now = new Date("2026-01-01T00:00:00.000Z");
  const current = {
    id: "sub_team",
    userId: null,
    teamId: "team_1",
    planId: "plan_old",
    totalTrafficGb: 100,
    usedTrafficGb: 4,
    remainingTrafficGb: 96,
    expireAt: new Date(Date.now() + 86_400_000),
    state: "active",
    renewable: true,
    sourceAction: "created",
    lastSyncedAt: now,
    plan: { name: "Old Team", maxConcurrentSessions: 3 },
    user: null,
    team: { name: "Team" },
    nodeAccesses: []
  };
  const nextPlan = {
    id: "plan_new",
    name: "New Team",
    scope: "team",
    totalTrafficGb: 200,
    renewable: true,
    maxConcurrentSessions: 5,
    isActive: true
  };
  let publishLookupStarted = false;
  const service = createAdminSubscriptionService({
    logger: {
      warn: () => undefined
    },
    requireSubscription: async () => current,
    ensurePlanExists: async () => nextPlan,
    enforceSubscriptionConcurrentLeaseLimits: async () => ({ ok: true }),
    syncActiveLeasesForSubscriptionBestEffort: async () => ({ ok: true }),
    clientRuntimeEventsService: {
      publishToUsers: () => undefined
    },
    prisma: {
      teamMember: {
        findMany: async () => {
          publishLookupStarted = true;
          return new Promise<Array<{ userId: string }>>(() => undefined);
        }
      },
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
        })
    }
  });

  const result = await Promise.race([
    service.changeSubscriptionPlan("sub_team", { planId: "plan_new" }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("change plan waited for stalled subscription_updated publish")), 750);
    })
  ]);

  assert.equal(publishLookupStarted, false, "change plan response must return before subscription_updated publish starts");
  await waitUntil(() => publishLookupStarted);
  assert.equal(publishLookupStarted, true, "subscription_updated publish should still start in background");
  assert.equal(updates.length, 1, "local plan change must save before stalled publish finishes");
  assert.equal(result.planId, "plan_new");
  assert.equal(result.totalTrafficGb, 200);
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
    /userId 必须是字符串/,
    "reset-traffic must reject non-string userId with 400 instead of throwing TypeError later"
  );
}

async function testResetSubscriptionTrafficMapsTeamMemberReadFailure() {
  const lockedSubscription = {
    id: "sub_team",
    userId: null,
    teamId: "team_1",
    planId: "plan_team",
    totalTrafficGb: 100,
    usedTrafficGb: 40,
    remainingTrafficGb: 60,
    expireAt: new Date(Date.now() + 86_400_000),
    state: "active" as const,
    renewable: true,
    sourceAction: "created" as const,
    lastSyncedAt: new Date(),
    plan: { name: "Team Plan" },
    user: null,
    team: { name: "Team" },
    nodeAccesses: []
  };
  const service = createAdminSubscriptionService({
    requireSubscription: async () => lockedSubscription,
    prisma: {
      teamMember: {
        findFirst: async () => {
          throw new Error("team member reset preflight read failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.resetSubscriptionTraffic("sub_team", { userId: "member_1" }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/team member reset preflight read failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "team-member traffic reset preflight read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testResetSubscriptionTrafficReturnsWhenSubscriptionPublishStalls() {
  const lockedSubscription = {
    id: "sub_team",
    userId: null,
    teamId: "team_1",
    planId: "plan_1",
    totalTrafficGb: 100,
    usedTrafficGb: 0,
    remainingTrafficGb: 100,
    expireAt: new Date(Date.now() + 86_400_000),
    state: "active" as const,
    renewable: true,
    sourceAction: "created" as const,
    lastSyncedAt: new Date(),
    plan: { name: "Team Plan" },
    user: null,
    team: { name: "Team" },
    nodeAccesses: []
  };
  let resetCalled = false;
  let publishLookupStarted = false;
  const service = createAdminSubscriptionService({
    logger: {
      warn: () => undefined
    },
    requireSubscription: async () => lockedSubscription,
    resetSubscriptionTrafficCounters: async () => {
      resetCalled = true;
      return {
        subscription: lockedSubscription,
        targetUserId: null,
        clearedBindingCount: 0,
        panelSync: { ok: true }
      };
    },
    clientRuntimeEventsService: {
      publishToUsers: () => undefined
    },
    prisma: {
      teamMember: {
        findMany: async () => {
          publishLookupStarted = true;
          return new Promise<Array<{ userId: string }>>(() => undefined);
        }
      }
    }
  });

  const result = await Promise.race([
    service.resetSubscriptionTraffic("sub_team"),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("reset traffic waited for stalled subscription_updated publish")), 750);
    })
  ]);

  assert.equal(resetCalled, true, "local traffic reset must complete before stalled publish finishes");
  assert.equal(publishLookupStarted, false, "traffic reset response must return before subscription_updated publish starts");
  await waitUntil(() => publishLookupStarted);
  assert.equal(publishLookupStarted, true, "subscription_updated publish should still start in background");
  assert.equal(result.ok, true);
  assert.equal(result.subscriptionId, "sub_team");
  assert.equal(result.subscription.usedTrafficGb, 0);
}

async function testListAdminNodesMapsLocalReadFailure() {
  const service = createAdminNodeService({
    prisma: {
      node: {
        findMany: async () => {
          throw new Error("node list local read failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.listAdminNodes(),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/node list local read failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "node list local read failures must return a controlled 503 instead of HTTP 500"
  );
}

// The direct track's provisioning commands live in NodeCommandJob, so the
// admin queue must carry their binding target (subscription/user) — otherwise
// a pending ENSURE_USER cannot be shown for the subscription it belongs to.
async function testListNodeCommandJobsReadsBindingTargets() {
  const service = createAdminNodeService({
    logger: {
      warn: () => undefined
    },
    prisma: {
      nodeCommandJob: {
        findMany: async () => [
          {
            id: "cmd_user",
            nodeId: "node_1",
            commandType: "ENSURE_USER",
            status: "pending",
            attempts: 0,
            targetRevision: 7n,
            payload: { bindingId: "binding_1", email: "member@example.invalid" },
            subscriptionId: "sub_1",
            userId: "user_1",
            lastError: null,
            nextRunAt: new Date("2026-01-01T00:00:05.000Z"),
            completedAt: null,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            node: { name: "东京" }
          },
          {
            id: "cmd_inbound",
            nodeId: "node_1",
            commandType: "ENSURE_INBOUND",
            status: "running",
            attempts: 1,
            targetRevision: 8n,
            payload: { port: 443 },
            subscriptionId: null,
            userId: null,
            lastError: "deploy failed",
            nextRunAt: new Date("2026-01-01T00:00:10.000Z"),
            completedAt: null,
            createdAt: new Date("2026-01-01T00:00:01.000Z"),
            node: { name: "东京" }
          }
        ]
      }
    }
  });

  const jobs = await service.listNodeCommandJobs();

  assert.deepEqual(jobs[0], {
    id: "cmd_user",
    nodeId: "node_1",
    nodeName: "东京",
    commandType: "ENSURE_USER",
    status: "pending",
    attempts: 0,
    targetRevision: "7",
    subscriptionId: "sub_1",
    userId: "user_1",
    lastError: null,
    nextRunAt: "2026-01-01T00:00:05.000Z",
    completedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  assert.equal(jobs[1]?.subscriptionId, null, "非绑定命令（部署入站）不得伪造订阅归属");
  assert.equal(jobs[1]?.userId, null);
  assert.equal(jobs[1]?.lastError, "deploy failed");
}

// Counts must come from an aggregate over ALL outstanding commands, not from
// the paginated detail list: a node whose 201st command fell off the page
// would otherwise read as synced.
async function testListNodeCommandSummariesAggregatePerTarget() {
  const service = createAdminNodeService({
    logger: {
      warn: () => undefined
    },
    prisma: {
      nodeCommandJob: {
        groupBy: async () => [
          { nodeId: "node_1", subscriptionId: "sub_1", userId: "user_1", teamId: "team_1", status: "pending", _count: { _all: 3 } },
          { nodeId: "node_1", subscriptionId: "sub_1", userId: "user_1", teamId: "team_1", status: "failed", _count: { _all: 1 } },
          { nodeId: "node_2", subscriptionId: null, userId: null, teamId: null, status: "running", _count: { _all: 1 } }
        ],
        findMany: async () => [
          {
            nodeId: "node_1",
            subscriptionId: "sub_1",
            userId: "user_1",
            teamId: "team_1",
            lastError: "agent offline"
          }
        ]
      }
    }
  });

  const summaries = await service.listNodeCommandSummaries();

  assert.deepEqual(summaries.subscriptions, [
    { key: "sub_1", pending: 3, running: 0, failed: 1, total: 4, lastError: "agent offline" }
  ]);
  assert.deepEqual(summaries.users, [
    { key: "user_1", pending: 3, running: 0, failed: 1, total: 4, lastError: "agent offline" }
  ]);
  assert.deepEqual(summaries.teams, [
    { key: "team_1", pending: 3, running: 0, failed: 1, total: 4, lastError: "agent offline" }
  ]);
  assert.deepEqual(summaries.nodes, [
    { key: "node_1", pending: 3, running: 0, failed: 1, total: 4, lastError: "agent offline" },
    { key: "node_2", pending: 0, running: 1, failed: 0, total: 1, lastError: null }
  ]);
}

// Re-enabling a disabled node must queue direct access sync: the disable path
// took the bindings down with DISABLE_USER, and getConfig only serves ACTIVE
// bindings — without a re-provision the node comes back with no users.
async function testReEnableNodeRestoresBindingsViaDirectAccessSync() {
  const calls: string[] = [];
  let savedIsActive: boolean | null = null;
  const baseNode = {
    id: "node_1",
    name: "node",
    countryCode: "US",
    region: "US",
    provider: "test",
    tags: [],
    isActive: false,
    recommended: false,
    latencyMs: 0,
    probeLatencyMs: null,
    protocol: "vless",
    security: "reality",
    registrationStatus: "agent_ready",
    serverName: "www.microsoft.com",
    serverHost: "203.0.113.7",
    serverPort: 443,
    uuid: "11111111-1111-4111-8111-111111111111",
    realityPublicKey: "k".repeat(43),
    fingerprint: "chrome",
    statsLastSyncedAt: null,
    controlMode: "direct_primary",
    controlStatus: "online",
    agentLastSeenAt: null,
    agentConfigRevision: 1n,
    shortId: "abcd1234",
    spiderX: "/",
    inboundAppliedRevision: 1n,
    mldsa65Verify: null,
    probeStatus: "healthy",
    probeCheckedAt: null,
    probeError: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z")
  };
  const service = createAdminNodeService({
    logger: { warn: () => undefined },
    prisma: {
      node: {
        findUnique: async () => ({ ...baseNode }),
        update: async (payload: Record<string, any>) => {
          savedIsActive = payload.data.isActive ?? null;
          return { ...baseNode, ...payload.data };
        }
      }
    },
    runtimeSessionService: {
      syncDirectAccessForNode: async (nodeId: string) => {
        calls.push(`sync:${nodeId}`);
        return 1;
      },
      markPanelBindingsDisabledForNode: async () => {
        calls.push("disable");
        return 1;
      },
      queueLeaseRevocationJobForNode: async () => undefined
    },
    clientEventsPublisher: {
      resolveUserIdsForNodeAccess: async () => [],
      publishNodeAccessUpdatedToUsers: () => undefined
    }
  });

  await service.updateNode("node_1", { isActive: true });

  assert.equal(savedIsActive, true, "节点应被保存为启用");
  assert.deepEqual(calls, ["sync:node_1"], "重新启用必须触发该节点的 direct 供给（恢复绑定）");
}

// The queue endpoint must filter SERVER-SIDE by target: the cached global list
// is capped at 200, so a busy target whose commands fall off that page must
// still be inspectable through its own filtered query.
async function testListNodeCommandJobsAppliesTargetFilter() {
  let receivedWhere: unknown = null;
  const service = createAdminNodeService({
    prisma: {
      nodeCommandJob: {
        findMany: async (payload: Record<string, any>) => {
          receivedWhere = payload.where;
          return [];
        }
      }
    }
  });

  await service.listNodeCommandJobs({ subscriptionId: "sub_1" });
  assert.deepEqual(
    receivedWhere,
    { status: { in: ["pending", "running", "failed", "cancelled"] }, subscriptionId: "sub_1" },
    "订阅过滤必须下推为服务端条件"
  );

  // A team member's view supplies subscriptionId + userId + teamId together
  // and means EXACTLY that member: intersecting (AND) the scopes is the only
  // correct reading — OR would flood the page with other members' commands
  // and could hide this member's failure.
  await service.listNodeCommandJobs({ subscriptionId: "sub_1", userId: "user_1", teamId: "team_1" });
  assert.deepEqual(
    receivedWhere,
    { status: { in: ["pending", "running", "failed", "cancelled"] }, subscriptionId: "sub_1", userId: "user_1", teamId: "team_1" },
    "多目标过滤必须按 AND 交集，不得按 OR 并集"
  );

  await service.listNodeCommandJobs();
  assert.deepEqual(
    receivedWhere,
    { status: { in: ["pending", "running", "failed", "cancelled"] } },
    "无过滤时保持全局查询；cancelled（重试耗尽）必须保留在队列里——它是未解决的失败"
  );
}

// retryDueCommands marks retry-exhausted commands as cancelled without the
// operation ever completing. That is an UNRESOLVED failure: the queue and the
// per-target summaries must keep it visible (counted under failed) or the
// node reads as synced while the user was never provisioned.
async function testRetryExhaustedCommandsStayVisibleAsFailures() {
  const service = createAdminNodeService({
    logger: { warn: () => undefined },
    prisma: {
      nodeCommandJob: {
        findMany: async () => [
          {
            id: "cmd_exhausted",
            nodeId: "node_1",
            commandType: "ENSURE_USER",
            status: "cancelled",
            attempts: 8,
            targetRevision: 7n,
            payload: { bindingId: "binding_1" },
            subscriptionId: "sub_1",
            userId: "user_1",
            lastError: "Agent 命令重试次数已达到上限",
            nextRunAt: new Date("2026-01-01T00:00:05.000Z"),
            completedAt: null,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            node: { name: "东京" }
          }
        ],
        groupBy: async () => [
          { nodeId: "node_1", subscriptionId: "sub_1", userId: "user_1", teamId: null, status: "cancelled", _count: { _all: 1 } }
        ]
      }
    }
  });

  const jobs = await service.listNodeCommandJobs();
  assert.equal(jobs.length, 1, "重试耗尽的命令必须保留在队列明细里");
  assert.equal(jobs[0]?.status, "cancelled");

  const summaries = await service.listNodeCommandSummaries();
  assert.deepEqual(
    summaries.nodes,
    [{ key: "node_1", pending: 0, running: 0, failed: 1, total: 1, lastError: "Agent 命令重试次数已达到上限" }],
    "重试耗尽必须计入 failed——节点不得因此显示已同步"
  );
  assert.deepEqual(
    summaries.subscriptions,
    [{ key: "sub_1", pending: 0, running: 0, failed: 1, total: 1, lastError: "Agent 命令重试次数已达到上限" }],
    "订阅视角的待处理徽章不得因重试耗尽而消失"
  );
}

async function testUpdateNodeMapsLocalReadFailure() {
  const service = createAdminNodeService({
    prisma: {
      node: {
        findUnique: async () => {
          throw new Error("node read failed before update");
        }
      }
    }
  });

  await assert.rejects(
    () => service.updateNode("node_1", { name: "Node" }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/node read failed before update/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "node pre-update read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testRetryLeaseRevocationJobRequeuesWithoutKeepingBackoff() {
  const updates: Array<Record<string, any>> = [];
  const now = new Date("2026-01-01T00:00:00.000Z");
  const service = createAdminNodeService({
    prisma: {
      leaseRevocationJob: {
        updateMany: async (payload: Record<string, any>) => {
          updates.push(payload);
          return { count: 1 };
        },
        findMany: async () => [
          {
            id: "lease_job_1",
            reason: "subscription_exhausted",
            status: "pending",
            subscriptionId: "sub_1",
            userId: "user_1",
            nodeId: "node_1",
            attempts: 0,
            nextRunAt: now,
            lockedAt: null,
            lastError: null,
            completedAt: null,
            createdAt: now,
            updatedAt: now
          }
        ]
      },
      node: {
        findMany: async () => [{ id: "node_1", name: "Node 1" }]
      }
    }
  });

  const result = await service.retryLeaseRevocationJob("lease_job_1");

  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.where.id, "lease_job_1");
  assert.equal(updates[0]?.data.status, "pending");
  assert.equal(updates[0]?.data.lockedAt, null);
  assert.equal(updates[0]?.data.completedAt, null);
  assert.equal(updates[0]?.data.attempts, 0);
  assert.equal(updates[0]?.data.lastError, null);
  assert.deepEqual(result.map((job) => job.id), ["lease_job_1"]);
}

async function testLeaseRevocationQueueFallsBackWhenNodeNameLookupFails() {
  const warnings: string[] = [];
  const now = new Date("2026-01-01T00:00:00.000Z");
  const service = createAdminNodeService({
    logger: {
      warn: (message: string) => warnings.push(message)
    },
    prisma: {
      leaseRevocationJob: {
        findMany: async () => [
          {
            id: "lease_job_1",
            reason: "node_access_revoked",
            status: "failed",
            subscriptionId: "sub_1",
            userId: "user_1",
            nodeId: "node_missing",
            attempts: 2,
            nextRunAt: now,
            lockedAt: null,
            lastError: "panel offline",
            completedAt: null,
            createdAt: now,
            updatedAt: now
          }
        ]
      },
      node: {
        findMany: async () => {
          throw new Error("node name lookup failed");
        }
      }
    }
  });

  const result = await service.listLeaseRevocationJobs();

  assert.deepEqual(result.map((job) => job.id), ["lease_job_1"]);
  assert.equal(result[0]?.nodeId, "node_missing");
  assert.equal(result[0]?.nodeName, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /without node names/);
}

async function testLeaseRevocationRetryPublishesSyncQueueEvent() {
  const events: Array<Record<string, unknown>> = [];
  const now = new Date("2026-01-01T00:00:00.000Z");
  const service = createAdminNodeService({
    adminRuntimeEventsService: {
      publish: (event: Record<string, unknown>) => events.push(event)
    },
    prisma: {
      leaseRevocationJob: {
        updateMany: async () => ({ count: 1 }),
        findMany: async () => [
          {
            id: "lease_job_1",
            reason: "node_access_revoked",
            status: "pending",
            subscriptionId: "sub_1",
            userId: "user_1",
            nodeId: "node_1",
            attempts: 0,
            nextRunAt: now,
            lockedAt: null,
            lastError: null,
            completedAt: null,
            createdAt: now,
            updatedAt: now
          }
        ]
      },
      node: {
        findMany: async () => [{ id: "node_1", name: "Node 1" }]
      }
    }
  });

  await service.retryLeaseRevocationJob("lease_job_1");

  assert.equal(events.length, 1, "manual lease retry must notify admin sync queue subscribers");
  assert.equal(events[0]?.type, "sync_queue_updated");
  assert.equal(events[0]?.nodeId, null);
}

async function testRetryLeaseRevocationJobKeepsSavedRetryWhenListRefreshFails() {
  const updates: Array<Record<string, any>> = [];
  const warnings: string[] = [];
  const service = createAdminNodeService({
    logger: {
      warn: (message: string) => warnings.push(message)
    },
    prisma: {
      leaseRevocationJob: {
        updateMany: async (payload: Record<string, any>) => {
          updates.push(payload);
          return { count: 1 };
        },
        findMany: async () => {
          throw new Error("lease queue list refresh failed");
        }
      }
    }
  });

  const result = await service.retryLeaseRevocationJob("lease_job_1");

  assert.deepEqual(result, [], "saved lease retry must return a successful fallback response when queue refresh fails");
  assert.equal(updates.length, 1, "retry state must be saved before lease queue refresh");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /queue refresh failed/);
}

async function testRetryLeaseRevocationJobsForNodeOnlyRequeuesRetryableJobsOnThatNode() {
  const updates: Array<Record<string, any>> = [];
  const now = new Date("2026-01-01T00:00:00.000Z");
  const service = createAdminNodeService({
    prisma: {
      leaseRevocationJob: {
        updateMany: async (payload: Record<string, any>) => {
          updates.push(payload);
          return { count: 2 };
        },
        findMany: async () => [
          {
            id: "lease_pending",
            reason: "admin_user_disconnected",
            status: "pending",
            subscriptionId: "sub_1",
            userId: "user_1",
            nodeId: "node_1",
            attempts: 1,
            nextRunAt: now,
            lockedAt: null,
            lastError: "old error",
            completedAt: null,
            createdAt: now,
            updatedAt: now
          },
          {
            id: "lease_failed",
            reason: "admin_user_disabled",
            status: "failed",
            subscriptionId: "sub_1",
            userId: "user_1",
            nodeId: "node_1",
            attempts: 2,
            nextRunAt: now,
            lockedAt: null,
            lastError: "lease revoke failed",
            completedAt: null,
            createdAt: now,
            updatedAt: now
          }
        ]
      },
      node: {
        findMany: async () => [{ id: "node_1", name: "Node 1" }]
      }
    }
  });

  const result = await service.retryLeaseRevocationJobsForNode("node_1");

  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.where.nodeId, "node_1");
  assert.deepEqual(updates[0]?.where.status, { in: ["pending", "failed"] });
  assert.equal(updates[0]?.data.status, "pending");
  assert.equal(updates[0]?.data.lockedAt, null);
  assert.equal(updates[0]?.data.completedAt, null);
  assert.equal(updates[0]?.data.attempts, 0);
  assert.equal(updates[0]?.data.lastError, null);
  assert.deepEqual(result.map((job) => job.id), ["lease_pending", "lease_failed"]);
  assert.deepEqual(result.map((job) => job.nodeName), ["Node 1", "Node 1"]);
}

async function testRetryLeaseRevocationJobsForNodeRejectsWhenNoRetryableJobsExist() {
  const updates: Array<Record<string, any>> = [];
  const service = createAdminNodeService({
    prisma: {
      leaseRevocationJob: {
        updateMany: async (payload: Record<string, any>) => {
          updates.push(payload);
          return { count: 0 };
        }
      }
    }
  });

  await assert.rejects(
    () => service.retryLeaseRevocationJobsForNode("node_running"),
    (error) => error instanceof NotFoundException,
    "node-level lease revocation retry must not unlock running or completed jobs"
  );

  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.where.nodeId, "node_running");
  assert.deepEqual(updates[0]?.where.status, { in: ["pending", "failed"] });
}

async function testUpdateNodeAccessRejectsInvalidNodeIdsAsBadRequest() {
  const service = createDevDataService();

  const cases: Array<{ input: unknown; pattern: RegExp }> = [
    { input: {}, pattern: /nodeIds must be an array/ },
    { input: { nodeIds: [123] }, pattern: /node id strings/ },
    { input: { nodeIds: [""] }, pattern: /empty values/ }
  ];

  for (const item of cases) {
    await assert.rejects(
      () => service.updateSubscriptionNodeAccess("sub_1", item.input as any),
      (error) => error instanceof BadRequestException && item.pattern.test(error.message),
      `invalid node access payload must return a controlled 400: ${JSON.stringify(item.input)}`
    );
  }
}

async function testGetNodeAccessMapsUnknownReadFailure() {
  const service = createDevDataService({
    logger: {
      error: () => undefined
    },
    requireSubscription: async () => ({
      id: "sub_1",
      userId: "user_1",
      teamId: null
    }),
    prisma: {
      subscriptionNodeAccess: {
        findMany: async () => {
          throw new Error("node access read failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.getSubscriptionNodeAccess("sub_1"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      /节点授权加载失败/.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "node access read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testUpdateNodeAccessMapsLocalSaveConstraintErrors() {
  const service = createDevDataService({
    logger: {
      error: () => undefined
    },
    requireSubscription: async () => ({
      id: "sub_1",
      userId: "user_1",
      teamId: null
    }),
    prisma: {
      subscriptionNodeAccess: {
        findMany: async () => {
          throw { code: "P2003" };
        }
      }
    }
  });

  await assert.rejects(
    () => service.updateSubscriptionNodeAccess("sub_1", { nodeIds: ["node_1"] }),
    (error) => error instanceof BadRequestException && /节点授权数据已变化/.test(error.message),
    "local node access constraint errors must return a controlled 400 instead of HTTP 500"
  );
}

async function testUpdateNodeAccessMapsUnknownLocalSaveFailure() {
  const service = createDevDataService({
    logger: {
      error: () => undefined
    },
    requireSubscription: async () => ({
      id: "sub_1",
      userId: "user_1",
      teamId: null
    }),
    prisma: {
      subscriptionNodeAccess: {
        findMany: async () => {
          throw new Error("local node access read failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.updateSubscriptionNodeAccess("sub_1", { nodeIds: ["node_1"] }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      /节点授权保存失败/.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "unknown local node access save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testUpdateNodeAccessMapsTransactionCommitFailure() {
  const node = {
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
  let accessRows = [{ id: "access_offline", nodeId: "node_offline", node }];
  const service = createDevDataService({
    logger: {
      error: () => undefined
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
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) => {
        await task({
          subscriptionNodeAccess: {
            deleteMany: async () => {
              accessRows = [];
            }
          }
        });
        throw { code: "P2028", message: "Transaction already closed: timeout" };
      }
    },
    runtimeSessionService: {
      queuePanelDisableJobsForSubscriptionTx: async () => 1,
      queueLeaseRevocationJobsForSubscriptionTx: async () => 1
    }
  });

  await assert.rejects(
    () => service.updateSubscriptionNodeAccess("sub_1", { nodeIds: [] }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      /节点授权保存暂时繁忙/.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "transaction commit/timeout failures must return a controlled 503 instead of HTTP 500"
  );
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
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          subscriptionNodeAccess: {
            createMany: async (payload: Record<string, any>) => {
              createdRows.push(payload);
            }
          }
        })
    },
    runtimeSessionService: {
      queueDirectSubscriptionAccessSyncTx: async () => 0,
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

async function testNodeAccessEnsureQueuesDirectSyncInsideTransaction() {
  let inTransaction = false;
  let sawTransactionScopedSync = false;
  let txSyncCalls = 0;
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
        findMany: async (payload: { select?: unknown }) => (payload.select ? [] : [{ nodeId: "node_1", node }]),
        createMany: async () => undefined
      },
      node: {
        findMany: async () => [node]
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) => {
        inTransaction = true;
        try {
          return await task({
            subscriptionNodeAccess: {
              createMany: async () => undefined
            }
          });
        } finally {
          inTransaction = false;
        }
      }
    },
    runtimeSessionService: {
      queueDirectSubscriptionAccessSyncTx: async () => {
        sawTransactionScopedSync = inTransaction;
        txSyncCalls += 1;
        return 0;
      }
    },
    clientEventsPublisher: {
      publishNodeAccessUpdated: async () => undefined
    }
  });

  await service.updateSubscriptionNodeAccess("sub_1", { nodeIds: ["node_1"] });

  assert.equal(txSyncCalls, 1, "供给必须走事务作用域的 direct 入口，不得退回根客户端调用");
  assert.equal(
    sawTransactionScopedSync,
    true,
    "绑定激活/基线/修订/ENSURE_USER 必须在同一事务内提交或回滚"
  );
}

async function testNodeAccessRemovalMessagesDescribeQueuedRevocation() {
  const baseNode = {
    id: "node_keep",
    name: "keep",
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

  let clearRows = [{ id: "access_old", nodeId: "node_old" }];
  const clearService = createDevDataService({
    requireSubscription: async () => ({ id: "sub_clear", userId: "user_1", teamId: null }),
    prisma: {
      subscriptionNodeAccess: {
        findMany: async () => clearRows,
        deleteMany: async () => {
          clearRows = [];
        }
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          subscriptionNodeAccess: {
            deleteMany: async () => {
              clearRows = [];
            }
          }
        })
    },
    runtimeSessionService: {
      queuePanelDisableJobsForSubscriptionTx: async () => 1,
      queueLeaseRevocationJobsForSubscriptionTx: async () => 1
    },
    publishNodeAccessUpdatedEvent: async () => undefined
  });

  const clearResult = await clearService.updateSubscriptionNodeAccess("sub_clear", { nodeIds: [] });
  assert.equal(clearResult.reasonMessage, "当前订阅的节点授权已全部取消，本地权限已立即失效；连接撤销任务会后台处理。");
  assert.equal(clearResult.message, "节点授权已清空，本地权限已立即失效；连接撤销和面板同步任务已排队。");

  let replaceRows = [
    { id: "access_old", nodeId: "node_old" },
    { id: "access_keep", nodeId: "node_keep" }
  ];
  const replaceService = createDevDataService({
    requireSubscription: async () => ({ id: "sub_replace", userId: "user_1", teamId: null }),
    prisma: {
      subscriptionNodeAccess: {
        findMany: async (payload: { select?: unknown }) => {
          if (payload.select) {
            return replaceRows;
          }
          return replaceRows
            .filter((row) => row.nodeId === "node_keep")
            .map((row) => ({ ...row, node: baseNode }));
        },
        deleteMany: async () => {
          replaceRows = replaceRows.filter((row) => row.nodeId !== "node_old");
        }
      },
      node: {
        findMany: async () => [baseNode]
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          subscriptionNodeAccess: {
            deleteMany: async () => {
              replaceRows = replaceRows.filter((row) => row.nodeId !== "node_old");
            }
          }
        })
    },
    runtimeSessionService: {
      queuePanelDisableJobsForSubscriptionTx: async () => 1,
      queueLeaseRevocationJobsForSubscriptionTx: async () => 1
    },
    publishNodeAccessUpdatedEvent: async () => undefined
  });

  const replaceResult = await replaceService.updateSubscriptionNodeAccess("sub_replace", { nodeIds: ["node_keep"] });
  assert.equal(replaceResult.reasonMessage, "已取消部分节点授权，本地权限已立即失效；连接撤销任务会后台处理。");
  assert.equal(replaceResult.message, "节点授权已保存，已移除的节点本地权限已立即失效；连接撤销和面板同步任务已排队。");
}

async function testNodeAccessHttpMapsSubscriptionLookupFailureToServiceUnavailable() {
  const devDataService = createDevDataService({
    logger: {
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined
    },
    requireSubscription: async () => {
      throw new Error("subscription lookup failed before local node access save");
    }
  });

  Reflect.defineMetadata("design:paramtypes", [AuthSessionService], AdminAuthGuard);
  Reflect.defineMetadata(
    "design:paramtypes",
    [DevDataService, RuntimeComponentsService, ImageBedService, DownloadMirrorService, AdminRuntimeEventsService, AuthSessionService],
    AdminController
  );

  @Module({
    controllers: [AdminController],
    providers: [
      AdminAuthGuard,
      {
        provide: AuthSessionService,
        useValue: {
          authenticateAccessToken: async () => ({ id: "admin_1", role: "admin" })
        }
      },
      { provide: DevDataService, useValue: devDataService },
      { provide: RuntimeComponentsService, useValue: {} },
      { provide: ImageBedService, useValue: {} },
      { provide: DownloadMirrorService, useValue: { getAdminConfig: async () => ({ defaultMirrorPrefix: null, allowClientMirror: true, updatedAt: null }), updateAdminConfig: async (input: unknown) => input } },
      { provide: AdminRuntimeEventsService, useValue: {} }
    ]
  })
  class NodeAccessHttpSubscriptionLookupRegressionModule {}

  const app = await NestFactory.create(NodeAccessHttpSubscriptionLookupRegressionModule, { logger: false });
  app.setGlobalPrefix("api");
  app.useGlobalFilters(new LoggingExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true
    })
  );
  const baseUrl = await listenOnFetchSafeNestApp(app);

  try {
    const response = await fetch(`${baseUrl}/api/admin/subscriptions/sub_1/nodes`, {
      method: "PUT",
      headers: {
        authorization: "Bearer admin-test-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ nodeIds: ["node_1"] })
    });
    const body = await response.json();

    assert.equal(
      response.status,
      503,
      `subscription lookup failures must return controlled 503 instead of HTTP 500: ${JSON.stringify(body)}`
    );
    assert.equal(body.statusCode, 503);
    assert.notEqual(body.message, "Internal server error");
  } finally {
    await app.close();
  }
}

async function testNodeAccessHttpMapsNodeListFailureToServiceUnavailable() {
  const devDataService = createDevDataService({
    logger: {
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined
    },
    requireSubscription: async () => ({
      id: "sub_1",
      userId: "user_1",
      teamId: null
    }),
    prisma: {
      subscriptionNodeAccess: {
        findMany: async () => []
      },
      node: {
        findMany: async () => {
          throw new Error("node list failed before local node access save");
        }
      }
    }
  });

  Reflect.defineMetadata("design:paramtypes", [AuthSessionService], AdminAuthGuard);
  Reflect.defineMetadata(
    "design:paramtypes",
    [DevDataService, RuntimeComponentsService, ImageBedService, DownloadMirrorService, AdminRuntimeEventsService, AuthSessionService],
    AdminController
  );

  @Module({
    controllers: [AdminController],
    providers: [
      AdminAuthGuard,
      {
        provide: AuthSessionService,
        useValue: {
          authenticateAccessToken: async () => ({ id: "admin_1", role: "admin" })
        }
      },
      { provide: DevDataService, useValue: devDataService },
      { provide: RuntimeComponentsService, useValue: {} },
      { provide: ImageBedService, useValue: {} },
      { provide: DownloadMirrorService, useValue: { getAdminConfig: async () => ({ defaultMirrorPrefix: null, allowClientMirror: true, updatedAt: null }), updateAdminConfig: async (input: unknown) => input } },
      { provide: AdminRuntimeEventsService, useValue: {} }
    ]
  })
  class NodeAccessHttpNodeListRegressionModule {}

  const app = await NestFactory.create(NodeAccessHttpNodeListRegressionModule, { logger: false });
  app.setGlobalPrefix("api");
  app.useGlobalFilters(new LoggingExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true
    })
  );
  const baseUrl = await listenOnFetchSafeNestApp(app);

  try {
    const response = await fetch(`${baseUrl}/api/admin/subscriptions/sub_1/nodes`, {
      method: "PUT",
      headers: {
        authorization: "Bearer admin-test-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ nodeIds: ["node_1"] })
    });
    const body = await response.json();

    assert.equal(
      response.status,
      503,
      `node list failures must return controlled 503 instead of HTTP 500: ${JSON.stringify(body)}`
    );
    assert.equal(body.statusCode, 503);
    assert.notEqual(body.message, "Internal server error");
  } finally {
    await app.close();
  }
}

async function testNodeAccessHttpReturnsOkWhenAdminRuntimeEventPublishThrowsAfterLocalSave() {
  const newNode = {
    id: "node_new",
    name: "new",
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
  let accessRows: Array<{ id: string; nodeId: string; node: typeof newNode }> = [];
  let adminPublishCalled = false;

  const devDataService = createDevDataService({
    logger: {
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined
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
        }
      },
      node: {
        findMany: async () => [newNode]
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          subscriptionNodeAccess: {
            createMany: async () => {
              accessRows.push({ id: "access_new", nodeId: "node_new", node: newNode });
            }
          }
        })
    },
    runtimeSessionService: {
      queueDirectSubscriptionAccessSyncTx: async () => 0,
      queueDirectSubscriptionAccessSync: async () => 0
    },
    adminRuntimeEventsService: {
      publish: () => {
        adminPublishCalled = true;
        throw new Error("admin runtime event publish failed");
      }
    },
    clientEventsPublisher: {
      publishNodeAccessUpdated: async () => undefined
    }
  });

  Reflect.defineMetadata("design:paramtypes", [AuthSessionService], AdminAuthGuard);
  Reflect.defineMetadata(
    "design:paramtypes",
    [DevDataService, RuntimeComponentsService, ImageBedService, DownloadMirrorService, AdminRuntimeEventsService, AuthSessionService],
    AdminController
  );

  @Module({
    controllers: [AdminController],
    providers: [
      AdminAuthGuard,
      {
        provide: AuthSessionService,
        useValue: {
          authenticateAccessToken: async () => ({ id: "admin_1", role: "admin" })
        }
      },
      { provide: DevDataService, useValue: devDataService },
      { provide: RuntimeComponentsService, useValue: {} },
      { provide: ImageBedService, useValue: {} },
      { provide: DownloadMirrorService, useValue: { getAdminConfig: async () => ({ defaultMirrorPrefix: null, allowClientMirror: true, updatedAt: null }), updateAdminConfig: async (input: unknown) => input } },
      { provide: AdminRuntimeEventsService, useValue: {} }
    ]
  })
  class NodeAccessHttpAdminRuntimeEventRegressionModule {}

  const app = await NestFactory.create(NodeAccessHttpAdminRuntimeEventRegressionModule, { logger: false });
  let caughtException: unknown = null;
  app.setGlobalPrefix("api");
  const loggingFilter = new LoggingExceptionFilter();
  app.useGlobalFilters({
    catch: (exception, host) => {
      caughtException = exception;
      loggingFilter.catch(exception, host);
    }
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true
    })
  );
  const baseUrl = await listenOnFetchSafeNestApp(app);

  try {
    const response = await fetch(`${baseUrl}/api/admin/subscriptions/sub_1/nodes`, {
      method: "PUT",
      headers: {
        authorization: "Bearer admin-test-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ nodeIds: ["node_new"] })
    });
    const body = await response.json();

    assert.equal(
      response.status,
      200,
      `admin runtime event publish failure must not surface as HTTP 500 after local save: ${JSON.stringify(body)} ${
        caughtException instanceof Error ? caughtException.stack : String(caughtException)
      }`
    );
    assert.equal(adminPublishCalled, true);
    assert.deepEqual(accessRows.map((row) => row.nodeId), ["node_new"]);
    assert.deepEqual(body.nodeIds, ["node_new"]);
    assert.notEqual(body.message, "Internal server error");
  } finally {
    await app.close();
  }
}

async function testKickTeamMemberDoesNotQueueDisconnectBeforeDisableAccountSave() {
  let teamSubscriptionLookupStarted = false;
  const service = createAdminSubscriptionService({
    requireTeamMember: async () => ({
      id: "member_1",
      teamId: "team_1",
      userId: "user_1",
      role: "member"
    }),
    updateUser: async () => {
      throw new Error("account disable local save failed");
    },
    findCurrentTeamSubscription: async () => {
      teamSubscriptionLookupStarted = true;
      return {
        id: "sub_team",
        teamId: "team_1",
        state: "active",
        remainingTrafficGb: 10,
        expireAt: new Date(Date.now() + 86_400_000)
      };
    }
  });

  await assert.rejects(
    () => service.kickTeamMember("team_1", "member_1", { disableAccount: true }),
    /account disable local save failed/
  );
  assert.equal(teamSubscriptionLookupStarted, false, "disconnect queueing must not start before disable account local save succeeds");
}

async function testCloseSupportTicketsPublishesClientAndAdminEvents() {
  const clientEvents: Array<{ userId: string; event: Record<string, unknown> }> = [];
  const adminEvents: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  const service = createAdminSubscriptionService({
    logger: {
      warn: (message: string) => warnings.push(message)
    },
    clientRuntimeEventsService: {
      publishToUser: (userId: string, event: Record<string, unknown>) => {
        clientEvents.push({ userId, event });
      }
    },
    adminRuntimeEventsService: {
      publishTicketUpdated: (event: Record<string, unknown>) => {
        adminEvents.push(event);
        throw new Error("admin ticket sse failed");
      }
    },
    prisma: {
      supportTicket: {
        findMany: async () => [
          {
            id: "ticket_1",
            userId: "user_1"
          }
        ],
        updateMany: async () => ({ count: 1 })
      },
      supportTicketMessage: {
        createMany: async () => ({ count: 1 })
      },
      $transaction: async (operations: Array<Promise<unknown>>) => {
        await Promise.all(operations);
      }
    }
  });

  const count = await (service as any).closePersonalSupportTicketsForUser("user_1", "membership changed");

  assert.equal(count, 1);
  assert.equal(clientEvents.length, 1);
  assert.equal(clientEvents[0].userId, "user_1");
  assert.equal(clientEvents[0].event.type, "ticket_updated");
  assert.equal(clientEvents[0].event.ticketId, "ticket_1");
  assert.equal(clientEvents[0].event.ticketStatus, "closed");
  assert.deepEqual(adminEvents, [{ ticketId: "ticket_1", ticketStatus: "closed" }]);
  assert.match(warnings.join("\n"), /admin ticket sse failed/);
}

async function testConvertPersonalSubscriptionToTeamWaitsForRequiredTeamSubscriptionLookup() {
  let teamMemberCreated = false;
  let subscriptionArchived = false;
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
    findCurrentTeamSubscription: async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 350));
      return {
        id: "sub_team",
        teamId: "team_1",
        state: "active",
        remainingTrafficGb: 10,
        expireAt: new Date(Date.now() + 86_400_000)
      };
    },
    closePersonalSupportTicketsForUserBestEffort: async () => undefined,
    requireTeamRecord: async () => ({
      id: "team_1",
      name: "Team"
    }),
    publishSubscriptionUpdatedEvent: async () => undefined,
    runtimeSessionService: {
      syncSubscriptionPanelAccess: async () => 0,
      revokeSubscriptionLeases: async () => 0,
      removePanelBindingsForSubscription: async () => {
        return { requested: 0, updated: 0, failed: [] };
      },
      assertPanelBindingMutation: () => undefined
    },
    prisma: {
      teamMember: {
        create: async () => {
          teamMemberCreated = true;
          return {};
        }
      },
      subscription: {
        update: async () => {
          subscriptionArchived = true;
          return {};
        }
      }
    }
  });

  const result = await Promise.race([
    service.convertPersonalSubscriptionToTeam("sub_personal", { targetTeamId: "team_1" }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("convertPersonalSubscriptionToTeam timed out waiting for required team subscription lookup")), 1_000);
    })
  ]);

  assert.equal(result.ok, true);
  assert.equal(teamMemberCreated, true, "conversion should wait for the required team subscription lookup instead of using a 300ms follow-up budget");
  assert.equal(subscriptionArchived, true, "conversion should continue after the required lookup succeeds");
}

async function testConvertPersonalSubscriptionToTeamConvertsMembershipUniqueConflict() {
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
    prisma: {
      teamMember: {
        create: async () => {
          throw { code: "P2002" };
        }
      }
    }
  });

  await assert.rejects(
    () => service.convertPersonalSubscriptionToTeam("sub_personal", { targetTeamId: "team_1" }),
    /already belongs to another team/
  );
}

async function testGetTeamUsageUsesAggregatedLedgerRows() {
  const groupByCalls: Array<Record<string, unknown>> = [];
  const service = createAdminSubscriptionService({
    prisma: {
      team: {
        findUnique: async () => ({ id: "team_1", name: "Team" })
      },
      trafficLedger: {
        findMany: async () => {
          throw new Error("team usage detail must not load raw traffic ledger rows");
        },
        groupBy: async (payload: Record<string, unknown>) => {
          groupByCalls.push(payload);
          return [
            {
              teamId: "team_1",
              userId: "user_1",
              subscriptionId: "sub_1",
              nodeId: "node_1",
              _sum: { usedTrafficGb: 12.3456 },
              _count: { _all: 3 },
              _max: { recordedAt: new Date("2026-01-02T00:00:00.000Z") }
            },
            {
              teamId: "team_1",
              userId: "user_1",
              subscriptionId: "sub_1",
              nodeId: null,
              _sum: { usedTrafficGb: 1 },
              _count: { _all: 1 },
              _max: { recordedAt: new Date("2026-01-01T00:00:00.000Z") }
            }
          ];
        }
      },
      user: {
        findMany: async () => [{ id: "user_1", displayName: "User", email: "user@example.com" }]
      },
      node: {
        findMany: async () => [{ id: "node_1", name: "Node", region: "US" }]
      }
    }
  });

  const result = await service.getTeamUsage("team_1");

  assert.equal(groupByCalls.length, 1);
  assert.deepEqual((groupByCalls[0].where as Record<string, unknown>).teamId, { in: ["team_1"] });
  assert.equal(result.length, 1);
  assert.equal(result[0].userId, "user_1");
  assert.equal(result[0].usedTrafficGb, 13.346);
  assert.equal(result[0].recordCount, 2, "aggregated rows should be summarized without loading raw ledger entries");
  assert.equal(result[0].nodeBreakdown.length, 2);
}

async function testClientBootstrapDegradesOptionalSectionsOnPrismaPoolTimeout() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const service = createClientAccessService({
    authSessionService: {
      authenticateAccessToken: async () => ({ id: "user_1", email: "user@example.com" })
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
    meteringIncidentService: {
      getSubscriptionMeteringState: async () => ({
        meteringStatus: "ok",
        meteringMessage: null
      })
    },
    announcementPolicyService: {
      getPolicies: async () => ({
        defaultMode: "rule",
        modes: [],
        features: {
          blockAds: false,
          chinaDirect: false,
          aiServicesProxy: false
        }
      }),
      getAnnouncements: async () => {
        throw { code: "P2024", message: "Timed out fetching a new connection from the connection pool" };
      }
    },
    clientTicketService: {
      getClientSupportTicketInbox: async () => {
        throw { code: "P2024", message: "Timed out fetching a new connection from the connection pool" };
      }
    },
    getClientVersion: async () => ({
      currentVersion: "1.1.6",
      minimumVersion: "1.1.0",
      forceUpgrade: false,
      changelog: [],
      downloadUrl: null
    })
  });

  const result = await service.getBootstrap("Bearer token", "windows");

  assert.deepEqual(result.announcements, []);
  assert.deepEqual(result.supportTickets, { totalCount: 0, unreadCount: 0 });
  assert.equal(result.subscription.id, "sub_1");
  assert.equal(result.version.currentVersion, "1.1.6");
}

async function testClientBootstrapMapsRequiredReadFailure() {
  const service = createClientAccessService({
    authSessionService: {
      authenticateAccessToken: async () => ({ id: "user_1" })
    },
    resolveSubscriptionAccessForUser: async () => {
      throw new Error("client bootstrap subscription read failed");
    }
  });

  await assert.rejects(
    () => service.getBootstrap("Bearer token", "windows"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/client bootstrap subscription read failed/i.test(error.message),
    "client bootstrap required read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testClientNodesMapLocalReadFailure() {
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
        findMany: async () => {
          throw new Error("client node list local read failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.getNodes("Bearer token"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/client node list local read failed/i.test(error.message),
    "client node list read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testClientVersionMapsPolicyReadFailure() {
  const service = createClientAccessService({
    prisma: {
      policyProfile: {
        findUnique: async () => {
          throw new Error("client version policy read failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.getClientVersion("windows"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/client version policy read failed/i.test(error.message),
    "client version policy read failures must return a controlled 503 instead of HTTP 500"
  );
}

function testLoggingFilterMapsPrismaPoolTimeoutToServiceUnavailable() {
  const filter = new LoggingExceptionFilter();
  let statusCode: number | null = null;
  let responseBody: any = null;
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({
        method: "GET",
        originalUrl: "/api/client/bootstrap",
        ip: "127.0.0.1",
        headers: {}
      }),
      getResponse: () => ({
        status: (code: number) => {
          statusCode = code;
          return {
            json: (body: unknown) => {
              responseBody = body;
            }
          };
        }
      })
    })
  } as any;

  filter.catch({ code: "P2024", message: "Timed out fetching a new connection from the connection pool" }, host);

  assert.equal(statusCode, 503);
  assert.equal(responseBody.statusCode, 503);
  assert.equal(responseBody.message, "服务暂时繁忙，请稍后重试。");
}

function testLoggingFilterMapsPrismaCodedErrorsToServiceUnavailable() {
  const filter = new LoggingExceptionFilter();
  let statusCode: number | null = null;
  let responseBody: any = null;
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({
        method: "POST",
        originalUrl: "/api/admin/users",
        ip: "127.0.0.1",
        headers: {}
      }),
      getResponse: () => ({
        status: (code: number) => {
          statusCode = code;
          return {
            json: (body: unknown) => {
              responseBody = body;
            }
          };
        }
      })
    })
  } as any;

  filter.catch({ code: "P2010", message: "Raw query failed" }, host);

  assert.equal(statusCode, 503);
  assert.equal(responseBody.statusCode, 503);
  assert.notEqual(responseBody.message, "Internal server error");
}

function testLoggingFilterMapsDatabaseTransientErrorsToServiceUnavailable() {
  const filter = new LoggingExceptionFilter();
  let statusCode: number | null = null;
  let responseBody: any = null;
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({
        method: "PATCH",
        originalUrl: "/api/admin/users/user_1",
        ip: "127.0.0.1",
        headers: {}
      }),
      getResponse: () => ({
        status: (code: number) => {
          statusCode = code;
          return {
            json: (body: unknown) => {
              responseBody = body;
            }
          };
        }
      })
    })
  } as any;

  filter.catch(new Error("server closed the connection unexpectedly"), host);

  assert.equal(statusCode, 503);
  assert.equal(responseBody.statusCode, 503);
  assert.notEqual(responseBody.message, "Internal server error");
}

function testLoggingFilterKeepsOrdinaryErrorsAsInternalServerError() {
  const filter = new LoggingExceptionFilter();
  let statusCode: number | null = null;
  let responseBody: any = null;
  let responseRequestId: string | null = null;
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({
        method: "PATCH",
        originalUrl: "/api/admin/users/user_1",
        ip: "127.0.0.1",
        headers: { "x-request-id": "admin-test-request-id" }
      }),
      getResponse: () => ({
        setHeader: (name: string, value: string) => {
          if (name.toLowerCase() === "x-request-id") {
            responseRequestId = value;
          }
        },
        status: (code: number) => {
          statusCode = code;
          return {
            json: (body: unknown) => {
              responseBody = body;
            }
          };
        }
      })
    })
  } as any;

  filter.catch(new Error("unexpected programmer error"), host);

  assert.equal(statusCode, 500);
  assert.equal(responseBody.statusCode, 500);
  assert.equal(responseBody.message, "Internal server error");
  assert.equal(responseBody.requestId, "admin-test-request-id");
  assert.equal(responseRequestId, "admin-test-request-id");
}

function testForceHttpsMiddlewareKeepsRequestIdOnUpgradeRequired() {
  let statusCode: number | null = null;
  let responseBody: any = null;
  let responseRequestId: string | null = null;
  let nextCalled = false;

  forceHttpsMiddleware(
    {
      secure: false,
      headers: { "x-request-id": "admin-http-upgrade-check", "x-forwarded-proto": "http" }
    },
    {
      setHeader: (name: string, value: string) => {
        if (name.toLowerCase() === "x-request-id") {
          responseRequestId = value;
        }
      },
      status: (code: number) => {
        statusCode = code;
        return {
          json: (body: unknown) => {
            responseBody = body;
          }
        };
      }
    },
    () => {
      nextCalled = true;
    }
  );

  assert.equal(statusCode, 426);
  assert.equal(responseBody.requestId, "admin-http-upgrade-check");
  assert.equal(responseRequestId, "admin-http-upgrade-check");
  assert.equal(nextCalled, false);
}

async function testRuntimeConnectMapsLocalReadFailure() {
  const service = createRuntimeSessionService({
    prisma: {
      node: {
        findUnique: async () => {
          throw new Error("runtime connect node read failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.connect({ nodeId: "node_1", mode: "rule" }, "Bearer token"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/runtime connect node read failed/i.test(error.message),
    "runtime connect local read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testRuntimeHeartbeatMapsLocalReadFailure() {
  const service = createRuntimeSessionService({
    authSessionService: {
      authenticateAccessToken: async () => ({ id: "user_1" })
    },
    prisma: {
      nodeSessionLease: {
        findUnique: async () => {
          throw new Error("runtime heartbeat lease read failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.heartbeatSession("session_1", "Bearer token"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/runtime heartbeat lease read failed/i.test(error.message),
    "runtime heartbeat local read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testRuntimeDisconnectMapsLocalReadFailure() {
  const service = createRuntimeSessionService({
    authSessionService: {
      authenticateAccessToken: async () => ({ id: "user_1" })
    },
    prisma: {
      nodeSessionLease: {
        findUnique: async () => {
          throw new Error("runtime disconnect lease read failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.disconnect("session_1", "Bearer token"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/runtime disconnect lease read failed/i.test(error.message),
    "runtime disconnect local read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testRuntimeActiveConfigMapsLocalReadFailure() {
  const service = createRuntimeSessionService({
    authSessionService: {
      authenticateAccessToken: async () => ({ id: "user_1" })
    },
    prisma: {
      nodeSessionLease: {
        findFirst: async () => {
          throw new Error("runtime active config lease read failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.getActiveRuntime(undefined, "Bearer token"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/runtime active config lease read failed/i.test(error.message),
    "runtime active config read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testRuntimePlanReturnsAvailablePartialComponentSet() {
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

  assert.equal(plan.components.length, 1, "client plan must expose the components actually configured by the backend");
  assert.equal(plan.components[0].kind, "geoip");
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
    /上传入口/,
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

async function testRuntimeComponentCreateRejectsBlankFileName() {
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
      originUrl: "https://example.com/xray.zip",
      fileName: "   ",
      expectedHash: "a".repeat(64)
    }),
    (error: unknown) => error instanceof BadRequestException,
    "remote runtime component create must reject blank output file names"
  );
}

async function testRuntimeComponentCreatePersistsRemoteMirrorFields() {
  let createdData: Record<string, unknown> | null = null;
  const service = createRuntimeComponentsService({
    prisma: {
      runtimeComponent: {
        create: async (payload: { data: Record<string, unknown> }) => {
          createdData = payload.data;
          return {
            ...payload.data,
            createdAt: new Date(),
            updatedAt: new Date()
          };
        }
      }
    }
  });

  const result = await service.createAdminRuntimeComponent({
    platform: "windows",
    architecture: "x64",
    kind: "xray",
    source: "custom_remote",
    originUrl: "https://example.com/xray.zip",
    defaultMirrorPrefix: "https://ghfast.top/",
    allowClientMirror: true,
    fileName: "xray.exe",
      expectedHash: "a".repeat(64)
  });

  assert.equal(
    createdData?.defaultMirrorPrefix,
    "https://ghfast.top/",
    "remote runtime components should persist default mirror prefixes for client acceleration"
  );
  assert.equal(
    createdData?.allowClientMirror,
    true,
    "remote runtime components should honor allowClientMirror"
  );
  assert.equal(result.defaultMirrorPrefix, "https://ghfast.top/");
  assert.equal(result.allowClientMirror, true);
}

async function testRuntimeComponentCreateMapsUniqueIdentityConflict() {
  const service = createRuntimeComponentsService({
    findSharedRulesetRecord: async () => null,
    prisma: {
      runtimeComponent: {
        create: async () => {
          throw { code: "P2002" };
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.createAdminRuntimeComponent({
        platform: "windows",
        architecture: "x64",
        kind: "xray",
        source: "custom_remote",
        originUrl: "https://example.com/xray.exe",
        fileName: "xray.exe",
        expectedHash: "a".repeat(64)
      }),
    ConflictException,
    "runtime component duplicate identity must return a controlled 409 instead of HTTP 500"
  );
}

async function testRuntimeComponentCreateMapsLocalSaveFailure() {
  const service = createRuntimeComponentsService({
    findSharedRulesetRecord: async () => null,
    prisma: {
      runtimeComponent: {
        create: async () => {
          throw new Error("runtime component create local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.createAdminRuntimeComponent({
        platform: "windows",
        architecture: "x64",
        kind: "xray",
        source: "custom_remote",
        originUrl: "https://example.com/xray.exe",
        fileName: "xray.exe",
        expectedHash: "a".repeat(64)
      }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/runtime component create local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "runtime component create local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testRuntimeComponentUpdateMapsUniqueIdentityConflict() {
  const service = createRuntimeComponentsService({
    ensureRuntimeComponentExists: async () => ({
      id: "component_1",
      platform: "windows",
      architecture: "x64",
      kind: "xray",
      source: "custom_remote",
      originUrl: "https://example.com/xray.exe",
      defaultMirrorPrefix: null,
      allowClientMirror: false,
      fileName: "xray.exe",
      storedFilePath: null,
      fileSizeBytes: null,
      fileHash: null,
      archiveEntryName: null,
      expectedHash: null,
      enabled: true
    }),
    prisma: {
      runtimeComponent: {
        update: async () => {
          throw { code: "P2002" };
        }
      }
    }
  });

  await assert.rejects(
    () => service.updateAdminRuntimeComponent("component_1", { fileName: "xray-new.exe" }),
    ConflictException,
    "runtime component update duplicate identity must return a controlled 409 instead of HTTP 500"
  );
}

async function testRuntimeComponentUpdateMapsLocalSaveFailure() {
  const service = createRuntimeComponentsService({
    ensureRuntimeComponentExists: async () => ({
      id: "component_1",
      platform: "windows",
      architecture: "x64",
      kind: "xray",
      source: "custom_remote",
      originUrl: "https://example.com/xray.exe",
      defaultMirrorPrefix: null,
      allowClientMirror: false,
      fileName: "xray.exe",
      storedFilePath: null,
      fileSizeBytes: null,
      fileHash: null,
      archiveEntryName: null,
      expectedHash: null,
      enabled: true
    }),
    prisma: {
      runtimeComponent: {
        update: async () => {
          throw new Error("runtime component update local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.updateAdminRuntimeComponent("component_1", { fileName: "xray-new.exe" }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/runtime component update local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "runtime component update local save failures must return a controlled 503 instead of HTTP 500"
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

  await assert.rejects(() => service.listRuntimeComponentFailureReports(Number.NaN), /失败记录数量/);
  await assert.rejects(() => service.listRuntimeComponentFailureReports(1000), /失败记录数量/);
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
    /运行组件不存在/,
    "unknown runtime component ids should be rejected before Prisma foreign key enforcement"
  );
  assert.equal(createCalled, false);
}

async function testRuntimeComponentFailureReportMapsLocalSaveFailure() {
  const service = createRuntimeComponentsService({
    prisma: {
      runtimeComponentFailureReport: {
        create: async () => {
          throw new Error("runtime failure report local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.reportRuntimeComponentFailure({
        platform: "windows",
        architecture: "x64",
        kind: "xray",
        reason: "download_failed",
        message: "download failed"
      }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/runtime failure report local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "runtime component failure report local save failures must return a controlled 503 instead of HTTP 500"
  );
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
  assert.match(result.message, /内网|保留地址/);
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

  assert.equal(result.status, "ready");
  assert.match(result.message, /有效|地址|下载/);
}

async function testRuntimeComponentUploadUsesActualHashWhenExpectedHashMismatch() {
  const cleanupCalls: Array<{ absolutePath: string | null; label: string }> = [];
  let createdData: Record<string, any> | null = null;
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
        create: async (payload: Record<string, any>) => {
          createdData = payload.data;
          return {
            ...payload.data,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z")
          };
        }
      }
    },
    startSharedRulesetDuplicatesCleanup: () => undefined,
    removeRuntimeComponentFileBestEffort: async (absolutePath: string | null, label: string) => {
      cleanupCalls.push({ absolutePath, label });
    }
  });

  const result = await service.uploadAdminRuntimeComponent(
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
  );

  assert.deepEqual(cleanupCalls, []);
  assert.equal(createdData?.fileHash, "a".repeat(64));
  assert.equal(createdData?.expectedHash, null);
  assert.equal(result.expectedHash, null);
}

async function testRuntimeComponentUploadMapsUniqueIdentityConflict() {
  const cleanupCalls: Array<{ absolutePath: string | null; label: string }> = [];
  const service = createRuntimeComponentsService({
    findSharedRulesetRecord: async () => null,
    prepareUploadedRuntimeComponentFile: async () => ({
      absolutePath: "prepared-runtime.bin",
      storedFilePath: "component/prepared-runtime.bin",
      fileName: "xray.exe",
      fileSizeBytes: 1n,
      fileHash: "a".repeat(64),
      downloadUrl: "/api/downloads/runtime-components/component_1"
    }),
    prisma: {
      runtimeComponent: {
        create: async () => {
          throw { code: "P2002" };
        }
      }
    },
    removeRuntimeComponentFileBestEffort: async (absolutePath: string | null, label: string) => {
      cleanupCalls.push({ absolutePath, label });
    }
  });

  await assert.rejects(
    () =>
      service.uploadAdminRuntimeComponent(
        {
          platform: "windows",
          architecture: "x64",
          kind: "xray"
        },
        {
          path: "upload-runtime.tmp",
          originalname: "xray.exe",
          size: 1
        }
      ),
    ConflictException,
    "runtime component upload duplicate identity must return a controlled 409 instead of HTTP 500"
  );
  assert.deepEqual(cleanupCalls, [{ absolutePath: "prepared-runtime.bin", label: "failed runtime component upload" }]);
}

async function testRuntimeComponentUploadMapsTransientPrismaFailure() {
  const cleanupCalls: Array<{ absolutePath: string | null; label: string }> = [];
  const service = createRuntimeComponentsService({
    findSharedRulesetRecord: async () => null,
    prepareUploadedRuntimeComponentFile: async () => ({
      absolutePath: "prepared-runtime-transient.bin",
      storedFilePath: "component/prepared-runtime-transient.bin",
      fileName: "xray.exe",
      fileSizeBytes: 1n,
      fileHash: "a".repeat(64),
      downloadUrl: "/api/downloads/runtime-components/component_1"
    }),
    prisma: {
      runtimeComponent: {
        create: async () => {
          throw { code: "P2028", message: "Transaction already closed" };
        }
      }
    },
    removeRuntimeComponentFileBestEffort: async (absolutePath: string | null, label: string) => {
      cleanupCalls.push({ absolutePath, label });
    }
  });

  await assert.rejects(
    () =>
      service.uploadAdminRuntimeComponent(
        {
          platform: "windows",
          architecture: "x64",
          kind: "xray"
        },
        {
          path: "upload-runtime-transient.tmp",
          originalname: "xray.exe",
          size: 1
        }
      ),
    ServiceUnavailableException,
    "runtime component upload transient Prisma failures must return a controlled 503 instead of HTTP 500"
  );
  assert.deepEqual(cleanupCalls, [{ absolutePath: "prepared-runtime-transient.bin", label: "failed runtime component upload" }]);
}

async function testRuntimeComponentUploadMapsLocalSaveFailure() {
  const cleanupCalls: Array<{ absolutePath: string | null; label: string }> = [];
  const service = createRuntimeComponentsService({
    findSharedRulesetRecord: async () => null,
    prepareUploadedRuntimeComponentFile: async () => ({
      absolutePath: "prepared-runtime-local-failure.bin",
      storedFilePath: "component/prepared-runtime-local-failure.bin",
      fileName: "xray.exe",
      fileSizeBytes: 1n,
      fileHash: "a".repeat(64),
      downloadUrl: "/api/downloads/runtime-components/component_1"
    }),
    prisma: {
      runtimeComponent: {
        create: async () => {
          throw new Error("runtime component upload local save failed");
        }
      }
    },
    removeRuntimeComponentFileBestEffort: async (absolutePath: string | null, label: string) => {
      cleanupCalls.push({ absolutePath, label });
    }
  });

  await assert.rejects(
    () =>
      service.uploadAdminRuntimeComponent(
        {
          platform: "windows",
          architecture: "x64",
          kind: "xray"
        },
        {
          path: "upload-runtime-local-failure.tmp",
          originalname: "xray.exe",
          size: 1
        }
      ),
    (error) =>
      error instanceof ServiceUnavailableException &&
      /已尝试清理本次上传文件/.test(error.message) &&
      !/已清理本次上传文件/.test(error.message) &&
      !/runtime component upload local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "runtime component upload local save failures must return a controlled 503 instead of HTTP 500"
  );
  assert.deepEqual(cleanupCalls, [{ absolutePath: "prepared-runtime-local-failure.bin", label: "failed runtime component upload" }]);
}

async function testRuntimeComponentPrepareMissingTempFileReturnsBadRequest() {
  const previousStorageRoot = process.env.CHORDV_RELEASE_STORAGE_ROOT;
  const storageRoot = await mkdtemp(path.join(tmpdir(), "runtime-upload-missing-"));
  process.env.CHORDV_RELEASE_STORAGE_ROOT = storageRoot;
  const service = createRuntimeComponentsService();

  try {
    await assert.rejects(
      () =>
        service["prepareUploadedRuntimeComponentFile"](
          "component_1",
          {
            path: path.join(storageRoot, "missing-upload.tmp"),
            originalname: "xray.exe",
            size: 1
          },
          "xray.exe"
        ),
      BadRequestException,
      "missing runtime component temporary upload must return a controlled 400 instead of HTTP 500"
    );
  } finally {
    if (previousStorageRoot === undefined) {
      delete process.env.CHORDV_RELEASE_STORAGE_ROOT;
    } else {
      process.env.CHORDV_RELEASE_STORAGE_ROOT = previousStorageRoot;
    }
    await rm(storageRoot, { recursive: true, force: true });
  }
}

async function testRuntimeComponentReplaceUploadUsesActualHashWhenExpectedHashMismatch() {
  const failedCleanupCalls: Array<{ absolutePath: string | null; label: string }> = [];
  const staleCleanupCalls: Array<{ storedFilePath: string | null; label: string }> = [];
  let updatedData: Record<string, any> | null = null;
  const service = createRuntimeComponentsService({
    ensureRuntimeComponentExists: async () => ({
      id: "component_1",
      platform: "windows",
      architecture: "x64",
      kind: "xray",
      source: "uploaded",
      originUrl: "/api/downloads/runtime-components/component_1",
      defaultMirrorPrefix: null,
      allowClientMirror: false,
      fileName: "xray.exe",
      storedFilePath: "component_1/xray.exe",
      fileSizeBytes: 1n,
      fileHash: "a".repeat(64),
      archiveEntryName: null,
      expectedHash: "a".repeat(64),
      enabled: true
    }),
    prepareUploadedRuntimeComponentFile: async () => ({
      absolutePath: "missing-replacement-runtime.bin",
      storedFilePath: "component_1/xray-new.exe",
      fileName: "xray-new.exe",
      fileSizeBytes: 1n,
      fileHash: "a".repeat(64),
      downloadUrl: "/api/downloads/runtime-components/component_1"
    }),
    prisma: {
      runtimeComponent: {
        update: async (payload: Record<string, any>) => {
          updatedData = payload.data;
          return {
            ...payload.data,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z")
          };
        }
      }
    },
    startRuntimeComponentStoredFileCleanupBestEffort: (storedFilePath: string | null, label: string) => {
      staleCleanupCalls.push({ storedFilePath, label });
    },
    startSharedRulesetDuplicatesCleanup: () => undefined,
    removeRuntimeComponentFileBestEffort: async (absolutePath: string | null, label: string) => {
      failedCleanupCalls.push({ absolutePath, label });
    }
  });

  const result = await service.replaceAdminRuntimeComponentUpload(
    "component_1",
    {
      platform: "windows",
      architecture: "x64",
      kind: "xray",
      expectedHash: "b".repeat(64)
    },
    {
      path: "missing-replacement-upload-runtime.bin",
      originalname: "xray-new.exe",
      size: 1
    }
  );

  assert.deepEqual(failedCleanupCalls, []);
  assert.deepEqual(staleCleanupCalls, [
    { storedFilePath: "component_1/xray.exe", label: "old runtime component upload" }
  ]);
  assert.equal(updatedData?.fileHash, "a".repeat(64));
  assert.equal(updatedData?.expectedHash, null);
  assert.equal(result.expectedHash, null);
}

async function testRuntimeComponentReplaceUploadMapsUniqueIdentityConflict() {
  const cleanupCalls: Array<{ absolutePath: string | null; label: string }> = [];
  const service = createRuntimeComponentsService({
    ensureRuntimeComponentExists: async () => ({
      id: "component_1",
      platform: "windows",
      architecture: "x64",
      kind: "xray",
      source: "uploaded",
      originUrl: "/api/downloads/runtime-components/component_1",
      defaultMirrorPrefix: null,
      allowClientMirror: false,
      fileName: "xray.exe",
      storedFilePath: "component_1/xray.exe",
      fileSizeBytes: 1n,
      fileHash: "a".repeat(64),
      archiveEntryName: null,
      expectedHash: "a".repeat(64),
      enabled: true
    }),
    prepareUploadedRuntimeComponentFile: async () => ({
      absolutePath: "replacement-runtime.bin",
      storedFilePath: "component_1/replacement-runtime.bin",
      fileName: "xray-new.exe",
      fileSizeBytes: 1n,
      fileHash: "a".repeat(64),
      downloadUrl: "/api/downloads/runtime-components/component_1"
    }),
    prisma: {
      runtimeComponent: {
        update: async () => {
          throw { code: "P2002" };
        }
      }
    },
    removeRuntimeComponentFileBestEffort: async (absolutePath: string | null, label: string) => {
      cleanupCalls.push({ absolutePath, label });
    }
  });

  await assert.rejects(
    () =>
      service.replaceAdminRuntimeComponentUpload(
        "component_1",
        {
          platform: "windows",
          architecture: "x64",
          kind: "xray"
        },
        {
          path: "replacement-upload-runtime.tmp",
          originalname: "xray-new.exe",
          size: 1
        }
      ),
    ConflictException,
    "runtime component replacement duplicate identity must return a controlled 409 instead of HTTP 500"
  );
  assert.deepEqual(cleanupCalls, [
    { absolutePath: "replacement-runtime.bin", label: "failed runtime component replacement upload" }
  ]);
}

async function testRuntimeComponentReplaceUploadMapsTransientPrismaFailure() {
  const cleanupCalls: Array<{ absolutePath: string | null; label: string }> = [];
  const service = createRuntimeComponentsService({
    ensureRuntimeComponentExists: async () => ({
      id: "component_1",
      platform: "windows",
      architecture: "x64",
      kind: "xray",
      source: "uploaded",
      originUrl: "/api/downloads/runtime-components/component_1",
      defaultMirrorPrefix: null,
      allowClientMirror: false,
      fileName: "xray.exe",
      storedFilePath: "component_1/xray.exe",
      fileSizeBytes: 1n,
      fileHash: "a".repeat(64),
      archiveEntryName: null,
      expectedHash: "a".repeat(64),
      enabled: true
    }),
    prepareUploadedRuntimeComponentFile: async () => ({
      absolutePath: "replacement-runtime-transient.bin",
      storedFilePath: "component_1/replacement-runtime-transient.bin",
      fileName: "xray-new.exe",
      fileSizeBytes: 1n,
      fileHash: "a".repeat(64),
      downloadUrl: "/api/downloads/runtime-components/component_1"
    }),
    prisma: {
      runtimeComponent: {
        update: async () => {
          throw { code: "P2034", message: "Transaction failed due to a write conflict" };
        }
      }
    },
    removeRuntimeComponentFileBestEffort: async (absolutePath: string | null, label: string) => {
      cleanupCalls.push({ absolutePath, label });
    }
  });

  await assert.rejects(
    () =>
      service.replaceAdminRuntimeComponentUpload(
        "component_1",
        {
          platform: "windows",
          architecture: "x64",
          kind: "xray"
        },
        {
          path: "replacement-upload-runtime-transient.tmp",
          originalname: "xray-new.exe",
          size: 1
        }
      ),
    ServiceUnavailableException,
    "runtime component replacement transient Prisma failures must return a controlled 503 instead of HTTP 500"
  );
  assert.deepEqual(cleanupCalls, [
    { absolutePath: "replacement-runtime-transient.bin", label: "failed runtime component replacement upload" }
  ]);
}

async function testRuntimeComponentReplaceUploadMapsLocalSaveFailure() {
  const cleanupCalls: Array<{ absolutePath: string | null; label: string }> = [];
  const service = createRuntimeComponentsService({
    ensureRuntimeComponentExists: async () => ({
      id: "component_1",
      platform: "windows",
      architecture: "x64",
      kind: "xray",
      source: "uploaded",
      originUrl: "/api/downloads/runtime-components/component_1",
      defaultMirrorPrefix: null,
      allowClientMirror: false,
      fileName: "xray.exe",
      storedFilePath: "component_1/xray.exe",
      fileSizeBytes: 1n,
      fileHash: "a".repeat(64),
      archiveEntryName: null,
      expectedHash: "a".repeat(64),
      enabled: true
    }),
    prepareUploadedRuntimeComponentFile: async () => ({
      absolutePath: "replacement-runtime-local-failure.bin",
      storedFilePath: "component_1/replacement-runtime-local-failure.bin",
      fileName: "xray-new.exe",
      fileSizeBytes: 1n,
      fileHash: "a".repeat(64),
      downloadUrl: "/api/downloads/runtime-components/component_1"
    }),
    prisma: {
      runtimeComponent: {
        update: async () => {
          throw new Error("runtime component replacement local save failed");
        }
      }
    },
    removeRuntimeComponentFileBestEffort: async (absolutePath: string | null, label: string) => {
      cleanupCalls.push({ absolutePath, label });
    }
  });

  await assert.rejects(
    () =>
      service.replaceAdminRuntimeComponentUpload(
        "component_1",
        {
          platform: "windows",
          architecture: "x64",
          kind: "xray"
        },
        {
          path: "replacement-upload-runtime-local-failure.tmp",
          originalname: "xray-new.exe",
          size: 1
        }
      ),
    (error) =>
      error instanceof ServiceUnavailableException &&
      /已尝试清理本次上传文件/.test(error.message) &&
      !/已清理本次上传文件/.test(error.message) &&
      !/runtime component replacement local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "runtime component replacement local save failures must return a controlled 503 instead of HTTP 500"
  );
  assert.deepEqual(cleanupCalls, [
    { absolutePath: "replacement-runtime-local-failure.bin", label: "failed runtime component replacement upload" }
  ]);
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
  assert.equal(cleanupCalls, 0, "shared ruleset cleanup must not block the local save response");
  await waitUntil(() => cleanupCalls > 0);
  assert.equal(cleanupCalls, 1, "shared ruleset cleanup should still be attempted in background");
}

async function testRemoteSharedRulesetCreateCleansPreviousUploadedFile() {
  const expectedHash = "a".repeat(64);
  const cleanupCalls: Array<{ absolutePath: string | null; label: string }> = [];
  let updatePayload: Record<string, any> | null = null;
  const service = createRuntimeComponentsService({
    logger: {
      warn: () => undefined
    },
    findSharedRulesetRecord: async () => ({
      id: "component_existing",
      storedFilePath: "geoip/old-upload.dat"
    }),
    cleanupSharedRulesetDuplicates: async () => undefined,
    removeRuntimeComponentFileBestEffort: async (absolutePath: string | null, label: string) => {
      cleanupCalls.push({ absolutePath, label });
    },
    prisma: {
      runtimeComponent: {
        update: async (payload: Record<string, any>) => {
          updatePayload = payload;
          return {
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
          };
        }
      }
    }
  });

  const result = await service.createAdminRuntimeComponent({
    platform: "windows",
    architecture: "x64",
    kind: "geoip",
    source: "custom_remote",
    originUrl: "https://example.com/geoip.dat",
    fileName: "geoip.dat",
    expectedHash
  });

  assert.equal(result.id, "component_existing");
  assert.equal(result.source, "custom_remote");
  assert.equal(updatePayload?.data.storedFilePath, null);
  await waitUntil(() => cleanupCalls.length > 0);
  assert.equal(cleanupCalls.length, 1);
  assert.equal(cleanupCalls[0]?.label, "stale shared ruleset upload");
  assert.match(cleanupCalls[0]?.absolutePath ?? "", /geoip[\\/]old-upload\.dat$/);
}

async function testRemoteSharedRulesetCreateReturnsWhenCleanupStalls() {
  const previousCleanupBudget = process.env.CHORDV_SHARED_RULESET_CLEANUP_BUDGET_MS;
  process.env.CHORDV_SHARED_RULESET_CLEANUP_BUDGET_MS = "25";
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
      return new Promise<never>(() => undefined);
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

  try {
    const result = await Promise.race([
      service.createAdminRuntimeComponent({
        platform: "windows",
        architecture: "x64",
        kind: "geosite",
        source: "custom_remote",
        originUrl: "https://example.com/geosite.dat",
        fileName: "geosite.dat",
        expectedHash
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("runtime component create waited for stalled shared cleanup")), 750);
      })
    ]);

    assert.equal(result.id, "component_existing");
    assert.equal(result.kind, "geosite");
    assert.equal(cleanupCalls, 0, "stalled shared ruleset cleanup must not start before local save returns");
    await waitUntil(() => cleanupCalls > 0);
    assert.equal(cleanupCalls, 1, "shared ruleset cleanup should still be attempted in background");
  } finally {
    if (previousCleanupBudget === undefined) {
      delete process.env.CHORDV_SHARED_RULESET_CLEANUP_BUDGET_MS;
    } else {
      process.env.CHORDV_SHARED_RULESET_CLEANUP_BUDGET_MS = previousCleanupBudget;
    }
  }
}

async function testRemoteRuntimeValidationChecksExpectedHashWithGet() {
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
          expectedHash: "a".repeat(64),
          enabled: true
        })
      }
    }
  });

  const result = await service.validateAdminRuntimeComponent("component_1");
  assert.equal(result.status, "ready", "remote validation no longer downloads or compares SHA-256");
  assert.match(result.message, /有效|下载|地址/);
}

async function testRemoteRuntimeValidationReturnsUnreachableForHttp500() {
  const service = createRuntimeComponentsService({
    prisma: {
      runtimeComponent: {
        findUnique: async () => ({
          id: "component_1",
          platform: "windows",
          architecture: "x64",
          kind: "xray",
          source: "custom_remote",
          originUrl: "https://example.com/missing-xray.exe",
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
  assert.equal(result.status, "ready", "remote validation no longer probes upstream HTTP status");
}

async function testRemoteRuntimeValidationPersistsDownloadMetadata() {
  const updates: Array<Record<string, any>> = [];
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
          expectedHash: "a".repeat(64),
          enabled: true
        }),
        update: async (payload: Record<string, any>) => {
          updates.push(payload);
          return payload.data;
        }
      }
    }
  });

  const result = await service.validateAdminRuntimeComponent("component_1");
  assert.equal(result.status, "ready");
  assert.equal(updates.length, 0, "remote validation no longer persists downloaded hash metadata");
}

async function testRemoteRuntimeValidationRejectsLargeDefaultContentLength() {
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
          expectedHash: "a".repeat(64),
          enabled: true
        })
      }
    }
  });

  const result = await service.validateAdminRuntimeComponent("component_1");
  assert.equal(result.status, "ready", "remote validation no longer inspects Content-Length");
}

async function testRemoteRuntimeValidationReportsMetadataPersistFailure() {
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
          expectedHash: "a".repeat(64),
          enabled: true
        }),
        update: async () => {
          throw new Error("should not update remote metadata");
        }
      }
    }
  });

  const result = await service.validateAdminRuntimeComponent("component_1");
  assert.equal(result.status, "ready");
}

async function testRemoteRuntimeZipEntryValidationUsesExtractedEntryHash() {
  const service = createRuntimeComponentsService({
    prisma: {
      runtimeComponent: {
        findUnique: async () => ({
          id: "component_1",
          platform: "windows",
          architecture: "x64",
          kind: "xray",
          source: "custom_remote",
          originUrl: "https://example.com/xray.zip",
          defaultMirrorPrefix: null,
          allowClientMirror: false,
          fileName: "xray.exe",
          archiveEntryName: "xray.exe",
          storedFilePath: null,
          fileSizeBytes: null,
          fileHash: null,
          expectedHash: "a".repeat(64),
          enabled: true
        }),
        update: async () => {
          throw new Error("remote validation must not download zip entries for hash checks");
        }
      }
    }
  });

  const result = await service.validateAdminRuntimeComponent("component_1");
  assert.equal(result.status, "ready", "remote zip components only need a valid update URL");
}


async function testRemoteRuntimeZipEntryValidationUsesBestEffortArchiveCleanup() {
  const cleanupCalls: Array<{ absolutePath: string | null; label: string }> = [];
  const service = createRuntimeComponentsService({
    startRuntimeComponentFileCleanupBestEffort: (absolutePath: string | null, label: string) => {
      cleanupCalls.push({ absolutePath, label });
    },
    prisma: {
      runtimeComponent: {
        findUnique: async () => ({
          id: "component_1",
          platform: "windows",
          architecture: "x64",
          kind: "xray",
          source: "custom_remote",
          originUrl: "https://example.com/xray.zip",
          defaultMirrorPrefix: null,
          allowClientMirror: false,
          fileName: "xray.exe",
          archiveEntryName: "xray.exe",
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
  assert.equal(result.status, "ready");
  assert.equal(cleanupCalls.length, 0, "remote validation no longer extracts temporary zip archives");
}


async function testRemoteRuntimeValidationRejectsOversizeExpectedHashResponse() {
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
          expectedHash: "a".repeat(64),
          enabled: true
        })
      }
    }
  });

  const result = await service.validateAdminRuntimeComponent("component_1");
  assert.equal(result.status, "ready", "remote validation no longer streams remote bodies for hash limits");
}

async function testRemoteRuntimeValidationRejectsIdleTimeoutExpectedHashResponse() {
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
          expectedHash: "a".repeat(64),
          enabled: true
        })
      }
    }
  });

  const result = await service.validateAdminRuntimeComponent("component_1");
  assert.equal(result.status, "ready", "remote validation no longer waits on remote hash download idle timeout");
}

async function testRemoteRuntimeValidationRejectsTotalTimeoutExpectedHashResponse() {
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
          expectedHash: "a".repeat(64),
          enabled: true
        })
      }
    }
  });

  const result = await service.validateAdminRuntimeComponent("component_1");
  assert.equal(result.status, "ready", "remote validation no longer waits on remote hash download total timeout");
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

  assert.equal(plan.components.length, 3, "client plan may expose remote runtime components without size metadata");
}

async function testRuntimePlanSkipsRemoteRowsWithMismatchedHashMetadata() {
  const expectedHash = "a".repeat(64);
  const makeRemoteComponent = (id: string, kind: "xray" | "geoip" | "geosite", fileHash = expectedHash) => ({
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
    fileSizeBytes: 1024n,
    fileHash,
    archiveEntryName: null,
    expectedHash
  });
  const service = createRuntimeComponentsService({
    prisma: {
      runtimeComponent: {
        findMany: async (payload: { where: { kind?: string | { in: string[] } } }) => {
          if (payload.where.kind === "xray") {
            return [makeRemoteComponent("xray_1", "xray", "b".repeat(64))];
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

  assert.equal(
    plan.components.length,
    3,
    "client plan may expose remote runtime components even if stored fileHash differs from expectedHash"
  );
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

  assert.deepEqual(plan.components.map((item) => item.kind).sort(), ["geoip", "geosite"], "missing uploaded Xray must be filtered without hiding usable GEO components");
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

    assert.deepEqual(plan.components.map((item) => item.kind).sort(), ["geoip", "geosite"], "stale uploaded Xray must be filtered without hiding valid GEO components");
  } finally {
    if (previousReleaseStorageRoot === undefined) {
      delete process.env.CHORDV_RELEASE_STORAGE_ROOT;
    } else {
      process.env.CHORDV_RELEASE_STORAGE_ROOT = previousReleaseStorageRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testRuntimePlanExposesConfiguredMirrorFields() {
  const makeRemoteComponent = (id: string, kind: "xray" | "geoip" | "geosite") => ({
    id,
    platform: kind === "xray" ? "windows" : "macos",
    architecture: kind === "xray" ? "x64" : "arm64",
    kind,
    source: "custom_remote",
    originUrl: `https://origin.example.com/${kind}.dat`,
    defaultMirrorPrefix: null,
    allowClientMirror: true,
    fileName: `${kind}.dat`,
    storedFilePath: null,
    fileSizeBytes: 1024n,
    fileHash: "a".repeat(64),
    archiveEntryName: null,
    expectedHash: "a".repeat(64),
    enabled: true
  });
  const service = createRuntimeComponentsService({
    downloadMirrorService: {
      getEffectiveConfig: async () => ({
        defaultMirrorPrefix: "https://ghfast.top/",
        allowClientMirror: true,
        updatedAt: null
      })
    },
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
    architecture: "x64",
    clientMirrorPrefix: "https://client-mirror.example.com/"
  });

  assert.equal(plan.components.length, 3);
  for (const component of plan.components) {
    assert.equal(component.allowClientMirror, true, "client plan should expose configured allowClientMirror");
    assert.equal(component.defaultMirrorPrefix, "https://ghfast.top/", "client plan should expose global default mirrors");
    assert.equal(
      component.resolvedUrl,
      `https://client-mirror.example.com/${component.originUrl}`,
      "client plan should prefer client mirror when allowed"
    );
    assert.deepEqual(component.candidates, [
      { label: "client_mirror", url: `https://client-mirror.example.com/${component.originUrl}` },
      { label: "default_mirror", url: `https://ghfast.top/${component.originUrl}` },
      { label: "origin", url: component.originUrl }
    ]);
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
    /上传入口/,
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
    originUrl: "https://example.com/new-xray.zip",
    expectedHash: "b".repeat(64)
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

    assert.equal(existsSync(absolutePath), true, "switching runtime component to remote must not wait for old file cleanup");
    await waitUntil(() => !existsSync(absolutePath));
    assert.equal(existsSync(absolutePath), false, "old uploaded runtime file should still be removed in background");
  } finally {
    if (previousReleaseStorageRoot === undefined) {
      delete process.env.CHORDV_RELEASE_STORAGE_ROOT;
    } else {
      process.env.CHORDV_RELEASE_STORAGE_ROOT = previousReleaseStorageRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testRuntimeComponentDeleteReturnsWhenFileCleanupStalls() {
  const previousReleaseStorageRoot = process.env.CHORDV_RELEASE_STORAGE_ROOT;
  const previousCleanupBudget = process.env.CHORDV_RUNTIME_COMPONENT_FILE_CLEANUP_BUDGET_MS;
  const originalRm = fsForPatch.rm;
  const tempDir = await mkdtemp(path.join(tmpdir(), "chordv-runtime-delete-"));
  const storedFilePath = path.join("component_1", "xray.exe");
  let deleteCalled = false;
  let cleanupStarted = false;
  process.env.CHORDV_RELEASE_STORAGE_ROOT = tempDir;
  process.env.CHORDV_RUNTIME_COMPONENT_FILE_CLEANUP_BUDGET_MS = "25";
  fsForPatch.rm = async () => {
    cleanupStarted = true;
    return new Promise<never>(() => undefined);
  };
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
      logger: {
        warn: () => undefined
      },
      ensureRuntimeComponentExists: async () => current,
      prisma: {
        runtimeComponent: {
          delete: async () => {
            deleteCalled = true;
            return {};
          }
        }
      }
    });

    const result = await Promise.race([
      service.deleteAdminRuntimeComponent("component_1"),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("runtime component delete waited for stalled file cleanup")), 250);
      })
    ]);

    assert.equal(deleteCalled, true);
    assert.equal(cleanupStarted, false, "runtime component delete must not wait for file cleanup to start");
    assert.deepEqual(result, { id: "component_1", deleted: true });
    await waitUntil(() => cleanupStarted);
    assert.equal(cleanupStarted, true, "runtime component file cleanup should still start in background");
  } finally {
    fsForPatch.rm = originalRm;
    if (previousReleaseStorageRoot === undefined) {
      delete process.env.CHORDV_RELEASE_STORAGE_ROOT;
    } else {
      process.env.CHORDV_RELEASE_STORAGE_ROOT = previousReleaseStorageRoot;
    }
    if (previousCleanupBudget === undefined) {
      delete process.env.CHORDV_RUNTIME_COMPONENT_FILE_CLEANUP_BUDGET_MS;
    } else {
      process.env.CHORDV_RUNTIME_COMPONENT_FILE_CLEANUP_BUDGET_MS = previousCleanupBudget;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testRuntimeComponentDeleteIgnoresInvalidStoredCleanupPathAfterLocalDelete() {
  const warnings: string[] = [];
  let deleteCalled = false;
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
    storedFilePath: "../outside/xray.exe",
    fileSizeBytes: 10n,
    fileHash: "a".repeat(64),
    archiveEntryName: null,
    expectedHash: "a".repeat(64),
    enabled: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z")
  };
  const service = createRuntimeComponentsService({
    logger: {
      warn: (message: string) => warnings.push(message)
    },
    ensureRuntimeComponentExists: async () => current,
    prisma: {
      runtimeComponent: {
        delete: async () => {
          deleteCalled = true;
          return {};
        }
      }
    }
  });

  const result = await Promise.race([
    service.deleteAdminRuntimeComponent("component_1"),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("runtime component delete waited for invalid cleanup path")), 250);
    })
  ]);

  assert.equal(deleteCalled, true);
  assert.deepEqual(result, { id: "component_1", deleted: true });
  await waitUntil(() => warnings.length > 0);
  assert.match(warnings[0] ?? "", /cleanup path is invalid/);
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
        queueDirectSubscriptionAccessSyncTx: async () => 0,
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
  // 单独修改 expectedHash 不应清空远程文件元数据。
  assert.equal(updates[0].data.storedFilePath, undefined);
  assert.equal(updates[0].data.fileSizeBytes, undefined);
  assert.equal(updates[0].data.fileHash, undefined);
}

async function testRuntimeComponentDeleteMapsLocalSaveFailure() {
  const service = createRuntimeComponentsService({
    ensureRuntimeComponentExists: async () => ({
      id: "component_1",
      storedFilePath: "component_1/xray.exe"
    }),
    prisma: {
      runtimeComponent: {
        delete: async () => {
          throw new Error("runtime component delete local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.deleteAdminRuntimeComponent("component_1"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/runtime component delete local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "runtime component delete local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testExternalReleaseFlowPublishesAndFeedsClientUpdateCheck() {
  const { service } = createInMemoryReleaseCenterHarness();
  const release = await service.createRelease({
    platform: "windows",
    channel: "stable",
    version: "1.1.7",
    displayTitle: "",
    changelog: ["External full replacement"],
    minimumVersion: "1.1.0",
    forceUpgrade: false,
    status: "draft"
  });

  const externalHash = "a".repeat(64);
  await service.createReleaseArtifact(release.id, {
    source: "external",
    type: "zip",
    deliveryMode: "desktop_full_replace",
    downloadUrl: "https://cdn.example.com/ChordV_1.1.7_x64-full.zip",
    fileName: "ChordV_1.1.7_x64-full.zip",
    fileHash: externalHash,
    fileSizeBytes: "104857600",
    isPrimary: true
  });
  await service.publishRelease(release.id);

  const result = await service.checkClientUpdate({
    currentVersion: "1.1.6",
    platform: "windows",
    channel: "stable",
    artifactType: "zip"
  });

  assert.equal(result.hasUpdate, true);
  assert.equal(result.latestVersion, "1.1.7");
  assert.equal(result.downloadUrl, "https://cdn.example.com/ChordV_1.1.7_x64-full.zip");
  assert.equal(result.fileHash, externalHash);
  assert.equal(result.fileSizeBytes, "104857600");
  assert.equal(result.recommendedArtifact?.source, "external");
  assert.equal(result.recommendedArtifact?.defaultMirrorPrefix, null);
  assert.equal(result.recommendedArtifact?.allowClientMirror, false);
}

async function testUploadedReleaseFlowPublishesAndFeedsClientDownloadDescriptor() {
  const previousReleaseStorageRoot = process.env.CHORDV_RELEASE_STORAGE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), "chordv-release-flow-upload-"));
  const uploadPath = path.join(tempDir, "upload.tmp");
  const uploadBody = "uploaded full package";
  process.env.CHORDV_RELEASE_STORAGE_ROOT = tempDir;
  await writeFile(uploadPath, uploadBody);

  try {
    const { service } = createInMemoryReleaseCenterHarness();
    const release = await service.createRelease({
      platform: "windows",
      channel: "stable",
      version: "1.1.8",
      displayTitle: "ChordV 1.1.8",
      changelog: ["Uploaded full replacement"],
      minimumVersion: "1.1.0",
      forceUpgrade: false,
      status: "draft"
    });

    await service.uploadReleaseArtifact(
      release.id,
      {
        type: "zip",
        deliveryMode: "desktop_full_replace",
        fileName: "ChordV_1.1.8_x64-full.zip",
        isPrimary: true
      },
      {
        path: uploadPath,
        originalname: "ChordV_1.1.8_x64-full.zip",
        size: Buffer.byteLength(uploadBody)
      }
    );
    await service.publishRelease(release.id);

    const result = await service.checkClientUpdate({
      currentVersion: "1.1.7",
      platform: "windows",
      channel: "stable",
      artifactType: "zip"
    });

    assert.equal(result.hasUpdate, true);
    assert.equal(result.latestVersion, "1.1.8");
    assert.match(result.downloadUrl ?? "", /^\/api\/downloads\/releases\/artifact_/);
    assert.match(result.fileHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(result.fileSizeBytes, String(Buffer.byteLength(uploadBody)));
    assert.equal(result.recommendedArtifact?.source, "uploaded");
    assert.equal(result.recommendedArtifact?.defaultMirrorPrefix, null);
    assert.equal(result.recommendedArtifact?.allowClientMirror, false);

    const descriptor = await service.getReleaseArtifactDownloadDescriptor(result.recommendedArtifact?.id ?? "");
    assert.equal(descriptor.fileName, "ChordV_1.1.8_x64-full.zip");
    assert.equal(existsSync(descriptor.absolutePath), true);
  } finally {
    if (previousReleaseStorageRoot === undefined) {
      delete process.env.CHORDV_RELEASE_STORAGE_ROOT;
    } else {
      process.env.CHORDV_RELEASE_STORAGE_ROOT = previousReleaseStorageRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testCreateReleaseArtifactKeepsSaveWhenReleaseRefreshFails() {
  const release = makeReleaseCenterTestRelease();
  const createdArtifact = makeReleaseCenterTestArtifact({
    id: "artifact_created",
    isPrimary: true
  });
  let releaseFindCalls = 0;
  let transactionCalled = false;
  let metadataProbeCalled = false;
  let createdData: Record<string, any> | null = null;
  const service = createReleaseCenterService({
    resolveExternalReleaseArtifactMetadata: async () => {
      metadataProbeCalled = true;
      throw new Error("save must not probe external artifact metadata");
    },
    logger: {
      warn: () => undefined
    },
    prisma: {
      release: {
        findUnique: async () => {
          releaseFindCalls += 1;
          if (releaseFindCalls > 1) {
            throw new Error("release refresh failed after local artifact save");
          }
          return release;
        }
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) => {
        transactionCalled = true;
        return task({
          releaseArtifact: {
            updateMany: async () => ({ count: 0 }),
            create: async (payload: Record<string, any>) => {
              createdData = payload.data;
              return {
                ...createdArtifact,
                ...payload.data
              };
            }
          }
        });
      }
    }
  });

  const result = await service.createReleaseArtifact("release_1", {
    type: "zip",
    deliveryMode: "desktop_full_replace",
    downloadUrl: createdArtifact.downloadUrl,
    defaultMirrorPrefix: "https://ghfast.top/",
    allowClientMirror: true,
    fileName: createdArtifact.fileName,
    fileSizeBytes: Number(createdArtifact.fileSizeBytes),
    fileHash: createdArtifact.fileHash,
    isPrimary: true
  });

  assert.equal(transactionCalled, true, "artifact must be saved before response refresh fails");
  assert.equal(metadataProbeCalled, false, "saving an external artifact must not probe or download the remote file");
  assert.equal(createdData?.defaultMirrorPrefix, null, "external release artifacts must keep the origin URL without default mirrors");
  assert.equal(createdData?.allowClientMirror, false, "external release artifacts must not enable client mirror rewriting");
  assert.equal(result.id, "release_1");
  assert.equal(result.artifacts[0]?.id, createdData?.id);
}

async function testCreateReleaseArtifactPublishesAdminRefreshEvent() {
  const release = makeReleaseCenterTestRelease();
  const createdArtifact = makeReleaseCenterTestArtifact({
    id: "artifact_created",
    isPrimary: true
  });
  const adminEvents: string[] = [];
  const service = createReleaseCenterService({
    adminRuntimeEventsService: {
      publishReleaseCenterUpdated: () => {
        adminEvents.push("release_center_updated");
      }
    },
    prisma: {
      release: {
        findUnique: async () => release
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          releaseArtifact: {
            updateMany: async () => ({ count: 0 }),
            create: async (payload: Record<string, any>) => ({
              ...createdArtifact,
              ...payload.data
            })
          }
        })
    }
  });

  const result = await service.createReleaseArtifact("release_1", {
    type: "zip",
    deliveryMode: "desktop_full_replace",
    downloadUrl: createdArtifact.downloadUrl,
    fileName: createdArtifact.fileName,
    isPrimary: true
  });

  assert.equal(result.id, "release_1");
  assert.deepEqual(adminEvents, ["release_center_updated"]);
}

async function testCreateReleaseArtifactReturnsFallbackWhenReleaseRefreshStalls() {
  const release = makeReleaseCenterTestRelease();
  const createdArtifact = makeReleaseCenterTestArtifact({
    id: "artifact_created",
    isPrimary: true
  });
  let releaseFindCalls = 0;
  let createdArtifactId: string | null = null;
  const service = createReleaseCenterService({
    logger: {
      warn: () => undefined
    },
    prisma: {
      release: {
        findUnique: async () => {
          releaseFindCalls += 1;
          if (releaseFindCalls > 1) {
            return new Promise(() => undefined);
          }
          return release;
        }
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          releaseArtifact: {
            updateMany: async () => ({ count: 0 }),
            create: async (payload: Record<string, any>) => {
              createdArtifactId = payload.data.id;
              return {
                ...createdArtifact,
                ...payload.data
              };
            }
          }
        })
    }
  });

  const result = await Promise.race([
    service.createReleaseArtifact("release_1", {
      type: "zip",
      deliveryMode: "desktop_full_replace",
      downloadUrl: createdArtifact.downloadUrl,
      fileName: createdArtifact.fileName,
      isPrimary: true
    }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("release artifact save waited for stalled response refresh")), 750);
    })
  ]);

  assert.equal(result.id, "release_1");
  assert.equal(result.artifacts[0]?.id, createdArtifactId);
}

async function testCreateWindowsFullReplaceExternalArtifactAllowsNonZipUrlWhenExplicit() {
  const release = makeReleaseCenterTestRelease();
  const createdArtifact = makeReleaseCenterTestArtifact({
    id: "artifact_created",
    isPrimary: true
  });
  let releaseFindCalls = 0;
  let createdData: Record<string, any> | null = null;
  let metadataProbeCalled = false;
  const service = createReleaseCenterService({
    resolveExternalReleaseArtifactMetadata: async () => {
      metadataProbeCalled = true;
      throw new Error("saving an explicit external full package must not probe remote metadata");
    },
    logger: {
      warn: () => undefined
    },
    prisma: {
      release: {
        findUnique: async () => {
          releaseFindCalls += 1;
          if (releaseFindCalls > 1) {
            throw new Error("release refresh failed after local artifact save");
          }
          return release;
        }
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          releaseArtifact: {
            updateMany: async () => ({ count: 0 }),
            create: async (payload: Record<string, any>) => {
              createdData = payload.data;
              return {
                ...createdArtifact,
                ...payload.data
              };
            }
          }
        })
    }
  });

  const result = await service.createReleaseArtifact("release_1", {
    source: "external",
    type: "zip",
    deliveryMode: "desktop_full_replace",
    downloadUrl: "https://cdn.example.com/download?id=ChordV_1.1.6_x64-full",
    isPrimary: true
  });

  assert.equal(metadataProbeCalled, false);
  assert.equal(createdData?.type, "zip");
  assert.equal(createdData?.deliveryMode, "desktop_full_replace");
  assert.equal(createdData?.downloadUrl, "https://cdn.example.com/download?id=ChordV_1.1.6_x64-full");
  assert.equal(createdData?.fileName ?? null, null);
  assert.equal(createdData?.fileSizeBytes, null);
  assert.equal(createdData?.fileHash, null);
  assert.equal(result.artifacts[0]?.id, createdData?.id);
}

async function testCreateReleaseArtifactMapsLocalSaveFailure() {
  const release = makeReleaseCenterTestRelease();
  const service = createReleaseCenterService({
    prisma: {
      release: {
        findUnique: async () => release
      },
      $transaction: async () => {
        throw new Error("release artifact create local save failed");
      }
    }
  });

  await assert.rejects(
    () =>
      service.createReleaseArtifact("release_1", {
        type: "zip",
        deliveryMode: "desktop_full_replace",
        downloadUrl: "https://example.com/ChordV_1.1.6_x64-full.zip"
      }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/release artifact create local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "release artifact create local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testUpdateExternalReleaseArtifactDoesNotProbeRemoteMetadataBeforeSave() {
  const release = makeReleaseCenterTestRelease();
  const currentArtifact = makeReleaseCenterTestArtifact({
    id: "artifact_existing",
    downloadUrl: "https://example.com/old.zip",
    fileName: "old.zip",
    fileSizeBytes: 1024n,
    fileHash: "a".repeat(64)
  });
  let metadataProbeCalled = false;
  const updates: Array<Record<string, any>> = [];
  const service = createReleaseCenterService({
    resolveExternalReleaseArtifactMetadata: async () => {
      metadataProbeCalled = true;
      throw new Error("save must not probe external artifact metadata");
    },
    prisma: {
      releaseArtifact: {
        findFirst: async () => currentArtifact,
        update: async (payload: Record<string, any>) => {
          updates.push(payload);
          return {
            ...currentArtifact,
            ...payload.data
          };
        }
      },
      release: {
        findUnique: async () => release
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          releaseArtifact: {
            updateMany: async () => ({ count: 0 }),
            update: async (payload: Record<string, any>) => {
              updates.push(payload);
              return {
                ...currentArtifact,
                ...payload.data
              };
            }
          }
        })
    }
  });

  const result = await service.updateReleaseArtifact("release_1", "artifact_existing", {
    source: "external",
    type: "zip",
    deliveryMode: "desktop_full_replace",
    downloadUrl: "https://example.com/new.zip",
    defaultMirrorPrefix: "https://ghfast.top/",
    allowClientMirror: true,
    isPrimary: true
  });

  assert.equal(metadataProbeCalled, false, "editing an external artifact must not probe or download the remote file");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.downloadUrl, "https://example.com/new.zip");
  assert.equal(updates[0].data.defaultMirrorPrefix, null);
  assert.equal(updates[0].data.allowClientMirror, false);
  assert.equal(updates[0].data.fileName, null);
  assert.equal(updates[0].data.fileSizeBytes, null);
  assert.equal(updates[0].data.fileHash, null);
  assert.equal(result.id, "release_1");
}

async function testUpdateReleaseArtifactMapsLocalSaveFailure() {
  const release = makeReleaseCenterTestRelease();
  const currentArtifact = makeReleaseCenterTestArtifact({
    id: "artifact_existing"
  });
  const service = createReleaseCenterService({
    prisma: {
      releaseArtifact: {
        findFirst: async () => currentArtifact
      },
      release: {
        findUnique: async () => release
      },
      $transaction: async () => {
        throw new Error("release artifact update local save failed");
      }
    }
  });

  await assert.rejects(
    () =>
      service.updateReleaseArtifact("release_1", "artifact_existing", {
        fileName: "ChordV_1.1.6_x64-full.zip"
      }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/release artifact update local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "release artifact update local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testUpdateWindowsExternalReleaseInfersExternalForExeUrl() {
  const artifact = makeReleaseCenterTestArtifact({
    id: "artifact_existing",
    source: "external",
    type: "zip",
    deliveryMode: "desktop_full_replace",
    fileName: "ChordV-old.zip",
    downloadUrl: "https://example.com/ChordV-old.zip"
  });
  const updates: Array<Record<string, any>> = [];
  const service = createReleaseCenterService({
    prisma: {
      releaseArtifact: {
        findFirst: async () => artifact,
        update: async (payload: Record<string, any>) => {
          updates.push(payload);
          return {
            ...artifact,
            ...payload.data
          };
        }
      },
      release: {
        findUnique: async () =>
          makeReleaseCenterTestRelease({
            platform: "windows",
            artifacts: [artifact]
          })
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          releaseArtifact: {
            updateMany: async () => ({ count: 0 }),
            update: async (payload: Record<string, any>) => {
              updates.push(payload);
              return {
                ...artifact,
                ...payload.data
              };
            }
          }
        })
    }
  });

  const result = await service.updateReleaseArtifact("release_1", "artifact_existing", {
    downloadUrl: "https://example.com/ChordV-setup.exe"
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.downloadUrl, "https://example.com/ChordV-setup.exe");
  assert.equal(updates[0].data.type, "external");
  assert.equal(updates[0].data.deliveryMode, "external_download");
  assert.equal(result.id, "release_1");
}

async function testUpdateWindowsExternalReleaseInfersFullReplaceForZipUrl() {
  const artifact = makeReleaseCenterTestArtifact({
    id: "artifact_existing",
    source: "external",
    type: "external",
    deliveryMode: "external_download",
    fileName: null,
    downloadUrl: "https://example.com/chordv/windows/latest"
  });
  const updates: Array<Record<string, any>> = [];
  const service = createReleaseCenterService({
    prisma: {
      releaseArtifact: {
        findFirst: async () => artifact,
        update: async (payload: Record<string, any>) => {
          updates.push(payload);
          return {
            ...artifact,
            ...payload.data
          };
        }
      },
      release: {
        findUnique: async () =>
          makeReleaseCenterTestRelease({
            platform: "windows",
            artifacts: [artifact]
          })
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          releaseArtifact: {
            updateMany: async () => ({ count: 0 }),
            update: async (payload: Record<string, any>) => {
              updates.push(payload);
              return {
                ...artifact,
                ...payload.data
              };
            }
          }
        })
    }
  });

  const result = await service.updateReleaseArtifact("release_1", "artifact_existing", {
    downloadUrl: "https://cdn.example.com/ChordV_1.1.6_x64-full.zip"
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.downloadUrl, "https://cdn.example.com/ChordV_1.1.6_x64-full.zip");
  assert.equal(updates[0].data.type, "zip");
  assert.equal(updates[0].data.deliveryMode, "desktop_full_replace");
  assert.equal(result.id, "release_1");
}

async function testUpdateWindowsFullReplaceExternalKeepsModeForNonZipUrl() {
  const artifact = makeReleaseCenterTestArtifact({
    id: "artifact_existing",
    source: "external",
    type: "zip",
    deliveryMode: "desktop_full_replace",
    fileName: "ChordV-old.zip",
    downloadUrl: "https://example.com/ChordV-old.zip"
  });
  const updates: Array<Record<string, any>> = [];
  const service = createReleaseCenterService({
    prisma: {
      releaseArtifact: {
        findFirst: async () => artifact,
        update: async (payload: Record<string, any>) => {
          updates.push(payload);
          return {
            ...artifact,
            ...payload.data
          };
        }
      },
      release: {
        findUnique: async () =>
          makeReleaseCenterTestRelease({
            platform: "windows",
            artifacts: [artifact]
          })
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          releaseArtifact: {
            updateMany: async () => ({ count: 0 }),
            update: async (payload: Record<string, any>) => {
              updates.push(payload);
              return {
                ...artifact,
                ...payload.data
              };
            }
          }
        })
    }
  });

  const result = await service.updateReleaseArtifact("release_1", "artifact_existing", {
    downloadUrl: "https://cdn.example.com/download?id=ChordV_1.1.6_x64-full"
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.downloadUrl, "https://cdn.example.com/download?id=ChordV_1.1.6_x64-full");
  assert.equal(updates[0].data.type, "zip");
  assert.equal(updates[0].data.deliveryMode, "desktop_full_replace");
  assert.equal(updates[0].data.fileSizeBytes, null);
  assert.equal(updates[0].data.fileHash, null);
  assert.equal(result.id, "release_1");
}

async function testUploadReleaseArtifactSavesWithoutHashAfterZipValidation() {
  const tempDir = await mkdtemp(path.join(tmpdir(), "release-upload-valid-zip-"));
  const preparedPath = path.join(tempDir, "ChordV_1.1.6_x64-full.zip");
  const zip = createValidWindowsFullUpdateZip("1.1.6");
  await writeFile(preparedPath, zip);
  const release = makeReleaseCenterTestRelease({
    version: "1.1.6"
  });
  let preparedCalled = false;
  let createdData: Record<string, any> | null = null;
  try {
    const service = createReleaseCenterService({
      ensureReleaseExists: async () => release,
      assertReleaseArtifactsMutable: () => undefined,
      prepareUploadedReleaseArtifactFile: async () => {
        preparedCalled = true;
        return {
          absolutePath: preparedPath,
          storedFilePath: "release_1/artifact_created/ChordV_1.1.6_x64-full.zip",
          fileName: "ChordV_1.1.6_x64-full.zip",
          fileSizeBytes: BigInt(zip.byteLength),
          fileHash: null,
          downloadUrl: "/api/downloads/releases/artifact_created"
        };
      },
      prisma: {
        $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
          task({
            releaseArtifact: {
              updateMany: async () => ({ count: 0 }),
              create: async (payload: Record<string, any>) => {
                createdData = payload.data;
                return makeReleaseCenterTestArtifact({
                  id: payload.data.id,
                  releaseId: payload.data.releaseId,
                  source: payload.data.source,
                  type: payload.data.type,
                  deliveryMode: payload.data.deliveryMode,
                  downloadUrl: payload.data.downloadUrl,
                  fileName: payload.data.fileName,
                  storedFilePath: payload.data.storedFilePath,
                  fileSizeBytes: payload.data.fileSizeBytes,
                  fileHash: payload.data.fileHash,
                  isPrimary: payload.data.isPrimary,
                  isFullPackage: payload.data.isFullPackage
                });
              }
            }
          }),
        release: {
          findUnique: async () => ({
            ...release,
            artifacts: []
          })
        }
      }
    });

    const result = await service.uploadReleaseArtifact(
      "release_1",
      {
        type: "zip",
        deliveryMode: "desktop_full_replace",
        isPrimary: true
      },
      {
        path: "uploaded-valid-zip.tmp",
        originalname: "ChordV_1.1.6_x64-full.zip",
        size: zip.byteLength
      }
    );

    assert.equal(preparedCalled, true);
    assert.equal(createdData?.fileHash, null, "uploaded release artifacts should not require SHA256 metadata");
    assert.equal(createdData?.fileSizeBytes, BigInt(zip.byteLength));
    assert.equal(createdData?.deliveryMode, "desktop_full_replace");
    assert.equal(result.id, "release_1");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testUploadReleaseArtifactSavesReadableWindowsZipWithoutDeepInspection() {
  const tempDir = await mkdtemp(path.join(tmpdir(), "release-upload-invalid-zip-"));
  const preparedPath = path.join(tempDir, "ChordV_1.1.6_x64-full.zip");
  await writeFile(preparedPath, Buffer.from("not a zip"));
  const release = makeReleaseCenterTestRelease({
    version: "1.1.6"
  });
  let createdData: Record<string, any> | null = null;
  try {
    const service = createReleaseCenterService({
      ensureReleaseExists: async () => release,
      assertReleaseArtifactsMutable: () => undefined,
      prepareUploadedReleaseArtifactFile: async () => ({
        absolutePath: preparedPath,
        storedFilePath: "release_1/artifact_created/ChordV_1.1.6_x64-full.zip",
        fileName: "ChordV_1.1.6_x64-full.zip",
        fileSizeBytes: 9n,
        fileHash: null,
        downloadUrl: "/api/downloads/releases/artifact_created"
      }),
      cleanupFailedReleaseArtifactUpload: async () => undefined,
      prisma: {
        $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
          task({
            releaseArtifact: {
              updateMany: async () => ({ count: 0 }),
              create: async (payload: Record<string, any>) => {
                createdData = payload.data;
                return makeReleaseCenterTestArtifact({
                  id: payload.data.id,
                  releaseId: payload.data.releaseId,
                  source: payload.data.source,
                  type: payload.data.type,
                  deliveryMode: payload.data.deliveryMode,
                  downloadUrl: payload.data.downloadUrl,
                  fileName: payload.data.fileName,
                  storedFilePath: payload.data.storedFilePath,
                  fileSizeBytes: payload.data.fileSizeBytes,
                  fileHash: payload.data.fileHash,
                  isPrimary: payload.data.isPrimary,
                  isFullPackage: payload.data.isFullPackage
                });
              }
            }
          })
      }
    });

    const result = await service.uploadReleaseArtifact(
      "release_1",
      {
        type: "zip",
        deliveryMode: "desktop_full_replace",
        isPrimary: true
      },
      {
        path: "uploaded-invalid-zip.tmp",
        originalname: "ChordV_1.1.6_x64-full.zip",
        size: 9
      }
    );
    assert.equal(createdData?.type, "zip");
    assert.equal(createdData?.deliveryMode, "desktop_full_replace");
    assert.equal(result.id, "release_1");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testReleaseArtifactPrepareMissingTempFileReturnsBadRequest() {
  const previousStorageRoot = process.env.CHORDV_RELEASE_STORAGE_ROOT;
  const storageRoot = await mkdtemp(path.join(tmpdir(), "release-upload-missing-"));
  process.env.CHORDV_RELEASE_STORAGE_ROOT = storageRoot;
  const service = createReleaseCenterService();

  try {
    await assert.rejects(
      () =>
        service["prepareUploadedReleaseArtifactFile"](
          "release_1",
          "artifact_1",
          {
            path: path.join(storageRoot, "missing-release-upload.tmp"),
            originalname: "ChordV_1.1.6_x64-full.zip",
            size: 1
          },
          "ChordV_1.1.6_x64-full.zip"
        ),
      BadRequestException,
      "missing release artifact temporary upload must return a controlled 400 instead of HTTP 500"
    );
  } finally {
    if (previousStorageRoot === undefined) {
      delete process.env.CHORDV_RELEASE_STORAGE_ROOT;
    } else {
      process.env.CHORDV_RELEASE_STORAGE_ROOT = previousStorageRoot;
    }
    await rm(storageRoot, { recursive: true, force: true });
  }
}

async function testWindowsExeUploadIsRejectedForFullReplacementUpdates() {
  const release = makeReleaseCenterTestRelease({
    version: "1.1.6"
  });
  let preparedCalled = false;
  const service = createReleaseCenterService({
    ensureReleaseExists: async () => release,
    assertReleaseArtifactsMutable: () => undefined,
    prepareUploadedReleaseArtifactFile: async () => {
      preparedCalled = true;
      return {
        absolutePath: "prepared-windows-setup.exe",
        storedFilePath: "release_1/artifact_created/ChordV-setup.exe",
        fileName: "ChordV-setup.exe",
        fileSizeBytes: 123n,
        fileHash: null,
        downloadUrl: "/api/downloads/releases/artifact_created"
      };
    },
    prisma: {
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          releaseArtifact: {
            updateMany: async () => ({ count: 0 }),
            create: async () => {
              throw new Error("Windows .exe upload should be rejected before writing an artifact");
            }
          }
        }),
      release: {
        findUnique: async () => ({
          ...release,
          artifacts: []
        })
      }
    }
  });

  await assert.rejects(
    () =>
      service.uploadReleaseArtifact(
        "release_1",
        {
          type: "zip",
          deliveryMode: "desktop_full_replace",
          fileName: "ChordV_1.1.6_x64-full.zip"
        },
        {
          path: "windows-setup-upload.tmp",
          originalname: "ChordV-setup.exe",
          size: 123
        }
      ),
    /ZIP/i
  );
  assert.equal(preparedCalled, false);
}

async function testUploadReleaseArtifactFailureUsesBestEffortCleanup() {
  const release = makeReleaseCenterTestRelease();
  const cleanupCalls: Array<{ absolutePath: string | null; label: string }> = [];
  const service = createReleaseCenterService({
    ensureReleaseExists: async () => release,
    assertReleaseArtifactsMutable: () => undefined,
    assertUploadedReleaseArtifactValidForWindowsFullUpdate: async () => undefined,
    prepareUploadedReleaseArtifactFile: async () => ({
      absolutePath: "missing-prepared-release.zip",
      storedFilePath: "release_1/artifact_1/ChordV-full.zip",
      fileName: "ChordV-full.zip",
      fileSizeBytes: 123n,
      fileHash: "a".repeat(64),
      downloadUrl: "/api/downloads/releases/artifact_1"
    }),
    cleanupFailedReleaseArtifactUpload: async (absolutePath: string | null, label: string) => {
      cleanupCalls.push({ absolutePath, label });
    },
    prisma: {
      $transaction: async () => {
        throw new Error("release artifact create failed");
      }
    }
  });

  await assert.rejects(
    () =>
      service.uploadReleaseArtifact(
        "release_1",
        {
          type: "zip",
          deliveryMode: "desktop_full_replace",
          isPrimary: true
        },
        {
          path: "missing-upload-release.zip",
          originalname: "ChordV-full.zip",
          size: 123
        }
      ),
    (error) =>
      error instanceof ServiceUnavailableException &&
      /安装包保存失败/.test(error.message) &&
      /已尝试清理本次上传文件/.test(error.message) &&
      !/已清理本次上传文件/.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "release artifact local save failures must return a controlled 503 instead of HTTP 500"
  );
  assert.deepEqual(cleanupCalls, [
    { absolutePath: "missing-prepared-release.zip", label: "failed release artifact upload" }
  ]);
}

async function testUploadReleaseArtifactMapsTransientPrismaFailure() {
  const release = makeReleaseCenterTestRelease();
  const cleanupCalls: Array<{ absolutePath: string | null; label: string }> = [];
  const service = createReleaseCenterService({
    ensureReleaseExists: async () => release,
    assertReleaseArtifactsMutable: () => undefined,
    assertUploadedReleaseArtifactValidForWindowsFullUpdate: async () => undefined,
    prepareUploadedReleaseArtifactFile: async () => ({
      absolutePath: "missing-prepared-release-transient.zip",
      storedFilePath: "release_1/artifact_1/ChordV-full.zip",
      fileName: "ChordV-full.zip",
      fileSizeBytes: 123n,
      fileHash: "a".repeat(64),
      downloadUrl: "/api/downloads/releases/artifact_1"
    }),
    cleanupFailedReleaseArtifactUpload: async (absolutePath: string | null, label: string) => {
      cleanupCalls.push({ absolutePath, label });
    },
    prisma: {
      $transaction: async () => {
        throw { code: "P2028", message: "Transaction already closed" };
      }
    }
  });

  await assert.rejects(
    () =>
      service.uploadReleaseArtifact(
        "release_1",
        {
          type: "zip",
          deliveryMode: "desktop_full_replace",
          isPrimary: true
        },
        {
          path: "missing-upload-release-transient.zip",
          originalname: "ChordV-full.zip",
          size: 123
        }
      ),
    ServiceUnavailableException,
    "release artifact transient Prisma failures must return a controlled 503 instead of HTTP 500"
  );
  assert.deepEqual(cleanupCalls, [
    { absolutePath: "missing-prepared-release-transient.zip", label: "failed release artifact upload" }
  ]);
}

async function testReplaceReleaseArtifactUploadFailureUsesBestEffortCleanup() {
  const release = makeReleaseCenterTestRelease();
  const artifact = makeReleaseCenterTestArtifact({
    id: "artifact_1",
    type: "zip",
    deliveryMode: "desktop_full_replace",
    storedFilePath: "release_1/artifact_1/old.zip"
  });
  const cleanupCalls: Array<{ absolutePath: string | null; label: string }> = [];
  const service = createReleaseCenterService({
    ensureReleaseExists: async () => release,
    assertReleaseArtifactsMutable: () => undefined,
    assertUploadedReleaseArtifactValidForWindowsFullUpdate: async () => undefined,
    prepareUploadedReleaseArtifactFile: async () => ({
      absolutePath: "missing-prepared-replacement-release.zip",
      storedFilePath: "release_1/artifact_1/ChordV-full-new.zip",
      fileName: "ChordV-full-new.zip",
      fileSizeBytes: 123n,
      fileHash: "a".repeat(64),
      downloadUrl: "/api/downloads/releases/artifact_1"
    }),
    cleanupFailedReleaseArtifactUpload: async (absolutePath: string | null, label: string) => {
      cleanupCalls.push({ absolutePath, label });
    },
    prisma: {
      releaseArtifact: {
        findFirst: async () => artifact
      },
      $transaction: async () => {
        throw new Error("release artifact update failed");
      }
    }
  });

  await assert.rejects(
    () =>
      service.replaceReleaseArtifactUpload(
        "release_1",
        "artifact_1",
        {
          type: "zip",
          deliveryMode: "desktop_full_replace",
          isPrimary: true
        },
        {
          path: "missing-upload-replacement-release.zip",
          originalname: "ChordV-full-new.zip",
          size: 123
        }
      ),
    (error) =>
      error instanceof ServiceUnavailableException &&
      /安装包替换失败/.test(error.message) &&
      /已尝试清理本次上传文件/.test(error.message) &&
      !/已清理本次上传文件/.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "release artifact replacement local save failures must return a controlled 503 instead of HTTP 500"
  );
  assert.deepEqual(cleanupCalls, [
    { absolutePath: "missing-prepared-replacement-release.zip", label: "failed release artifact replacement upload" }
  ]);
}

async function testReplaceReleaseArtifactUploadMapsTransientPrismaFailure() {
  const release = makeReleaseCenterTestRelease();
  const artifact = makeReleaseCenterTestArtifact({
    id: "artifact_1",
    type: "zip",
    deliveryMode: "desktop_full_replace",
    storedFilePath: "release_1/artifact_1/old.zip"
  });
  const cleanupCalls: Array<{ absolutePath: string | null; label: string }> = [];
  const service = createReleaseCenterService({
    ensureReleaseExists: async () => release,
    assertReleaseArtifactsMutable: () => undefined,
    assertUploadedReleaseArtifactValidForWindowsFullUpdate: async () => undefined,
    prepareUploadedReleaseArtifactFile: async () => ({
      absolutePath: "missing-prepared-replacement-release-transient.zip",
      storedFilePath: "release_1/artifact_1/ChordV-full-new.zip",
      fileName: "ChordV-full-new.zip",
      fileSizeBytes: 123n,
      fileHash: "a".repeat(64),
      downloadUrl: "/api/downloads/releases/artifact_1"
    }),
    cleanupFailedReleaseArtifactUpload: async (absolutePath: string | null, label: string) => {
      cleanupCalls.push({ absolutePath, label });
    },
    prisma: {
      releaseArtifact: {
        findFirst: async () => artifact
      },
      $transaction: async () => {
        throw { code: "P2034", message: "Transaction failed due to a write conflict" };
      }
    }
  });

  await assert.rejects(
    () =>
      service.replaceReleaseArtifactUpload(
        "release_1",
        "artifact_1",
        {
          type: "zip",
          deliveryMode: "desktop_full_replace",
          isPrimary: true
        },
        {
          path: "missing-upload-replacement-release-transient.zip",
          originalname: "ChordV-full-new.zip",
          size: 123
        }
      ),
    ServiceUnavailableException,
    "release artifact replacement transient Prisma failures must return a controlled 503 instead of HTTP 500"
  );
  assert.deepEqual(cleanupCalls, [
    { absolutePath: "missing-prepared-replacement-release-transient.zip", label: "failed release artifact replacement upload" }
  ]);
}

async function testReplaceReleaseArtifactUploadMapsLocalReadFailure() {
  const service = createReleaseCenterService({
    prisma: {
      releaseArtifact: {
        findFirst: async () => {
          throw new Error("release artifact replacement preflight read failed");
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.replaceReleaseArtifactUpload(
        "release_1",
        "artifact_1",
        {
          type: "zip",
          deliveryMode: "desktop_full_replace",
          isPrimary: true
        },
        {
          path: "missing-upload-replacement-read-failure.zip",
          originalname: "ChordV-full-new.zip",
          size: 123
        }
      ),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/release artifact replacement preflight read failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "release artifact replacement preflight read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testUpdateUploadedReleaseArtifactToExternalDeletesOldFile() {
  const previousReleaseStorageRoot = process.env.CHORDV_RELEASE_STORAGE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), "chordv-release-switch-"));
  process.env.CHORDV_RELEASE_STORAGE_ROOT = tempDir;
  const oldStoredFilePath = path.join("release_1", "artifact_1", "old-upload.zip");
  const oldAbsolutePath = path.resolve(tempDir, oldStoredFilePath);
  await mkdir(path.dirname(oldAbsolutePath), { recursive: true });
  await writeFile(oldAbsolutePath, Buffer.from("old-upload"));
  const currentArtifact = makeReleaseCenterTestArtifact({
    id: "artifact_1",
    source: "uploaded",
    downloadUrl: "/api/downloads/releases/artifact_1",
    storedFilePath: oldStoredFilePath,
    allowClientMirror: false,
    fileName: "old-upload.zip"
  });
  const release = makeReleaseCenterTestRelease({
    artifacts: [currentArtifact]
  });
  const updates: Array<Record<string, any>> = [];
  try {
    const service = createReleaseCenterService({
      prisma: {
        releaseArtifact: {
          findFirst: async () => currentArtifact
        },
        release: {
          findUnique: async () => ({
            ...release,
            artifacts: [
              makeReleaseCenterTestArtifact({
                ...currentArtifact,
                source: "external",
                downloadUrl: "https://example.com/new.zip",
                storedFilePath: null,
                fileName: null,
                fileSizeBytes: 104857600n,
                fileHash: null
              })
            ]
          })
        },
        $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
          task({
            releaseArtifact: {
              updateMany: async () => ({ count: 1 }),
              update: async (payload: Record<string, any>) => {
                updates.push(payload);
                return {
                  ...currentArtifact,
                  ...payload.data
                };
              }
            }
          })
      }
    });

    const result = await service.updateReleaseArtifact("release_1", "artifact_1", {
      source: "external",
      type: "zip",
      deliveryMode: "desktop_full_replace",
      downloadUrl: "https://example.com/new.zip",
      isPrimary: true
    });

    assert.equal(updates.length, 1);
    assert.equal(updates[0].data.source, "external");
    assert.equal(updates[0].data.storedFilePath, null);
    assert.equal(updates[0].data.fileSizeBytes, null);
    assert.equal(updates[0].data.fileHash, null);
    assert.equal(result.id, "release_1");
    assert.equal(existsSync(oldAbsolutePath), true, "switching uploaded artifacts to external must not wait for old file cleanup");
    await waitUntil(() => !existsSync(oldAbsolutePath));
    assert.equal(existsSync(oldAbsolutePath), false, "old uploaded file should still be removed in background");
  } finally {
    if (previousReleaseStorageRoot === undefined) {
      delete process.env.CHORDV_RELEASE_STORAGE_ROOT;
    } else {
      process.env.CHORDV_RELEASE_STORAGE_ROOT = previousReleaseStorageRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testReplaceReleaseArtifactUploadDeletesOldFileOnSuccess() {
  const previousReleaseStorageRoot = process.env.CHORDV_RELEASE_STORAGE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), "chordv-release-replace-"));
  process.env.CHORDV_RELEASE_STORAGE_ROOT = tempDir;
  const oldStoredFilePath = path.join("release_1", "artifact_1", "old-upload.zip");
  const newStoredFilePath = path.join("release_1", "artifact_1", "new-upload.zip");
  const oldAbsolutePath = path.resolve(tempDir, oldStoredFilePath);
  const newAbsolutePath = path.resolve(tempDir, newStoredFilePath);
  await mkdir(path.dirname(oldAbsolutePath), { recursive: true });
  await writeFile(oldAbsolutePath, Buffer.from("old-upload"));
  const currentArtifact = makeReleaseCenterTestArtifact({
    id: "artifact_1",
    source: "uploaded",
    downloadUrl: "/api/downloads/releases/artifact_1",
    storedFilePath: oldStoredFilePath,
    allowClientMirror: false,
    fileName: "old-upload.zip",
    isPrimary: false
  });
  const release = makeReleaseCenterTestRelease({
    artifacts: [currentArtifact]
  });
  let primaryCleared = false;
  const updates: Array<Record<string, any>> = [];
  try {
    const service = createReleaseCenterService({
      assertUploadedReleaseArtifactValidForWindowsFullUpdate: async () => undefined,
      prepareUploadedReleaseArtifactFile: async () => ({
        absolutePath: newAbsolutePath,
        storedFilePath: newStoredFilePath,
        fileName: "new-upload.zip",
        fileSizeBytes: 10n,
        fileHash: null,
        downloadUrl: "/api/downloads/releases/artifact_1"
      }),
      prisma: {
        releaseArtifact: {
          findFirst: async () => currentArtifact
        },
        release: {
          findUnique: async () => ({
            ...release,
            artifacts: [
              makeReleaseCenterTestArtifact({
                ...currentArtifact,
                storedFilePath: newStoredFilePath,
                fileName: "new-upload.zip",
                fileSizeBytes: 10n,
                fileHash: null,
                isPrimary: true
              })
            ]
          })
        },
        $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
          task({
            releaseArtifact: {
              updateMany: async () => {
                primaryCleared = true;
                return { count: 1 };
              },
              update: async (payload: Record<string, any>) => {
                updates.push(payload);
                return {
                  ...currentArtifact,
                  ...payload.data
                };
              }
            }
          })
      }
    });

    const result = await service.replaceReleaseArtifactUpload(
      "release_1",
      "artifact_1",
      {
        type: "zip",
        deliveryMode: "desktop_full_replace",
        isPrimary: true
      },
      {
        path: "new-upload.tmp",
        originalname: "new-upload.zip",
        size: 10
      }
    );

    assert.equal(primaryCleared, true, "primary siblings must be cleared when the replacement is primary");
    assert.equal(updates.length, 1);
    assert.equal(updates[0].data.source, "uploaded");
    assert.equal(updates[0].data.storedFilePath, newStoredFilePath);
    assert.equal(updates[0].data.fileName, "new-upload.zip");
    assert.equal(updates[0].data.fileSizeBytes, 10n);
    assert.equal(updates[0].data.fileHash, null);
    assert.equal(updates[0].data.isPrimary, true);
    assert.equal(result.id, "release_1");
    assert.equal(existsSync(oldAbsolutePath), true, "successful replacement must not wait for old file cleanup");
    await waitUntil(() => !existsSync(oldAbsolutePath));
    assert.equal(existsSync(oldAbsolutePath), false, "previous uploaded file should still be removed in background");
  } finally {
    if (previousReleaseStorageRoot === undefined) {
      delete process.env.CHORDV_RELEASE_STORAGE_ROOT;
    } else {
      process.env.CHORDV_RELEASE_STORAGE_ROOT = previousReleaseStorageRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testDeleteReleaseArtifactKeepsDeleteWhenFileCleanupFails() {
  const artifact = makeReleaseCenterTestArtifact({
    source: "uploaded",
    storedFilePath: "missing-release/artifact_1/ChordV.zip",
    allowClientMirror: false
  });
  const release = makeReleaseCenterTestRelease({
    artifacts: [artifact]
  });
  let deleteCalled = false;
  let deleted = false;
  const service = createReleaseCenterService({
    logger: {
      warn: () => undefined
    },
    prisma: {
      release: {
        findUnique: async () => ({
          ...release,
          artifacts: deleted ? [] : [artifact]
        })
      },
      releaseArtifact: {
        findFirst: async () => artifact,
        findMany: async () => [artifact]
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          releaseArtifact: {
            delete: async () => {
              deleteCalled = true;
              deleted = true;
              return artifact;
            },
            update: async () => undefined
          }
        })
    }
  });

  const result = await service.deleteReleaseArtifact("release_1", "artifact_1");

  assert.equal(deleteCalled, true, "artifact delete must complete before best-effort file cleanup");
  assert.equal(result.id, "release_1");
  assert.deepEqual(result.artifacts, []);
}

async function testDeleteReleaseArtifactMapsLocalSaveFailure() {
  const artifact = makeReleaseCenterTestArtifact();
  const service = createReleaseCenterService({
    prisma: {
      release: {
        findUnique: async () => makeReleaseCenterTestRelease({ artifacts: [artifact] })
      },
      releaseArtifact: {
        findFirst: async () => artifact,
        findMany: async () => [artifact]
      },
      $transaction: async () => {
        throw new Error("release artifact delete local save failed");
      }
    }
  });

  await assert.rejects(
    () => service.deleteReleaseArtifact("release_1", "artifact_1"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/release artifact delete local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "release artifact delete local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testCreateReleaseArtifactRejectsBlankExternalDownloadUrl() {
  const service = createReleaseCenterService({
    prisma: {
      release: {
        findUnique: async () => makeReleaseCenterTestRelease()
      }
    }
  });

  await assert.rejects(
    () =>
      service.createReleaseArtifact("release_1", {
        source: "external",
        type: "zip",
        deliveryMode: "desktop_full_replace",
        downloadUrl: "   ",
        fileSizeBytes: "123",
        fileHash: "a".repeat(64)
      }),
    /download|http\/https|URL|地址/i,
    "external release artifacts must not be saved with a blank downloadUrl"
  );
}

async function testPublishWindowsReleaseRejectsClientUnusableArtifact() {
  const setupArtifact = makeReleaseCenterTestArtifact({
    source: "external",
    type: "setup.exe",
    deliveryMode: "desktop_installer_download",
    downloadUrl: "https://example.com/ChordV-setup.exe",
    fileName: "ChordV-setup.exe",
    fileSizeBytes: 123n,
    fileHash: "a".repeat(64)
  });
  const service = createReleaseCenterService({
    prisma: {
      release: {
        findUnique: async () =>
          makeReleaseCenterTestRelease({
            platform: "windows",
            artifacts: [setupArtifact]
          })
      }
    }
  });

  await assert.rejects(
    () => service["assertReleasePublishable"]("release_1"),
    /可供客户端下载|Windows 安装包/
  );
}

async function testPublishWindowsReleaseAllowsClientUsableArtifact() {
  const fullZipArtifact = makeReleaseCenterTestArtifact({
    source: "external",
    type: "zip",
    deliveryMode: "desktop_full_replace",
    downloadUrl: "https://example.com/ChordV_1.1.6_x64-full.zip",
    fileName: "ChordV_1.1.6_x64-full.zip",
    fileSizeBytes: 123n,
    fileHash: "a".repeat(64)
  });
  const service = createReleaseCenterService({
    prisma: {
      release: {
        findUnique: async () =>
          makeReleaseCenterTestRelease({
            platform: "windows",
            artifacts: [fullZipArtifact]
          })
      }
    }
  });

  await service["assertReleasePublishable"]("release_1");
}


async function testReleaseArtifactContentValidationMatchesDownloadedBytes() {
  const tempDir = await mkdtemp(path.join(tmpdir(), "release-content-validation-"));
  const artifactPath = path.join(tempDir, "artifact.bin");
  const body = Buffer.from("verified external artifact");
  await writeFile(artifactPath, body);
  const actualHash = createHash("sha256").update(body).digest("hex");
  const artifact = makeReleaseCenterTestArtifact({
    source: "external",
    type: "dmg",
    deliveryMode: "desktop_installer_download",
    downloadUrl: "https://cdn.example.com/ChordV.dmg",
    fileName: "ChordV.dmg",
    fileSizeBytes: BigInt(body.byteLength),
    fileHash: actualHash
  });
  let cleanupCalls = 0;
  try {
    const service = createReleaseCenterService({
      assertReleaseArtifactContentMatchesMetadata:
        (ReleaseCenterService.prototype as any).assertReleaseArtifactContentMatchesMetadata,
      downloadExternalReleaseArtifactForValidation: async () => ({
        absolutePath: artifactPath,
        resolvedUrl: artifact.downloadUrl,
        fileName: artifact.fileName,
        fileSizeBytes: BigInt(body.byteLength),
        fileHash: actualHash,
        cleanup: async () => {
          cleanupCalls += 1;
        }
      })
    });

    await service["assertReleaseArtifactContentMatchesMetadata"](artifact, "macos");
    assert.equal(cleanupCalls, 1, "successful external validation must clean its temporary file");

    await assert.rejects(
      () =>
        service["assertReleaseArtifactContentMatchesMetadata"](
          { ...artifact, fileHash: "0".repeat(64) },
          "macos"
        ),
      /SHA-256/
    );
    assert.equal(cleanupCalls, 2, "failed external validation must also clean its temporary file");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testReleaseArtifactContentValidationRejectsInvalidWindowsZip() {
  const tempDir = await mkdtemp(path.join(tmpdir(), "release-content-invalid-zip-"));
  const artifactPath = path.join(tempDir, "ChordV-full.zip");
  const body = Buffer.from("not a zip");
  await writeFile(artifactPath, body);
  const actualHash = createHash("sha256").update(body).digest("hex");
  const artifact = makeReleaseCenterTestArtifact({
    source: "external",
    type: "zip",
    deliveryMode: "desktop_full_replace",
    downloadUrl: "https://cdn.example.com/ChordV-full.zip",
    fileName: "ChordV-full.zip",
    fileSizeBytes: BigInt(body.byteLength),
    fileHash: actualHash
  });
  try {
    const service = createReleaseCenterService({
      assertReleaseArtifactContentMatchesMetadata:
        (ReleaseCenterService.prototype as any).assertReleaseArtifactContentMatchesMetadata,
      downloadExternalReleaseArtifactForValidation: async () => ({
        absolutePath: artifactPath,
        resolvedUrl: artifact.downloadUrl,
        fileName: artifact.fileName,
        fileSizeBytes: BigInt(body.byteLength),
        fileHash: actualHash,
        cleanup: async () => undefined
      })
    });

    await assert.rejects(
      () => service["assertReleaseArtifactContentMatchesMetadata"](artifact, "windows"),
      /ZIP/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testUploadWindowsReleaseRejectsExeFileName() {
  const cleanupCalls: Array<{ absolutePath: string | null; label: string }> = [];
  let preparedCalled = false;
  const service = createReleaseCenterService({
    prisma: {
      release: {
        findUnique: async () =>
          makeReleaseCenterTestRelease({
            platform: "windows"
          })
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          releaseArtifact: {
            updateMany: async () => ({ count: 0 }),
            create: async () => {
              throw new Error("Windows .exe upload should be rejected before writing an artifact");
            }
          }
        })
    },
    assertReleaseArtifactsMutable: () => undefined,
    prepareUploadedReleaseArtifactFile: async () => {
      preparedCalled = true;
      return {
        absolutePath: "prepared-windows-setup.exe",
        storedFilePath: "release_1/artifact_created/ChordV-setup.exe",
        fileName: "ChordV-setup.exe",
        fileSizeBytes: 123n,
        fileHash: null,
        downloadUrl: "/api/downloads/releases/artifact_created"
      };
    },
    cleanupFailedReleaseArtifactUpload: async (absolutePath: string | null, label: string) => {
      cleanupCalls.push({ absolutePath, label });
    }
  });

  await assert.rejects(
    () =>
      service.uploadReleaseArtifact(
        "release_1",
        {
          type: "zip",
          deliveryMode: "desktop_full_replace"
        },
        {
          path: "windows-setup-upload.tmp",
          originalname: "ChordV-setup.exe",
          size: 123
        }
      ),
    /ZIP/i
  );

  assert.equal(preparedCalled, false);
  assert.deepEqual(cleanupCalls, []);
}

async function testReleaseCleanupBestEffortReturnsWhenCleanupStalls() {
  const service = createReleaseCenterService({
    logger: {
      warn: () => undefined
    }
  });

  await Promise.race([
    service["runReleaseCleanupBestEffort"]("stalled cleanup", async () => new Promise<never>(() => undefined)),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("release cleanup waited for stalled cleanup task")), 750);
    })
  ]);
}

async function testDeleteReleaseStartsCleanupAfterLocalReturn() {
  let deleted = false;
  let returned = false;
  let cleanupStarted = false;
  const service = createReleaseCenterService({
    logger: {
      warn: () => undefined
    },
    runReleaseCleanupBestEffort: async () => {
      assert.equal(returned, true, "release cleanup must start after deleteRelease returns");
      cleanupStarted = true;
    },
    prisma: {
      release: {
        findUnique: async () =>
          makeReleaseCenterTestRelease({
            artifacts: [
              makeReleaseCenterTestArtifact({
                id: "artifact_1",
                storedFilePath: "release_1/artifact_1/file.zip"
              })
            ]
          }),
        delete: async () => {
          deleted = true;
        }
      }
    }
  });

  const result = await service.deleteRelease("release_1");
  returned = true;

  assert.equal(result.ok, true);
  assert.equal(deleted, true, "local release delete must finish before cleanup");
  assert.equal(cleanupStarted, false, "cleanup must not run before local delete response returns");
  await waitUntil(() => cleanupStarted);
  assert.equal(cleanupStarted, true, "cleanup should still run in background");
}

async function testDeleteReleaseMapsLocalSaveFailure() {
  const service = createReleaseCenterService({
    prisma: {
      release: {
        findUnique: async () => makeReleaseCenterTestRelease(),
        delete: async () => {
          throw new Error("release delete local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.deleteRelease("release_1"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/release delete local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "release delete local save failures must return a controlled 503 instead of HTTP 500"
  );
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
    (error: unknown) => error instanceof BadRequestException,
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

async function testUpdateCheckFallsBackToOlderUsableReleaseWhenLatestArtifactMissing() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const newerRelease = makeReleaseCenterTestRelease({
    id: "release_newer",
    version: "1.1.7",
    displayTitle: "ChordV 1.1.7",
    status: "published",
    publishedAt: now,
    artifacts: [
      makeReleaseCenterTestArtifact({
        id: "artifact_missing",
        releaseId: "release_newer",
        source: "uploaded",
        downloadUrl: "/api/downloads/releases/artifact_missing",
        storedFilePath: `missing-${Date.now()}/ChordV_1.1.7_x64-full.zip`,
        fileName: "ChordV_1.1.7_x64-full.zip",
        isPrimary: true
      })
    ]
  });
  const olderRelease = makeReleaseCenterTestRelease({
    id: "release_older",
    version: "1.1.6",
    displayTitle: "ChordV 1.1.6",
    status: "published",
    publishedAt: new Date("2025-12-31T00:00:00.000Z"),
    artifacts: [
      makeReleaseCenterTestArtifact({
        id: "artifact_older",
        releaseId: "release_older",
        source: "external",
        downloadUrl: "https://cdn.example.com/ChordV_1.1.6_x64-full.zip",
        fileName: "ChordV_1.1.6_x64-full.zip",
        isPrimary: true
      })
    ]
  });
  const service = createReleaseCenterService({
    findPublishedReleaseCandidates: async () => [newerRelease, olderRelease]
  });

  const result = await service.checkClientUpdate({
    currentVersion: "1.1.5",
    platform: "windows",
    channel: "stable",
    artifactType: "zip"
  });

  assert.equal(result.hasUpdate, true);
  assert.equal(result.latestVersion, "1.1.6");
  assert.equal(result.recommendedArtifact?.id, "artifact_older");
  assert.equal(result.downloadUrl, "https://cdn.example.com/ChordV_1.1.6_x64-full.zip");
}

async function testUpdateCheckIgnoresWithdrawnNewerRelease() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const withdrawnNewerRelease = makeReleaseCenterTestRelease({
    id: "release_withdrawn",
    version: "1.1.7",
    displayTitle: "ChordV 1.1.7",
    status: "draft",
    publishedAt: null,
    artifacts: [
      makeReleaseCenterTestArtifact({
        id: "artifact_withdrawn",
        releaseId: "release_withdrawn",
        downloadUrl: "https://cdn.example.com/ChordV_1.1.7_x64-full.zip",
        fileName: "ChordV_1.1.7_x64-full.zip"
      })
    ]
  });
  const olderPublishedRelease = makeReleaseCenterTestRelease({
    id: "release_older",
    version: "1.1.6",
    displayTitle: "ChordV 1.1.6",
    status: "published",
    publishedAt: now,
    artifacts: [
      makeReleaseCenterTestArtifact({
        id: "artifact_older",
        releaseId: "release_older",
        downloadUrl: "https://cdn.example.com/ChordV_1.1.6_x64-full.zip",
        fileName: "ChordV_1.1.6_x64-full.zip"
      })
    ]
  });
  const releaseQueries: Array<Record<string, any>> = [];
  const service = createReleaseCenterService({
    prisma: {
      release: {
        findMany: async (payload: Record<string, any>) => {
          releaseQueries.push(payload);
          return [withdrawnNewerRelease, olderPublishedRelease].filter((release) => release.status === payload.where.status);
        }
      }
    }
  });

  const result = await service.checkClientUpdate({
    currentVersion: "1.1.5",
    platform: "windows",
    channel: "stable",
    artifactType: "zip"
  });

  assert.equal(releaseQueries.length, 1);
  assert.equal(releaseQueries[0].where.status, "published");
  assert.equal(result.hasUpdate, true);
  assert.equal(result.latestVersion, "1.1.6");
  assert.equal(result.recommendedArtifact?.id, "artifact_older");
}

async function testUpdateCheckAllowsUploadedArtifactWithStaleMetadata() {
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

    assert.equal(result.hasUpdate, true, "client update check should announce uploaded packages when the file still exists");
    assert.equal(result.recommendedArtifact?.id, "artifact_stale");
    assert.equal(result.downloadUrl, "/api/downloads/releases/artifact_stale");
  } finally {
    if (previousReleaseStorageRoot === undefined) {
      delete process.env.CHORDV_RELEASE_STORAGE_ROOT;
    } else {
      process.env.CHORDV_RELEASE_STORAGE_ROOT = previousReleaseStorageRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testUpdateCheckAllowsUploadedArtifactWithoutMetadata() {
  const previousReleaseStorageRoot = process.env.CHORDV_RELEASE_STORAGE_ROOT;
  const tempDir = await mkdtemp(path.join(tmpdir(), "chordv-release-storage-null-metadata-"));
  const storedFilePath = path.join("release_1", "artifact_null_metadata", "ChordV_1.1.3_x64-full.zip");
  process.env.CHORDV_RELEASE_STORAGE_ROOT = tempDir;
  const absolutePath = resolveReleaseArtifactAbsolutePath(storedFilePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, "package-bytes");
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
            id: "artifact_null_metadata",
            releaseId: "release_1",
            source: "uploaded",
            type: "zip",
            deliveryMode: "desktop_full_replace",
            downloadUrl: "/api/downloads/releases/artifact_null_metadata",
            defaultMirrorPrefix: null,
            allowClientMirror: false,
            fileName: "ChordV_1.1.3_x64-full.zip",
            storedFilePath,
            fileSizeBytes: null,
            fileHash: null,
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

    assert.equal(result.hasUpdate, false, "client update check must not announce uploaded packages without SHA-256 metadata");
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

async function testWindowsUpdateCheckPrefersZipOverGenericExternalArtifact() {
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
          id: "artifact_external",
          releaseId: "release_1",
          source: "external",
          type: "external",
          deliveryMode: "external_download",
          downloadUrl: "https://example.com/chordv/windows/latest",
          defaultMirrorPrefix: null,
          allowClientMirror: false,
          fileName: null,
          storedFilePath: null,
          fileSizeBytes: null,
          fileHash: null,
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
    artifactType: "zip"
  });

  assert.equal(result.hasUpdate, true);
  assert.equal(result.deliveryMode, "desktop_full_replace");
  assert.equal(result.recommendedArtifact?.type, "zip");
  assert.equal(result.downloadUrl, "https://example.com/ChordV_1.1.3_x64-full.zip");
  assert.equal(result.fileName, "ChordV_1.1.3_x64-full.zip");
}

async function testWindowsUpdateCheckKeepsExternalZipWithoutHashMetadata() {
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
          id: "artifact_external_zip",
          releaseId: "release_1",
          source: "external",
          type: "zip",
          deliveryMode: "desktop_full_replace",
          downloadUrl: "https://cdn.example.com/ChordV_1.1.3_x64-full.zip",
          defaultMirrorPrefix: null,
          allowClientMirror: true,
          fileName: "ChordV_1.1.3_x64-full.zip",
          storedFilePath: null,
          fileSizeBytes: null,
          fileHash: null,
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

  assert.equal(result.hasUpdate, false, "client update check must not announce external packages without SHA-256 metadata");
  assert.equal(result.recommendedArtifact, null);
  assert.equal(result.downloadUrl, null);
}

async function testWindowsUpdateCheckSkipsClientUnusablePublishedArtifact() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const service = createReleaseCenterService({
    findLatestPublishedRelease: async () => ({
      id: "release_1",
      platform: "windows",
      channel: "stable",
      version: "1.1.3",
      displayTitle: "ChordV 1.1.3",
      changelog: ["Invalid historical artifact"],
      minimumVersion: "1.1.0",
      forceUpgrade: false,
      status: "published",
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
      artifacts: [
        {
          id: "artifact_invalid_external",
          releaseId: "release_1",
          source: "external",
          type: "external",
          deliveryMode: "desktop_full_replace",
          downloadUrl: "https://cdn.example.com/ChordV_1.1.3_x64-full.zip",
          defaultMirrorPrefix: null,
          allowClientMirror: false,
          fileName: "ChordV_1.1.3_x64-full.zip",
          storedFilePath: null,
          fileSizeBytes: null,
          fileHash: null,
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

  assert.equal(result.hasUpdate, false, "client update check must not publish historically invalid artifact rows");
  assert.equal(result.recommendedArtifact, null);
  assert.equal(result.downloadUrl, null);
}

async function testWindowsUpdateCheckSkipsInstallerOnlyRelease() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const service = createReleaseCenterService({
    findLatestPublishedRelease: async () => ({
      id: "release_1",
      platform: "windows",
      channel: "stable",
      version: "1.1.3",
      displayTitle: "ChordV 1.1.3",
      changelog: ["Installer only"],
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
          source: "uploaded",
          type: "setup_exe",
          deliveryMode: "desktop_installer_download",
          downloadUrl: "/api/downloads/releases/artifact_setup",
          defaultMirrorPrefix: null,
          allowClientMirror: false,
          fileName: "ChordV-setup.exe",
          storedFilePath: "release_1/artifact_setup/ChordV-setup.exe",
          fileSizeBytes: 1024n,
          fileHash: null,
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
    artifactType: "setup.exe"
  });

  assert.equal(result.hasUpdate, false);
  assert.equal(result.recommendedArtifact, null);
  assert.equal(result.downloadUrl, null);
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

async function testLoginRateLimitWritesDoNotUseInteractiveTransaction() {
  const upserts: Array<Record<string, any>> = [];
  const service = createClientAccessService({
    prisma: {
      rateLimitBucket: {
        findMany: async () => [],
        findUnique: async () => null,
        upsert: async (payload: Record<string, any>) => {
          upserts.push(payload);
          return payload.create;
        }
      },
      user: {
        findUnique: async () => null
      },
      $transaction: async () => {
        throw new Error("login rate limit writes must not use Prisma interactive transactions");
      }
    }
  });

  await assert.rejects(
    () => service.login("missing@example.com", "bad-password", "127.0.0.1"),
    /账号或密码错误/,
    "missing user login should still fail as unauthorized"
  );

  assert.equal(upserts.length, 3, "failed login must still update all rate-limit buckets");
}

async function testLoginMapsClearFailuresLocalWriteFailure() {
  const passwordHash = await bcrypt.hash("correct-password", 4);
  const service = createClientAccessService({
    prisma: {
      rateLimitBucket: {
        findMany: async () => [],
        deleteMany: async () => {
          throw new Error("login clear failures local write failed");
        }
      },
      user: {
        findUnique: async () => ({
          id: "user_1",
          email: "admin@example.com",
          displayName: "Admin",
          role: "admin",
          status: "active",
          passwordHash
        })
      }
    }
  });

  await assert.rejects(
    () => service.login("admin@example.com", "correct-password", "127.0.0.1"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/login clear failures local write failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "successful login cleanup write failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testLoginMapsLastSeenLocalWriteFailure() {
  const passwordHash = await bcrypt.hash("correct-password", 4);
  const service = createClientAccessService({
    prisma: {
      rateLimitBucket: {
        findMany: async () => [],
        deleteMany: async () => ({ count: 0 })
      },
      user: {
        findUnique: async () => ({
          id: "user_1",
          email: "admin@example.com",
          displayName: "Admin",
          role: "admin",
          status: "active",
          passwordHash
        }),
        update: async () => {
          throw new Error("login last seen local write failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.login("admin@example.com", "correct-password", "127.0.0.1"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/login last seen local write failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "successful login user update failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testLoginMapsIssueSessionLocalWriteFailure() {
  const passwordHash = await bcrypt.hash("correct-password", 4);
  const service = createClientAccessService({
    prisma: {
      rateLimitBucket: {
        findMany: async () => [],
        deleteMany: async () => ({ count: 0 })
      },
      user: {
        findUnique: async () => ({
          id: "user_1",
          email: "admin@example.com",
          displayName: "Admin",
          role: "admin",
          status: "active",
          passwordHash
        }),
        update: async () => ({ id: "user_1" })
      }
    },
    authSessionService: {
      issueSession: async () => {
        throw new Error("login refresh token local write failed");
      }
    }
  });

  await assert.rejects(
    () => service.login("admin@example.com", "correct-password", "127.0.0.1"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/login refresh token local write failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "successful login session write failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testClientVersionDoesNotUseCrossPlatformReleaseWithoutPlatform() {
  const updateQueries: Array<Record<string, any>> = [];
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
        findMany: async () => {
          throw new Error("client version endpoint must use release center artifact selection");
        }
      }
    },
    releaseCenterService: {
      checkClientUpdate: async (payload: Record<string, any>) => {
        updateQueries.push(payload);
        return {
          hasUpdate: true,
          forceUpgrade: false,
          blockedByMinimumVersion: false,
          forcedByRelease: false,
          updateRequirement: "optional",
          currentVersion: payload.currentVersion,
          latestVersion: "1.1.3",
          minimumVersion: "1.1.0",
          platform: "windows",
          channel: "stable",
          changelog: ["Windows"],
          deliveryMode: "desktop_full_replace",
          recommendedArtifact: {
            id: "artifact_zip",
            releaseId: "release_windows",
            source: "external",
            type: "zip",
            deliveryMode: "desktop_full_replace",
            downloadUrl: "https://example.com/ChordV_1.1.3_x64-full.zip",
            defaultMirrorPrefix: null,
            allowClientMirror: false,
            fileName: "ChordV_1.1.3_x64-full.zip",
            fileSizeBytes: "2048",
            fileHash: null,
            isPrimary: false,
            isFullPackage: true,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z"
          },
          downloadUrl: "https://example.com/ChordV_1.1.3_x64-full.zip",
          fileName: "ChordV_1.1.3_x64-full.zip",
          fileSizeBytes: "2048",
          fileHash: null,
          publishedAt: "2026-01-01T00:00:00.000Z"
        };
      }
    }
  });

  const fallback = await service.getClientVersion();
  assert.equal(fallback.currentVersion, "1.1.2");
  assert.equal(updateQueries.length, 0, "version without platform must not select a release");

  const windows = await service.getClientVersion("windows");
  assert.equal(windows.currentVersion, "1.1.3");
  assert.equal(windows.downloadUrl, "https://example.com/ChordV_1.1.3_x64-full.zip");
  assert.deepEqual(updateQueries[0], {
    currentVersion: "1.1.2",
    platform: "windows",
    channel: "stable"
  });
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
    /负责人转移/,
    "adding a team member must not silently create another owner"
  );
}

async function testCreateTeamMemberRejectsUniqueConflictAsConflict() {
  const service = createAdminSubscriptionService({
    requireTeam: async () => ({ id: "team_1" }),
    assertUserCanJoinTeam: async () => undefined,
    prisma: {
      teamMember: {
        create: async () => {
          throw { code: "P2002" };
        }
      }
    }
  });

  await assert.rejects(
    () => service.createTeamMember("team_1", { userId: "user_1", role: "member" }),
    (error) => error instanceof ConflictException && /belongs to another team/i.test(error.message),
    "team member unique conflicts must return a controlled conflict instead of HTTP 500"
  );
}

async function testCreateTeamMemberMapsUnknownLocalSaveFailure() {
  const service = createAdminSubscriptionService({
    requireTeam: async () => ({ id: "team_1" }),
    assertUserCanJoinTeam: async () => undefined,
    prisma: {
      teamMember: {
        create: async () => {
          throw new Error("team member local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.createTeamMember("team_1", { userId: "user_1", role: "member" }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      /Team 成员保存失败/.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "team member local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testCreateUserRejectsUniqueEmailConflictAsConflict() {
  const service = createAdminSubscriptionService({
    prisma: {
      user: {
        findUnique: async () => null,
        create: async () => {
          throw { code: "P2002" };
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.createUser({
        email: "user@example.com",
        password: "password123",
        displayName: "User",
        role: "user"
      }),
    (error) => error instanceof ConflictException && /邮箱|exist/i.test(error.message),
    "user email unique conflicts must return a controlled conflict instead of HTTP 500"
  );
}

async function testCreateUserMapsUnknownLocalSaveFailure() {
  const service = createAdminSubscriptionService({
    prisma: {
      user: {
        findUnique: async () => null,
        create: async () => {
          throw new Error("user local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.createUser({
        email: "user@example.com",
        password: "password123",
        displayName: "User",
        role: "user"
      }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      /账号保存失败/.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "user local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testConvertSubscriptionToTeamMapsUnknownLocalSaveFailure() {
  const personalSubscription = {
    id: "subscription_1",
    userId: "user_1",
    teamId: null,
    state: "active",
    remainingTrafficGb: 10,
    expireAt: new Date(Date.now() + 60_000)
  };
  const service = createAdminSubscriptionService({
    requireSubscription: async () => personalSubscription,
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
      id: "team_subscription_1",
      userId: null,
      teamId: "team_1",
      state: "active",
      remainingTrafficGb: 10,
      expireAt: new Date(Date.now() + 60_000)
    }),
    prisma: {
      $transaction: async () => {
        throw new Error("convert subscription local save failed");
      }
    }
  });

  await assert.rejects(
    () => service.convertPersonalSubscriptionToTeam("subscription_1", { targetTeamId: "team_1" }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      /订阅转入 Team 保存失败/.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "subscription-to-team local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testUpdateUserMapsLocalSaveFailure() {
  const service = createAdminSubscriptionService({
    ensureUserExists: async () => ({
      id: "user_1",
      role: "user",
      status: "active"
    }),
    prisma: {
      user: {
        update: async () => {
          throw new Error("user update local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.updateUser("user_1", { displayName: "Renamed" }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/user update local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "user update local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testUpdateUserSecurityMapsLocalSaveFailure() {
  const service = createAdminSubscriptionService({
    ensureUserExists: async () => ({ id: "user_1" }),
    prisma: {
      user: {
        update: async () => {
          throw new Error("user security local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.updateUserSecurity("user_1", { maxConcurrentSessionsOverride: 2 }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/user security local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "user security local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testCreateSubscriptionMapsLocalSaveFailure() {
  const service = createAdminSubscriptionService({
    ensureUserExists: async () => ({
      id: "user_1",
      status: "active"
    }),
    getUserMembership: async () => null,
    findCurrentPersonalSubscription: async () => null,
    ensurePlanExists: async () => ({
      id: "plan_1",
      scope: "personal",
      isActive: true,
      totalTrafficGb: 100,
      renewable: true
    }),
    prisma: {
      subscription: {
        create: async () => {
          throw new Error("subscription create local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.createSubscription({
        userId: "user_1",
        planId: "plan_1",
        expireAt: new Date(Date.now() + 86_400_000).toISOString()
      }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/subscription create local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "personal subscription local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testRenewSubscriptionMapsLocalSaveFailure() {
  const current = {
    id: "sub_1",
    totalTrafficGb: 100,
    usedTrafficGb: 10,
    remainingTrafficGb: 90,
    expireAt: new Date(Date.now() + 86_400_000),
    state: "active",
    userId: "user_1",
    teamId: null
  };
  const service = createAdminSubscriptionService({
    requireSubscription: async () => current,
    prisma: {
      $transaction: async () => {
        throw new Error("subscription renew local save failed");
      }
    }
  });

  await assert.rejects(
    () => service.renewSubscription("sub_1", { totalTrafficGb: 120 }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/subscription renew local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "subscription renew local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testChangeSubscriptionPlanMapsLocalSaveFailure() {
  const current = {
    id: "sub_1",
    totalTrafficGb: 100,
    usedTrafficGb: 10,
    remainingTrafficGb: 90,
    expireAt: new Date(Date.now() + 86_400_000),
    state: "active",
    userId: "user_1",
    teamId: null
  };
  const service = createAdminSubscriptionService({
    requireSubscription: async () => current,
    ensurePlanExists: async () => ({
      id: "plan_2",
      scope: "personal",
      isActive: true,
      totalTrafficGb: 200,
      renewable: true
    }),
    prisma: {
      $transaction: async () => {
        throw new Error("subscription plan local save failed");
      }
    }
  });

  await assert.rejects(
    () => service.changeSubscriptionPlan("sub_1", { planId: "plan_2" }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/subscription plan local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "subscription plan local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testUpdateSubscriptionMapsLocalSaveFailure() {
  const current = {
    id: "sub_1",
    totalTrafficGb: 100,
    usedTrafficGb: 10,
    remainingTrafficGb: 90,
    expireAt: new Date(Date.now() + 86_400_000),
    state: "active",
    userId: "user_1",
    teamId: null
  };
  const service = createAdminSubscriptionService({
    requireSubscription: async () => current,
    prisma: {
      $transaction: async () => {
        throw new Error("subscription update local save failed");
      }
    }
  });

  await assert.rejects(
    () => service.updateSubscription("sub_1", { totalTrafficGb: 120 }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/subscription update local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "subscription update local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testCreateTeamMapsLocalSaveFailure() {
  const service = createAdminSubscriptionService({
    ensureUserExists: async () => ({
      id: "owner_1",
      status: "active"
    }),
    assertUserCanJoinTeam: async () => undefined,
    prisma: {
      $transaction: async () => {
        throw new Error("team create local save failed");
      },
      team: {
        create: () => ({})
      },
      teamMember: {
        create: () => ({})
      }
    }
  });

  await assert.rejects(
    () => service.createTeam({ name: "Team", ownerUserId: "owner_1" }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/team create local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "team create local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testCreateTeamMapsOwnerUniqueConflictAsConflict() {
  const service = createAdminSubscriptionService({
    ensureUserExists: async () => ({
      id: "owner_1",
      status: "active"
    }),
    assertUserCanJoinTeam: async () => undefined,
    prisma: {
      $transaction: async () => {
        throw { code: "P2002" };
      },
      team: {
        create: () => ({})
      },
      teamMember: {
        create: () => ({})
      }
    }
  });

  await assert.rejects(
    () => service.createTeam({ name: "Team", ownerUserId: "owner_1" }),
    (error) => error instanceof ConflictException && /belongs to another team/i.test(error.message),
    "team owner unique conflicts must return a controlled 409 instead of a transient 503"
  );
}

async function testUpdateTeamMapsLocalSaveFailure() {
  const service = createAdminSubscriptionService({
    requireTeam: async () => ({
      id: "team_1",
      ownerUserId: "owner_1",
      status: "active"
    }),
    prisma: {
      team: {
        update: async () => {
          throw new Error("team update local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.updateTeam("team_1", { name: "Renamed Team" }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/team update local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "team update local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testUpdateTeamOwnerTransferRejectsConcurrentForeignMembership() {
  let oldOwnerDemoted = false;
  let currentTeamUpdated = false;
  let currentTeamMemberCreated = false;
  const service = createAdminSubscriptionService({
    requireTeam: async () => ({
      id: "team_1",
      ownerUserId: "owner_1",
      status: "active"
    }),
    ensureUserExists: async () => ({
      id: "new_owner",
      status: "active"
    }),
    getUserMembership: async () => null,
    findCurrentPersonalSubscription: async () => null,
    prisma: {
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          teamMember: {
            findUnique: async () => ({
              id: "member_other",
              teamId: "team_other",
              userId: "new_owner",
              role: "member"
            }),
            updateMany: async () => {
              oldOwnerDemoted = true;
              return { count: 1 };
            },
            update: async () => {
              throw new Error("must not update a member from another team");
            },
            create: async () => {
              currentTeamMemberCreated = true;
              return {};
            }
          },
          team: {
            update: async () => {
              currentTeamUpdated = true;
              return {};
            }
          }
        })
    }
  });

  await assert.rejects(
    () => service.updateTeam("team_1", { ownerUserId: "new_owner" }),
    (error) => error instanceof ConflictException && /belongs to another team/i.test(error.message),
    "owner transfer must re-check membership inside the transaction before changing team state"
  );
  assert.equal(oldOwnerDemoted, false, "old owner must not be demoted after the new owner joins another team");
  assert.equal(currentTeamMemberCreated, false, "new owner must not be added to the current team after a concurrent foreign membership");
  assert.equal(currentTeamUpdated, false, "team ownerUserId must not point to a user from another team");
}

async function testUpdateTeamOwnerTransferUsesOwnerLock() {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalLockTimeout = process.env.CHORDV_SUBSCRIPTION_LOCK_WAIT_TIMEOUT_MS;
  const originalLockRetry = process.env.CHORDV_SUBSCRIPTION_LOCK_RETRY_INTERVAL_MS;
  delete process.env.DATABASE_URL;
  process.env.CHORDV_SUBSCRIPTION_LOCK_WAIT_TIMEOUT_MS = "25";
  process.env.CHORDV_SUBSCRIPTION_LOCK_RETRY_INTERVAL_MS = "5";
  let releaseOuterLock!: () => void;
  let businessLogicEntered = false;

  const heldLock = runWithSubscriptionOwnerLock(
    "personal:new_owner",
    async () =>
      new Promise<void>((resolve) => {
        releaseOuterLock = resolve;
      })
  );

  try {
    for (let attempt = 0; !releaseOuterLock && attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const service = createAdminSubscriptionService({
      requireTeam: async () => {
        businessLogicEntered = true;
        return {
          id: "team_1",
          ownerUserId: "owner_1",
          status: "active"
        };
      }
    });

    await assert.rejects(
      () => service.updateTeam("team_1", { ownerUserId: "new_owner" }),
      (error) => error instanceof ConflictException && /retry shortly/.test(error.message),
      "team owner transfer must use the subscription owner lock before entering mutation logic"
    );
    assert.equal(businessLogicEntered, false, "owner transfer must not enter team mutation logic while the owner lock is held");
  } finally {
    if (releaseOuterLock) {
      releaseOuterLock();
    }
    await heldLock.catch(() => undefined);
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    if (originalLockTimeout === undefined) {
      delete process.env.CHORDV_SUBSCRIPTION_LOCK_WAIT_TIMEOUT_MS;
    } else {
      process.env.CHORDV_SUBSCRIPTION_LOCK_WAIT_TIMEOUT_MS = originalLockTimeout;
    }
    if (originalLockRetry === undefined) {
      delete process.env.CHORDV_SUBSCRIPTION_LOCK_RETRY_INTERVAL_MS;
    } else {
      process.env.CHORDV_SUBSCRIPTION_LOCK_RETRY_INTERVAL_MS = originalLockRetry;
    }
  }
}

async function testUpdateTeamOwnerTransferUsesTeamLock() {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalLockTimeout = process.env.CHORDV_SUBSCRIPTION_LOCK_WAIT_TIMEOUT_MS;
  const originalLockRetry = process.env.CHORDV_SUBSCRIPTION_LOCK_RETRY_INTERVAL_MS;
  delete process.env.DATABASE_URL;
  process.env.CHORDV_SUBSCRIPTION_LOCK_WAIT_TIMEOUT_MS = "25";
  process.env.CHORDV_SUBSCRIPTION_LOCK_RETRY_INTERVAL_MS = "5";
  let releaseOuterLock!: () => void;
  let businessLogicEntered = false;

  const heldLock = runWithSubscriptionOwnerLock(
    "team:team_1",
    async () =>
      new Promise<void>((resolve) => {
        releaseOuterLock = resolve;
      })
  );

  try {
    for (let attempt = 0; !releaseOuterLock && attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const service = createAdminSubscriptionService({
      requireTeam: async () => {
        businessLogicEntered = true;
        return {
          id: "team_1",
          ownerUserId: "owner_1",
          status: "active"
        };
      }
    });

    await assert.rejects(
      () => service.updateTeam("team_1", { ownerUserId: "new_owner" }),
      (error) => error instanceof ConflictException && /retry shortly/.test(error.message),
      "team owner transfer must use a team-level lock before entering mutation logic"
    );
    assert.equal(businessLogicEntered, false, "owner transfer must not enter team mutation logic while the team lock is held");
  } finally {
    if (releaseOuterLock) {
      releaseOuterLock();
    }
    await heldLock.catch(() => undefined);
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    if (originalLockTimeout === undefined) {
      delete process.env.CHORDV_SUBSCRIPTION_LOCK_WAIT_TIMEOUT_MS;
    } else {
      process.env.CHORDV_SUBSCRIPTION_LOCK_WAIT_TIMEOUT_MS = originalLockTimeout;
    }
    if (originalLockRetry === undefined) {
      delete process.env.CHORDV_SUBSCRIPTION_LOCK_RETRY_INTERVAL_MS;
    } else {
      process.env.CHORDV_SUBSCRIPTION_LOCK_RETRY_INTERVAL_MS = originalLockRetry;
    }
  }
}

async function testUpdateTeamMemberMapsLocalSaveFailure() {
  const service = createAdminSubscriptionService({
    requireTeamMember: async () => ({
      id: "member_1",
      teamId: "team_1",
      userId: "user_1",
      role: "member"
    }),
    prisma: {
      teamMember: {
        update: async () => {
          throw new Error("team member update local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.updateTeamMember("team_1", "member_1", { role: "admin" }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/team member update local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "team member update local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testUpdateTeamMemberOwnerTransferUsesTeamLock() {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalLockTimeout = process.env.CHORDV_SUBSCRIPTION_LOCK_WAIT_TIMEOUT_MS;
  const originalLockRetry = process.env.CHORDV_SUBSCRIPTION_LOCK_RETRY_INTERVAL_MS;
  delete process.env.DATABASE_URL;
  process.env.CHORDV_SUBSCRIPTION_LOCK_WAIT_TIMEOUT_MS = "25";
  process.env.CHORDV_SUBSCRIPTION_LOCK_RETRY_INTERVAL_MS = "5";
  let releaseOuterLock!: () => void;
  let businessLogicEntered = false;

  const heldLock = runWithSubscriptionOwnerLock(
    "team:team_1",
    async () =>
      new Promise<void>((resolve) => {
        releaseOuterLock = resolve;
      })
  );

  try {
    for (let attempt = 0; !releaseOuterLock && attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const service = createAdminSubscriptionService({
      requireTeamMember: async () => {
        businessLogicEntered = true;
        return {
          id: "member_1",
          teamId: "team_1",
          userId: "user_1",
          role: "member"
        };
      }
    });

    await assert.rejects(
      () => service.updateTeamMember("team_1", "member_1", { role: "owner" }),
      (error) => error instanceof ConflictException && /retry shortly/.test(error.message),
      "team member owner transfer must use a team-level lock before entering mutation logic"
    );
    assert.equal(businessLogicEntered, false, "member owner transfer must not enter mutation logic while the team lock is held");
  } finally {
    if (releaseOuterLock) {
      releaseOuterLock();
    }
    await heldLock.catch(() => undefined);
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    if (originalLockTimeout === undefined) {
      delete process.env.CHORDV_SUBSCRIPTION_LOCK_WAIT_TIMEOUT_MS;
    } else {
      process.env.CHORDV_SUBSCRIPTION_LOCK_WAIT_TIMEOUT_MS = originalLockTimeout;
    }
    if (originalLockRetry === undefined) {
      delete process.env.CHORDV_SUBSCRIPTION_LOCK_RETRY_INTERVAL_MS;
    } else {
      process.env.CHORDV_SUBSCRIPTION_LOCK_RETRY_INTERVAL_MS = originalLockRetry;
    }
  }
}

async function testDeleteTeamMemberMapsLocalSaveFailure() {
  const service = createAdminSubscriptionService({
    requireTeamMember: async () => ({
      id: "member_1",
      teamId: "team_1",
      userId: "user_1",
      role: "member"
    }),
    prisma: {
      $transaction: async () => {
        throw new Error("team member delete local save failed");
      }
    }
  });

  await assert.rejects(
    () => service.deleteTeamMember("team_1", "member_1"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/team member delete local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "team member delete local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testCreateTeamSubscriptionMapsLocalSaveFailure() {
  const service = createAdminSubscriptionService({
    requireTeam: async () => ({
      id: "team_1",
      status: "active"
    }),
    findCurrentTeamSubscription: async () => null,
    ensurePlanExists: async () => ({
      id: "plan_team",
      scope: "team",
      isActive: true,
      totalTrafficGb: 500,
      renewable: true
    }),
    prisma: {
      subscription: {
        create: async () => {
          throw new Error("team subscription local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.createTeamSubscription("team_1", {
        planId: "plan_team",
        expireAt: new Date(Date.now() + 86_400_000).toISOString()
      }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/team subscription local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "team subscription local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testCreatePlanMapsLocalSaveFailure() {
  const service = createAdminSubscriptionService({
    prisma: {
      plan: {
        create: async () => {
          throw new Error("plan create local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.createPlan({
        name: "Plan",
        scope: "personal",
        totalTrafficGb: 100,
        renewable: true
      }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/plan create local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "plan create local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testListAdminPlansMapsLocalReadFailure() {
  const service = createAdminSubscriptionService({
    prisma: {
      plan: {
        findMany: async () => {
          throw new Error("plan list local read failed");
        }
      },
      subscription: {
        findMany: async () => []
      }
    }
  });

  await assert.rejects(
    () => service.listAdminPlans(),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/plan list local read failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "plan list local read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testListAdminPlansUsesSubscriptionCountAggregation() {
  let fullSubscriptionReadCalled = false;
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  const updatedAt = new Date("2026-01-02T00:00:00.000Z");
  const service = createAdminSubscriptionService({
    prisma: {
      plan: {
        findMany: async () => [
          {
            id: "plan_a",
            name: "A",
            scope: "personal",
            totalTrafficGb: 100,
            renewable: true,
            maxConcurrentSessions: 2,
            isActive: true,
            createdAt,
            updatedAt
          },
          {
            id: "plan_b",
            name: "B",
            scope: "team",
            totalTrafficGb: 300,
            renewable: false,
            maxConcurrentSessions: 5,
            isActive: true,
            createdAt,
            updatedAt
          }
        ]
      },
      subscription: {
        groupBy: async (payload: Record<string, unknown>) => {
          assert.deepEqual(payload, { by: ["planId"], _count: { _all: true } });
          return [
            { planId: "plan_a", _count: { _all: 3 } },
            { planId: "plan_b", _count: { _all: 1 } }
          ];
        },
        findMany: async () => {
          fullSubscriptionReadCalled = true;
          throw new Error("full subscription read must not be used for plan counts");
        }
      }
    }
  });

  const plans = await service.listAdminPlans();

  assert.equal(fullSubscriptionReadCalled, false, "plan list must not read full subscription rows for counts");
  assert.deepEqual(
    plans.map((plan) => ({ id: plan.id, subscriptionCount: plan.subscriptionCount })),
    [
      { id: "plan_a", subscriptionCount: 3 },
      { id: "plan_b", subscriptionCount: 1 }
    ]
  );
}

async function testUpdatePlanMapsLocalSaveFailure() {
  const service = createAdminSubscriptionService({
    ensurePlanExists: async () => ({
      id: "plan_1",
      name: "Plan",
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
        count: async () => 0
      },
      plan: {
        update: async () => {
          throw new Error("plan update local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.updatePlan("plan_1", { name: "Renamed Plan" }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/plan update local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "plan update local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testUpdatePlanMapsSubscriptionCountReadFailure() {
  const service = createAdminSubscriptionService({
    ensurePlanExists: async () => ({
      id: "plan_1",
      name: "Plan",
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
        count: async () => {
          throw new Error("plan subscription count read failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.updatePlan("plan_1", { name: "Renamed Plan" }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/plan subscription count read failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "plan update preflight subscription count read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testUpdatePlanSecurityMapsLocalSaveFailure() {
  const service = createAdminSubscriptionService({
    ensurePlanExists: async () => ({
      id: "plan_1",
      maxConcurrentSessions: 3
    }),
    prisma: {
      plan: {
        update: async () => {
          throw new Error("plan security local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.updatePlanSecurity("plan_1", { maxConcurrentSessions: 5 }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/plan security local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "plan security local save failures must return a controlled 503 instead of HTTP 500"
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
    /套餐类型已有订阅使用/,
    "plan scope changes must be blocked when existing subscriptions use the plan"
  );
}

async function testCreatePlanRejectsBlankTrimmedName() {
  const service = createAdminSubscriptionService({
    prisma: {
      plan: {
        create: async () => {
          throw new Error("plan create should not be called");
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.createPlan({
        name: "   ",
        scope: "personal",
        totalTrafficGb: 100,
        renewable: true
      }),
    /套餐名称不能为空/,
    "plan creation must reject names that are blank after trimming"
  );
}

async function testUpdateCurrentAdminSecurityRejectsUniqueEmailConflictAsConflict() {
  const passwordHash = await bcrypt.hash("current-password", 10);
  const service = createDevDataService({
    authSessionService: {
      authenticateAccessToken: async () => ({
        id: "admin_1",
        role: "admin"
      }),
      issueSession: async () => {
        throw new Error("session should not be issued after an email unique conflict");
      }
    },
    prisma: {
      user: {
        findUnique: async (payload: Record<string, any>) => {
          if (payload.where.id === "admin_1") {
            return {
              id: "admin_1",
              email: "admin@example.com",
              role: "admin",
              status: "active",
              passwordHash
            };
          }
          return null;
        }
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          user: {
            update: async () => {
              throw { code: "P2002" };
            }
          },
          refreshToken: {
            updateMany: async () => ({ count: 0 })
          }
        })
    }
  });

  await assert.rejects(
    () =>
      service.updateCurrentAdminSecurity("Bearer admin-token", {
        currentPassword: "current-password",
        email: "taken@example.com"
      }),
    (error) => error instanceof ConflictException && /占用|conflict|exists/i.test(error.message),
    "admin email unique conflicts must return a controlled conflict instead of HTTP 500"
  );
}

async function testUpdateCurrentAdminSecurityMapsCurrentAdminReadFailure() {
  const service = createDevDataService({
    authSessionService: {
      authenticateAccessToken: async () => ({
        id: "admin_1",
        role: "admin"
      })
    },
    prisma: {
      user: {
        findUnique: async () => {
          throw new Error("server closed the connection unexpectedly");
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.updateCurrentAdminSecurity("Bearer admin-token", {
        currentPassword: "current-password",
        email: "admin@example.com"
      }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      /管理员账号读取失败/.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "admin security current admin read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testUpdateCurrentAdminSecurityMapsEmailPreflightReadFailure() {
  const passwordHash = await bcrypt.hash("current-password", 10);
  const service = createDevDataService({
    authSessionService: {
      authenticateAccessToken: async () => ({
        id: "admin_1",
        role: "admin"
      })
    },
    prisma: {
      user: {
        findUnique: async (payload: Record<string, any>) => {
          if (payload.where.id === "admin_1") {
            return {
              id: "admin_1",
              email: "admin@example.com",
              role: "admin",
              status: "active",
              passwordHash
            };
          }
          throw new Error("server closed the connection unexpectedly");
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.updateCurrentAdminSecurity("Bearer admin-token", {
        currentPassword: "current-password",
        email: "admin@example.com"
      }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      /管理员账号邮箱校验失败/.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "admin security email preflight read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testUpdateCurrentAdminSecurityMapsTransactionFailure() {
  const passwordHash = await bcrypt.hash("current-password", 10);
  const service = createDevDataService({
    authSessionService: {
      authenticateAccessToken: async () => ({
        id: "admin_1",
        role: "admin"
      }),
      issueSession: async () => {
        throw new Error("session should not be issued after a failed local save");
      }
    },
    prisma: {
      user: {
        findUnique: async (payload: Record<string, any>) => {
          if (payload.where.id === "admin_1") {
            return {
              id: "admin_1",
              email: "admin@example.com",
              role: "admin",
              status: "active",
              passwordHash
            };
          }
          return null;
        }
      },
      $transaction: async () => {
        throw new Error("server closed the connection unexpectedly");
      }
    }
  });

  await assert.rejects(
    () =>
      service.updateCurrentAdminSecurity("Bearer admin-token", {
        currentPassword: "current-password",
        email: "admin@example.com"
      }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      /管理员安全设置保存失败/.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "admin security transaction failures must return a controlled 503 instead of HTTP 500"
  );
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

  await waitUntil(() => enforced.length > 0);
  assert.deepEqual(enforced, [{ userId: "user_1", limit: 1 }]);
}

async function testUpdateUserSecurityPublishesAccountEvents() {
  const adminEvents: Array<Record<string, unknown>> = [];
  const clientEvents: Array<{ userId: string; event: Record<string, unknown> }> = [];
  const service = createAdminSubscriptionService({
    ensureUserExists: async () => ({ id: "user_1" }),
    requireAdminUserRecord: async (userId: string) => ({ id: userId }),
    runtimeSessionService: {
      enforceUserConcurrentLeaseLimit: async () => undefined
    },
    clientRuntimeEventsService: {
      publishToUser: (userId: string, event: Record<string, unknown>) => {
        clientEvents.push({ userId, event });
      }
    },
    adminRuntimeEventsService: {
      publish: (event: Record<string, unknown>) => {
        adminEvents.push(event);
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

  assert.equal(adminEvents[0]?.type, "account_updated");
  assert.deepEqual(clientEvents.map((entry) => ({ userId: entry.userId, type: entry.event.type, reasonCode: entry.event.reasonCode })), [
    { userId: "user_1", type: "account_updated", reasonCode: undefined }
  ]);
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

  await waitUntil(() => enforced.length >= 2);
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

  await waitUntil(() => enforced.length > 0);
  assert.deepEqual(enforced, [{ userId: "user_1", limit: 1 }]);
}

async function testUpdateSubscriptionReturnsWhenSubscriptionPublishStalls() {
  const updates: Array<Record<string, any>> = [];
  const now = new Date("2026-01-01T00:00:00.000Z");
  const current = {
    id: "sub_team",
    userId: null,
    teamId: "team_1",
    planId: "plan_1",
    totalTrafficGb: 100,
    usedTrafficGb: 4,
    remainingTrafficGb: 96,
    expireAt: new Date(Date.now() + 86_400_000),
    state: "active",
    renewable: true,
    sourceAction: "created",
    lastSyncedAt: now,
    plan: { name: "Team Plan", maxConcurrentSessions: 3 },
    user: null,
    team: { name: "Team" },
    nodeAccesses: []
  };
  let publishLookupStarted = false;
  const adminEvents: Array<Record<string, any>> = [];
  const service = createAdminSubscriptionService({
    logger: {
      warn: () => undefined
    },
    requireSubscription: async () => current,
    syncActiveLeasesForSubscriptionBestEffort: async () => ({ ok: true }),
    clientRuntimeEventsService: {
      publishToUsers: () => undefined
    },
    adminRuntimeEventsService: {
      publishSubscriptionUpdated: (event: Record<string, any>) => {
        adminEvents.push(event);
      }
    },
    prisma: {
      teamMember: {
        findMany: async () => {
          publishLookupStarted = true;
          return new Promise<Array<{ userId: string }>>(() => undefined);
        }
      },
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

  const result = await Promise.race([
    service.updateSubscription("sub_team", { totalTrafficGb: 120 }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("update subscription waited for stalled subscription_updated publish")), 750);
    })
  ]);

  assert.equal(publishLookupStarted, false, "subscription update response must return before subscription_updated publish starts");
  assert.equal(adminEvents.length, 0, "subscription_updated publish must remain deferred until after local response returns");
  await waitUntil(() => adminEvents.length > 0);
  assert.deepEqual(adminEvents[0], { subscriptionId: "sub_team", state: "active" });
  await waitUntil(() => publishLookupStarted);
  assert.equal(publishLookupStarted, true, "subscription_updated publish should still start in background");
  assert.equal(updates.length, 1, "local subscription update must save before stalled publish finishes");
  assert.equal(result.totalTrafficGb, 120);
  assert.equal(result.remainingTrafficGb, 116);
}

async function testSubscriptionUpdatedStillPublishesAdminEventWhenClientPublishFails() {
  const adminEvents: Array<Record<string, any>> = [];
  const warnings: string[] = [];
  const service = createAdminSubscriptionService({
    logger: {
      warn: (message: string) => warnings.push(message)
    },
    resolveTargetUserIdsForSubscriptionTarget: async () => ["user_1"],
    clientRuntimeEventsService: {
      publishToUsers: () => {
        throw new Error("client SSE failed");
      }
    },
    adminRuntimeEventsService: {
      publishSubscriptionUpdated: (event: Record<string, any>) => {
        adminEvents.push(event);
      }
    }
  });

  await service["runSubscriptionUpdatedPublishInBackground"]({
    subscriptionId: "sub_1",
    userId: "user_1",
    state: "active"
  });

  assert.deepEqual(adminEvents, [{ subscriptionId: "sub_1", state: "active" }]);
  assert.match(warnings[0] ?? "", /subscription_updated publish failed/);
}

async function testDevDataNodeAccessStillPublishesAdminEventWhenClientPublishFails() {
  const adminEvents: Array<Record<string, any>> = [];
  const warnings: string[] = [];
  const service = createDevDataService({
    logger: {
      warn: (message: string) => warnings.push(message)
    },
    clientEventsPublisher: {
      publishNodeAccessUpdated: async () => {
        throw new Error("client node access SSE failed");
      }
    },
    adminRuntimeEventsService: {
      publish: (event: Record<string, any>) => {
        adminEvents.push(event);
      }
    }
  });

  await service["publishNodeAccessUpdatedEvent"]({
    subscriptionId: "sub_1",
    userId: "user_1"
  });

  assert.equal(adminEvents[0].type, "node_access_updated");
  assert.match(warnings[0] ?? "", /node_access_updated publish failed/);
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

  await waitUntil(() => enforced.length > 0);
  assert.deepEqual(enforced, [{ userId: "user_1", limit: 1 }]);
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
      queueDirectSubscriptionAccessSync: async () => {
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
  assert.equal(syncCalled, true, "panel sync should be persisted before the local response");
  assert.equal(result.id, "sub_1");
}

async function testCreateSubscriptionKeepsLocalSaveWhenTicketCleanupStalls() {
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
    closeSupportTicketsForUser: async () => new Promise<number>(() => undefined),
    runtimeSessionService: {
      queueDirectSubscriptionAccessSync: async () => {
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

  const result = await Promise.race([
    service.createSubscription({
      userId: "user_1",
      planId: "plan_1",
      expireAt: new Date(Date.now() + 60_000).toISOString()
    }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("createSubscription waited for stalled ticket cleanup")), 750);
    })
  ]);

  assert.equal(createdSubscription, true);
  assert.equal(syncCalled, true, "panel sync should be persisted before the local response");
  assert.equal(result.id, "sub_1");
  await waitUntil(() => syncCalled);
  assert.equal(syncCalled, true, "panel sync should still be queued after stalled best-effort ticket cleanup");
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

async function testUpdateTeamMemberOwnerTransferMapsLocalSaveFailure() {
  let transactionCalled = false;
  let subscriptionLookupCalled = false;
  let panelSyncQueued = false;
  let eventPublished = false;
  const now = new Date("2026-01-01T00:00:00.000Z");
  const service = createAdminSubscriptionService({
    requireTeamMember: async () => ({
      id: "member_new_owner",
      teamId: "team_1",
      userId: "user_new_owner",
      role: "member"
    }),
    ensureUserExists: async () => ({
      id: "user_new_owner",
      email: "new-owner@example.com",
      displayName: "New Owner",
      role: "user",
      status: "active",
      lastSeenAt: now,
      maxConcurrentSessionsOverride: null
    }),
    findCurrentTeamSubscription: async () => {
      subscriptionLookupCalled = true;
      return null;
    },
    publishSubscriptionUpdatedEvent: async () => {
      eventPublished = true;
    },
    runtimeSessionService: {
      queueDirectSubscriptionAccessSync: async () => {
        panelSyncQueued = true;
        return 1;
      }
    },
    prisma: {
      $transaction: async () => {
        transactionCalled = true;
        throw new Error("owner transfer local save failed");
      },
      teamMember: {
        update: async () => ({}),
        updateMany: async () => ({})
      },
      team: {
        update: async () => ({})
      }
    }
  });

  await assert.rejects(
    () => service.updateTeamMember("team_1", "member_new_owner", { role: "owner" }),
    (error: unknown) =>
      error instanceof ServiceUnavailableException &&
      String((error as ServiceUnavailableException).message).includes("Team 成员保存失败")
  );
  assert.equal(transactionCalled, true, "owner transfer should try the local transaction");
  assert.equal(subscriptionLookupCalled, false, "local save failure must not start subscription lookup");
  assert.equal(panelSyncQueued, false, "local save failure must not queue remote panel sync");
  assert.equal(eventPublished, false, "local save failure must not publish subscription events");
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
    /当前团队/,
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
    /负责人/,
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
    /普通用户/,
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

async function testGetPoliciesMapsLocalReadFailure() {
  const service = createAnnouncementPolicyService({
    prisma: {
      policyProfile: {
        findUnique: async () => {
          throw new Error("policy public read failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.getPolicies(),
    (error) =>
      error instanceof ServiceUnavailableException &&
      /策略配置读取失败/.test(error.message) &&
      !/policy public read failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "client policy read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testGetAnnouncementsMapsLocalReadFailure() {
  const service = createAnnouncementPolicyService({
    prisma: {
      announcement: {
        findMany: async () => {
          throw new Error("announcement public read failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.getAnnouncements(),
    (error) =>
      error instanceof ServiceUnavailableException &&
      /公告列表读取失败/.test(error.message) &&
      !/announcement public read failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "client announcement read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testMarkAnnouncementReadMapsLocalReadFailure() {
  const service = createAnnouncementPolicyService({
    authSessionService: {
      authenticateAccessToken: async () => ({ id: "user_1" })
    },
    prisma: {
      announcement: {
        findMany: async () => {
          throw new Error("announcement read-state lookup failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.markClientAnnouncementsRead({ announcementIds: ["announcement_1"], action: "seen" }, "token"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      /公告状态读取失败/.test(error.message) &&
      !/announcement read-state lookup failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "announcement read-state lookups must return a controlled 503 instead of HTTP 500"
  );
}

async function testMarkAnnouncementReadMapsLocalSaveFailure() {
  const service = createAnnouncementPolicyService({
    authSessionService: {
      authenticateAccessToken: async () => ({ id: "user_1" })
    },
    prisma: {
      announcement: {
        findMany: async () => [
          {
            id: "announcement_1",
            displayMode: "passive"
          }
        ]
      },
      $transaction: async () => {
        throw new Error("announcement read-state save failed");
      }
    }
  });

  await assert.rejects(
    () => service.markClientAnnouncementsRead({ announcementIds: ["announcement_1"], action: "seen" }, "token"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      /公告已读状态保存失败/.test(error.message) &&
      !/announcement read-state save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "announcement read-state save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testCreateAnnouncementMapsLocalSaveFailure() {
  const service = createAnnouncementPolicyService({
    prisma: {
      announcement: {
        create: async () => {
          throw new Error("announcement create local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.createAnnouncement({
        title: "Title",
        body: "Body",
        level: "info"
      }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/announcement create local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "announcement create local save failures must return a controlled 503 instead of HTTP 500"
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

async function testUpdateAnnouncementMapsLocalReadFailure() {
  const service = createAnnouncementPolicyService({
    prisma: {
      announcement: {
        findUnique: async () => {
          throw new Error("announcement read failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.updateAnnouncement("announcement_1", { title: "Title" }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/announcement read failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "announcement update read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testUpdateAnnouncementMapsLocalSaveFailure() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const service = createAnnouncementPolicyService({
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
        update: async () => {
          throw new Error("announcement update local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.updateAnnouncement("announcement_1", { title: "Updated" }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/announcement update local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "announcement update local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testDeleteAnnouncementMapsLocalSaveFailure() {
  const service = createAnnouncementPolicyService({
    prisma: {
      announcement: {
        findUnique: async () => ({ id: "announcement_1" }),
        delete: async () => {
          throw new Error("announcement delete local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.deleteAnnouncement("announcement_1"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/announcement delete local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "announcement delete local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testAdminSnapshotCountsOnlyClientVisibleAnnouncements() {
  const now = new Date();
  const visiblePublishedAt = new Date(now.getTime() - 60_000).toISOString();
  const futurePublishedAt = new Date(now.getTime() + 60_000).toISOString();
  const makeAnnouncement = (id: string, publishedAt: string, isActive: boolean) => ({
    id,
    title: id,
    body: "Body",
    level: "info" as const,
    publishedAt,
    isActive,
    displayMode: "passive" as const,
    countdownSeconds: 0,
    createdAt: visiblePublishedAt,
    updatedAt: visiblePublishedAt
  });
  const service = createDevDataService({
    listAdminUsers: async () => [],
    listAdminPlans: async () => [],
    listAdminSubscriptions: async () => [],
    listAdminTeams: async () => [],
    listAdminNodes: async () => [],
    listAdminPanelSyncJobs: async () => [],
    getAdminPolicy: async () => ({
      defaultMode: "rule",
      modes: ["rule"],
      features: {
        blockAds: false,
        chinaDirect: true,
        aiServicesProxy: true
      }
    }),
    listAdminReleases: async () => [],
    getSupportTicketDashboardCounts: async () => ({
      openTickets: 0,
      waitingAdminTickets: 0,
      closedTickets: 0
    }),
    listAdminAnnouncements: async () => [
      makeAnnouncement("visible", visiblePublishedAt, true),
      makeAnnouncement("scheduled", futurePublishedAt, true),
      makeAnnouncement("inactive", visiblePublishedAt, false)
    ]
  });

  const snapshot = await service.getAdminSnapshot();

  assert.equal(snapshot.dashboard.announcements, 1);
}

async function testAdminSnapshotDoesNotHideOptionalListFailures() {
  const service = createDevDataService({
    listAdminUsers: async () => [],
    listAdminPlans: async () => {
      throw new Error("plans database unavailable");
    },
    listAdminSubscriptions: async () => [],
    listAdminTeams: async () => [],
    listAdminNodes: async () => [],
    listAdminPanelSyncJobs: async () => [],
    listAdminAnnouncements: async () => [],
    getAdminPolicy: async () => ({
      defaultMode: "rule",
      modes: ["rule"],
      features: {
        blockAds: false,
        chinaDirect: true,
        aiServicesProxy: true
      }
    }),
    listAdminReleases: async () => [],
    getSupportTicketDashboardCounts: async () => ({
      openTickets: 0,
      waitingAdminTickets: 0,
      closedTickets: 0
    })
  });

  await assert.rejects(
    () => service.getAdminSnapshot(),
    (error: unknown) => error instanceof Error && /plans database unavailable/.test(error.message),
    "admin snapshot must not turn local database failures into empty lists"
  );
}

async function testAdminSnapshotKeepsPolicyAsRequiredData() {
  const service = createDevDataService({
    listAdminUsers: async () => [],
    listAdminPlans: async () => [],
    listAdminSubscriptions: async () => [],
    listAdminTeams: async () => [],
    listAdminNodes: async () => [],
    listAdminPanelSyncJobs: async () => [],
    listAdminAnnouncements: async () => [],
    getAdminPolicy: async () => {
      throw new Error("policy unavailable");
    },
    listAdminReleases: async () => [],
    getSupportTicketDashboardCounts: async () => ({
      openTickets: 0,
      waitingAdminTickets: 0,
      closedTickets: 0
    })
  });

  await assert.rejects(
    () => service.getAdminSnapshot(),
    (error: unknown) => error instanceof Error && /policy unavailable/.test(error.message),
    "admin snapshot must not silently replace the active policy with a fake fallback"
  );
}

function testAdminUploadLimitsExposePositiveControllerLimits() {
  const controller = createInstance<AdminController>(AdminController.prototype);
  const limits = controller.getUploadLimits();

  assert.equal(Number.isInteger(limits.releaseArtifactMaxBytes), true);
  assert.equal(Number.isInteger(limits.runtimeComponentMaxBytes), true);
  assert.equal(Number.isInteger(limits.supportTicketAttachmentMaxBytes), true);
  assert.equal(limits.releaseArtifactMaxBytes > 0, true);
  assert.equal(limits.runtimeComponentMaxBytes > 0, true);
  assert.equal(limits.runtimeComponentMaxBytes < limits.releaseArtifactMaxBytes, true);
  assert.equal(limits.supportTicketAttachmentMaxBytes > 0, true);
}

async function testAdminDashboardCountsOnlyPublishedActiveAnnouncements() {
  const announcementCountPayloads: Array<Record<string, any>> = [];
  const subscriptionCountPayloads: Array<Record<string, any>> = [];
  const service = createDevDataService({
    getSupportTicketDashboardCounts: async () => ({
      openTickets: 0,
      waitingAdminTickets: 0,
      closedTickets: 0
    }),
    prisma: {
      user: { count: async () => 0 },
      team: { count: async () => 0 },
      plan: { count: async () => 0 },
      subscription: {
        count: async (payload: Record<string, any>) => {
          subscriptionCountPayloads.push(payload);
          return 2;
        }
      },
      node: { count: async () => 0 },
      announcement: {
        count: async (payload: Record<string, any>) => {
          announcementCountPayloads.push(payload);
          return 1;
        }
      }
    }
  });

  const dashboard = await service.getAdminDashboard();

  assert.equal(dashboard.announcements, 1);
  assert.equal(dashboard.activeSubscriptions, 2);
  assert.equal(subscriptionCountPayloads.length, 1);
  assert.equal(subscriptionCountPayloads[0].where.state, "active");
  assert.ok(subscriptionCountPayloads[0].where.expireAt?.gt instanceof Date);
  assert.deepEqual(subscriptionCountPayloads[0].where.remainingTrafficGb, { gt: 0 });
  assert.equal(announcementCountPayloads.length, 1);
  assert.equal(announcementCountPayloads[0].where.isActive, true);
  assert.ok(announcementCountPayloads[0].where.publishedAt?.lte instanceof Date);
}

async function testAdminDashboardCountsWaitingUserTicketsAsOpen() {
  const ticketCountPayloads: Array<Record<string, any>> = [];
  const service = createDevDataService({
    prisma: {
      supportTicket: {
        count: async (payload: Record<string, any>) => {
          ticketCountPayloads.push(payload);
          if (payload.where.status?.in?.includes("waiting_user")) {
            return 3;
          }
          if (payload.where.status === "waiting_admin") {
            return 2;
          }
          if (payload.where.status === "closed") {
            return 1;
          }
          return 0;
        }
      }
    }
  });

  const counts = await service["getSupportTicketDashboardCounts"]();

  assert.equal(counts.openTickets, 3);
  assert.equal(counts.waitingAdminTickets, 2);
  assert.equal(counts.closedTickets, 1);
  assert.deepEqual(ticketCountPayloads[0].where.status, { in: ["open", "waiting_user"] });
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

async function testCreateAnnouncementReturnsWhenPublishUserLookupStalls() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  let created = false;
  let publishLookupStarted = false;
  const service = createAnnouncementPolicyService({
    logger: {
      warn: () => undefined
    },
    prisma: {
      announcement: {
        create: async () => {
          created = true;
          return {
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
          };
        }
      },
      user: {
        findMany: async () => {
          publishLookupStarted = true;
          return new Promise<never>(() => undefined);
        }
      }
    }
  });

  const result = await Promise.race([
    service.createAnnouncement({
      title: "Title",
      body: "Body",
      level: "info"
    }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("announcement create waited for stalled publish user lookup")), 750);
    })
  ]);

  assert.equal(created, true);
  assert.equal(result.id, "announcement_1");
  assert.equal(publishLookupStarted, false, "announcement publish must not start before local create returns");
  await waitUntil(() => publishLookupStarted);
  assert.equal(publishLookupStarted, true, "announcement publish should still start in background");
}

async function testCreateAnnouncementPublishesUpdateEvent() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const published: Array<{ userIds: string[]; event: Record<string, any> }> = [];
  const adminPublished: Array<Record<string, any>> = [];
  const service = createAnnouncementPolicyService({
    logger: {
      warn: () => undefined
    },
    clientRuntimeEventsService: {
      publishToUsers: (userIds: string[], event: Record<string, any>) => {
        published.push({ userIds, event });
      }
    },
    adminRuntimeEventsService: {
      publish: (event: Record<string, any>) => {
        adminPublished.push(event);
      }
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
        findMany: async (payload: Record<string, any>) => {
          assert.deepEqual(payload.where, { status: "active" });
          return [{ id: "user_1" }, { id: "user_2" }, { id: "user_1" }];
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
  await waitUntil(() => published.length > 0);
  assert.deepEqual(published[0].userIds.sort(), ["user_1", "user_2"]);
  assert.equal(published[0].event.type, "announcement_updated");
  assert.equal(published[0].event.announcementId, "announcement_1");
  assert.equal(adminPublished[0].type, "announcement_updated");
  assert.equal(adminPublished[0].announcementId, "announcement_1");
}

async function testCreateAnnouncementPublishesClientEventWhenAdminPublishFails() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const warnings: string[] = [];
  const published: Array<{ userIds: string[]; event: Record<string, any> }> = [];
  const service = createAnnouncementPolicyService({
    logger: {
      warn: (message: string) => warnings.push(message)
    },
    clientRuntimeEventsService: {
      publishToUsers: (userIds: string[], event: Record<string, any>) => {
        published.push({ userIds, event });
      }
    },
    adminRuntimeEventsService: {
      publish: () => {
        throw new Error("admin sse failed");
      }
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
        findMany: async () => [{ id: "user_1" }]
      }
    }
  });

  await service.createAnnouncement({
    title: "Title",
    body: "Body",
    level: "info"
  });

  await waitUntil(() => published.length > 0);
  assert.deepEqual(published[0].userIds, ["user_1"]);
  assert.equal(published[0].event.type, "announcement_updated");
  assert.match(warnings.join("\n"), /admin sse failed/);
}

async function testUpdateAnnouncementPublishesUpdateEvent() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const published: Array<{ userIds: string[]; event: Record<string, any> }> = [];
  const service = createAnnouncementPolicyService({
    logger: {
      warn: () => undefined
    },
    clientRuntimeEventsService: {
      publishToUsers: (userIds: string[], event: Record<string, any>) => {
        published.push({ userIds, event });
      }
    },
    prisma: {
      announcement: {
        findUnique: async () => ({
          id: "announcement_1",
          title: "Old",
          body: "Body",
          level: "info",
          publishedAt: now,
          isActive: true,
          displayMode: "passive",
          countdownSeconds: 0,
          createdAt: now,
          updatedAt: now
        }),
        update: async (payload: Record<string, any>) => ({
          id: payload.where.id,
          title: payload.data.title ?? "Old",
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
        findMany: async (payload: Record<string, any>) => {
          assert.deepEqual(payload.where, { status: "active" });
          return [{ id: "user_1" }, { id: "user_2" }];
        }
      }
    }
  });

  const result = await service.updateAnnouncement("announcement_1", {
    title: "New"
  });

  assert.equal(result.title, "New");
  await waitUntil(() => published.length > 0);
  assert.deepEqual(published[0].userIds.sort(), ["user_1", "user_2"]);
  assert.equal(published[0].event.type, "announcement_updated");
  assert.equal(published[0].event.announcementId, "announcement_1");
}

async function testDeleteAnnouncementRemovesRecordAndPublishesUpdate() {
  const calls: string[] = [];
  const publishedIds: string[] = [];
  const service = createAnnouncementPolicyService({
    publishAnnouncementUpdatedEvent: async (announcementId: string) => {
      publishedIds.push(announcementId);
    },
    prisma: {
      announcement: {
        findUnique: async (payload: Record<string, any>) => {
          calls.push(`find:${payload.where.id}`);
          return { id: payload.where.id };
        },
        delete: async (payload: Record<string, any>) => {
          calls.push(`delete:${payload.where.id}`);
          return { id: payload.where.id };
        }
      }
    }
  });

  const result = await service.deleteAnnouncement("announcement_1");

  assert.deepEqual(calls, ["find:announcement_1", "delete:announcement_1"]);
  await waitUntil(() => publishedIds.length > 0);
  assert.deepEqual(publishedIds, ["announcement_1"]);
  assert.deepEqual(result, { ok: true, announcementId: "announcement_1" });
}

async function testDeleteAnnouncementRejectsMissingRecordBeforeDbDelete() {
  const calls: string[] = [];
  const service = createAnnouncementPolicyService({
    prisma: {
      announcement: {
        findUnique: async () => {
          calls.push("find");
          return null;
        },
        delete: async () => {
          calls.push("delete");
          throw new Error("delete should not be called for missing announcement");
        }
      }
    }
  });

  await assert.rejects(
    () => service.deleteAnnouncement("announcement_missing"),
    (error) => error instanceof NotFoundException,
    "missing announcement deletes must return a controlled 404"
  );
  assert.deepEqual(calls, ["find"]);
}

async function testDeleteAnnouncementKeepsLocalDeleteWhenPublishFails() {
  const warnings: string[] = [];
  const calls: string[] = [];
  const service = createAnnouncementPolicyService({
    logger: {
      warn: (message: string) => warnings.push(message)
    },
    prisma: {
      announcement: {
        findUnique: async () => ({ id: "announcement_1" }),
        delete: async () => {
          calls.push("delete");
          return { id: "announcement_1" };
        }
      },
      user: {
        findMany: async () => {
          throw new Error("active user lookup failed");
        }
      }
    }
  });

  const result = await service.deleteAnnouncement("announcement_1");

  assert.deepEqual(calls, ["delete"]);
  assert.deepEqual(result, { ok: true, announcementId: "announcement_1" });
  await waitUntil(() => warnings.length > 0);
  assert.match(warnings[0] ?? "", /announcement_updated publish failed/);
}

async function testMarkAnnouncementReadKeepsLocalSaveWhenPublishFails() {
  const upserts: Array<Record<string, any>> = [];
  const warnings: string[] = [];
  const service = createAnnouncementPolicyService({
    logger: {
      warn: (message: string) => warnings.push(message)
    },
    authSessionService: {
      authenticateAccessToken: async () => ({ id: "user_1" })
    },
    clientRuntimeEventsService: {
      publishToUser: () => {
        throw new Error("announcement read SSE unavailable");
      }
    },
    prisma: {
      announcement: {
        findMany: async () => [
          {
            id: "announcement_1",
            displayMode: "passive"
          }
        ]
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
        task({
          announcementReadState: {
            upsert: async (payload: Record<string, any>) => {
              upserts.push(payload);
            }
          }
        })
    }
  });

  const result = await service.markClientAnnouncementsRead(
    {
      announcementIds: ["announcement_1"],
      action: "seen"
    },
    "token"
  );

  assert.deepEqual(result.updatedIds, ["announcement_1"]);
  assert.equal(upserts.length, 1, "announcement read state must be saved before SSE publish");
  assert.match(warnings[0] ?? "", /announcement_read_state_updated publish failed/);
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

async function testGetAdminPolicyMapsLocalReadFailure() {
  const service = createAnnouncementPolicyService({
    prisma: {
      policyProfile: {
        findUnique: async () => {
          throw new Error("policy read failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.getAdminPolicy(),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/policy read failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "admin policy read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testUpdatePolicyMapsLocalSaveFailure() {
  const service = createAnnouncementPolicyService({
    prisma: {
      policyProfile: {
        findUnique: async () => ({
          id: "default",
          defaultMode: "rule",
          modes: ["rule"],
          blockAds: false,
          chinaDirect: true,
          aiServicesProxy: true,
          updatedAt: new Date()
        }),
        update: async () => {
          throw new Error("policy update local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.updatePolicy({ blockAds: true }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/policy update local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "admin policy save failures must return a controlled 503 instead of HTTP 500"
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

async function testUpdatePolicyDoesNotRefreshAfterLocalSave() {
  const updates: Array<Record<string, any>> = [];
  const adminPublished: Array<Record<string, any>> = [];
  const service = createAnnouncementPolicyService({
    logger: {
      warn: () => undefined
    },
    adminRuntimeEventsService: {
      publish: (event: Record<string, any>) => {
        adminPublished.push(event);
      }
    },
    getAdminPolicy: async () => {
      throw new Error("policy refresh should not run after local save");
    },
    prisma: {
      policyProfile: {
        findUnique: async () => ({
          id: "default",
          defaultMode: "rule",
          modes: ["rule"],
          blockAds: true,
          chinaDirect: true,
          aiServicesProxy: true
        }),
        update: async (payload: Record<string, any>) => {
          updates.push(payload);
          return {
            id: "default",
            defaultMode: "rule",
            modes: ["rule"],
            blockAds: payload.data.blockAds,
            chinaDirect: true,
            aiServicesProxy: true
          };
        }
      },
      user: {
        findMany: async () => []
      }
    }
  });

  const result = await service.updatePolicy({ blockAds: false });

  assert.equal(updates.length, 1);
  assert.equal(result.features.blockAds, false);
  await waitUntil(() => adminPublished.length > 0);
  assert.equal(adminPublished[0].type, "policy_updated");
}

async function testUpdatePolicyReturnsWhenPublishUserLookupStalls() {
  const updates: Array<Record<string, any>> = [];
  let publishLookupStarted = false;
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
          publishLookupStarted = true;
          return new Promise<never>(() => undefined);
        }
      }
    }
  });

  const result = await Promise.race([
    service.updatePolicy({ blockAds: false }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("policy update waited for stalled publish user lookup")), 750);
    })
  ]);

  assert.equal(updates.length, 1);
  assert.equal(result.features.blockAds, false);
  assert.equal(publishLookupStarted, false, "policy publish must not start before local update returns");
  await waitUntil(() => publishLookupStarted);
  assert.equal(publishLookupStarted, true, "policy publish should still start in background");
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
  assert.equal(result.attachmentUploadStatus, "uploaded");
  assert.equal(result.attachmentUploadError, null);
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
    (error) =>
      error instanceof ServiceUnavailableException &&
      /工单回复保存失败/.test(error.message) &&
      /已尝试清理本次上传附件/.test(error.message) &&
      !/已上传附件已清理/.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "admin ticket attachment local save failures must return a controlled 503 instead of HTTP 500"
  );
  assert.deepEqual(deletedUploads, ["support-tickets/orphan.png"]);
}

async function testAdminReplySupportTicketAttachmentMapsTransientPrismaFailure() {
  const deletedUploads: string[] = [];
  const uploadedFile = {
    url: "https://image.achord.cn/file/support-tickets/transient.png",
    providerFileId: "support-tickets/transient.png",
    fileName: "transient.png",
    mimeType: "image/png",
    fileSizeBytes: BigInt(1234)
  };

  const service = createDevDataService({
    prisma: {
      supportTicket: {
        findUnique: async () => ({ id: "ticket_1", status: "waiting_admin", userId: "user_1" })
      },
      $transaction: async () => {
        throw { code: "P2028", message: "Transaction already closed" };
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
          path: path.join(tmpdir(), "transient.png"),
          originalname: "transient.png",
          mimetype: "image/png",
          size: 1234
        },
        "admin_1"
      ),
    ServiceUnavailableException,
    "admin ticket attachment transient Prisma failures must return a controlled 503 instead of HTTP 500"
  );
  assert.deepEqual(deletedUploads, ["support-tickets/transient.png"]);
}

async function testAdminReplySupportTicketMapsLocalSaveFailure() {
  const service = createDevDataService({
    prisma: {
      supportTicket: {
        findUnique: async () => ({ id: "ticket_1", status: "waiting_admin", userId: "user_1" }),
        update: () => ({})
      },
      supportTicketMessage: {
        create: () => ({})
      },
      $transaction: async () => {
        throw new Error("admin ticket reply local save failed");
      }
    }
  });

  await assert.rejects(
    () => service.replyAdminSupportTicket("ticket_1", { body: "reply" }, "admin_1"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/admin ticket reply local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "admin ticket reply local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testAdminReplySupportTicketAttachmentUploadFailureSavesTextReply() {
  const writes: Array<{ kind: string; data: Record<string, unknown> }> = [];
  let publishCalls = 0;
  let cleanupCalls = 0;
  const service = createDevDataService({
    logger: {
      warn: () => undefined
    },
    prisma: {
      supportTicket: {
        findUnique: async () => ({ id: "ticket_1", status: "waiting_admin", userId: "user_1" })
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
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
      uploadSupportTicketAttachment: async () => {
        throw new BadRequestException("图床 API Token 未配置，请先在后台图床配置中填写。");
      },
      deleteUploadedSupportTicketAttachmentBestEffort: async () => {
        cleanupCalls += 1;
      }
    },
    clientRuntimeEventsService: {
      publishToUser: () => {
        publishCalls += 1;
      }
    },
    getAdminSupportTicketDetail: async () => {
      return { id: "ticket_1" };
    }
  });

  const result = await service.replyAdminSupportTicketWithAttachment(
    "ticket_1",
    { body: "please see attachment" },
    {
      path: path.join(tmpdir(), "upload-failure.png"),
      originalname: "upload-failure.png",
      mimetype: "image/png",
      size: 1234
    },
    "admin_1"
  );

  assert.equal(result.attachmentUploadStatus, "failed");
  assert.match(result.attachmentUploadError ?? "", /图床 API Token 未配置/);
  assert.equal(writes.filter((item) => item.kind === "message").length, 1);
  assert.equal(writes.filter((item) => item.kind === "attachment").length, 0);
  assert.equal(writes.filter((item) => item.kind === "ticket").length, 1);
  assert.match(String(writes.find((item) => item.kind === "message")?.data.body ?? ""), /please see attachment/);
  assert.equal(publishCalls, 1, "saved text reply must still publish ticket updates");
  assert.equal(cleanupCalls, 0, "there is no uploaded provider file to clean when upload itself fails");
}

async function testAdminReplySupportTicketAttachmentOnlyUploadFailureRejectsWithoutWritingReply() {
  const writes: Array<{ kind: string; data: Record<string, unknown> }> = [];
  let publishCalls = 0;
  const service = createDevDataService({
    logger: {
      warn: () => undefined
    },
    prisma: {
      supportTicket: {
        findUnique: async () => ({ id: "ticket_1", status: "waiting_admin", userId: "user_1" })
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
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
      uploadSupportTicketAttachment: async () => {
        throw new Error("image bed upload failed");
      }
    },
    clientRuntimeEventsService: {
      publishToUser: () => {
        publishCalls += 1;
      }
    },
    getAdminSupportTicketDetail: async () => {
      return { id: "ticket_1" };
    }
  });

  await assert.rejects(
    () =>
      service.replyAdminSupportTicketWithAttachment(
        "ticket_1",
        { body: "" },
        {
          path: path.join(tmpdir(), "upload-failure.png"),
          originalname: "upload-failure.png",
          mimetype: "image/png",
          size: 1234
        },
        "admin_1"
      ),
    (error) => error instanceof ServiceUnavailableException && /附件上传失败/.test(error.message),
    "attachment-only admin upload failures must reject instead of writing a fake ticket reply"
  );

  assert.deepEqual(writes, [], "attachment-only upload failure must not write a message, attachment, or ticket status change");
  assert.equal(publishCalls, 0, "attachment-only upload failure must not publish ticket updates");
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

async function testAdminReplySupportTicketPublishesClientAndAdminEvents() {
  const clientEvents: Array<{ userId: string; event: Record<string, unknown> }> = [];
  const adminEvents: Array<Record<string, unknown>> = [];
  const service = createDevDataService({
    logger: {
      warn: () => undefined
    },
    prisma: {
      supportTicket: {
        findUnique: async () => ({ id: "ticket_1", status: "waiting_admin", userId: "user_1" }),
        update: async () => ({})
      },
      $transaction: async (operations: Array<Promise<unknown>>) => {
        await Promise.all(operations);
      },
      supportTicketMessage: {
        create: async () => ({})
      }
    },
    clientRuntimeEventsService: {
      publishToUser: (userId: string, event: Record<string, unknown>) => {
        clientEvents.push({ userId, event });
      }
    },
    adminRuntimeEventsService: {
      publishTicketUpdated: (event: Record<string, unknown>) => {
        adminEvents.push(event);
      }
    },
    getAdminSupportTicketDetail: async (ticketId: string) => ({ id: ticketId })
  });

  await service.replyAdminSupportTicket("ticket_1", { body: "reply" }, "admin_1");

  assert.equal(clientEvents.length, 1);
  assert.equal(clientEvents[0].userId, "user_1");
  assert.equal(clientEvents[0].event.type, "ticket_updated");
  assert.equal(clientEvents[0].event.ticketId, "ticket_1");
  assert.equal(clientEvents[0].event.ticketStatus, "waiting_user");
  assert.deepEqual(adminEvents, [{ ticketId: "ticket_1", ticketStatus: "waiting_user" }]);
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
    lastMessageAt: new Date("2026-01-01T00:00:30.000Z"),
    closedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:30.000Z"),
    user: {
      id: "user_1",
      email: "user@example.com",
      displayName: "User"
    },
    team: null,
    messages: [
      {
        id: "ticket_msg_existing",
        ticketId: "ticket_1",
        authorRole: "user",
        authorUserId: "user_1",
        body: "original question",
        createdAt: new Date("2026-01-01T00:00:30.000Z"),
        attachments: [],
        authorUser: {
          id: "user_1",
          email: "user@example.com",
          displayName: "User"
        }
      }
    ]
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
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0]?.body, "original question");
  assert.equal(result.messages[1]?.body, "reply saved");
  assert.equal(result.messages[1]?.authorRole, "admin");
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
    lastMessageAt: new Date("2026-01-01T00:00:30.000Z"),
    closedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:30.000Z"),
    user: {
      id: "user_1",
      email: "user@example.com",
      displayName: "User"
    },
    team: {
      id: "team_1",
      name: "Team"
    },
    messages: [
      {
        id: "ticket_msg_existing",
        ticketId: "ticket_1",
        authorRole: "user",
        authorUserId: "user_1",
        body: "original attachment question",
        createdAt: new Date("2026-01-01T00:00:30.000Z"),
        attachments: [],
        authorUser: {
          id: "user_1",
          email: "user@example.com",
          displayName: "User"
        }
      }
    ]
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
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0]?.body, "original attachment question");
  assert.equal(result.messages[1]?.attachments[0]?.url, uploadedFile.url);
  assert.equal(result.messages[1]?.attachments[0]?.fileSizeBytes, uploadedFile.fileSizeBytes.toString());
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /detail refresh failed/);
}

async function testAdminReplySupportTicketReturnsFallbackWhenDetailRefreshStalls() {
  const ticketRow = {
    id: "ticket_1",
    title: "Need help",
    status: "waiting_admin",
    source: "desktop",
    userId: "user_1",
    subscriptionId: null,
    teamId: null,
    lastMessageAt: new Date("2026-01-01T00:00:30.000Z"),
    closedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:30.000Z"),
    user: {
      id: "user_1",
      email: "user@example.com",
      displayName: "User"
    },
    team: null,
    messages: [
      {
        id: "ticket_msg_existing",
        ticketId: "ticket_1",
        authorRole: "user",
        authorUserId: "user_1",
        body: "original question",
        createdAt: new Date("2026-01-01T00:00:30.000Z"),
        attachments: [],
        authorUser: {
          id: "user_1",
          email: "user@example.com",
          displayName: "User"
        }
      }
    ]
  };
  const service = createDevDataService({
    logger: {
      warn: () => undefined
    },
    prisma: {
      supportTicket: {
        findUnique: async () => ticketRow,
        update: async () => ({})
      },
      $transaction: async (operations: Array<Promise<unknown>>) => {
        await Promise.all(operations);
      },
      supportTicketMessage: {
        create: async () => ({})
      }
    },
    clientRuntimeEventsService: {
      publishToUser: () => undefined
    },
    getAdminSupportTicketDetail: async () => new Promise(() => undefined)
  });

  const result = await Promise.race([
    service.replyAdminSupportTicket("ticket_1", { body: "reply saved" }, "admin_1"),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("admin ticket reply waited for stalled detail refresh")), 750);
    })
  ]);

  assert.equal(result.id, "ticket_1");
  assert.equal(result.status, "waiting_user");
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0]?.body, "original question");
  assert.equal(result.messages[1]?.body, "reply saved");
}

async function testCloseAdminSupportTicketReturnsFallbackWhenDetailRefreshStalls() {
  let updatedStatus: string | null = null;
  const adminEvents: Array<Record<string, unknown>> = [];
  const ticketRow = {
    id: "ticket_1",
    title: "Need help",
    status: "waiting_admin",
    source: "desktop",
    userId: "user_1",
    subscriptionId: null,
    teamId: null,
    closedAt: null,
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
      warn: () => undefined
    },
    prisma: {
      supportTicket: {
        findUnique: async () => ticketRow,
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updatedStatus = data.status as string;
          return {};
        }
      }
    },
    clientRuntimeEventsService: {
      publishToUser: () => undefined
    },
    adminRuntimeEventsService: {
      publishTicketUpdated: (event: Record<string, unknown>) => {
        adminEvents.push(event);
      }
    },
    getAdminSupportTicketDetail: async () => new Promise(() => undefined)
  });

  const result = await Promise.race([
    service.closeAdminSupportTicket("ticket_1"),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("admin ticket close waited for stalled detail refresh")), 750);
    })
  ]);

  assert.equal(updatedStatus, "closed");
  assert.deepEqual(adminEvents, [{ ticketId: "ticket_1", ticketStatus: "closed" }]);
  assert.equal(result.id, "ticket_1");
  assert.equal(result.status, "closed");
}

async function testCloseAdminSupportTicketMapsLocalSaveFailure() {
  const ticketRow = {
    id: "ticket_1",
    title: "Need help",
    status: "waiting_admin",
    source: "desktop",
    userId: "user_1",
    subscriptionId: null,
    teamId: null,
    closedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    user: { id: "user_1", email: "user@example.com", displayName: "User" },
    team: null,
    messages: []
  };
  const service = createDevDataService({
    prisma: {
      supportTicket: {
        findUnique: async () => ticketRow,
        update: async () => {
          throw new Error("admin ticket close local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.closeAdminSupportTicket("ticket_1"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/admin ticket close local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "admin ticket close local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testReopenAdminSupportTicketReturnsFallbackWhenDetailRefreshStalls() {
  let updatedStatus: string | null = null;
  let capturedFindUniqueArgs: Record<string, any> | null = null;
  const ticketRow = {
    id: "ticket_1",
    title: "Need help",
    status: "closed",
    source: "desktop",
    userId: "user_1",
    subscriptionId: null,
    teamId: null,
    closedAt: new Date("2026-01-02T00:00:00.000Z"),
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
      warn: () => undefined
    },
    prisma: {
      supportTicket: {
        findUnique: async (args: Record<string, any>) => {
          capturedFindUniqueArgs = args;
          return ticketRow;
        },
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updatedStatus = data.status as string;
          return {};
        }
      }
    },
    clientRuntimeEventsService: {
      publishToUser: () => undefined
    },
    getAdminSupportTicketDetail: async () => new Promise(() => undefined)
  });

  const result = await Promise.race([
    service.reopenAdminSupportTicket("ticket_1"),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("admin ticket reopen waited for stalled detail refresh")), 750);
    })
  ]);

  assert.equal(updatedStatus, "open");
  assert.equal(capturedFindUniqueArgs?.include?.messages?.take, 300, "admin ticket reopen must cap returned messages");
  assert.equal(result.id, "ticket_1");
  assert.equal(result.status, "open");
  assert.equal(result.closedAt, null);
}

async function testReopenAdminSupportTicketMapsLocalSaveFailure() {
  const ticketRow = {
    id: "ticket_1",
    title: "Need help",
    status: "closed",
    source: "desktop",
    userId: "user_1",
    subscriptionId: null,
    teamId: null,
    closedAt: new Date("2026-01-02T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    user: { id: "user_1", email: "user@example.com", displayName: "User" },
    team: null,
    messages: []
  };
  const service = createDevDataService({
    prisma: {
      supportTicket: {
        findUnique: async () => ticketRow,
        update: async () => {
          throw new Error("admin ticket reopen local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.reopenAdminSupportTicket("ticket_1"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/admin ticket reopen local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "admin ticket reopen local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testClientCreateSupportTicketReturnsFallbackWhenDetailRefreshStalls() {
  let createdTicket: Record<string, any> | null = null;
  const adminEvents: Array<Record<string, unknown>> = [];
  const service = createClientTicketService({
    logger: {
      warn: () => undefined
    },
    authSessionService: {
      authenticateAccessToken: async () => ({ id: "user_1" })
    },
    resolveSubscriptionAccessForUser: async () => ({
      subscription: { id: "sub_1" },
      team: null
    }),
    prisma: {
      supportTicket: {
        create: async ({ data }: { data: Record<string, any> }) => {
          createdTicket = data;
          return data;
        }
      }
    },
    clientRuntimeEventsService: {
      publishToUser: () => undefined
    },
    adminRuntimeEventsService: {
      publishTicketUpdated: (event: Record<string, unknown>) => {
        adminEvents.push(event);
      }
    },
    getClientSupportTicketDetail: async () => new Promise(() => undefined)
  });

  const result = await Promise.race([
    service.createClientSupportTicket({ title: " Need help ", body: " body saved " }, "token"),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("client ticket create waited for stalled detail refresh")), 750);
    })
  ]);

  assert.ok(createdTicket);
  assert.deepEqual(adminEvents, [{ ticketId: createdTicket.id, ticketStatus: "waiting_admin" }]);
  assert.equal(result.title, "Need help");
  assert.equal(result.subscriptionId, "sub_1");
  assert.equal(result.messages[0]?.body, "body saved");
}

async function testClientReplySupportTicketReturnsFallbackWhenDetailRefreshStalls() {
  const writes: string[] = [];
  const ticketRow = {
    id: "ticket_1",
    title: "Need help",
    status: "waiting_user",
    source: "desktop",
    subscriptionId: "sub_1",
    teamId: null,
    lastMessageAt: new Date("2026-01-01T00:01:00.000Z"),
    closedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:01:00.000Z"),
    team: null,
    readStates: [{ lastReadAt: new Date("2026-01-01T00:01:00.000Z"), lastReadMessageAt: new Date("2026-01-01T00:01:00.000Z") }],
    messages: [
      {
        id: "ticket_msg_existing",
        ticketId: "ticket_1",
        authorRole: "admin",
        body: "existing admin reply",
        createdAt: new Date("2026-01-01T00:01:00.000Z"),
        authorUser: { displayName: "Support" },
        attachments: []
      }
    ]
  };
  const service = createClientTicketService({
    logger: {
      warn: () => undefined
    },
    authSessionService: {
      authenticateAccessToken: async () => ({ id: "user_1" })
    },
    prisma: {
      supportTicket: {
        findFirst: async () => ticketRow,
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
      publishToUser: () => undefined
    },
    getClientSupportTicketDetail: async () => new Promise(() => undefined)
  });

  const result = await Promise.race([
    service.replyClientSupportTicket("ticket_1", { body: "reply saved" }, "token"),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("client ticket reply waited for stalled detail refresh")), 750);
    })
  ]);

  assert.deepEqual(writes.sort(), ["message", "read_state", "ticket"]);
  assert.equal(result.id, "ticket_1");
  assert.equal(result.messages[0]?.body, "existing admin reply");
  assert.equal(result.messages[0]?.authorDisplayName, "Support");
  assert.equal(result.messages[1]?.body, "reply saved");
}

async function testClientReplySupportTicketAttachmentReturnsFallbackWhenDetailRefreshStalls() {
  const uploadedFile = {
    url: "https://image.achord.cn/file/support-tickets/client-fallback.png",
    providerFileId: "support-tickets/client-fallback.png",
    fileName: "client-fallback.png",
    mimeType: "image/png",
    fileSizeBytes: BigInt(1234)
  };
  const ticketRow = {
    id: "ticket_1",
    title: "Need attachment",
    status: "waiting_user",
    source: "desktop",
    subscriptionId: "sub_1",
    teamId: null,
    lastMessageAt: new Date("2026-01-01T00:01:00.000Z"),
    closedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:01:00.000Z"),
    team: null,
    readStates: [{ lastReadAt: new Date("2026-01-01T00:01:00.000Z"), lastReadMessageAt: new Date("2026-01-01T00:01:00.000Z") }],
    messages: [
      {
        id: "ticket_msg_existing",
        ticketId: "ticket_1",
        authorRole: "admin",
        body: "existing attachment discussion",
        createdAt: new Date("2026-01-01T00:01:00.000Z"),
        authorUser: { displayName: "Support" },
        attachments: [
          {
            id: "att_existing",
            url: "https://image.achord.cn/file/support-tickets/existing.png",
            fileName: "existing.png",
            mimeType: "image/png",
            fileSizeBytes: BigInt(99),
            createdAt: new Date("2026-01-01T00:01:01.000Z")
          }
        ]
      }
    ]
  };
  const service = createClientTicketService({
    logger: {
      warn: () => undefined
    },
    authSessionService: {
      authenticateAccessToken: async () => ({ id: "user_1" })
    },
    prisma: {
      supportTicket: {
        findFirst: async () => ticketRow
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<void>) =>
        task({
          supportTicketMessage: {
            create: async ({ data }: { data: Record<string, unknown> }) => ({ id: data.id })
          },
          supportTicketAttachment: {
            create: async ({ data }: { data: Record<string, unknown> }) => data
          },
          supportTicket: {
            update: async () => ({})
          },
          supportTicketReadState: {
            upsert: async () => ({})
          }
        })
    },
    imageBedService: {
      uploadSupportTicketAttachment: async () => uploadedFile,
      deleteUploadedSupportTicketAttachmentBestEffort: async () => undefined
    },
    clientRuntimeEventsService: {
      publishToUser: () => undefined
    },
    getClientSupportTicketDetail: async () => new Promise(() => undefined)
  });

  const result = await Promise.race([
    service.replyClientSupportTicketWithAttachment(
      "ticket_1",
      { body: "" },
      {
        path: path.join(tmpdir(), "client-fallback.png"),
        originalname: "client-fallback.png",
        mimetype: "image/png",
        size: 1234
      },
      "token"
    ),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("client ticket attachment reply waited for stalled detail refresh")), 750);
    })
  ]);

  assert.equal(result.id, "ticket_1");
  assert.equal(result.messages[0]?.body, "existing attachment discussion");
  assert.equal(result.messages[0]?.attachments[0]?.url, "https://image.achord.cn/file/support-tickets/existing.png");
  assert.equal(result.messages[1]?.body, `Uploaded attachment: ${uploadedFile.fileName}`);
  assert.equal(result.messages[1]?.attachments[0]?.url, uploadedFile.url);
  assert.equal(result.messages[1]?.attachments[0]?.fileSizeBytes, uploadedFile.fileSizeBytes.toString());
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

async function testClientSupportTicketListMapsLocalReadFailure() {
  const service = createClientTicketService({
    authSessionService: {
      authenticateAccessToken: async () => ({ id: "user_1" })
    },
    prisma: {
      supportTicket: {
        findMany: async () => {
          throw new Error("client ticket list local read failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.listClientSupportTickets("token"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/client ticket list local read failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "client ticket list read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testAdminSupportTicketListMapsLocalReadFailure() {
  const service = createDevDataService({
    prisma: {
      supportTicket: {
        findMany: async () => {
          throw new Error("admin ticket list local read failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.listAdminSupportTickets(),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/admin ticket list local read failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "admin ticket list read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testAdminSupportTicketListUsesBoundedQuery() {
  let capturedArgs: Record<string, any> | null = null;
  const service = createDevDataService({
    prisma: {
      supportTicket: {
        findMany: async (args: Record<string, any>) => {
          capturedArgs = args;
          return [];
        }
      }
    }
  });

  const result = await service.listAdminSupportTickets();

  assert.deepEqual(result, []);
  assert.equal(capturedArgs?.take, 200, "admin ticket list must cap returned tickets");
  assert.equal(capturedArgs?.include?.messages?.take, 1, "admin ticket list must only read the latest message preview");
}

async function testAdminSupportTicketDetailUsesBoundedRecentMessagesInAscendingOrder() {
  let capturedArgs: Record<string, any> | null = null;
  const service = createDevDataService({
    prisma: {
      supportTicket: {
        findUnique: async (args: Record<string, any>) => {
          capturedArgs = args;
          return {
            id: "ticket_1",
            title: "Need help",
            status: "waiting_admin",
            source: "desktop",
            userId: "user_1",
            subscriptionId: "sub_1",
            teamId: null,
            lastMessageAt: new Date("2026-01-01T00:02:00.000Z"),
            closedAt: null,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:02:00.000Z"),
            user: { id: "user_1", email: "user@example.com", displayName: "User" },
            team: null,
            messages: [
              {
                id: "msg_new",
                ticketId: "ticket_1",
                authorRole: "admin",
                authorUserId: null,
                body: "new",
                createdAt: new Date("2026-01-01T00:02:00.000Z"),
                authorUser: null,
                attachments: []
              },
              {
                id: "msg_old",
                ticketId: "ticket_1",
                authorRole: "user",
                authorUserId: "user_1",
                body: "old",
                createdAt: new Date("2026-01-01T00:01:00.000Z"),
                authorUser: { id: "user_1", email: "user@example.com", displayName: "User" },
                attachments: []
              }
            ]
          };
        }
      }
    }
  });

  const result = await service.getAdminSupportTicketDetail("ticket_1");

  assert.equal(capturedArgs?.include?.messages?.take, 300, "admin ticket detail must cap returned messages");
  assert.deepEqual(
    result.messages.map((message) => message.id),
    ["msg_old", "msg_new"],
    "admin ticket detail must return the bounded recent messages in ascending chat order"
  );
}

async function testReleaseListMapsLocalReadFailure() {
  const service = createReleaseCenterService({
    prisma: {
      release: {
        findMany: async () => {
          throw new Error("release list local read failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.listAdminReleases(),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/release list local read failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "release list read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testClientUpdateCheckMapsLocalReadFailure() {
  const service = createReleaseCenterService({
    prisma: {
      release: {
        findMany: async () => {
          throw new Error("release candidates local read failed");
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.checkClientUpdate({
        currentVersion: "1.1.6",
        platform: "windows",
        channel: "stable"
      }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/release candidates local read failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "client update release reads must return a controlled 503 instead of HTTP 500"
  );
}

async function testRuntimeComponentListMapsLocalReadFailure() {
  const service = createRuntimeComponentsService({
    prisma: {
      runtimeComponent: {
        findMany: async () => {
          throw new Error("runtime component list local read failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.listAdminRuntimeComponents(),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/runtime component list local read failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "runtime component list read failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testRuntimePlanMapsLocalReadFailure() {
  let calls = 0;
  const service = createRuntimeComponentsService({
    prisma: {
      runtimeComponent: {
        findMany: async () => {
          calls += 1;
          if (calls === 1) {
            return [];
          }
          throw new Error("runtime shared ruleset local read failed");
        }
      }
    }
  });

  await assert.rejects(
    () =>
      service.getClientRuntimeComponentsPlan({
        platform: "windows",
        architecture: "x64"
      }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/runtime shared ruleset local read failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "runtime component plan reads must return a controlled 503 instead of HTTP 500"
  );
}

async function testClientCreateSupportTicketMapsLocalSaveFailure() {
  const service = createClientTicketService({
    authSessionService: {
      authenticateAccessToken: async () => ({ id: "user_1" })
    },
    resolveSubscriptionAccessForUser: async () => ({
      subscription: { id: "sub_1" },
      team: null
    }),
    prisma: {
      supportTicket: {
        create: async () => {
          throw new Error("client ticket create local save failed");
        }
      }
    }
  });

  await assert.rejects(
    () => service.createClientSupportTicket({ title: "Need help", body: "Body" }, "token"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/client ticket create local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "client ticket create local save failures must return a controlled 503 instead of HTTP 500"
  );
}

async function testClientReplySupportTicketMapsLocalSaveFailure() {
  const service = createClientTicketService({
    authSessionService: {
      authenticateAccessToken: async () => ({ id: "user_1" })
    },
    prisma: {
      supportTicket: {
        findFirst: async () => ({ id: "ticket_1", status: "waiting_user" })
      },
      $transaction: async () => {
        throw new Error("client ticket reply local save failed");
      }
    }
  });

  await assert.rejects(
    () => service.replyClientSupportTicket("ticket_1", { body: "reply" }, "token"),
    (error) =>
      error instanceof ServiceUnavailableException &&
      !/client ticket reply local save failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message),
    "client ticket reply local save failures must return a controlled 503 instead of HTTP 500"
  );
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
    (error) =>
      error instanceof ServiceUnavailableException &&
      /已尝试清理本次上传附件/.test(error.message) &&
      !/已上传附件已清理/.test(error.message) &&
      !/db write failed/i.test(error.message) &&
      !/HTTP 500/i.test(error.message)
  );
  assert.deepEqual(deletedUploads, ["support-tickets/client-orphan.png"]);
}

async function testClientReplySupportTicketAttachmentMapsTransientPrismaFailure() {
  const deletedUploads: string[] = [];
  const uploadedFile = {
    url: "https://image.achord.cn/file/support-tickets/client-transient.png",
    providerFileId: "support-tickets/client-transient.png",
    fileName: "client-transient.png",
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
        throw { code: "P2028", message: "Transaction already closed" };
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
          path: path.join(tmpdir(), "client-transient.png"),
          originalname: "client-transient.png",
          mimetype: "image/png",
          size: 1234
        },
        "token"
      ),
    ServiceUnavailableException,
    "client ticket attachment transient Prisma failures must return a controlled 503 instead of HTTP 500"
  );
  assert.deepEqual(deletedUploads, ["support-tickets/client-transient.png"]);
}

async function testClientReplySupportTicketAttachmentUploadFailureSavesTextReply() {
  const writes: Array<{ kind: string; data: Record<string, unknown> }> = [];
  let publishCalls = 0;
  let cleanupCalls = 0;
  const service = createClientTicketService({
    logger: {
      warn: () => undefined
    },
    authSessionService: {
      authenticateAccessToken: async () => ({ id: "user_1" })
    },
    prisma: {
      supportTicket: {
        findFirst: async () => ({
          id: "ticket_1",
          title: "Need help",
          status: "waiting_user",
          subscriptionId: "sub_1",
          teamId: null,
          closedAt: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          team: null
        })
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
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
          },
          supportTicketReadState: {
            upsert: async ({ update }: { update: Record<string, unknown> }) => {
              writes.push({ kind: "read", data: update });
              return update;
            }
          }
        })
    },
    imageBedService: {
      uploadSupportTicketAttachment: async () => {
        throw new BadRequestException("图床 API Token 未配置，请先在后台图床配置中填写。");
      },
      deleteUploadedSupportTicketAttachmentBestEffort: async () => {
        cleanupCalls += 1;
      }
    },
    clientRuntimeEventsService: {
      publishToUser: () => {
        publishCalls += 1;
      }
    },
    getClientSupportTicketDetail: async () => {
      return { id: "ticket_1" };
    }
  });

  const result = await service.replyClientSupportTicketWithAttachment(
    "ticket_1",
    { body: "please see attachment" },
    {
      path: path.join(tmpdir(), "client-upload-failure.png"),
      originalname: "client-upload-failure.png",
      mimetype: "image/png",
      size: 1234
    },
    "token"
  );

  assert.equal(result.attachmentUploadStatus, "failed");
  assert.match(result.attachmentUploadError ?? "", /图床 API Token 未配置/);
  assert.equal(writes.filter((item) => item.kind === "message").length, 1);
  assert.equal(writes.filter((item) => item.kind === "attachment").length, 0);
  assert.equal(writes.filter((item) => item.kind === "ticket").length, 1);
  assert.equal(writes.filter((item) => item.kind === "read").length, 1);
  assert.match(String(writes.find((item) => item.kind === "message")?.data.body ?? ""), /please see attachment/);
  assert.equal(publishCalls, 1, "saved text reply must still publish ticket updates");
  assert.equal(cleanupCalls, 0, "there is no uploaded provider file to clean when upload itself fails");
}

async function testClientReplySupportTicketAttachmentOnlyUploadFailureRejectsWithoutWritingReply() {
  const writes: Array<{ kind: string; data: Record<string, unknown> }> = [];
  let publishCalls = 0;
  const service = createClientTicketService({
    logger: {
      warn: () => undefined
    },
    authSessionService: {
      authenticateAccessToken: async () => ({ id: "user_1" })
    },
    prisma: {
      supportTicket: {
        findFirst: async () => ({
          id: "ticket_1",
          title: "Need help",
          status: "waiting_user",
          subscriptionId: "sub_1",
          teamId: null,
          closedAt: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          team: null
        })
      },
      $transaction: async (task: (tx: Record<string, any>) => Promise<unknown>) =>
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
          },
          supportTicketReadState: {
            upsert: async ({ update }: { update: Record<string, unknown> }) => {
              writes.push({ kind: "read", data: update });
              return update;
            }
          }
        })
    },
    imageBedService: {
      uploadSupportTicketAttachment: async () => {
        throw new Error("image bed upload failed");
      }
    },
    clientRuntimeEventsService: {
      publishToUser: () => {
        publishCalls += 1;
      }
    },
    getClientSupportTicketDetail: async () => {
      return { id: "ticket_1" };
    }
  });

  await assert.rejects(
    () =>
      service.replyClientSupportTicketWithAttachment(
        "ticket_1",
        { body: "" },
        {
          path: path.join(tmpdir(), "client-upload-failure.png"),
          originalname: "client-upload-failure.png",
          mimetype: "image/png",
          size: 1234
        },
        "token"
      ),
    (error) => error instanceof ServiceUnavailableException && /附件上传失败/.test(error.message),
    "attachment-only client upload failures must reject instead of writing a fake ticket reply"
  );

  assert.deepEqual(writes, [], "attachment-only upload failure must not write a message, attachment, read state, or ticket status change");
  assert.equal(publishCalls, 0, "attachment-only upload failure must not publish ticket updates");
}

async function main() {
  await testSubscriptionUsageLockTimesOutWithoutPoisoningLocalQueue();
  await testSubscriptionOwnerLockTimesOutAsRetryableConflict();
  await testClientAuthGuardRejectsAdminTokens();
  await testClientAuthGuardAllowsUserTokens();
  await testPublicRemoteUrlDnsLookupRespectsTimeout();
  await testPublicRemoteUrlRejectsPrivateAddressOnConnectLookup();
  await testUpdateUserPasswordRevokesExistingSessions();
  await testUpdateUserRoleRevokesExistingSessions();
  await testUpdateUserKeepsLocalSaveWhenSessionRevocationFails();
  await testListAdminUsersMapsLocalReadFailure();
  await testCreateUserMapsPreflightEmailReadFailure();
  await testCreateSubscriptionMapsPreflightUserReadFailure();
  await testRefreshTokenLogoutRevokesOnlyCurrentRefreshToken();
  await testRefreshTokenRotationUsesExtendedTransactionTimeout();
  await testIssueSessionMapsUserReadFailure();
  await testIssueSessionMapsRefreshTokenSaveFailure();
  await testRefreshTokenRotationMapsReadFailure();
  await testAccessTokenLogoutRevokesOnlyBoundSession();
  await testAccessTokenLogoutMapsRefreshTokenSaveFailure();
  await testAccessTokenAuthenticationRequiresActiveBoundSession();
  await testAccessTokenAuthenticationMapsUserReadFailure();
  await testAccessTokenAuthenticationMapsSessionReadFailure();
  await testRuntimeEventStreamValidatesBeforeDispatch();
  await testRuntimeEventReplayValidatesBeforeDispatch();
  await testRuntimeEventStreamPreservesOrderWithAsyncValidation();
  await testAdminRuntimeEventReplayValidatesBeforeDispatch();
  await testAdminRuntimeEventStreamPreservesOrderWithAsyncValidation();
  await testExternalReleaseMetadataRejectsPrivateNetworkUrl();
  await testExternalReleaseMetadataRejectsStalledResponse();
  await testExternalReleaseMetadataMapsHttp500ToBadRequest();
  await testExternalReleaseDownloadRejectsStalledBody();
  await testExternalReleaseDownloadMapsHttp500ToBadRequest();
  await testReleaseDownloadRejectsDraftArtifacts();
  await testReleaseDownloadAllowsUploadedArtifactWithStaleMetadata();
  await testReleaseDownloadMissingUploadedFileReturnsNotFound();
  await testReleaseDownloadUnreadableUploadedFileReturnsServiceUnavailable();
  await testReleaseDownloadMapsSendFileMissingToNotFound();
  await testRuntimeDownloadRejectsDisabledComponents();
  await testRuntimeDownloadRejectsUploadedComponentWithStaleMetadata();
  await testRuntimeDownloadMissingUploadedFileReturnsNotFound();
  await testRuntimeDownloadUnreadableUploadedFileReturnsServiceUnavailable();
  await testRuntimeDownloadStatFailureReturnsServiceUnavailable();
  await testRuntimeDownloadMapsSendFileFailureToServiceUnavailable();
  await testRuntimeDownloadIgnoresSendFileFailureAfterHeadersSent();
  await testUpdateReleaseDelegatesToReleaseCenter();
  await testAdminReleaseListAppliesFilters();
  await testCreateReleaseFallsBackToVersionWhenDisplayTitleIsBlank();
  await testCreateReleaseDefaultsMissingMinimumVersionToVersion();
  await testReleaseDraftMutationsPublishAdminRefreshEvent();
  await testUpdateReleaseFallsBackToVersionWhenDisplayTitleIsBlank();
  await testCreateReleaseRejectsPublishedStatusWithoutArtifactFlow();
  await testCreateReleaseWithInitialArtifactUsesSingleTransaction();
  await testCreateReleaseWithInitialExternalFullReplaceAllowsNonZipUrl();
  await testCreateReleaseRejectsDuplicateVersionAsConflict();
  await testCreateReleaseMapsLocalSaveFailure();
  await testPublishReleaseKeepsLocalSaveWhenVersionEventFails();
  await testPublishReleaseMapsLocalSaveFailure();
  await testUpdateReleaseMapsLocalSaveFailure();
  await testUnpublishReleaseClearsPublishedStateAndPublishesVersionEvent();
  await testUnpublishReleaseKeepsLocalSaveWhenVersionEventFails();
  await testUnpublishReleaseMapsLocalSaveFailure();
  await testUnpublishReleaseRejectsArchivedReleaseBeforeDbWrite();
  await testAssertReleasePublishableAllowsExternalWindowsZipWithoutOptionalMetadata();
  await testPublishReleaseAllowsWindowsZipWithoutOptionalMetadata();
  await testPublishReleaseAllowsReadableUploadedWindowsZipWithoutDeepInspection();
  await testPublishReleaseRejectsMissingUploadedArtifactFile();
  await testPublishReleaseAllowsUsableExternalWhenSecondaryUploadIsMissing();
  await testPublishReleaseAllowsWindowsExternalZipWithoutOptionalMetadata();
  await testCreateReleaseArtifactDelegatesToReleaseCenter();
  await testExternalReleaseFlowPublishesAndFeedsClientUpdateCheck();
  await testUploadedReleaseFlowPublishesAndFeedsClientDownloadDescriptor();
  await testConvertToTeamDelegatesToAdminSubscriptionService();
  await testHeartbeatWithinTtlSucceeds();
  await testHeartbeatWithinGraceStillSucceeds();
  await testHeartbeatBeyondGraceFailsWithLeaseExpired();
  await testGetActiveRuntimeRevokesDisabledUserLease();
  await testGetActiveRuntimeRevokesNodeAccessRevokedLease();
  await testGetActiveRuntimeRevokesRemovedTeamMemberLease();
  await testHeartbeatUpdatesCachedRuntimeLeaseExpiry();
  await testRevokeLeaseClearsCachedRuntime();
  await testDisconnectDoesNotExposeOtherUsersCachedRuntime();
  await testDisconnectRevokesOwnActiveLeaseAndClearsCachedRuntime();
  await testSweepExpiredLeasesDoesNotRevokeTooEarly();
  await testLeaseRevocationKeepsLocalStateWhenRuntimeEventPublishFails();
  await testLeaseRevocationKeepsLocalStateWhenSecurityEventWriteFails();
  await testLeaseRevocationContinuesWhenOneLocalRevokeFails();
  await testLeaseRevocationJobQueuePersistsRevocationTarget();
  await testNodeLeaseRevocationJobQueuePublishesSyncQueueEvent();
  await testLeaseRevocationJobRetriesFailedRevocation();
  await testLeaseRevocationBatchContinuesAfterStalledJob();
  await testLeaseRevocationBatchContinuesWhenFailurePersistFails();
  await testLeaseRevocationWorkerBatchReturnsWhenInitialReadFails();
  await testLeaseRevocationWorkerBatchContinuesWhenLockFails();
  await testRenewSubscriptionReturnsWhenSubscriptionPublishStalls();
  await testChangeSubscriptionPlanReturnsWhenSubscriptionPublishStalls();
  await testResetSubscriptionTrafficRejectsNonStringUserId();
  await testResetSubscriptionTrafficMapsTeamMemberReadFailure();
  await testResetSubscriptionTrafficReturnsWhenSubscriptionPublishStalls();
  await testListAdminNodesMapsLocalReadFailure();
  await testListNodeCommandJobsReadsBindingTargets();
  await testListNodeCommandSummariesAggregatePerTarget();
  await testReEnableNodeRestoresBindingsViaDirectAccessSync();
  await testListNodeCommandJobsAppliesTargetFilter();
  await testRetryExhaustedCommandsStayVisibleAsFailures();
  await testUpdateNodeMapsLocalReadFailure();
  await testRetryLeaseRevocationJobRequeuesWithoutKeepingBackoff();
  await testLeaseRevocationQueueFallsBackWhenNodeNameLookupFails();
  await testLeaseRevocationRetryPublishesSyncQueueEvent();
  await testRetryLeaseRevocationJobKeepsSavedRetryWhenListRefreshFails();
  await testRetryLeaseRevocationJobsForNodeOnlyRequeuesRetryableJobsOnThatNode();
  await testRetryLeaseRevocationJobsForNodeRejectsWhenNoRetryableJobsExist();
  await testUpdateNodeAccessRejectsInvalidNodeIdsAsBadRequest();
  await testGetNodeAccessMapsUnknownReadFailure();
  await testUpdateNodeAccessMapsLocalSaveConstraintErrors();
  await testUpdateNodeAccessMapsUnknownLocalSaveFailure();
  await testUpdateNodeAccessMapsTransactionCommitFailure();
  await testUpdateNodeAccessKeepsLocalSaveWhenPublishFails();
  await testNodeAccessEnsureQueuesDirectSyncInsideTransaction();
  await testNodeAccessRemovalMessagesDescribeQueuedRevocation();
  await testNodeAccessHttpMapsSubscriptionLookupFailureToServiceUnavailable();
  await testNodeAccessHttpMapsNodeListFailureToServiceUnavailable();
  await testNodeAccessHttpReturnsOkWhenAdminRuntimeEventPublishThrowsAfterLocalSave();
  await testKickTeamMemberDoesNotQueueDisconnectBeforeDisableAccountSave();
  await testConvertPersonalSubscriptionToTeamWaitsForRequiredTeamSubscriptionLookup();
  await testConvertPersonalSubscriptionToTeamConvertsMembershipUniqueConflict();
  await testGetTeamUsageUsesAggregatedLedgerRows();
  await testClientBootstrapDegradesOptionalSectionsOnPrismaPoolTimeout();
  await testClientBootstrapMapsRequiredReadFailure();
  await testClientNodesMapLocalReadFailure();
  await testClientVersionMapsPolicyReadFailure();
  await testRuntimeConnectMapsLocalReadFailure();
  await testRuntimeHeartbeatMapsLocalReadFailure();
  await testRuntimeDisconnectMapsLocalReadFailure();
  await testRuntimeActiveConfigMapsLocalReadFailure();
  await testRuntimePlanReturnsAvailablePartialComponentSet();
  await testRuntimeComponentCreateRejectsUploadedSource();
  await testRuntimeComponentCreateRequiresHttpUrl();
  await testRuntimeComponentCreateRejectsBlankFileName();
  await testRuntimeComponentCreatePersistsRemoteMirrorFields();
  await testRuntimeComponentCreateMapsUniqueIdentityConflict();
  await testRuntimeComponentCreateMapsLocalSaveFailure();
  await testRuntimeComponentUpdateMapsUniqueIdentityConflict();
  await testRuntimeComponentUpdateMapsLocalSaveFailure();
  await testRuntimeFailureReportLimitRejectsInvalidValues();
  await testRuntimeComponentFailureRejectsUnknownComponentId();
  await testRuntimeComponentFailureReportMapsLocalSaveFailure();
  await testRemoteRuntimeValidationRejectsPrivateNetworkUrl();
  await testRemoteRuntimeValidationRejectsMissingExpectedHash();
  await testRuntimeComponentUploadUsesActualHashWhenExpectedHashMismatch();
  await testRuntimeComponentUploadMapsUniqueIdentityConflict();
  await testRuntimeComponentUploadMapsTransientPrismaFailure();
  await testRuntimeComponentUploadMapsLocalSaveFailure();
  await testRuntimeComponentPrepareMissingTempFileReturnsBadRequest();
  await testRuntimeComponentReplaceUploadUsesActualHashWhenExpectedHashMismatch();
  await testRuntimeComponentReplaceUploadMapsUniqueIdentityConflict();
  await testRuntimeComponentReplaceUploadMapsTransientPrismaFailure();
  await testRuntimeComponentReplaceUploadMapsLocalSaveFailure();
  await testRuntimeComponentUploadKeepsSavedFileWhenSharedCleanupFails();
  await testRemoteSharedRulesetCreateKeepsSaveWhenCleanupFails();
  await testRemoteSharedRulesetCreateCleansPreviousUploadedFile();
  await testRemoteSharedRulesetCreateReturnsWhenCleanupStalls();
  await testRemoteRuntimeValidationChecksExpectedHashWithGet();
  await testRemoteRuntimeValidationReturnsUnreachableForHttp500();
  await testRemoteRuntimeValidationPersistsDownloadMetadata();
  await testRemoteRuntimeValidationRejectsLargeDefaultContentLength();
  await testRemoteRuntimeValidationReportsMetadataPersistFailure();
  await testRemoteRuntimeZipEntryValidationUsesExtractedEntryHash();
  await testRemoteRuntimeZipEntryValidationUsesBestEffortArchiveCleanup();
  await testRemoteRuntimeValidationRejectsOversizeExpectedHashResponse();
  await testRemoteRuntimeValidationRejectsIdleTimeoutExpectedHashResponse();
  await testRemoteRuntimeValidationRejectsTotalTimeoutExpectedHashResponse();
  await testRuntimePlanSkipsRemoteRowsMissingDownloadMetadata();
  await testRuntimePlanSkipsRemoteRowsWithMismatchedHashMetadata();
  await testRuntimePlanSkipsUploadedRowsMissingFiles();
  await testRuntimePlanSkipsUploadedRowsWithStaleMetadata();
  await testRuntimePlanExposesConfiguredMirrorFields();
  await testRuntimeComponentPatchCannotSwitchToUploadedSource();
  await testRuntimeComponentPatchInvalidatesRemoteMetadata();
  await testRuntimeComponentPatchDeletesOldUploadWhenSwitchingToRemote();
  await testRuntimeComponentDeleteReturnsWhenFileCleanupStalls();
  await testRuntimeComponentDeleteIgnoresInvalidStoredCleanupPathAfterLocalDelete();
  await testSubscriptionNodeAccessConcurrentReplaceIsSerialized();
  await testRuntimeComponentPatchInvalidatesMetadataWhenExpectedHashChanges();
  await testRuntimeComponentDeleteMapsLocalSaveFailure();
  await testCreateReleaseArtifactKeepsSaveWhenReleaseRefreshFails();
  await testCreateReleaseArtifactPublishesAdminRefreshEvent();
  await testCreateReleaseArtifactReturnsFallbackWhenReleaseRefreshStalls();
  await testCreateWindowsFullReplaceExternalArtifactAllowsNonZipUrlWhenExplicit();
  await testCreateReleaseArtifactMapsLocalSaveFailure();
  await testUpdateExternalReleaseArtifactDoesNotProbeRemoteMetadataBeforeSave();
  await testUpdateReleaseArtifactMapsLocalSaveFailure();
  await testUpdateWindowsExternalReleaseInfersExternalForExeUrl();
  await testUpdateWindowsExternalReleaseInfersFullReplaceForZipUrl();
  await testUpdateWindowsFullReplaceExternalKeepsModeForNonZipUrl();
  await testUploadReleaseArtifactSavesWithoutHashAfterZipValidation();
  await testUploadReleaseArtifactSavesReadableWindowsZipWithoutDeepInspection();
  await testReleaseArtifactPrepareMissingTempFileReturnsBadRequest();
  await testWindowsExeUploadIsRejectedForFullReplacementUpdates();
  await testUploadReleaseArtifactFailureUsesBestEffortCleanup();
  await testUploadReleaseArtifactMapsTransientPrismaFailure();
  await testReplaceReleaseArtifactUploadFailureUsesBestEffortCleanup();
  await testReplaceReleaseArtifactUploadMapsTransientPrismaFailure();
  await testReplaceReleaseArtifactUploadMapsLocalReadFailure();
  await testUpdateUploadedReleaseArtifactToExternalDeletesOldFile();
  await testReplaceReleaseArtifactUploadDeletesOldFileOnSuccess();
  await testDeleteReleaseArtifactKeepsDeleteWhenFileCleanupFails();
  await testDeleteReleaseArtifactMapsLocalSaveFailure();
  await testCreateReleaseArtifactRejectsBlankExternalDownloadUrl();
  await testPublishWindowsReleaseRejectsClientUnusableArtifact();
  await testPublishWindowsReleaseAllowsClientUsableArtifact();
  await testReleaseArtifactContentValidationMatchesDownloadedBytes();
  await testReleaseArtifactContentValidationRejectsInvalidWindowsZip();
  await testUploadWindowsReleaseRejectsExeFileName();
  await testReleaseCleanupBestEffortReturnsWhenCleanupStalls();
  await testDeleteReleaseStartsCleanupAfterLocalReturn();
  await testDeleteReleaseMapsLocalSaveFailure();
  await testReleaseArtifactPatchCannotRewriteUploadedUrl();
  await testUpdateCheckSkipsUploadedArtifactMissingStoredFile();
  await testUpdateCheckFallsBackToOlderUsableReleaseWhenLatestArtifactMissing();
  await testUpdateCheckIgnoresWithdrawnNewerRelease();
  await testUpdateCheckAllowsUploadedArtifactWithStaleMetadata();
  await testUpdateCheckAllowsUploadedArtifactWithoutMetadata();
  await testMoveUploadedFileCleansTargetWhenCrossDeviceUnlinkFails();
  await testWindowsUpdateCheckPrefersZipOverGenericExternalArtifact();
  await testWindowsUpdateCheckKeepsExternalZipWithoutHashMetadata();
  await testWindowsUpdateCheckSkipsClientUnusablePublishedArtifact();
  await testWindowsUpdateCheckSkipsInstallerOnlyRelease();
  await testCurrentSubscriptionPrefersEffectiveSubscription();
  await testLoginRateLimitWritesDoNotUseInteractiveTransaction();
  await testLoginMapsClearFailuresLocalWriteFailure();
  await testLoginMapsLastSeenLocalWriteFailure();
  await testLoginMapsIssueSessionLocalWriteFailure();
  await testClientVersionDoesNotUseCrossPlatformReleaseWithoutPlatform();
  await testCreateTeamMemberRejectsOwnerRole();
  await testCreateTeamMemberRejectsUniqueConflictAsConflict();
  await testCreateTeamMemberMapsUnknownLocalSaveFailure();
  await testCreateUserRejectsUniqueEmailConflictAsConflict();
  await testCreateUserMapsUnknownLocalSaveFailure();
  await testConvertSubscriptionToTeamMapsUnknownLocalSaveFailure();
  await testUpdateUserMapsLocalSaveFailure();
  await testUpdateUserSecurityMapsLocalSaveFailure();
  await testCreateSubscriptionMapsLocalSaveFailure();
  await testRenewSubscriptionMapsLocalSaveFailure();
  await testChangeSubscriptionPlanMapsLocalSaveFailure();
  await testUpdateSubscriptionMapsLocalSaveFailure();
  await testCreateTeamMapsLocalSaveFailure();
  await testCreateTeamMapsOwnerUniqueConflictAsConflict();
  await testUpdateTeamMapsLocalSaveFailure();
  await testUpdateTeamOwnerTransferRejectsConcurrentForeignMembership();
  await testUpdateTeamOwnerTransferUsesOwnerLock();
  await testUpdateTeamOwnerTransferUsesTeamLock();
  await testUpdateTeamMemberOwnerTransferUsesTeamLock();
  await testUpdateTeamMemberMapsLocalSaveFailure();
  await testDeleteTeamMemberMapsLocalSaveFailure();
  await testCreateTeamSubscriptionMapsLocalSaveFailure();
  await testCreatePlanMapsLocalSaveFailure();
  await testListAdminPlansMapsLocalReadFailure();
  await testListAdminPlansUsesSubscriptionCountAggregation();
  await testUpdatePlanMapsLocalSaveFailure();
  await testUpdatePlanMapsSubscriptionCountReadFailure();
  await testUpdatePlanSecurityMapsLocalSaveFailure();
  await testGetNodeAccessMapsUnknownReadFailure();
  await testUpdatePlanRejectsScopeChangeWhenUsed();
  await testCreatePlanRejectsBlankTrimmedName();
  await testUpdateCurrentAdminSecurityRejectsUniqueEmailConflictAsConflict();
  await testUpdateCurrentAdminSecurityMapsCurrentAdminReadFailure();
  await testUpdateCurrentAdminSecurityMapsEmailPreflightReadFailure();
  await testUpdateCurrentAdminSecurityMapsTransactionFailure();
  await testImageBedListRejectsSuccessFalsePayload();
  await testImageBedListUsesShortManageTimeout();
  await testImageBedListMapsResponseReadFailure();
  await testImageBedListDefaultsToUploadFolder();
  await testImageBedListUsesProviderFileIdForNestedFiles();
  await testImageBedUploadRejectsSuccessFalsePayload();
  await testImageBedUploadUsesCallerTimeout();
  await testImageBedUploadSuccessParsesUrlAndCleansTempFile();
  await testImageBedUploadMapsMissingTempFileToServiceUnavailable();
  await testImageBedUploadRejectsMalformedReturnedUrlAndCleansTempFile();
  await testImageBedUploadRejectsNonImageAndCleansTempFile();
  await testImageBedDeleteReturnsStructuredBusinessFailure();
  await testImageBedDeleteAcceptsDeletedListWithoutSuccessTrue();
  await testImageBedDeleteUsesShortManageTimeout();
  await testImageBedDeleteAllowsPlainPercentFilePath();
  await testImageBedDeleteRejectsMalformedPercentUrlPath();
  await testUpdateImageBedConfigDoesNotValidateExternalImageBed();
  await testImageBedMutationsPublishAdminRefreshEvent();
  await testGetImageBedConfigMapsLocalReadFailure();
  await testGetImageBedConfigTimesOutSlowLocalRead();
  await testUpdateImageBedConfigMapsLocalSaveFailure();
  await testImageBedDeleteReturnsStructuredMessageWhenSuccessFalseWithoutFailedArray();
  await testImageBedAttachmentCleanupLogsDeleteFailure();
  await testImageBedAttachmentCleanupLogsBusinessDeleteFailure();
  await testImageBedAttachmentCleanupReturnsWhenDeleteStalls();
  await testUpdateImageBedConfigRejectsBaseUrlWithPath();
  await testUpdateUserCredentialChangePublishesAccountEvents();
  await testUpdateUserSecurityReconcilesActiveLeases();
  await testUpdateUserSecurityPublishesAccountEvents();
  await testUpdateUserSecurityKeepsLocalSaveWhenLeaseEnforcementFails();
  await testUpdatePlanSecurityReconcilesUsersWithoutOverrides();
  await testUpdatePlanReconcilesConcurrencyWhenLimitChanges();
  await testUpdateSubscriptionReturnsWhenSubscriptionPublishStalls();
  await testSubscriptionUpdatedStillPublishesAdminEventWhenClientPublishFails();
  await testDevDataNodeAccessStillPublishesAdminEventWhenClientPublishFails();
  await testChangeSubscriptionPlanReconcilesNewConcurrencyLimit();
  await testCreateSubscriptionKeepsLocalSaveWhenTicketCleanupFails();
  await testCreateSubscriptionKeepsLocalSaveWhenTicketCleanupStalls();
  await testCreateTeamCreatesTeamAndOwnerInSingleTransaction();
  await testCreateTeamMemberKeepsMemberWhenTicketCleanupFails();
  await testUpdateTeamMemberOwnerTransferMapsLocalSaveFailure();
  await testTeamMemberMutationRejectsMismatchedTeamRoute();
  await testTeamMemberMutationRejectsOwnerDemotion();
  await testCreateAnnouncementRejectsBlankTrimmedText();
  await testCreateAnnouncementRejectsFractionalCountdown();
  await testGetPoliciesMapsLocalReadFailure();
  await testGetAnnouncementsMapsLocalReadFailure();
  await testMarkAnnouncementReadMapsLocalReadFailure();
  await testMarkAnnouncementReadMapsLocalSaveFailure();
  await testCreateAnnouncementMapsLocalSaveFailure();
  await testUpdateAnnouncementMapsLocalSaveFailure();
  await testUpdateAnnouncementDefaultsCountdownWhenSwitchingMode();
  await testUpdateAnnouncementMapsLocalReadFailure();
  await testAdminSnapshotCountsOnlyClientVisibleAnnouncements();
  await testAdminSnapshotDoesNotHideOptionalListFailures();
  await testAdminSnapshotKeepsPolicyAsRequiredData();
  await testAdminDashboardCountsOnlyPublishedActiveAnnouncements();
  await testAdminDashboardCountsWaitingUserTicketsAsOpen();
  await testCreateAnnouncementKeepsLocalSaveWhenPublishFails();
  await testCreateAnnouncementReturnsWhenPublishUserLookupStalls();
  await testCreateAnnouncementPublishesUpdateEvent();
  await testCreateAnnouncementPublishesClientEventWhenAdminPublishFails();
  await testUpdateAnnouncementPublishesUpdateEvent();
  await testDeleteAnnouncementRemovesRecordAndPublishesUpdate();
  await testDeleteAnnouncementRejectsMissingRecordBeforeDbDelete();
  await testDeleteAnnouncementMapsLocalSaveFailure();
  await testDeleteAnnouncementKeepsLocalDeleteWhenPublishFails();
  await testMarkAnnouncementReadKeepsLocalSaveWhenPublishFails();
  await testUpdatePolicyRejectsDuplicateModes();
  await testGetAdminPolicyMapsLocalReadFailure();
  await testUpdatePolicyMapsLocalSaveFailure();
  await testUpdatePolicyAllowsUnrelatedChangeWithHistoricalDuplicateModes();
  await testUpdatePolicyKeepsLocalSaveWhenPublishFails();
  await testUpdatePolicyDoesNotRefreshAfterLocalSave();
  await testUpdatePolicyReturnsWhenPublishUserLookupStalls();
  await testCloseSupportTicketsPublishesClientAndAdminEvents();
  await testAdminReplySupportTicketWithAttachmentCreatesAttachment();
  await testAdminReplySupportTicketAttachmentCleansUploadWhenTransactionFails();
  await testAdminReplySupportTicketAttachmentMapsTransientPrismaFailure();
  await testAdminReplySupportTicketMapsLocalSaveFailure();
  await testAdminReplySupportTicketAttachmentUploadFailureSavesTextReply();
  await testAdminReplySupportTicketAttachmentOnlyUploadFailureRejectsWithoutWritingReply();
  await testAdminReplySupportTicketKeepsSaveWhenPublishFails();
  await testAdminReplySupportTicketPublishesClientAndAdminEvents();
  await testAdminReplySupportTicketReturnsFallbackWhenDetailRefreshFails();
  await testAdminReplySupportTicketAttachmentReturnsFallbackWhenDetailRefreshFails();
  await testAdminReplySupportTicketReturnsFallbackWhenDetailRefreshStalls();
  await testCloseAdminSupportTicketReturnsFallbackWhenDetailRefreshStalls();
  await testCloseAdminSupportTicketMapsLocalSaveFailure();
  await testReopenAdminSupportTicketReturnsFallbackWhenDetailRefreshStalls();
  await testReopenAdminSupportTicketMapsLocalSaveFailure();
  await testClientCreateSupportTicketReturnsFallbackWhenDetailRefreshStalls();
  await testClientReplySupportTicketReturnsFallbackWhenDetailRefreshStalls();
  await testClientReplySupportTicketAttachmentReturnsFallbackWhenDetailRefreshStalls();
  await testClientSupportTicketListMapsLocalReadFailure();
  await testAdminSupportTicketListMapsLocalReadFailure();
  await testAdminSupportTicketListUsesBoundedQuery();
  await testAdminSupportTicketDetailUsesBoundedRecentMessagesInAscendingOrder();
  await testReleaseListMapsLocalReadFailure();
  await testClientUpdateCheckMapsLocalReadFailure();
  await testRuntimeComponentListMapsLocalReadFailure();
  await testRuntimePlanMapsLocalReadFailure();
  await testClientCreateSupportTicketMapsLocalSaveFailure();
  await testClientReplySupportTicketMapsLocalSaveFailure();
  await testClientReplySupportTicketAttachmentCleansUploadWhenTransactionFails();
  await testClientReplySupportTicketAttachmentMapsTransientPrismaFailure();
  await testClientReplySupportTicketAttachmentUploadFailureSavesTextReply();
  await testClientReplySupportTicketAttachmentOnlyUploadFailureRejectsWithoutWritingReply();
  await testClientReplySupportTicketKeepsSaveWhenPublishFails();
  await testUploadedTempFileCleanupInterceptorDeletesTempFileOnError();
  console.log("dev-data and usage regression checks passed");
}

void main();
















