import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { AgentCommandDto, SwitchNodeControlModeResultDto } from "@chordv/shared";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { buildSnapshotKey } from "../common/runtime-session.utils";
import { createOrRefreshLeaseRevocationJob } from "../common/panel-sync-job.utils";
import { trafficBytesToGbNumber, trafficGbNumberToBytes } from "../common/traffic-bytes.utils";
import { runWithNodeUsageLock } from "../common/usage-lock.utils";
import { SwitchNodeControlModeDto } from "./agent.dto";
import { AgentEventsService } from "./agent-events.service";
import { PrismaService } from "../common/prisma.service";
import { XuiService } from "../xui/xui.service";
import { UsageSyncService } from "../usage/usage-sync.service";

const AGENT_FRESHNESS_MS = 90_000;
const DIRECT_SWITCH_SAMPLE_FRESHNESS_MS = 15_000;
const OFFLINE_ALLOWANCE_BYTES = 64n * 1024n * 1024n;
const CONTROL_MODE_TRANSACTION_MAX_WAIT_MS = 10_000;
const CONTROL_MODE_TRANSACTION_TIMEOUT_MS = 30_000;
const CONTROL_MODE_TRANSACTION_ATTEMPTS = 3;
const DIRECT_CUTOVER_WAIT_MS = 30_000;
const DIRECT_CUTOVER_POLL_MS = 1_000;

