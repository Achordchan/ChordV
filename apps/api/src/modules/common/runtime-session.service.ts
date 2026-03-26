import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { Cron } from "@nestjs/schedule";
import { randomUUID } from "node:crypto";
import type {
  ConnectRequestDto,
  GeneratedRuntimeConfigDto,
  TeamMemberRole,
  TeamStatus,
  UserProfileDto
} from "@chordv/shared";
import { METERING_REASON_NODE_UNAVAILABLE } from "./metering.constants";
import { AuthSessionService } from "./auth-session.service";
import { ClientRuntimeEventsService } from "./client-runtime-events.service";
import { MeteringIncidentService } from "./metering-incident.service";
import { PrismaService } from "./prisma.service";
import {
  assertSubscriptionConnectable,
  buildLeaseDiagnosticFields,
  buildLeaseEmail,
  buildPanelClientEmail,
  buildSnapshotKey,
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  getLeaseHardExpireCutoff,
  getLeaseFailureDetails,
  isLeaseHardExpired,
  LEASE_GRACE_SECONDS,
  LEASE_HEARTBEAT_INTERVAL_SECONDS,
  LEASE_TTL_SECONDS,
  type PanelBindingFailure,
  type PanelBindingMutationResult,
  SECURITY_REASON_CONCURRENCY,
  shouldDeletePanelClients,
  shouldProvisionPanelClients,
  toClientRuntimeEventType
} from "./runtime-session.utils";
import { pickCurrentSubscription } from "./subscription.utils";
import { EdgeGatewayService } from "../edge-gateway/edge-gateway.service";
import { XuiService } from "../xui/xui.service";

type ResolvedSubscriptionAccess = {
  subscription: {
    id: string;
    userId: string | null;
    teamId: string | null;
    expireAt: Date;
    state: "active" | "expired" | "exhausted" | "paused";
    remainingTrafficGb: number;
    plan: {
      maxConcurrentSessions: number;
    };
    user?: { status: "active" | "disabled" } | null;
    team?: { status: TeamStatus } | null;
  } | null;
  team: {
    id: string;
    name: string;
    status: TeamStatus;
  } | null;
  memberRole: TeamMemberRole | null;
  memberUsedTrafficGb: number | null;
};

type ActiveRuntimeUsageContext = {
  subscriptionId: string;
  nodeId: string;
  userId: string;
  teamId: string | null;
};

