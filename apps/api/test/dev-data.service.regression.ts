import assert from "node:assert/strict";
import { LEASE_GRACE_SECONDS } from "../src/modules/common/runtime-session.utils";
import { RuntimeSessionService } from "../src/modules/common/runtime-session.service";
import { DevDataService } from "../src/modules/common/dev-data.service";
import { AdminSubscriptionService } from "../src/modules/common/admin-subscription.service";
import { AdminNodeService } from "../src/modules/common/admin-node.service";
import { ClientAccessService } from "../src/modules/common/client-access.service";
import { UsageSyncService } from "../src/modules/usage/usage-sync.service";
import { ReleaseCenterService } from "../src/modules/common/release-center.service";
import { RuntimeComponentsService } from "../src/modules/common/runtime-components.service";
import { resolveReleaseArtifactAbsolutePath, resolveReleaseArtifactForClient } from "../src/modules/common/release-center.utils";

const GB_IN_BYTES = 1024 ** 3;

function createInstance<T>(prototype: object, overrides: Record<string, unknown> = {}) {
  return Object.assign(Object.create(prototype), overrides) as T & Record<string, unknown>;
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

function createAdminSubscriptionService(overrides: Record<string, unknown> = {}) {
  return createInstance<AdminSubscriptionService>(AdminSubscriptionService.prototype, overrides);
}

function createAdminNodeService(overrides: Record<string, unknown> = {}) {
  return createInstance<AdminNodeService>(AdminNodeService.prototype, overrides);
}

function createClientAccessService(overrides: Record<string, unknown> = {}) {
  return createInstance<ClientAccessService>(ClientAccessService.prototype, overrides);
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
      $transaction: async (operations: Array<Promise<unknown>>) => {
        await Promise.all(operations);
      }
    }
  });

  const count = await service.markPanelBindingsDisabledForSubscription("sub_1");

  assert.equal(count, 1);
  assert.equal(bindingUpdateManyCalled, false, "disable queue must not mark binding disabled before 3x-ui confirms it");
  assert.equal(upserts.length, 1);
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
  const service = createAdminNodeService({
    clientEventsPublisher: {
      resolveUserIdsForNodeAccess: async () => ["user_1"],
      publishNodeAccessUpdatedToUsers: () => undefined
    },
    runtimeSessionService: {
      revokeNodeLeases: async () => 1,
      removePanelBindingsForSubscription: async () => ({
        requested: 1,
        updated: 0,
        failed: [{ bindingId: "binding_1", nodeId: "node_1", nodeName: "node", panelClientEmail: "user@example.com", error: "panel down" }]
      }),
      assertPanelBindingMutation: () => {
        throw new Error("panel cleanup failed");
      }
    },
    prisma: {
      panelClientBinding: {
        findMany: async () => [{ subscriptionId: "sub_1" }]
      },
      node: {
        findUnique: async () => ({ id: "node_1" }),
        delete: async () => {
          nodeDeleted = true;
        }
      }
    }
  });

  await assert.rejects(() => service.deleteNode("node_1"), /panel cleanup failed/);
  assert.equal(nodeDeleted, false, "node row must not be deleted before remote panel bindings are cleaned up");
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
      $transaction: async (operations: Array<Promise<unknown>>) => {
        await Promise.all(operations);
      }
    }
  });

  await service.markPanelBindingsDisabledForSubscription("sub_1");

  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].update.attempts, 0, "re-queued disable jobs must reset stale retry attempts");
  assert.equal(upserts[0].update.lastError, null, "re-queued disable jobs must clear stale errors");
}

async function testDisablePanelBindingUsesStoredInboundId() {
  const inboundIds: Array<number | null> = [];
  const service = createRuntimeSessionService({
    xuiService: {
      setClientEnabled: async (node: { panelInboundId: number | null }) => {
        inboundIds.push(node.panelInboundId);
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
              id: "node_1",
              name: "node",
              panelBaseUrl: "https://panel.example.com",
              panelApiBasePath: "/",
              panelUsername: "admin",
              panelPassword: "password",
              panelInboundId: 99
            }
          }
        ],
        update: async () => ({})
      }
    }
  });

  const result = await service.disablePanelBindingsForSubscription("sub_1");

  assert.equal(result.failed.length, 0);
  assert.deepEqual(inboundIds, [7], "disable must use the binding inbound id captured at provision time");
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

