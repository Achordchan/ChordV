import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AdminCreateNodeAgentCredentialResultDto,
  AdminNodeAgentDto,
  AgentCommandDto,
  AgentConfigDto,
  AgentUsageBatchAckDto,
  NodeAgentCommandType
} from "@chordv/shared";
import { NodeAgent, Prisma } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AgentCommandResultDto, AgentHeartbeatDto, AgentUsageBatchDto, QueueAgentCommandDto } from "./agent.dto";
import { AgentEventsService } from "./agent-events.service";
import { ClientEventsPublisher } from "../common/client-events.publisher";
import { PrismaService } from "../common/prisma.service";
import { trafficGbNumberToBytes } from "../common/traffic-bytes.utils";
import { runWithNodeAndSubscriptionUsageLocks, runWithNodeUsageLock } from "../common/usage-lock.utils";
import { applyDirectBatch, type SubscriptionTransition } from "./agent-direct-metering";

const OFFLINE_ALLOWANCE_BYTES = 64n * 1024n * 1024n;
const MAX_SERIALIZABLE_RETRIES = 3;
const MAX_CONTIGUOUS_BATCHES_PER_TRANSACTION = 4;

@Injectable()
export class AgentService {
  constructor(private readonly prisma: PrismaService, private readonly events: AgentEventsService, private readonly clientEvents: ClientEventsPublisher) {}

  async authenticate(authorization?: string): Promise<NodeAgent | null> {
    const token = readBearerToken(authorization);
    if (!token) return null;
    return this.prisma.nodeAgent.findFirst({
      where: { tokenHash: hashAgentToken(token), revokedAt: null }
    });
  }

