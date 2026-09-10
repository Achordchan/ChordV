import { BadRequestException, Injectable, NotFoundException, Optional, UnauthorizedException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomBytes, randomUUID } from "node:crypto";
import type { AdminNodeRecordDto, CreateAgentNodeInputDto, CreateAgentNodeResultDto } from "@chordv/shared";
import { PrismaService } from "../common/prisma.service";
import { toAdminNodeRecord } from "../common/node-import.utils";
import { hashAgentToken } from "./agent.service";
import type { AgentRegisterDto, AgentRegisterResultDto } from "./agent.dto";
import { normalizePanelInbound } from "./panel-inbound";
import { AdminRuntimeEventsService } from "../common/admin-runtime-events.service";

// A registration token's lifetime: generous enough for a slow VPS provision +
// install, short enough that a leaked command is a bounded window.
const REGISTER_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
// Registration is a single-flight, single-use operation per token; two racing
// register calls must not both mint credentials.
const MAX_REGISTER_ATTEMPTS = 3;

@Injectable()
export class AgentRegisterService {
  constructor(private readonly prisma: PrismaService, @Optional() private readonly adminEvents?: AdminRuntimeEventsService) {}

  /**
   * Persist public imported parameters with the pending node and token. They
   * remain separate from usable connection fields until live validation passes.
   */
  async createAgentNode(input: CreateAgentNodeInputDto): Promise<CreateAgentNodeResultDto> {
    if (!input.name?.trim()) throw new BadRequestException("节点名称不能为空");
    if (input.name.trim().length > 120) throw new BadRequestException("节点名称过长");
    const spec = normalizePanelInbound(input.panelInbound ?? {});
    const token = `chordv_register_${randomBytes(32).toString("base64url")}`;
    const { node, expiresAt } = await this.prisma.$transaction(async (tx) => {
      const row = await tx.node.create({
        data: {
          id: randomUUID(),
          name: input.name.trim(),
          onboardingSpec: spec as unknown as Prisma.InputJsonValue,
          countryCode: input.countryCode?.trim() || null,
          region: input.region?.trim() || "未指定",
          provider: input.provider?.trim() || "未指定",
          tags: input.tags ?? [],
          // Inactive until the agent registers AND reports usable connection
          // parameters (R2's inbound deployment). Activation, availability and
          // assignment also enforce the shared onboarding/endpoint invariant.
          isActive: false,
          recommended: input.recommended ?? false,
          // Connection parameters are unknown until the agent reports them;
          // placeholder values keep NOT NULL columns satisfied without
          // implying a usable node (registrationStatus gates that).
          protocol: "vless",
          security: "reality",
          serverHost: "pending-agent",
          serverPort: 0,
          uuid: randomUUID(),
          flow: "",
          realityPublicKey: "",
          shortId: "",
          serverName: "",
          fingerprint: "chrome",
          spiderX: "/",
          mldsa65Verify: "",
          latencyMs: 0,
          controlMode: "direct_primary",
          controlStatus: "pending_register",
          registrationStatus: "pending_register"
        }
      });
      const expiresAt = new Date(Date.now() + REGISTER_TOKEN_TTL_MS);
      await tx.agentRegisterToken.create({
        data: {
          id: randomUUID(),
          nodeId: row.id,
          tokenHash: hashAgentToken(token),
          tokenPrefix: token.slice(0, 24),
          expiresAt
        }
      });
      return { node: row, expiresAt };
    });
    return {
      node: toAdminNodeRecord(node),
      registerToken: token,
      registerTokenExpiresAt: expiresAt.toISOString()
    };
  }

  requireOnboardingSpec(): never {
    throw new BadRequestException("该待接入节点没有面板入站参数，请删除此未接入节点后重新添加并导入链接");
  }