async function testDeactivatePanelClientsUsesStoredInboundId() {
  const inboundIds: Array<number | null> = [];
  const bindingUpdates: Array<Record<string, any>> = [];
  const service = createUsageSyncService({
    xuiService: {
      setClientEnabled: async (node: { panelInboundId: number | null }) => {
        inboundIds.push(node.panelInboundId);
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
              id: "node_1",
              panelBaseUrl: "https://panel.example.com",
              panelApiBasePath: "/",
              panelUsername: "admin",
              panelPassword: "password",
              panelInboundId: 99
            }
          }
        ],
        update: async (payload: Record<string, any>) => {
          bindingUpdates.push(payload);
        }
      },
      node: {
        update: async () => undefined
      }
    }
  });

  await service["deactivatePanelClients"]("sub_1", "disabled");

  assert.deepEqual(inboundIds, [7], "subscription deactivation must disable the stored binding inbound id");
  assert.equal(bindingUpdates[0].data.status, "disabled");
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

async function testRemovePanelBindingDisabledFallbackDoesNotMarkDeleted() {
  const bindingUpdates: Array<Record<string, any>> = [];
  let deletedSnapshot = false;
  const service = createRuntimeSessionService({
    xuiService: {
      removeClient: async () => "disabled"
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
              id: "node_1",
              name: "node",
              panelBaseUrl: "https://panel.example.com",
              panelApiBasePath: "/",
              panelUsername: "admin",
              panelPassword: "password",
              panelInboundId: 99
            }
          }
        ],
        update: async (payload: Record<string, any>) => {
          bindingUpdates.push(payload);
          return {};
        }
      },
      trafficSnapshot: {
        deleteMany: async () => {
          deletedSnapshot = true;
        }
      }
    }
  });

  const result = await service.removePanelBindingsForSubscription("sub_1");

  assert.equal(result.updated, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(bindingUpdates[0].data.status, "disabled", "disabled fallback must keep local binding disabled");
  assert.equal(deletedSnapshot, false, "disabled fallback must not delete traffic baseline as if remote deletion succeeded");
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

async function main() {
  await testUpdateUserPasswordRevokesExistingSessions();
  await testUpdateUserRoleRevokesExistingSessions();
  testReleaseArtifactPathTraversalIsRejected();
  testUploadedReleaseArtifactDoesNotUseClientMirror();
  await testReleaseDownloadRejectsDraftArtifacts();
  await testRuntimeDownloadRejectsDisabledComponents();
  await testUpdateReleaseDelegatesToReleaseCenter();
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
  await testSweepExpiredLeasesDoesNotRevokeTooEarly();
  await testPanelDisableJobDoesNotPreDisableBinding();
  await testPanelDisableJobCallsXuiEvenWhenNodeInactive();
  await testClearPendingPanelDisableJobsOnlyClearsRestoredNodeAccess();
  await testExistingBindingMissingSnapshotUsesBindingCountersAsBaseline();
  await testUsageTriggeredInvalidationUsesUnifiedRevokePath();
  await testInitialUsageDeltaUsesBindingCountersForUuidMapping();
  await testStaleUsageSampleAfterResetDoesNotReapplyOldTraffic();
  await testDeleteNodeStopsBeforeLocalDeleteWhenPanelCleanupFails();
  await testPanelDisableJobUpsertResetsStaleFailureState();
  await testDisablePanelBindingUsesStoredInboundId();
  await testUsageSyncUsesStoredInboundIdGroups();
  await testDeactivatePanelClientsUsesStoredInboundId();
  await testUpdateNodeUsesExplicitClearedInboundIdForPanelRefresh();
  await testClientNodesRequirePanelEnabled();
  await testConnectRejectsPanelDisabledNode();
  await testRemovePanelBindingDisabledFallbackDoesNotMarkDeleted();
  await testRuntimePlanRequiresCompleteComponentSet();
  await testRuntimeComponentPatchCannotSwitchToUploadedSource();
  await testTeamMemberMutationRejectsMismatchedTeamRoute();
  console.log("dev-data and usage regression checks passed");
}

void main();
