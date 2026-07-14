import assert from "node:assert/strict";
import { AdminNodeService } from "../src/modules/common/admin-node.service";
import { UsageSyncService } from "../src/modules/usage/usage-sync.service";

function createInstance<T extends object>(prototype: object, overrides: Record<string, unknown> = {}): T {
  return Object.assign(Object.create(prototype), overrides) as T;
}

function makeNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "node_1",
    name: "node",
    countryCode: "US",
    region: "LA",
    provider: "p",
    tags: [],
    isActive: true,
    recommended: true,
    latencyMs: 10,
    protocol: "vless",
    security: "reality",
    serverHost: "127.0.0.1",
    serverPort: 9,
    uuid: "uuid",
    flow: "",
    realityPublicKey: "pk",
    shortId: "sid",
    serverName: "example.com",
    fingerprint: "chrome",
    spiderX: "/",
    mldsa65Verify: "",
    subscriptionUrl: null,
    statsLastSyncedAt: null,
    probeStatus: "healthy",
    probeLatencyMs: 10,
    probeCheckedAt: new Date(),
    probeError: null,
    panelBaseUrl: "https://panel.example.com",
    panelApiBasePath: "/",
    panelUsername: "admin",
    panelPassword: "password",
    panelInboundId: 1,
    panelEnabled: true,
    panelStatus: "online",
    panelLastSyncedAt: new Date(),
    panelError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

async function testProbeTimeoutKeepsPanelOnline() {
  const previous = process.env.CHORDV_NODE_PROBE_TIMEOUT_MS;
  process.env.CHORDV_NODE_PROBE_TIMEOUT_MS = "20";
  const current = makeNode();
  const updates: any[] = [];
  const service = createInstance<AdminNodeService>(AdminNodeService.prototype, {
    logger: { warn: () => undefined },
    panelProbeFailureCounts: new Map(),
    xuiService: {
      checkNodeHealth: async () => new Promise(() => undefined)
    },
    prisma: {
      node: {
        findUnique: async () => current,
        update: async (payload: any) => {
          updates.push(payload);
          return { ...current, ...payload.data };
        }
      }
    }
  });
  try {
    const result = await Promise.race([
      service.probeNode("node_1"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout wait")), 800))
    ]) as any;
    assert.equal(result.panelStatus, "online");
    assert.equal(result.panelError, null);
    assert.equal(updates.length, 0);
  } finally {
    if (previous === undefined) delete process.env.CHORDV_NODE_PROBE_TIMEOUT_MS;
    else process.env.CHORDV_NODE_PROBE_TIMEOUT_MS = previous;
  }
}

async function testProbeDegradesAfterThreeFailures() {
  const current = makeNode();
  const service = createInstance<AdminNodeService>(AdminNodeService.prototype, {
    logger: { warn: () => undefined },
    panelProbeFailureCounts: new Map(),
    xuiService: {
      checkNodeHealth: async () => {
        throw new Error("temporary panel glitch");
      }
    },
    prisma: {
      node: {
        findUnique: async () => current,
        update: async (payload: any) => {
          Object.assign(current, payload.data);
          return { ...current };
        }
      }
    }
  });
  assert.equal((await service.probeNode("node_1")).panelStatus, "online");
  assert.equal((await service.probeNode("node_1")).panelStatus, "online");
  const third = await service.probeNode("node_1");
  assert.equal(third.panelStatus, "degraded");
  assert.match(String(third.panelError ?? ""), /temporary panel glitch/);
}

async function testUsageSyncDegradesOnlyAfterThreshold() {
  const updates: any[] = [];
  const service = createInstance<UsageSyncService>(UsageSyncService.prototype, {
    logger: { warn: () => undefined, debug: () => undefined },
    panelUsageFailureCounts: new Map(),
    warningTimestamps: new Map(),
    prisma: {
      panelClientBinding: {
        findMany: async () => [
          {
            subscriptionId: "sub_1",
            panelClientEmail: "a@example.com",
            panelInboundId: 1,
            nodeId: "node_1",
            node: {
              id: "node_1",
              panelBaseUrl: "https://panel.example.com",
              panelApiBasePath: "/",
              panelUsername: "admin",
              panelPassword: "password",
              panelInboundId: 1,
              panelStatus: "online"
            }
          }
        ]
      },
      node: {
        update: async (payload: any) => {
          updates.push(payload);
          return payload;
        }
      },
      meteringIncident: {
        updateMany: async () => ({ count: 0 }),
        findMany: async () => []
      },
      nodeSessionLease: {
        findMany: async () => []
      }
    },
    xuiService: {
      listNodeUsage: async () => {
        throw new Error("temporary panel glitch");
      }
    },
    openIncidentForSubscriptions: async () => undefined,
    resolveIncidentForSubscriptions: async () => undefined,
    resolveResidualUnavailableNodeIncidents: async () => undefined
  });

  // call private sync via bracket
  for (let i = 0; i < 2; i += 1) {
    await (service as any).syncXuiUsage();
  }
  assert.equal(updates.length, 0, "first two usage failures must not degrade panel");
  await (service as any).syncXuiUsage();
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.panelStatus, "degraded");
}

async function main() {
  await testProbeTimeoutKeepsPanelOnline();
  await testProbeDegradesAfterThreeFailures();
  await testUsageSyncDegradesOnlyAfterThreshold();
  console.log("panel status stability regression checks passed");
}

void main();
