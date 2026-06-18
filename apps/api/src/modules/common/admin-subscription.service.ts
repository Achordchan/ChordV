import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException
} from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import type {
  AdminPlanRecordDto,
  AdminSubscriptionRecordDto,
  AdminTeamRecordDto,
  AdminTeamUsageRecordDto,
  AdminUserRecordDto,
  ChangeSubscriptionPlanInputDto,
  ConvertSubscriptionToTeamInputDto,
  ConvertSubscriptionToTeamResultDto,
  CreatePlanInputDto,
  CreateSubscriptionInputDto,
  CreateTeamInputDto,
  CreateTeamMemberInputDto,
  CreateTeamSubscriptionInputDto,
  CreateUserInputDto,
  DisconnectUserResultDto,
  KickTeamMemberInputDto,
  KickTeamMemberResultDto,
  PlanScope,
  ResetSubscriptionTrafficInputDto,
  ResetSubscriptionTrafficResultDto,
  RenewSubscriptionInputDto,
  SubscriptionState,
  TeamMemberRole,
  TeamStatus,
  UpdatePlanInputDto,
  UpdatePlanSecurityInputDto,
  UpdateSubscriptionInputDto,
  UpdateTeamInputDto,
  UpdateTeamMemberInputDto,
  UpdateUserInputDto,
  UpdateUserSecurityInputDto,
  UserSubscriptionSummaryDto
} from "@chordv/shared";
import { ClientRuntimeEventsService } from "./client-runtime-events.service";
import { AdminRuntimeEventsService } from "./admin-runtime-events.service";
import { AuthSessionService } from "./auth-session.service";
import { PrismaService } from "./prisma.service";
import { RuntimeSessionService } from "./runtime-session.service";
import { runWithSubscriptionOwnerLock, runWithSubscriptionUsageLock } from "./usage-lock.utils";
import { buildSnapshotKey, DEFAULT_MAX_CONCURRENT_SESSIONS } from "./runtime-session.utils";
import { createOrRefreshPanelSyncJob } from "./panel-sync-job.utils";
import { isPrismaCodedError, toPrismaTransientHttpError } from "./prisma-error.utils";
import {
  isEffectiveSubscription,
  normalizeOptionalString,
  pickCurrentSubscription,
  readEffectiveSubscriptionState,
  resolveRenewExpireAt,
  resolveSubscriptionState,
  summarizeTeamUsageRecords,
  toAdminSubscriptionRecord,
  toAdminTeamRecord,
  toAdminUserRecord,
  toUserSubscriptionSummary
} from "./subscription.utils";

const SUBSCRIPTION_FOLLOW_UP_BUDGET_MS = 300;
const SUBSCRIPTION_DEFERRED_EFFECT_DELAY_MS = 50;
const PANEL_SYNC_RECENT_ERROR_LIMIT = 1_000;

type PanelSyncBestEffortResult = { ok: true } | { ok: false; errorMessage: string };
type AdminSubscriptionEntity = Parameters<typeof toAdminSubscriptionRecord>[0];
type PanelSyncSummaryJob = {
  subscriptionId: string;
  userId: string | null;
  teamId: string | null;
  status: string;
  lastError: string | null;
  updatedAt: Date;
  count?: number;
};
type PanelSyncSummary = {
  pending: number;
  running: number;
  failed: number;
  lastError: string | null;
};
type ResetTrafficCountersResult = {
  subscription: AdminSubscriptionEntity;
  targetUserId: string | null;
  clearedBindingCount: number;
  panelSync: PanelSyncBestEffortResult;
};
type SubscriptionWithSecurityPlan = AdminSubscriptionEntity & {
  plan: AdminSubscriptionEntity["plan"] & { maxConcurrentSessions: number };
};

@Injectable()
export class AdminSubscriptionService {
  private readonly logger = new Logger(AdminSubscriptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clientRuntimeEventsService: ClientRuntimeEventsService,
    private readonly adminRuntimeEventsService: AdminRuntimeEventsService,
    private readonly authSessionService: AuthSessionService,
    private readonly runtimeSessionService: RuntimeSessionService
  ) {}