  async getOnboarding(nodeId: string) {
    // The job and applied revision must come from one snapshot. A completion
    // between two independent reads would otherwise look like a stale failure.
    const { node, job } = await this.prisma.$transaction(async tx => {
      const node = await tx.node.findUnique({ where: { id: nodeId },
        include: { nodeAgents: { where: { revokedAt: null }, orderBy: { createdAt: "desc" }, take: 1 } } });
      if (!node) throw new NotFoundException("节点不存在");
      const job = await tx.nodeCommandJob.findFirst({
        where: { nodeId, commandType: "ENSURE_INBOUND" }, orderBy: { targetRevision: "desc" },
        select: { id: true, status: true, lastError: true, targetRevision: true, payload: true }
      });
      return { node, job };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    const candidate = job?.payload ?? node.onboardingSpec;
    const panelMode = candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
      && candidate.mode === "validate_panel";
    return {
      node: toAdminNodeRecord(node),
      mode: panelMode ? "panel" as const : "legacy" as const,
      spec: panelMode ? normalizePanelInbound(candidate as Record<string, unknown>) : null,
      command: job ? { id: job.id, status: job.status, lastError: job.lastError, targetRevision: job.targetRevision.toString() } : null
    };
  }

  /**
   * Issue a one-time registration token for a node and (re)start its
   * pending_register lifecycle. Revoking previous tokens and re-issuing is the
   * admin's "regenerate the install command" affordance, so it is allowed while
   * the node is still pending. Plaintext returns once, only to the admin UI —
   * only the hash is stored.
   *
   * ONLY pending_register nodes qualify: a null registrationStatus marks a
   * legacy (xui) node, and converting it here would silently mix a native
   * agent into a legacy node's lifecycle. agent_ready nodes must go through
   * credential revocation first. Serializable isolation re-checks the node
   * inside the transaction, so a register commit racing this mint cannot be
   * overwritten back to pending_register.
   */
  async issueRegisterToken(nodeId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = `chordv_register_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + REGISTER_TOKEN_TTL_MS);
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.issueRegisterTokenOnce(nodeId, token, expiresAt);
        return { token, expiresAt };
      } catch (error) {
        if (
          attempt < MAX_REGISTER_ATTEMPTS &&
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2034"
        ) {
          await delay(25 * attempt);
          continue;
        }
        throw error;
      }
    }
  }

  private async issueRegisterTokenOnce(nodeId: string, token: string, expiresAt: Date): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        const node = await tx.node.findUnique({
          where: { id: nodeId },
          select: { id: true, registrationStatus: true, nodeAgents: { where: { revokedAt: null }, select: { id: true } } }
        });
        if (!node) throw new NotFoundException("节点不存在");
        if (node.registrationStatus !== "pending_register") {
          throw new BadRequestException("仅待注册（pending_register）节点可生成注册令牌");
        }
        if (node.nodeAgents.length > 0) {
          throw new BadRequestException("该节点存在历史 Agent 凭据，与 Agent 原生注册流程冲突");
        }
        // Invalidate any still-open tokens: only the newest install command works.
        await tx.agentRegisterToken.updateMany({
          where: { nodeId, usedAt: null },
          data: { usedAt: new Date() }
        });
        await tx.agentRegisterToken.create({
          data: {
            id: randomUUID(),
            nodeId,
            tokenHash: hashAgentToken(token),
            tokenPrefix: token.slice(0, 24),
            expiresAt
          }
        });
        await tx.node.update({
          where: { id: nodeId },
          data: { registrationStatus: "pending_register" }
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  /**
   * Exchange a one-time registration token for persistent agent credentials.
   * Single-use and expiry are enforced inside the serializable transaction, so
   * a replayed token (even racing the first use) cannot mint a second credential.
   */
  async register(input: AgentRegisterDto): Promise<AgentRegisterResultDto> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.registerOnce(input);
      } catch (error) {
        // A racing register/token-regen on the same rows (P2034) resolves itself
        // on retry: the loser sees the token consumed or the node state moved.
        // Bounded — a persistent serialization failure must not loop forever.
        if (
          attempt < MAX_REGISTER_ATTEMPTS &&
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2034"
        ) {
          await delay(25 * attempt);
          continue;
        }
        throw error;
      }
    }
  }

  private async registerOnce(input: AgentRegisterDto): Promise<AgentRegisterResultDto> {
    const tokenHash = hashAgentToken(input.registerToken);
    const agentTokenHash = hashAgentToken(input.agentToken);
    const agentId = `agent-${randomBytes(8).toString("hex")}`;
    const result = await this.prisma.$transaction(
        async (tx) => {
          const record = await tx.agentRegisterToken.findUnique({ where: { tokenHash } });
          if (!record) throw new UnauthorizedException("注册令牌无效");
          const node = await tx.node.findUnique({
            where: { id: record.nodeId },
            select: { id: true, registrationStatus: true, onboardingSpec: true, nodeAgents: { where: { revokedAt: null }, select: { id: true, agentId: true, tokenHash: true } } }
          });
          if (!node) throw new UnauthorizedException("注册令牌对应的节点不存在");
          // `NodeAgent.tokenHash` is globally unique, so two agents can never
          // share a hash — but without this check a client reusing its secret
          // for a second node would hit a raw unique-violation 500. Reject it
          // explicitly, before the replay branch, so a hash already bound
          // elsewhere can neither register nor replay here. Serializable
          // isolation makes the read-then-insert safe against a concurrent
          // registration of the same secret on another node.
          const boundElsewhere = await tx.nodeAgent.findFirst({
            where: { tokenHash: agentTokenHash, nodeId: { not: node.id } },
            select: { id: true }
          });
          if (boundElsewhere) throw new UnauthorizedException("Agent 凭据已绑定其他节点，不能跨节点复用");
          const existing = node.nodeAgents.find((agent) => agent.tokenHash === agentTokenHash);
          if (record.usedAt && existing) {
            // Replay proves possession of the already-issued live credential. It
            // only returns existing IDs, including after the registration TTL.
            return { agent: { agentId: existing.agentId }, replay: true as const, node };
          }
          if (record.expiresAt.getTime() <= Date.now()) throw new UnauthorizedException("注册令牌已过期");
          if (node.nodeAgents.length > 0) {
            throw new UnauthorizedException("该节点已存在有效 Agent，注册令牌不可复用");
          }
          if (record.usedAt) {
            // Token consumed but the node has NO live agent: the registered
            // credential was revoked/lost, not retried. Dead end by design —
            // regeneration is only offered for pending nodes.
            throw new UnauthorizedException("注册令牌已被使用");
          }
          if (node.registrationStatus !== "pending_register") {
            throw new UnauthorizedException("节点不处于待注册状态，不能签发 Agent 凭据");
          }
          let spec = node.onboardingSpec ? normalizePanelInbound(node.onboardingSpec as Record<string, unknown>) : null;
          if (spec && !input.agentVersion.startsWith("go-")) {
            throw new BadRequestException("此节点需要 Go agent，不能使用旧 Node 安装器注册");
          }
          if (spec) {
            if (!input.xrayInboundTag || !/^[A-Za-z0-9_-]{1,32}$/.test(input.xrayInboundTag)) {
              throw new BadRequestException("缺少安装器核实的实际入站 tag，请使用新版 Go 接入命令");
            }
            if (spec.tagOverrideConfirmed && spec.inboundTag !== input.xrayInboundTag) {
              throw new BadRequestException("Agent 实际 tag 与手工确认的目标不一致");
            }
            // Automatic matching is confirmed by the installer's live probe;
            // freeze that exact tag for all subsequent validation and retries.
            spec = { ...spec, inboundTag: input.xrayInboundTag, tagOverrideConfirmed: true };
          }
          const agent = await tx.nodeAgent.create({
            data: {
              id: randomUUID(),
              agentId,
              nodeId: node.id,
              tokenHash: agentTokenHash,
              tokenPrefix: input.agentToken.slice(0, 20),
              version: input.agentVersion,
              bootId: input.bootId,
              status: "online",
              lastSeenAt: new Date()
            }
          });
          await tx.agentRegisterToken.update({
            where: { id: record.id },
            data: { usedAt: new Date() }
          });
          const registered = await tx.node.update({
            where: { id: node.id },
            data: {
              registrationStatus: "agent_ready",
              ...(spec ? { agentConfigRevision: { increment: 1n }, onboardingSpec: spec as unknown as Prisma.InputJsonValue } : {}),
              agentLastSeenAt: new Date()
            }
          });
          // Identity and initial validation are committed together. Replayed
          // registration returns above, so it cannot enqueue a duplicate job.
          // The agent's existing SSE backlog delivers this after its first connect.
          if (spec) await tx.nodeCommandJob.create({ data: {
            id: randomUUID(), nodeId: node.id, agentId: agent.id,
            commandType: "ENSURE_INBOUND", targetRevision: registered.agentConfigRevision,
            dedupeKey: `onboarding:${node.id}`, payload: spec as unknown as Prisma.InputJsonValue
          } });
          return { agent, replay: false as const, node };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    this.adminEvents?.publish({ type: "node_access_updated", nodeId: result.node.id, occurredAt: new Date().toISOString() });
    return {
      accepted: true,
      agentId: result.agent.agentId,
      // The agent already holds this client-generated secret. Only its hash is
      // stored; the response returns identity fields rather than echoing it.
      nodeId: result.node.id
    };
  }

  /**
   * Resolve a registration token's node id WITHOUT validating it — for the
   * install-script route, which must render a script even for an exhausted
   * token so the operator sees a clear error instead of a bare 404.
   */
  async resolveTokenNode(token: string) {
    if (!token || token.length > 128) return null;
    const record = await this.prisma.agentRegisterToken.findUnique({
      where: { tokenHash: hashAgentToken(token) },
      select: { nodeId: true, usedAt: true, expiresAt: true, node: { select: { onboardingSpec: true, registrationStatus: true } } }
    });
    if (!record) return null;
    return {
      nodeId: record.nodeId,
      usable: !record.usedAt && record.expiresAt.getTime() > Date.now(),
      spec: record.node?.onboardingSpec ? normalizePanelInbound(record.node.onboardingSpec as Record<string, unknown>) : null
    };
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
