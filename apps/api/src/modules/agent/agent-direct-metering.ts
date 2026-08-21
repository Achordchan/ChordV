import { BadRequestException, ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { buildSnapshotKey } from "../common/runtime-session.utils";
import { createOrRefreshLeaseRevocationJob } from "../common/panel-sync-job.utils";
import { trafficBytesToGbNumber, trafficGbNumberToBytes } from "../common/traffic-bytes.utils";
import { AgentUsageBatchDto } from "./agent.dto";

export type SubscriptionTransition = {
  subscriptionId: string;
  userId: string | null;
  teamId: string | null;
  state: "active" | "expired" | "exhausted" | "paused";
};

export type DirectBatchApplication = {
  transitions: SubscriptionTransition[];
  commandAgentIds: string[];
};

export type DirectDisableState = { state: SubscriptionTransition["state"] };

type DirectBinding = Prisma.PanelClientBindingGetPayload<{ include: { subscription: true } }>;

export async function applyDirectBatch(
  tx: Prisma.TransactionClient,
  agentRecordId: string,
  nodeId: string,
  sampledAt: Date,
  samples: AgentUsageBatchDto["samples"]
) {
  if (samples.length === 0) return { transitions: [], commandAgentIds: [] } as DirectBatchApplication;
  const bindingIds = samples.map((sample) => sample.bindingId);
  if (new Set(bindingIds).size !== bindingIds.length) {
    throw new ConflictException("同一批次不能包含重复的 Direct 用户绑定");
  }
  const bindings = await tx.panelClientBinding.findMany({
    where: { id: { in: bindingIds } },
    include: { subscription: true }
  });
  const bindingById = new Map(bindings.map((binding) => [binding.id, binding]));
  const prepared = samples.map((sample) => {
    const binding = bindingById.get(sample.bindingId);
    if (!binding || binding.nodeId !== nodeId || binding.source !== "direct" || binding.status !== "active") {
      throw new ConflictException(`Direct 用户绑定无效：${sample.bindingId}`);
    }
    return {
      sample,
      binding,
      snapshotKey: buildSnapshotKey(nodeId, binding.subscriptionId, binding.userId),
      uplinkBytes: parseUsageBigInt(sample.uplinkBytes, "uplinkBytes"),
      downlinkBytes: parseUsageBigInt(sample.downlinkBytes, "downlinkBytes")
    };
  });
  const snapshots = await tx.trafficSnapshot.findMany({
    where: { snapshotKey: { in: prepared.map((entry) => entry.snapshotKey) } }
  });
  const snapshotByKey = new Map(snapshots.map((snapshot) => [snapshot.snapshotKey, snapshot]));
  const unchangedBindingIds: string[] = [];
  const unchangedSnapshotKeys: string[] = [];
  const changedEntries: Array<(typeof prepared)[number]> = [];
  const deltasBySubscription = new Map<string, { binding: DirectBinding; deltaBytes: bigint }>();
  const ledgerRows: Prisma.TrafficLedgerCreateManyInput[] = [];

  for (const entry of prepared) {
    const snapshot = snapshotByKey.get(entry.snapshotKey);
    let deltaBytes = 0n;
    if (snapshot && snapshot.counterGeneration === entry.sample.counterGeneration) {
      if (entry.uplinkBytes < snapshot.uplinkBytes || entry.downlinkBytes < snapshot.downlinkBytes) {
        throw new ConflictException(`同一计数代发生回退：${entry.binding.panelClientEmail}`);
      }
      deltaBytes = entry.uplinkBytes - snapshot.uplinkBytes + (entry.downlinkBytes - snapshot.downlinkBytes);
    } else if (snapshot) {
      deltaBytes = entry.uplinkBytes + entry.downlinkBytes;
    }
    const snapshotUnchanged = snapshot
      && snapshot.counterGeneration === entry.sample.counterGeneration
      && snapshot.uplinkBytes === entry.uplinkBytes
      && snapshot.downlinkBytes === entry.downlinkBytes;
    const bindingUnchanged = entry.binding.lastUplinkBytes === entry.uplinkBytes
      && entry.binding.lastDownlinkBytes === entry.downlinkBytes;
    if (snapshotUnchanged && bindingUnchanged) {
      unchangedSnapshotKeys.push(entry.snapshotKey);
      unchangedBindingIds.push(entry.binding.id);
    } else {
      changedEntries.push(entry);
    }
    if (deltaBytes <= 0n) continue;
    const current = deltasBySubscription.get(entry.binding.subscriptionId);
    if (current) current.deltaBytes += deltaBytes;
    else deltasBySubscription.set(entry.binding.subscriptionId, { binding: entry.binding, deltaBytes });
    if (entry.binding.teamId && entry.binding.userId) {
      ledgerRows.push({
        id: randomUUID(),
        teamId: entry.binding.teamId,
        userId: entry.binding.userId,
        subscriptionId: entry.binding.subscriptionId,
        nodeId,
        usedTrafficBytes: deltaBytes,
        usedTrafficGb: trafficBytesToGbNumber(deltaBytes),
        recordedAt: sampledAt
      });
    }
  }

  if (unchangedSnapshotKeys.length > 0) {
    await tx.trafficSnapshot.updateMany({
      where: { snapshotKey: { in: unchangedSnapshotKeys } },
      data: { sampledAt }
    });
  }
  if (unchangedBindingIds.length > 0) {
    await tx.panelClientBinding.updateMany({
      where: { id: { in: unchangedBindingIds } },
      data: { lastSyncedAt: sampledAt }
    });
  }
  for (const entry of changedEntries) {
    await tx.trafficSnapshot.upsert({
      where: { snapshotKey: entry.snapshotKey },
      update: {
        uplinkBytes: entry.uplinkBytes,
        downlinkBytes: entry.downlinkBytes,
        totalBytes: entry.uplinkBytes + entry.downlinkBytes,
        sampledAt,
        source: "direct",
        counterGeneration: entry.sample.counterGeneration
      },
      create: {
        id: randomUUID(),
        snapshotKey: entry.snapshotKey,
        nodeId,
        subscriptionId: entry.binding.subscriptionId,
        userId: entry.binding.userId,
        teamId: entry.binding.teamId,
        uplinkBytes: entry.uplinkBytes,
        downlinkBytes: entry.downlinkBytes,
        totalBytes: entry.uplinkBytes + entry.downlinkBytes,
        sampledAt,
        source: "direct",
        counterGeneration: entry.sample.counterGeneration
      }
    });
    await tx.panelClientBinding.update({
      where: { id: entry.binding.id },
      data: { lastUplinkBytes: entry.uplinkBytes, lastDownlinkBytes: entry.downlinkBytes, lastSyncedAt: sampledAt }
    });
  }

  const transitions: SubscriptionTransition[] = [];
  const commandAgentIds = new Set<string>();
  const disabledSubscriptions = new Map<string, { state: SubscriptionTransition["state"] }>();
  for (const [subscriptionId, usage] of deltasBySubscription) {
    const subscription = usage.binding.subscription;
    const totalBytes = subscription.totalTrafficBytes > 0n
      ? subscription.totalTrafficBytes
      : trafficGbNumberToBytes(subscription.totalTrafficGb);
    const currentUsedBytes = subscription.usedTrafficBytes > 0n
      ? subscription.usedTrafficBytes
      : trafficGbNumberToBytes(subscription.usedTrafficGb);
    const nextUsedBytes = currentUsedBytes + usage.deltaBytes;
    const remainingBytes = totalBytes > nextUsedBytes ? totalBytes - nextUsedBytes : 0n;
    const previousState = subscription.state;
    const nextState: SubscriptionTransition["state"] = previousState !== "active"
      ? previousState
      : subscription.expireAt.getTime() <= sampledAt.getTime()
        ? "expired"
        : remainingBytes === 0n ? "exhausted" : "active";
    await tx.subscription.update({
      where: { id: subscriptionId },
      data: {
        totalTrafficBytes: totalBytes,
        usedTrafficBytes: nextUsedBytes,
        usedTrafficGb: trafficBytesToGbNumber(nextUsedBytes),
        remainingTrafficGb: trafficBytesToGbNumber(remainingBytes),
        state: nextState,
        lastSyncedAt: sampledAt
      }
    });
    if (previousState !== nextState) {
      transitions.push({
        subscriptionId,
        userId: usage.binding.userId,
        teamId: usage.binding.teamId,
        state: nextState
      });
    }
    if (nextState !== "active") disabledSubscriptions.set(subscriptionId, { state: nextState });
  }
  if (ledgerRows.length > 0) await tx.trafficLedger.createMany({ data: ledgerRows });

  if (disabledSubscriptions.size > 0) {
    for (const commandAgentId of await disableDirectBindingsForSubscriptions(tx, nodeId, agentRecordId, disabledSubscriptions)) {
      commandAgentIds.add(commandAgentId);
    }
    for (const [subscriptionId, disabled] of disabledSubscriptions) {
      const dedupeKey = `direct-metering:${subscriptionId}:${disabled.state}`;
      const now = new Date();
      await createOrRefreshLeaseRevocationJob(tx, dedupeKey, {
        create: {
          id: randomUUID(),
          dedupeKey,
          reason: `subscription_${disabled.state}`,
          subscriptionId,
          nodeId,
          status: "pending",
          nextRunAt: now
        },
        update: {
          reason: `subscription_${disabled.state}`,
          subscriptionId,
          nodeId,
          status: "pending",
          attempts: 0,
          nextRunAt: now,
          lockedAt: null,
          lastError: null,
          completedAt: null
        }
      });
    }
  }
  return { transitions, commandAgentIds: Array.from(commandAgentIds) };
}

export async function disableDirectBindingsForSubscriptions(
  tx: Prisma.TransactionClient,
  currentNodeId: string,
  currentAgentId: string,
  disabledSubscriptions: Map<string, DirectDisableState>
) {
  if (disabledSubscriptions.size === 0) return [] as string[];
  const disabledBindings = await tx.panelClientBinding.findMany({
    where: {
      subscriptionId: { in: Array.from(disabledSubscriptions.keys()) },
      source: "direct",
      status: "active"
    }
  });
  const bindingsByNode = new Map<string, typeof disabledBindings>();
  for (const binding of disabledBindings) {
    const group = bindingsByNode.get(binding.nodeId);
    if (group) group.push(binding);
    else bindingsByNode.set(binding.nodeId, [binding]);
  }
  const agentByNode = new Map<string, string>([[currentNodeId, currentAgentId]]);
  const otherNodeIds = Array.from(bindingsByNode.keys()).filter((bindingNodeId) => bindingNodeId !== currentNodeId);
  if (otherNodeIds.length > 0) {
    const agents = await tx.nodeAgent.findMany({
      where: { nodeId: { in: otherNodeIds }, revokedAt: null },
      orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }]
    });
    for (const agent of agents) {
      if (!agentByNode.has(agent.nodeId)) agentByNode.set(agent.nodeId, agent.id);
    }
  }
  const commandAgentIds = new Set<string>();
  for (const [bindingNodeId, nodeBindings] of bindingsByNode) {
    const targetAgentId = agentByNode.get(bindingNodeId) ?? null;
    const nodeRevision = await tx.node.update({
      where: { id: bindingNodeId },
      data: {
        agentConfigRevision: { increment: 1n },
        ...(targetAgentId ? {} : { controlStatus: "degraded" })
      },
      select: { agentConfigRevision: true }
    });
    await tx.panelClientBinding.updateMany({
      where: { id: { in: nodeBindings.map((binding) => binding.id) } },
      data: { status: "disabled", directRevision: nodeRevision.agentConfigRevision }
    });
    if (!targetAgentId) continue;
    for (const binding of nodeBindings) {
      const state = disabledSubscriptions.get(binding.subscriptionId)!.state;
      await tx.nodeCommandJob.upsert({
        where: { dedupeKey: `auto-disable:${binding.id}:${nodeRevision.agentConfigRevision.toString()}` },
        update: {},
        create: {
          id: randomUUID(),
          dedupeKey: `auto-disable:${binding.id}:${nodeRevision.agentConfigRevision.toString()}`,
          nodeId: bindingNodeId,
          agentId: targetAgentId,
          commandType: "DISABLE_USER",
          targetRevision: nodeRevision.agentConfigRevision,
          payload: { bindingId: binding.id, email: binding.panelClientEmail, uuid: binding.panelClientId, reason: `subscription_${state}` }
        }
      });
    }
    commandAgentIds.add(targetAgentId);
  }
  return Array.from(commandAgentIds);
}

function parseUsageBigInt(value: string, field: string) {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new BadRequestException(`${field} 必须是非负十进制整数字符串`);
  return BigInt(value);
}