@Injectable()
export class AgentControlModeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: AgentEventsService,
    private readonly xuiService: XuiService,
    private readonly usageSyncService: UsageSyncService
  ) {}

  async switchMode(nodeId: string, input: SwitchNodeControlModeDto): Promise<SwitchNodeControlModeResultDto> {
    if (input.targetMode === "direct_primary" && input.confirmDirect === true) {
      return this.switchToDirect(nodeId, input);
    }
    return runWithNodeUsageLock(nodeId, async () => {
      const xuiRollbackBaselines =
        input.targetMode === "xui_primary" && input.confirmRollback === true && input.confirmXuiCalibrated === true
          ? await this.loadXuiRollbackBaselines(nodeId)
          : null;
      const outcome = await this.runSwitchTransaction(nodeId, input, xuiRollbackBaselines, null);
      if (outcome.command && outcome.agentRecordId) this.events.publish(outcome.agentRecordId, outcome.command);
      return outcome.result;
    });
  }

  private async switchToDirect(nodeId: string, input: SwitchNodeControlModeDto) {
    const preparation = await runWithNodeUsageLock(nodeId, async () => {
      const node = await this.prisma.node.findUnique({
        where: { id: nodeId },
        select: {
          controlMode: true,
          controlStatus: true,
          agentConfigRevision: true,
          panelClientBindings: {
            where: { status: "active" },
            select: { id: true, subscription: { select: { state: true } } }
          }
        }
      });
      if (!node) throw new NotFoundException("节点不存在");
      if (node.controlMode === "direct_primary") {
        return { result: toResult(nodeId, node.controlMode, node.controlMode, node.agentConfigRevision, false), boundary: null };
      }
      assertAllowedTransition(node.controlMode, input);
      const inactiveBindings = node.panelClientBindings.filter((binding) => binding.subscription.state !== "active");
      if (inactiveBindings.length > 0) throw new ConflictException(`存在不可迁移的非活跃订阅绑定：${inactiveBindings.map((binding) => binding.id).join(",")}`);
      const boundary = await this.usageSyncService.settleNodeForDirectCutover(nodeId);
      const prepared = await this.prisma.node.updateMany({
        where: { id: nodeId, controlMode: "shadow_direct", agentConfigRevision: node.agentConfigRevision },
        data: { controlStatus: "direct_cutover_pending" }
      });
      if (prepared.count !== 1) throw new ConflictException("节点状态在 Direct 准备期间发生变化，请重试");
      return { result: null, boundary };
    });
    if (preparation.result) return preparation.result;

    try {
      const directSwitchContext = await this.waitForDirectSwitchContext(nodeId, preparation.boundary!);
      return await runWithNodeUsageLock(nodeId, async () => {
        const outcome = await this.runSwitchTransaction(nodeId, input, null, directSwitchContext);
        if (outcome.command && outcome.agentRecordId) this.events.publish(outcome.agentRecordId, outcome.command);
        return outcome.result;
      });
    } catch (error) {
      await runWithNodeUsageLock(nodeId, async () => {
        await this.prisma.node.updateMany({
          where: { id: nodeId, controlMode: "shadow_direct", controlStatus: "direct_cutover_pending" },
          data: { controlStatus: "online" }
        });
      }).catch(() => undefined);
      throw error;
    }
  }

  private async waitForDirectSwitchContext(nodeId: string, minimumSampledAt: Date) {
    const deadline = Date.now() + DIRECT_CUTOVER_WAIT_MS;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      try {
        const context = await this.loadDirectSwitchContext(nodeId, minimumSampledAt);
        if (context) return context;
      } catch (error) {
        lastError = error;
      }
      await waitForRetry(DIRECT_CUTOVER_POLL_MS);
    }
    if (lastError instanceof ConflictException) throw lastError;
    throw new ConflictException("等待 Agent 最终绝对计数快照超时，请重试");
  }

  private async runSwitchTransaction(
    nodeId: string,
    input: SwitchNodeControlModeDto,
    xuiRollbackBaselines: Map<string, XuiRollbackBaseline> | null,
    directSwitchContext: DirectSwitchContext | null
  ) {
    for (let attempt = 1; attempt <= CONTROL_MODE_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          (tx) => this.switchWithinTransaction(tx, nodeId, input, xuiRollbackBaselines, directSwitchContext),
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: CONTROL_MODE_TRANSACTION_MAX_WAIT_MS,
            timeout: CONTROL_MODE_TRANSACTION_TIMEOUT_MS
          }
        );
      } catch (error) {
        if (!isPrismaWriteConflict(error) || attempt === CONTROL_MODE_TRANSACTION_ATTEMPTS) throw error;
        await waitForRetry(50 * 2 ** (attempt - 1));
      }
    }
    throw new Error("unreachable control-mode transaction state");
  }

  private async switchWithinTransaction(
    tx: Prisma.TransactionClient,
    nodeId: string,
    input: SwitchNodeControlModeDto,
    xuiRollbackBaselines: Map<string, XuiRollbackBaseline> | null,
    directSwitchContext: DirectSwitchContext | null
  ) {
    const node = await tx.node.findUnique({
      where: { id: nodeId },
      include: {
        panelClientBindings: {
          where: { status: "active" },
          include: { subscription: true },
          orderBy: { id: "asc" }
        }
      }
    });
    if (!node) throw new NotFoundException("节点不存在");
    const previousMode = node.controlMode;
    if (previousMode === input.targetMode) {
      return { result: toResult(nodeId, previousMode, previousMode, node.agentConfigRevision, false), command: null, agentRecordId: null };
    }
    assertAllowedTransition(previousMode, input);

    const needsAgent = input.targetMode !== "xui_primary" || previousMode === "direct_primary" || previousMode === "rollback_pending";
    const agent = needsAgent ? await this.findEffectiveAgent(tx, nodeId) : null;
    if ((previousMode === "direct_primary" || previousMode === "rollback_pending") && agent) {
      if (!agent.bootId) throw new ConflictException("有效 Agent 缺少 bootId");
      await this.assertNoUnconfirmedBatches(tx, agent.id, agent.bootId, agent.lastAckSequence, agent.lastSequence);
    }

    const revision = node.agentConfigRevision + 1n;
    let directCutoverSubscriptions: Map<string, DirectCutoverSubscription> | null = null;
    if (previousMode === "shadow_direct" && input.targetMode === "direct_primary") {
      if (node.controlStatus !== "direct_cutover_pending") throw new ConflictException("节点尚未完成 Direct 切换准备");
      if (!directSwitchContext) throw new ConflictException("Shadow 切换上下文缺失，请重试");
      if (!agent?.bootId) throw new ConflictException("有效 Agent 缺少 bootId");
      assertDirectSwitchContextUnchanged(agent, directSwitchContext);
      assertDirectBindingIdentityUnchanged(node.panelClientBindings, directSwitchContext.bindings);
      assertBindingIdentity(node.panelClientBindings);
      const inactiveBindings = node.panelClientBindings.filter((binding) => binding.subscription.state !== "active");
      if (inactiveBindings.length > 0) throw new ConflictException(`存在不可迁移的非活跃订阅绑定：${inactiveBindings.map((binding) => binding.id).join(",")}`);
      if (agent.lastAckSequence !== agent.lastSequence) throw new ConflictException("Shadow 批次尚未连续确认，禁止切换 Direct");
      const samples = directSwitchContext.samples;
      const missing = node.panelClientBindings.filter((binding) => !samples.has(binding.id));
      if (missing.length > 0) throw new ConflictException(`Shadow 样本缺失：${missing.map((item) => item.id).join(",")}`);
      assertDirectSamplesFresh(samples);
      const cutoverUsage: DirectCutoverUsageEntry[] = [];
      for (const binding of node.panelClientBindings) {
        const sample = samples.get(binding.id)!;
        const snapshotKey = buildSnapshotKey(nodeId, binding.subscriptionId, binding.userId);
        const xuiSnapshot = await tx.trafficSnapshot.findUnique({ where: { snapshotKey } });
        if (!xuiSnapshot || xuiSnapshot.source !== "xui") throw new ConflictException(`最终 XUI 快照缺失：${binding.id}`);
        if (xuiSnapshot.sampledAt > sample.sampledAt) throw new ConflictException(`Direct 基线早于最终 XUI 快照：${binding.id}`);
        if (sample.uplinkBytes < xuiSnapshot.uplinkBytes || sample.downlinkBytes < xuiSnapshot.downlinkBytes) {
          throw new ConflictException(`切换窗口累计计数发生回退，请重新结清 XUI：${binding.id}`);
        }
        const cutoverDeltaBytes = sample.uplinkBytes - xuiSnapshot.uplinkBytes
          + (sample.downlinkBytes - xuiSnapshot.downlinkBytes);
        if (cutoverDeltaBytes > 0n) {
          cutoverUsage.push({
            subscriptionId: binding.subscriptionId,
            userId: binding.userId,
            teamId: binding.teamId,
            deltaBytes: cutoverDeltaBytes,
            sampledAt: sample.sampledAt,
            subscription: binding.subscription
          });
        }
        await tx.trafficSnapshot.upsert({
          where: { snapshotKey },
          update: { uplinkBytes: sample.uplinkBytes, downlinkBytes: sample.downlinkBytes, totalBytes: sample.uplinkBytes + sample.downlinkBytes, sampledAt: sample.sampledAt, source: "direct", counterGeneration: sample.counterGeneration },
          create: { id: randomUUID(), snapshotKey, nodeId, subscriptionId: binding.subscriptionId, userId: binding.userId, teamId: binding.teamId, uplinkBytes: sample.uplinkBytes, downlinkBytes: sample.downlinkBytes, totalBytes: sample.uplinkBytes + sample.downlinkBytes, sampledAt: sample.sampledAt, source: "direct", counterGeneration: sample.counterGeneration }
        });
        await tx.panelClientBinding.update({ where: { id: binding.id }, data: { source: "direct", directRevision: revision, lastUplinkBytes: sample.uplinkBytes, lastDownlinkBytes: sample.downlinkBytes, lastSyncedAt: sample.sampledAt } });
      }
      directCutoverSubscriptions = await applyDirectCutoverUsage(tx, nodeId, cutoverUsage);
    } else if (previousMode === "rollback_pending" && input.targetMode === "xui_primary") {
      if (!xuiRollbackBaselines) throw new ConflictException("缺少3X-UI回退基线，禁止完成回退");
      for (const binding of node.panelClientBindings) {
        const baseline = xuiRollbackBaselines.get(binding.id);
        if (!baseline) throw new ConflictException(`缺少3X-UI回退基线：${binding.id}`);
        const snapshotKey = buildSnapshotKey(nodeId, binding.subscriptionId, binding.userId);
        await tx.panelClientBinding.update({
          where: { id: binding.id },
          data: {
            source: "xui",
            directRevision: revision,
            lastUplinkBytes: baseline.uplinkBytes,
            lastDownlinkBytes: baseline.downlinkBytes,
            lastSyncedAt: baseline.sampledAt
          }
        });
        await tx.trafficSnapshot.upsert({
          where: { snapshotKey },
          update: {
            uplinkBytes: baseline.uplinkBytes,
            downlinkBytes: baseline.downlinkBytes,
            totalBytes: baseline.uplinkBytes + baseline.downlinkBytes,
            sampledAt: baseline.sampledAt,
            source: "xui",
            counterGeneration: `xui:${revision.toString()}`
          },
          create: {
            id: randomUUID(),
            snapshotKey,
            nodeId,
            subscriptionId: binding.subscriptionId,
            userId: binding.userId,
            teamId: binding.teamId,
            uplinkBytes: baseline.uplinkBytes,
            downlinkBytes: baseline.downlinkBytes,
            totalBytes: baseline.uplinkBytes + baseline.downlinkBytes,
            sampledAt: baseline.sampledAt,
            source: "xui",
            counterGeneration: `xui:${revision.toString()}`
          }
        });
      }
    }

    await tx.node.update({
      where: { id: nodeId },
      data: { controlMode: input.targetMode, agentConfigRevision: revision, controlStatus: input.targetMode === "rollback_pending" ? "rollback_pending" : "online" }
    });
    const command = agent ? await this.createModeCommand(tx, node, agent.id, input.targetMode, revision, directCutoverSubscriptions) : null;
    return {
      result: toResult(nodeId, previousMode, input.targetMode, revision, true),
      command,
      agentRecordId: agent?.id ?? null
    };
  }

  private async findEffectiveAgent(tx: Prisma.TransactionClient, nodeId: string) {
    const agent = await tx.nodeAgent.findFirst({
      where: { nodeId, revokedAt: null, status: "online", xrayStatus: "healthy", lastSeenAt: { gte: new Date(Date.now() - AGENT_FRESHNESS_MS) } },
      orderBy: { lastSeenAt: "desc" }
    });
    if (!agent) throw new ConflictException("没有在线且健康的有效 Agent");
    return agent;
  }

  private async loadDirectSwitchContext(nodeId: string, minimumSampledAt?: Date): Promise<DirectSwitchContext | null> {
    const node = await this.prisma.node.findUnique({
      where: { id: nodeId },
      select: {
        controlMode: true,
        panelClientBindings: {
          where: { status: "active" },
          select: {
            id: true,
            panelClientEmail: true,
            panelClientId: true,
            subscriptionId: true,
            userId: true,
            teamId: true
          },
          orderBy: { id: "asc" }
        }
      }
    });
    if (!node) throw new NotFoundException("节点不存在");
    if (node.controlMode !== "shadow_direct") return null;
    const agent = await this.prisma.nodeAgent.findFirst({
      where: {
        nodeId,
        revokedAt: null,
        status: "online",
        xrayStatus: "healthy",
        lastSeenAt: { gte: new Date(Date.now() - AGENT_FRESHNESS_MS) }
      },
      orderBy: { lastSeenAt: "desc" }
    });
    if (!agent) throw new ConflictException("没有在线且健康的有效 Agent");
    if (!agent.bootId) throw new ConflictException("有效 Agent 缺少 bootId");
    if (agent.lastAckSequence !== agent.lastSequence) {
      throw new ConflictException("Shadow 批次尚未连续确认，禁止切换 Direct");
    }
    const samples = await this.loadLatestShadowSamples(
      this.prisma,
      nodeId,
      agent.id,
      agent.bootId,
      agent.lastAckSequence,
      minimumSampledAt
    );
    return {
      agentRecordId: agent.id,
      bootId: agent.bootId,
      lastAckSequence: agent.lastAckSequence,
      lastSequence: agent.lastSequence,
      bindings: node.panelClientBindings.map(toDirectBindingIdentity),
      samples
    };
  }

  private async loadXuiRollbackBaselines(nodeId: string): Promise<Map<string, XuiRollbackBaseline>> {
    const node = await this.prisma.node.findUnique({
      where: { id: nodeId },
      include: {
        panelClientBindings: {
          where: { status: "active" },
          orderBy: { id: "asc" }
        }
      }
    });
    if (!node) throw new NotFoundException("节点不存在");
    if (node.controlMode !== "rollback_pending") throw new ConflictException("节点尚未进入回退窗口");
    if (!node.panelEnabled || !node.panelInboundId) throw new ConflictException("3X-UI面板配置不完整，禁止完成回退");

    const samples = await this.xuiService.listNodeUsage({
      id: node.id,
      panelBaseUrl: node.panelBaseUrl,
      panelApiBasePath: node.panelApiBasePath,
      panelUsername: node.panelUsername,
      panelPassword: node.panelPassword,
      panelInboundId: node.panelInboundId
    });
    const bindingsByEmail = new Map(
      node.panelClientBindings.map((binding) => [binding.panelClientEmail.trim().toLowerCase(), binding])
    );
    const baselines = new Map<string, XuiRollbackBaseline>();
    for (const sample of samples) {
      const email = sample.xrayUserEmail.trim().toLowerCase();
      const binding = bindingsByEmail.get(email);
      if (!binding) throw new ConflictException(`3X-UI存在未知回退用户：${email}`);
      if (sample.xrayUserUuid && sample.xrayUserUuid.trim().toLowerCase() !== binding.panelClientId.trim().toLowerCase()) {
        throw new ConflictException(`3X-UI回退用户UUID不一致：${binding.id}`);
      }
      if (baselines.has(binding.id)) throw new ConflictException(`3X-UI回退用户重复：${binding.id}`);
      const sampledAt = new Date(sample.sampledAt);
      if (Number.isNaN(sampledAt.getTime())) throw new ConflictException(`3X-UI回退样本时间无效：${binding.id}`);
      baselines.set(binding.id, {
        uplinkBytes: sample.uplinkBytes,
        downlinkBytes: sample.downlinkBytes,
        sampledAt
      });
    }
    const missing = node.panelClientBindings.filter((binding) => !baselines.has(binding.id));
    if (missing.length > 0) throw new ConflictException(`3X-UI回退样本缺失：${missing.map((item) => item.id).join(",")}`);
    return baselines;
  }

  private async assertNoUnconfirmedBatches(tx: Prisma.TransactionClient, agentId: string, bootId: string, ack: bigint, last: bigint) {
    if (ack !== last) throw new ConflictException("存在未确认流量批次，禁止回退");
    const gap = await tx.nodeUsageBatch.findFirst({ where: { agentId, bootId, sequence: { gt: ack } }, select: { id: true } });
    if (gap) throw new ConflictException("存在未确认流量批次，禁止回退");
  }

  private async loadLatestShadowSamples(client: Pick<Prisma.TransactionClient, "nodeUsageBatch">, nodeId: string, agentId: string, bootId: string, ackThrough: bigint, minimumSampledAt?: Date) {
    if (ackThrough <= 0n) throw new ConflictException("Shadow 尚无已确认的绝对计数快照");
    const batch = await client.nodeUsageBatch.findUnique({
      where: { nodeId_bootId_sequence: { nodeId, bootId, sequence: ackThrough } },
      select: { agentId: true, payload: true, sampledAt: true }
    });
    if (!batch || batch.agentId !== agentId) throw new ConflictException("Shadow 最新确认批次不存在");
    if (minimumSampledAt && batch.sampledAt < minimumSampledAt) {
      throw new ConflictException("Agent 最终快照尚未越过 XUI 结清边界");
    }
    if (Date.now() - batch.sampledAt.getTime() > DIRECT_SWITCH_SAMPLE_FRESHNESS_MS) {
      throw new ConflictException("Shadow 绝对计数快照已过期，请等待 Agent 完成新采样");
    }
    const samples = new Map<string, { uplinkBytes: bigint; downlinkBytes: bigint; counterGeneration: string; sampledAt: Date }>();
    const payload = batch.payload as unknown as { samples?: Array<{ bindingId: string; counterGeneration: string; uplinkBytes: string; downlinkBytes: string }> };
    for (const sample of payload.samples ?? []) {
      if (samples.has(sample.bindingId)) throw new ConflictException(`Shadow 最新批次包含重复绑定：${sample.bindingId}`);
      samples.set(sample.bindingId, { uplinkBytes: parseBytes(sample.uplinkBytes), downlinkBytes: parseBytes(sample.downlinkBytes), counterGeneration: sample.counterGeneration, sampledAt: batch.sampledAt });
    }
    return samples;
  }

  private async createModeCommand(
    tx: Prisma.TransactionClient,
    node: Awaited<ReturnType<typeof this.loadNodeShape>>,
    agentRecordId: string,
    controlMode: string,
    revision: bigint,
    subscriptionOverrides: Map<string, DirectCutoverSubscription> | null = null
  ): Promise<AgentCommandDto> {
    const users = node.panelClientBindings.map((binding) => {
      const subscription = subscriptionOverrides?.get(binding.subscriptionId) ?? binding.subscription;
      return {
        bindingId: binding.id,
        revision: revision.toString(),
        email: binding.panelClientEmail,
        uuid: binding.panelClientId,
        flow: node.flow === "xtls-rprx-vision" ? "xtls-rprx-vision" : "",
        enabled: binding.status === "active" && subscription.state === "active",
        quotaRemainingBytes: remainingBytes(subscription).toString(),
        offlineAllowanceBytes: OFFLINE_ALLOWANCE_BYTES.toString()
      };
    });
    const payload = { controlMode, users };
    const id = randomUUID();
    await tx.nodeCommandJob.create({ data: { id, dedupeKey: `control-mode:${node.id}:${revision.toString()}`, nodeId: node.id, agentId: agentRecordId, commandType: "RECONCILE_USERS", targetRevision: revision, payload } });
    return { commandId: id, type: "RECONCILE_USERS", targetRevision: revision.toString(), payload, createdAt: new Date().toISOString() };
  }

  // Type-only helper: never called.
  private loadNodeShape() {
    return this.prisma.node.findUniqueOrThrow({ where: { id: "" }, include: { panelClientBindings: { include: { subscription: true } } } });
  }
}

