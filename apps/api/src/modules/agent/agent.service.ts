import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from "@nestjs/common";
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
import { inboundSpecKey, normalizeInboundSpec, parseInboundReport, type NormalizedInboundSpec } from "./agent-inbound";
import { ClientEventsPublisher } from "../common/client-events.publisher";
import { PrismaService } from "../common/prisma.service";
import { resolveExhaustedCommands } from "../common/node-command-job.utils";
import { trafficGbNumberToBytes } from "../common/traffic-bytes.utils";
import { runWithNodeAndSubscriptionUsageLocks, runWithNodeUsageLock } from "../common/usage-lock.utils";
import { applyDirectBatch, type SubscriptionTransition } from "./agent-direct-metering";

import { normalizePanelInbound, parsePanelReport } from "./panel-inbound";
import { AdminRuntimeEventsService } from "../common/admin-runtime-events.service";

const OFFLINE_ALLOWANCE_BYTES = 64n * 1024n * 1024n;
const MAX_SERIALIZABLE_RETRIES = 3;
const MAX_CONTIGUOUS_BATCHES_PER_TRANSACTION = 4;

@Injectable()
export class AgentService {
  constructor(private readonly prisma: PrismaService, private readonly events: AgentEventsService, private readonly clientEvents: ClientEventsPublisher,
    @Optional() private readonly adminEvents?: AdminRuntimeEventsService) {}

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
      if (currentAgent.xrayStatus !== input.xrayStatus ||
        (input.xrayStatus === "awaiting_inbound" && (!currentAgent.lastSeenAt || now.getTime() - currentAgent.lastSeenAt.getTime() >= 60_000))) {
        this.adminEvents?.publish({ type: "node_access_updated", nodeId: agent.nodeId, occurredAt: now.toISOString() });
      }
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
      // The same per-node serialization point as queueCommand, taken FIRST for
      // the same lock-order reason: this transaction writes a job row and then
      // the Node row, while queueCommand holds the Node lock while releasing a
      // superseded job's key — inverting the two orders would deadlock.
      await tx.$queryRaw`SELECT id FROM "Node" WHERE id = ${agent.nodeId} FOR UPDATE`;
      const job = await tx.nodeCommandJob.findFirst({
        where: { id: commandId, nodeId: agent.nodeId, agentId: agent.id, status: { in: ["pending", "running", "failed"] } },
        select: { id: true, commandType: true, payload: true, targetRevision: true, dedupeKey: true }
      });
      if (!job) return false;
      await tx.nodeCommandJob.update({
        where: { id: job.id },
        data: {
          status: input.status,
          result: (input.result ?? {}) as Prisma.InputJsonValue,
          lastError: input.status === "completed" ? null : input.error ?? "Agent 执行失败",
          completedAt: input.status === "completed" ? new Date() : null,
          nextRunAt: input.status === "completed" ? new Date() : new Date(Date.now() + 30_000),
          // ENSURE_INBOUND alone uses its dedupe key as an OUTSTANDING-operation
          // lock, so completing it releases the key and the same deployment can
          // be ordered again. Every other command type keeps the caller's
          // explicit key as an idempotency contract — releasing it would let a
          // delayed ENABLE_USER retry re-enable a user disabled since.
          ...(input.status === "completed" && job.commandType === "ENSURE_INBOUND"
            ? { dedupeKey: `${job.dedupeKey}:done:${job.id}` }
            : {})
        }
      });
      if (input.status === "completed" && job.commandType === "ENSURE_INBOUND") {
        await this.applyInboundReport(tx, agent.nodeId, job, input);
      }
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
    this.adminEvents?.publish({ type: "node_access_updated", nodeId: agent.nodeId, occurredAt: new Date().toISOString() });
    return { accepted: true };
  }

  /**
   * Writes the connection parameters an agent reported for a deployed inbound.
   * The node stays inactive: this only makes activation POSSIBLE (the shared
   * onboarding invariant starts passing), because shipping users to an inbound
   * nobody has smoke-tested is the operator's call, not ours.
   */
  private async applyInboundReport(
    tx: Prisma.TransactionClient,
    nodeId: string,
    job: { id: string; payload: Prisma.JsonValue; targetRevision: bigint },
    input: AgentCommandResultDto
  ) {
    const payload = (job.payload ?? {}) as Record<string, unknown>;
    const fields = payload.mode === "validate_panel"
      ? parsePanelReport(input.result, normalizePanelInbound(payload))
      : parseInboundReport(input.result, normalizeInboundSpec(payload));
    // A delayed or retried result must not overwrite a newer deployment. Reading
    // the newest completed job and then writing would still race a concurrent
    // completion — both transactions can see no newer row. One conditional
    // statement decides it instead: a stale writer simply matches no rows.
    if (payload.mode === "validate_panel") {
      // Freeze the live tag only after the authenticated report passed all public-parameter checks.
      const report = (input.result as { inbound: { inboundTag: string } }).inbound;
      await tx.nodeCommandJob.update({ where: { id: job.id }, data: { payload: { ...payload, inboundTag: report.inboundTag, tagOverrideConfirmed: true } as Prisma.InputJsonValue } });
    }
    const updated = await tx.node.updateMany({
      where: { id: nodeId, inboundAppliedRevision: { lt: job.targetRevision }, ...(payload.mode === "validate_panel" ? { isActive: false } : {}) },
      data: { ...fields, inboundAppliedRevision: job.targetRevision }
    });
    if (payload.mode === "validate_panel" && updated.count === 0) {
      throw new BadRequestException("节点已激活或校验结果已过期，请停用并基于当前 revision 重新校验");
    }
  }

  /**
   * The COMPLETE specification of the currently applied deployment — the last
   * applied ENSURE_INBOUND job's payload. The node record is a LOSSY
   * projection of it (one serverName, no dest, no inboundTag), and the admin
   * reissue flow needs the whole thing to preserve fields its form does not
   * edit instead of silently resetting them to the control-plane defaults.
   * Null when the node has no applied deployment (or its parameters predate
   * agent-native deployments, e.g. imported from a subscription URL).
   */
  async getInboundSpec(nodeId: string): Promise<{ spec: Record<string, unknown> | null }> {
    const node = await this.prisma.node.findUnique({
      where: { id: nodeId },
      select: { inboundAppliedRevision: true }
    });
    if (!node || node.inboundAppliedRevision === 0n) return { spec: null };
    const job = await this.prisma.nodeCommandJob.findFirst({
      where: {
        nodeId,
        commandType: "ENSURE_INBOUND",
        status: "completed",
        targetRevision: node.inboundAppliedRevision
      },
      orderBy: [{ targetRevision: "desc" }, { createdAt: "desc" }],
      select: { payload: true }
    });
    if (!job) {
      // A nonzero applied revision means the current parameters came from an
      // ENSURE_INBOUND command. Answering "no spec" here — the same as a node
      // that was never deployed — would let the reissue form fall back to the
      // lossy node record and silently drop SNIs, replace the dest and reset
      // the tag. Fail loudly instead, so the UI keeps reissue disabled.
      throw new BadRequestException("该节点的部署规格记录缺失（命令历史可能已被清理），无法安全地重新下发");
    }
    return { spec: job.payload as Record<string, unknown> };
  }

  /**
   * The terminal outcome of a queued command, for the admin deploy flow's
   * poll: a higher node-level applied revision alone does not prove THIS
   * command succeeded — a later administrator's deployment can push the
   * revision past a FAILED one. The command's own status is the truth.
   */
  async getCommandOutcome(nodeId: string, commandId: string): Promise<{ status: string; lastError: string | null } | null> {
    const job = await this.prisma.nodeCommandJob.findFirst({
      where: { id: commandId, nodeId },
      select: { status: true, lastError: true }
    });
    return job ?? null;
  }

  async queueCommand(nodeId: string, input: QueueAgentCommandDto): Promise<AgentCommandDto> {
    const agent = await this.prisma.nodeAgent.findFirst({
      where: { nodeId, revokedAt: null },
      orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }]
    });
    if (!agent) throw new BadRequestException("该节点尚未创建有效 Agent 凭据");
    if (input.type === "ENSURE_INBOUND") {
      const mode = (input.payload as Record<string, unknown> | undefined)?.mode;
      if (mode !== undefined && mode !== "validate_panel") throw new BadRequestException("未知入站模式，拒绝降级为部署");
      if (agent.version?.startsWith("go-") && mode !== "validate_panel") throw new BadRequestException("Go agent 仅接受面板只读校验，请导入面板链接");
      if (mode === "validate_panel" && !agent.version?.startsWith("go-")) {
        throw new BadRequestException("面板校验需要 go- 版本标识的 Go agent，禁止交给旧 Node agent 部署");
      }
    }
    // The inbound spec is the one payload the server must understand: it is
    // what the agent's report is later compared against field by field, and a
    // command dispatched with an unvalidated spec could never be verified.
    let inboundInput = input.payload as Record<string, unknown> | undefined;
    if (input.type === "ENSURE_INBOUND" && inboundInput?.mode === "validate_panel" && inboundInput.tagOverrideConfirmed !== true) {
      const applied = await this.getInboundSpec(nodeId);
      if (applied.spec?.mode === "validate_panel" && typeof applied.spec.inboundTag === "string") {
        // A registered node already has a confirmed runtime tag. Blank-tag
        // revalidation keeps it rather than reviving a parser naming guess.
        inboundInput = { ...inboundInput, inboundTag: applied.spec.inboundTag, tagOverrideConfirmed: true };
      }
    }
    const payload = input.type === "ENSURE_INBOUND"
      ? ((input.payload as Record<string, unknown> | undefined)?.mode === "validate_panel"
        ? normalizePanelInbound(inboundInput as Record<string, unknown>)
        : normalizeInboundSpec((input.payload ?? {}) as Record<string, unknown>))
      : input.payload;
    // Deduplicate RETRIES of an operation, not every historical occurrence of a
    // spec: an outstanding identical request is the double-click we want to
    // collapse, while a finished one must be repeatable (deploy 443 → 8443 →
    // 443 again, or a second key rotation with the same payload). The key is
    // therefore stable only while the operation is outstanding — completeCommand
    // releases it — so the unique index, not a read-then-write, is what makes
    // two concurrent identical requests collapse into one job.
    const dedupeKey = input.dedupeKey
      ?? (input.type === "ENSURE_INBOUND"
        ? inboundSpecKey(nodeId, payload as NormalizedInboundSpec)
        : `${nodeId}:${input.type}:${randomUUID()}`);
    // The revision allocation, the intervening-deployment check, the key
    // release and the upsert are ONE atomic unit per node. Without the
    // serialization a concurrent request can slip in between another's
    // revision allocation and its insert: the second 443 request would see no
    // intervening job, collapse onto the obsolete command, and the node would
    // end on 8443 despite the later 443 request — the unique index only
    // arbitrates same-key writes, and this check is cross-job. The Node row
    // lock also sets the lock ORDER convention (Node first, then job rows):
    // completeCommand takes the same lock first, and inverting the two orders
    // would deadlock against this release path.
    const job = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Node" WHERE id = ${nodeId} FOR UPDATE`;
      if (input.type === "ENSURE_INBOUND" && (payload as Record<string, unknown>)?.mode === "validate_panel") {
        const current = await tx.node.findUnique({ where: { id: nodeId }, select: { isActive: true, onboardingSpec: true, inboundAppliedRevision: true } });
        if (!current || current.isActive) throw new BadRequestException("请先停用节点，再导入面板参数并进行校验");
        if ((current.onboardingSpec as Record<string, unknown> | null)?.mode === "awaiting_panel" && current.inboundAppliedRevision === 0n) {
          const live = await tx.nodeAgent.findFirst({ where: { id: agent.id, revokedAt: null } });
          if (!live || !["awaiting_inbound", "healthy"].includes(live.xrayStatus) || !live.lastSeenAt || Date.now() - live.lastSeenAt.getTime() >= 60_000) {
            throw new BadRequestException("请先完成 Agent 安装并等待环境就绪，再添加节点入站");
          }
        }
        if (input.expectedInboundAppliedRevision === undefined) throw new BadRequestException("面板校验必须携带当前入站 revision");
      }
      const node = await tx.node.update({
        where: { id: nodeId },
        data: { agentConfigRevision: { increment: 1n } },
        select: { agentConfigRevision: true, inboundAppliedRevision: true }
      });
      const targetRevision = node.agentConfigRevision;
      // Compare-and-swap for ENSURE_INBOUND: reject when the node's APPLIED
      // revision moved past what the submitting form was built from. The check
      // sits inside the same Node-row lock that serializes completions, so a
      // deployment finishing concurrently cannot slip between the check and
      // the enqueue; the transaction rollback also undoes the increment above.
      if (input.type === "ENSURE_INBOUND" && input.expectedInboundAppliedRevision !== undefined
        && input.expectedInboundAppliedRevision !== node.inboundAppliedRevision.toString()) {
        throw new BadRequestException(
          `节点部署已更新（当前部署 revision ${node.inboundAppliedRevision}，表单基于 ${input.expectedInboundAppliedRevision}），请刷新后重试`
        );
      }
      // Collapse an identical request only while the outstanding one is still
      // the NEWEST deployment for the node. When the operator went 443 → 8443
      // → 443 again with nothing completed yet, the outstanding 443 command
      // carries an OLDER revision than the 8443 one: collapsing onto it would
      // leave 8443 as the newest operation, and the agent's stale-revision
      // guard would then reject the reused command — the operator's last
      // request would never run. Release the key (the completion flow's own
      // rename) and let the upsert below create a fresh command with the
      // newly allocated revision instead.
      if (input.type === "ENSURE_INBOUND" && !input.dedupeKey) {
        const outstanding = await tx.nodeCommandJob.findUnique({ where: { dedupeKey } });
        if (outstanding) {
          // "Newer" by targetRevision, not createdAt: every created job
          // consumed its own increment of the node's monotonic counter, so
          // revisions are strictly ordered where timestamps can tie.
          const intervening = await tx.nodeCommandJob.findFirst({
            where: {
              nodeId,
              commandType: "ENSURE_INBOUND",
              targetRevision: { gt: outstanding.targetRevision },
            },
            select: { id: true },
          });
          if (intervening) {
            // Match on STILL HOLDING the base key rather than on a status: an
            // outstanding job may already be running (the agent picked it up
            // but has not reported), and a job that completed concurrently has
            // already released the key its own way (:done:) and must be left
            // alone — either way the base key ends up free for the fresh
            // command.
            await tx.nodeCommandJob.updateMany({
              where: { id: outstanding.id, dedupeKey },
              data: { dedupeKey: `${dedupeKey}:superseded:${outstanding.id}` },
            });
          }
        }
      }
      // An existing key means an idempotent REPLAY of an outstanding request
      // (the upsert's update was empty): nothing new is ordered, so it must
      // not resolve any exhausted failure — a replayed older command clearing
      // a newer retry-exhausted row would hide an unresolved failure. The
      // unique index still arbitrates concurrent same-key requests: the
      // loser of the create race re-reads the winner's row.
      const replayed = await tx.nodeCommandJob.findUnique({ where: { dedupeKey } });
      if (replayed) {
        return replayed;
      }
      // User commands carry their binding target in the payload: resolution
      // must scope to THAT binding (ordering ENSURE_USER for one user must not
      // clear other users' exhausted failures on the same node), and the new
      // row must carry the ownership columns the admin queue aggregates by.
      // A bindingId that does not belong to this node is rejected — otherwise
      // the command would act on another node's user.
      const payloadBindingId = typeof (payload as Record<string, unknown>).bindingId === "string"
        ? (payload as Record<string, unknown>).bindingId as string
        : null;
      let bindingTarget: { id: string; subscriptionId: string; userId: string | null; teamId: string | null } | null = null;
      if (payloadBindingId) {
        const binding = await tx.panelClientBinding.findUnique({
          where: { id: payloadBindingId },
          select: { id: true, nodeId: true, subscriptionId: true, userId: true, teamId: true }
        });
        if (!binding || binding.nodeId !== nodeId) {
          throw new BadRequestException("命令携带的用户绑定不属于该节点");
        }
        bindingTarget = binding;
      }
      // Exhausted (cancelled) failures resolve only under a genuinely NEW
      // order, and only with a scope the new command actually covers:
      // - a verified binding resolves that binding's exhausted rows;
      // - a payload with NO user-targeting field (ENSURE_INBOUND,
      //   RECONCILE_USERS, ...) resolves node+commandType-wide;
      // - a user command targeted by email/userKey WITHOUT a bindingId
      //   resolves NOTHING — node-wide would clear OTHER users' exhausted
      //   failures on the same node.
      // Only rows older than this new order can be resolved, which is
      // structural here — the replacement is being created now.
      if (bindingTarget) {
        await resolveExhaustedCommands(tx, {
          bindingId: bindingTarget.id,
          nodeId,
          commandType: input.type
        });
      } else if (!hasUserTargeting(payload)) {
        await resolveExhaustedCommands(tx, { nodeId, commandType: input.type });
      }
      return await tx.nodeCommandJob.create({
        data: {
          id: randomUUID(),
          dedupeKey,
          nodeId,
          agentId: agent.id,
          commandType: input.type,
          targetRevision,
          payload: payload as Prisma.InputJsonValue,
          ...(bindingTarget
            ? {
                bindingId: bindingTarget.id,
                subscriptionId: bindingTarget.subscriptionId,
                userId: bindingTarget.userId,
                teamId: bindingTarget.teamId
              }
            : {})
        }
      });
    }).catch(async (error: unknown) => {
      // PostgreSQL aborts the transaction on a uniqueness violation. Recover
      // only after rollback, so revision allocation and failure resolution
      // from the losing request cannot be committed as side effects of replay.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const replayed = await this.prisma.nodeCommandJob.findUnique({ where: { dedupeKey } });
        if (replayed) return replayed;
      }
      throw error;
    });
    const command = serializeCommand(job);
    if (job.agentId) this.events.publish(job.agentId, command);
    this.adminEvents?.publish({ type: "node_access_updated", nodeId, occurredAt: new Date().toISOString() });
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

function hasUserTargeting(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  return ["bindingId", "userKey", "email", "uuid"].some((key) => {
    const value = Reflect.get(payload, key);
    return typeof value === "string" && value.length > 0;
  });
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
