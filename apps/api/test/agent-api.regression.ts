import assert from "node:assert/strict";
import { ConflictException } from "@nestjs/common";
import { applyDirectBatch } from "../src/modules/agent/agent-direct-metering";
import { AgentService, assertAgentTokenPepperReadyForProduction, hashAgentToken, isRetryableAgentTransactionError, parseDecimalBigInt } from "../src/modules/agent/agent.service";

type StoredBatch = { id: string; nodeId: string; agentId: string; bootId: string; sequence: bigint; payloadHash: string };

async function main() {
  assert.equal(parseDecimalBigInt("900719925474099312345", "bytes"), 900719925474099312345n);
  assert.throws(() => parseDecimalBigInt("1.5", "bytes"));
  assert.equal(hashAgentToken("same-token"), hashAgentToken("same-token"));
  assert.notEqual(hashAgentToken("same-token"), hashAgentToken("other-token"));
  assert.equal(isRetryableAgentTransactionError(new Error("Transaction API error: Transaction already closed")), true);
  assert.equal(isRetryableAgentTransactionError(new Error("Transaction failed due to a write conflict or a deadlock")), true);
  assert.equal(isRetryableAgentTransactionError(new Error("Direct 用户绑定无效")), false);

  const previousNodeEnv = process.env.NODE_ENV;
  const previousPepper = process.env.CHORDV_AGENT_TOKEN_PEPPER;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.CHORDV_AGENT_TOKEN_PEPPER;
    assert.throws(() => assertAgentTokenPepperReadyForProduction(), /CHORDV_AGENT_TOKEN_PEPPER/);
    process.env.CHORDV_AGENT_TOKEN_PEPPER = "a".repeat(64);
    assert.doesNotThrow(() => assertAgentTokenPepperReadyForProduction());
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousPepper === undefined) delete process.env.CHORDV_AGENT_TOKEN_PEPPER;
    else process.env.CHORDV_AGENT_TOKEN_PEPPER = previousPepper;
  }

  const fixture = createFixture();
  const service = new AgentService(fixture.prisma as never, { publish() {} } as never, { publishSubscriptionUpdated: async () => undefined } as never);
  const batch = {
    bootId: "boot-a",
    sequence: "1",
    sampledAt: "2026-07-26T00:00:00.000Z",
    samples: []
  };
  const first = await service.ingestUsageBatch(fixture.agent as never, batch);
  assert.deepEqual(first, { accepted: true, duplicate: false, ackThrough: "1" });
  for (let index = 0; index < 99; index += 1) {
    const duplicate = await service.ingestUsageBatch(fixture.agent as never, batch);
    assert.deepEqual(duplicate, { accepted: true, duplicate: true, ackThrough: "1" });
  }
  assert.equal(fixture.batches.length, 1, "重复上报100次只能创建一个批次");

  const outOfOrder = createFixture();
  const outOfOrderService = new AgentService(outOfOrder.prisma as never, { publish() {} } as never, { publishSubscriptionUpdated: async () => undefined } as never);
  const second = await outOfOrderService.ingestUsageBatch(outOfOrder.agent as never, { ...batch, sequence: "2" });
  assert.equal(second.ackThrough, "0");
  const thenFirst = await outOfOrderService.ingestUsageBatch(outOfOrder.agent as never, batch);
  assert.equal(thenFirst.ackThrough, "2", "缺口补齐后应连续确认到序号2");

  await assert.rejects(
    () => outOfOrderService.ingestUsageBatch(outOfOrder.agent as never, { ...batch, sampledAt: "2026-07-26T00:00:01.000Z" }),
    ConflictException
  );

  const bootReset = createFixture();
  bootReset.agent.bootId = "boot-old";
  bootReset.agent.lastSequence = 23n;
  bootReset.agent.lastAckSequence = 23n;
  const bootResetService = new AgentService(
    bootReset.prisma as never,
    { publish() {} } as never,
    { publishSubscriptionUpdated: async () => undefined } as never
  );
  const firstNewBoot = await bootResetService.ingestUsageBatch(
    bootReset.agent as never,
    { ...batch, bootId: "boot-new" }
  );
  assert.equal(firstNewBoot.ackThrough, "1");
  assert.equal(bootReset.agent.bootId, "boot-new");
  assert.equal(bootReset.agent.lastSequence, 1n, "新 boot 的监控序号必须从1重新开始");
  assert.equal(bootReset.agent.lastAckSequence, 1n);

  const direct = createDirectFixture();
  const directService = new AgentService(direct.prisma as never, { publish() {} } as never, { publishSubscriptionUpdated: async () => undefined } as never);
  const secondDirect = await directService.ingestUsageBatch(direct.agent as never, usageBatch("2", "200"));
  assert.equal(secondDirect.ackThrough, "0");
  assert.equal(direct.subscription.usedTrafficBytes, 0n, "乱序批次存在缺口时不得提前入账");
  const firstDirect = await directService.ingestUsageBatch(direct.agent as never, usageBatch("1", "100"));
  assert.equal(firstDirect.ackThrough, "2");
  assert.equal(direct.subscription.usedTrafficBytes, 100n, "补齐缺口后必须按序建立基线并只入账后续差值");
  const writesBeforeIdleBatch = { ...direct.queryCounts };
  const idleDirect = await directService.ingestUsageBatch(direct.agent as never, usageBatch("3", "200"));
  assert.equal(idleDirect.ackThrough, "3");
  assert.equal(direct.subscription.usedTrafficBytes, 100n, "绝对计数未变化时不得重复入账");
  assert.equal(direct.queryCounts.snapshotUpserts, writesBeforeIdleBatch.snapshotUpserts, "零增量批次不得逐用户重写快照");
  assert.equal(direct.queryCounts.bindingUpdates, writesBeforeIdleBatch.bindingUpdates, "零增量批次不得逐用户重写绑定");
  assert.equal(direct.queryCounts.subscriptionUpdates, writesBeforeIdleBatch.subscriptionUpdates, "零增量批次不得触碰套餐账本");
  assert.equal(direct.queryCounts.snapshotBulkRefreshes, writesBeforeIdleBatch.snapshotBulkRefreshes + 1);
  assert.equal(direct.queryCounts.bindingBulkRefreshes, writesBeforeIdleBatch.bindingBulkRefreshes + 1);

  const resetGeneration = await directService.ingestUsageBatch(direct.agent as never, usageBatch("4", "50", "1"));
  assert.equal(resetGeneration.ackThrough, "4");
  assert.equal(direct.subscription.usedTrafficBytes, 150n, "新 counterGeneration 的首个绝对样本必须计入套餐用量");

  const multiNode = createMultiNodeExhaustionFixture();
  const multiNodeResult = await applyDirectBatch(
    multiNode.tx as never,
    "agent-node-1",
    "node-1",
    new Date("2026-07-26T00:00:05.000Z"),
    [{
      bindingId: "binding-1",
      counterGeneration: "0",
      uplinkBytes: "120",
      downlinkBytes: "0",
      uplinkDeltaBytes: "30",
      downlinkDeltaBytes: "0"
    }]
  );
  assert.deepEqual(new Set(multiNodeResult.commandAgentIds), new Set(["agent-node-1", "agent-node-2"]));
  assert.equal(multiNode.bindings.every((item) => item.status === "disabled"), true, "共享套餐耗尽必须停用所有 Direct 节点绑定");
  assert.deepEqual(new Set(multiNode.commands.map((item) => item.nodeId)), new Set(["node-1", "node-2"]));
  assert.deepEqual(new Set(multiNode.commands.map((item) => item.agentId)), new Set(["agent-node-1", "agent-node-2"]));
  assert.equal(multiNode.revocations[0]?.update.status, "pending", "再次耗尽必须把既有租约撤销任务重新排队");
  assert.equal(multiNode.revocations[0]?.update.attempts, 0);
  assert.equal(multiNode.revocations[0]?.update.completedAt, null);

  const missingAgent = createMultiNodeExhaustionFixture(false);
  const missingAgentResult = await applyDirectBatch(
    missingAgent.tx as never,
    "agent-node-1",
    "node-1",
    new Date("2026-07-26T00:00:05.000Z"),
    [{
      bindingId: "binding-1",
      counterGeneration: "0",
      uplinkBytes: "120",
      downlinkBytes: "0",
      uplinkDeltaBytes: "30",
      downlinkDeltaBytes: "0"
    }]
  );
  assert.equal(missingAgent.subscription.state, "exhausted", "缺失 Agent 不得回滚套餐耗尽状态");
  assert.equal(missingAgent.bindings.every((item) => item.status === "disabled"), true);
  assert.deepEqual(missingAgentResult.commandAgentIds, ["agent-node-1"]);
  assert.equal(missingAgent.nodeUpdates.get("node-2")?.controlStatus, "degraded", "缺失 Agent 的节点必须标记为异常");

  console.log("agent-api regression tests passed");
}

