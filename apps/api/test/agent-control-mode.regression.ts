import assert from "node:assert/strict";
import { ConflictException } from "@nestjs/common";
import { AgentControlModeService } from "../src/modules/agent/agent-control-mode.service";
import { UsageSyncService } from "../src/modules/usage/usage-sync.service";

async function main() {
  await assert.rejects(
    () => serviceFor(node("direct_primary")).switchMode("node-1", { targetMode: "xui_primary", confirmRollback: true }),
    ConflictException,
    "Direct 不得直接切回 XUI"
  );
  await assert.rejects(
    () => serviceFor(node("shadow_direct")).switchMode("node-1", { targetMode: "direct_primary" }),
    ConflictException,
    "Shadow 切 Direct 必须显式确认"
  );

  const pending = createFixture(node("direct_primary"), { lastSequence: 2n, lastAckSequence: 1n });
  await assert.rejects(
    () => pending.service.switchMode("node-1", { targetMode: "rollback_pending", confirmRollback: true }),
    /未确认流量批次/
  );
  const oldBootBatch = createFixture(node("direct_primary"), { lastSequence: 2n, lastAckSequence: 2n }, [{
    bootId: "boot-old",
    sequence: 99n,
    accountedAt: null
  }]);
  const rollback = await oldBootBatch.service.switchMode("node-1", { targetMode: "rollback_pending", confirmRollback: true });
  assert.equal(rollback.controlMode, "rollback_pending", "旧 boot 的高序号批次不得阻塞当前 boot 回退");
  await assert.rejects(
    () => serviceFor(node("rollback_pending")).switchMode("node-1", { targetMode: "xui_primary", confirmRollback: true }),
    /3X-UI 用户已按相同 UUID\/email 校准/
  );

  const shadowNode = node("shadow_direct", [binding("binding-1", "user@example.com", "uuid-1")]);
  const fixture = createFixture(shadowNode, { lastSequence: 1n, lastAckSequence: 1n }, [{
    sequence: 1n,
    sampledAt: new Date(),
    payload: { samples: [{ bindingId: "binding-1", counterGeneration: "boot-a:0", uplinkBytes: "100", downlinkBytes: "200" }] }
  }]);
  const result = await fixture.service.switchMode("node-1", { targetMode: "direct_primary", confirmDirect: true });
  assert.equal(result.controlMode, "direct_primary");
  assert.equal(result.revision, "1");
  assert.equal(fixture.snapshotCreates.length, 1);
  assert.equal(fixture.snapshotCreates[0].uplinkBytes, 100n);
  assert.equal(fixture.subscriptionUpdates[0].usedTrafficBytes, 300n, "XUI 结清后到 Direct 基线之间的正向差值必须入账");
  assert.equal(fixture.bindingUpdates[0].source, "direct");
  assert.equal(fixture.commands[0].commandType, "RECONCILE_USERS");
  assert.equal(fixture.published.length, 1);

  const queuedFixture = createFixture(shadowNode, { lastSequence: 1n, lastAckSequence: 1n, queueDepth: 1 }, [{
    sequence: 1n,
    sampledAt: new Date(),
    payload: { samples: [{ bindingId: "binding-1", counterGeneration: "boot-a:0", uplinkBytes: "100", downlinkBytes: "200" }] }
  }]);
  const queuedContext = await (queuedFixture.service as any).loadDirectSwitchContext("node-1");
  assert.equal(queuedContext.samples.get("binding-1").downlinkBytes, 200n, "心跳队列深度滞后不得覆盖已确认批次边界");

  const staleFixture = createFixture(shadowNode, { lastSequence: 1n, lastAckSequence: 1n }, [{
    sequence: 1n,
    sampledAt: new Date(Date.now() - 16_000),
    payload: { samples: [{ bindingId: "binding-1", counterGeneration: "boot-a:0", uplinkBytes: "100", downlinkBytes: "200" }] }
  }]);
  await assert.rejects(
    () => (staleFixture.service as any).loadDirectSwitchContext("node-1"),
    /快照已过期/
  );

  const retryFixture = createFixture(shadowNode, { lastSequence: 1n, lastAckSequence: 1n }, [{
    sequence: 1n,
    sampledAt: new Date(),
    payload: { samples: [{ bindingId: "binding-1", counterGeneration: "boot-a:0", uplinkBytes: "100", downlinkBytes: "200" }] }
  }], [], { transactionFailures: 1 });
  const retryResult = await retryFixture.service.switchMode("node-1", { targetMode: "direct_primary", confirmDirect: true });
  assert.equal(retryResult.controlMode, "direct_primary");
  assert.equal(retryFixture.getTransactionAttempts(), 2, "P2034 应有限重试后完成切换");

  const exhaustedRetryFixture = createFixture(shadowNode, { lastSequence: 1n, lastAckSequence: 1n }, [{
    sequence: 1n,
    sampledAt: new Date(),
    payload: { samples: [{ bindingId: "binding-1", counterGeneration: "boot-a:0", uplinkBytes: "100", downlinkBytes: "200" }] }
  }], [], { transactionFailures: 3 });
  await assert.rejects(
    () => exhaustedRetryFixture.service.switchMode("node-1", { targetMode: "direct_primary", confirmDirect: true }),
    (error: unknown) => typeof error === "object" && error !== null && Reflect.get(error, "code") === "P2034"
  );
  assert.equal(exhaustedRetryFixture.getTransactionAttempts(), 3, "P2034 最多只能尝试3次");
  assert.equal(exhaustedRetryFixture.commands.length, 0);
  assert.equal(exhaustedRetryFixture.published.length, 0);

  const changedContextFixture = createFixture(shadowNode, { lastSequence: 1n, lastAckSequence: 1n }, [{
    sequence: 1n,
    sampledAt: new Date(),
    payload: { samples: [{ bindingId: "binding-1", counterGeneration: "boot-a:0", uplinkBytes: "100", downlinkBytes: "200" }] }
  }], [], { transactionAgentOverride: { lastSequence: 2n, lastAckSequence: 2n } });
  await assert.rejects(
    () => changedContextFixture.service.switchMode("node-1", { targetMode: "direct_primary", confirmDirect: true }),
    /切换期间发生变化/
  );

  const changedBindingNode = node("shadow_direct", [binding("binding-1", "changed@example.com", "uuid-1")]);
  const changedBindingFixture = createFixture(shadowNode, { lastSequence: 1n, lastAckSequence: 1n }, [{
    sequence: 1n,
    sampledAt: new Date(),
    payload: { samples: [{ bindingId: "binding-1", counterGeneration: "boot-a:0", uplinkBytes: "100", downlinkBytes: "200" }] }
  }], [], { transactionNode: changedBindingNode });
  await assert.rejects(
    () => changedBindingFixture.service.switchMode("node-1", { targetMode: "direct_primary", confirmDirect: true }),
    /用户身份在切换期间发生变化/
  );

  const rollbackNode = node("rollback_pending", [binding("binding-rollback", "rollback@example.com", "uuid-rollback")]);
  const rollbackFixture = createFixture(rollbackNode, {}, [], [{
    xrayUserEmail: "rollback@example.com",
    xrayUserUuid: "uuid-rollback",
    uplinkBytes: 900n,
    downlinkBytes: 1200n,
    sampledAt: "2026-07-27T07:50:00.000Z"
  }]);
  const rollbackResult = await rollbackFixture.service.switchMode("node-1", {
    targetMode: "xui_primary",
    confirmRollback: true,
    confirmXuiCalibrated: true
  });
  assert.equal(rollbackResult.controlMode, "xui_primary");
  assert.equal(rollbackFixture.bindingUpdates[0].source, "xui");
  assert.equal(rollbackFixture.bindingUpdates[0].lastUplinkBytes, 900n);
  assert.equal(rollbackFixture.bindingUpdates[0].lastDownlinkBytes, 1200n);
  assert.equal(rollbackFixture.snapshotCreates[0].source, "xui");
  assert.equal(rollbackFixture.snapshotCreates[0].totalBytes, 2100n);
  assert.equal(rollbackFixture.subscriptionUpdates[0].usedTrafficBytes, 2100n, "回退窗口的正向流量差值必须在替换 XUI 基线前入账");

  const missingRollbackFixture = createFixture(rollbackNode, {}, [], []);
  await assert.rejects(
    () => missingRollbackFixture.service.switchMode("node-1", {
      targetMode: "xui_primary",
      confirmRollback: true,
      confirmXuiCalibrated: true
    }),
    /回退样本缺失/
  );

  const duplicateNode = node("shadow_direct", [
    binding("binding-1", "same@example.com", "uuid-1"),
    binding("binding-2", "same@example.com", "uuid-2")
  ]);
  await assert.rejects(
    () => createFixture(duplicateNode, { lastSequence: 1n, lastAckSequence: 1n }, [{
      sequence: 1n,
      sampledAt: new Date(),
      payload: { samples: [
        { bindingId: "binding-1", counterGeneration: "boot-a:0", uplinkBytes: "0", downlinkBytes: "0" },
        { bindingId: "binding-2", counterGeneration: "boot-a:0", uplinkBytes: "0", downlinkBytes: "0" }
      ] }
    }]).service.switchMode("node-1", { targetMode: "direct_primary", confirmDirect: true }),
    /重复/
  );

  await assertStaleXuiWorkIsDiscardedAfterDirectSwitch();
  await assertFinalXuiSettlementProducesCutoverBoundary();

  console.log("agent control-mode regression tests passed");
}

