import assert from "node:assert/strict";
import { MeteringIncidentService } from "../src/modules/common/metering-incident.service";
import {
  METERING_REASON_NODE_UNAVAILABLE,
  METERING_REASON_SAMPLE_MISSING
} from "../src/modules/common/metering.constants";

function createInstance<T extends object>(prototype: object, overrides: Record<string, unknown> = {}) {
  return Object.assign(Object.create(prototype), overrides) as T;
}

async function testMeteringStateOnlyUsesCurrentlyConnectedOnlineNode() {
  const service = createInstance<MeteringIncidentService>(MeteringIncidentService.prototype, {
    prisma: {
      nodeSessionLease: {
        findMany: async (payload: Record<string, any>) => {
          assert.equal(payload.where.subscriptionId, "sub_1");
          assert.equal(payload.where.userId, "user_1");
          assert.equal(payload.where.status, "active");
          return [
            {
              nodeId: "node_online_connected",
              updatedAt: new Date(),
              lastHeartbeatAt: new Date(),
              createdAt: new Date()
            },
            {
              nodeId: "node_online_idle_incident",
              updatedAt: new Date(Date.now() - 60_000),
              lastHeartbeatAt: new Date(Date.now() - 60_000),
              createdAt: new Date(Date.now() - 60_000)
            }
          ];
        }
      },
      node: {
        findFirst: async (payload: Record<string, any>) => {
          assert.equal(payload.where.id, "node_online_connected");
          assert.equal(payload.where.isActive, true);
          assert.equal(payload.where.controlStatus, "online");
          return { id: "node_online_connected" };
        }
      },
      meteringIncident: {
        findMany: async (payload: Record<string, any>) => {
          assert.equal(payload.where.nodeId, "node_online_connected");
          return [];
        }
      }
    }
  });

  const okWhileOtherNodeHasNoise = await service.getSubscriptionMeteringState("sub_1", "user_1");
  assert.equal(okWhileOtherNodeHasNoise.meteringStatus, "ok");
  assert.equal(okWhileOtherNodeHasNoise.meteringMessage, null);

  const degradedService = createInstance<MeteringIncidentService>(MeteringIncidentService.prototype, {
    prisma: {
      nodeSessionLease: {
        findMany: async () => [
          {
            nodeId: "node_online_connected",
            updatedAt: new Date(),
            lastHeartbeatAt: new Date(),
            createdAt: new Date()
          }
        ]
      },
      node: {
        findFirst: async () => ({ id: "node_online_connected" })
      },
      meteringIncident: {
        findMany: async () => [
          {
            reason: METERING_REASON_SAMPLE_MISSING,
            createdAt: new Date(Date.now() - 60_000),
            openedAt: new Date(Date.now() - 60_000)
          }
        ]
      }
    }
  });

  const degraded = await degradedService.getSubscriptionMeteringState("sub_1", "user_1");
  assert.equal(degraded.meteringStatus, "degraded");
  assert.match(String(degraded.meteringMessage ?? ""), /流量统计正在校准/);

  const offlineConnectedService = createInstance<MeteringIncidentService>(MeteringIncidentService.prototype, {
    prisma: {
      nodeSessionLease: {
        findMany: async () => [
          {
            nodeId: "node_offline",
            updatedAt: new Date(),
            lastHeartbeatAt: new Date(),
            createdAt: new Date()
          }
        ]
      },
      node: {
        findFirst: async () => null
      },
      meteringIncident: {
        findMany: async () => {
          throw new Error("should not query incidents when connected node is not online");
        }
      }
    }
  });

  const okOffline = await offlineConnectedService.getSubscriptionMeteringState("sub_1", "user_1");
  assert.equal(okOffline.meteringStatus, "ok");
  assert.equal(okOffline.meteringMessage, null);

  const noLeaseService = createInstance<MeteringIncidentService>(MeteringIncidentService.prototype, {
    prisma: {
      nodeSessionLease: {
        findMany: async () => []
      },
      node: {
        findFirst: async () => {
          throw new Error("should not query nodes without active lease");
        }
      },
      meteringIncident: {
        findMany: async () => {
          throw new Error("should not query incidents without active lease");
        }
      }
    }
  });

  const okNoLease = await noLeaseService.getSubscriptionMeteringState("sub_1", "user_1");
  assert.equal(okNoLease.meteringStatus, "ok");
  assert.equal(okNoLease.meteringMessage, null);
}

async function testNodeUnavailableIncidentShowsRetryBanner() {
  const service = createInstance<MeteringIncidentService>(MeteringIncidentService.prototype, {
    prisma: {
      nodeSessionLease: {
        findMany: async () => [
          {
            nodeId: "node_degraded",
            updatedAt: new Date(),
            lastHeartbeatAt: new Date(),
            createdAt: new Date()
          }
        ]
      },
      node: {
        findFirst: async () => ({ id: "node_degraded" })
      },
      meteringIncident: {
        findMany: async () => [
          {
            reason: METERING_REASON_NODE_UNAVAILABLE,
            createdAt: new Date(Date.now() - 3600_000),
            openedAt: new Date(Date.now() - 3600_000)
          }
        ]
      }
    }
  });

  const degraded = await service.getSubscriptionMeteringState("sub_1", "user_1");
  assert.equal(degraded.meteringStatus, "degraded");
  assert.match(String(degraded.meteringMessage ?? ""), /计量同步延迟/);
}

async function main() {
  await testMeteringStateOnlyUsesCurrentlyConnectedOnlineNode();
  await testNodeUnavailableIncidentShowsRetryBanner();
  console.log("metering offline banner regression checks passed");
}

void main();