function usageBatch(sequence: string, uplinkBytes: string, counterGeneration = "0") {
  return {
    bootId: "boot-a",
    sequence,
    sampledAt: `2026-07-26T00:00:0${sequence}.000Z`,
    samples: [{
      bindingId: "binding-1",
      counterGeneration,
      uplinkBytes,
      downlinkBytes: "0",
      uplinkDeltaBytes: "100",
      downlinkDeltaBytes: "0"
    }]
  };
}

function createMultiNodeExhaustionFixture(hasSecondAgent = true) {
  const subscription = {
    id: "subscription-shared",
    totalTrafficGb: 0,
    usedTrafficGb: 0,
    remainingTrafficGb: 0,
    totalTrafficBytes: 100n,
    usedTrafficBytes: 90n,
    state: "active",
    expireAt: new Date("2027-07-26T00:00:00.000Z")
  };
  const bindings = ["node-1", "node-2"].map((nodeId, index) => ({
    id: `binding-${index + 1}`,
    nodeId,
    subscriptionId: subscription.id,
    userId: `user-${index + 1}`,
    teamId: null,
    source: "direct",
    status: "active",
    directRevision: 1n,
    panelClientEmail: `user-${index + 1}@example.invalid`,
    panelClientId: `00000000-0000-4000-8000-00000000000${index + 1}`,
    lastUplinkBytes: index === 0 ? 90n : 0n,
    lastDownlinkBytes: 0n,
    subscription
  }));
  const commands: Array<{ nodeId: string; agentId: string }> = [];
  const revocations: Array<{ create: Record<string, unknown>; update: Record<string, unknown> }> = [];
  const nodeUpdates = new Map<string, Record<string, unknown>>();
  const revisions = new Map([["node-1", 1n], ["node-2", 5n]]);
  const tx = {
    panelClientBinding: {
      findMany: async ({ where }: any) => where.id ? [bindings[0]] : bindings.filter((item) => where.subscriptionId.in.includes(item.subscriptionId) && item.status === "active"),
      updateMany: async ({ where, data }: any) => {
        for (const binding of bindings.filter((item) => where.id.in.includes(item.id))) Object.assign(binding, data);
        return { count: where.id.in.length };
      },
      update: async ({ where, data }: any) => {
        const binding = bindings.find((item) => item.id === where.id)!;
        Object.assign(binding, data);
        return binding;
      }
    },
    trafficSnapshot: {
      findMany: async () => [{ snapshotKey: "node-1:subscription-shared:user-1", uplinkBytes: 90n, downlinkBytes: 0n, counterGeneration: "0" }],
      upsert: async () => undefined,
      updateMany: async () => ({ count: 0 })
    },
    subscription: {
      update: async ({ data }: any) => { Object.assign(subscription, data); return subscription; }
    },
    trafficLedger: { createMany: async () => ({ count: 0 }) },
    node: {
      update: async ({ where, data }: any) => {
        nodeUpdates.set(where.id, data);
        const revision = (revisions.get(where.id) ?? 0n) + 1n;
        revisions.set(where.id, revision);
        return { agentConfigRevision: revision };
      }
    },
    nodeAgent: {
      findMany: async () => hasSecondAgent ? [{ id: "agent-node-2", nodeId: "node-2", revokedAt: null }] : []
    },
    nodeCommandJob: {
      upsert: async ({ create }: any) => { commands.push({ nodeId: create.nodeId, agentId: create.agentId }); return create; }
    },
    leaseRevocationJob: {
      upsert: async ({ create, update }: any) => { revocations.push({ create, update }); return create; }
    }
  };
  return { tx, bindings, commands, subscription, revocations, nodeUpdates };
}