  private async withSubscriptionFollowUpBudget<T>(
    label: string,
    timeoutResult: T,
    task: () => Promise<T>
  ): Promise<T> {
    let settled = false;
    const guardedTask = Promise.resolve()
      .then(task)
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
    void guardedTask.catch((error) => {
      this.logger?.warn(
        `Local subscription change saved, but delayed ${label} failed: ${readErrorMessage(error, "unknown error")}`
      );
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutTask = new Promise<T>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        this.logger?.warn(
          `Local subscription change saved, but ${label} exceeded ${SUBSCRIPTION_FOLLOW_UP_BUDGET_MS}ms and will continue in background.`
        );
        resolve(timeoutResult);
      }, SUBSCRIPTION_FOLLOW_UP_BUDGET_MS);
    });

    try {
      return await Promise.race([guardedTask, timeoutTask]);
    } catch (error) {
      this.logger?.warn(`Local subscription change saved, but ${label} failed: ${readErrorMessage(error, "unknown error")}`);
      return timeoutResult;
    } finally {
      if (settled && timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private startSubscriptionFollowUpInBackground(label: string, task: () => Promise<unknown>): PanelSyncBestEffortResult {
    const timer = setTimeout(() => {
      void this.withSubscriptionFollowUpBudget(label, undefined, async () => {
        try {
          await task();
        } catch (error) {
          this.logger?.warn(`Local subscription change saved, but ${label} failed: ${readErrorMessage(error, "unknown error")}`);
        }
      });
    }, SUBSCRIPTION_DEFERRED_EFFECT_DELAY_MS);
    timer.unref?.();
    return {
      ok: false,
      errorMessage: `${label} queued for background processing`
    };
  }

  private startPanelSyncResultFollowUpInBackground(
    label: string,
    task: () => Promise<PanelSyncBestEffortResult>
  ): PanelSyncBestEffortResult {
    return this.startSubscriptionFollowUpInBackground(label, async () => {
      const result = await task();
      if (!result.ok) {
        throw new Error(result.errorMessage);
      }
    });
  }

  async listAdminUsers(): Promise<AdminUserRecordDto[]> {
    const [rows, panelSyncJobs] = await Promise.all([
      this.prisma.user.findMany({
        include: {
          subscriptions: {
            include: { plan: true },
            orderBy: [{ createdAt: "desc" }]
          },
          teamMemberships: {
            include: {
              team: {
                include: {
                  subscriptions: {
                    include: { plan: true },
                    orderBy: [{ createdAt: "desc" }]
                  }
                }
              }
            }
          }
        },
        orderBy: { createdAt: "asc" }
      }),
      this.listActivePanelSyncJobs()
    ]);
    const panelSyncByUserId = buildPanelSyncSummaryMap(panelSyncJobs, "userId");

    return rows.map((row) => {
      const membership = row.teamMemberships[0] ?? null;
      const currentSubscription = membership
        ? pickCurrentSubscription(row.teamMemberships[0]?.team.subscriptions ?? [])
        : pickCurrentSubscription(row.subscriptions);

      return withPanelSyncSummary(toAdminUserRecord(row, {
        accountType: membership ? "team" : "personal",
        teamId: membership?.team.id ?? null,
        teamName: membership?.team.name ?? null,
        subscriptionCount: membership ? membership.team.subscriptions.length : row.subscriptions.length,
        activeSubscriptionCount: membership
          ? membership.team.subscriptions.filter((item) => readEffectiveSubscriptionState(item) === "active").length
          : row.subscriptions.filter((item) => readEffectiveSubscriptionState(item) === "active").length,
        currentSubscription: currentSubscription
          ? toUserSubscriptionSummary(currentSubscription, membership?.team ?? null)
          : null
      }), panelSyncByUserId.get(row.id));
    });
  }

  async createUser(input: CreateUserInputDto): Promise<AdminUserRecordDto> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException("邮箱已存在");
    }

    const passwordHash = await bcrypt.hash(input.password, 10);
    let row: Awaited<ReturnType<PrismaService["user"]["create"]>>;
    try {
      row = await this.prisma.user.create({
        data: {
          id: createId("user"),
          email,
          displayName: input.displayName.trim(),
          role: input.role,
          status: "active",
          maxConcurrentSessionsOverride: input.maxConcurrentSessionsOverride ?? null,
          passwordHash,
          lastSeenAt: new Date()
        }
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        throw new ConflictException("邮箱已存在");
      }
      throw toAdminLocalSaveHttpError(error, "账号保存失败，请刷新用户列表后重试。");
    }

    return toAdminUserRecord(row, {
      accountType: "personal",
      teamId: null,
      teamName: null,
      subscriptionCount: 0,
      activeSubscriptionCount: 0,
      currentSubscription: null
    });
  }

  async updateUser(userId: string, input: UpdateUserInputDto): Promise<AdminUserRecordDto> {
    const currentUser = await this.ensureUserExists(userId);
    const roleChanged = input.role !== undefined && input.role !== currentUser.role;
    const passwordChanged = input.password !== undefined;
    const statusChanged = input.status !== undefined && input.status !== currentUser.status;
    const data: Record<string, unknown> = {};
    if (input.displayName !== undefined) data.displayName = input.displayName.trim();
    if (input.role !== undefined) data.role = input.role;
    if (input.status !== undefined) data.status = input.status;
    if (input.password !== undefined) data.passwordHash = await bcrypt.hash(input.password, 10);
    if (input.maxConcurrentSessionsOverride !== undefined) {
      data.maxConcurrentSessionsOverride = input.maxConcurrentSessionsOverride;
    }

    let panelSync: PanelSyncBestEffortResult = { ok: true };
    let updatedUser: Awaited<ReturnType<PrismaService["user"]["update"]>>;

    updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data
    });
    if (statusChanged && input.status === "disabled") {
      panelSync = mergePanelSyncResults(
        panelSync,
        await this.queueUserDisconnectAfterLocalSaveBestEffort(userId, "user_disabled", "user disable")
      );
    }

    if ((roleChanged || passwordChanged) && !(statusChanged && input.status === "disabled")) {
      await this.revokeAllUserSessionsBestEffort(userId, "user credentials changed");
    }

    if (statusChanged && input.status) {
      panelSync = mergePanelSyncResults(
        panelSync,
        this.startUserStatusFollowUpInBackground(userId, input.status)
      );
    }

    return this.withAdminUserRefreshBestEffort(userId, updatedUser, panelSync, "账号已更新。");
  }

  async disconnectUser(userId: string): Promise<DisconnectUserResultDto> {
    const user = await this.ensureUserExists(userId);
    const panelSync = mergePanelSyncResults(
      await this.queueUserDisconnectAfterLocalSaveBestEffort(userId, "admin_user_disconnected", "user disconnect"),
      this.startUserDisconnectFollowUpInBackground(userId, "admin_user_disconnected")
    );
    const refreshedUser = await this.withAdminUserRefreshBestEffort(
      userId,
      user,
      panelSync,
      "账号当前连接断开已进入后台处理。"
    );

    return {
      ok: true,
      action: "disconnect_session",
      disconnectedSessionCount: 0,
      panelSyncStatus: refreshedUser.panelSyncStatus,
      panelSyncMessage: refreshedUser.panelSyncMessage,
      message: refreshedUser.message ?? "账号当前连接断开已进入后台处理。",
      reasonCode: "admin_paused_connection",
      reasonMessage: "管理员已暂停当前连接，用户稍后可以重新连接。",
      user: refreshedUser
    };
  }

  async updateUserSecurity(userId: string, input: UpdateUserSecurityInputDto): Promise<AdminUserRecordDto> {
    await this.ensureUserExists(userId);
    const row = await this.prisma.user.update({
      where: { id: userId },
      data: {
        maxConcurrentSessionsOverride: input.maxConcurrentSessionsOverride ?? null
      }
    });
    const panelSync = this.startSubscriptionFollowUpInBackground(`user concurrent lease enforcement for ${userId}`, async () => {
      const effectiveLimit = row.maxConcurrentSessionsOverride ?? (await this.resolveEffectiveConcurrentLeaseLimitForUser(userId));
      if (effectiveLimit !== null) {
        await this.runtimeSessionService.enforceUserConcurrentLeaseLimit(userId, effectiveLimit);
      }
    });
    return this.withAdminUserRefreshBestEffort(userId, row, panelSync, "账号安全策略已更新。");
  }

  async resetSubscriptionTraffic(
    subscriptionId: string,
    input: ResetSubscriptionTrafficInputDto = {}
  ): Promise<ResetSubscriptionTrafficResultDto> {
    const subscription = await this.requireSubscription(subscriptionId);
    if (input.userId !== undefined && input.userId !== null && typeof input.userId !== "string") {
      throw new BadRequestException("reset traffic userId must be a string.");
    }
    const reset = await this.resetSubscriptionTrafficCounters(subscription, {
      requestedUserId: typeof input.userId === "string" ? input.userId : undefined,
      allowTeamWideReset: false
    });
    await this.publishSubscriptionUpdatedEvent({
      subscriptionId: reset.subscription.id,
      userId: reset.subscription.userId,
      teamId: reset.subscription.teamId,
      state: reset.subscription.state
    });

    let user: AdminUserRecordDto | null = null;
    let responseRefreshSync: PanelSyncBestEffortResult = { ok: true };
    if (reset.targetUserId) {
      const refresh = await this.withSubscriptionFollowUpBudget<
        { ok: true; user: AdminUserRecordDto } | { ok: false; errorMessage: string }
      >(
        `traffic reset user response refresh for ${reset.targetUserId}`,
        {
          ok: false,
          errorMessage: "admin user response refresh is still running in background"
        },
        async () => {
          try {
            return { ok: true, user: await this.requireAdminUserRecord(reset.targetUserId as string) };
          } catch (error) {
            const errorMessage = readErrorMessage(error, "unknown error");
            this.logger?.warn(`Traffic reset saved, but admin user response refresh failed for ${reset.targetUserId}: ${errorMessage}`);
            return {
              ok: false,
              errorMessage: `admin user response refresh failed: ${errorMessage}`
            };
          }
        }
      );
      if (refresh.ok) {
        user = refresh.user;
      } else {
        responseRefreshSync = {
          ok: false,
          errorMessage: refresh.errorMessage
        };
      }
    }
    const panelSync = mergePanelSyncResults(reset.panelSync, responseRefreshSync);
    const panelSyncResult = buildPanelSyncResult(panelSync);
    return {
      ok: true,
      subscriptionId: subscription.id,
      userId: reset.targetUserId,
      clearedBindingCount: reset.clearedBindingCount,
      panelSyncStatus: panelSyncResult.panelSyncStatus,
      panelSyncMessage: panelSyncResult.panelSyncMessage,
      message:
        reset.clearedBindingCount > 0
          ? buildPanelSyncMessage(panelSync, "已重置订阅流量，并同步清空 3x-ui 面板计量")
          : "已重置订阅流量，当前没有可同步的 3x-ui 客户端",
      subscription: toAdminSubscriptionRecord(reset.subscription),
      user
    };
  }

  async listAdminPlans(): Promise<AdminPlanRecordDto[]> {
    const [plans, subscriptions] = await Promise.all([
      this.prisma.plan.findMany({ orderBy: { createdAt: "asc" } }),
      this.prisma.subscription.findMany()
    ]);

    return plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      scope: plan.scope,
      totalTrafficGb: plan.totalTrafficGb,
      renewable: plan.renewable,
      maxConcurrentSessions: plan.maxConcurrentSessions,
      isActive: plan.isActive,
      subscriptionCount: subscriptions.filter((item) => item.planId === plan.id).length,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString()
    }));
  }

  async createPlan(input: CreatePlanInputDto): Promise<AdminPlanRecordDto> {
    const name = normalizePlanName(input.name);
    const row = await this.prisma.plan.create({
      data: {
        id: createId("plan"),
        name,
        scope: input.scope,
        totalTrafficGb: input.totalTrafficGb,
        renewable: input.renewable,
        maxConcurrentSessions: input.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS,
        isActive: input.isActive ?? true
      }
    });

    return {
      id: row.id,
      name: row.name,
      scope: row.scope,
      totalTrafficGb: row.totalTrafficGb,
      renewable: row.renewable,
      maxConcurrentSessions: row.maxConcurrentSessions,
      isActive: row.isActive,
      subscriptionCount: 0,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    };
  }

  async updatePlan(planId: string, input: UpdatePlanInputDto): Promise<AdminPlanRecordDto> {
    const current = await this.ensurePlanExists(planId);
    const subscriptionCount = await this.prisma.subscription.count({ where: { planId } });
    if (input.scope !== undefined && input.scope !== current.scope && subscriptionCount > 0) {
      throw new BadRequestException("Plan scope cannot be changed while subscriptions are using this plan.");
    }
    const name = input.name !== undefined ? normalizePlanName(input.name) : undefined;
    const row = await this.prisma.plan.update({
      where: { id: planId },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
        ...(input.totalTrafficGb !== undefined ? { totalTrafficGb: input.totalTrafficGb } : {}),
        ...(input.renewable !== undefined ? { renewable: input.renewable } : {}),
        ...(input.maxConcurrentSessions !== undefined ? { maxConcurrentSessions: input.maxConcurrentSessions } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {})
      }
    });
    if (input.maxConcurrentSessions !== undefined && input.maxConcurrentSessions !== current.maxConcurrentSessions) {
      const panelSync = this.reconcilePlanConcurrentLeaseLimitsBestEffort(planId, row.maxConcurrentSessions);
      return withPanelSyncStatus(
        toAdminPlanRecord(row, subscriptionCount),
        panelSync,
        "套餐已更新。"
      );
    }
    return toAdminPlanRecord(row, subscriptionCount);
  }

  async updatePlanSecurity(planId: string, input: UpdatePlanSecurityInputDto): Promise<AdminPlanRecordDto> {
    await this.ensurePlanExists(planId);
    const row = await this.prisma.plan.update({
      where: { id: planId },
      data: {
        maxConcurrentSessions: input.maxConcurrentSessions
      }
    });
    const subscriptionCountResult = await this.countPlanSubscriptionsBestEffort(planId);
    const panelSync = this.reconcilePlanConcurrentLeaseLimitsBestEffort(planId, row.maxConcurrentSessions);
    return withPanelSyncStatus(
      toAdminPlanRecord(row, subscriptionCountResult.count),
      mergePanelSyncResults(panelSync, subscriptionCountResult.panelSync),
      "套餐安全策略已更新。"
    );
  }

  private async countPlanSubscriptionsBestEffort(planId: string): Promise<{
    count: number;
    panelSync: PanelSyncBestEffortResult;
  }> {
    const result = await this.withSubscriptionFollowUpBudget<
      { ok: true; count: number } | { ok: false; errorMessage: string }
    >(
      `plan subscription count refresh for ${planId}`,
      {
        ok: false,
        errorMessage: "plan subscription count refresh is still running in background"
      },
      async () => {
        try {
          return { ok: true, count: await this.prisma.subscription.count({ where: { planId } }) };
        } catch (error) {
          return {
            ok: false,
            errorMessage: `plan subscription count refresh failed: ${readErrorMessage(error, "unknown error")}`
          };
        }
      }
    );

    if (result.ok) {
      return { count: result.count, panelSync: { ok: true } };
    }
    return {
      count: 0,
      panelSync: {
        ok: false,
        errorMessage: result.errorMessage
      }
    };
  }

  async listAdminSubscriptions(): Promise<AdminSubscriptionRecordDto[]> {
    const [rows, panelSyncJobs] = await Promise.all([
      this.prisma.subscription.findMany({
        include: {
          plan: true,
          user: true,
          team: true,
          nodeAccesses: true
        },
        orderBy: [{ expireAt: "desc" }, { createdAt: "desc" }]
      }),
      this.listActivePanelSyncJobs()
    ]);
    const panelSyncBySubscriptionId = buildPanelSyncSummaryMap(panelSyncJobs, "subscriptionId");
    return rows.map((row) => withPanelSyncSummary(toAdminSubscriptionRecord(row), panelSyncBySubscriptionId.get(row.id)));
  }

  async createSubscription(input: CreateSubscriptionInputDto): Promise<AdminSubscriptionRecordDto> {
    return runWithSubscriptionOwnerLock(`personal:${input.userId}`, () => this.createSubscriptionLocked(input));
  }

  private async createSubscriptionLocked(input: CreateSubscriptionInputDto): Promise<AdminSubscriptionRecordDto> {
    const user = await this.ensureUserExists(input.userId);
    if (user.status !== "active") {
      throw new BadRequestException("用户已禁用");
    }

    const membership = await this.getUserMembership(input.userId);
    if (membership) {
      throw new BadRequestException("团队成员不能创建个人订阅");
    }

    const existing = await this.findCurrentPersonalSubscription(input.userId);
    if (existing && isEffectiveSubscription(existing)) {
      throw new ConflictException("该账号已有有效订阅，请使用续期、变更套餐或校正。");
    }

    const plan = await this.ensurePlanExists(input.planId);
    if (!plan.isActive) {
      throw new BadRequestException("套餐已停用，不能新建订阅");
    }
    if (plan.scope !== "personal") {
      throw new BadRequestException("个人订阅只能选择个人套餐");
    }

    const expireAt = new Date(input.expireAt);
    if (Number.isNaN(expireAt.getTime())) {
      throw new BadRequestException("到期时间无效");
    }

    const totalTrafficGb = input.totalTrafficGb ?? plan.totalTrafficGb;
    const usedTrafficGb = input.usedTrafficGb ?? 0;
    const remainingTrafficGb = Math.max(0, totalTrafficGb - usedTrafficGb);
    const state = resolveSubscriptionState(input.state ?? "active", remainingTrafficGb, expireAt);

    const row = await this.prisma.subscription.create({
      data: {
        id: createId("subscription"),
        userId: input.userId,
        planId: input.planId,
        totalTrafficGb,
        usedTrafficGb,
        remainingTrafficGb,
        expireAt,
        state,
        renewable: plan.renewable,
        sourceAction: "created",
        lastSyncedAt: new Date()
      },
      include: {
        plan: true,
        user: true,
        team: true,
        nodeAccesses: true
      }
    });

    const panelSync = mergePanelSyncResults(
      this.startSubscriptionFollowUpInBackground(`team ticket cleanup after personal subscription create for ${input.userId}`, () =>
        this.closeTeamSupportTicketsForUser(
          input.userId,
          "当前账号已切换为个人订阅，原 Team 工单已失效。如需继续咨询，请在当前个人订阅下重新创建工单。"
        )
      ),
      this.startPanelSyncResultFollowUpInBackground(`subscription panel access sync after create for ${row.id}`, () =>
        this.syncSubscriptionPanelAccessBestEffort(row.id)
      )
    );
    await this.publishSubscriptionUpdatedEvent({
      subscriptionId: row.id,
      userId: row.userId,
      teamId: row.teamId,
      state: row.state
    });

    return withPanelSyncStatus(toAdminSubscriptionRecord(row), panelSync, "订阅已创建。");
  }

  async renewSubscription(subscriptionId: string, input: RenewSubscriptionInputDto): Promise<AdminSubscriptionRecordDto> {
    let disconnectReason: string | null = null;
    let resetPanelSync: PanelSyncBestEffortResult = { ok: true };
    let row: AdminSubscriptionEntity;
    if (input.resetTraffic) {
      const current = await this.requireSubscription(subscriptionId);
      const reset = await this.resetSubscriptionTrafficCounters(current, {
        allowTeamWideReset: true,
        totalTrafficGb: input.totalTrafficGb,
        renewExpireAt: input.expireAt,
        sourceAction: "renewed",
        statePreference: "active"
      });
      row = reset.subscription;
      resetPanelSync = reset.panelSync;
    } else {
      row = await runWithSubscriptionUsageLock(subscriptionId, async () => {
        const lockedSubscription = await this.requireSubscription(subscriptionId);
        const nextExpireAt = resolveRenewExpireAt(lockedSubscription.expireAt, input.expireAt);
        const totalTrafficGb = input.totalTrafficGb ?? lockedSubscription.totalTrafficGb;
        const remainingTrafficGb = Math.max(0, totalTrafficGb - lockedSubscription.usedTrafficGb);
        const state = resolveSubscriptionState("active", remainingTrafficGb, nextExpireAt);
        disconnectReason = getSubscriptionDisconnectReason({
          state,
          remainingTrafficGb,
          expireAt: nextExpireAt
        });

        return this.prisma.$transaction(async (tx) =>
          tx.subscription.update({
            where: { id: subscriptionId },
            data: {
              totalTrafficGb,
              remainingTrafficGb,
              expireAt: nextExpireAt,
              state,
              sourceAction: "renewed",
              lastSyncedAt: new Date()
            },
            include: {
              plan: true,
              user: true,
              team: true,
              nodeAccesses: true
            }
          })
        );
      });
    }

    const panelSync = mergePanelSyncResults(
      resetPanelSync,
      disconnectReason
        ? this.startPanelSyncResultFollowUpInBackground(`subscription disconnect after renew for ${subscriptionId}`, () =>
            this.queueSubscriptionDisconnectBestEffort(subscriptionId, disconnectReason as string)
          )
        : { ok: true },
      this.startPanelSyncResultFollowUpInBackground(`active lease sync after renew for ${subscriptionId}`, () =>
        this.syncActiveLeasesForSubscriptionBestEffort(row)
      ),
      this.startPanelSyncResultFollowUpInBackground(`subscription panel access sync after renew for ${subscriptionId}`, () =>
        this.syncSubscriptionPanelAccessBestEffort(subscriptionId)
      )
    );
    await this.publishSubscriptionUpdatedEvent({
      subscriptionId: row.id,
      userId: row.userId,
      teamId: row.teamId,
      state: row.state
    });

    return withPanelSyncStatus(toAdminSubscriptionRecord(row), panelSync, "订阅已续期。");
  }

  async changeSubscriptionPlan(
    subscriptionId: string,
    input: ChangeSubscriptionPlanInputDto
  ): Promise<AdminSubscriptionRecordDto> {
    await this.requireSubscription(subscriptionId);
    const plan = await this.ensurePlanExists(input.planId);
    if (!plan.isActive) {
      throw new BadRequestException("套餐已停用，不能切换");
    }

    let disconnectReason: string | null = null;
    const row = await runWithSubscriptionUsageLock(subscriptionId, async () => {
      const current = await this.requireSubscription(subscriptionId);
      assertPlanScopeMatchesSubscription(plan.scope, current);
      const expireAt = input.expireAt ? new Date(input.expireAt) : current.expireAt;
      if (Number.isNaN(expireAt.getTime())) {
        throw new BadRequestException("到期时间无效");
      }

      const totalTrafficGb = input.totalTrafficGb ?? plan.totalTrafficGb;
      const remainingTrafficGb = Math.max(0, totalTrafficGb - current.usedTrafficGb);
      const state = resolveSubscriptionState("active", remainingTrafficGb, expireAt);
      disconnectReason = getSubscriptionDisconnectReason({
        state,
        remainingTrafficGb,
        expireAt
      });

      return this.prisma.$transaction(async (tx) => {
        return tx.subscription.update({
          where: { id: subscriptionId },
          data: {
            planId: plan.id,
            totalTrafficGb,
            remainingTrafficGb,
            expireAt,
            renewable: plan.renewable,
            state,
            sourceAction: "plan_changed",
            lastSyncedAt: new Date()
          },
          include: {
            plan: true,
            user: true,
            team: true,
            nodeAccesses: true
          }
        });
      });
    });

    const panelSync = mergePanelSyncResults(
      disconnectReason
        ? this.startPanelSyncResultFollowUpInBackground(`subscription disconnect after plan change for ${subscriptionId}`, () =>
            this.queueSubscriptionDisconnectBestEffort(subscriptionId, disconnectReason as string)
          )
        : { ok: true },
      await this.enforceSubscriptionConcurrentLeaseLimits(row),
      this.startPanelSyncResultFollowUpInBackground(`active lease sync after plan change for ${subscriptionId}`, () =>
        this.syncActiveLeasesForSubscriptionBestEffort(row)
      ),
      this.startPanelSyncResultFollowUpInBackground(`subscription panel access sync after plan change for ${subscriptionId}`, () =>
        this.syncSubscriptionPanelAccessBestEffort(subscriptionId)
      )
    );
    await this.publishSubscriptionUpdatedEvent({
      subscriptionId: row.id,
      userId: row.userId,
      teamId: row.teamId,
      state: row.state
    });

    return withPanelSyncStatus(toAdminSubscriptionRecord(row), panelSync, "订阅套餐已变更。");
  }

  async updateSubscription(subscriptionId: string, input: UpdateSubscriptionInputDto): Promise<AdminSubscriptionRecordDto> {
    await this.requireSubscription(subscriptionId);

    let disconnectReason: string | null = null;
    const row = await runWithSubscriptionUsageLock(subscriptionId, async () => {
      const current = await this.requireSubscription(subscriptionId);
      const totalTrafficGb = input.totalTrafficGb ?? current.totalTrafficGb;
      const usedTrafficGb = input.usedTrafficGb ?? current.usedTrafficGb;
      const expireAt = input.expireAt ? new Date(input.expireAt) : current.expireAt;
      if (Number.isNaN(expireAt.getTime())) {
        throw new BadRequestException("鍒版湡鏃堕棿鏃犳晥");
      }
      const remainingTrafficGb = Math.max(0, totalTrafficGb - usedTrafficGb);
      const state = resolveSubscriptionState(input.state ?? current.state, remainingTrafficGb, expireAt);
      disconnectReason = getSubscriptionDisconnectReason({
        state,
        remainingTrafficGb,
        expireAt
      });

      return this.prisma.$transaction(async (tx) => {
        return tx.subscription.update({
          where: { id: subscriptionId },
          data: {
            totalTrafficGb,
            usedTrafficGb,
            remainingTrafficGb,
            expireAt,
            state,
            sourceAction: "adjusted",
            lastSyncedAt: new Date()
          },
          include: {
            plan: true,
            user: true,
            team: true,
            nodeAccesses: true
          }
        });
      });
    });

    const panelSync = mergePanelSyncResults(
      disconnectReason
        ? this.startPanelSyncResultFollowUpInBackground(`subscription disconnect after update for ${subscriptionId}`, () =>
            this.queueSubscriptionDisconnectBestEffort(subscriptionId, disconnectReason as string)
          )
        : { ok: true },
      this.startPanelSyncResultFollowUpInBackground(`active lease sync after update for ${subscriptionId}`, () =>
        this.syncActiveLeasesForSubscriptionBestEffort(row)
      ),
      this.startPanelSyncResultFollowUpInBackground(`subscription panel access sync after update for ${subscriptionId}`, () =>
        this.syncSubscriptionPanelAccessBestEffort(subscriptionId)
      )
    );
    await this.publishSubscriptionUpdatedEvent({
      subscriptionId: row.id,
      userId: row.userId,
      teamId: row.teamId,
      state: row.state
    });

    return withPanelSyncStatus(toAdminSubscriptionRecord(row), panelSync, "订阅已更新。");
  }

  async convertPersonalSubscriptionToTeam(
    subscriptionId: string,
    input: ConvertSubscriptionToTeamInputDto
  ): Promise<ConvertSubscriptionToTeamResultDto> {
    const owner = await this.requireSubscription(subscriptionId);
    if (!owner.userId || owner.teamId) {
      throw new BadRequestException("鍙湁涓汉璁㈤槄鎵嶈兘杞叆 Team");
    }
    return runWithSubscriptionOwnerLock(`personal:${owner.userId}`, () =>
      this.convertPersonalSubscriptionToTeamLocked(subscriptionId, input)
    );
  }

  private async convertPersonalSubscriptionToTeamLocked(
    subscriptionId: string,
    input: ConvertSubscriptionToTeamInputDto
  ): Promise<ConvertSubscriptionToTeamResultDto> {
    const current = await this.requireSubscription(subscriptionId);
    if (!current.userId || current.teamId) {
      throw new BadRequestException("只有个人订阅才能转入 Team");
    }

    const user = await this.ensureUserExists(current.userId);
    if (user.status !== "active") {
      throw new BadRequestException("账号已禁用，不能转入 Team");
    }

    const targetTeam = await this.requireTeam(input.targetTeamId);
    if (targetTeam.status !== "active") {
      throw new BadRequestException("目标团队已停用，不能转入 Team");
    }

    const membership = await this.getUserMembership(user.id);
    if (membership) {
      throw new BadRequestException("该账号已属于其他团队");
    }

    const teamSubscription = await this.findCurrentTeamSubscription(targetTeam.id);
    if (!teamSubscription || !isEffectiveSubscription(teamSubscription)) {
      throw new BadRequestException("目标团队当前没有可用的 Team 订阅");
    }

    const membershipId = createId("member");
    let teamPanelSync: PanelSyncBestEffortResult = { ok: true };

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.teamMember.create({
          data: {
            id: membershipId,
            teamId: targetTeam.id,
            userId: user.id,
            role: "member"
          }
        });
        await tx.subscription.update({
          where: { id: subscriptionId },
          data: {
            state: "expired",
            expireAt: new Date(),
            remainingTrafficGb: 0,
            sourceAction: "adjusted",
            lastSyncedAt: new Date()
          }
        });
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        throw new ConflictException("The account already belongs to another team.");
      }
      throw toAdminLocalSaveHttpError(error, "订阅转入 Team 保存失败，请刷新订阅和团队列表后重试。");
    }
    teamPanelSync = mergePanelSyncResults(
      teamPanelSync,
      this.startSubscriptionFollowUpInBackground(`team panel sync after personal conversion for ${teamSubscription.id}`, async () => {
        const result = await this.syncSubscriptionPanelAccessBestEffort(teamSubscription.id);
        if (!result.ok) {
          throw new Error(result.errorMessage);
        }
      }),
      this.startSubscriptionFollowUpInBackground(`personal lease revocation after team conversion for ${subscriptionId}`, async () => {
        const result = await this.revokeSubscriptionLeasesBestEffort(subscriptionId, "team_member_removed", {
          userId: user.id
        });
        if (!result.ok) {
          throw new Error(result.errorMessage);
        }
      }),
      this.startSubscriptionFollowUpInBackground(`personal panel cleanup for ${subscriptionId}`, async () => {
        const removeResult = await this.runtimeSessionService.removePanelBindingsForSubscription(subscriptionId, {
          userId: user.id
        });
        this.runtimeSessionService.assertPanelBindingMutation("Delete personal subscription 3x-ui client failed", removeResult);
      }),
      this.startSubscriptionFollowUpInBackground(`personal ticket cleanup after team conversion for ${user.id}`, () =>
        this.closePersonalSupportTicketsForUser(
          user.id,
          "Current account has switched to Team ownership. Previous personal subscription tickets are closed. Please create a new ticket under the current Team if needed."
        )
      )
    );
    await this.publishSubscriptionUpdatedEvent({
      subscriptionId,
      userId: user.id,
      state: null
    });
    await this.publishSubscriptionUpdatedEvent({
      subscriptionId: teamSubscription.id,
      teamId: targetTeam.id,
      state: teamSubscription.state
    });

    const teamRecord = await this.withTeamRecordRefreshBestEffort(targetTeam.id, teamPanelSync, "个人订阅已停用，账号已转入 Team。");
    const conversionPanelSync: PanelSyncBestEffortResult =
      teamRecord.panelSyncStatus === "pending"
        ? { ok: false, errorMessage: teamRecord.panelSyncMessage ?? "team conversion sync pending" }
        : { ok: true };
    return {
      ok: true,
      deletedSubscriptionId: subscriptionId,
      teamId: teamRecord.id,
      teamName: teamRecord.name,
      teamSubscriptionId: teamSubscription.id,
      ...buildPanelSyncResult(conversionPanelSync),
      message: buildPanelSyncMessage(conversionPanelSync, `个人订阅已停用，账号已转入 Team「${teamRecord.name}」。`)
    };
  }

  async listAdminTeams(): Promise<AdminTeamRecordDto[]> {
    const [teams, panelSyncJobs] = await Promise.all([
      this.prisma.team.findMany({
        include: {
          owner: true,
          members: {
            include: { user: true },
            orderBy: { createdAt: "asc" }
          },
          subscriptions: {
            include: { plan: true },
            orderBy: [{ expireAt: "desc" }, { createdAt: "desc" }]
          }
        },
        orderBy: { createdAt: "asc" }
      }),
      this.listActivePanelSyncJobs()
    ]);
    const panelSyncByTeamId = buildPanelSyncSummaryMap(panelSyncJobs, "teamId");
    return teams.map((team) =>
      withPanelSyncSummary(toAdminTeamRecord({
        ...team,
        trafficLedgerEntries: []
      }), panelSyncByTeamId.get(team.id))
    );
  }

  private async loadTeamUsageSummaries(teamIds: string[]) {
    const result = new Map<
      string,
      Array<{
        id: string;
        teamId: string;
        userId: string;
        subscriptionId: string;
        nodeId: string | null;
        usedTrafficGb: number;
        recordedAt: Date;
        user: { displayName: string; email: string };
        node: { id: string; name: string; region: string } | null;
      }>
    >();
    if (teamIds.length === 0) {
      return result;
    }

    const rows = await this.prisma.trafficLedger.groupBy({
      by: ["teamId", "userId", "subscriptionId", "nodeId"],
      where: { teamId: { in: teamIds } },
      _sum: { usedTrafficGb: true },
      _count: { _all: true },
      _max: { recordedAt: true }
    });
    const userIds = Array.from(new Set(rows.map((row) => row.userId)));
    const nodeIds = Array.from(new Set(rows.map((row) => row.nodeId).filter((nodeId): nodeId is string => Boolean(nodeId))));
    const [users, nodes] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, displayName: true, email: true }
      }),
      this.prisma.node.findMany({
        where: { id: { in: nodeIds } },
        select: { id: true, name: true, region: true }
      })
    ]);
    const userById = new Map(users.map((user) => [user.id, user]));
    const nodeById = new Map(nodes.map((node) => [node.id, node]));

    for (const row of rows) {
      const recordedAt = row._max.recordedAt;
      const user = userById.get(row.userId);
      if (!recordedAt || !user) {
        continue;
      }
      const current = result.get(row.teamId) ?? [];
      current.push({
        id: `ledger_summary_${row.teamId}_${row.userId}_${row.nodeId ?? "unknown"}`,
        teamId: row.teamId,
        userId: row.userId,
        subscriptionId: row.subscriptionId,
        nodeId: row.nodeId,
        usedTrafficGb: row._sum.usedTrafficGb ?? 0,
        recordedAt,
        user,
        node: row.nodeId ? nodeById.get(row.nodeId) ?? null : null
      });
      result.set(row.teamId, current);
    }

    return result;
  }

  private async listActivePanelSyncJobs(): Promise<PanelSyncSummaryJob[]> {
    const [counts, recentFailedJobs] = await Promise.all([
      this.prisma.panelSyncJob.groupBy({
        by: ["subscriptionId", "userId", "teamId", "status"],
        where: {
          status: { in: ["pending", "running", "failed"] }
        },
        _count: { _all: true }
      }),
      this.prisma.panelSyncJob.findMany({
        where: {
          status: "failed",
          lastError: { not: null }
        },
        select: {
          subscriptionId: true,
          userId: true,
          teamId: true,
          status: true,
          lastError: true,
          updatedAt: true
        },
        orderBy: [{ updatedAt: "desc" }],
        take: PANEL_SYNC_RECENT_ERROR_LIMIT
      })
    ]);
    return [
      ...counts.map((row) => ({
        subscriptionId: row.subscriptionId,
        userId: row.userId,
        teamId: row.teamId,
        status: row.status,
        lastError: null,
        updatedAt: new Date(0),
        count: row._count._all
      })),
      ...recentFailedJobs.map((row) => ({
        subscriptionId: row.subscriptionId,
        userId: row.userId,
        teamId: row.teamId,
        status: row.status,
        lastError: row.lastError,
        updatedAt: row.updatedAt,
        count: 0
      }))
    ];
  }

  async createTeam(input: CreateTeamInputDto): Promise<AdminTeamRecordDto> {
    return runWithSubscriptionOwnerLock(`personal:${input.ownerUserId}`, () => this.createTeamLocked(input));
  }

  private async createTeamLocked(input: CreateTeamInputDto): Promise<AdminTeamRecordDto> {
    const owner = await this.ensureUserExists(input.ownerUserId);
    if (owner.status !== "active") {
      throw new BadRequestException("负责人账号已禁用");
    }

    await this.assertUserCanJoinTeam(owner.id);

    const teamId = createId("team");
    await this.prisma.$transaction([
      this.prisma.team.create({
        data: {
          id: teamId,
          name: input.name.trim(),
          ownerUserId: owner.id,
          status: input.status ?? "active"
        }
      }),
      this.prisma.teamMember.create({
        data: {
          id: createId("member"),
          teamId,
          userId: owner.id,
          role: "owner"
        }
      })
    ]);

    await this.closePersonalSupportTicketsForUserBestEffort(
      owner.id,
      "当前账号已切换为 Team 归属，原个人订阅工单已失效。如需继续咨询，请在当前 Team 归属下重新创建工单。"
    );

    return this.withTeamRecordRefreshBestEffort(teamId, { ok: true }, "Team 已创建。");
  }

  async updateTeam(teamId: string, input: UpdateTeamInputDto): Promise<AdminTeamRecordDto> {
    const current = await this.requireTeam(teamId);
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.status !== undefined) data.status = input.status;
    let teamUpdatedInOwnerTransaction = false;
    let panelSync: PanelSyncBestEffortResult = { ok: true };

    if (input.ownerUserId && input.ownerUserId !== current.ownerUserId) {
      const nextOwner = await this.ensureUserExists(input.ownerUserId);
      if (nextOwner.status !== "active") {
        throw new BadRequestException("负责人账号已禁用");
      }

      const nextMembership = await this.getUserMembership(nextOwner.id);
      const joinsCurrentTeamAsNewOwner = !nextMembership;
      if (nextMembership && nextMembership.teamId !== teamId) {
        throw new BadRequestException("该账号已属于其他团队");
      }

      const activePersonal = await this.findCurrentPersonalSubscription(nextOwner.id);
      if (activePersonal && isEffectiveSubscription(activePersonal)) {
        throw new BadRequestException("该账号已有个人有效订阅，不能切为团队负责人");
      }

      data.ownerUserId = nextOwner.id;
      await this.prisma.$transaction(async (tx) => {
        await tx.teamMember.updateMany({
          where: { teamId, role: "owner" },
          data: { role: "member" }
        });
        await tx.teamMember.upsert({
          where: { userId: nextOwner.id },
          update: { role: "owner" },
          create: {
            id: createId("member"),
            teamId,
            userId: nextOwner.id,
            role: "owner"
          }
        });
        await tx.team.update({
          where: { id: teamId },
          data
        });
      });
      teamUpdatedInOwnerTransaction = true;

      if (joinsCurrentTeamAsNewOwner) {
        await this.closePersonalSupportTicketsForUserBestEffort(
          nextOwner.id,
          "当前账号已切换为 Team 归属，原个人订阅工单已失效。如需继续咨询，请在当前 Team 归属下重新创建工单。"
        );
      }
    }

    if (input.status !== undefined && input.status !== current.status) {
      if (!teamUpdatedInOwnerTransaction) {
        await this.prisma.team.update({
          where: { id: teamId },
          data
        });
      }
      if (input.status === "disabled") {
        panelSync = mergePanelSyncResults(
          panelSync,
          await this.queueTeamDisconnectAfterLocalSaveBestEffort(teamId, "team_disabled", "team disable")
        );
      }
      panelSync = mergePanelSyncResults(panelSync, this.startTeamStatusFollowUpInBackground(teamId, input.status));
    } else {
      if (!teamUpdatedInOwnerTransaction) {
        await this.prisma.team.update({
          where: { id: teamId },
          data
        });
      }
      const teamSubscriptionLookup = await this.findTeamSubscriptionAfterLocalSaveBestEffort(
        teamId,
        "team subscription lookup after team update"
      );
      const teamSubscription = teamSubscriptionLookup.subscription;
      panelSync = mergePanelSyncResults(panelSync, teamSubscriptionLookup.panelSync);
      if (teamSubscription) {
        if (input.ownerUserId && input.ownerUserId !== current.ownerUserId) {
          panelSync = mergePanelSyncResults(
            panelSync,
            this.startPanelSyncResultFollowUpInBackground(`subscription panel access sync after team owner update for ${teamSubscription.id}`, () =>
              this.syncSubscriptionPanelAccessBestEffort(teamSubscription.id)
            )
          );
        }
        await this.publishSubscriptionUpdatedEvent({
          subscriptionId: teamSubscription.id,
          teamId,
          state: teamSubscription.state
        });
      }
    }

    return this.withTeamRecordRefreshBestEffort(teamId, panelSync, "Team 已更新。");
  }

  async createTeamMember(teamId: string, input: CreateTeamMemberInputDto): Promise<AdminTeamRecordDto> {
    return runWithSubscriptionOwnerLock(`personal:${input.userId}`, () => this.createTeamMemberLocked(teamId, input));
  }

  private async createTeamMemberLocked(teamId: string, input: CreateTeamMemberInputDto): Promise<AdminTeamRecordDto> {
    await this.requireTeam(teamId);
    if (input.role === "owner") {
      throw new BadRequestException("Use the team owner transfer flow to assign an owner.");
    }
    await this.assertUserCanJoinTeam(input.userId);

    let member: Awaited<ReturnType<PrismaService["teamMember"]["create"]>>;
    try {
      member = await this.prisma.teamMember.create({
        data: {
          id: createId("member"),
          teamId,
          userId: input.userId,
          role: input.role ?? "member"
        }
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        throw new ConflictException("The account already belongs to another team.");
      }
      throw toAdminLocalSaveHttpError(error, "Team 成员保存失败，请刷新团队和用户列表后重试。");
    }

    await this.closePersonalSupportTicketsForUserBestEffort(
      input.userId,
      "当前账号已切换为 Team 归属，原个人订阅工单已失效。如需继续咨询，请在当前 Team 归属下重新创建工单。"
    );

    let panelSync: PanelSyncBestEffortResult = { ok: true };
    let subscription: Awaited<ReturnType<AdminSubscriptionService["findCurrentTeamSubscription"]>> | null = null;
    const lookup = await this.withSubscriptionFollowUpBudget<
      | { ok: true; subscription: Awaited<ReturnType<AdminSubscriptionService["findCurrentTeamSubscription"]>> | null }
      | { ok: false; errorMessage: string }
    >(
      `team subscription lookup after member create for ${teamId}`,
      {
        ok: false,
        errorMessage: "team subscription lookup is still running in background"
      },
      async () => {
        try {
          return { ok: true, subscription: await this.findCurrentTeamSubscription(teamId) };
        } catch (error) {
          return {
            ok: false,
            errorMessage: `team subscription lookup failed: ${readErrorMessage(error, "unknown error")}`
          };
        }
      }
    );
    if (lookup.ok) {
      subscription = lookup.subscription;
    } else {
      panelSync = mergePanelSyncResults(panelSync, {
        ok: false,
        errorMessage: lookup.errorMessage
      });
    }
    if (subscription) {
      panelSync = mergePanelSyncResults(
        panelSync,
        this.startPanelSyncResultFollowUpInBackground(`subscription panel access sync after team member create for ${subscription.id}`, () =>
          this.syncSubscriptionPanelAccessBestEffort(subscription.id)
        )
      );
      await this.publishSubscriptionUpdatedEvent({
        subscriptionId: subscription.id,
        teamId: subscription.teamId,
        state: subscription.state
      });
    }

    return this.withTeamRecordRefreshBestEffort(teamId, panelSync, "Team 成员已添加。");
  }

  async updateTeamMember(teamId: string, memberId: string, input: UpdateTeamMemberInputDto): Promise<AdminTeamRecordDto> {
    const member = await this.requireTeamMember(memberId);
    if (member.teamId !== teamId) {
      throw new BadRequestException("Team member does not belong to the requested team.");
    }
    const nextRole = input.role ?? member.role;
    if (member.role === "owner" && nextRole !== "owner") {
      throw new BadRequestException("Use the team owner transfer flow before changing the current owner role.");
    }

    let panelSync: PanelSyncBestEffortResult = { ok: true };
    if (nextRole === "owner") {
      const ownerUser = await this.ensureUserExists(member.userId);
      if (ownerUser.status !== "active") {
        throw new BadRequestException("Team owner account must be active.");
      }
      await this.prisma.$transaction([
        this.prisma.teamMember.update({
          where: { id: memberId },
          data: { role: "owner" }
        }),
        this.prisma.teamMember.updateMany({
          where: {
            teamId: member.teamId,
            NOT: { id: memberId }
          },
          data: { role: "member" }
        }),
        this.prisma.team.update({
          where: { id: member.teamId },
          data: { ownerUserId: member.userId }
        })
      ]);
      const lookup = await this.findTeamSubscriptionAfterLocalSaveBestEffort(
        member.teamId,
        "team subscription lookup after owner transfer"
      );
      panelSync = mergePanelSyncResults(panelSync, lookup.panelSync);
      const subscription = lookup.subscription;
      if (subscription) {
        panelSync = mergePanelSyncResults(
          panelSync,
          this.startPanelSyncResultFollowUpInBackground(`subscription panel access sync after owner transfer for ${subscription.id}`, () =>
            this.syncSubscriptionPanelAccessBestEffort(subscription.id)
          )
        );
        await this.publishSubscriptionUpdatedEvent({
          subscriptionId: subscription.id,
          teamId: subscription.teamId,
          state: subscription.state
        });
      }
    } else {
      await this.prisma.teamMember.update({
        where: { id: memberId },
        data: { role: nextRole }
      });
    }

    return this.withTeamRecordRefreshBestEffort(member.teamId, panelSync, "Team 成员已更新。");
  }

  async deleteTeamMember(teamId: string, memberId: string) {
    const member = await this.requireTeamMember(memberId);
    if (member.teamId !== teamId) {
      throw new BadRequestException("Team member does not belong to the requested team.");
    }
    if (member.role === "owner") {
      throw new BadRequestException("负责人不能直接移除，请先转移负责人");
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.teamMember.delete({
        where: { id: memberId }
      });
    });
    const panelSync = mergePanelSyncResults(
      await this.queueTeamDisconnectAfterLocalSaveBestEffort(member.teamId, "team_member_removed", "team member removal", {
        userId: member.userId
      }),
      this.startTeamMemberRemovedFollowUpInBackground({
        teamId: member.teamId,
        userId: member.userId
      })
    );
    return {
      ok: true,
      ...buildPanelSyncResult(panelSync),
      message: buildPanelSyncMessage(panelSync, "Team 成员已移除。")
    };
  }

  async kickTeamMember(
    teamId: string,
    memberId: string,
    input: KickTeamMemberInputDto
  ): Promise<KickTeamMemberResultDto> {
    const member = await this.requireTeamMember(memberId);
    if (member.teamId !== teamId) {
      throw new BadRequestException("团队成员不属于当前团队");
    }

    let user: AdminUserRecordDto | null = null;
    let accountDisabled = false;
    const disconnectPanelSync = this.startTeamMemberDisconnectFollowUpInBackground({
      teamId,
      userId: member.userId
    });
    let panelSyncStatus: KickTeamMemberResultDto["panelSyncStatus"] = "pending";
    let panelSyncMessage: string | null = buildPanelSyncResult(disconnectPanelSync).panelSyncMessage;
    if (input.disableAccount) {
      user = await this.updateUser(member.userId, { status: "disabled" });
      accountDisabled = true;
      if (user.panelSyncStatus === "pending") {
        panelSyncMessage = [panelSyncMessage, user.panelSyncMessage].filter(Boolean).join(" ");
      }
    }
    let message = accountDisabled ? "账号已禁用，连接断开已进入后台处理。" : "成员连接断开已进入后台处理。";
    const team = await this.withTeamRecordRefreshBestEffort(
      teamId,
      { ok: false, errorMessage: panelSyncMessage ?? "team member disconnect sync queued for background processing" },
      "Team 成员连接已处理。"
    );
    panelSyncStatus = team.panelSyncStatus ?? panelSyncStatus;
    panelSyncMessage = team.panelSyncMessage ?? panelSyncMessage;
    if (panelSyncMessage) {
      message = `${message}，${panelSyncMessage}`;
    }
    return {
      ok: true,
      action: "disconnect_session",
      disconnectedSessionCount: 0,
      accountDisabled,
      panelSyncStatus,
      panelSyncMessage,
      message,
      reasonCode: input.disableAccount ? "account_disabled" : "admin_paused_connection",
      reasonMessage: input.disableAccount ? "当前账号已禁用，连接已失效。" : "管理员已暂停当前连接，可稍后恢复使用。",
      team,
      user
    };
  }

  async createTeamSubscription(teamId: string, input: CreateTeamSubscriptionInputDto): Promise<AdminSubscriptionRecordDto> {
    return runWithSubscriptionOwnerLock(`team:${teamId}`, () => this.createTeamSubscriptionLocked(teamId, input));
  }

  private async createTeamSubscriptionLocked(teamId: string, input: CreateTeamSubscriptionInputDto): Promise<AdminSubscriptionRecordDto> {
    const team = await this.requireTeam(teamId);
    if (team.status !== "active") {
      throw new BadRequestException("团队已停用");
    }

    const current = await this.findCurrentTeamSubscription(teamId);
    if (current && isEffectiveSubscription(current)) {
      throw new ConflictException("该团队已有有效共享订阅，请使用续期、变更套餐或校正。");
    }

    const plan = await this.ensurePlanExists(input.planId);
    if (!plan.isActive) {
      throw new BadRequestException("套餐已停用，不能分配");
    }
    if (plan.scope !== "team") {
      throw new BadRequestException("团队订阅只能选择 Team 套餐");
    }

    const expireAt = new Date(input.expireAt);
    if (Number.isNaN(expireAt.getTime())) {
      throw new BadRequestException("到期时间无效");
    }

    const totalTrafficGb = input.totalTrafficGb ?? plan.totalTrafficGb;
    const usedTrafficGb = input.usedTrafficGb ?? 0;
    const remainingTrafficGb = Math.max(0, totalTrafficGb - usedTrafficGb);
    const state = resolveSubscriptionState("active", remainingTrafficGb, expireAt);

    const row = await this.prisma.subscription.create({
      data: {
        id: createId("subscription"),
        teamId,
        planId: input.planId,
        totalTrafficGb,
        usedTrafficGb,
        remainingTrafficGb,
        expireAt,
        state,
        renewable: plan.renewable,
        sourceAction: "created",
        lastSyncedAt: new Date()
      },
      include: {
        plan: true,
        user: true,
        team: true,
        nodeAccesses: true
      }
    });

    const panelSync = this.startPanelSyncResultFollowUpInBackground(`subscription panel access sync after team subscription create for ${row.id}`, () =>
      this.syncSubscriptionPanelAccessBestEffort(row.id)
    );
    await this.publishSubscriptionUpdatedEvent({
      subscriptionId: row.id,
      userId: row.userId,
      teamId: row.teamId,
      state: row.state
    });

    return withPanelSyncStatus(toAdminSubscriptionRecord(row), panelSync, "Team 订阅已创建。");
  }

  async getTeamUsage(teamId: string): Promise<AdminTeamUsageRecordDto[]> {
    await this.requireTeam(teamId);
    const usageByTeamId = await this.loadTeamUsageSummaries([teamId]);
    return summarizeTeamUsageRecords(usageByTeamId.get(teamId) ?? []);
  }

  private async resetSubscriptionTrafficCounters(
    subscription: AdminSubscriptionEntity,
    options: {
      requestedUserId?: string | null;
      allowTeamWideReset: boolean;
      totalTrafficGb?: number;
      expireAt?: Date;
      renewExpireAt?: string | null;
      sourceAction?: "renewed";
      statePreference?: SubscriptionState;
    }
  ): Promise<ResetTrafficCountersResult> {
    const requestedUserId = normalizeOptionalString(options.requestedUserId);

    let targetUserId: string | null;
    if (subscription.teamId) {
      if (requestedUserId) {
        const membership = await this.prisma.teamMember.findFirst({
          where: {
            teamId: subscription.teamId,
            userId: requestedUserId
          }
        });
        if (!membership) {
          throw new BadRequestException("指定成员不属于当前 Team 订阅");
        }
        targetUserId = requestedUserId;
      } else if (options.allowTeamWideReset) {
        targetUserId = null;
      } else {
        throw new BadRequestException("Team 订阅重置流量时必须指定成员账号");
      }
    } else {
      if (!subscription.userId) {
        throw new BadRequestException("个人订阅缺少所属用户，不能重置流量");
      }
      if (requestedUserId && requestedUserId !== subscription.userId) {
        throw new BadRequestException("个人订阅不能指定其他成员流量");
      }
      targetUserId = subscription.userId;
    }

    let clearedBindingCount = 0;
    let updatedSubscription: AdminSubscriptionEntity | null = null;
    let panelSync: PanelSyncBestEffortResult = { ok: true };
    let panelResetBindings: any[] = [];
    let panelResetQueuedAt: Date | null = null;

    await runWithSubscriptionUsageLock(subscription.id, async () => {
      const resetSampledAt = new Date();

      updatedSubscription = await this.prisma.$transaction(async (tx) => {
        const bindings = await tx.panelClientBinding.findMany({
          where: {
            subscriptionId: subscription.id,
            ...(targetUserId ? { userId: targetUserId } : {}),
            status: { in: ["active", "disabled"] }
          },
          include: {
            node: true
          }
        });
        clearedBindingCount = bindings.length;
        panelResetBindings = bindings;
        const baselineSamples = bindings.map((binding: any) => ({
          binding,
          uplinkBytes: 0n,
          downlinkBytes: 0n,
          sampledAt: resetSampledAt
        }));

        const lockedSubscription = await tx.subscription.findUnique({
          where: { id: subscription.id },
          include: {
            plan: true,
            user: true,
            team: true,
            nodeAccesses: true
          }
        });
        if (!lockedSubscription) {
          return null;
        }

        await this.persistTrafficResetBaselineSamples(baselineSamples.filter((item): item is NonNullable<typeof item> => Boolean(item)), tx);
        const totalTrafficGb = options.totalTrafficGb ?? lockedSubscription.totalTrafficGb;
        const expireAt =
          options.renewExpireAt !== undefined
            ? resolveRenewExpireAt(lockedSubscription.expireAt, options.renewExpireAt ?? undefined)
            : options.expireAt ?? new Date(lockedSubscription.expireAt);
        let usedTrafficGb = 0;

        if (lockedSubscription.teamId) {
          await tx.trafficLedger.deleteMany({
            where: {
              teamId: lockedSubscription.teamId,
              subscriptionId: lockedSubscription.id,
              ...(targetUserId ? { userId: targetUserId } : {})
            }
          });

          if (targetUserId) {
            const aggregate = await tx.trafficLedger.aggregate({
              where: { subscriptionId: lockedSubscription.id },
              _sum: { usedTrafficGb: true }
            });
            usedTrafficGb = aggregate._sum.usedTrafficGb ?? 0;
          }
        }

        panelResetQueuedAt = resetSampledAt;
        panelSync =
          bindings.length > 0
            ? {
                ok: false,
                errorMessage: "3x-ui traffic reset queued for background retry; local counters are already reset"
              }
            : { ok: true };

        const remainingTrafficGb = Math.max(0, totalTrafficGb - usedTrafficGb);
        return tx.subscription.update({
          where: { id: lockedSubscription.id },
          data: {
            totalTrafficGb,
            usedTrafficGb,
            remainingTrafficGb,
            expireAt,
            state: resolveSubscriptionState(
              options.statePreference ?? (lockedSubscription.state === "paused" ? "paused" : "active"),
              remainingTrafficGb,
              expireAt
            ),
            ...(options.sourceAction ? { sourceAction: options.sourceAction } : {}),
            lastSyncedAt: new Date()
          },
          include: {
            plan: true,
            user: true,
            team: true,
            nodeAccesses: true
          }
        });
      });
    });

    if (!updatedSubscription) {
      throw new NotFoundException("订阅不存在");
    }
    if (panelResetBindings.length > 0 && panelResetQueuedAt) {
      panelSync = mergePanelSyncResults(
        panelSync,
        await this.withSubscriptionFollowUpBudget<PanelSyncBestEffortResult>(
          `3x-ui traffic reset queueing for ${subscription.id}`,
          {
            ok: false,
            errorMessage: "3x-ui traffic reset queueing is still running in background; local counters are already reset"
          },
          () => this.queuePanelTrafficResetJobsBestEffort(panelResetBindings, panelResetQueuedAt as Date)
        )
      );
    }
    return {
      subscription: updatedSubscription,
      targetUserId,
      clearedBindingCount,
      panelSync
    };
  }

  private async persistTrafficResetBaselineSamples(
    samples: Array<{
      binding: {
        id: string;
        nodeId: string;
        subscriptionId: string;
        userId: string | null;
        teamId: string | null;
      };
      uplinkBytes: bigint;
      downlinkBytes: bigint;
      sampledAt: Date;
    }>,
    tx?: any
  ) {
    if (samples.length === 0) {
      return;
    }
    const client = tx ?? this.prisma;
    const writeSamples = async (writer: any) => {
      for (const item of samples) {
        if (!item.binding.userId) {
          continue;
        }
        const totalBytes = item.uplinkBytes + item.downlinkBytes;
        const snapshotKey = buildSnapshotKey(item.binding.nodeId, item.binding.subscriptionId, item.binding.userId);
        await writer.trafficSnapshot.upsert({
          where: { snapshotKey },
          update: {
            uplinkBytes: item.uplinkBytes,
            downlinkBytes: item.downlinkBytes,
            totalBytes,
            sampledAt: item.sampledAt
          },
          create: {
            id: randomUUID(),
            snapshotKey,
            nodeId: item.binding.nodeId,
            subscriptionId: item.binding.subscriptionId,
            userId: item.binding.userId,
            teamId: item.binding.teamId,
            uplinkBytes: item.uplinkBytes,
            downlinkBytes: item.downlinkBytes,
            totalBytes,
            sampledAt: item.sampledAt
          }
        });

        await writer.panelClientBinding.update({
          where: { id: item.binding.id },
          data: {
            lastUplinkBytes: item.uplinkBytes,
            lastDownlinkBytes: item.downlinkBytes,
            lastSyncedAt: item.sampledAt
          }
        });
      }
    };

    if (tx) {
      await writeSamples(client);
      return;
    }
    await this.prisma.$transaction(writeSamples);
  }

  private async queuePanelTrafficResetJobsTx(writer: any, bindings: any[], panelResetQueuedAt: Date) {
    if (bindings.length === 0) {
      return;
    }

    for (const binding of bindings) {
      const snapshot = binding.node ?? {};
      const dedupeKey = `reset:${binding.id}`;
      await createOrRefreshPanelSyncJob(writer, dedupeKey, {
        create: {
          id: randomUUID(),
          dedupeKey,
          action: "reset_client_traffic",
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
          nextRunAt: panelResetQueuedAt
        },
        update: {
          status: "pending",
          nextRunAt: panelResetQueuedAt,
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
  }

  private async queuePanelTrafficResetJobsBestEffort(bindings: any[], panelResetQueuedAt: Date): Promise<PanelSyncBestEffortResult> {
    try {
      await this.queuePanelTrafficResetJobsTx(this.prisma, bindings, panelResetQueuedAt);
      return bindings.length > 0
        ? {
            ok: false,
            errorMessage: "3x-ui traffic reset queued for background retry; local counters are already reset"
          }
        : { ok: true };
    } catch (error) {
      const errorMessage = readErrorMessage(error, "unknown error");
      this.logger?.warn(`Traffic reset saved locally, but panel reset job queueing failed: ${errorMessage}`);
      return {
        ok: false,
        errorMessage: `3x-ui traffic reset queueing failed after local reset was saved: ${errorMessage}`
      };
    }
  }

  private async resolveTargetUserIdsForSubscriptionTarget(target: {
    userId?: string | null;
    teamId?: string | null;
  }): Promise<string[]> {
    if (target.teamId) {
      const rows = await this.prisma.teamMember.findMany({
        where: { teamId: target.teamId },
        select: { userId: true }
      });
      return Array.from(new Set(rows.map((row) => row.userId)));
    }
    return target.userId ? [target.userId] : [];
  }

  private async publishSubscriptionUpdatedEvent(target: {
    subscriptionId?: string | null;
    userId?: string | null;
    teamId?: string | null;
    state?: SubscriptionState | null;
  }) {
    const timer = setTimeout(() => {
      void this.runSubscriptionUpdatedPublishInBackground(target);
    }, SUBSCRIPTION_DEFERRED_EFFECT_DELAY_MS);
    timer.unref?.();
  }

  private async runSubscriptionUpdatedPublishInBackground(target: {
    subscriptionId?: string | null;
    userId?: string | null;
    teamId?: string | null;
    state?: SubscriptionState | null;
  }) {
    await this.withSubscriptionFollowUpBudget(
      "subscription_updated publish",
      undefined,
      async () => {
        try {
          const occurredAt = new Date().toISOString();
          this.adminRuntimeEventsService.publishSubscriptionUpdated({
            subscriptionId: target.subscriptionId ?? null,
            state: target.state ?? null
          });
          const userIds = await this.resolveTargetUserIdsForSubscriptionTarget(target);
          this.clientRuntimeEventsService.publishToUsers(userIds, {
            type: "subscription_updated",
            occurredAt,
            subscriptionId: target.subscriptionId ?? null,
            subscriptionState: target.state ?? null,
            state: target.state ?? null
          });
        } catch (error) {
          this.logger?.warn(`Local subscription change saved, but subscription_updated publish failed: ${readErrorMessage(error, "unknown error")}`);
        }
      }
    );
  }

  private tryPublishUserEvent(userId: string, event: Parameters<ClientRuntimeEventsService["publishToUser"]>[1]) {
    try {
      this.clientRuntimeEventsService.publishToUser(userId, event);
    } catch (error) {
      this.logger?.warn(`Local subscription change saved, but user event publish failed for ${userId}: ${readErrorMessage(error, "unknown error")}`);
    }
  }

  private startUserStatusFollowUpInBackground(userId: string, status: "active" | "disabled"): PanelSyncBestEffortResult {
    const timer = setTimeout(() => {
      void this.runUserStatusFollowUpInBackground(userId, status);
    }, SUBSCRIPTION_DEFERRED_EFFECT_DELAY_MS);
    timer.unref?.();
    return {
      ok: false,
      errorMessage: "user status follow-up sync queued for background processing"
    };
  }

  private startUserDisconnectFollowUpInBackground(userId: string, reason: string): PanelSyncBestEffortResult {
    const timer = setTimeout(() => {
      void this.runUserDisconnectFollowUpInBackground(userId, reason);
    }, SUBSCRIPTION_DEFERRED_EFFECT_DELAY_MS);
    timer.unref?.();
    return {
      ok: false,
      errorMessage: "user disconnect follow-up sync queued for background processing"
    };
  }

  private async queueUserDisconnectAfterLocalSaveBestEffort(
    userId: string,
    reason: string,
    label: string
  ): Promise<PanelSyncBestEffortResult> {
    return this.withSubscriptionFollowUpBudget(
      `${label} disconnect queueing for ${userId}`,
      {
        ok: false as const,
        errorMessage: `${label} disconnect queueing is still running in background`
      },
      async () => {
        try {
          const subscriptionIds = await this.findCurrentSubscriptionIdsForUser(userId);
          const syncResults = await Promise.all(
            subscriptionIds.map((subscriptionId) => this.queueSubscriptionDisconnectBestEffort(subscriptionId, reason, { userId }))
          );
          return mergePanelSyncResults(...syncResults);
        } catch (error) {
          return {
            ok: false as const,
            errorMessage: `${label} disconnect queueing failed: ${readErrorMessage(error, "unknown error")}`
          };
        }
      }
    );
  }

  private async runUserDisconnectFollowUpInBackground(userId: string, reason: string) {
    try {
      const subscriptionIds = await this.findCurrentSubscriptionIdsForUser(userId);
      const syncResults = await Promise.all(
        subscriptionIds.map((subscriptionId) => this.queueSubscriptionDisconnectBestEffort(subscriptionId, reason, { userId }))
      );
      let panelSync: PanelSyncBestEffortResult = { ok: true };
      for (const result of syncResults) {
        panelSync = mergePanelSyncResults(panelSync, result);
      }
      if (!panelSync.ok) {
        this.logger?.warn(`User disconnect follow-up for ${userId} is pending: ${panelSync.errorMessage}`);
      }
    } catch (error) {
      this.logger?.warn(`User disconnect follow-up failed for ${userId}: ${readErrorMessage(error, "unknown error")}`);
    }
  }

  private async runUserStatusFollowUpInBackground(userId: string, status: "active" | "disabled") {
    try {
      const subscriptionIds = await this.findCurrentSubscriptionIdsForUser(userId);
      const syncResults =
        status === "disabled"
          ? await Promise.all(
              subscriptionIds.map((subscriptionId) =>
                this.queueSubscriptionDisconnectBestEffort(subscriptionId, "user_disabled", { userId })
              )
            )
          : await Promise.all(subscriptionIds.map((subscriptionId) => this.syncSubscriptionPanelAccessBestEffort(subscriptionId)));
      let panelSync: PanelSyncBestEffortResult = { ok: true };
      for (const result of syncResults) {
        panelSync = mergePanelSyncResults(panelSync, result);
      }
      if (!panelSync.ok) {
        this.logger?.warn(`User status follow-up for ${userId} is pending: ${panelSync.errorMessage}`);
      }
      if (status === "disabled") {
        await this.revokeAllUserSessionsBestEffort(userId, "user disabled");
        this.tryPublishUserEvent(userId, {
          type: "account_updated",
          occurredAt: new Date().toISOString(),
          reasonCode: "account_disabled",
          reasonMessage: "当前账号已禁用，请重新登录。"
        });
      }
    } catch (error) {
      this.logger?.warn(`User status follow-up failed for ${userId}: ${readErrorMessage(error, "unknown error")}`);
    }
  }

  private async queueTeamDisconnectAfterLocalSaveBestEffort(
    teamId: string,
    reason: string,
    label: string,
    filter?: { userId?: string; nodeIds?: string[] }
  ): Promise<PanelSyncBestEffortResult> {
    const lookup = await this.findTeamSubscriptionAfterLocalSaveBestEffort(teamId, `${label} subscription lookup`);
    const subscription = lookup.subscription;
    if (!subscription) {
      return lookup.panelSync;
    }
    return mergePanelSyncResults(
      lookup.panelSync,
      await this.queueSubscriptionDisconnectBestEffort(subscription.id, reason, filter)
    );
  }

  private startTeamStatusFollowUpInBackground(teamId: string, status: "active" | "disabled"): PanelSyncBestEffortResult {
    const timer = setTimeout(() => {
      void this.runTeamStatusFollowUpInBackground(teamId, status);
    }, SUBSCRIPTION_DEFERRED_EFFECT_DELAY_MS);
    timer.unref?.();
    return {
      ok: false,
      errorMessage: "team status follow-up sync queued for background processing"
    };
  }

  private async runTeamStatusFollowUpInBackground(teamId: string, status: "active" | "disabled") {
    try {
      const lookup = await this.findTeamSubscriptionAfterLocalSaveBestEffort(
        teamId,
        "team subscription lookup after team status update"
      );
      if (!lookup.panelSync.ok) {
        this.logger?.warn(`Team status follow-up for ${teamId} is pending: ${lookup.panelSync.errorMessage}`);
      }
      const subscription = lookup.subscription;
      if (!subscription) {
        return;
      }
      const panelSync =
        status === "disabled"
          ? await this.queueSubscriptionDisconnectBestEffort(subscription.id, "team_disabled")
          : await this.syncSubscriptionPanelAccessBestEffort(subscription.id);
      if (!panelSync.ok) {
        this.logger?.warn(`Team status panel follow-up for ${teamId} is pending: ${panelSync.errorMessage}`);
      }
      await this.publishSubscriptionUpdatedEvent({
        subscriptionId: subscription.id,
        teamId,
        state: subscription.state
      });
    } catch (error) {
      this.logger?.warn(`Team status follow-up failed for ${teamId}: ${readErrorMessage(error, "unknown error")}`);
    }
  }

  private startTeamMemberRemovedFollowUpInBackground(member: { teamId: string; userId: string }): PanelSyncBestEffortResult {
    const timer = setTimeout(() => {
      void this.runTeamMemberRemovedFollowUpInBackground(member);
    }, SUBSCRIPTION_DEFERRED_EFFECT_DELAY_MS);
    timer.unref?.();
    return {
      ok: false,
      errorMessage: "team member removal follow-up sync queued for background processing"
    };
  }

  private async runTeamMemberRemovedFollowUpInBackground(member: { teamId: string; userId: string }) {
    try {
      await this.closeSupportTicketsForUserBestEffort(
        {
          userId: member.userId,
          teamId: member.teamId
        },
        "当前账号已离开原 Team，原 Team 工单已失效。如需继续咨询，请按当前归属重新创建工单。"
      );
      const lookup = await this.findTeamSubscriptionAfterLocalSaveBestEffort(
        member.teamId,
        "team subscription lookup after member delete"
      );
      if (!lookup.panelSync.ok) {
        this.logger?.warn(`Team member removal follow-up for ${member.userId} is pending: ${lookup.panelSync.errorMessage}`);
      }
      const subscription = lookup.subscription;
      if (subscription) {
        const panelSync = await this.queueSubscriptionDisconnectBestEffort(subscription.id, "team_member_removed", {
          userId: member.userId
        });
        if (!panelSync.ok) {
          this.logger?.warn(`Team member removal panel follow-up for ${member.userId} is pending: ${panelSync.errorMessage}`);
        }
        await this.publishSubscriptionUpdatedEvent({
          subscriptionId: subscription.id,
          teamId: subscription.teamId,
          state: subscription.state
        });
      }
      this.tryPublishUserEvent(member.userId, {
        type: "subscription_updated",
        occurredAt: new Date().toISOString(),
        subscriptionId: null,
        subscriptionState: null,
        state: null,
        reasonCode: "team_access_revoked",
        reasonMessage: "你已被移出当前团队，当前不再拥有团队订阅。"
      });
      this.tryPublishUserEvent(member.userId, {
        type: "node_access_updated",
        occurredAt: new Date().toISOString(),
        subscriptionId: null,
        nodeId: null,
        reasonCode: "team_access_revoked",
        reasonMessage: "团队节点授权已被移除。"
      });
    } catch (error) {
      this.logger?.warn(`Team member removal follow-up failed for ${member.userId}: ${readErrorMessage(error, "unknown error")}`);
    }
  }

  private startTeamMemberDisconnectFollowUpInBackground(member: { teamId: string; userId: string }): PanelSyncBestEffortResult {
    const timer = setTimeout(() => {
      void this.runTeamMemberDisconnectFollowUpInBackground(member);
    }, SUBSCRIPTION_DEFERRED_EFFECT_DELAY_MS);
    timer.unref?.();
    return {
      ok: false,
      errorMessage: "team member disconnect follow-up sync queued for background processing"
    };
  }

  private async runTeamMemberDisconnectFollowUpInBackground(member: { teamId: string; userId: string }) {
    try {
      const lookup = await this.findTeamSubscriptionAfterLocalSaveBestEffort(
        member.teamId,
        "team subscription lookup before member kick"
      );
      if (!lookup.panelSync.ok) {
        this.logger?.warn(`Team member disconnect follow-up for ${member.userId} is pending: ${lookup.panelSync.errorMessage}`);
      }
      const subscription = lookup.subscription;
      if (!subscription) {
        return;
      }
      const panelSync = await this.queueSubscriptionDisconnectBestEffort(subscription.id, "team_member_disconnected", {
        userId: member.userId
      });
      if (!panelSync.ok) {
        this.logger?.warn(`Team member disconnect panel follow-up for ${member.userId} is pending: ${panelSync.errorMessage}`);
      }
    } catch (error) {
      this.logger?.warn(`Team member disconnect follow-up failed for ${member.userId}: ${readErrorMessage(error, "unknown error")}`);
    }
  }

  private async findCurrentSubscriptionIdsForUser(userId: string) {
    const subscriptionIds: string[] = [];
    const personalSubscription = await this.findCurrentPersonalSubscription(userId);
    if (personalSubscription) {
      subscriptionIds.push(personalSubscription.id);
    }
    const memberships = await this.prisma.teamMember.findMany({
      where: { userId },
      select: { teamId: true }
    });
    const teamSubscriptions = await Promise.all(
      memberships.map((membership) => this.findCurrentTeamSubscription(membership.teamId))
    );
    for (const subscription of teamSubscriptions) {
      if (subscription) {
        subscriptionIds.push(subscription.id);
      }
    }
    return subscriptionIds;
  }

  private async revokeAllUserSessionsBestEffort(userId: string, reason: string) {
    await this.withSubscriptionFollowUpBudget(
      `auth session revocation for ${userId}`,
      undefined,
      async () => {
    try {
      await this.authSessionService.revokeAllUserSessions(userId);
    } catch (error) {
      this.logger?.warn(
        `Local user change saved, but auth session revocation failed for ${userId} after ${reason}: ${readErrorMessage(error, "unknown error")}`
      );
    }
      }
    );
  }

  private async queueSubscriptionDisconnectBestEffort(
    subscriptionId: string,
    reason: string,
    filter?: { userId?: string; nodeIds?: string[] }
  ): Promise<PanelSyncBestEffortResult> {
    const panelDisable = this.withSubscriptionFollowUpBudget<
      { ok: true; queuedCount: number } | { ok: false; errorMessage: string }
    >(
      `panel disable queueing for ${subscriptionId}`,
      {
        ok: false,
        errorMessage: "3x-ui panel disable queueing is still running in background"
      },
      async () => {
        try {
          const queuedCount = await this.runtimeSessionService.markPanelBindingsDisabledForSubscription(subscriptionId, filter);
          return { ok: true, queuedCount };
        } catch (error) {
          return {
            ok: false,
            errorMessage: `3x-ui panel disable queueing failed: ${readErrorMessage(error, "unknown error")}`
          };
        }
      }
    );
    const leaseJob = this.withSubscriptionFollowUpBudget<
      { ok: true; queuedCount: number } | { ok: false; errorMessage: string }
    >(
      `lease revocation job queueing for ${subscriptionId}`,
      {
        ok: false,
        errorMessage: "lease revocation job queueing is still running in background"
      },
      async () => {
        try {
          const queuedCount = await this.prisma.$transaction((tx) =>
            this.runtimeSessionService.queueLeaseRevocationJobsForSubscriptionTx(tx, subscriptionId, reason, filter)
          );
          return { ok: true, queuedCount };
        } catch (error) {
          return {
            ok: false,
            errorMessage: `lease revocation job queueing failed: ${readErrorMessage(error, "unknown error")}`
          };
        }
      }
    );
    const [panelDisableResult, leaseJobResult] = await Promise.all([
      panelDisable,
      leaseJob
    ]);

    const messages: string[] = [];
    if (panelDisableResult.ok && panelDisableResult.queuedCount > 0) {
      messages.push("3x-ui panel disable queued for background retry");
    } else if (!panelDisableResult.ok) {
      messages.push(panelDisableResult.errorMessage);
    }
    if (!leaseJobResult.ok) {
      messages.push(leaseJobResult.errorMessage);
    } else if (leaseJobResult.queuedCount > 0) {
      messages.push("lease revocation queued for background retry");
    }

    return messages.length > 0
      ? {
          ok: false,
          errorMessage: messages.join("; ")
        }
      : { ok: true };
  }

  private async syncActiveLeasesForSubscriptionBestEffort(subscription: Parameters<RuntimeSessionService["syncActiveLeasesForSubscription"]>[0]) {
    return this.withSubscriptionFollowUpBudget(
      `active lease sync for ${subscription.id}`,
      {
        ok: false as const,
        errorMessage: "active lease revocation queueing is still running in background"
      },
      async () => {
        try {
          const queuedCount = await this.runtimeSessionService.queueActiveLeaseSyncForSubscription(subscription);
          return queuedCount > 0
            ? {
                ok: false as const,
                errorMessage: "active lease revocation queued for background retry"
              }
            : { ok: true as const };
        } catch (error) {
          return {
            ok: false as const,
            errorMessage: `active lease revocation queueing failed: ${readErrorMessage(error, "unknown error")}`
          };
        }
      }
    );
  }

  private async revokeSubscriptionLeasesBestEffort(
    subscriptionId: string,
    reason: string,
    filter?: { userId?: string; nodeIds?: string[] }
  ) {
    return this.withSubscriptionFollowUpBudget(
      `active lease revocation for ${subscriptionId}`,
      {
        ok: false as const,
        revokedCount: 0,
        errorMessage: "active lease revocation queueing is still running in background"
      },
      async () => {
        try {
          const queuedCount = await this.runtimeSessionService.queueLeaseRevocationJobsForSubscription(subscriptionId, reason, filter);
          return queuedCount > 0
            ? {
                ok: false as const,
                revokedCount: 0,
                errorMessage: "active lease revocation queued for background retry"
              }
            : { ok: true as const, revokedCount: 0 };
        } catch (error) {
          return {
            ok: false as const,
            revokedCount: 0,
            errorMessage: `active lease revocation queueing failed: ${readErrorMessage(error, "unknown error")}`
          };
        }
      }
    );
  }

  private async reconcilePlanConcurrentLeaseLimits(planId: string, maxConcurrentSessions: number) {
    const subscriptions = await this.prisma.subscription.findMany({
      where: { planId },
      include: {
        team: {
          include: {
            members: true
          }
        }
      }
    });
    const affectedUserIds = new Set<string>();
    for (const subscription of subscriptions) {
      if (subscription.userId) {
        affectedUserIds.add(subscription.userId);
      }
      for (const member of subscription.team?.members ?? []) {
        affectedUserIds.add(member.userId);
      }
    }
    if (affectedUserIds.size === 0) {
      return;
    }

    const users = await this.prisma.user.findMany({
      where: { id: { in: [...affectedUserIds] } },
      select: { id: true, maxConcurrentSessionsOverride: true }
    });
    for (const user of users) {
      if (user.maxConcurrentSessionsOverride !== null) {
        continue;
      }
      try {
        await this.runtimeSessionService.enforceUserConcurrentLeaseLimit(user.id, maxConcurrentSessions);
      } catch {
        // Lease enforcement is retried on subsequent security updates and normal lease validation.
      }
    }
  }

  private reconcilePlanConcurrentLeaseLimitsBestEffort(planId: string, maxConcurrentSessions: number) {
    return this.startSubscriptionFollowUpInBackground(
      `plan lease concurrency reconciliation for ${planId}`,
      () => this.reconcilePlanConcurrentLeaseLimits(planId, maxConcurrentSessions)
    );
  }

  private async enforceSubscriptionConcurrentLeaseLimits(subscription: {
    id?: string | null;
    userId?: string | null;
    teamId?: string | null;
    plan: { maxConcurrentSessions: number };
  }) {
    return this.startSubscriptionFollowUpInBackground(
      `lease concurrency reconciliation for ${subscription.id ?? subscription.userId ?? subscription.teamId ?? "subscription"}`,
      async () => {
        const userIds = await this.resolveTargetUserIdsForSubscriptionTarget(subscription);
        const users = await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, maxConcurrentSessionsOverride: true }
        });
        for (const user of users) {
          const limit = user.maxConcurrentSessionsOverride ?? subscription.plan.maxConcurrentSessions;
          await this.runtimeSessionService.enforceUserConcurrentLeaseLimit(user.id, limit);
        }
      }
    );
  }

  private async resolveEffectiveConcurrentLeaseLimitForUser(userId: string) {
    const personalSubscription = await this.findCurrentPersonalSubscription(userId);
    if (personalSubscription && isEffectiveSubscription(personalSubscription)) {
      return personalSubscription.plan.maxConcurrentSessions;
    }

    const membership = await this.getUserMembership(userId);
    if (!membership) {
      return DEFAULT_MAX_CONCURRENT_SESSIONS;
    }
    const teamSubscription = await this.findCurrentTeamSubscription(membership.teamId);
    if (teamSubscription && isEffectiveSubscription(teamSubscription)) {
      return teamSubscription.plan.maxConcurrentSessions;
    }
    return DEFAULT_MAX_CONCURRENT_SESSIONS;
  }

  private async syncSubscriptionPanelAccessBestEffort(subscriptionId: string) {
    return this.withSubscriptionFollowUpBudget(
      `subscription panel access sync for ${subscriptionId}`,
      {
        ok: false as const,
        errorMessage: "3x-ui panel sync is still running in background"
      },
      async () => {
    try {
      const queuedCount = await this.runtimeSessionService.queueSubscriptionPanelAccessSync(subscriptionId);
      return queuedCount > 0
        ? {
            ok: false as const,
            errorMessage: "3x-ui panel sync queued for background retry"
          }
        : { ok: true as const };
    } catch (error) {
      return {
        ok: false as const,
        errorMessage: readErrorMessage(error, "3x-ui panel sync failed")
      };
    }
      }
    );
  }

  private async findCurrentPersonalSubscription(userId: string) {
    const rows = await this.prisma.subscription.findMany({
      where: {
        userId
      },
      include: { plan: true, user: true, team: true, nodeAccesses: true },
      orderBy: [{ expireAt: "desc" }, { createdAt: "desc" }]
    });
    return pickCurrentSubscription(rows as SubscriptionWithSecurityPlan[]);
  }

  private async findCurrentPersonalSubscriptionTx(writer: any, userId: string) {
    const rows = await writer.subscription.findMany({
      where: {
        userId
      },
      include: { plan: true, user: true, team: true, nodeAccesses: true },
      orderBy: [{ expireAt: "desc" }, { createdAt: "desc" }]
    });
    return pickCurrentSubscription(rows as AdminSubscriptionEntity[]);
  }

  private async findCurrentTeamSubscription(teamId: string) {
    const rows = await this.prisma.subscription.findMany({
      where: { teamId },
      include: { plan: true, user: true, team: true, nodeAccesses: true },
      orderBy: [{ expireAt: "desc" }, { createdAt: "desc" }]
    });
    return pickCurrentSubscription(rows);
  }

  private async findCurrentTeamSubscriptionTx(writer: any, teamId: string) {
    const rows = await writer.subscription.findMany({
      where: { teamId },
      include: { plan: true, user: true, team: true, nodeAccesses: true },
      orderBy: [{ expireAt: "desc" }, { createdAt: "desc" }]
    });
    return pickCurrentSubscription(rows as AdminSubscriptionEntity[]);
  }

  private async findTeamSubscriptionAfterLocalSaveBestEffort(teamId: string, label: string) {
    const lookup = await this.withSubscriptionFollowUpBudget<
      | { ok: true; subscription: Awaited<ReturnType<AdminSubscriptionService["findCurrentTeamSubscription"]>> | null }
      | { ok: false; errorMessage: string }
    >(
      `${label} for ${teamId}`,
      {
        ok: false,
        errorMessage: `${label} is still running in background`
      },
      async () => {
        try {
          return { ok: true, subscription: await this.findCurrentTeamSubscription(teamId) };
        } catch (error) {
          return {
            ok: false,
            errorMessage: `${label} failed: ${readErrorMessage(error, "unknown error")}`
          };
        }
      }
    );

    if (lookup.ok) {
      return {
        subscription: lookup.subscription,
        panelSync: { ok: true } as PanelSyncBestEffortResult
      };
    }
    return {
      subscription: null,
      panelSync: {
        ok: false,
        errorMessage: lookup.errorMessage
      } as PanelSyncBestEffortResult
    };
  }

  private async getUserMembership(userId: string) {
    return this.prisma.teamMember.findUnique({
      where: { userId }
    });
  }

  private async getMemberUsedTrafficGb(teamId: string, userId: string, subscriptionId: string) {
    const rows = await this.prisma.trafficLedger.findMany({
      where: { teamId, userId, subscriptionId }
    });
    return rows.reduce((sum, item) => sum + item.usedTrafficGb, 0);
  }

  private async ensureUserExists(userId: string) {
    const row = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!row) {
      throw new NotFoundException("用户不存在");
    }
    return row;
  }

  private async requireAdminUserRecord(userId: string) {
    const row = (await this.listAdminUsers()).find((item) => item.id === userId);
    if (!row) {
      throw new NotFoundException("用户不存在");
    }
    return row;
  }

  private async withAdminUserRefreshBestEffort(
    userId: string,
    fallbackUser: {
      id: string;
      email: string;
      displayName: string;
      role: "user" | "admin";
      status: "active" | "disabled";
      lastSeenAt: Date;
      maxConcurrentSessionsOverride: number | null;
    },
    panelSync: PanelSyncBestEffortResult,
    syncedMessage: string
  ): Promise<AdminUserRecordDto> {
    const refresh = await this.withSubscriptionFollowUpBudget<
      { ok: true; record: AdminUserRecordDto } | { ok: false; errorMessage: string }
    >(
      `admin user response refresh for ${userId}`,
      {
        ok: false,
        errorMessage: "admin user response refresh is still running in background"
      },
      async () => {
        try {
          return {
            ok: true,
            record: withPanelSyncStatus(await this.requireAdminUserRecord(userId), panelSync, syncedMessage)
          };
        } catch (error) {
          const errorMessage = readErrorMessage(error, "unknown error");
          this.logger?.warn(`Local user change saved, but admin user response refresh failed for ${userId}: ${errorMessage}`);
          return {
            ok: false,
            errorMessage: `admin user response refresh failed: ${errorMessage}`
          };
        }
      }
    );
    if (refresh.ok) {
      return refresh.record;
    }
      const fallbackPanelSync = mergePanelSyncResults(panelSync, {
        ok: false,
        errorMessage: refresh.errorMessage
      });
      return withPanelSyncStatus(
        toAdminUserRecord(fallbackUser, {
          accountType: "personal",
          teamId: null,
          teamName: null,
          subscriptionCount: 0,
          activeSubscriptionCount: 0,
          currentSubscription: null
        }),
        fallbackPanelSync,
        syncedMessage
      );
  }

  private async ensurePlanExists(planId: string) {
    const row = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!row) {
      throw new NotFoundException("套餐不存在");
    }
    return row;
  }

  private async requireSubscription(subscriptionId: string) {
    const row = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        plan: true,
        user: true,
        team: true,
        nodeAccesses: true
      }
    });
    if (!row) {
      throw new NotFoundException("订阅不存在");
    }
    return row;
  }

  private async requireTeam(teamId: string) {
    const row = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!row) {
      throw new NotFoundException("团队不存在");
    }
    return row;
  }

  private async requireTeamRecord(teamId: string) {
    const row = await this.loadBasicTeamRecord(teamId);
    if (!row) {
      throw new NotFoundException("团队不存在");
    }
    return row;
  }

  private async withTeamRecordRefreshBestEffort(
    teamId: string,
    panelSync: PanelSyncBestEffortResult,
    syncedMessage: string
  ): Promise<AdminTeamRecordDto> {
    const refresh = await this.withSubscriptionFollowUpBudget<
      { ok: true; record: AdminTeamRecordDto } | { ok: false; errorMessage: string }
    >(
      `admin team response refresh for ${teamId}`,
      {
        ok: false,
        errorMessage: "admin team response refresh is still running in background"
      },
      async () => {
        try {
          return {
            ok: true,
            record: withPanelSyncStatus(await this.requireTeamRecord(teamId), panelSync, syncedMessage)
          };
        } catch (error) {
          const errorMessage = readErrorMessage(error, "unknown error");
          this.logger?.warn(`Local team change saved, but admin team response refresh failed for ${teamId}: ${errorMessage}`);
          return {
            ok: false,
            errorMessage: `admin team response refresh failed: ${errorMessage}`
          };
        }
      }
    );
    if (refresh.ok) {
      return refresh.record;
    }
      const fallbackPanelSync = mergePanelSyncResults(panelSync, {
        ok: false,
        errorMessage: refresh.errorMessage
      });
      let record: AdminTeamRecordDto;
      const basicRecord = await this.withSubscriptionFollowUpBudget<AdminTeamRecordDto | null>(
        `basic team response fallback for ${teamId}`,
        null,
        async () => {
          try {
            return await this.loadBasicTeamRecord(teamId);
          } catch (fallbackError) {
            this.logger?.warn(
              `Local team change saved, but basic team response fallback failed for ${teamId}: ${readErrorMessage(fallbackError, "unknown error")}`
            );
            return null;
          }
        }
      );
      if (basicRecord) {
        record = basicRecord;
      } else {
        this.logger?.warn(
          `Local team change saved, but basic team response fallback failed for ${teamId}: timeout`
        );
        const now = new Date().toISOString();
        record = {
          id: teamId,
          name: "Team",
          ownerUserId: "",
          ownerDisplayName: "",
          ownerEmail: "",
          status: "active",
          memberCount: 0,
          currentSubscription: null,
          members: [],
          usage: [],
          createdAt: now,
          updatedAt: now
        };
      }
      return withPanelSyncStatus(record, fallbackPanelSync, syncedMessage);
  }

  private async loadBasicTeamRecord(teamId: string): Promise<AdminTeamRecordDto> {
    const row = await this.prisma.team.findUnique({
      where: { id: teamId },
      include: {
        owner: {
          select: { displayName: true, email: true }
        },
        members: {
          include: {
            user: {
              select: { email: true, displayName: true }
            }
          }
        },
        subscriptions: {
          include: { plan: true },
          orderBy: [{ expireAt: "desc" }, { createdAt: "desc" }]
        }
      }
    });
    if (!row) {
      throw new NotFoundException("Team not found");
    }
    return toAdminTeamRecord({
      ...row,
      trafficLedgerEntries: []
    });
  }

  private async requireTeamMember(memberId: string) {
    const row = await this.prisma.teamMember.findUnique({
      where: { id: memberId }
    });
    if (!row) {
      throw new NotFoundException("团队成员不存在");
    }
    return row;
  }

  private async assertUserCanJoinTeam(userId: string) {
    const user = await this.ensureUserExists(userId);
    if (user.status !== "active") {
      throw new BadRequestException("账号已禁用，不能加入团队");
    }

    const membership = await this.getUserMembership(userId);
    if (membership) {
      throw new BadRequestException("该账号已属于其他团队");
    }

    const personal = await this.findCurrentPersonalSubscription(userId);
    if (personal && isEffectiveSubscription(personal)) {
      throw new BadRequestException("该账号已有个人有效订阅，不能加入团队");
    }
  }

  private async closePersonalSupportTicketsForUser(userId: string, body: string) {
    return this.closeSupportTicketsForUser(
      {
        userId,
        teamId: null
      },
      body
    );
  }

  private async closePersonalSupportTicketsForUserBestEffort(userId: string, body: string) {
    await this.closeSupportTicketsForUserBestEffort({ userId, teamId: null }, body);
  }

  private async closeTeamSupportTicketsForUser(userId: string, body: string) {
    return this.closeSupportTicketsForUser(
      {
        userId,
        requireTeamOwnership: true
      },
      body
    );
  }

  private async closeTeamSupportTicketsForUserBestEffort(userId: string, body: string) {
    await this.closeSupportTicketsForUserBestEffort({ userId, requireTeamOwnership: true }, body);
  }

  private async closeSupportTicketsForUserBestEffort(
    target: {
      userId: string;
      teamId?: string | null;
      requireTeamOwnership?: boolean;
    },
    body: string
  ) {
    await this.withSubscriptionFollowUpBudget(
      `support ticket cleanup for ${target.userId}`,
      undefined,
      async () => {
        try {
          await this.closeSupportTicketsForUser(target, body);
        } catch (error) {
          this.logger?.warn(
            `Local team membership change saved, but support ticket cleanup failed for ${target.userId}: ${readErrorMessage(error, "unknown error")}`
          );
        }
      }
    );
  }

  private async closeSupportTicketsForUser(
    target: {
      userId: string;
      teamId?: string | null;
      requireTeamOwnership?: boolean;
    },
    body: string
  ) {
    const where: {
      userId: string;
      status: { not: "closed" };
      teamId?: string | null;
      NOT?: { teamId: null };
    } = {
      userId: target.userId,
      status: { not: "closed" }
    };

    if (target.requireTeamOwnership) {
      where.NOT = { teamId: null };
    } else if (target.teamId !== undefined) {
      where.teamId = target.teamId;
    }

    const tickets = await this.prisma.supportTicket.findMany({
      where,
      select: {
        id: true,
        userId: true
      }
    });

    if (tickets.length === 0) {
      return 0;
    }

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.supportTicketMessage.createMany({
        data: tickets.map((ticket) => ({
          id: createId("ticket_msg"),
          ticketId: ticket.id,
          authorRole: "system",
          authorUserId: null,
          body
        }))
      }),
      this.prisma.supportTicket.updateMany({
        where: {
          id: {
            in: tickets.map((ticket) => ticket.id)
          }
        },
        data: {
          status: "closed",
          closedAt: now,
          lastMessageAt: now
        }
      })
    ]);

    for (const ticket of tickets) {
      this.tryPublishUserEvent(ticket.userId, {
        type: "ticket_updated",
        occurredAt: now.toISOString(),
        ticketId: ticket.id,
        ticketStatus: "closed"
      });
    }

    return tickets.length;
  }
}