  async createCredential(nodeId: string, requestedAgentId?: string): Promise<AdminCreateNodeAgentCredentialResultDto> {
    const node = await this.prisma.node.findUnique({ where: { id: nodeId }, select: { id: true } });
    if (!node) throw new NotFoundException("节点不存在");
    const token = `chordv_agent_${randomBytes(32).toString("base64url")}`;
    const agentId = requestedAgentId?.trim() || `${nodeId}-${randomBytes(6).toString("hex")}`;
    const agent = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.nodeAgent.updateMany({
        where: { nodeId, revokedAt: null },
        data: { revokedAt: now, status: "revoked" }
      });
      return tx.nodeAgent.create({
        data: {
          id: randomUUID(),
          agentId,
          nodeId,
          tokenHash: hashAgentToken(token),
          tokenPrefix: token.slice(0, 20)
        }
      });
    });
    return { ...serializeAgent(agent), token };
  }

  async listAgents(nodeId: string): Promise<AdminNodeAgentDto[]> {
    const agents = await this.prisma.nodeAgent.findMany({ where: { nodeId }, orderBy: { createdAt: "desc" } });
    return agents.map(serializeAgent);
  }

  async revokeCredential(nodeId: string, agentRecordId: string) {
    const result = await this.prisma.nodeAgent.updateMany({
      where: { id: agentRecordId, nodeId, revokedAt: null },
      data: { revokedAt: new Date(), status: "revoked" }
    });
    if (result.count === 0) throw new NotFoundException("Agent 凭据不存在或已撤销");
    return { revoked: true };
  }

  async heartbeat(agent: NodeAgent, input: AgentHeartbeatDto) {
    return runWithNodeUsageLock(agent.nodeId, async () => {
      const now = new Date();
      const configRevision = parseDecimalBigInt(input.configRevision, "configRevision");
      const [node, currentAgent] = await Promise.all([
        this.prisma.node.findUnique({
          where: { id: agent.nodeId },
          select: { controlMode: true, controlStatus: true, agentConfigRevision: true }
        }),
        this.prisma.nodeAgent.findUnique({ where: { id: agent.id } })
      ]);
      if (!node) throw new NotFoundException("节点不存在");
      if (!currentAgent || currentAgent.revokedAt) throw new NotFoundException("Agent 凭据已撤销");
      const bootChanged = currentAgent.bootId !== input.bootId;
      const [next] = await Promise.all([
        this.prisma.nodeAgent.update({
          where: { id: agent.id },
          data: {
            bootId: input.bootId,
            version: input.version,
            status: "online",
            xrayStatus: input.xrayStatus,
            queueDepth: input.queueDepth,
            configRevision,
            lastSeenAt: now,
            ...(bootChanged ? { lastSequence: 0n, lastAckSequence: 0n } : {})
          }
        }),
        this.prisma.node.update({
          where: { id: agent.nodeId },
          data: {
            agentLastSeenAt: now,
            ...(node.controlMode === "rollback_pending" || node.controlStatus === "direct_cutover_pending"
              ? {}
              : { controlStatus: input.xrayStatus === "healthy" ? "online" : input.xrayStatus })
          }
        })
      ]);
      return {
        accepted: true,
        serverTime: now.toISOString(),
        configRevision: node.agentConfigRevision.toString(),
        ackThrough: next.lastAckSequence.toString()
      };
    });
  }

  async getConfig(agent: NodeAgent): Promise<AgentConfigDto> {
    const node = await this.prisma.node.findUnique({
      where: { id: agent.nodeId },
      include: {
        panelClientBindings: {
          where: { status: "active" },
          include: { subscription: true },
          orderBy: { id: "asc" }
        }
      }
    });
    if (!node) throw new NotFoundException("节点不存在");
    return {
      nodeId: node.id,
      controlMode: node.controlMode,
      revision: node.agentConfigRevision.toString(),
      users: node.panelClientBindings
        .filter((binding) => node.controlMode !== "direct_primary" || binding.source === "direct")
        .map((binding) => ({
        bindingId: binding.id,
        revision: binding.directRevision.toString(),
        email: binding.panelClientEmail,
        uuid: binding.panelClientId,
        flow: node.flow === "xtls-rprx-vision" ? "xtls-rprx-vision" : "",
        enabled: binding.status === "active" && binding.subscription.state === "active",
        quotaRemainingBytes: (binding.subscription.totalTrafficBytes > 0n
          ? (binding.subscription.totalTrafficBytes > binding.subscription.usedTrafficBytes ? binding.subscription.totalTrafficBytes - binding.subscription.usedTrafficBytes : 0n)
          : trafficGbNumberToBytes(binding.subscription.remainingTrafficGb)).toString(),
        offlineAllowanceBytes: OFFLINE_ALLOWANCE_BYTES.toString()
        }))
    };
  }

  async ingestUsageBatch(agent: NodeAgent, input: AgentUsageBatchDto): Promise<AgentUsageBatchAckDto> {
    const bindingIds = Array.from(new Set(input.samples.map((sample) => sample.bindingId)));
    const subscriptions = bindingIds.length === 0
      ? []
      : await this.prisma.panelClientBinding.findMany({
          where: { id: { in: bindingIds }, nodeId: agent.nodeId },
          select: { subscriptionId: true }
        });
    return runWithNodeAndSubscriptionUsageLocks(
      agent.nodeId,
      subscriptions.map((binding) => binding.subscriptionId),
      () => this.ingestUsageBatchWithinNodeLock(agent, input)
    );
  }

  private async ingestUsageBatchWithinNodeLock(agent: NodeAgent, input: AgentUsageBatchDto): Promise<AgentUsageBatchAckDto> {
    const sequence = BigInt(input.sequence);
    const sampledAt = new Date(input.sampledAt);
    const payload = canonicalBatchPayload(input);
    const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");

    const outcome = await this.withSerializableRetry(async () =>
      this.prisma.$transaction(async (tx) => {
        const currentAgent = await tx.nodeAgent.findUnique({ where: { id: agent.id } });
        if (!currentAgent || currentAgent.revokedAt) throw new NotFoundException("Agent 凭据已撤销");
        const existing = await tx.nodeUsageBatch.findUnique({
          where: { nodeId_bootId_sequence: { nodeId: agent.nodeId, bootId: input.bootId, sequence } }
        });
        if (existing) {
          if (existing.payloadHash !== payloadHash) throw new ConflictException("相同批次序号对应了不同内容");
        }

        const node = await tx.node.findUnique({ where: { id: agent.nodeId }, select: { controlMode: true } });
        if (!node) throw new NotFoundException("节点不存在");
        if (currentAgent.bootId && currentAgent.bootId !== input.bootId) {
          await tx.nodeAgent.update({ where: { id: agent.id }, data: { bootId: input.bootId, lastSequence: 0n, lastAckSequence: 0n } });
          currentAgent.lastSequence = 0n;
          currentAgent.lastAckSequence = 0n;
        }

        if (!existing) {
          await tx.nodeUsageBatch.create({
            data: {
              id: randomUUID(),
              nodeId: agent.nodeId,
              agentId: agent.id,
              bootId: input.bootId,
              sequence,
              payloadHash,
              payload: payload as Prisma.InputJsonValue,
              sampledAt
            }
          });
        }
        const processed = node.controlMode === "direct_primary"
          ? await this.accountContiguousBatches(tx, agent.id, agent.nodeId, input.bootId, currentAgent.lastAckSequence)
          : {
              ackThrough: await this.advanceAck(tx, agent.id, agent.nodeId, input.bootId, currentAgent.lastAckSequence),
              transitions: [] as SubscriptionTransition[],
              commandAgentIds: [] as string[]
            };
        const ackThrough = processed.ackThrough;
        await tx.nodeAgent.update({
          where: { id: agent.id },
          data: { bootId: input.bootId, lastSequence: sequence > currentAgent.lastSequence ? sequence : currentAgent.lastSequence, lastAckSequence: ackThrough, lastSeenAt: new Date(), status: "online" }
        });
        return {
          ack: { accepted: true, duplicate: Boolean(existing), ackThrough: ackThrough.toString() },
          transitions: processed.transitions,
          commandAgentIds: processed.commandAgentIds
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    );
    for (const transition of outcome.transitions) {
      await this.clientEvents.publishSubscriptionUpdated(transition).catch(() => undefined);
    }
    const commandAgentIds = Array.from(new Set([agent.id, ...outcome.commandAgentIds]));
    const pending = await this.prisma.nodeCommandJob.findMany({ where: { agentId: { in: commandAgentIds }, status: "pending" }, orderBy: { createdAt: "asc" }, take: 100 });
    for (const job of pending) {
      if (job.agentId) this.events.publish(job.agentId, serializeCommand(job));
    }
    return outcome.ack;
  }

  async completeCommand(agent: NodeAgent, commandId: string, input: AgentCommandResultDto) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const job = await tx.nodeCommandJob.findFirst({
        where: { id: commandId, nodeId: agent.nodeId, agentId: agent.id, status: { in: ["pending", "running", "failed"] } },
        select: { id: true, commandType: true, payload: true }
      });
      if (!job) return false;
      await tx.nodeCommandJob.update({
        where: { id: job.id },
        data: {
          status: input.status,
          result: (input.result ?? {}) as Prisma.InputJsonValue,
          lastError: input.status === "completed" ? null : input.error ?? "Agent 执行失败",
          completedAt: input.status === "completed" ? new Date() : null,
          nextRunAt: input.status === "completed" ? new Date() : new Date(Date.now() + 30_000)
        }
      });
      if (input.status === "completed" && (job.commandType === "DISABLE_USER" || job.commandType === "REMOVE_USER")) {
        const payload = job.payload as Record<string, unknown>;
        const bindingId = typeof payload.bindingId === "string" ? payload.bindingId : null;
        const watermarks = parseDisableWatermarksInput(input.result?.disableWatermarks);
        if (bindingId && watermarks) {
          await tx.panelClientBinding.updateMany({
            where: { id: bindingId, nodeId: agent.nodeId, source: "direct" },
            data: { directDisableWatermarks: watermarks as Prisma.InputJsonValue }
          });
        }
      }
      return true;
    });
    if (!updated) throw new NotFoundException("命令不存在、已结束或不属于当前 Agent");
    return { accepted: true };
  }

  async queueCommand(nodeId: string, input: QueueAgentCommandDto): Promise<AgentCommandDto> {
    const agent = await this.prisma.nodeAgent.findFirst({
      where: { nodeId, revokedAt: null },
      orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }]
    });
    if (!agent) throw new BadRequestException("该节点尚未创建有效 Agent 凭据");
    const node = await this.prisma.node.update({
      where: { id: nodeId },
      data: { agentConfigRevision: { increment: 1n } },
      select: { agentConfigRevision: true }
    });
    const targetRevision = node.agentConfigRevision;
    const dedupeKey = input.dedupeKey ?? `${nodeId}:${input.type}:${randomUUID()}`;
    const job = await this.prisma.nodeCommandJob.upsert({
      where: { dedupeKey },
      update: {},
      create: {
        id: randomUUID(),
        dedupeKey,
        nodeId,
        agentId: agent.id,
        commandType: input.type,
        targetRevision,
        payload: input.payload as Prisma.InputJsonValue
      }
    });
    const command = serializeCommand(job);
    this.events.publish(agent.id, command);
    return command;
  }

  private async advanceAck(tx: Prisma.TransactionClient, agentId: string, nodeId: string, bootId: string, currentAck: bigint) {
    const batches = await tx.nodeUsageBatch.findMany({
      where: { agentId, nodeId, bootId, sequence: { gt: currentAck } },
      select: { sequence: true },
      orderBy: { sequence: "asc" },
      take: 10_000
    });
    let ack = currentAck;
    for (const batch of batches) {
      if (batch.sequence !== ack + 1n) break;
      ack = batch.sequence;
    }
    return ack;
  }

  private async accountContiguousBatches(
    tx: Prisma.TransactionClient,
    agentId: string,
    nodeId: string,
    bootId: string,
    currentAck: bigint
  ) {
    const batches = await tx.nodeUsageBatch.findMany({
      where: { agentId, nodeId, bootId, sequence: { gt: currentAck } },
      select: { id: true, sequence: true, payload: true, sampledAt: true, accountedAt: true },
      orderBy: { sequence: "asc" },
      take: MAX_CONTIGUOUS_BATCHES_PER_TRANSACTION
    });
    const transitions: SubscriptionTransition[] = [];
    const commandAgentIds = new Set<string>();
    let ackThrough = currentAck;
    for (const batch of batches) {
      if (batch.sequence !== ackThrough + 1n) break;
      if (!batch.accountedAt) {
        const payload = batch.payload as unknown as ReturnType<typeof canonicalBatchPayload>;
        const applied = await applyDirectBatch(tx, agentId, nodeId, batch.sampledAt, bootId, batch.sequence, payload.samples);
        transitions.push(...applied.transitions);
        for (const commandAgentId of applied.commandAgentIds) commandAgentIds.add(commandAgentId);
        await tx.nodeUsageBatch.update({ where: { id: batch.id }, data: { accountedAt: new Date() } });
      }
      ackThrough = batch.sequence;
    }
    return { ackThrough, transitions, commandAgentIds: Array.from(commandAgentIds) };
  }

  private async withSerializableRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try { return await operation(); }
      catch (error) {
        if (attempt >= MAX_SERIALIZABLE_RETRIES || !isRetryableAgentTransactionError(error)) throw error;
        await delay(25 * attempt);
      }
    }
  }
}