function createDirectFixture() {
  const batches: Array<StoredBatch & { payload: unknown; sampledAt: Date; accountedAt: Date | null }> = [];
  const snapshots = new Map<string, { snapshotKey: string; uplinkBytes: bigint; downlinkBytes: bigint; counterGeneration: string; sampledAt?: Date }>();
  const queryCounts = {
    snapshotUpserts: 0,
    snapshotBulkRefreshes: 0,
    bindingUpdates: 0,
    bindingBulkRefreshes: 0,
    subscriptionUpdates: 0
  };
  const agent = { id: "agent-record-1", agentId: "agent-public-1", nodeId: "node-1", bootId: "boot-a", lastSequence: 0n, lastAckSequence: 0n, revokedAt: null };
  const subscription = {
    id: "subscription-1",
    totalTrafficGb: 1,
    usedTrafficGb: 0,
    remainingTrafficGb: 1,
    totalTrafficBytes: 1024n * 1024n * 1024n,
    usedTrafficBytes: 0n,
    state: "active",
    expireAt: new Date("2027-07-26T00:00:00.000Z")
  };
  const binding = {
    id: "binding-1",
    nodeId: "node-1",
    subscriptionId: subscription.id,
    userId: "user-1",
    teamId: null,
    source: "direct",
    status: "active",
    directRevision: 1n,
    panelClientEmail: "user@example.com",
    panelClientId: "00000000-0000-4000-8000-000000000001",
    lastUplinkBytes: 0n,
    lastDownlinkBytes: 0n,
    subscription
  };
  const tx = {
    nodeAgent: {
      findUnique: async () => ({ ...agent }),
      update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(agent, data); return { ...agent }; }
    },
    node: { findUnique: async () => ({ controlMode: "direct_primary" }) },
    nodeUsageBatch: {
      findUnique: async ({ where }: any) => batches.find((item) => item.sequence === where.nodeId_bootId_sequence.sequence) ?? null,
      create: async ({ data }: any) => { const row = { ...data, sampledAt: new Date(data.sampledAt), accountedAt: null }; batches.push(row); return row; },
      update: async ({ where, data }: any) => { const row = batches.find((item) => item.id === where.id)!; Object.assign(row, data); return row; },
      findMany: async ({ where }: any) => batches.filter((item) => item.sequence > where.sequence.gt).sort((a, b) => a.sequence < b.sequence ? -1 : 1)
    },
    panelClientBinding: {
      findMany: async () => [binding],
      update: async ({ data }: any) => { queryCounts.bindingUpdates += 1; Object.assign(binding, data); return binding; },
      updateMany: async ({ data }: any) => { queryCounts.bindingBulkRefreshes += 1; Object.assign(binding, data); return { count: 1 }; }
    },
    trafficSnapshot: {
      findMany: async () => Array.from(snapshots.values()),
      upsert: async ({ where, create, update }: any) => {
        queryCounts.snapshotUpserts += 1;
        const next = snapshots.has(where.snapshotKey)
          ? { ...snapshots.get(where.snapshotKey), ...update, snapshotKey: where.snapshotKey }
          : { ...create, snapshotKey: where.snapshotKey };
        snapshots.set(where.snapshotKey, next);
        return next;
      },
      updateMany: async ({ data }: any) => {
        queryCounts.snapshotBulkRefreshes += 1;
        for (const [key, snapshot] of snapshots) snapshots.set(key, { ...snapshot, ...data });
        return { count: snapshots.size };
      }
    },
    subscription: {
      update: async ({ data }: any) => { queryCounts.subscriptionUpdates += 1; Object.assign(subscription, data); return subscription; }
    },
    trafficLedger: { createMany: async () => ({ count: 0 }) },
    nodeCommandJob: { upsert: async () => undefined },
    leaseRevocationJob: { upsert: async () => undefined }
  };
  return {
    agent,
    subscription,
    queryCounts,
    prisma: {
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
      panelClientBinding: { findMany: async () => [{ subscriptionId: binding.subscriptionId }] },
      nodeCommandJob: { findMany: async () => [] }
    }
  };
}