async function assertFinalXuiSettlementProducesCutoverBoundary() {
  const sampledAt = new Date();
  let applied = 0;
  const service = Object.create(UsageSyncService.prototype) as UsageSyncService;
  Object.assign(service, {
    prisma: {
      panelClientBinding: {
        findMany: async () => [{
          id: "binding-1",
          subscriptionId: "subscription-1",
          userId: "user-1",
          teamId: null,
          nodeId: "node-1",
          panelClientEmail: "user@example.com",
          panelClientId: "uuid-1",
          panelInboundId: 7,
          node: { id: "node-1", panelBaseUrl: "https://panel.example.com", panelApiBasePath: "/", panelUsername: "admin", panelPassword: "password", panelInboundId: 7 }
        }]
      }
    },
    xuiService: {
      listNodeUsage: async () => [{ xrayUserEmail: "user@example.com", xrayUserUuid: "uuid-1", uplinkBytes: 1n, downlinkBytes: 2n, sampledAt: sampledAt.toISOString() }]
    },
    loadNodeSyncContext: async () => ({ subscriptionIds: ["subscription-1"], mappings: new Map(), leaseMappingsByUuid: new Map(), invalidMappings: [] }),
    applyNodeSamples: async () => { applied += 1; }
  });
  const boundary = await service.settleNodeForDirectCutover("node-1");
  assert.equal(boundary.toISOString(), sampledAt.toISOString());
  assert.equal(applied, 1);
}

