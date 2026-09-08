import { isNodeOnboardingReady } from "./node-onboarding-policy";
import { workLifecycle, DrainableJob } from "../../work-lifecycle";
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException
} from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { Client as PgClient } from "pg";
import type {
  AgentCommandDto,
  ConnectRequestDto,
  NodeAgentCommandType,
  GeneratedRuntimeConfigDto,
  TeamMemberRole,
  TeamStatus,
  UserProfileDto
} from "@chordv/shared";
import { METERING_REASON_NODE_UNAVAILABLE } from "./metering.constants";
import { AuthSessionService } from "./auth-session.service";
import { AdminRuntimeEventsService } from "./admin-runtime-events.service";
import { ClientRuntimeEventsService } from "./client-runtime-events.service";
import { ClientRoutingRuleService } from "./client-routing-rule.service";
import { MeteringIncidentService } from "./metering-incident.service";
import { PrismaService } from "./prisma.service";
import { readMemberUsedTrafficGb } from "./member-traffic-usage";
import { throwLocalReadAsServiceUnavailable, throwLocalSaveAsServiceUnavailable } from "./prisma-error.utils";
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
import { canServeManagedClients, usesAgentControl, usesAgentShadowMetering, type NodeControlModeValue } from "./node-control-mode";
import { createOrRefreshLeaseRevocationJob } from "./lease-revocation-job.utils";
import { createOrRefreshNodeCommandJob } from "./node-command-job.utils";
import { trafficGbNumberToBytes } from "./traffic-bytes.utils";
import { AgentEventsService } from "../agent/agent-events.service";

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
const NODE_PANEL_BINDING_SUBSCRIPTION_TIMEOUT_MS = 300;
const DIRECT_OFFLINE_ALLOWANCE_BYTES = 64n * 1024n * 1024n;
const CONNECT_PANEL_RUNTIME_READ_TIMEOUT_MS = Number(process.env.CHORDV_CONNECT_PANEL_RUNTIME_READ_TIMEOUT_MS ?? 1500);

type PanelBindingFilter = {
  userId?: string;
  nodeIds?: string[];
  statuses?: string[];
};

type PanelSyncAction = "ensure_client" | "disable_client" | "delete_client" | "reset_client_traffic";

