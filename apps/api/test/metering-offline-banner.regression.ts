import assert from "node:assert/strict";
import { MeteringIncidentService } from "../src/modules/common/metering-incident.service";
import { UsageSyncService } from "../src/modules/usage/usage-sync.service";
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
          assert.equal(payload.where.panelStatus, "online");
          assert.equal(payload.where.isActive, true);
          assert.equal(payload.where.panelEnabled, true);
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

async function testUsageSyncResolvesResidualIncidentsWithoutActiveLease() {
  const updates: Array<Record<string, any>> = [];
  const finds: Array<Record<string, any>> = [];
  const service = createInstance<UsageSyncService>(UsageSyncService.prototype, {
    logger: { warn: () => undefined, debug: () => undefined },
    prisma: {
      panelClientBinding: {
        findMany: async () => []
      },
      nodeSessionLease: {
        findMany: async (payload: Record<string, any>) => {
          finds.push(payload);
          // only one residual open incident keeps an active lease
          return [{ subscriptionId: "sub_live", nodeId: "node_live" }];
        }
      },
      meteringIncident: {
        findMany: async () => [
          { id: "inc_live", subscriptionId: "sub_live", nodeId: "node_live" },
          { id: "inc_stale", subscriptionId: "sub_stale", nodeId: "node_live" },
          { id: "inc_other", subscriptionId: "sub_live", nodeId: "node_other" }
        ],
        updateMany: async (payload: Record<string, any>) => {
          updates.push(payload);
          return { count: Array.isArray(payload.where?.id?.in) ? payload.where.id.in.length : 1 };
        }
      },
      node: {
        update: async () => undefined
      }
    },
    xuiService: {
      listNodeUsage: async () => []
    }
  });

  await service["syncXuiUsage"]();

  assert.equal(updates.length, 2, "must resolve unavailable-node residuals and no-lease residuals");
  assert.equal(updates[0].where.status, "open");
  assert.deepEqual(updates[0].where.node.OR, [
    { isActive: false },
    { panelEnabled: false },
    { panelStatus: "offline" },
    { panelStatus: "degraded" }
  ]);
  assert.equal(updates[0].data.status, "resolved");
  assert.match(String(updates[0].data.detail ?? ""), /面板不可用/);

  assert.deepEqual(updates[1].where.id.in.sort(), ["inc_other", "inc_stale"]);
  assert.equal(updates[1].data.status, "resolved");
  assert.match(String(updates[1].data.detail ?? ""), /无活跃连接/);
  assert.equal(finds.length, 1);
}

async function main() {
  await testMeteringStateOnlyUsesCurrentlyConnectedOnlineNode();
  await testUsageSyncResolvesResidualIncidentsWithoutActiveLease();
  console.log("metering offline banner regression checks passed");
}

void main();
