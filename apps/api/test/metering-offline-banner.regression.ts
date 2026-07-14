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

async function testMeteringStateIgnoresOfflineAndDegradedNodes() {
  const service = createInstance<MeteringIncidentService>(MeteringIncidentService.prototype, {
    prisma: {
      nodeSessionLease: {
        findMany: async () => [
          { nodeId: "node_offline" },
          { nodeId: "node_degraded" },
          { nodeId: "node_online" }
        ]
      },
      node: {
        findMany: async (payload: Record<string, any>) => {
          assert.deepEqual(payload.where.panelStatus, "online");
          assert.equal(payload.where.isActive, true);
          assert.equal(payload.where.panelEnabled, true);
          return [{ id: "node_online" }];
        }
      },
      meteringIncident: {
        findMany: async (payload: Record<string, any>) => {
          assert.deepEqual(payload.where.nodeId.in, ["node_online"]);
          return [
            {
              reason: METERING_REASON_SAMPLE_MISSING,
              createdAt: new Date(Date.now() - 60_000),
              openedAt: new Date(Date.now() - 60_000)
            }
          ];
        }
      }
    }
  });

  const degraded = await service.getSubscriptionMeteringState("sub_1");
  assert.equal(degraded.meteringStatus, "degraded");
  assert.match(String(degraded.meteringMessage ?? ""), /流量统计正在校准/);

  const onlyOfflineService = createInstance<MeteringIncidentService>(MeteringIncidentService.prototype, {
    prisma: {
      nodeSessionLease: {
        findMany: async () => [{ nodeId: "node_offline" }, { nodeId: "node_degraded" }]
      },
      node: {
        findMany: async () => []
      },
      meteringIncident: {
        findMany: async () => {
          throw new Error("should not query incidents when no online metering nodes remain");
        }
      }
    }
  });

  const ok = await onlyOfflineService.getSubscriptionMeteringState("sub_1");
  assert.equal(ok.meteringStatus, "ok");
  assert.equal(ok.meteringMessage, null);
}

async function testUsageSyncResolvesResidualIncidentsOnOfflineNodes() {
  const updates: Array<Record<string, any>> = [];
  const service = createInstance<UsageSyncService>(UsageSyncService.prototype, {
    logger: { warn: () => undefined, debug: () => undefined },
    prisma: {
      panelClientBinding: {
        findMany: async () => []
      },
      meteringIncident: {
        updateMany: async (payload: Record<string, any>) => {
          updates.push(payload);
          return { count: 2 };
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

  assert.equal(updates.length, 1, "residual cleanup must run even when there are no active bindings");
  assert.equal(updates[0].where.status, "open");
  assert.deepEqual(updates[0].where.node.OR, [
    { isActive: false },
    { panelEnabled: false },
    { panelStatus: "offline" },
    { panelStatus: "degraded" }
  ]);
  assert.equal(updates[0].data.status, "resolved");
  assert.match(String(updates[0].data.detail ?? ""), /面板不可用/);
}

async function main() {
  await testMeteringStateIgnoresOfflineAndDegradedNodes();
  await testUsageSyncResolvesResidualIncidentsOnOfflineNodes();
  console.log("metering offline banner regression checks passed");
}

void main();
