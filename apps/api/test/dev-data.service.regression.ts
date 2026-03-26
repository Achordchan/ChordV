import assert from "node:assert/strict";
import { LEASE_GRACE_SECONDS } from "../src/modules/common/runtime-session.utils";
import { RuntimeSessionService } from "../src/modules/common/runtime-session.service";
import { DevDataService } from "../src/modules/common/dev-data.service";
import { UsageSyncService } from "../src/modules/usage/usage-sync.service";

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
          accessMode: "xui",
          status: "active",
          expiresAt: new Date(Date.now() + 20_000),
          revokedReason: null,
          xrayUserEmail: "demo@example.com",
          xrayUserUuid: "uuid_1",
          node: { id: "node_1", flow: "" }
        }),
        update: async (payload: Record<string, unknown>) => {
          updates.push(payload);
          return undefined;
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
          accessMode: "xui",
          status: "active",
          expiresAt: new Date(Date.now() - 5_000),
          revokedReason: null,
          xrayUserEmail: "demo@example.com",
          xrayUserUuid: "uuid_2",
          node: { id: "node_1", flow: "" }
        }),
        update: async (payload: Record<string, unknown>) => {
          updates.push(payload);
          return undefined;
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
  const updates: Array<Record<string, unknown>> = [];
  const service = createRuntimeSessionService({
    resolveActiveUserFromToken: async () => ({ id: "user_1" }),
    assertLeaseCanHeartbeat: async () => undefined,
    logLeaseWarning: () => undefined,
    prisma: {
      nodeSessionLease: {
        findUnique: async () => ({
          id: "lease_3",
          sessionId: "session_3",
          userId: "user_1",
          subscriptionId: "sub_1",
          nodeId: "node_1",
          accessMode: "xui",
          status: "active",
          expiresAt: new Date(Date.now() - (LEASE_GRACE_SECONDS * 1000 + 5_000)),
          revokedReason: null,
          xrayUserEmail: "demo@example.com",
          xrayUserUuid: "uuid_3",
          node: { id: "node_1", flow: "" }
        }),
        update: async (payload: Record<string, unknown>) => {
          updates.push(payload);
          return undefined;
        }
      }
    }
  });

  await assert.rejects(() => service.heartbeatSession("session_3"), /会话已过期/);

  assert.equal(updates.length, 1, "超过 TTL + grace 后，心跳应写回过期状态");
  assert.equal(updates[0]?.data?.status, "expired");
  assert.equal(updates[0]?.data?.revokedReason, "lease_expired");
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

async function testUsageTriggeredInvalidationUsesUnifiedRevokePath() {
  let updateManyCalled = false;
  const panelCalls: Array<{ subscriptionId: string; nextStatus: string }> = [];
  const revokeCalls: Array<{ subscriptionId: string; reason: string }> = [];
  const publishedStates: string[] = [];

  const service = createUsageSyncService({
    deactivatePanelClients: async (subscriptionId: string, nextStatus: string) => {
      panelCalls.push({ subscriptionId, nextStatus });
    },
    runtimeSessionService: {
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

  await service["applyUsageDelta"]("node_1", "sub_1", null, "user_1", BigInt(GB_IN_BYTES), new Date());

  assert.equal(updateManyCalled, false, "usage 失效不应该再裸调用 nodeSessionLease.updateMany");
  assert.deepEqual(panelCalls, [{ subscriptionId: "sub_1", nextStatus: "disabled" }]);
  assert.deepEqual(revokeCalls, [{ subscriptionId: "sub_1", reason: "subscription_expired" }]);
  assert.deepEqual(publishedStates, ["expired"]);
}

async function main() {
  await testUpdateReleaseDelegatesToReleaseCenter();
  await testCreateReleaseArtifactDelegatesToReleaseCenter();
  await testConvertToTeamDelegatesToAdminSubscriptionService();
  await testValidateReleaseArtifactDelegatesToReleaseCenter();
  await testHeartbeatWithinTtlSucceeds();
  await testHeartbeatWithinGraceStillSucceeds();
  await testHeartbeatBeyondGraceFailsWithLeaseExpired();
  await testSweepExpiredLeasesDoesNotRevokeTooEarly();
  await testUsageTriggeredInvalidationUsesUnifiedRevokePath();
  console.log("dev-data and usage regression checks passed");
}

void main();