function createId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function toAdminPlanRecord(
  row: {
    id: string;
    name: string;
    scope: PlanScope;
    totalTrafficGb: number;
    renewable: boolean;
    maxConcurrentSessions: number;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
  },
  subscriptionCount: number
): AdminPlanRecordDto {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    totalTrafficGb: row.totalTrafficGb,
    renewable: row.renewable,
    maxConcurrentSessions: row.maxConcurrentSessions,
    isActive: row.isActive,
    subscriptionCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function normalizePlanName(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new BadRequestException("Plan name must not be empty.");
  }
  return trimmed;
}

function readErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function withPanelSyncStatus<T extends object>(
  record: T,
  panelSync: PanelSyncBestEffortResult,
  syncedMessage: string
) {
  return {
    ...record,
    ...buildPanelSyncResult(panelSync),
    message: buildPanelSyncMessage(panelSync, syncedMessage)
  };
}

function buildPanelSyncResult(panelSync: PanelSyncBestEffortResult) {
  if (panelSync.ok) {
    return {
      panelSyncStatus: "synced" as const,
      panelSyncMessage: null
    };
  }
  return {
    panelSyncStatus: "pending" as const,
    panelSyncMessage: `本地操作已保存，3x-ui 面板同步已进入后台队列：${panelSync.errorMessage}`
  };
}

