import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException
} from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { createHash, randomUUID } from "node:crypto";
import { Client as PgClient } from "pg";
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
import { toNodeSummary } from "./node-import.utils";
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
import { runWithSubscriptionUsageLock } from "./usage-lock.utils";
import { createOrRefreshLeaseRevocationJob, createOrRefreshPanelSyncJob } from "./panel-sync-job.utils";
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

const NODE_PANEL_ACCESS_SYNC_TIMEOUT_MS = 300;

type PanelBindingFilter = {
  userId?: string;
  nodeIds?: string[];
  statuses?: string[];
};

type PanelSyncAction = "ensure_client" | "disable_client" | "delete_client" | "reset_client_traffic";

const PANEL_SYNC_BATCH_SIZE = Number(process.env.CHORDV_PANEL_SYNC_BATCH_SIZE ?? 20);
const DEFAULT_PANEL_SYNC_JOB_CONCURRENCY = 4;
const PANEL_SYNC_RETRY_BASE_SECONDS = Number(process.env.CHORDV_PANEL_SYNC_RETRY_BASE_SECONDS ?? 30);
const PANEL_SYNC_RETRY_MAX_SECONDS = Number(process.env.CHORDV_PANEL_SYNC_RETRY_MAX_SECONDS ?? 1800);
const DEFAULT_PANEL_SYNC_JOB_TIMEOUT_MS = 30_000;
const LEASE_REVOCATION_BATCH_SIZE = Number(process.env.CHORDV_LEASE_REVOCATION_BATCH_SIZE ?? 50);
const LEASE_REVOCATION_RETRY_BASE_SECONDS = Number(process.env.CHORDV_LEASE_REVOCATION_RETRY_BASE_SECONDS ?? 15);
const LEASE_REVOCATION_RETRY_MAX_SECONDS = Number(process.env.CHORDV_LEASE_REVOCATION_RETRY_MAX_SECONDS ?? 900);
const CONNECT_LOCK_KEY_1 = 420_702;

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

  private async runWithDistributedUserLeaseLock<T>(userId: string, task: () => Promise<T>) {
    return this.runWithUserLeaseLock(userId, async () => {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) {
        return task();
      }

      const lockClient = new PgClient({ connectionString });
      let locked = false;
      const userLockKey = deriveUserAdvisoryLockKey(userId);
      try {
        await lockClient.connect();
        await lockClient.query("select pg_advisory_lock($1, $2)", [CONNECT_LOCK_KEY_1, userLockKey]);
        locked = true;
        return await task();
      } finally {
        if (locked) {
          await lockClient.query("select pg_advisory_unlock($1, $2)", [CONNECT_LOCK_KEY_1, userLockKey]).catch(() => undefined);
        }
        await lockClient.end().catch(() => undefined);
      }
    });
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
    if (!node.panelEnabled) {
      throw new ForbiddenException("当前节点未启用面板接入");
    }

    const user = await this.resolveActiveUserFromToken(token);
    return this.runWithDistributedUserLeaseLock(user.id, async () => {
      const initialAccess = await this.resolveSubscriptionAccessForUser(user.id);
      if (!initialAccess.subscription) {
        throw new NotFoundException("当前没有可用订阅");
      }

      const lockedSubscriptionId = initialAccess.subscription.id;
      return runWithSubscriptionUsageLock(lockedSubscriptionId, async () => {
      const access = await this.resolveSubscriptionAccessForUser(user.id);
      if (!access.subscription) {
        throw new NotFoundException("褰撳墠娌℃湁鍙敤璁㈤槄");
      }

      if (access.subscription.id !== lockedSubscriptionId) {
        throw new ForbiddenException("Current subscription changed while connecting. Please retry.");
      }

      assertRuntimeAccessConnectable(access);
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
            isActive: true,
            panelEnabled: true
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
      await this.evictExceededUserLeases(user.id, concurrentLimit, 1);

      return this.connectWithXui(node, user, access, request, policy);
      });
    });
  }

  async enforceUserConcurrentLeaseLimit(userId: string, maxConcurrentSessions: number) {
    const limit = Math.max(1, Math.trunc(maxConcurrentSessions));
    return this.runWithDistributedUserLeaseLock(userId, () => this.evictExceededUserLeases(userId, limit, 0));
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
    const canClearPreviousRuntime =
      Boolean(previous) &&
      previous?.sessionId === sessionId &&
      this.activeRuntimeUsageContext?.userId === user.id;
    if (canClearPreviousRuntime) {
      this.clearActiveRuntime(sessionId);
    }
    return { ok: true, previousSessionId: canClearPreviousRuntime ? previous?.sessionId ?? null : null };
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
    try {
      await this.assertLeaseCanHeartbeat(lease, user.id);
    } catch {
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
    return runWithSubscriptionUsageLock(subscriptionId, () => this.syncSubscriptionPanelAccessLocked(subscriptionId));
  }

  async queueSubscriptionPanelAccessSync(subscriptionId: string) {
    return this.syncSubscriptionPanelAccessLocked(subscriptionId);
  }

  private async syncSubscriptionPanelAccessLocked(subscriptionId: string) {
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
      return 0;
    }

    let queuedPanelSyncCount = 0;

    const allowedNodeIds = new Set(
      subscription.nodeAccesses
        .filter((item) => item.node.isActive && item.node.panelEnabled)
        .map((item) => item.nodeId)
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
      return removeResult.updated;
    }

    for (const binding of bindings) {
      const invalidByNode = !allowedNodeIds.has(binding.nodeId);
      const invalidByUser = activeTeamMemberIds ? !activeTeamMemberIds.has(binding.userId ?? "") : false;
      if (invalidByUser) {
        await this.revokeSubscriptionLeases(subscriptionId, "team_member_removed", {
          userId: binding.userId ?? undefined,
          nodeIds: [binding.nodeId]
        });
        queuedPanelSyncCount += await this.markPanelBindingsDisabledForSubscription(subscriptionId, {
          userId: binding.userId ?? undefined,
          nodeIds: [binding.nodeId]
        });
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
        queuedPanelSyncCount += await this.markPanelBindingsDisabledForSubscription(subscriptionId, {
          userId: binding.userId ?? undefined,
          nodeIds: [binding.nodeId]
        });
      }
    }

    if (!shouldProvision) {
      return queuedPanelSyncCount;
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
        const binding = await this.ensurePanelClientBinding({
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
        if (binding) {
          queuedPanelSyncCount += 1;
        }
      }
    }
    return queuedPanelSyncCount;
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
    const requested = await this.markPanelBindingsDisabledForSubscription(subscriptionId, {
      ...(filter?.userId ? { userId: filter.userId } : {}),
      ...(filter?.nodeIds ? { nodeIds: filter.nodeIds } : {})
    });
    return {
      requested,
      updated: requested,
      failed: []
    };
  }

  async markPanelBindingsDisabledForSubscription(
    subscriptionId: string,
    filter?: { userId?: string; nodeIds?: string[] }
  ) {
    return this.prisma.$transaction((tx) => this.queuePanelDisableJobsForSubscriptionTx(tx, subscriptionId, filter));
  }

  async queuePanelDisableJobsForSubscriptionTx(
    writer: any,
    subscriptionId: string,
    filter?: { userId?: string; nodeIds?: string[] }
  ) {
    const bindings = await writer.panelClientBinding.findMany({
      where: {
        subscriptionId,
        ...(filter?.userId ? { userId: filter.userId } : {}),
        ...(filter?.nodeIds ? { nodeId: { in: filter.nodeIds } } : {}),
        status: "active"
      },
      include: {
        node: {
          select: {
            panelBaseUrl: true,
            panelApiBasePath: true,
            panelUsername: true,
            panelPassword: true
          }
        }
      }
    });
    if (bindings.length === 0) {
      return 0;
    }
    const now = new Date();

    for (const binding of bindings) {
      const snapshot = binding.node ?? {};
      const dedupeKey = `disable:${binding.id}`;
      await createOrRefreshPanelSyncJob(writer, dedupeKey, {
        create: {
          id: randomUUID(),
          dedupeKey,
          action: "disable_client",
          bindingId: binding.id,
          subscriptionId: binding.subscriptionId,
          userId: binding.userId,
          teamId: binding.teamId,
          nodeId: binding.nodeId,
          panelClientEmail: binding.panelClientEmail,
          panelClientId: binding.panelClientId,
          panelInboundId: binding.panelInboundId,
          panelBaseUrl: snapshot.panelBaseUrl ?? null,
          panelApiBasePath: snapshot.panelApiBasePath ?? null,
          panelUsername: snapshot.panelUsername ?? null,
          panelPassword: snapshot.panelPassword ?? null,
          status: "pending",
          nextRunAt: now
        },
        update: {
          status: "pending",
          nextRunAt: now,
          lockedAt: null,
          completedAt: null,
          attempts: 0,
          lastError: null,
          subscriptionId: binding.subscriptionId,
          userId: binding.userId,
          teamId: binding.teamId,
          nodeId: binding.nodeId,
          panelClientEmail: binding.panelClientEmail,
          panelClientId: binding.panelClientId,
          panelInboundId: binding.panelInboundId,
          panelBaseUrl: snapshot.panelBaseUrl ?? null,
          panelApiBasePath: snapshot.panelApiBasePath ?? null,
          panelUsername: snapshot.panelUsername ?? null,
          panelPassword: snapshot.panelPassword ?? null
        }
      });
    }

    return bindings.length;
  }

  async queuePanelDeleteJobsForSubscriptionTx(
    writer: any,
    subscriptionId: string,
    filter?: { userId?: string; nodeIds?: string[] },
    panelConfig?: {
      panelBaseUrl: string | null;
      panelApiBasePath: string | null;
      panelUsername: string | null;
      panelPassword: string | null;
    }
  ) {
    const bindings = await writer.panelClientBinding.findMany({
      where: {
        subscriptionId,
        ...(filter?.userId ? { userId: filter.userId } : {}),
        ...(filter?.nodeIds ? { nodeId: { in: filter.nodeIds } } : {}),
        status: { in: ["active", "disabled"] }
      },
      include: {
        node: {
          select: {
            panelBaseUrl: true,
            panelApiBasePath: true,
            panelUsername: true,
            panelPassword: true
          }
        }
      }
    });
    if (bindings.length === 0) {
      return 0;
    }

    const now = new Date();
    for (const binding of bindings) {
      const dedupeKey = `delete:${binding.id}`;
      await createOrRefreshPanelSyncJob(writer, dedupeKey, {
        create: {
          id: randomUUID(),
          dedupeKey,
          action: "delete_client",
          bindingId: binding.id,
          subscriptionId: binding.subscriptionId,
          userId: binding.userId,
          teamId: binding.teamId,
          nodeId: binding.nodeId,
          panelClientEmail: binding.panelClientEmail,
          panelClientId: binding.panelClientId,
          panelInboundId: binding.panelInboundId,
          panelBaseUrl: panelConfig?.panelBaseUrl ?? binding.node?.panelBaseUrl ?? null,
          panelApiBasePath: panelConfig?.panelApiBasePath ?? binding.node?.panelApiBasePath ?? null,
          panelUsername: panelConfig?.panelUsername ?? binding.node?.panelUsername ?? null,
          panelPassword: panelConfig?.panelPassword ?? binding.node?.panelPassword ?? null,
          status: "pending",
          nextRunAt: now
        },
        update: {
          status: "pending",
          nextRunAt: now,
          lockedAt: null,
          completedAt: null,
          attempts: 0,
          lastError: null,
          subscriptionId: binding.subscriptionId,
          userId: binding.userId,
          teamId: binding.teamId,
          nodeId: binding.nodeId,
          panelClientEmail: binding.panelClientEmail,
          panelClientId: binding.panelClientId,
          panelInboundId: binding.panelInboundId,
          panelBaseUrl: panelConfig?.panelBaseUrl ?? binding.node?.panelBaseUrl ?? null,
          panelApiBasePath: panelConfig?.panelApiBasePath ?? binding.node?.panelApiBasePath ?? null,
          panelUsername: panelConfig?.panelUsername ?? binding.node?.panelUsername ?? null,
          panelPassword: panelConfig?.panelPassword ?? binding.node?.panelPassword ?? null
        }
      });

      await writer.trafficSnapshot.deleteMany({
        where: {
          snapshotKey: buildSnapshotKey(binding.nodeId, binding.subscriptionId, binding.userId)
        }
      });
    }

    await writer.panelClientBinding.updateMany({
      where: {
        id: { in: bindings.map((binding: { id: string }) => binding.id) },
        status: { in: ["active", "disabled"] }
      },
      data: {
        status: "deleted"
      }
    });

    return bindings.length;
  }

  async queueLeaseRevocationJobsForSubscriptionTx(
    writer: any,
    subscriptionId: string,
    reason: string,
    filter?: { userId?: string; nodeIds?: string[] }
  ) {
    const now = new Date();
    const nodeIds = filter?.nodeIds && filter.nodeIds.length > 0 ? Array.from(new Set(filter.nodeIds)) : [null];
    for (const nodeId of nodeIds) {
      const dedupeKey = buildLeaseRevocationJobKey(subscriptionId, reason, filter?.userId ?? null, nodeId);
      await createOrRefreshLeaseRevocationJob(writer, dedupeKey, {
        create: {
          id: randomUUID(),
          dedupeKey,
          subscriptionId,
          userId: filter?.userId ?? null,
          nodeId,
          reason,
          status: "pending",
          nextRunAt: now
        },
        update: {
          subscriptionId,
          userId: filter?.userId ?? null,
          nodeId,
          reason,
          status: "pending",
          attempts: 0,
          nextRunAt: now,
          lockedAt: null,
          completedAt: null,
          lastError: null
        }
      });
    }
    return nodeIds.length;
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

  async disablePanelBindingsForNode(nodeId: string): Promise<PanelBindingMutationResult> {
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

    const failed: PanelBindingFailure[] = [];
    let requested = 0;
    let updated = 0;
    for (const subscription of subscriptions) {
      const result = await this.disablePanelBindingsForSubscription(subscription.id, { nodeIds: [nodeId] });
      requested += result.requested;
      updated += result.updated;
      failed.push(...result.failed);
    }
    return { requested, updated, failed };
  }

  async removePanelBindingsForNode(
    nodeId: string,
    panelConfig?: {
      panelBaseUrl: string | null;
      panelApiBasePath: string | null;
      panelUsername: string | null;
      panelPassword: string | null;
    }
  ): Promise<PanelBindingMutationResult> {
    const subscriptions = await this.prisma.subscription.findMany({
      where: {
        panelClientBindings: {
          some: {
            nodeId,
            status: { in: ["active", "disabled"] }
          }
        }
      },
      select: { id: true }
    });

    const failed: PanelBindingFailure[] = [];
    let requested = 0;
    let updated = 0;
    for (const subscription of subscriptions) {
      const result = await this.removePanelBindingsForSubscription(subscription.id, { nodeIds: [nodeId] }, panelConfig);
      requested += result.requested;
      updated += result.updated;
      failed.push(...result.failed);
    }
    return { requested, updated, failed };
  }

  async markPanelBindingsDeletedForNode(nodeId: string) {
    const bindings = await this.prisma.panelClientBinding.findMany({
      where: {
        nodeId,
        status: { in: ["active", "disabled"] }
      },
      select: {
        id: true,
        nodeId: true,
        subscriptionId: true,
        userId: true
      }
    });
    if (bindings.length === 0) {
      return 0;
    }

    await this.prisma.$transaction([
      ...bindings.map((binding) =>
        this.prisma.trafficSnapshot.deleteMany({
          where: {
            snapshotKey: buildSnapshotKey(binding.nodeId, binding.subscriptionId, binding.userId)
          }
        })
      ),
      this.prisma.panelClientBinding.updateMany({
        where: {
          id: { in: bindings.map((binding) => binding.id) },
          status: { in: ["active", "disabled"] }
        },
        data: {
          status: "deleted"
        }
      })
    ]);

    return bindings.length;
  }

  async syncPanelAccessForNode(nodeId: string) {
    const subscriptions = await this.prisma.subscription.findMany({
      where: {
        OR: [
          {
            nodeAccesses: {
              some: { nodeId }
            }
          },
          {
            panelClientBindings: {
              some: {
                nodeId,
                status: { in: ["active", "disabled", "deleted"] }
              }
            }
          }
        ]
      },
      select: { id: true }
    });

    const subscriptionIds = Array.from(new Set(subscriptions.map((subscription) => subscription.id)));
    await Promise.all(subscriptionIds.map((subscriptionId) => this.queuePanelAccessSyncForNodeSubscription(nodeId, subscriptionId)));
    return subscriptionIds.length;
  }

  private async queuePanelAccessSyncForNodeSubscription(nodeId: string, subscriptionId: string) {
    let settled = false;
    const task = Promise.resolve()
      .then(() => this.queueSubscriptionPanelAccessSync(subscriptionId))
      .then(
        () => {
          settled = true;
        },
        (error) => {
          settled = true;
          throw error;
        }
      );
    void task.catch((error) => {
      this.logger.warn(
        `Node ${nodeId} panel access sync for subscription ${subscriptionId} failed after local node save: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutTask = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (!settled) {
          this.logger.warn(
            `Node ${nodeId} panel access sync for subscription ${subscriptionId} exceeded ${NODE_PANEL_ACCESS_SYNC_TIMEOUT_MS}ms and will continue in background.`
          );
        }
        resolve();
      }, NODE_PANEL_ACCESS_SYNC_TIMEOUT_MS);
    });

    try {
      await Promise.race([task, timeoutTask]);
    } catch {
      // Individual subscription failures are logged by the guarded task and must not stop other node syncs.
    } finally {
      if (settled && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  async clearPendingPanelDisableJobsForNode(nodeId: string) {
    const jobs = await this.prisma.panelSyncJob.findMany({
      where: {
        nodeId,
        action: "disable_client",
        status: { in: ["pending", "failed"] }
      },
      include: {
        binding: {
          include: {
            user: true
          }
        },
        node: true,
        subscription: {
          include: {
            user: true,
            team: true,
            nodeAccesses: {
              where: { nodeId },
              select: { nodeId: true }
            }
          }
        }
      }
    });

    if (jobs.length === 0) {
      return 0;
    }

    const membershipPairs = jobs
      .filter((job) => job.teamId && job.userId)
      .map((job) => ({ teamId: job.teamId as string, userId: job.userId as string }));
    const memberships =
      membershipPairs.length > 0
        ? await this.prisma.teamMember.findMany({
            where: {
              OR: membershipPairs.map((pair) => ({
                teamId: pair.teamId,
                userId: pair.userId
              }))
            },
            select: {
              teamId: true,
              userId: true
            }
          })
        : [];
    const activeMemberships = new Set(memberships.map((membership) => `${membership.teamId}:${membership.userId}`));
    const clearableJobIds = jobs
      .filter((job) => isPanelDisableJobClearableAfterNodeReenabled(job, activeMemberships))
      .map((job) => job.id);

    if (clearableJobIds.length === 0) {
      return 0;
    }

    const result = await this.prisma.panelSyncJob.updateMany({
      where: {
        id: { in: clearableJobIds },
        status: { in: ["pending", "failed"] }
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
    filter?: { userId?: string; nodeIds?: string[] },
    panelConfig?: {
      panelBaseUrl: string | null;
      panelApiBasePath: string | null;
      panelUsername: string | null;
      panelPassword: string | null;
    }
  ): Promise<PanelBindingMutationResult> {
    const requested = await this.prisma.$transaction((tx) =>
      this.queuePanelDeleteJobsForSubscriptionTx(tx, subscriptionId, filter, panelConfig)
    );
    return {
      requested,
      updated: requested,
      failed: []
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
        node: true,
        binding: {
          select: {
            status: true
          }
        }
      },
      orderBy: [{ nextRunAt: "asc" }, { createdAt: "asc" }],
      take: PANEL_SYNC_BATCH_SIZE
    });

    let nextIndex = 0;
    const workerCount = Math.min(jobs.length, readPanelSyncJobConcurrency());
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const job = jobs[nextIndex];
        nextIndex += 1;
        if (!job) {
          return;
        }
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
    });
    await Promise.all(workers);
  }

  private async runPanelSyncJob(job: {
    id: string;
    action: string;
    attempts: number;
    bindingId: string;
    subscriptionId: string;
    userId?: string | null;
    teamId?: string | null;
    nodeId: string;
    panelClientEmail: string;
    panelClientId: string;
    panelInboundId?: number | null;
    panelBaseUrl?: string | null;
    panelApiBasePath?: string | null;
    panelUsername?: string | null;
    panelPassword?: string | null;
    node: {
      id: string;
      name: string;
      flow: string;
      isActive: boolean;
      panelEnabled: boolean;
      panelBaseUrl: string | null;
      panelApiBasePath: string | null;
      panelUsername: string | null;
      panelPassword: string | null;
      panelInboundId: number | null;
    };
    binding: {
      status: string;
    };
  }) {
    try {
      if (!isPanelSyncAction(job.action)) {
        throw new Error(`未知面板同步动作：${job.action}`);
      }

      if (job.action === "disable_client" && (job.binding.status !== "active" || !(await this.shouldRunPanelDisableJob(job)))) {
        await this.completePanelSyncJob(job);
        return;
      }

      const panelNodeConfig = {
        id: job.node.id,
        panelBaseUrl: job.panelBaseUrl ?? job.node.panelBaseUrl,
        panelApiBasePath: job.panelApiBasePath ?? job.node.panelApiBasePath,
        panelUsername: job.panelUsername ?? job.node.panelUsername,
        panelPassword: job.panelPassword ?? job.node.panelPassword,
        panelInboundId: job.panelInboundId ?? job.node.panelInboundId
      };

      if (job.action === "disable_client" && !(await this.shouldRunPanelDisableJob(job))) {
        await this.completePanelSyncJob(job);
        return;
      }

      let ensuredPanelClientId: string | null = null;
      let ensuredPanelInboundId: number | null = null;
      if (job.action === "disable_client") {
        await this.runPanelSyncRemoteCallWithBudget(
          job,
          this.xuiService.setClientEnabled(
            panelNodeConfig,
            job.panelClientId,
            job.panelClientEmail,
            false
          )
        );
      } else if (job.action === "ensure_client") {
        const subscription = await this.prisma.subscription.findUnique({
          where: { id: job.subscriptionId },
          select: { expireAt: true }
        });
        if (!subscription) {
          throw new Error(`Subscription not found for panel sync job: ${job.subscriptionId}`);
        }
        const ensured = await this.runPanelSyncRemoteCallWithBudget(
          job,
          this.xuiService.ensureClient(panelNodeConfig, {
            id: job.panelClientId,
            email: job.panelClientEmail,
            enable: true,
            flow: job.node.flow,
            expiryTime: subscription.expireAt.getTime(),
            limitIp: 0,
            totalGB: 0,
            subId: "",
            reset: 0,
            tgId: 0,
            comment: job.node.name
          })
        );
        ensuredPanelClientId = ensured.uuid || job.panelClientId;
        ensuredPanelInboundId = ensured.inboundId ?? panelNodeConfig.panelInboundId ?? job.panelInboundId ?? null;
      } else if (job.action === "reset_client_traffic") {
        await this.runPanelSyncRemoteCallWithBudget(
          job,
          this.xuiService.resetClientTraffic(panelNodeConfig, job.panelClientEmail)
        );
      } else if (job.action === "delete_client") {
        const removalStatus = await this.runPanelSyncRemoteCallWithBudget(
          job,
          this.xuiService.removeClient(
            panelNodeConfig,
            job.panelClientId,
            job.panelClientEmail
          )
        );
        if (removalStatus === "disabled") {
          throw new Error("3x-ui client could only be disabled, not deleted");
        }
      } else {
        throw new Error(`Panel sync action is not implemented yet: ${job.action}`);
      }

      await this.prisma.$transaction([
        ...(job.action === "delete_client"
          ? [
              this.prisma.trafficSnapshot.deleteMany({
                where: {
                  snapshotKey: buildSnapshotKey(job.nodeId, job.subscriptionId, job.userId ?? null)
                }
              })
            ]
          : []),
        this.prisma.panelClientBinding.update({
          where: { id: job.bindingId },
          data:
            job.action === "disable_client"
              ? { status: "disabled" }
              : job.action === "delete_client"
                ? { status: "deleted" }
                : job.action === "ensure_client"
                  ? {
                      status: "active",
                      panelClientId: ensuredPanelClientId ?? job.panelClientId,
                      panelInboundId: ensuredPanelInboundId ?? job.panelInboundId ?? 0,
                      lastSyncedAt: new Date()
                    }
                  : {
                      lastUplinkBytes: 0n,
                      lastDownlinkBytes: 0n,
                      lastSyncedAt: new Date()
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

  private async runPanelSyncRemoteCallWithBudget<T>(
    job: { id: string; action: string; nodeId: string; panelClientEmail: string },
    task: Promise<T>
  ): Promise<T> {
    let settled = false;
    const guardedTask = task.then(
      (result) => {
        settled = true;
        return result;
      },
      (error) => {
        settled = true;
        throw error;
      }
    );
    void guardedTask.catch((error) => {
      this.logger.warn(
        `Delayed panel sync job remote call failed after timeout or retry handoff (${job.id}/${job.action}/${job.nodeId}/${job.panelClientEmail}): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = readPanelSyncJobTimeoutMs();
    const timeoutTask = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        reject(new Error(`3x-ui panel sync job remote call timed out after ${timeoutMs}ms; retry will continue in background`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([guardedTask, timeoutTask]);
    } finally {
      if (settled && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async completePanelSyncJob(job: { id: string; subscriptionId: string; nodeId: string }) {
    const completedAt = new Date();
    await this.prisma.panelSyncJob.update({
      where: { id: job.id },
      data: {
        status: "completed",
        lockedAt: null,
        lastError: null,
        completedAt
      }
    });
  }

  private async shouldRunPanelDisableJob(job: { id: string; nodeId: string }) {
    const freshJob = await this.prisma.panelSyncJob.findUnique({
      where: { id: job.id },
      include: {
        binding: {
          include: {
            user: true
          }
        },
        node: true,
        subscription: {
          include: {
            user: true,
            team: true,
            nodeAccesses: {
              where: { nodeId: job.nodeId },
              select: { nodeId: true }
            }
          }
        }
      }
    });

    if (!freshJob || freshJob.binding.status !== "active") {
      return false;
    }

    const memberships =
      freshJob.teamId && freshJob.userId
        ? await this.prisma.teamMember.findMany({
            where: {
              teamId: freshJob.teamId,
              userId: freshJob.userId
            },
            select: {
              teamId: true,
              userId: true
            }
          })
        : [];
    const activeMemberships = new Set(memberships.map((membership) => `${membership.teamId}:${membership.userId}`));
    return !isPanelDisableJobClearableAfterNodeReenabled(freshJob, activeMemberships);
  }

  @Cron("*/30 * * * * *")
  async retryPendingLeaseRevocationJobs() {
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - 10 * 60 * 1000);
    const jobs = await this.prisma.leaseRevocationJob.findMany({
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
      orderBy: [{ nextRunAt: "asc" }, { createdAt: "asc" }],
      take: LEASE_REVOCATION_BATCH_SIZE
    });

    for (const job of jobs) {
      const locked = await this.prisma.leaseRevocationJob.updateMany({
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

      await this.runLeaseRevocationJob(job);
    }
  }

  private async runLeaseRevocationJob(job: {
    id: string;
    attempts: number;
    subscriptionId: string | null;
    userId: string | null;
    nodeId: string | null;
    reason: string;
  }) {
    try {
      if (job.subscriptionId) {
        await this.revokeSubscriptionLeases(job.subscriptionId, job.reason, {
          ...(job.userId ? { userId: job.userId } : {}),
          ...(job.nodeId ? { nodeIds: [job.nodeId] } : {})
        });
      } else if (job.userId) {
        await this.revokeUserLeases(job.userId, job.reason, job.nodeId ? { nodeIds: [job.nodeId] } : undefined);
      } else if (job.nodeId) {
        await this.revokeNodeLeases(job.nodeId, job.reason);
      } else {
        throw new Error("Lease revocation job is missing a target.");
      }

      await this.prisma.leaseRevocationJob.update({
        where: { id: job.id },
        data: {
          status: "completed",
          lockedAt: null,
          lastError: null,
          completedAt: new Date()
        }
      });
    } catch (error) {
      const nextAttempts = job.attempts + 1;
      const retrySeconds = Math.min(
        LEASE_REVOCATION_RETRY_MAX_SECONDS,
        LEASE_REVOCATION_RETRY_BASE_SECONDS * 2 ** Math.min(nextAttempts - 1, 6)
      );
      const message = error instanceof Error ? error.message : "lease revocation failed";
      await this.prisma.leaseRevocationJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          attempts: nextAttempts,
          lockedAt: null,
          lastError: message,
          nextRunAt: new Date(Date.now() + retrySeconds * 1000)
        }
      });
      this.logger.warn(`Lease revocation job failed; retrying in ${retrySeconds}s: ${job.id}: ${message}`);
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
      mldsa65Verify?: string | null;
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
    const inboundRuntime = await this.xuiService.getInboundRuntime({
      id: node.id,
      panelBaseUrl: node.panelBaseUrl,
      panelApiBasePath: node.panelApiBasePath,
      panelUsername: node.panelUsername,
      panelPassword: node.panelPassword,
      panelInboundId: binding.panelInboundId
    });
    const effectiveNode = {
      ...node,
      serverHost: inboundRuntime.serverHost,
      serverPort: inboundRuntime.serverPort,
      uuid: inboundRuntime.uuid,
      flow: inboundRuntime.flow,
      realityPublicKey: inboundRuntime.realityPublicKey,
      shortId: inboundRuntime.shortId,
      serverName: inboundRuntime.serverName,
      fingerprint: inboundRuntime.fingerprint,
      spiderX: inboundRuntime.spiderX,
      mldsa65Verify: inboundRuntime.mldsa65Verify
    };

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

    const runtime: GeneratedRuntimeConfigDto = {
      sessionId,
      leaseId,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
      leaseHeartbeatIntervalSeconds: LEASE_HEARTBEAT_INTERVAL_SECONDS,
      leaseGraceSeconds: LEASE_GRACE_SECONDS,
      node: toNodeSummary(effectiveNode),
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
        server: effectiveNode.serverHost,
        port: effectiveNode.serverPort,
        uuid: binding.panelClientId,
        flow: effectiveNode.flow,
        realityPublicKey: effectiveNode.realityPublicKey,
        shortId: effectiveNode.shortId,
        serverName: effectiveNode.serverName,
        fingerprint: effectiveNode.fingerprint,
        spiderX: effectiveNode.spiderX,
        mldsa65Verify: effectiveNode.mldsa65Verify || null
      }
    };
    this.activeRuntime = runtime;
    this.activeRuntimeUsageContext = {
      subscriptionId: subscription.id,
      nodeId: node.id,
      userId: user.id,
      teamId: subscription.teamId
    };

    await this.prisma.node.update({
      where: { id: node.id },
      data: {
        serverHost: effectiveNode.serverHost,
        serverPort: effectiveNode.serverPort,
        uuid: effectiveNode.uuid,
        flow: effectiveNode.flow,
        realityPublicKey: effectiveNode.realityPublicKey,
        shortId: effectiveNode.shortId,
        serverName: effectiveNode.serverName,
        fingerprint: effectiveNode.fingerprint,
        spiderX: effectiveNode.spiderX,
        mldsa65Verify: effectiveNode.mldsa65Verify,
        panelStatus: "online",
        panelError: null
      }
    });
    await this.meteringIncidentService.resolve(subscription.id, node.id, METERING_REASON_NODE_UNAVAILABLE);
    return runtime;
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
    const panelInboundId =
      input.node.panelInboundId ?? (existing && existing.status !== "deleted" ? existing.panelInboundId : null);

    return this.ensurePanelClientBindingLocally(input, existing, panelClientEmail, panelClientId, panelInboundId);
  }

  private async ensurePanelClientBindingLocally(
    input: {
      node: {
        id: string;
        name: string;
        flow: string;
        panelBaseUrl: string | null;
        panelApiBasePath: string | null;
        panelUsername: string | null;
        panelPassword: string | null;
        panelInboundId: number | null;
      };
      subscriptionId: string;
      userId: string;
      teamId: string | null;
      userDisplayName: string;
      expireAt: Date;
    },
    existing: any,
    panelClientEmail: string,
    panelClientId: string,
    panelInboundId: number | null
  ) {
    const baseline = {
      uplinkBytes: 0n,
      downlinkBytes: 0n,
      sampledAt: new Date()
    };
    const resolvedPanelInboundId = panelInboundId ?? 0;

    if (existing) {
      const binding = await this.prisma.panelClientBinding.update({
        where: { id: existing.id },
        data: {
          panelClientEmail,
          panelClientId,
          panelInboundId: existing.status === "deleted" ? resolvedPanelInboundId : panelInboundId ?? existing.panelInboundId,
          status: "active",
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
          uplinkBytes: existing.status === "deleted" ? 0n : existing.lastUplinkBytes,
          downlinkBytes: existing.status === "deleted" ? 0n : existing.lastDownlinkBytes,
          sampledAt: existing.lastSyncedAt ?? baseline.sampledAt,
          replaceExisting: existing.status === "deleted"
        });
      }
      await this.queuePanelEnsureJobForBinding(binding, input);
      return binding;
    }

    const binding = await this.createPanelClientBindingOrRecover({
      id: createId("panel_client"),
      subscriptionId: input.subscriptionId,
      userId: input.userId,
      teamId: input.teamId,
      nodeId: input.node.id,
      panelClientEmail,
      panelClientId,
      panelInboundId: resolvedPanelInboundId,
      lastUplinkBytes: baseline.uplinkBytes,
      lastDownlinkBytes: baseline.downlinkBytes,
      lastSyncedAt: baseline.sampledAt,
      status: "active"
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
    await this.queuePanelEnsureJobForBinding(binding, input);
    return binding;
  }

  private async queuePanelEnsureJobForBinding(
    binding: {
      id: string;
      subscriptionId: string;
      userId: string | null;
      teamId: string | null;
      nodeId: string;
      panelClientEmail: string;
      panelClientId: string;
      panelInboundId: number;
    },
    input: {
      node: {
        panelBaseUrl: string | null;
        panelApiBasePath: string | null;
        panelUsername: string | null;
        panelPassword: string | null;
      };
    }
  ) {
    const now = new Date();
    const dedupeKey = `ensure:${binding.id}`;
    await createOrRefreshPanelSyncJob(this.prisma, dedupeKey, {
      create: {
        id: randomUUID(),
        dedupeKey,
        action: "ensure_client",
        bindingId: binding.id,
        subscriptionId: binding.subscriptionId,
        userId: binding.userId,
        teamId: binding.teamId,
        nodeId: binding.nodeId,
        panelClientEmail: binding.panelClientEmail,
        panelClientId: binding.panelClientId,
        panelInboundId: binding.panelInboundId,
        panelBaseUrl: input.node.panelBaseUrl,
        panelApiBasePath: input.node.panelApiBasePath,
        panelUsername: input.node.panelUsername,
        panelPassword: input.node.panelPassword,
        status: "pending",
        nextRunAt: now
      },
      update: {
        status: "pending",
        nextRunAt: now,
        lockedAt: null,
        completedAt: null,
        attempts: 0,
        lastError: null,
        subscriptionId: binding.subscriptionId,
        userId: binding.userId,
        teamId: binding.teamId,
        nodeId: binding.nodeId,
        panelClientEmail: binding.panelClientEmail,
        panelClientId: binding.panelClientId,
        panelInboundId: binding.panelInboundId,
        panelBaseUrl: input.node.panelBaseUrl,
        panelApiBasePath: input.node.panelApiBasePath,
        panelUsername: input.node.panelUsername,
        panelPassword: input.node.panelPassword
      }
    });
  }

  private async createPanelClientBindingOrRecover(data: {
    id: string;
    subscriptionId: string;
    userId: string;
    teamId: string | null;
    nodeId: string;
    panelClientEmail: string;
    panelClientId: string;
    panelInboundId: number;
    lastUplinkBytes: bigint;
    lastDownlinkBytes: bigint;
    lastSyncedAt: Date;
    status: string;
  }) {
    try {
      return await this.prisma.panelClientBinding.create({ data });
    } catch (error) {
      if (!isPrismaUniqueConstraintError(error)) {
        throw error;
      }
    }

    const existing: any = await this.prisma.panelClientBinding.findFirst({
      where: {
        subscriptionId: data.subscriptionId,
        nodeId: data.nodeId,
        userId: data.userId
      },
      orderBy: { createdAt: "desc" }
    });
    if (!existing) {
      throw new BadGatewayException("Panel client binding was created concurrently but could not be reloaded.");
    }
    return this.prisma.panelClientBinding.update({
      where: { id: existing.id },
      data: {
        teamId: data.teamId,
        panelClientEmail: data.panelClientEmail,
        panelClientId: data.panelClientId,
        panelInboundId: data.panelInboundId,
        lastUplinkBytes: data.lastUplinkBytes,
        lastDownlinkBytes: data.lastDownlinkBytes,
        lastSyncedAt: data.lastSyncedAt,
        status: "active"
      }
    });
  }

  private async ensureTrafficSnapshotBaseline(input: {
    nodeId: string;
    subscriptionId: string;
    userId: string | null;
    teamId: string | null;
    uplinkBytes: bigint;
    downlinkBytes: bigint;
    sampledAt?: Date;
    replaceExisting?: boolean;
  }) {
    const snapshotKey = buildSnapshotKey(input.nodeId, input.subscriptionId, input.userId);
    const sampledAt = input.sampledAt ?? new Date();
    const totalBytes = input.uplinkBytes + input.downlinkBytes;
    const current = await this.prisma.trafficSnapshot.findUnique({
      where: { snapshotKey }
    });
    if (current && !input.replaceExisting) {
      return;
    }
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

  private async evictExceededUserLeases(userId: string, maxConcurrentSessions: number, reservedSlots: number) {
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

    const evictCount = activeLeases.length - maxConcurrentSessions + reservedSlots;
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
      await revokeAndThrow("当前订阅不存在，连接已失效", "subscription_missing");
    }
    const ensuredSubscription = subscription as NonNullable<typeof subscription>;

    if (ensuredSubscription.userId) {
      if (ensuredSubscription.userId !== userId) {
        await revokeAndThrow("当前会话不属于该账号", "subscription_owner_mismatch");
      }
      if (!ensuredSubscription.user || ensuredSubscription.user.status !== "active") {
        await revokeAndThrow("当前账号已禁用，连接已失效", "subscription_user_disabled");
      }
    } else if (ensuredSubscription.teamId) {
      const membership = await this.prisma.teamMember.findUnique({
        where: { userId },
        include: {
          team: true
        }
      });
      if (!membership || !membership.team || membership.teamId !== ensuredSubscription.teamId) {
        await revokeAndThrow("当前成员已失去团队访问权限，连接已失效", "team_membership_missing");
        return;
      }
      if (membership.team.status !== "active") {
        await revokeAndThrow("当前团队已停用，连接已失效", "team_disabled");
        return;
      }
    } else {
      await revokeAndThrow("当前订阅缺少归属信息，连接已失效", "subscription_owner_missing");
    }

    if (ensuredSubscription.nodeAccesses.length === 0) {
      await revokeAndThrow("当前节点授权已取消，连接已失效", "node_access_revoked");
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
      await revokeAndThrow("当前节点客户端已停用，连接已失效", "panel_client_disabled");
      return;
    }

    if (
      binding.panelClientEmail !== lease.xrayUserEmail ||
      binding.panelClientId !== lease.xrayUserUuid
    ) {
      await revokeAndThrow("当前节点客户端凭据已更新，连接已失效", "panel_client_rotated");
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
    try {
      this.clientRuntimeEventsService.publishToUser(lease.userId, {
        type: toClientRuntimeEventType(details.reasonCode),
        occurredAt: new Date().toISOString(),
        sessionId: lease.sessionId,
        subscriptionId: lease.subscriptionId,
        nodeId: lease.nodeId,
        reasonCode: details.reasonCode,
        reasonMessage: details.reasonMessage
      });
    } catch (error) {
      this.logger.warn(`Lease ${lease.id} was revoked, but runtime event publish failed: ${readRuntimeErrorMessage(error)}`);
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
    const rows = await this.prisma.subscription.findMany({
      where: {
        userId
      },
      include: { plan: true, user: true, team: true },
      orderBy: [{ expireAt: "desc" }, { createdAt: "desc" }]
    });
    return pickCurrentSubscription(rows);
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
      mldsa65Verify?: string | null;
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
      spiderX: lease.node.spiderX,
      mldsa65Verify: lease.node.mldsa65Verify ?? null
    }
  };
}

function createId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function readRuntimeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function assertRuntimeAccessConnectable(access: ResolvedSubscriptionAccess) {
  const subscription = access.subscription;
  if (!subscription) {
    throw new NotFoundException("Current subscription is unavailable.");
  }
  if (subscription.user?.status === "disabled") {
    throw new ForbiddenException("Current account is disabled.");
  }
  if (access.team?.status && access.team.status !== "active") {
    throw new ForbiddenException("Current team is disabled.");
  }
  if (subscription.team?.status && subscription.team.status !== "active") {
    throw new ForbiddenException("Current team is disabled.");
  }
}

function deriveUserAdvisoryLockKey(userId: string) {
  return createHash("sha256").update(userId).digest().readInt32BE(0);
}

function buildLeaseRevocationJobKey(
  subscriptionId: string,
  reason: string,
  userId: string | null,
  nodeId: string | null
) {
  return `lease:${subscriptionId}:${reason}:${userId ?? "*"}:${nodeId ?? "*"}`;
}

function isPrismaUniqueConstraintError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

function isPanelSyncAction(action: string): action is PanelSyncAction {
  return ["ensure_client", "disable_client", "delete_client", "reset_client_traffic"].includes(action);
}

function readPanelSyncJobTimeoutMs() {
  const parsed = Number(process.env.CHORDV_PANEL_SYNC_JOB_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_PANEL_SYNC_JOB_TIMEOUT_MS;
}

function readPanelSyncJobConcurrency() {
  const parsed = Number(process.env.CHORDV_PANEL_SYNC_JOB_CONCURRENCY);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : DEFAULT_PANEL_SYNC_JOB_CONCURRENCY;
}

function isPanelDisableJobClearableAfterNodeReenabled(
  job: {
    userId: string | null;
    teamId: string | null;
    binding: {
      status: string;
      user?: { status: "active" | "disabled" } | null;
    };
    node: {
      isActive: boolean;
      panelEnabled: boolean;
    };
    subscription: {
      userId: string | null;
      teamId: string | null;
      state: "active" | "expired" | "exhausted" | "paused";
      expireAt: Date;
      remainingTrafficGb: number;
      user?: { status: "active" | "disabled" } | null;
      team?: { status: TeamStatus } | null;
      nodeAccesses: Array<{ nodeId: string }>;
    };
  },
  activeMemberships: Set<string>
) {
  if (job.binding.status !== "active") {
    return false;
  }
  if (!job.node.isActive || !job.node.panelEnabled) {
    return false;
  }
  if (
    job.subscription.state !== "active" ||
    job.subscription.expireAt.getTime() <= Date.now() ||
    job.subscription.remainingTrafficGb <= 0 ||
    job.subscription.nodeAccesses.length === 0
  ) {
    return false;
  }
  if (job.subscription.userId) {
    return job.subscription.user?.status === "active";
  }
  if (job.subscription.teamId) {
    if (job.subscription.team?.status !== "active" || job.binding.user?.status !== "active") {
      return false;
    }
    if (!job.userId || !job.teamId) {
      return false;
    }
    return activeMemberships.has(`${job.teamId}:${job.userId}`);
  }
  return false;
}