async function assertStaleXuiWorkIsDiscardedAfterDirectSwitch() {
  let panelReads = 0;
  let appliedSamples = 0;
  const service = Object.create(UsageSyncService.prototype) as UsageSyncService;
  Object.assign(service, {
    prisma: {
      panelClientBinding: {
        findMany: async () => [{
          id: "binding-stale",
          subscriptionId: "subscription-stale",
          userId: "user-stale",
          teamId: null,
          nodeId: "node-stale",
          panelClientEmail: "stale@example.com",
          panelClientId: "uuid-stale",
          panelInboundId: 7,
          node: {
            id: "node-stale",
            panelBaseUrl: "https://panel.example.com",
            panelApiBasePath: "/",
            panelUsername: "admin",
            panelPassword: "password",
            panelInboundId: 7
          }
        }]
      },
      node: {
        findUnique: async () => ({ controlMode: "direct_primary" })
      }
    },
    xuiService: {
      listNodeUsage: async () => {
        panelReads += 1;
        return [];
      }
    },
    resolveResidualUnavailableNodeIncidents: async () => undefined,
    applyNodeSamples: async () => {
      appliedSamples += 1;
    }
  });
  await (service as any).syncXuiUsage();
  assert.equal(panelReads, 0, "拿到节点锁后已切为Direct时不得继续读取XUI流量");
  assert.equal(appliedSamples, 0, "锁外选中的Shadow任务不得在Direct模式继续入账");
}

function serviceFor(nodeValue: ReturnType<typeof node>) {
  return createFixture(nodeValue).service;
}