function buildPanelSyncMessage(panelSync: PanelSyncBestEffortResult, syncedMessage: string) {
  if (panelSync.ok) {
    return syncedMessage;
  }
  return `${syncedMessage} ${buildPanelSyncResult(panelSync).panelSyncMessage}`;
}

function mergePanelSyncResults(...results: PanelSyncBestEffortResult[]): PanelSyncBestEffortResult {
  const failed = results.filter((item): item is { ok: false; errorMessage: string } => !item.ok);
  if (failed.length === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    errorMessage: failed.map((item) => item.errorMessage).join("; ")
  };
}

function buildPanelSyncSummaryMap(
  jobs: PanelSyncSummaryJob[],
  key: "subscriptionId" | "userId" | "teamId"
) {
  const result = new Map<string, PanelSyncSummary>();
  for (const job of jobs) {
    const id = job[key];
    if (!id) {
      continue;
    }
    const summary = result.get(id) ?? { pending: 0, running: 0, failed: 0, lastError: null };
    const count = job.count ?? 1;
    if (job.status === "failed") {
      summary.failed += count;
    } else if (job.status === "running") {
      summary.running += count;
    } else {
      summary.pending += count;
    }
    summary.lastError = summary.lastError ?? job.lastError;
    result.set(id, summary);
  }
  return result;
}