const DEFAULT_PANEL_TRAFFIC_RESET_CONFIRM_MAX_BYTES = 16n * 1024n * 1024n;
const LEASE_REVOCATION_BATCH_SIZE = Number(process.env.CHORDV_LEASE_REVOCATION_BATCH_SIZE ?? 50);
const DEFAULT_LEASE_REVOCATION_JOB_CONCURRENCY = 4;
const DEFAULT_LEASE_REVOCATION_JOB_TIMEOUT_MS = 30_000;
const LEASE_REVOCATION_RETRY_BASE_SECONDS = Number(process.env.CHORDV_LEASE_REVOCATION_RETRY_BASE_SECONDS ?? 15);
const LEASE_REVOCATION_RETRY_MAX_SECONDS = Number(process.env.CHORDV_LEASE_REVOCATION_RETRY_MAX_SECONDS ?? 900);
const CONNECT_LOCK_KEY_1 = 420_702;
const DEFAULT_CONNECT_LOCK_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_CONNECT_LOCK_RETRY_INTERVAL_MS = 100;

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
    private readonly clientRoutingRuleService: ClientRoutingRuleService,
    private readonly adminRuntimeEventsService: AdminRuntimeEventsService,
    private readonly agentEventsService: AgentEventsService
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

      const lockClient = new PgClient({
        connectionString,
        connectionTimeoutMillis: readPositiveIntegerEnv(
          "CHORDV_CONNECT_LOCK_CONNECT_TIMEOUT_MS",
          readConnectLockWaitTimeoutMs()
        )
      });
      let locked = false;
      const userLockKey = deriveUserAdvisoryLockKey(userId);
      try {
        try {
          await lockClient.connect();
          await acquirePgAdvisoryLock(lockClient, "runtime connection", [CONNECT_LOCK_KEY_1, userLockKey]);
        } catch (error) {
          if (error instanceof HttpException) {
            throw error;
          }
          throw new ServiceUnavailableException("连接锁暂时不可用，请稍后重试。");
        }
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
    try {
    const node = await this.prisma.node.findUnique({
      where: { id: request.nodeId }
    });

    if (!node) {
      throw new NotFoundException("节点不存在");
    }
    if (!node.isActive) {
      throw new ForbiddenException("当前节点已禁用");
    }
    if (!isNodeOnboardingReady(node)) {
      throw new ForbiddenException("当前节点尚未完成 Agent 注册或入站配置");
    }
    if (!usesAgentControl(node.controlMode)) {
      throw new ForbiddenException("当前节点控制模式不可用");
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
        throw new NotFoundException("当前没有可用订阅");
      }

      if (access.subscription.id !== lockedSubscriptionId) {
        throw new ForbiddenException("当前订阅状态已变化，请重新连接。");
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
            controlMode: "direct_primary"
          }
        }
      });
      if (allowedRows.length === 0) {
        throw new ForbiddenException("当前节点已被取消授权");
      }

      const customRoutingRules = await this.readEnabledCustomRoutingRulesBestEffort(user.id);

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

      return this.connectWithManagedNode(node, user, access, request, policy, customRoutingRules);
      });
    });
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "连接状态暂时不可用，请稍后重试。");
    }
  }

  async enforceUserConcurrentLeaseLimit(userId: string, maxConcurrentSessions: number) {
    const limit = Math.max(1, Math.trunc(maxConcurrentSessions));
    return this.runWithDistributedUserLeaseLock(userId, () => this.evictExceededUserLeases(userId, limit, 0));
  }

  async heartbeatSession(sessionId: string, token?: string) {
    try {
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
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "连接心跳暂时不可用，请稍后重试。");
    }
  }

  async disconnect(sessionId: string, token?: string) {
    try {
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
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "断开连接暂时不可用，请稍后重试。");
    }
  }

  async getActiveRuntime(sessionId?: string, token?: string) {
    try {
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
    const customRoutingRules = await this.readEnabledCustomRoutingRulesBestEffort(user.id);

    return buildRuntimeFromLease(lease, policy, customRoutingRules);
    } catch (error) {
      throwLocalReadAsServiceUnavailable(error, "运行配置暂时不可用，请稍后重试。");
    }
  }

  getActiveRuntimeUsageContext() {
    return this.activeRuntimeUsageContext ?? null;
  }

  private async readEnabledCustomRoutingRulesBestEffort(userId: string): Promise<GeneratedRuntimeConfigDto["customRoutingRules"]> {
    try {
      const service = this.clientRoutingRuleService as ClientRoutingRuleService | undefined;
      return service ? await service.listEnabledRulesForUserId(userId) : [];
    } catch (error) {
      this.logger.warn(`Custom routing rules unavailable; continue with built-in routing. ${readRuntimeErrorMessage(error)}`);
      return [];
    }
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

  async queueDirectSubscriptionAccessSync(subscriptionId: string) {
    return this.syncSubscriptionPanelAccessLocked(subscriptionId, {
      ensureOnly: true
    });
  }

  async quiesceDirectBindingsForTrafficReset(subscriptionId: string, userId?: string | null) {
    const outcome = await this.prisma.$transaction(async (writer) => {
      const bindings = await writer.panelClientBinding.findMany({
        where: {
          subscriptionId,
          source: "direct",
          status: "active",
          ...(userId ? { userId } : {})
        }
      });
      const commands: Array<{ agentId: string; command: AgentCommandDto }> = [];
      for (const binding of bindings) {
        const queued = await this.queueDirectBindingCommand(writer, binding, "DISABLE_USER", {
          bindingId: binding.id,
          userKey: binding.panelClientEmail,
          email: binding.panelClientEmail,
          uuid: binding.panelClientId,
          reason: "traffic_reset_boundary"
        }, { publish: false });
        commands.push(queued);
      }
      await markPanelBindingsDisabledLocally(writer, bindings.map((binding) => binding.id));
      return { bindingIds: bindings.map((binding) => binding.id), commands };
    });
    for (const queued of outcome.commands) this.agentEventsService.publish(queued.agentId, queued.command);
    return outcome.bindingIds;
  }

  private async syncSubscriptionPanelAccessLocked(
    subscriptionId: string,
    options?: {
      writer?: any;
      ensureOnly?: boolean;
    }
  ) {
    const writer = options?.writer ?? this.prisma;
    const subscription = await writer.subscription.findUnique({
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

    let updatedBindingCount = 0;

    // Every node serves through the agent now; a node is servable when it is
    // active and its inbound was deployed.
    const allowedNodeIds = new Set(
      subscription.nodeAccesses
        .filter((item: any) => item.node.isActive && isNodeOnboardingReady(item.node))
        .map((item: any) => item.nodeId)
    );
    const bindings = options?.ensureOnly
      ? []
      : await writer.panelClientBinding.findMany({
          where: {
            subscriptionId
          }
        });
    const activeTeamMemberIds =
      subscription.teamId && subscription.team
        ? new Set(subscription.team.members.filter((item: any) => item.user.status === "active").map((item: any) => item.userId))
        : null;
    // The shared eligibility predicate carries the team/account status and
    // effective-quota checks (a disabled team's active subscription must NOT
    // re-provision credentials the team shutdown disabled).
    const shouldProvision = shouldProvisionPanelClients(subscription);
    const shouldDeleteAll = shouldDeletePanelClients(subscription);

    if (shouldDeleteAll) {
      if (options?.ensureOnly) {
        return 0;
      }
      const removeResult = await this.removePanelBindingsForSubscription(subscriptionId);
      this.assertPanelBindingMutation("删除节点客户端失败", removeResult);
      return removeResult.updated;
    }

    for (const binding of bindings) {
      const invalidByNode = !allowedNodeIds.has(binding.nodeId);
      const invalidByUser = activeTeamMemberIds ? !activeTeamMemberIds.has(binding.userId ?? "") : false;
      if (invalidByUser) {
        await this.queueLeaseRevocationJobsForSubscriptionTx(writer, subscriptionId, "team_member_removed", {
          userId: binding.userId ?? undefined,
          nodeIds: [binding.nodeId]
        });
        updatedBindingCount += await this.markPanelBindingsDisabledForSubscription(subscriptionId, {
          userId: binding.userId ?? undefined,
          nodeIds: [binding.nodeId]
        });
        continue;
      }
      if (invalidByNode || !shouldProvision) {
        if (binding.status !== "active") {
          continue;
        }
        await this.queueLeaseRevocationJobsForSubscriptionTx(
          writer,
          subscriptionId,
          invalidByNode ? "node_access_revoked" : "subscription_inactive",
          {
            userId: binding.userId ?? undefined,
            nodeIds: [binding.nodeId]
          }
        );
        updatedBindingCount += await this.markPanelBindingsDisabledForSubscription(subscriptionId, {
          userId: binding.userId ?? undefined,
          nodeIds: [binding.nodeId]
        });
      }
    }

    if (!shouldProvision) {
      return updatedBindingCount;
    }

    const targets =
      subscription.teamId && subscription.team
        ? subscription.team.members
            .filter((item: any) => item.user.status === "active")
            .map((item: any) => ({
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
        if (!access.node.isActive || !isNodeOnboardingReady(access.node)) {
          continue;
        }
        const binding = await this.ensurePanelClientBinding(writer, {
          node: {
            id: access.node.id,
            name: access.node.name,
            flow: access.node.flow,
            controlMode: access.node.controlMode
          },
          subscriptionId,
          userId: target.userId,
          teamId: target.teamId,
          userEmail: target.userEmail,
          userDisplayName: target.userDisplayName,
          expireAt: subscription.expireAt
        });
        if (binding) {
          updatedBindingCount += 1;
        }
      }
    }
    return updatedBindingCount;
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

    return this.revokeLeasesBestEffort(activeLeases, reason);
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

    return this.revokeLeasesBestEffort(activeLeases, reason);
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

    return this.revokeLeasesBestEffort(activeLeases, reason);
  }

  private async revokeLeasesBestEffort(
    leases: Array<{ id: string; sessionId?: string; userId?: string; subscriptionId?: string; nodeId?: string; node: { id: string; flow: string } }>,
    reason: string
  ) {
    let revokedCount = 0;
    for (const lease of leases) {
      try {
        await this.revokeLease(lease.id, lease.node, reason);
        revokedCount += 1;
      } catch (error) {
        this.logger.warn(
          `Lease revocation skipped after local failure (${lease.id}/${lease.subscriptionId ?? "-"}/${lease.nodeId ?? "-"}): ${readRuntimeErrorMessage(error)}`
        );
      }
    }
    return revokedCount;
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
      }
    });
    if (bindings.length === 0) {
      return 0;
    }
    const now = new Date();
    let queuedCount = 0;

    // Every binding serves through its node's agent: disable = DISABLE_USER.
    for (const binding of bindings) {
      await this.queueDirectBindingCommand(writer, binding, "DISABLE_USER", {
        bindingId: binding.id,
        userKey: binding.panelClientEmail,
        email: binding.panelClientEmail,
        uuid: binding.panelClientId
      });
      queuedCount += 1;
    }

    await markPanelBindingsDisabledLocally(writer, bindings.map((binding: { id: string }) => binding.id));
    this.publishSyncQueueUpdatedBestEffort({
      nodeId: filter?.nodeIds?.[0] ?? bindings[0]?.nodeId ?? null,
      subscriptionId
    });

    return queuedCount;
  }

  async queuePanelDeleteJobsForSubscriptionTx(
    writer: any,
    subscriptionId: string,
    filter?: { userId?: string; nodeIds?: string[] }
  ) {
    const bindings = await writer.panelClientBinding.findMany({
      where: {
        subscriptionId,
        ...(filter?.userId ? { userId: filter.userId } : {}),
        ...(filter?.nodeIds ? { nodeId: { in: filter.nodeIds } } : {}),
        status: { in: ["active", "disabled"] }
      }
    });
    if (bindings.length === 0) {
      return 0;
    }

    const now = new Date();
    let queuedCount = 0;
    for (const binding of bindings) {
      // Every binding serves through its node's agent: delete = REMOVE_USER.
      await this.queueDirectBindingCommand(writer, binding, "REMOVE_USER", {
        bindingId: binding.id,
        userKey: binding.panelClientEmail,
        email: binding.panelClientEmail,
        uuid: binding.panelClientId
      });
      queuedCount += 1;

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
        status: "deleted",
        directDisabledAt: now,
        directDisableWatermarks: Prisma.DbNull
      }
    });
    this.publishSyncQueueUpdatedBestEffort({
      nodeId: filter?.nodeIds?.[0] ?? bindings[0]?.nodeId ?? null,
      subscriptionId
    });

    return queuedCount;
  }

  async queueLeaseRevocationJobsForSubscription(
    subscriptionId: string,
    reason: string,
    filter?: { userId?: string; nodeIds?: string[] }
  ) {
    return this.prisma.$transaction((tx) => this.queueLeaseRevocationJobsForSubscriptionTx(tx, subscriptionId, reason, filter));
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
    this.publishSyncQueueUpdatedBestEffort({
      nodeId: nodeIds.length === 1 ? nodeIds[0] : null,
      subscriptionId
    });
    return nodeIds.length;
  }

  /**
   * Disables every active binding on a node: queue DISABLE_USER for each (the
   * agent drops the credentials; getConfig would otherwise keep serving users
   * whose credentials were issued while the node was active) and mark the
   * bindings disabled locally.
   */
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
      try {
        disabledCount += await withNodePanelBindingSubscriptionBudget(
          () => this.markPanelBindingsDisabledForSubscription(subscription.id, { nodeIds: [nodeId] }),
          `Node ${nodeId} binding disable for subscription ${subscription.id}`
        );
      } catch (error) {
        this.logger.warn(
          `Node ${nodeId} binding disable failed for subscription ${subscription.id}; remaining subscriptions will continue: ${readRuntimeErrorMessage(error)}`
        );
      }
    }
    return disabledCount;
  }

  async removePanelBindingsForSubscription(
    subscriptionId: string,
    filter?: { userId?: string; nodeIds?: string[] }
  ): Promise<PanelBindingMutationResult> {
    const requested = await this.prisma.$transaction((tx) =>
      this.queuePanelDeleteJobsForSubscriptionTx(tx, subscriptionId, filter)
    );
    return {
      requested,
      updated: requested,
      failed: []
    };
  }

  private publishSyncQueueUpdatedBestEffort(input: { nodeId?: string | null; subscriptionId?: string | null }) {
    try {
      this.adminRuntimeEventsService?.publish({
        type: "sync_queue_updated",
        occurredAt: new Date().toISOString(),
        nodeId: input.nodeId ?? null
      });
    } catch (error) {
      this.logger?.warn(
        `Sync queue change saved, but admin sync_queue_updated publish failed: ${readRuntimeErrorMessage(error)}`
      );
    }
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
  @DrainableJob()
  async retryPendingLeaseRevocationJobs() {
    try {
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

      let nextIndex = 0;
      const workerCount = Math.min(jobs.length, readLeaseRevocationJobConcurrency());
      const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
          if (workLifecycle.isDraining) return; // leave unclaimed durable jobs for the next process
          const job = jobs[nextIndex];
          nextIndex += 1;
          if (!job) {
            return;
          }
          let locked: { count: number };
          try {
            locked = await this.prisma.leaseRevocationJob.updateMany({
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
          } catch (error) {
            this.logger.warn(`Lease revocation worker could not lock job ${job.id}: ${readRuntimeErrorMessage(error)}`);
            continue;
          }
          if (locked.count === 0) {
            continue;
          }
          this.publishSyncQueueUpdatedBestEffort({
            nodeId: job.nodeId,
            subscriptionId: job.subscriptionId
          });

          try {
            await this.runLeaseRevocationJob(job);
          } catch (error) {
            this.logger.warn(
              `Lease revocation worker skipped a job after unexpected failure (${job.id}): ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        }
      });
      await workLifecycle.all(workers);
    } catch (error) {
      this.logger.warn(`Lease revocation worker batch failed: ${readRuntimeErrorMessage(error)}`);
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
        await this.runLeaseRevocationEffectWithBudget(
          job,
          this.revokeSubscriptionLeases(job.subscriptionId, job.reason, {
            ...(job.userId ? { userId: job.userId } : {}),
            ...(job.nodeId ? { nodeIds: [job.nodeId] } : {})
          })
        );
      } else if (job.userId) {
        await this.runLeaseRevocationEffectWithBudget(
          job,
          this.revokeUserLeases(job.userId, job.reason, job.nodeId ? { nodeIds: [job.nodeId] } : undefined)
        );
      } else if (job.nodeId) {
        await this.runLeaseRevocationEffectWithBudget(job, this.revokeNodeLeases(job.nodeId, job.reason));
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
      this.publishSyncQueueUpdatedBestEffort({ nodeId: job.nodeId, subscriptionId: job.subscriptionId });
    } catch (error) {
      const nextAttempts = job.attempts + 1;
      const retrySeconds = Math.min(
        LEASE_REVOCATION_RETRY_MAX_SECONDS,
        LEASE_REVOCATION_RETRY_BASE_SECONDS * 2 ** Math.min(nextAttempts - 1, 6)
      );
      const message = error instanceof Error ? error.message : "lease revocation failed";
      try {
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
        this.publishSyncQueueUpdatedBestEffort({ nodeId: job.nodeId, subscriptionId: job.subscriptionId });
      } catch (persistError) {
        this.logger.warn(
          `Lease revocation job failure state could not be saved (${job.id}): ${
            persistError instanceof Error ? persistError.message : String(persistError)
          }`
        );
      }
      this.logger.warn(`Lease revocation job failed; retrying in ${retrySeconds}s: ${job.id}: ${message}`);
    }
  }

  private async runLeaseRevocationEffectWithBudget(
    job: { id: string; reason: string; subscriptionId: string | null; userId: string | null; nodeId: string | null },
    task: Promise<unknown>
  ) {
    // A task that settles after its budget (or never) must not surface as an
    // unhandled rejection; its late failure is the retry path's concern.
    void task.catch((error) => {
      this.logger.warn(
        `Delayed lease revocation effect failed after timeout or retry handoff (${job.id}/${job.reason}/${job.subscriptionId ?? "-"}/${job.userId ?? "-"}/${job.nodeId ?? "-"}): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });

    // Accounting covers only the awaiting window: a hung effect is handed back
    // to the retry path instead of holding a work item until it settles.
    const timeoutMs = readLeaseRevocationJobTimeoutMs();
    return await workLifecycle.awaitWithBudget(
      task,
      timeoutMs,
      () => new LeaseRevocationEffectTimeoutError(timeoutMs)
    );
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

  async queueActiveLeaseSyncForSubscription(subscription: {
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

    return this.queueLeaseRevocationJobsForSubscription(subscription.id, reason);
  }

  @Cron("*/30 * * * * *")
  @DrainableJob()
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

  async queueLeaseRevocationJobForNode(nodeId: string, reason: string) {
    const now = new Date();
    const dedupeKey = buildNodeLeaseRevocationJobKey(nodeId, reason);
    await createOrRefreshLeaseRevocationJob(this.prisma, dedupeKey, {
      create: {
        id: randomUUID(),
        dedupeKey,
        subscriptionId: null,
        userId: null,
        nodeId,
        reason,
        status: "pending",
        nextRunAt: now
      },
      update: {
        subscriptionId: null,
        userId: null,
        nodeId,
        reason,
        status: "pending",
        nextRunAt: now,
        lockedAt: null,
        completedAt: null,
        attempts: 0,
        lastError: null
      }
    });
    this.publishSyncQueueUpdatedBestEffort({ nodeId, subscriptionId: null });
  }

  private async connectWithManagedNode(
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
      controlMode: NodeControlModeValue;
    },
    user: UserProfileDto,
    access: ResolvedSubscriptionAccess,
    request: ConnectRequestDto,
    policy: {
      blockAds: boolean;
      chinaDirect: boolean;
      aiServicesProxy: boolean;
    } | null,
    customRoutingRules: GeneratedRuntimeConfigDto["customRoutingRules"] = []
  ): Promise<GeneratedRuntimeConfigDto> {
    const now = new Date();
    const sessionId = `session_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const leaseId = createId("lease");
    const leaseExpiresAt = new Date(now.getTime() + LEASE_TTL_SECONDS * 1000);
    const subscription = access.subscription;
    if (!subscription) {
      throw new NotFoundException("当前没有可用订阅");
    }
    const binding = await this.ensurePanelClientBinding(this.prisma, {
      node,
      subscriptionId: subscription.id,
      userId: user.id,
      teamId: subscription.teamId,
      userEmail: user.email,
      userDisplayName: user.displayName,
      expireAt: subscription.expireAt
    });
    const inboundRuntime = await this.readConnectInboundRuntimeBestEffort(node);
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
      customRoutingRules,
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

    await this.updateConnectedNodeRuntimeBestEffort(node.id, effectiveNode, inboundRuntime);
    if (inboundRuntime.ok) {
      await this.resolveNodeMeteringIncidentBestEffort(subscription.id, node.id);
    }
    return runtime;
  }

  private async updateConnectedNodeRuntimeBestEffort(
    nodeId: string,
    effectiveNode: {
      serverHost: string;
      serverPort: number;
      uuid: string;
      flow: string;
      realityPublicKey: string;
      shortId: string;
      serverName: string;
      fingerprint: string;
      spiderX: string;
      mldsa65Verify?: string | null;
    },
    inboundRuntime: { ok: boolean; errorMessage?: string | null }
  ) {
    try {
      await this.prisma.node.update({
        where: { id: nodeId },
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
          mldsa65Verify: effectiveNode.mldsa65Verify ?? "",
          controlStatus: inboundRuntime.ok ? "online" : "degraded"
        }
      });
    } catch (error) {
      this.logger.warn(`Runtime lease created, but node runtime cache update failed: ${readRuntimeErrorMessage(error)}`);
    }
  }

  private async resolveNodeMeteringIncidentBestEffort(subscriptionId: string, nodeId: string) {
    try {
      await this.meteringIncidentService.resolve(subscriptionId, nodeId, METERING_REASON_NODE_UNAVAILABLE);
    } catch (error) {
      this.logger.warn(`Runtime lease created, but metering incident resolve failed: ${readRuntimeErrorMessage(error)}`);
    }
  }

  private async readConnectInboundRuntimeBestEffort(node: {
    serverHost: string;
    serverPort: number;
    uuid: string;
    flow: string;
    realityPublicKey: string;
    shortId: string;
    serverName: string;
    fingerprint: string;
    spiderX: string;
    mldsa65Verify?: string | null;
  }) {
    // Connection parameters come from the agent's inbound report; the cached
    // node row IS the runtime truth now.
    this.assertCachedNodeRuntimeUsable(node);
    return {
      ok: true as const,
      errorMessage: null,
      serverHost: node.serverHost,
      serverPort: node.serverPort,
      uuid: node.uuid,
      flow: node.flow,
      realityPublicKey: node.realityPublicKey,
      shortId: node.shortId,
      serverName: node.serverName,
      fingerprint: node.fingerprint,
      spiderX: node.spiderX,
      mldsa65Verify: node.mldsa65Verify ?? null
    };
  }

  private assertCachedNodeRuntimeUsable(node: {
    serverHost: string;
    serverPort: number;
    realityPublicKey: string;
    serverName: string;
    fingerprint: string;
    spiderX: string;
  }) {
    if (!node.serverHost.trim() || !Number.isFinite(node.serverPort) || node.serverPort <= 0) {
      throw new BadGatewayException("Cached node runtime is incomplete: server address is missing.");
    }
    if (!node.realityPublicKey.trim() || !node.serverName.trim() || !node.fingerprint.trim() || !node.spiderX.trim()) {
      throw new BadGatewayException("Cached node runtime is incomplete: reality settings are missing.");
    }
  }

  private async ensurePanelClientBinding(writer: any, input: {
    node: {
      id: string;
      name: string;
      flow: string;
      controlMode: NodeControlModeValue;
    };
    subscriptionId: string;
    userId: string;
    teamId: string | null;
    userEmail: string;
    userDisplayName: string;
    expireAt: Date;
  }) {
    if (!usesAgentControl(input.node.controlMode)) {
      throw new BadRequestException("节点控制模式不可用");
    }

    const existing = await writer.panelClientBinding.findFirst({
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
      existing && existing.status !== "deleted" ? existing.panelInboundId : null;

    return this.ensurePanelClientBindingLocally(writer, input, existing, panelClientEmail, panelClientId, panelInboundId);
  }

  private async ensurePanelClientBindingLocally(
    writer: any,
    input: {
      node: {
        id: string;
        name: string;
        flow: string;
        controlMode: NodeControlModeValue;
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
      if (existing.status === "deleted" || existing.status === "disabled") {
        await assertDirectTerminalWatermarksSettled(writer, existing);
      }
      const refreshShadowConfig = usesAgentShadowMetering(input.node.controlMode) && (
        existing.status !== "active" ||
        existing.panelClientEmail !== panelClientEmail ||
        existing.panelClientId !== panelClientId ||
        existing.teamId !== input.teamId
      );
      const binding = await writer.panelClientBinding.update({
        where: { id: existing.id },
        data: {
          panelClientEmail,
          panelClientId,
          panelInboundId: existing.status === "deleted" ? resolvedPanelInboundId : panelInboundId ?? existing.panelInboundId,
          status: "active",
          directDisabledAt: null,
          directDisableWatermarks: Prisma.DbNull,
          teamId: input.teamId,
          source: "direct" as const
        }
      });
      const snapshot = await writer.trafficSnapshot.findUnique({
        where: {
          snapshotKey: buildSnapshotKey(binding.nodeId, binding.subscriptionId, binding.userId)
        }
      });
      if (existing.status === "deleted" || !snapshot) {
        await this.ensureTrafficSnapshotBaseline(writer, {
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
      await this.queuePanelEnsureJobForBinding(writer, binding, input);
      if (refreshShadowConfig) await this.bumpShadowAgentConfigRevision(writer, [binding.nodeId]);
      return { ...binding, cachedRemoteClient: existing.status !== "deleted" };
    }

    const recovered = await this.createPanelClientBindingOrRecover(writer, {
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
      status: "active",
      source: usesAgentControl(input.node.controlMode) ? "direct" : "xui"
    });
    const binding = recovered.binding;
    await this.ensureTrafficSnapshotBaseline(writer, {
      nodeId: binding.nodeId,
      subscriptionId: binding.subscriptionId,
      userId: binding.userId,
      teamId: binding.teamId,
      uplinkBytes: baseline.uplinkBytes,
      downlinkBytes: baseline.downlinkBytes,
      sampledAt: baseline.sampledAt
    });
    await this.queuePanelEnsureJobForBinding(writer, binding, input);
    if (usesAgentShadowMetering(input.node.controlMode) && !recovered.cachedRemoteClient) {
      await this.bumpShadowAgentConfigRevision(writer, [binding.nodeId]);
    }
    return { ...binding, cachedRemoteClient: recovered.cachedRemoteClient };
  }

  private async bumpShadowAgentConfigRevision(writer: any, nodeIds: string[]) {
    const uniqueNodeIds = Array.from(new Set(nodeIds.filter(Boolean)));
    if (uniqueNodeIds.length === 0) return;
    await writer.node.updateMany({
      where: { id: { in: uniqueNodeIds }, controlMode: "shadow_direct" },
      data: { agentConfigRevision: { increment: 1n } }
    });
  }

  private async queuePanelEnsureJobForBinding(
    writer: any,
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
        flow: string;
      };
      expireAt: Date;
    }
  ) {
    // Every binding serves through its node's agent: ensure = ENSURE_USER.
    const subscription = await writer.subscription.findUnique({
      where: { id: binding.subscriptionId },
      select: { totalTrafficBytes: true, usedTrafficBytes: true, remainingTrafficGb: true }
    });
    if (!subscription) {
      throw new NotFoundException("Direct 用户绑定对应的订阅不存在");
    }
    await this.queueDirectBindingCommand(writer, binding, "ENSURE_USER", {
      bindingId: binding.id,
      userKey: binding.panelClientEmail,
      email: binding.panelClientEmail,
      uuid: binding.panelClientId,
      flow: input.node.flow,
      expiresAt: input.expireAt.toISOString(),
      ...buildDirectUserQuotaPayload(subscription)
    });
  }

  private async queueDirectBindingCommand(
    writer: any,
    binding: {
      id: string;
      nodeId: string;
      subscriptionId: string;
      userId: string | null;
      teamId: string | null;
      panelClientEmail: string;
      panelClientId: string;
    },
    // Imported rather than re-listed: this union drifted from the shared type
    // once already, and a missing member here silently blocks a command kind.
    commandType: NodeAgentCommandType,
    payload: Record<string, unknown>,
    options: { publish?: boolean } = {}
  ) {
    const nodeRevision = await writer.node.update({
      where: { id: binding.nodeId },
      data: { agentConfigRevision: { increment: 1n } },
      select: { agentConfigRevision: true }
    });
    const updated = await writer.panelClientBinding.update({
      where: { id: binding.id },
      data: {
        source: "direct",
        directRevision: nodeRevision.agentConfigRevision
      }
    });
    const agent = await writer.nodeAgent.findFirst({
      where: { nodeId: binding.nodeId, revokedAt: null },
      orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }]
    });
    if (!agent) {
      throw new ServiceUnavailableException("该节点尚未配置有效的 Node Agent 凭据");
    }
    const dedupeKey = `agent:${commandType.toLowerCase()}:${binding.id}:${updated.directRevision.toString()}`;
    const now = new Date();
    const job = await createOrRefreshNodeCommandJob(writer, dedupeKey, {
      create: {
        id: randomUUID(),
        dedupeKey,
        nodeId: binding.nodeId,
        agentId: agent.id,
        commandType,
        targetRevision: updated.directRevision,
        payload,
        status: "pending",
        nextRunAt: now
      },
      update: {
        agentId: agent.id,
        commandType,
        targetRevision: updated.directRevision,
        payload,
        status: "pending",
        nextRunAt: now,
        lockedAt: null,
        completedAt: null,
        attempts: 0,
        lastError: null,
        result: null
      }
    });
    const command = {
      commandId: job.id,
      type: job.commandType,
      targetRevision: job.targetRevision.toString(),
      payload: job.payload as Record<string, unknown>,
      createdAt: job.createdAt.toISOString()
    } satisfies AgentCommandDto;
    if (options.publish !== false) this.agentEventsService.publish(agent.id, command);
    this.publishSyncQueueUpdatedBestEffort({
      nodeId: binding.nodeId,
      subscriptionId: binding.subscriptionId
    });
    return { agentId: agent.id, command };
  }

  private async createPanelClientBindingOrRecover(writer: any, data: {
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
    source: "xui" | "direct";
    directRevision?: bigint;
  }) {
    const existing: any = await writer.panelClientBinding.findFirst({
      where: {
        subscriptionId: data.subscriptionId,
        nodeId: data.nodeId,
        userId: data.userId
      },
      orderBy: { createdAt: "desc" }
    });
    if (existing) {
      const binding = await writer.panelClientBinding.update({
        where: { id: existing.id },
        data: {
          teamId: data.teamId,
          status: "active"
        }
      });
      return {
        binding,
        cachedRemoteClient: existing.status !== "deleted"
      };
    }

    if (typeof writer.panelClientBinding.create !== "function") {
      return {
        binding: await writer.panelClientBinding.upsert({
          where: {
            subscriptionId_userId_nodeId: {
              subscriptionId: data.subscriptionId,
              userId: data.userId,
              nodeId: data.nodeId
            }
          },
          create: data,
          update: {
            teamId: data.teamId,
            status: "active"
          }
        }),
        cachedRemoteClient: false
      };
    }

    try {
      return {
        binding: await writer.panelClientBinding.create({ data }),
        cachedRemoteClient: false
      };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      const recovered = await writer.panelClientBinding.findFirst({
        where: {
          subscriptionId: data.subscriptionId,
          nodeId: data.nodeId,
          userId: data.userId
        },
        orderBy: { createdAt: "desc" }
      });
      if (!recovered) {
        throw error;
      }
      const binding = await writer.panelClientBinding.update({
        where: { id: recovered.id },
        data: {
          teamId: data.teamId,
          status: "active"
        }
      });
      return {
        binding,
        cachedRemoteClient: recovered.status !== "deleted"
      };
    }
  }

  private async ensureTrafficSnapshotBaseline(writer: any, input: {
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
    const current = await writer.trafficSnapshot.findUnique({
      where: { snapshotKey }
    });
    if (current && !input.replaceExisting) {
      return;
    }
    await writer.trafficSnapshot.upsert({
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

    try {
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
    } catch (error) {
      this.logger.warn(`Lease ${lease.id} was revoked, but security event write failed: ${readRuntimeErrorMessage(error)}`);
    }

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
    return readMemberUsedTrafficGb(this.prisma, teamId, userId, subscriptionId);
  }

  private async resolveActiveUserFromToken(token?: string): Promise<UserProfileDto> {
    return this.authSessionService.authenticateAccessToken(token);
  }
}

export function buildDirectUserQuotaPayload(subscription: {
  totalTrafficBytes: bigint;
  usedTrafficBytes: bigint;
  remainingTrafficGb: number;
}) {
  const quotaRemainingBytes = subscription.totalTrafficBytes > 0n
    ? subscription.totalTrafficBytes > subscription.usedTrafficBytes
      ? subscription.totalTrafficBytes - subscription.usedTrafficBytes
      : 0n
    : trafficGbNumberToBytes(subscription.remainingTrafficGb);
  return {
    quotaRemainingBytes: quotaRemainingBytes.toString(),
    offlineAllowanceBytes: DIRECT_OFFLINE_ALLOWANCE_BYTES.toString()
  };
}

export async function assertDirectTerminalWatermarksSettled(
  writer: any,
  binding: { id: string; nodeId: string; directDisableWatermarks: Prisma.JsonValue | null }
) {
  const watermarks = parseDirectDisableWatermarks(binding.directDisableWatermarks);
  if (!watermarks) {
    throw new ConflictException(`Direct 用户停用水位尚未确认：${binding.id}`);
  }
  for (const watermark of watermarks) {
    const batch = await writer.nodeUsageBatch.findUnique({
      where: {
        nodeId_bootId_sequence: {
          nodeId: binding.nodeId,
          bootId: watermark.bootId,
          sequence: watermark.sequenceThrough
        }
      },
      select: { accountedAt: true }
    });
    if (!batch?.accountedAt) {
      throw new ConflictException(`Direct 用户停用前流量批次尚未结清：${binding.id}`);
    }
  }
}

function parseDirectDisableWatermarks(value: Prisma.JsonValue | null) {
  if (!Array.isArray(value)) return null;
  const result: Array<{ bootId: string; sequenceThrough: bigint }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const bootId = Reflect.get(item, "bootId");
    const sequenceThrough = Reflect.get(item, "sequenceThrough");
    if (typeof bootId !== "string" || typeof sequenceThrough !== "string" || !/^(0|[1-9]\d*)$/.test(sequenceThrough)) return null;
    result.push({ bootId, sequenceThrough: BigInt(sequenceThrough) });
  }
  return result;
}

function buildRuntimeFromLease(
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
  } | null,
  customRoutingRules: GeneratedRuntimeConfigDto["customRoutingRules"] = []
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
    customRoutingRules,
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

async function withNodePanelBindingSubscriptionBudget<T>(taskFactory: () => Promise<T>, label: string): Promise<T> {
  let settled = false;
  const task = Promise.resolve()
    .then(taskFactory)
    .then(
      (result) => {
        settled = true;
        return result;
      },
      (error) => {
        settled = true;
        throw error;
      }
    );
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutTask = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      if (!settled) {
        reject(new Error(`${label} exceeded ${NODE_PANEL_BINDING_SUBSCRIPTION_TIMEOUT_MS}ms; remaining subscriptions will continue`));
      }
    }, NODE_PANEL_BINDING_SUBSCRIPTION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([workLifecycle.track(task), timeoutTask]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    void task.catch(() => undefined);
  }
}

function buildNodePanelBindingFailure(nodeId: string, subscriptionId: string, error: unknown): PanelBindingFailure {
  return {
    bindingId: subscriptionId,
    nodeId,
    nodeName: nodeId,
    panelClientEmail: subscriptionId,
    error: readRuntimeErrorMessage(error)
  };
}

function assertRuntimeAccessConnectable(access: ResolvedSubscriptionAccess) {
  const subscription = access.subscription;
  if (!subscription) {
    throw new NotFoundException("当前没有可用订阅。");
  }
  if (subscription.user?.status === "disabled") {
    throw new ForbiddenException("当前账号已禁用，连接已失效。");
  }
  if (access.team?.status && access.team.status !== "active") {
    throw new ForbiddenException("当前团队已停用，连接已失效。");
  }
  if (subscription.team?.status && subscription.team.status !== "active") {
    throw new ForbiddenException("当前团队已停用，连接已失效。");
  }
}

function deriveUserAdvisoryLockKey(userId: string) {
  return createHash("sha256").update(userId).digest().readInt32BE(0);
}

async function acquirePgAdvisoryLock(client: PgClient, label: string, args: [number, number]) {
  const timeoutMs = readConnectLockWaitTimeoutMs();
  const retryIntervalMs = readConnectLockRetryIntervalMs();
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const result = await client.query("select pg_try_advisory_lock($1, $2) as locked", args);
    if (result.rows[0]?.locked === true) {
      return;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new ConflictException(`${label} is still being processed; please retry shortly.`);
    }
    await delay(Math.min(retryIntervalMs, remainingMs));
  }
}

function readConnectLockWaitTimeoutMs() {
  return readPositiveIntegerEnv("CHORDV_CONNECT_LOCK_WAIT_TIMEOUT_MS", DEFAULT_CONNECT_LOCK_WAIT_TIMEOUT_MS);
}

function readConnectLockRetryIntervalMs() {
  return readPositiveIntegerEnv("CHORDV_CONNECT_LOCK_RETRY_INTERVAL_MS", DEFAULT_CONNECT_LOCK_RETRY_INTERVAL_MS);
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildLeaseRevocationJobKey(
  subscriptionId: string,
  reason: string,
  userId: string | null,
  nodeId: string | null
) {
  return `lease:${subscriptionId}:${reason}:${userId ?? "*"}:${nodeId ?? "*"}`;
}

function buildNodeLeaseRevocationJobKey(nodeId: string, reason: string) {
  return `lease-node:${nodeId}:${reason}`;
}

function isPanelSyncAction(action: string): action is PanelSyncAction {
  return ["ensure_client", "disable_client", "delete_client", "reset_client_traffic"].includes(action);
}

function withPanelAbortBudget<
  T extends {
    panelRequestTimeoutMs?: number | null;
    panelAbortSignal?: AbortSignal | null;
  }
>(config: T, timeoutMs: number) {
  return {
    ...config,
    panelRequestTimeoutMs: timeoutMs,
    panelAbortSignal: AbortSignal.timeout(timeoutMs)
  };
}

class PanelSyncRemoteCallTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`3x-ui panel sync job remote call timed out after ${timeoutMs}ms; retry will continue in background`);
    this.name = "PanelSyncRemoteCallTimeoutError";
  }
}

class LeaseRevocationEffectTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`lease revocation effect timed out after ${timeoutMs}ms; retry will continue in background`);
    this.name = "LeaseRevocationEffectTimeoutError";
  }
}



function readPanelTrafficResetConfirmMaxBytes() {
  const parsed = Number(process.env.CHORDV_PANEL_TRAFFIC_RESET_CONFIRM_MAX_BYTES);
  return Number.isFinite(parsed) && parsed > 0
    ? BigInt(Math.floor(parsed))
    : DEFAULT_PANEL_TRAFFIC_RESET_CONFIRM_MAX_BYTES;
}

function readLeaseRevocationJobTimeoutMs() {
  const parsed = Number(process.env.CHORDV_LEASE_REVOCATION_JOB_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_LEASE_REVOCATION_JOB_TIMEOUT_MS;
}

function readLeaseRevocationJobConcurrency() {
  const parsed = Number(process.env.CHORDV_LEASE_REVOCATION_JOB_CONCURRENCY);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : DEFAULT_LEASE_REVOCATION_JOB_CONCURRENCY;
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
  if (job.binding.status !== "active" && job.binding.status !== "disabled") {
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

async function markPanelBindingsDisabledLocally(writer: any, bindingIds: string[]) {
  if (bindingIds.length === 0) {
    return;
  }
  const disabledAt = new Date();
  if (typeof writer.panelClientBinding.updateMany === "function") {
    await writer.panelClientBinding.updateMany({
      where: {
        id: { in: bindingIds },
        status: "active"
      },
      data: {
        status: "disabled",
        directDisabledAt: disabledAt,
        directDisableWatermarks: Prisma.DbNull
      }
    });
    return;
  }
  if (typeof writer.panelClientBinding.update === "function") {
    await workLifecycle.all(
      bindingIds.map((id) =>
        writer.panelClientBinding.update({
          where: { id },
          data: { status: "disabled", directDisabledAt: disabledAt, directDisableWatermarks: Prisma.DbNull }
        })
      )
    );
  }
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2002");
}