function createFixture() {
  const batches: StoredBatch[] = [];
  const agent = {
    id: "agent-record-1",
    agentId: "agent-public-1",
    nodeId: "node-1",
    bootId: "boot-a",
    lastSequence: 0n,
    lastAckSequence: 0n,
    revokedAt: null
  };
  const tx = {
    nodeAgent: {
      findUnique: async () => ({ ...agent }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(agent, data);
        return { ...agent };
      }
    },
    node: {
      findUnique: async () => ({ controlMode: "shadow_direct" })
    },
    nodeUsageBatch: {
      findUnique: async ({ where }: { where: { nodeId_bootId_sequence: { nodeId: string; bootId: string; sequence: bigint } } }) => {
        const key = where.nodeId_bootId_sequence;
        return batches.find((item) => item.nodeId === key.nodeId && item.bootId === key.bootId && item.sequence === key.sequence) ?? null;
      },
      create: async ({ data }: { data: StoredBatch }) => {
        batches.push({ ...data });
        return data;
      },
      update: async () => undefined,
      findMany: async ({ where }: { where: { agentId: string; nodeId: string; bootId: string; sequence: { gt: bigint } } }) =>
        batches
          .filter((item) => item.agentId === where.agentId && item.nodeId === where.nodeId && item.bootId === where.bootId && item.sequence > where.sequence.gt)
          .sort((left, right) => left.sequence < right.sequence ? -1 : 1)
          .map((item) => ({ sequence: item.sequence }))
    }
  };
  return {
    agent,
    batches,
    prisma: {
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
      nodeCommandJob: { findMany: async () => [] }
    }
  };
}

void main();