function parseDisableWatermarksInput(value: unknown): Array<{ bootId: string; sequenceThrough: string }> | null {
  if (!Array.isArray(value)) return null;
  const result: Array<{ bootId: string; sequenceThrough: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const bootId = Reflect.get(item, "bootId");
    const sequenceThrough = Reflect.get(item, "sequenceThrough");
    if (typeof bootId !== "string" || typeof sequenceThrough !== "string" || !/^(0|[1-9]\d*)$/.test(sequenceThrough)) return null;
    result.push({ bootId, sequenceThrough });
  }
  return result;
}

export function isRetryableAgentTransactionError(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2034" || error.code === "P1008") return true;
    if (error.code !== "P2028") return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /transaction already closed|unable to start a transaction|transaction not found|write conflict|deadlock|timeout expired/i.test(message);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function hashAgentToken(token: string) {
  const pepper = process.env.CHORDV_AGENT_TOKEN_PEPPER?.trim() || "chordv-development-agent-token-pepper";
  return createHash("sha256").update(`${pepper}:${token}`).digest("hex");
}

export function assertAgentTokenPepperReadyForProduction() {
  if (process.env.NODE_ENV !== "production") return;
  const pepper = process.env.CHORDV_AGENT_TOKEN_PEPPER?.trim() ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(pepper)) {
    throw new Error("生产环境必须配置 32 字节十六进制 CHORDV_AGENT_TOKEN_PEPPER");
  }
}

