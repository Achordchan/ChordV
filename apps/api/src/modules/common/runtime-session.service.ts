import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException
} from "@nestjs/common";
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

type PanelBindingFilter = {
  userId?: string;
  nodeIds?: string[];
  statuses?: string[];
};

const PANEL_SYNC_BATCH_SIZE = Number(process.env.CHORDV_PANEL_SYNC_BATCH_SIZE ?? 20);
const PANEL_SYNC_RETRY_BASE_SECONDS = Number(process.env.CHORDV_PANEL_SYNC_RETRY_BASE_SECONDS ?? 30);
const PANEL_SYNC_RETRY_MAX_SECONDS = Number(process.env.CHORDV_PANEL_SYNC_RETRY_MAX_SECONDS ?? 1800);

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
    if (!node.isActive) {
      throw new ForbiddenException("当前节点已禁用");
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
          nodeId: request.nodeId,
          node: {
            isActive: true
          }
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

      return this.connectWithXui(node, user, access, request, policy);
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

    const allowedNodeIds = new Set(
      subscription.nodeAccesses.filter((item) => item.node.isActive).map((item) => item.nodeId)
    );
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
        if (binding.status !== "active") {
          continue;
        }
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
        if (!access.node.isActive || !access.node.panelEnabled) {
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

  async revokeNodeLeases(nodeId: string, reason: string) {
    const graceWindowStart = new Date(Date.now() - LEASE_GRACE_SECONDS * 1000);
    const activeLeases = await this.prisma.nodeSessionLease.findMany({
      where: {
        nodeId,
        status: "active",
        expiresAt: { gt: graceWindowStart }
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
    filter?: PanelBindingFilter
  ): Promise<PanelBindingMutationResult> {
    const bindings = await this.prisma.panelClientBinding.findMany({
      where: {
        subscriptionId,
        ...(filter?.userId ? { userId: filter.userId } : {}),
        ...(filter?.nodeIds ? { nodeId: { in: filter.nodeIds } } : {}),
        status: filter?.statuses ? { in: filter.statuses } : "active"
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

  async markPanelBindingsDisabledForSubscription(
    subscriptionId: string,
    filter?: { userId?: string; nodeIds?: string[] }
  ) {
    const bindings = await this.prisma.panelClientBinding.findMany({
      where: {
        subscriptionId,
        ...(filter?.userId ? { userId: filter.userId } : {}),
        ...(filter?.nodeIds ? { nodeId: { in: filter.nodeIds } } : {}),
        status: "active"
      }
    });
    if (bindings.length === 0) {
      return 0;
    }
    const now = new Date();

    await this.prisma.$transaction([
      this.prisma.panelClientBinding.updateMany({
        where: {
          id: { in: bindings.map((binding) => binding.id) }
        },
        data: {
          status: "disabled"
        }
      }),
      ...bindings.map((binding) =>
        this.prisma.panelSyncJob.upsert({
          where: {
            dedupeKey: `disable:${binding.id}`
          },
          create: {
            id: randomUUID(),
            dedupeKey: `disable:${binding.id}`,
            action: "disable_client",
            bindingId: binding.id,
            subscriptionId: binding.subscriptionId,
            userId: binding.userId,
            teamId: binding.teamId,
            nodeId: binding.nodeId,
            panelClientEmail: binding.panelClientEmail,
            panelClientId: binding.panelClientId,
            panelInboundId: binding.panelInboundId,
            status: "pending",
            nextRunAt: now
          },
          update: {
            status: "pending",
            nextRunAt: now,
            lockedAt: null,
            completedAt: null
          }
        })
      )
    ]);

    return bindings.length;
  }

  async markPanelBindingsDisabledForNode(nodeId: string) {
    const subscriptions = await this.prisma.subscription.findMany({
      where: {
        panelClientBindings: {
          some: {
            nodeId,
            status: "active"
          }
        }
      },
      select: { id: true }
    });

    let disabledCount = 0;
    for (const subscription of subscriptions) {
      disabledCount += await this.markPanelBindingsDisabledForSubscription(subscription.id, { nodeIds: [nodeId] });
    }
    return disabledCount;
  }

  async clearPendingPanelDisableJobsForNode(nodeId: string) {
    const result = await this.prisma.panelSyncJob.updateMany({
      where: {
        nodeId,
        action: "disable_client",
        status: { in: ["pending", "running", "failed"] }
      },
      data: {
        status: "completed",
        lockedAt: null,
        lastError: null,
        completedAt: new Date()
      }
    });

    return result.count;
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

  @Cron("*/30 * * * * *")
  async retryPendingPanelSyncJobs() {
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - 10 * 60 * 1000);
    const jobs = await this.prisma.panelSyncJob.findMany({
      where: {
        OR: [
          {
            status: { in: ["pending", "failed"] },
            nextRunAt: { lte: now },
            OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }]
          },
          {
            status: "running",
            lockedAt: { lt: staleLockBefore }
          }
        ]
      },
      include: {
        node: true
      },
      orderBy: [{ nextRunAt: "asc" }, { createdAt: "asc" }],
      take: PANEL_SYNC_BATCH_SIZE
    });

    for (const job of jobs) {
      const locked = await this.prisma.panelSyncJob.updateMany({
        where: {
          id: job.id,
          OR: [
            {
              status: { in: ["pending", "failed"] },
              nextRunAt: { lte: now },
              OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }]
            },
            {
              status: "running",
              lockedAt: { lt: staleLockBefore }
            }
          ]
        },
        data: {
          status: "running",
          lockedAt: new Date()
        }
      });
      if (locked.count === 0) {
        continue;
      }

      await this.runPanelSyncJob(job);
    }
  }

  private async runPanelSyncJob(job: {
    id: string;
    action: string;
    attempts: number;
    bindingId: string;
    nodeId: string;
    panelClientEmail: string;
    panelClientId: string;
    node: {
      id: string;
      panelBaseUrl: string | null;
      panelApiBasePath: string | null;
      panelUsername: string | null;
      panelPassword: string | null;
      panelInboundId: number | null;
    };
  }) {
    try {
      if (job.action !== "disable_client") {
        throw new Error(`未知面板同步动作：${job.action}`);
      }

      await this.xuiService.setClientEnabled(
        {
          id: job.node.id,
          panelBaseUrl: job.node.panelBaseUrl,
          panelApiBasePath: job.node.panelApiBasePath,
          panelUsername: job.node.panelUsername,
          panelPassword: job.node.panelPassword,
          panelInboundId: job.node.panelInboundId
        },
        job.panelClientId,
        job.panelClientEmail,
        false
      );

      await this.prisma.$transaction([
        this.prisma.panelClientBinding.update({
          where: { id: job.bindingId },
          data: {
            status: "disabled"
          }
        }),
        this.prisma.panelSyncJob.update({
          where: { id: job.id },
          data: {
            status: "completed",
            lockedAt: null,
            lastError: null,
            completedAt: new Date()
          }
        })
      ]);
    } catch (error) {
      const nextAttempts = job.attempts + 1;
      const retrySeconds = Math.min(
        PANEL_SYNC_RETRY_MAX_SECONDS,
        PANEL_SYNC_RETRY_BASE_SECONDS * 2 ** Math.min(nextAttempts - 1, 6)
      );
      const message = error instanceof Error ? error.message : "3x-ui 客户端同步失败";
      await this.prisma.$transaction([
        this.prisma.node.update({
          where: { id: job.nodeId },
          data: {
            panelStatus: "degraded",
            panelError: message
          }
        }),
        this.prisma.panelSyncJob.update({
          where: { id: job.id },
          data: {
            status: "failed",
            attempts: nextAttempts,
            lockedAt: null,
            lastError: message,
            nextRunAt: new Date(Date.now() + retrySeconds * 1000)
          }
        })
      ]);
      this.logger.warn(`面板同步任务失败，${retrySeconds} 秒后重试：${job.nodeId}/${job.panelClientEmail}: ${message}`);
    }
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
          where: {
            nodeId: lease.nodeId,
            node: {
              isActive: true
            }
          },
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