@Injectable()
export class RuntimeSessionService {
  private readonly logger = new Logger(RuntimeSessionService.name);
  private activeRuntime?: GeneratedRuntimeConfigDto;
  private activeRuntimeUsageContext?: ActiveRuntimeUsageContext;
  private readonly userLeaseLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly meteringIncidentService: MeteringIncidentService,
    private readonly authSessionService: AuthSessionService,
    private readonly clientRuntimeEventsService: ClientRuntimeEventsService,
    private readonly moduleRef: ModuleRef,
    private readonly xuiService: XuiService
  ) {}

  private async runWithUserLeaseLock<T>(userId: string, task: () => Promise<T>) {
    const previous = this.userLeaseLocks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slot = previous.finally(() => undefined).then(() => current);
    this.userLeaseLocks.set(userId, slot);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.userLeaseLocks.get(userId) === slot) {
        this.userLeaseLocks.delete(userId);
      }
    }
  }

  private getEdgeGatewayService() {
    return this.moduleRef.get(EdgeGatewayService, { strict: false });
  }

  private logLeaseWarning(
    message: string,
    lease: {
      sessionId: string;
      status: string;
      lastHeartbeatAt: Date;
      expiresAt: Date;
      revokedReason?: string | null;
    },
    extra?: Record<string, string | null>
  ) {
    this.logger.warn(
      `${message} ${JSON.stringify({
        ...buildLeaseDiagnosticFields(lease),
        ...extra
      })}`
    );
  }

  async connect(request: ConnectRequestDto, token?: string): Promise<GeneratedRuntimeConfigDto> {
    const node = await this.prisma.node.findUnique({
      where: { id: request.nodeId }
    });

    if (!node) {
      throw new NotFoundException("节点不存在");
    }

    const user = await this.resolveActiveUserFromToken(token);
    return this.runWithUserLeaseLock(user.id, async () => {
      const access = await this.resolveSubscriptionAccessForUser(user.id);
      if (!access.subscription) {
        throw new NotFoundException("当前没有可用订阅");
      }

      assertSubscriptionConnectable(access.subscription);

      const policy = await this.prisma.policyProfile.findUnique({
        where: { id: "default" }
      });
      if (!policy) {
        throw new NotFoundException("策略配置不存在");
      }

      const allowedRows = await this.prisma.subscriptionNodeAccess.findMany({
        where: {
          subscriptionId: access.subscription.id,
          nodeId: request.nodeId
        }
      });
      if (allowedRows.length === 0) {
        throw new ForbiddenException("当前节点已被取消授权");
      }

      const userSecurity = await this.prisma.user.findUnique({
        where: { id: user.id },
        select: { maxConcurrentSessionsOverride: true }
      });
      const concurrentLimit = Math.max(
        1,
        userSecurity?.maxConcurrentSessionsOverride ??
          access.subscription.plan.maxConcurrentSessions ??
          DEFAULT_MAX_CONCURRENT_SESSIONS
      );
      await this.evictExceededUserLeases(user.id, concurrentLimit);

      if (policy.accessMode === "xui") {
        return this.connectWithXui(node, user, access, request, policy);
      }
      if (policy.accessMode !== "relay") {
        throw new BadRequestException("当前接入模式未启用");
      }

      const now = new Date();
      const sessionId = `session_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
      const leaseId = createId("lease");
      const xrayUserEmail = buildLeaseEmail(user.id, leaseId);
      const xrayUserUuid = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + LEASE_TTL_SECONDS * 1000);

      await this.prisma.nodeSessionLease.create({
        data: {
          id: leaseId,
          sessionId,
          accessMode: "relay",
          userId: user.id,
          subscriptionId: access.subscription.id,
          nodeId: node.id,
          xrayUserEmail,
          xrayUserUuid,
          status: "active",
          issuedAt: now,
          expiresAt: leaseExpiresAt,
          lastHeartbeatAt: now
        }
      });

      try {
        await this.getEdgeGatewayService().openSession({
          sessionId,
          leaseId,
          subscriptionId: access.subscription.id,
          userId: user.id,
          xrayUserEmail,
          xrayUserUuid,
          expiresAt: leaseExpiresAt.toISOString(),
          node: {
            nodeId: node.id,
            serverHost: node.serverHost,
            serverPort: node.serverPort,
            uuid: node.uuid,
            flow: node.flow,
            realityPublicKey: node.realityPublicKey,
            shortId: node.shortId,
            serverName: node.serverName,
            fingerprint: node.fingerprint,
            spiderX: node.spiderX
          }
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "下发临时租约失败";
        await this.prisma.nodeSessionLease.update({
          where: { id: leaseId },
          data: {
            status: "revoked",
            revokedAt: new Date(),
            revokedReason: "edge_open_failed"
          }
        });
        await this.prisma.securityEvent.create({
          data: {
            id: createId("security"),
            type: "relay_open_failed",
            userId: user.id,
            subscriptionId: access.subscription.id,
            nodeId: node.id,
            leaseId,
            detail
          }
        });
        await this.getEdgeGatewayService().markNodeUnavailable(node.id, detail);
        throw new BadRequestException(`中心中转会话创建失败：${detail}`);
      }

      const edgeConfig = this.getEdgeGatewayService().getPublicRuntimeConfig();
      this.activeRuntime = {
        sessionId,
        leaseId,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        leaseHeartbeatIntervalSeconds: LEASE_HEARTBEAT_INTERVAL_SECONDS,
        leaseGraceSeconds: LEASE_GRACE_SECONDS,
        node: toNodeSummary(node),
        mode: request.mode,
        localHttpPort: 17890,
        localSocksPort: 17891,
        routingProfile: request.strategyGroupId ?? "managed-rule-default",
        generatedAt: new Date().toISOString(),
        features: {
          blockAds: policy.blockAds,
          chinaDirect: policy.chinaDirect,
          aiServicesProxy: policy.aiServicesProxy
        },
        outbound: {
          protocol: "vless",
          server: edgeConfig.server,
          port: edgeConfig.port,
          uuid: xrayUserUuid,
          flow: edgeConfig.flow,
          realityPublicKey: edgeConfig.realityPublicKey,
          shortId: edgeConfig.shortId,
          serverName: edgeConfig.serverName,
          fingerprint: edgeConfig.fingerprint,
          spiderX: edgeConfig.spiderX
        }
      };
      this.activeRuntimeUsageContext = {
        subscriptionId: access.subscription.id,
        nodeId: node.id,
        userId: user.id,
        teamId: access.subscription.teamId
      };

      await this.meteringIncidentService.resolve(access.subscription.id, node.id, METERING_REASON_NODE_UNAVAILABLE);
      return this.activeRuntime;
    });
  }

  async heartbeatSession(sessionId: string, token?: string) {
    const user = await this.resolveActiveUserFromToken(token);
    const lease = await this.prisma.nodeSessionLease.findUnique({
      where: { sessionId },
      include: {
        node: true
      }
    });

    if (!lease || lease.userId !== user.id) {
      if (lease) {
        this.logLeaseWarning("会话心跳失败：会话归属不匹配", lease, {
          reason: "subscription_owner_mismatch"
        });
      }
      throw new NotFoundException("当前连接已失效，请重新连接");
    }
    if (lease.status !== "active") {
      this.logLeaseWarning("会话心跳失败：租约状态不可续租", lease, {
        reason: lease.revokedReason ?? "lease_not_active"
      });
      throw new ForbiddenException(getLeaseFailureDetails(lease.status, lease.revokedReason).reasonMessage);
    }

    const now = new Date();
    if (isLeaseHardExpired(lease.expiresAt, now)) {
      await this.revokeLease(lease.id, lease.node, "lease_expired");
      this.logLeaseWarning(
        "会话心跳失败：租约已超过宽限期",
        {
          ...lease,
          status: "revoked",
          revokedReason: "lease_expired"
        },
        {
          reason: "lease_expired"
        }
      );
      throw new ForbiddenException("会话已过期");
    }

    await this.assertLeaseCanHeartbeat(lease, user.id);

    const nextExpiresAt = new Date(now.getTime() + LEASE_TTL_SECONDS * 1000);
    if (lease.accessMode === "xui") {
      const renewed = await this.prisma.nodeSessionLease.updateMany({
        where: {
          id: lease.id,
          userId: user.id,
          status: "active"
        },
        data: {
          status: "active",
          expiresAt: nextExpiresAt,
          lastHeartbeatAt: now,
          revokedAt: null,
          revokedReason: null
        }
      });
      if (renewed.count === 0) {
        throw new ForbiddenException("当前连接已失效，请重新连接");
      }
      this.refreshActiveRuntimeLease(sessionId, nextExpiresAt);
      return {
        sessionId,
        status: "active" as const,
        leaseExpiresAt: nextExpiresAt.toISOString(),
        evictedReason: null,
        reasonCode: null,
        reasonMessage: null,
        detailReason: null
      };
    }

    try {
      await this.getEdgeGatewayService().openSession({
        sessionId: lease.sessionId,
        leaseId: lease.id,
        subscriptionId: lease.subscriptionId,
        userId: lease.userId,
        xrayUserEmail: lease.xrayUserEmail,
        xrayUserUuid: lease.xrayUserUuid,
        expiresAt: nextExpiresAt.toISOString(),
        node: {
          nodeId: lease.node.id,
          serverHost: lease.node.serverHost,
          serverPort: lease.node.serverPort,
          uuid: lease.node.uuid,
          flow: lease.node.flow,
          realityPublicKey: lease.node.realityPublicKey,
          shortId: lease.node.shortId,
          serverName: lease.node.serverName,
          fingerprint: lease.node.fingerprint,
          spiderX: lease.node.spiderX
        }
      });
      const renewed = await this.prisma.nodeSessionLease.updateMany({
        where: {
          id: lease.id,
          userId: user.id,
          status: "active"
        },
        data: {
          status: "active",
          expiresAt: nextExpiresAt,
          lastHeartbeatAt: now,
          revokedAt: null,
          revokedReason: null
        }
      });
      if (renewed.count === 0) {
        await this.getEdgeGatewayService().closeSession({
          sessionId: lease.sessionId,
          leaseId: lease.id,
          nodeId: lease.nodeId
        }).catch(() => null);
        throw new ForbiddenException("当前连接已失效，请重新连接");
      }
      this.refreshActiveRuntimeLease(sessionId, nextExpiresAt);
    } catch (error) {
      await this.revokeLease(lease.id, lease.node, "lease_renew_failed");
      this.logLeaseWarning(
        "会话心跳失败：续租下发失败",
        {
          ...lease,
          status: "revoked",
          revokedReason: "lease_renew_failed"
        },
        {
          reason: "lease_renew_failed",
          error: error instanceof Error ? error.message : "未知错误"
        }
      );
      await this.getEdgeGatewayService().markNodeUnavailable(
        lease.nodeId,
        error instanceof Error ? error.message : "未知错误"
      );
      throw new ForbiddenException(`会话续租失败：${error instanceof Error ? error.message : "未知错误"}`);
    }

    return {
      sessionId,
      status: "active" as const,
      leaseExpiresAt: nextExpiresAt.toISOString(),
      evictedReason: null,
      reasonCode: null,
      reasonMessage: null,
      detailReason: null
    };
  }

  async disconnect(sessionId: string, token?: string) {
    const user = await this.resolveActiveUserFromToken(token);
    const lease = await this.prisma.nodeSessionLease.findUnique({
      where: { sessionId },
      include: {
        node: true
      }
    });

    if (lease && lease.userId === user.id && lease.status === "active") {
      await this.revokeLease(lease.id, lease.node, "revoked_by_client");
    }

    const previous = this.activeRuntime;
    this.clearActiveRuntime(sessionId);
    return { ok: true, previousSessionId: previous?.sessionId ?? null };
  }

  async getActiveRuntime(sessionId?: string, token?: string) {
    const user = await this.resolveActiveUserFromToken(token);
    const lease = await this.prisma.nodeSessionLease.findFirst({
      where: {
        userId: user.id,
        status: "active",
        ...(sessionId ? { sessionId } : {})
      },
      include: {
        node: true
      },
      orderBy: {
        updatedAt: "desc"
      }
    });

    if (!lease) {
      return null;
    }
    if (isLeaseHardExpired(lease.expiresAt, new Date())) {
      this.clearActiveRuntime(lease.sessionId);
      return null;
    }

    const runtime = this.activeRuntime;
    const usageContext = this.activeRuntimeUsageContext;
    if (runtime && usageContext?.userId === user.id && runtime.sessionId === lease.sessionId) {
      return runtime;
    }

    if (lease.accessMode !== "xui") {
      return null;
    }

    const policy = await this.prisma.policyProfile.findUnique({
      where: { id: "default" }
    });

    return buildXuiRuntimeFromLease(lease, policy);
  }

  getActiveRuntimeUsageContext() {
    return this.activeRuntimeUsageContext ?? null;
  }

  private refreshActiveRuntimeLease(sessionId: string, leaseExpiresAt: Date) {
    if (!this.activeRuntime || this.activeRuntime.sessionId !== sessionId) {
      return;
    }
    this.activeRuntime = {
      ...this.activeRuntime,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
      generatedAt: new Date().toISOString()
    };
  }

  private clearActiveRuntime(sessionId?: string) {
    if (!sessionId || this.activeRuntime?.sessionId === sessionId) {
      this.activeRuntime = undefined;
      this.activeRuntimeUsageContext = undefined;
    }
  }

  async syncSubscriptionPanelAccess(subscriptionId: string) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        user: true,
        team: {
          include: {
            members: {
              include: {
                user: true
              }
            }
          }
        },
        nodeAccesses: {
          include: {
            node: true
          }
        }
      }
    });

    if (!subscription) {
      return;
    }

    const allowedNodeIds = new Set(subscription.nodeAccesses.map((item) => item.nodeId));
    const bindings = await this.prisma.panelClientBinding.findMany({
      where: {
        subscriptionId
      }
    });
    const activeTeamMemberIds =
      subscription.teamId && subscription.team
        ? new Set(subscription.team.members.filter((item) => item.user.status === "active").map((item) => item.userId))
        : null;
    const shouldProvision = shouldProvisionPanelClients(subscription);
    const shouldDeleteAll = shouldDeletePanelClients(subscription);

    if (shouldDeleteAll) {
      const removeResult = await this.removePanelBindingsForSubscription(subscriptionId);
      this.assertPanelBindingMutation("删除 3x-ui 客户端失败", removeResult);
      return;
    }

    for (const binding of bindings) {
      const invalidByNode = !allowedNodeIds.has(binding.nodeId);
      const invalidByUser = activeTeamMemberIds ? !activeTeamMemberIds.has(binding.userId ?? "") : false;
      if (invalidByUser) {
        await this.revokeSubscriptionLeases(subscriptionId, "team_member_removed", {
          userId: binding.userId ?? undefined,
          nodeIds: [binding.nodeId]
        });
        const removeResult = await this.removePanelBindingsForSubscription(subscriptionId, {
          userId: binding.userId ?? undefined,
          nodeIds: [binding.nodeId]
        });
        this.assertPanelBindingMutation("删除 3x-ui 客户端失败", removeResult);
        continue;
      }
      if (invalidByNode || !shouldProvision) {
        await this.revokeSubscriptionLeases(
          subscriptionId,
          invalidByNode ? "node_access_revoked" : "subscription_inactive",
          {
            userId: binding.userId ?? undefined,
            nodeIds: [binding.nodeId]
          }
        );
        const disableResult = await this.disablePanelBindingsForSubscription(subscriptionId, {
          userId: binding.userId ?? undefined,
          nodeIds: [binding.nodeId]
        });
        this.assertPanelBindingMutation("禁用 3x-ui 客户端失败", disableResult);
      }
    }

    if (!shouldProvision) {
      return;
    }

    const targets =
      subscription.teamId && subscription.team
        ? subscription.team.members
            .filter((item) => item.user.status === "active")
            .map((item) => ({
              userId: item.userId,
              userEmail: item.user.email,
              userDisplayName: item.user.displayName,
              teamId: subscription.teamId
            }))
        : subscription.user && subscription.user.status === "active"
          ? [
              {
                userId: subscription.user.id,
                userEmail: subscription.user.email,
                userDisplayName: subscription.user.displayName,
                teamId: null
              }
            ]
          : [];

    for (const target of targets) {
      for (const access of subscription.nodeAccesses) {
        if (!access.node.panelEnabled) {
          continue;
        }
        await this.ensurePanelClientBinding({
          node: {
            id: access.node.id,
            name: access.node.name,
            flow: access.node.flow,
            panelBaseUrl: access.node.panelBaseUrl,
            panelApiBasePath: access.node.panelApiBasePath,
            panelUsername: access.node.panelUsername,
            panelPassword: access.node.panelPassword,
            panelInboundId: access.node.panelInboundId,
            panelEnabled: access.node.panelEnabled
          },
          subscriptionId,
          userId: target.userId,
          teamId: target.teamId,
          userEmail: target.userEmail,
          userDisplayName: target.userDisplayName,
          expireAt: subscription.expireAt
        });
      }
    }
  }

  async revokeUserLeases(
    userId: string,
    reason: string,
    filter?: { subscriptionId?: string; nodeIds?: string[] }
  ) {
    const graceWindowStart = new Date(Date.now() - LEASE_GRACE_SECONDS * 1000);
    const activeLeases = await this.prisma.nodeSessionLease.findMany({
      where: {
        userId,
        status: "active",
        expiresAt: { gt: graceWindowStart },
        ...(filter?.subscriptionId ? { subscriptionId: filter.subscriptionId } : {}),
        ...(filter?.nodeIds ? { nodeId: { in: filter.nodeIds } } : {})
      },
      include: {
        node: {
          select: {
            id: true,
            flow: true
          }
        }
      }
    });

    for (const lease of activeLeases) {
      await this.revokeLease(lease.id, lease.node, reason);
    }

    return activeLeases.length;
  }

  async revokeSubscriptionLeases(
    subscriptionId: string,
    reason: string,
    filter?: { userId?: string; nodeIds?: string[] }
  ) {
    const graceWindowStart = new Date(Date.now() - LEASE_GRACE_SECONDS * 1000);
    const activeLeases = await this.prisma.nodeSessionLease.findMany({
      where: {
        subscriptionId,
        status: "active",
        expiresAt: { gt: graceWindowStart },
        ...(filter?.userId ? { userId: filter.userId } : {}),
        ...(filter?.nodeIds ? { nodeId: { in: filter.nodeIds } } : {})
      },
      include: {
        node: {
          select: {
            id: true,
            flow: true
          }
        }
      }
    });

    for (const lease of activeLeases) {
      await this.revokeLease(lease.id, lease.node, reason);
    }

    return activeLeases.length;
  }

  async disablePanelBindingsForSubscription(
    subscriptionId: string,
    filter?: { userId?: string; nodeIds?: string[] }
  ): Promise<PanelBindingMutationResult> {
    const bindings = await this.prisma.panelClientBinding.findMany({
      where: {
        subscriptionId,
        ...(filter?.userId ? { userId: filter.userId } : {}),
        ...(filter?.nodeIds ? { nodeId: { in: filter.nodeIds } } : {}),
        status: "active"
      },
      include: {
        node: true
      }
    });

    const failed: PanelBindingFailure[] = [];
    for (const binding of bindings) {
      try {
        await this.xuiService.setClientEnabled(
          {
            id: binding.node.id,
            panelBaseUrl: binding.node.panelBaseUrl,
            panelApiBasePath: binding.node.panelApiBasePath,
            panelUsername: binding.node.panelUsername,
            panelPassword: binding.node.panelPassword,
            panelInboundId: binding.node.panelInboundId
          },
          binding.panelClientId,
          binding.panelClientEmail,
          false
        );
      } catch (error) {
        await this.prisma.node.update({
          where: { id: binding.nodeId },
          data: {
            panelStatus: "degraded",
            panelError: error instanceof Error ? error.message : "禁用 3x-ui 客户端失败"
          }
        });
        failed.push({
          bindingId: binding.id,
          nodeId: binding.nodeId,
          nodeName: binding.node.name,
          panelClientEmail: binding.panelClientEmail,
          error: error instanceof Error ? error.message : "禁用 3x-ui 客户端失败"
        });
        continue;
      }

      await this.prisma.panelClientBinding.update({
        where: { id: binding.id },
        data: {
          status: "disabled"
        }
      });
    }

    return {
      requested: bindings.length,
      updated: bindings.length - failed.length,
      failed
    };
  }

  async removePanelBindingsForSubscription(
    subscriptionId: string,
    filter?: { userId?: string; nodeIds?: string[] }
  ): Promise<PanelBindingMutationResult> {
    const bindings = await this.prisma.panelClientBinding.findMany({
      where: {
        subscriptionId,
        ...(filter?.userId ? { userId: filter.userId } : {}),
        ...(filter?.nodeIds ? { nodeId: { in: filter.nodeIds } } : {}),
        status: { in: ["active", "disabled"] }
      },
      include: {
        node: true
      }
    });

    const failed: PanelBindingFailure[] = [];
    for (const binding of bindings) {
      try {
        await this.xuiService.removeClient(
          {
            id: binding.node.id,
            panelBaseUrl: binding.node.panelBaseUrl,
            panelApiBasePath: binding.node.panelApiBasePath,
            panelUsername: binding.node.panelUsername,
            panelPassword: binding.node.panelPassword,
            panelInboundId: binding.node.panelInboundId
          },
          binding.panelClientId,
          binding.panelClientEmail
        );
      } catch (error) {
        await this.prisma.node.update({
          where: { id: binding.nodeId },
          data: {
            panelStatus: "degraded",
            panelError: error instanceof Error ? error.message : "删除 3x-ui 客户端失败"
          }
        });
        failed.push({
          bindingId: binding.id,
          nodeId: binding.nodeId,
          nodeName: binding.node.name,
          panelClientEmail: binding.panelClientEmail,
          error: error instanceof Error ? error.message : "删除 3x-ui 客户端失败"
        });
        continue;
      }

      await this.prisma.trafficSnapshot.deleteMany({
        where: {
          snapshotKey: buildSnapshotKey(binding.nodeId, binding.subscriptionId, binding.userId)
        }
      });

      await this.prisma.panelClientBinding.update({
        where: { id: binding.id },
        data: {
          status: "deleted"
        }
      });
    }

    return {
      requested: bindings.length,
      updated: bindings.length - failed.length,
      failed
    };
  }

  assertPanelBindingMutation(action: string, result: PanelBindingMutationResult) {
    if (result.failed.length === 0) {
      return;
    }
    const detail = result.failed
      .map((item) => `${item.nodeName} / ${item.panelClientEmail}: ${item.error}`)
      .join("；");
    throw new BadGatewayException(`${action}。以下节点未完成同步：${detail}`);
  }

  async syncActiveLeasesForSubscription(subscription: {
    id: string;
    state: "active" | "expired" | "exhausted" | "paused";
    remainingTrafficGb: number;
    expireAt: Date;
  }) {
    const reason =
      subscription.expireAt.getTime() <= Date.now() || subscription.state === "expired"
        ? "subscription_expired"
        : subscription.remainingTrafficGb <= 0 || subscription.state === "exhausted"
          ? "subscription_exhausted"
          : subscription.state === "paused"
            ? "subscription_paused"
            : null;

    if (!reason) {
      return 0;
    }

    return this.revokeSubscriptionLeases(subscription.id, reason);
  }

  @Cron("*/30 * * * * *")
  async sweepExpiredLeases() {
    const now = new Date();
    const expired = await this.prisma.nodeSessionLease.findMany({
      where: {
        status: { in: ["active", "expired"] },
        expiresAt: { lt: getLeaseHardExpireCutoff(now) }
      },
      include: { node: true },
      take: 100
    });

    for (const lease of expired) {
      try {
        this.logLeaseWarning("会话过期回收：租约已超过宽限期，准备回收", lease, {
          reason: "lease_expired"
        });
        await this.revokeLease(lease.id, lease.node, "lease_expired");
      } catch (error) {
        this.logLeaseWarning("会话过期回收失败", lease, {
          reason: "lease_expired",
          error: error instanceof Error ? error.message : "未知错误"
        });
      }
    }
  }

  private async connectWithXui(
    node: {
      id: string;
      name: string;
      region: string;
      provider: string;
      tags: string[];
      recommended: boolean;
      latencyMs: number;
      protocol: string;
      security: string;
      serverHost: string;
      serverPort: number;
      serverName: string;
      uuid: string;
      flow: string;
      realityPublicKey: string;
      shortId: string;
      fingerprint: string;
      spiderX: string;
      panelBaseUrl: string | null;
      panelApiBasePath: string | null;
      panelUsername: string | null;
      panelPassword: string | null;
      panelInboundId: number | null;
      panelEnabled: boolean;
    },
    user: UserProfileDto,
    access: ResolvedSubscriptionAccess,
    request: ConnectRequestDto,
    policy: {
      blockAds: boolean;
      chinaDirect: boolean;
      aiServicesProxy: boolean;
    } | null
  ): Promise<GeneratedRuntimeConfigDto> {
    const now = new Date();
    const sessionId = `session_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const leaseId = createId("lease");
    const leaseExpiresAt = new Date(now.getTime() + LEASE_TTL_SECONDS * 1000);
    const subscription = access.subscription;
    if (!subscription) {
      throw new NotFoundException("当前没有可用订阅");
    }
    const binding = await this.ensurePanelClientBinding({
      node,
      subscriptionId: subscription.id,
      userId: user.id,
      teamId: subscription.teamId,
      userEmail: user.email,
      userDisplayName: user.displayName,
      expireAt: subscription.expireAt
    });

    await this.prisma.nodeSessionLease.create({
      data: {
        id: leaseId,
        sessionId,
        accessMode: "xui",
        userId: user.id,
        subscriptionId: subscription.id,
        nodeId: node.id,
        xrayUserEmail: binding.panelClientEmail,
        xrayUserUuid: binding.panelClientId,
        status: "active",
        issuedAt: now,
        expiresAt: leaseExpiresAt,
        lastHeartbeatAt: now
      }
    });

    this.activeRuntime = {
      sessionId,
      leaseId,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
      leaseHeartbeatIntervalSeconds: LEASE_HEARTBEAT_INTERVAL_SECONDS,
      leaseGraceSeconds: LEASE_GRACE_SECONDS,
      node: toNodeSummary(node),
      mode: request.mode,
      localHttpPort: 17890,
      localSocksPort: 17891,
      routingProfile: request.strategyGroupId ?? "managed-rule-default",
      generatedAt: new Date().toISOString(),
      features: {
        blockAds: policy?.blockAds ?? true,
        chinaDirect: policy?.chinaDirect ?? true,
        aiServicesProxy: policy?.aiServicesProxy ?? true
      },
      outbound: {
        protocol: "vless",
        server: node.serverHost,
        port: node.serverPort,
        uuid: binding.panelClientId,
        flow: node.flow,
        realityPublicKey: node.realityPublicKey,
        shortId: node.shortId,
        serverName: node.serverName,
        fingerprint: node.fingerprint,
        spiderX: node.spiderX
      }
    };
    this.activeRuntimeUsageContext = {
      subscriptionId: subscription.id,
      nodeId: node.id,
      userId: user.id,
      teamId: subscription.teamId
    };

    await this.prisma.node.update({
      where: { id: node.id },
      data: {
        panelStatus: "online",
        panelError: null
      }
    });
    await this.meteringIncidentService.resolve(subscription.id, node.id, METERING_REASON_NODE_UNAVAILABLE);
    return this.activeRuntime;
  }

  private async ensurePanelClientBinding(input: {
    node: {
      id: string;
      name: string;
      flow: string;
      panelBaseUrl: string | null;
      panelApiBasePath: string | null;
      panelUsername: string | null;
      panelPassword: string | null;
      panelInboundId: number | null;
      panelEnabled: boolean;
    };
    subscriptionId: string;
    userId: string;
    teamId: string | null;
    userEmail: string;
    userDisplayName: string;
    expireAt: Date;
  }) {
    if (!input.node.panelEnabled) {
      throw new BadRequestException("节点未启用 3x-ui 面板接入");
    }

    const existing = await this.prisma.panelClientBinding.findFirst({
      where: {
        subscriptionId: input.subscriptionId,
        nodeId: input.node.id,
        userId: input.userId
      },
      orderBy: { createdAt: "desc" }
    });

    const panelClientEmail =
      existing?.panelClientEmail ??
      buildPanelClientEmail(input.userEmail, input.subscriptionId, input.node.id, input.userId);
    const panelClientId =
      existing?.status === "deleted" ? randomUUID() : existing?.panelClientId ?? randomUUID();
    const panelInboundId = input.node.panelInboundId ?? existing?.panelInboundId ?? null;
    const nodeConfig = {
      id: input.node.id,
      panelBaseUrl: input.node.panelBaseUrl,
      panelApiBasePath: input.node.panelApiBasePath,
      panelUsername: input.node.panelUsername,
      panelPassword: input.node.panelPassword,
      panelInboundId
    };

    const ensured = await this.xuiService.ensureClient(nodeConfig, {
      id: panelClientId,
      email: panelClientEmail,
      enable: true,
      flow: input.node.flow,
      expiryTime: input.expireAt.getTime(),
      limitIp: 0,
      totalGB: 0,
      subId: "",
      reset: 0,
      tgId: "",
      comment: `${input.userDisplayName} · ${input.node.name}`
    });
    const resolvedPanelClientId = ensured.uuid || panelClientId;
    const resolvedPanelInboundId = panelInboundId ?? ensured.inboundId;
    const baseline = await this.readPanelClientBaseline(
      {
        ...nodeConfig,
        panelInboundId: resolvedPanelInboundId
      },
      panelClientEmail
    );

    if (existing) {
      const binding = await this.prisma.panelClientBinding.update({
        where: { id: existing.id },
        data: {
          panelClientEmail,
          panelClientId: resolvedPanelClientId,
          panelInboundId: resolvedPanelInboundId ?? existing.panelInboundId,
          status: "active",
          lastUplinkBytes: baseline.uplinkBytes,
          lastDownlinkBytes: baseline.downlinkBytes,
          lastSyncedAt: baseline.sampledAt,
          teamId: input.teamId
        }
      });
      const snapshot = await this.prisma.trafficSnapshot.findUnique({
        where: {
          snapshotKey: buildSnapshotKey(binding.nodeId, binding.subscriptionId, binding.userId)
        }
      });
      if (existing.status === "deleted" || !snapshot) {
        await this.ensureTrafficSnapshotBaseline({
          nodeId: binding.nodeId,
          subscriptionId: binding.subscriptionId,
          userId: binding.userId,
          teamId: binding.teamId,
          uplinkBytes: baseline.uplinkBytes,
          downlinkBytes: baseline.downlinkBytes,
          sampledAt: baseline.sampledAt
        });
      }
      return binding;
    }

    const binding = await this.prisma.panelClientBinding.create({
      data: {
        id: createId("panel_client"),
        subscriptionId: input.subscriptionId,
        userId: input.userId,
        teamId: input.teamId,
        nodeId: input.node.id,
        panelClientEmail,
        panelClientId: resolvedPanelClientId,
        panelInboundId: resolvedPanelInboundId ?? 0,
        lastUplinkBytes: baseline.uplinkBytes,
        lastDownlinkBytes: baseline.downlinkBytes,
        lastSyncedAt: baseline.sampledAt,
        status: "active"
      }
    });
    await this.ensureTrafficSnapshotBaseline({
      nodeId: binding.nodeId,
      subscriptionId: binding.subscriptionId,
      userId: binding.userId,
      teamId: binding.teamId,
      uplinkBytes: baseline.uplinkBytes,
      downlinkBytes: baseline.downlinkBytes,
      sampledAt: baseline.sampledAt
    });
    return binding;
  }

  private async readPanelClientBaseline(
    node: {
      id: string;
      panelBaseUrl: string | null;
      panelApiBasePath: string | null;
      panelUsername: string | null;
      panelPassword: string | null;
      panelInboundId: number | null;
    },
    panelClientEmail: string
  ) {
    const usage = await this.xuiService.getClientUsage(node, panelClientEmail);
    const sampledAt = usage?.sampledAt ? new Date(usage.sampledAt) : new Date();
    return {
      uplinkBytes: usage?.uplinkBytes ?? 0n,
      downlinkBytes: usage?.downlinkBytes ?? 0n,
      sampledAt: Number.isNaN(sampledAt.getTime()) ? new Date() : sampledAt
    };
  }

  private async ensureTrafficSnapshotBaseline(input: {
    nodeId: string;
    subscriptionId: string;
    userId: string | null;
    teamId: string | null;
    uplinkBytes: bigint;
    downlinkBytes: bigint;
    sampledAt?: Date;
  }) {
    const snapshotKey = buildSnapshotKey(input.nodeId, input.subscriptionId, input.userId);
    const sampledAt = input.sampledAt ?? new Date();
    const totalBytes = input.uplinkBytes + input.downlinkBytes;
    await this.prisma.trafficSnapshot.upsert({
      where: { snapshotKey },
      update: {
        uplinkBytes: input.uplinkBytes,
        downlinkBytes: input.downlinkBytes,
        totalBytes,
        sampledAt
      },
      create: {
        id: randomUUID(),
        snapshotKey,
        nodeId: input.nodeId,
        subscriptionId: input.subscriptionId,
        userId: input.userId,
        teamId: input.teamId,
        uplinkBytes: input.uplinkBytes,
        downlinkBytes: input.downlinkBytes,
        totalBytes,
        sampledAt
      }
    });
  }

  private async evictExceededUserLeases(userId: string, maxConcurrentSessions: number) {
    const graceWindowStart = new Date(Date.now() - LEASE_GRACE_SECONDS * 1000);
    const activeLeases = await this.prisma.nodeSessionLease.findMany({
      where: {
        userId,
        status: "active",
        expiresAt: { gt: graceWindowStart }
      },
      include: { node: true },
      orderBy: [{ lastHeartbeatAt: "asc" }, { issuedAt: "asc" }]
    });

    const evictCount = activeLeases.length - maxConcurrentSessions + 1;
    if (evictCount <= 0) {
      return;
    }

    for (const lease of activeLeases.slice(0, evictCount)) {
      await this.revokeLease(lease.id, lease.node, SECURITY_REASON_CONCURRENCY);
    }
  }

  private async assertLeaseCanHeartbeat(
    lease: {
      id: string;
      sessionId: string;
      accessMode: string;
      userId: string;
      subscriptionId: string;
      nodeId: string;
      xrayUserEmail: string;
      xrayUserUuid: string;
      status: string;
      lastHeartbeatAt: Date;
      expiresAt: Date;
      revokedReason: string | null;
      node: {
        id: string;
        flow: string;
      };
    },
    userId: string
  ) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: lease.subscriptionId },
      include: {
        user: true,
        team: true,
        nodeAccesses: {
          where: { nodeId: lease.nodeId },
          select: { nodeId: true }
        }
      }
    });

    const revokeAndThrow = async (message: string, reason: string) => {
      this.logLeaseWarning(
        "会话心跳失败：租约校验未通过",
        {
          ...lease,
          status: reason === SECURITY_REASON_CONCURRENCY ? "evicted" : "revoked",
          revokedReason: reason
        },
        {
          reason
        }
      );
      await this.revokeLease(lease.id, lease.node, reason);
      throw new ForbiddenException(message);
    };

    if (!subscription) {
      await revokeAndThrow("当前订阅不存在，会话已失效", "subscription_missing");
    }
    const ensuredSubscription = subscription as NonNullable<typeof subscription>;

    if (ensuredSubscription.userId) {
      if (ensuredSubscription.userId !== userId) {
        await revokeAndThrow("当前会话不属于该账号", "subscription_owner_mismatch");
      }
      if (!ensuredSubscription.user || ensuredSubscription.user.status !== "active") {
        await revokeAndThrow("当前账号已禁用，会话已失效", "subscription_user_disabled");
      }
    } else if (ensuredSubscription.teamId) {
      const membership = await this.prisma.teamMember.findUnique({
        where: { userId },
        include: {
          team: true
        }
      });
      if (!membership || !membership.team || membership.teamId !== ensuredSubscription.teamId) {
        await revokeAndThrow("当前成员已失去团队访问权限，会话已失效", "team_membership_missing");
        return;
      }
      if (membership.team.status !== "active") {
        await revokeAndThrow("当前团队已停用，会话已失效", "team_disabled");
        return;
      }
    } else {
      await revokeAndThrow("当前订阅缺少归属信息，会话已失效", "subscription_owner_missing");
    }

    if (ensuredSubscription.nodeAccesses.length === 0) {
      await revokeAndThrow("当前节点授权已取消，会话已失效", "node_access_revoked");
    }

    try {
      assertSubscriptionConnectable(ensuredSubscription);
    } catch (error) {
      const message = error instanceof Error ? error.message : "当前订阅不可继续使用";
      const reason =
        ensuredSubscription.expireAt.getTime() <= Date.now() || ensuredSubscription.state === "expired"
          ? "subscription_expired"
          : ensuredSubscription.remainingTrafficGb <= 0 || ensuredSubscription.state === "exhausted"
            ? "subscription_exhausted"
            : ensuredSubscription.state === "paused"
              ? "subscription_paused"
              : "subscription_unavailable";
      await revokeAndThrow(message, reason);
    }

    if (lease.accessMode === "xui") {
      const binding = await this.prisma.panelClientBinding.findFirst({
        where: {
          subscriptionId: lease.subscriptionId,
          nodeId: lease.nodeId,
          userId: lease.userId,
          status: "active"
        }
      });

      if (!binding) {
        await revokeAndThrow("当前节点客户端已停用，会话已失效", "panel_client_disabled");
        return;
      }

      if (
        binding.panelClientEmail !== lease.xrayUserEmail ||
        binding.panelClientId !== lease.xrayUserUuid
      ) {
        await revokeAndThrow("当前节点客户端凭据已更新，会话已失效", "panel_client_rotated");
      }
    }
  }

  private async revokeLease(
    leaseId: string,
    node: { id: string; flow: string },
    reason: string
  ) {
    const lease = await this.prisma.nodeSessionLease.findUnique({
      where: { id: leaseId }
    });
    if (!lease) {
      return;
    }

    this.clearActiveRuntime(lease.sessionId);

    const nextStatus = reason === SECURITY_REASON_CONCURRENCY ? "evicted" : "revoked";
    const revoked = await this.prisma.nodeSessionLease.updateMany({
      where: {
        id: lease.id,
        status: { in: ["active", "expired"] }
      },
      data: {
        status: nextStatus,
        revokedAt: new Date(),
        revokedReason: reason
      }
    });
    if (revoked.count === 0) {
      return;
    }

    await this.prisma.securityEvent.create({
      data: {
        id: createId("security"),
        type: reason === SECURITY_REASON_CONCURRENCY ? "session_evicted" : "session_revoked",
        userId: lease.userId,
        subscriptionId: lease.subscriptionId,
        nodeId: lease.nodeId,
        leaseId: lease.id,
        detail: reason
      }
    });

    const details = getLeaseFailureDetails(nextStatus, reason);
    this.clientRuntimeEventsService.publishToUser(lease.userId, {
      type: toClientRuntimeEventType(details.reasonCode),
      occurredAt: new Date().toISOString(),
      sessionId: lease.sessionId,
      subscriptionId: lease.subscriptionId,
      nodeId: lease.nodeId,
      reasonCode: details.reasonCode,
      reasonMessage: details.reasonMessage
    });

    if (lease.accessMode === "relay") {
      try {
        await this.getEdgeGatewayService().closeSession({
          sessionId: lease.sessionId,
          leaseId: lease.id,
          nodeId: lease.nodeId
        });
        await this.meteringIncidentService.resolve(
          lease.subscriptionId,
          lease.nodeId,
          METERING_REASON_NODE_UNAVAILABLE
        );
      } catch (error) {
        await this.getEdgeGatewayService().markNodeUnavailable(
          lease.nodeId,
          error instanceof Error ? error.message : "关闭中心中转会话失败"
        );
      }
    }
  }

  private async resolveSubscriptionAccessForUser(userId: string): Promise<ResolvedSubscriptionAccess> {
    const membership = await this.prisma.teamMember.findUnique({
      where: { userId },
      include: {
        team: {
          include: {
            subscriptions: {
              include: { plan: true },
              orderBy: [{ expireAt: "desc" }, { createdAt: "desc" }]
            }
          }
        }
      }
    });

    if (membership) {
      const pickedSubscription = pickCurrentSubscription(membership.team.subscriptions);
      const subscription = pickedSubscription
        ? await this.prisma.subscription.findUnique({
            where: { id: pickedSubscription.id },
            include: { plan: true, user: true, team: true }
          })
        : null;
      const memberUsedTrafficGb = subscription
        ? await this.getMemberUsedTrafficGb(membership.teamId, userId, subscription.id)
        : 0;
      return {
        subscription,
        team: membership.team,
        memberRole: membership.role as TeamMemberRole,
        memberUsedTrafficGb
      };
    }

    const subscription = await this.findCurrentPersonalSubscription(userId);
    return {
      subscription,
      team: null,
      memberRole: null,
      memberUsedTrafficGb: null
    };
  }

  private async findCurrentPersonalSubscription(userId: string) {
    return this.prisma.subscription.findFirst({
      where: {
        userId
      },
      include: { plan: true, user: true, team: true },
      orderBy: [{ expireAt: "desc" }, { createdAt: "desc" }]
    });
  }

  private async getMemberUsedTrafficGb(teamId: string, userId: string, subscriptionId: string) {
    const rows = await this.prisma.trafficLedger.findMany({
      where: { teamId, userId, subscriptionId }
    });
    return rows.reduce((sum, item) => sum + item.usedTrafficGb, 0);
  }

  private async resolveActiveUserFromToken(token?: string): Promise<UserProfileDto> {
    return this.authSessionService.authenticateAccessToken(token);
  }
}