export function parseDecimalBigInt(value: string, field: string) {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new BadRequestException(`${field} 必须是非负十进制整数字符串`);
  return BigInt(value);
}

function readBearerToken(authorization?: string) {
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}

function canonicalBatchPayload(input: AgentUsageBatchDto) {
  return {
    bootId: input.bootId,
    sequence: input.sequence,
    sampledAt: input.sampledAt,
    samples: input.samples.map((entry) => ({
      bindingId: entry.bindingId,
      counterGeneration: entry.counterGeneration,
      uplinkBytes: entry.uplinkBytes,
      downlinkBytes: entry.downlinkBytes,
      uplinkDeltaBytes: entry.uplinkDeltaBytes,
      downlinkDeltaBytes: entry.downlinkDeltaBytes
    }))
  };
}

function serializeAgent(agent: NodeAgent): AdminNodeAgentDto {
  return {
    id: agent.id,
    agentId: agent.agentId,
    nodeId: agent.nodeId,
    tokenPrefix: agent.tokenPrefix,
    version: agent.version,
    status: agent.status,
    xrayStatus: agent.xrayStatus,
    bootId: agent.bootId,
    configRevision: agent.configRevision.toString(),
    lastSequence: agent.lastSequence.toString(),
    lastAckSequence: agent.lastAckSequence.toString(),
    queueDepth: agent.queueDepth,
    lastSeenAt: agent.lastSeenAt?.toISOString() ?? null,
    revokedAt: agent.revokedAt?.toISOString() ?? null
  };
}

function serializeCommand(job: { id: string; commandType: NodeAgentCommandType; targetRevision: bigint; payload: Prisma.JsonValue; createdAt: Date }): AgentCommandDto {
  return {
    commandId: job.id,
    type: job.commandType,
    targetRevision: job.targetRevision.toString(),
    payload: job.payload as Record<string, unknown>,
    createdAt: job.createdAt.toISOString()
  };
}