type XuiRollbackBaseline = {
  uplinkBytes: bigint;
  downlinkBytes: bigint;
  sampledAt: Date;
};

type DirectCutoverSubscription = {
  state: "active" | "expired" | "exhausted" | "paused";
  totalTrafficBytes: bigint;
  usedTrafficBytes: bigint;
  remainingTrafficGb: number;
};

type DirectCutoverUsageEntry = {
  subscriptionId: string;
  userId: string | null;
  teamId: string | null;
  deltaBytes: bigint;
  sampledAt: Date;
  subscription: DirectCutoverSubscription & {
    totalTrafficGb: number;
    usedTrafficGb: number;
    expireAt: Date;
  };
};

async function applyDirectCutoverUsage(
  tx: Prisma.TransactionClient,
  nodeId: string,
  entries: DirectCutoverUsageEntry[]
) {
  const grouped = new Map<string, { entries: DirectCutoverUsageEntry[]; deltaBytes: bigint; sampledAt: Date }>();
  for (const entry of entries) {
    const current = grouped.get(entry.subscriptionId);
    if (current) {
      current.entries.push(entry);
      current.deltaBytes += entry.deltaBytes;
      if (entry.sampledAt > current.sampledAt) current.sampledAt = entry.sampledAt;
    } else {
      grouped.set(entry.subscriptionId, { entries: [entry], deltaBytes: entry.deltaBytes, sampledAt: entry.sampledAt });
    }
  }
  const updatedSubscriptions = new Map<string, DirectCutoverSubscription>();
  const ledgerRows: Prisma.TrafficLedgerCreateManyInput[] = [];
  for (const [subscriptionId, usage] of grouped) {
    const subscription = usage.entries[0]!.subscription;
    const totalTrafficBytes = subscription.totalTrafficBytes > 0n
      ? subscription.totalTrafficBytes
      : trafficGbNumberToBytes(subscription.totalTrafficGb);
    const usedTrafficBytes = subscription.usedTrafficBytes > 0n
      ? subscription.usedTrafficBytes
      : trafficGbNumberToBytes(subscription.usedTrafficGb);
    const nextUsedTrafficBytes = usedTrafficBytes + usage.deltaBytes;
    const remainingTrafficBytes = totalTrafficBytes > nextUsedTrafficBytes
      ? totalTrafficBytes - nextUsedTrafficBytes
      : 0n;
    const nextState = subscription.state !== "active"
      ? subscription.state
      : subscription.expireAt.getTime() <= usage.sampledAt.getTime()
        ? "expired"
        : remainingTrafficBytes === 0n ? "exhausted" : "active";
    await tx.subscription.update({
      where: { id: subscriptionId },
      data: {
        totalTrafficBytes,
        usedTrafficBytes: nextUsedTrafficBytes,
        usedTrafficGb: trafficBytesToGbNumber(nextUsedTrafficBytes),
        remainingTrafficGb: trafficBytesToGbNumber(remainingTrafficBytes),
        state: nextState,
        lastSyncedAt: usage.sampledAt
      }
    });
    updatedSubscriptions.set(subscriptionId, {
      state: nextState,
      totalTrafficBytes,
      usedTrafficBytes: nextUsedTrafficBytes,
      remainingTrafficGb: trafficBytesToGbNumber(remainingTrafficBytes)
    });
    for (const entry of usage.entries) {
      if (entry.teamId && entry.userId) {
        ledgerRows.push({
          id: randomUUID(),
          teamId: entry.teamId,
          userId: entry.userId,
          subscriptionId,
          nodeId,
          usedTrafficBytes: entry.deltaBytes,
          usedTrafficGb: trafficBytesToGbNumber(entry.deltaBytes),
          recordedAt: entry.sampledAt
        });
      }
    }
    if (subscription.state !== nextState && nextState !== "active") {
      const dedupeKey = `direct-metering:${subscriptionId}:${nextState}`;
      const now = new Date();
      await createOrRefreshLeaseRevocationJob(tx, dedupeKey, {
        create: {
          id: randomUUID(),
          dedupeKey,
          reason: `subscription_${nextState}`,
          subscriptionId,
          nodeId,
          status: "pending",
          nextRunAt: now
        },
        update: {
          reason: `subscription_${nextState}`,
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
  if (ledgerRows.length > 0) await tx.trafficLedger.createMany({ data: ledgerRows });
  return updatedSubscriptions;
}

type DirectSwitchContext = {
  agentRecordId: string;
  bootId: string;
  lastAckSequence: bigint;
  lastSequence: bigint;
  bindings: DirectBindingIdentity[];
  samples: Map<string, {
    uplinkBytes: bigint;
    downlinkBytes: bigint;
    counterGeneration: string;
    sampledAt: Date;
  }>;
};

type DirectBindingIdentity = {
  id: string;
  email: string;
  uuid: string;
  subscriptionId: string;
  userId: string | null;
  teamId: string | null;
};

function assertDirectSwitchContextUnchanged(
  agent: { id: string; bootId: string | null; lastAckSequence: bigint; lastSequence: bigint },
  context: DirectSwitchContext
) {
  if (
    agent.id !== context.agentRecordId ||
    agent.bootId !== context.bootId ||
    agent.lastAckSequence !== context.lastAckSequence ||
    agent.lastSequence !== context.lastSequence
  ) {
    throw new ConflictException("Shadow 状态在切换期间发生变化，请重试");
  }
}

function assertDirectSamplesFresh(samples: Map<string, { sampledAt: Date }>) {
  const now = Date.now();
  for (const [bindingId, sample] of samples) {
    if (now - sample.sampledAt.getTime() > DIRECT_SWITCH_SAMPLE_FRESHNESS_MS) {
      throw new ConflictException(`Shadow 样本已过期：${bindingId}`);
    }
  }
}

function assertDirectBindingIdentityUnchanged(
  bindings: Array<{
    id: string;
    panelClientEmail: string;
    panelClientId: string;
    subscriptionId: string;
    userId: string | null;
    teamId: string | null;
  }>,
  expected: DirectBindingIdentity[]
) {
  const current = bindings.map(toDirectBindingIdentity);
  if (current.length !== expected.length) {
    throw new ConflictException("Shadow 用户集合在切换期间发生变化，请重试");
  }
  for (let index = 0; index < current.length; index += 1) {
    const actual = current[index];
    const baseline = expected[index];
    if (
      actual.id !== baseline.id ||
      actual.email !== baseline.email ||
      actual.uuid !== baseline.uuid ||
      actual.subscriptionId !== baseline.subscriptionId ||
      actual.userId !== baseline.userId ||
      actual.teamId !== baseline.teamId
    ) {
      throw new ConflictException("Shadow 用户身份在切换期间发生变化，请重试");
    }
  }
}

function toDirectBindingIdentity(binding: {
  id: string;
  panelClientEmail: string;
  panelClientId: string;
  subscriptionId: string;
  userId: string | null;
  teamId: string | null;
}): DirectBindingIdentity {
  return {
    id: binding.id,
    email: binding.panelClientEmail.trim().toLowerCase(),
    uuid: binding.panelClientId.trim().toLowerCase(),
    subscriptionId: binding.subscriptionId,
    userId: binding.userId,
    teamId: binding.teamId
  };
}

function isPrismaWriteConflict(error: unknown) {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "P2034";
}

function waitForRetry(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function assertAllowedTransition(previous: string, input: SwitchNodeControlModeDto) {
  const target = input.targetMode;
  if (previous === "xui_primary" && target === "shadow_direct") return;
  if (previous === "shadow_direct" && target === "xui_primary") return;
  if (previous === "shadow_direct" && target === "direct_primary") {
    if (input.confirmDirect !== true) throw new ConflictException("切换 Direct 必须显式确认");
    return;
  }
  if (previous === "direct_primary" && target === "rollback_pending") {
    if (input.confirmRollback !== true) throw new ConflictException("进入回退流程必须显式确认");
    return;
  }
  if (previous === "rollback_pending" && target === "xui_primary") {
    if (input.confirmRollback !== true) throw new ConflictException("完成回退必须显式确认");
    if (input.confirmXuiCalibrated !== true) throw new ConflictException("完成回退前必须确认 3X-UI 用户已按相同 UUID/email 校准");
    return;
  }
  throw new ConflictException(`不允许从 ${previous} 直接切换到 ${target}`);
}

function assertBindingIdentity(bindings: Array<{ id: string; panelClientEmail: string; panelClientId: string }>) {
  if (bindings.length === 0) throw new ConflictException("节点没有可迁移的活跃绑定");
  const emails = new Set<string>();
  const uuids = new Set<string>();
  for (const binding of bindings) {
    const email = binding.panelClientEmail.trim().toLowerCase();
    const uuid = binding.panelClientId.trim().toLowerCase();
    if (!email || !uuid) throw new ConflictException(`绑定 UUID/email 缺失：${binding.id}`);
    if (emails.has(email) || uuids.has(uuid)) throw new ConflictException(`绑定 UUID/email 重复：${binding.id}`);
    emails.add(email);
    uuids.add(uuid);
  }
}

function parseBytes(value: string) {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new ConflictException("Shadow 样本包含非法字节值");
  return BigInt(value);
}

function remainingBytes(subscription: { totalTrafficBytes: bigint; usedTrafficBytes: bigint; remainingTrafficGb: number }) {
  if (subscription.totalTrafficBytes > 0n) return subscription.totalTrafficBytes > subscription.usedTrafficBytes ? subscription.totalTrafficBytes - subscription.usedTrafficBytes : 0n;
  return trafficGbNumberToBytes(subscription.remainingTrafficGb);
}

function toResult(nodeId: string, previousMode: any, controlMode: any, revision: bigint, changed: boolean): SwitchNodeControlModeResultDto {
  return { nodeId, previousMode, controlMode, revision: revision.toString(), changed };
}