function withPanelSyncSummary<T extends object>(record: T, summary?: PanelSyncSummary) {
  if (!summary) {
    return record;
  }
  const total = summary.pending + summary.running + summary.failed;
  if (total === 0) {
    return record;
  }
  const parts = [
    summary.pending > 0 ? `待同步 ${summary.pending}` : null,
    summary.running > 0 ? `执行中 ${summary.running}` : null,
    summary.failed > 0 ? `失败 ${summary.failed}` : null
  ].filter(Boolean);
  const message = [
    `存在 ${total} 个面板同步任务：${parts.join("，")}`,
    summary.lastError ? `最近错误：${summary.lastError}` : null
  ]
    .filter(Boolean)
    .join("；");
  return {
    ...record,
    panelSyncStatus: "pending" as const,
    panelSyncMessage: message,
    panelSyncSummary: {
      pending: summary.pending,
      running: summary.running,
      failed: summary.failed,
      total,
      lastError: summary.lastError
    }
  };
}

function getSubscriptionDisconnectReason(subscription: {
  state: SubscriptionState;
  remainingTrafficGb: number;
  expireAt: Date;
}) {
  if (subscription.expireAt.getTime() <= Date.now() || subscription.state === "expired") {
    return "subscription_expired";
  }
  if (subscription.remainingTrafficGb <= 0 || subscription.state === "exhausted") {
    return "subscription_exhausted";
  }
  if (subscription.state === "paused") {
    return "subscription_paused";
  }
  return null;
}

function assertPlanScopeMatchesSubscription(
  planScope: "personal" | "team",
  subscription: { userId: string | null; teamId: string | null }
) {
  if (subscription.userId && planScope !== "personal") {
    throw new BadRequestException("Personal subscriptions can only use personal plans.");
  }
  if (subscription.teamId && planScope !== "team") {
    throw new BadRequestException("Team subscriptions can only use team plans.");
  }
}

function isPrismaUniqueConstraintError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

function toAdminLocalSaveHttpError(error: unknown, message: string) {
  if (error instanceof HttpException) {
    return error;
  }
  if (isPrismaCodedError(error)) {
    return toPrismaTransientHttpError(error, message) ?? new ServiceUnavailableException(message);
  }
  return error;
}