function createFixture(
  nodeValue: ReturnType<typeof node>,
  agentOverride: Record<string, unknown> = {},
  batches: Array<Record<string, unknown>> = [],
  xuiSamples: Array<Record<string, unknown>> = [],
  options: {
    transactionFailures?: number;
    transactionAgentOverride?: Record<string, unknown>;
    transactionNode?: ReturnType<typeof node>;
    settledAt?: Date;
    xuiSnapshot?: { uplinkBytes: bigint; downlinkBytes: bigint };
  } = {}
) {
  const snapshotCreates: Array<Record<string, any>> = [];
  const bindingUpdates: Array<Record<string, any>> = [];
  const subscriptionUpdates: Array<Record<string, any>> = [];
  const commands: Array<Record<string, any>> = [];
  const published: unknown[] = [];
  const agent = {
    id: "agent-record-1",
    nodeId: "node-1",
    status: "online",
    xrayStatus: "healthy",
    bootId: "boot-a",
    lastSeenAt: new Date(),
    lastSequence: 0n,
    lastAckSequence: 0n,
    queueDepth: 0,
    ...agentOverride
  };
  const transactionAgent = { ...agent, ...options.transactionAgentOverride };
  let remainingTransactionFailures = options.transactionFailures ?? 0;
  let transactionAttempts = 0;
  const settledAt = options.settledAt ?? new Date(Date.now() - 1_000);
  const tx = {
    node: {
      findUnique: async () => options.transactionNode ?? nodeValue,
      update: async ({ data }: any) => ({ ...nodeValue, ...data })
    },
    nodeAgent: { findFirst: async () => transactionAgent },
    nodeUsageBatch: {
      findFirst: async ({ where }: any) => batches.find((batch: any) =>
        batch.bootId === where.bootId && BigInt(batch.sequence) > BigInt(where.sequence.gt)
      ) ?? null,
      findUnique: async ({ where }: any) => {
        const key = where.nodeId_bootId_sequence;
        const batch = batches.find((item: any) =>
          (item.bootId ?? "boot-a") === key.bootId && BigInt(item.sequence) === BigInt(key.sequence)
        );
        return batch ? { agentId: "agent-record-1", ...batch } : null;
      }
    },
    trafficSnapshot: {
      findUnique: async () => ({
        source: nodeValue.controlMode === "rollback_pending" ? "direct" : "xui",
        sampledAt: settledAt,
        uplinkBytes: options.xuiSnapshot?.uplinkBytes ?? 0n,
        downlinkBytes: options.xuiSnapshot?.downlinkBytes ?? 0n
      }),
      upsert: async ({ update, create }: any) => { snapshotCreates.push(update ?? create); return create; },
      updateMany: async () => ({ count: 1 })
    },
    subscription: {
      update: async ({ data }: any) => { subscriptionUpdates.push(data); return data; }
    },
    trafficLedger: { createMany: async () => ({ count: 0 }) },
    leaseRevocationJob: { upsert: async () => undefined },
    panelClientBinding: {
      update: async ({ data }: any) => { bindingUpdates.push(data); return data; },
      updateMany: async () => ({ count: 1 })
    },
    nodeCommandJob: {
      create: async ({ data }: any) => { commands.push(data); return data; }
    }
  };
  const prisma = {
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => {
      transactionAttempts += 1;
      if (remainingTransactionFailures > 0) {
        remainingTransactionFailures -= 1;
        throw { code: "P2034", message: "Transaction failed due to a write conflict" };
      }
      return operation(tx);
    },
    node: {
      findUnique: async () => nodeValue,
      updateMany: async ({ data }: any) => {
        Object.assign(nodeValue, data);
        if (options.transactionNode) Object.assign(options.transactionNode, data);
        return { count: 1 };
      }
    },
    nodeAgent: { findFirst: async () => agent },
    nodeUsageBatch: {
      findUnique: async ({ where }: any) => {
        const key = where.nodeId_bootId_sequence;
        const batch = batches.find((item: any) =>
          (item.bootId ?? "boot-a") === key.bootId && BigInt(item.sequence) === BigInt(key.sequence)
        );
        return batch ? { agentId: "agent-record-1", ...batch } : null;
      }
    }
  };
  const service = new AgentControlModeService(
    prisma as never,
    { publish: (...args: unknown[]) => published.push(args) } as never,
    { listNodeUsage: async () => xuiSamples } as never,
    { settleNodeForDirectCutover: async () => settledAt } as never
  );
  return { service, snapshotCreates, bindingUpdates, subscriptionUpdates, commands, published, getTransactionAttempts: () => transactionAttempts };
}

function node(controlMode: string, panelClientBindings: Array<ReturnType<typeof binding>> = []) {
  return {
    id: "node-1",
    controlMode,
    controlStatus: "online",
    agentConfigRevision: 0n,
    flow: "xtls-rprx-vision",
    panelEnabled: true,
    panelInboundId: 4,
    panelBaseUrl: "https://panel.example.com",
    panelApiBasePath: "/",
    panelUsername: "admin",
    panelPassword: "password",
    panelClientBindings
  };
}

function binding(id: string, email: string, uuid: string) {
  return {
    id,
    subscriptionId: `subscription-${id}`,
    userId: `user-${id}`,
    teamId: null,
    nodeId: "node-1",
    panelClientEmail: email,
    panelClientId: uuid,
    status: "active",
    subscription: {
      state: "active",
      expireAt: new Date("2027-07-26T00:00:00.000Z"),
      totalTrafficGb: 1,
      usedTrafficGb: 0,
      totalTrafficBytes: 1024n,
      usedTrafficBytes: 0n,
      remainingTrafficGb: 1
    }
  };
}

void main();