function toNodeSummary(row: {
  id: string;
  name: string;
  region: string;
  provider: string;
  tags: string[];
  recommended: boolean;
  latencyMs: number;
  probeLatencyMs?: number | null;
  protocol: string;
  security: string;
}) {
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    provider: row.provider,
    tags: row.tags,
    recommended: row.recommended,
    latencyMs: row.probeLatencyMs ?? row.latencyMs,
    protocol: row.protocol as "vless",
    security: row.security as "reality"
  };
}

function buildXuiRuntimeFromLease(
  lease: {
    id: string;
    sessionId: string;
    accessMode: string;
    expiresAt: Date;
    updatedAt: Date;
    xrayUserUuid: string;
    node: {
      id: string;
      name: string;
      region: string;
      provider: string;
      tags: string[];
      recommended: boolean;
      latencyMs: number;
      probeLatencyMs?: number | null;
      protocol: string;
      security: string;
      serverHost: string;
      serverPort: number;
      flow: string;
      realityPublicKey: string;
      shortId: string;
      serverName: string;
      fingerprint: string;
      spiderX: string;
    };
  },
  policy: {
    blockAds: boolean;
    chinaDirect: boolean;
    aiServicesProxy: boolean;
  } | null
): GeneratedRuntimeConfigDto {
  return {
    sessionId: lease.sessionId,
    leaseId: lease.id,
    leaseExpiresAt: lease.expiresAt.toISOString(),
    leaseHeartbeatIntervalSeconds: LEASE_HEARTBEAT_INTERVAL_SECONDS,
    leaseGraceSeconds: LEASE_GRACE_SECONDS,
    node: toNodeSummary(lease.node),
    mode: "rule",
    localHttpPort: 17890,
    localSocksPort: 17891,
    routingProfile: "managed-rule-default",
    generatedAt: lease.updatedAt.toISOString(),
    features: {
      blockAds: policy?.blockAds ?? true,
      chinaDirect: policy?.chinaDirect ?? true,
      aiServicesProxy: policy?.aiServicesProxy ?? true
    },
    outbound: {
      protocol: "vless",
      server: lease.node.serverHost,
      port: lease.node.serverPort,
      uuid: lease.xrayUserUuid,
      flow: lease.node.flow,
      realityPublicKey: lease.node.realityPublicKey,
      shortId: lease.node.shortId,
      serverName: lease.node.serverName,
      fingerprint: lease.node.fingerprint,
      spiderX: lease.node.spiderX
    }
  };
}

function createId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}
