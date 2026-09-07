import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomBytes, randomUUID } from "node:crypto";
import type { AdminNodeRecordDto, CreateAgentNodeInputDto, CreateAgentNodeResultDto } from "@chordv/shared";
import { PrismaService } from "../common/prisma.service";
import { toAdminNodeRecord } from "../common/node-import.utils";
import { hashAgentToken } from "./agent.service";
import type { AgentRegisterDto, AgentRegisterResultDto } from "./agent.dto";

// A registration token's lifetime: generous enough for a slow VPS provision +
// install, short enough that a leaked command is a bounded window.
const REGISTER_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
// Registration is a single-flight, single-use operation per token; two racing
// register calls must not both mint credentials.
const MAX_REGISTER_ATTEMPTS = 3;

@Injectable()
export class AgentRegisterService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Agent-native node creation: descriptive fields only (name/region/tags),
   * NO connection parameters — those arrive from the agent itself once it
   * registers. The row is created directly in pending_register and a one-time
   * registration token is minted in the same transaction, so the admin UI can
   * render the install command immediately.
   */
  async createAgentNode(input: CreateAgentNodeInputDto): Promise<CreateAgentNodeResultDto> {
    if (!input.name?.trim()) throw new BadRequestException("节点名称不能为空");
    if (input.name.trim().length > 120) throw new BadRequestException("节点名称过长");
    const token = `chordv_register_${randomBytes(32).toString("base64url")}`;
    const { node, expiresAt } = await this.prisma.$transaction(async (tx) => {
      const row = await tx.node.create({
        data: {
          id: randomUUID(),
          name: input.name.trim(),
          countryCode: input.countryCode?.trim() || null,
          region: input.region?.trim() || "未指定",
          provider: input.provider?.trim() || "未指定",
          tags: input.tags ?? [],
          isActive: input.isActive ?? true,
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
          registrationStatus: "pending_register",
          panelEnabled: false
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

  /**
   * Issue a one-time registration token for a node and (re)start its
   * pending_register lifecycle. Revoking previous tokens and re-issuing is the
   * admin's "regenerate the install command" affordance, so it is allowed while
   * the node is still pending. Plaintext returns once, only to the admin UI —
   * only the hash is stored.
   */
  async issueRegisterToken(nodeId: string): Promise<{ token: string; expiresAt: Date }> {
    return this.prisma.$transaction(async (tx) => {
      const node = await tx.node.findUnique({
        where: { id: nodeId },
        select: { id: true, registrationStatus: true, nodeAgents: { where: { revokedAt: null }, select: { id: true } } }
      });
      if (!node) throw new NotFoundException("节点不存在");
      if (node.registrationStatus === "agent_ready") {
        throw new BadRequestException("该节点已完成 Agent 注册；如需更换凭据请先撤销现有 Agent");
      }
      if (node.nodeAgents.length > 0) {
        throw new BadRequestException("该节点存在历史 Agent 凭据，与 Agent 原生注册流程冲突");
      }
      // Invalidate any still-open tokens: only the newest install command works.
      await tx.agentRegisterToken.updateMany({
        where: { nodeId, usedAt: null },
        data: { usedAt: new Date() }
      });
      const token = `chordv_register_${randomBytes(32).toString("base64url")}`;
      const expiresAt = new Date(Date.now() + REGISTER_TOKEN_TTL_MS);
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
      return { token, expiresAt };
    });
  }

  /**
   * Exchange a one-time registration token for persistent agent credentials.
   * Single-use and expiry are enforced inside the serializable transaction, so
   * a replayed token (even racing the first use) cannot mint a second credential.
   */
  async register(input: AgentRegisterDto): Promise<AgentRegisterResultDto> {
    const tokenHash = hashAgentToken(input.registerToken);
    const agentToken = `chordv_agent_${randomBytes(32).toString("base64url")}`;
    const agentId = `agent-${randomBytes(8).toString("hex")}`;
    let nodeId: string | null = null;
    try {
      const result = await this.prisma.$transaction(
        async (tx) => {
          const record = await tx.agentRegisterToken.findUnique({ where: { tokenHash } });
          if (!record) throw new UnauthorizedException("注册令牌无效");
          if (record.usedAt) throw new UnauthorizedException("注册令牌已被使用");
          if (record.expiresAt.getTime() <= Date.now()) throw new UnauthorizedException("注册令牌已过期");
          const node = await tx.node.findUnique({
            where: { id: record.nodeId },
            select: { id: true, registrationStatus: true, nodeAgents: { where: { revokedAt: null }, select: { id: true } } }
          });
          if (!node) throw new UnauthorizedException("注册令牌对应的节点不存在");
          if (node.nodeAgents.length > 0) {
            throw new UnauthorizedException("该节点已存在有效 Agent，注册令牌不可复用");
          }
          const agent = await tx.nodeAgent.create({
            data: {
              id: randomUUID(),
              agentId,
              nodeId: node.id,
              tokenHash: hashAgentToken(agentToken),
              tokenPrefix: agentToken.slice(0, 20),
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
          await tx.node.update({
            where: { id: node.id },
            data: {
              registrationStatus: "agent_ready",
              agentLastSeenAt: new Date()
            }
          });
          return { agent, agentToken, node };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
      nodeId = result.node.id;
      return {
        accepted: true,
        agentId: result.agent.agentId,
        token: agentToken,
        nodeId: result.node.id
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" && MAX_REGISTER_ATTEMPTS > 1) {
        // Serialization conflict (a racing register on the same token): retry
        // once — the loser of the race will then see the token as used.
        return this.register(input);
      }
      throw error;
    }
  }

  /**
   * Resolve a registration token's node id WITHOUT validating it — for the
   * install-script route, which must render a script even for an exhausted
   * token so the operator sees a clear error instead of a bare 404.
   */
  async resolveTokenNode(token: string): Promise<{ nodeId: string; usable: boolean } | null> {
    if (!token || token.length > 128) return null;
    const record = await this.prisma.agentRegisterToken.findUnique({
      where: { tokenHash: hashAgentToken(token) },
      select: { nodeId: true, usedAt: true, expiresAt: true }
    });
    if (!record) return null;
    return {
      nodeId: record.nodeId,
      usable: !record.usedAt && record.expiresAt.getTime() > Date.now()
    };
  }
}
