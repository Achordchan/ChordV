import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
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
  KickTeamMemberInputDto,
  KickTeamMemberResultDto,
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
import { AuthSessionService } from "./auth-session.service";
import { PrismaService } from "./prisma.service";
import { RuntimeSessionService } from "./runtime-session.service";
import { runWithSubscriptionOwnerLock, runWithSubscriptionUsageLock } from "./usage-lock.utils";
import { buildSnapshotKey, DEFAULT_MAX_CONCURRENT_SESSIONS } from "./runtime-session.utils";
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
import { XuiService } from "../xui/xui.service";

type PanelSyncBestEffortResult = { ok: true } | { ok: false; errorMessage: string };
type AdminSubscriptionEntity = Parameters<typeof toAdminSubscriptionRecord>[0];
type ResetTrafficCountersResult = {
  subscription: AdminSubscriptionEntity;
  targetUserId: string | null;
  clearedBindingCount: number;
};

@Injectable()
export class AdminSubscriptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clientRuntimeEventsService: ClientRuntimeEventsService,
    private readonly authSessionService: AuthSessionService,
    private readonly runtimeSessionService: RuntimeSessionService,
    private readonly xuiService: XuiService
  ) {}

  async listAdminUsers(): Promise<AdminUserRecordDto[]> {
    const rows = await this.prisma.user.findMany({
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
    });

    return rows.map((row) => {
      const membership = row.teamMemberships[0] ?? null;
      const currentSubscription = membership
        ? pickCurrentSubscription(row.teamMemberships[0]?.team.subscriptions ?? [])
        : pickCurrentSubscription(row.subscriptions);

      return toAdminUserRecord(row, {
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
      });
    });
  }

  async createUser(input: CreateUserInputDto): Promise<AdminUserRecordDto> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException("邮箱已存在");
    }

    const passwordHash = await bcrypt.hash(input.password, 10);
    const row = await this.prisma.user.create({
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

    const disableTargets: string[] = [];
    if (statusChanged && input.status === "disabled") {
      const personalSubscription = await this.findCurrentPersonalSubscription(userId);
      if (personalSubscription) {
        disableTargets.push(personalSubscription.id);
      }
      const memberships = await this.prisma.teamMember.findMany({
        where: { userId },
        select: { teamId: true }
      });
      for (const membership of memberships) {
        const teamSubscription = await this.findCurrentTeamSubscription(membership.teamId);
        if (teamSubscription) {
          disableTargets.push(teamSubscription.id);
        }
      }
    }

    if (disableTargets.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        for (const subscriptionId of disableTargets) {
          await this.queuePanelDisableJobsForSubscriptionTx(tx, subscriptionId, { userId });
          await this.queueLeaseRevocationJobsForSubscriptionTx(tx, subscriptionId, "user_disabled", { userId });
        }
        await tx.user.update({
          where: { id: userId },
          data
        });
      });
    } else {
      await this.prisma.user.update({
        where: { id: userId },
        data
      });
    }

    if ((roleChanged || passwordChanged) && !(statusChanged && input.status === "disabled")) {
      await this.authSessionService.revokeAllUserSessions(userId);
    }

    if (statusChanged) {
      if (input.status === "disabled") {
        for (const subscriptionId of disableTargets) {
          await this.revokeSubscriptionLeasesBestEffort(subscriptionId, "user_disabled", { userId });
        }
      } else if (input.status === "active") {
        const personalSubscription = await this.findCurrentPersonalSubscription(userId);
        if (personalSubscription) {
          await this.syncSubscriptionPanelAccessBestEffort(personalSubscription.id);
        }
        const memberships = await this.prisma.teamMember.findMany({
          where: { userId },
          select: { teamId: true }
        });
        for (const membership of memberships) {
          const teamSubscription = await this.findCurrentTeamSubscription(membership.teamId);
          if (teamSubscription) {
            await this.syncSubscriptionPanelAccessBestEffort(teamSubscription.id);
          }
        }
      }

      if (input.status === "disabled") {
        await this.authSessionService.revokeAllUserSessions(userId);
        this.clientRuntimeEventsService.publishToUser(userId, {
          type: "account_updated",
          occurredAt: new Date().toISOString(),
          reasonCode: "account_disabled",
          reasonMessage: "当前账号已禁用，请重新登录。"
        });
      }
    }

    return this.requireAdminUserRecord(userId);
  }

  async updateUserSecurity(userId: string, input: UpdateUserSecurityInputDto): Promise<AdminUserRecordDto> {
    await this.ensureUserExists(userId);
    const row = await this.prisma.user.update({
      where: { id: userId },
      data: {
        maxConcurrentSessionsOverride: input.maxConcurrentSessionsOverride ?? null
      }
    });
    const effectiveLimit =
      row.maxConcurrentSessionsOverride ?? (await this.resolveEffectiveConcurrentLeaseLimitForUser(userId));
    if (effectiveLimit !== null) {
      await this.runtimeSessionService.enforceUserConcurrentLeaseLimit(userId, effectiveLimit);
    }
    return this.requireAdminUserRecord(userId);
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

    const user = reset.targetUserId ? await this.requireAdminUserRecord(reset.targetUserId) : null;
    return {
      ok: true,
      subscriptionId: subscription.id,
      userId: reset.targetUserId,
      clearedBindingCount: reset.clearedBindingCount,
      message:
        reset.clearedBindingCount > 0
          ? "已重置订阅流量，并同步清空 3x-ui 面板计量"
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
    const row = await this.prisma.plan.create({
      data: {
        id: createId("plan"),
        name: input.name.trim(),
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
    const row = await this.prisma.plan.update({
      where: { id: planId },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
        ...(input.totalTrafficGb !== undefined ? { totalTrafficGb: input.totalTrafficGb } : {}),
        ...(input.renewable !== undefined ? { renewable: input.renewable } : {}),
        ...(input.maxConcurrentSessions !== undefined ? { maxConcurrentSessions: input.maxConcurrentSessions } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {})
      }
    });
    if (input.maxConcurrentSessions !== undefined && input.maxConcurrentSessions !== current.maxConcurrentSessions) {
      await this.reconcilePlanConcurrentLeaseLimits(planId, row.maxConcurrentSessions);
    }
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

  async updatePlanSecurity(planId: string, input: UpdatePlanSecurityInputDto): Promise<AdminPlanRecordDto> {
    await this.ensurePlanExists(planId);
    const row = await this.prisma.plan.update({
      where: { id: planId },
      data: {
        maxConcurrentSessions: input.maxConcurrentSessions
      }
    });
    const subscriptionCount = await this.prisma.subscription.count({ where: { planId } });
    await this.reconcilePlanConcurrentLeaseLimits(planId, row.maxConcurrentSessions);
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

  async listAdminSubscriptions(): Promise<AdminSubscriptionRecordDto[]> {
    const rows = await this.prisma.subscription.findMany({
      include: {
        plan: true,
        user: true,
        team: true,
        nodeAccesses: true
      },
      orderBy: [{ expireAt: "desc" }, { createdAt: "desc" }]
    });
    return rows.map(toAdminSubscriptionRecord);
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

    try {
      await this.closeTeamSupportTicketsForUser(
        input.userId,
        "当前账号已切换为个人订阅，原 Team 工单已失效。如需继续咨询，请在当前个人订阅下重新创建工单。"
      );
    } catch (error) {
      await this.prisma.subscription.delete({ where: { id: row.id } }).catch(() => undefined);
      throw new BadGatewayException(`Subscription was not created because support ticket cleanup failed: ${readErrorMessage(error, "unknown error")}`);
    }

    const panelSync = await this.syncSubscriptionPanelAccessBestEffort(row.id);
    await this.publishSubscriptionUpdatedEvent({
      subscriptionId: row.id,
      userId: row.userId,
      teamId: row.teamId,
      state: row.state
    });

    return withPanelSyncStatus(toAdminSubscriptionRecord(row), panelSync, "订阅已创建。");
  }

  async renewSubscription(subscriptionId: string, input: RenewSubscriptionInputDto): Promise<AdminSubscriptionRecordDto> {
    const current = await this.requireSubscription(subscriptionId);
    const nextExpireAt = resolveRenewExpireAt(current.expireAt, input.expireAt);
    const totalTrafficGb = input.totalTrafficGb ?? current.totalTrafficGb;
    const row = input.resetTraffic
      ? (
          await this.resetSubscriptionTrafficCounters(current, {
            allowTeamWideReset: true,
            totalTrafficGb,
            expireAt: nextExpireAt,
            sourceAction: "renewed",
            statePreference: "active"
          })
        ).subscription
      : await runWithSubscriptionUsageLock(subscriptionId, async () => {
          const lockedSubscription = await this.requireSubscription(subscriptionId);
          const remainingTrafficGb = Math.max(0, totalTrafficGb - lockedSubscription.usedTrafficGb);
          const state = resolveSubscriptionState("active", remainingTrafficGb, nextExpireAt);
          const disconnectReason = getSubscriptionDisconnectReason({
            state,
            remainingTrafficGb,
            expireAt: nextExpireAt
          });
          const mustDisableRemoteClients = Boolean(disconnectReason);

          return this.prisma.$transaction(async (tx) => {
            if (mustDisableRemoteClients) {
              await this.queuePanelDisableJobsForSubscriptionTx(tx, subscriptionId);
              await this.queueLeaseRevocationJobsForSubscriptionTx(tx, subscriptionId, disconnectReason as string);
            }
            return tx.subscription.update({
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
            });
          });
        });

    const panelSync = mergePanelSyncResults(
      await this.syncActiveLeasesForSubscriptionBestEffort(row),
      await this.syncSubscriptionPanelAccessBestEffort(subscriptionId)
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
    const disconnectReason = getSubscriptionDisconnectReason({
      state,
      remainingTrafficGb,
      expireAt
    });
    const mustDisableRemoteClients = Boolean(disconnectReason);
    return this.prisma.$transaction(async (tx) => {
      if (mustDisableRemoteClients) {
        await this.queuePanelDisableJobsForSubscriptionTx(tx, subscriptionId);
        await this.queueLeaseRevocationJobsForSubscriptionTx(tx, subscriptionId, disconnectReason as string);
      }
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
      await this.enforceSubscriptionConcurrentLeaseLimits(row),
      await this.syncActiveLeasesForSubscriptionBestEffort(row),
      await this.syncSubscriptionPanelAccessBestEffort(subscriptionId)
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
      const disconnectReason = getSubscriptionDisconnectReason({
        state,
        remainingTrafficGb,
        expireAt
      });
      const mustDisableRemoteClients = Boolean(disconnectReason);

      return this.prisma.$transaction(async (tx) => {
        if (mustDisableRemoteClients) {
          await this.queuePanelDisableJobsForSubscriptionTx(tx, subscriptionId);
          await this.queueLeaseRevocationJobsForSubscriptionTx(tx, subscriptionId, disconnectReason as string);
        }
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

    const leaseSync = await this.syncActiveLeasesForSubscriptionBestEffort(row);
    const panelSync = mergePanelSyncResults(
      leaseSync,
      await this.syncSubscriptionPanelAccessBestEffort(subscriptionId)
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
    let membershipCreated = false;
    let teamPanelSync: PanelSyncBestEffortResult = { ok: true };

    try {
      await this.prisma.teamMember.create({
        data: {
          id: membershipId,
          teamId: targetTeam.id,
          userId: user.id,
          role: "member"
        }
      });
      membershipCreated = true;

      teamPanelSync = await this.syncSubscriptionPanelAccessBestEffort(teamSubscription.id);
      await this.runtimeSessionService.revokeSubscriptionLeases(subscriptionId, "team_member_removed", {
        userId: user.id
      });
      const removeResult = await this.runtimeSessionService.removePanelBindingsForSubscription(subscriptionId, {
        userId: user.id
      });
      this.runtimeSessionService.assertPanelBindingMutation("删除个人订阅的 3x-ui 客户端失败", removeResult);

      await this.closePersonalSupportTicketsForUser(
        user.id,
        "当前账号已切换为 Team 归属，原个人订阅工单已失效。如需继续咨询，请在当前 Team 归属下重新创建工单。"
      );

      await this.prisma.subscription.delete({
        where: { id: subscriptionId }
      });
    } catch (error) {
      if (membershipCreated) {
        await this.prisma.teamMember.deleteMany({
          where: { id: membershipId }
        });
        const rollbackErrors: string[] = [];
        const teamRollback = await this.syncSubscriptionPanelAccessBestEffort(teamSubscription.id);
        if (!teamRollback.ok) {
          rollbackErrors.push(teamRollback.errorMessage);
        }
        const personalRollback = await this.syncSubscriptionPanelAccessBestEffort(subscriptionId);
        if (!personalRollback.ok) {
          rollbackErrors.push(personalRollback.errorMessage);
        }
        if (rollbackErrors.length > 0) {
          const baseMessage = readErrorMessage(error, "个人订阅转 Team 失败");
          throw new BadGatewayException(`${baseMessage}；回滚时又出现问题：${rollbackErrors.join("；")}`);
        }
      }
      throw error;
    }

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

    const teamRecord = await this.requireTeamRecord(targetTeam.id);
    return {
      ok: true,
      deletedSubscriptionId: subscriptionId,
      teamId: teamRecord.id,
      teamName: teamRecord.name,
      teamSubscriptionId: teamSubscription.id,
      ...buildPanelSyncResult(teamPanelSync),
      message: buildPanelSyncMessage(teamPanelSync, `个人订阅已删除，账号已转入 Team「${teamRecord.name}」。`)
    };
  }

  async listAdminTeams(): Promise<AdminTeamRecordDto[]> {
    const teams = await this.prisma.team.findMany({
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
    });
    const usageByTeamId = await this.loadTeamUsageSummaries(teams.map((team) => team.id));
    return teams.map((team) =>
      toAdminTeamRecord({
        ...team,
        trafficLedgerEntries: usageByTeamId.get(team.id) ?? []
      })
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
    let teamCreated = false;
    try {
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
      teamCreated = true;

      await this.closePersonalSupportTicketsForUser(
        owner.id,
        "当前账号已切换为 Team 归属，原个人订阅工单已失效。如需继续咨询，请在当前 Team 归属下重新创建工单。"
      );
    } catch (error) {
      if (teamCreated) {
        try {
          await this.prisma.team.delete({ where: { id: teamId } });
        } catch (rollbackError) {
          throw new BadGatewayException(
            `${readErrorMessage(error, "创建 Team 失败")}；回滚 Team 时又出现问题：${readErrorMessage(rollbackError, "删除 Team 失败")}`
          );
        }
      }
      throw error;
    }

    return this.requireTeamRecord(teamId);
  }

  async updateTeam(teamId: string, input: UpdateTeamInputDto): Promise<AdminTeamRecordDto> {
    const current = await this.requireTeam(teamId);
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.status !== undefined) data.status = input.status;
    const teamSubscription = await this.findCurrentTeamSubscription(teamId);
    const teamWillBeDisabled = Boolean(teamSubscription && input.status === "disabled" && input.status !== current.status);
    let teamUpdatedInOwnerTransaction = false;

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
        if (teamWillBeDisabled && teamSubscription) {
          await this.queuePanelDisableJobsForSubscriptionTx(tx, teamSubscription.id);
          await this.queueLeaseRevocationJobsForSubscriptionTx(tx, teamSubscription.id, "team_disabled");
        }
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
        try {
          await this.closePersonalSupportTicketsForUser(
          nextOwner.id,
          "当前账号已切换为 Team 归属，原个人订阅工单已失效。如需继续咨询，请在当前 Team 归属下重新创建工单。"
        );
        } catch (error) {
          await this.prisma.$transaction([
            this.prisma.teamMember.updateMany({
              where: { teamId, userId: current.ownerUserId },
              data: { role: "owner" }
            }),
            this.prisma.teamMember.deleteMany({
              where: { teamId, userId: nextOwner.id }
            }),
            this.prisma.team.update({
              where: { id: teamId },
              data: {
                ownerUserId: current.ownerUserId,
                name: current.name,
                status: current.status
              }
            })
          ]);
          throw new BadGatewayException(`Team owner was not changed because support ticket cleanup failed: ${readErrorMessage(error, "unknown error")}`);
        }
      }
    }

    if (!teamUpdatedInOwnerTransaction) {
      if (teamWillBeDisabled && teamSubscription) {
        await this.prisma.$transaction(async (tx) => {
          await this.queuePanelDisableJobsForSubscriptionTx(tx, teamSubscription.id);
          await this.queueLeaseRevocationJobsForSubscriptionTx(tx, teamSubscription.id, "team_disabled");
          await tx.team.update({
            where: { id: teamId },
            data
          });
        });
      } else {
        await this.prisma.team.update({
          where: { id: teamId },
          data
        });
      }
    }

    if (teamSubscription) {
      if (input.status !== undefined && input.status !== current.status) {
        if (input.status === "disabled") {
          await this.revokeSubscriptionLeasesBestEffort(teamSubscription.id, "team_disabled");
        } else if (input.status === "active") {
          await this.syncSubscriptionPanelAccessBestEffort(teamSubscription.id);
        }
      } else if (input.ownerUserId && input.ownerUserId !== current.ownerUserId) {
        await this.syncSubscriptionPanelAccessBestEffort(teamSubscription.id);
      }
      await this.publishSubscriptionUpdatedEvent({
        subscriptionId: teamSubscription.id,
        teamId,
        state: teamSubscription.state
      });
    }

    return this.requireTeamRecord(teamId);
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

    const member = await this.prisma.teamMember.create({
      data: {
        id: createId("member"),
        teamId,
        userId: input.userId,
        role: input.role ?? "member"
      }
    });

    try {
      await this.closePersonalSupportTicketsForUser(
      input.userId,
      "当前账号已切换为 Team 归属，原个人订阅工单已失效。如需继续咨询，请在当前 Team 归属下重新创建工单。"
    );

    } catch (error) {
      await this.prisma.teamMember.delete({ where: { id: member.id } }).catch(() => null);
      throw new BadGatewayException(`Team member was not added because support ticket cleanup failed: ${readErrorMessage(error, "unknown error")}`);
    }

    const subscription = await this.findCurrentTeamSubscription(teamId);
    if (subscription) {
      await this.syncSubscriptionPanelAccessBestEffort(subscription.id);
      await this.publishSubscriptionUpdatedEvent({
        subscriptionId: subscription.id,
        teamId: subscription.teamId,
        state: subscription.state
      });
    }

    return this.requireTeamRecord(teamId);
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
    } else {
      await this.prisma.teamMember.update({
        where: { id: memberId },
        data: { role: nextRole }
      });
    }

    return this.requireTeamRecord(member.teamId);
  }

  async deleteTeamMember(teamId: string, memberId: string) {
    const member = await this.requireTeamMember(memberId);
    if (member.teamId !== teamId) {
      throw new BadRequestException("Team member does not belong to the requested team.");
    }
    if (member.role === "owner") {
      throw new BadRequestException("负责人不能直接移除，请先转移负责人");
    }

    const subscription = await this.findCurrentTeamSubscription(member.teamId);
    await this.closeSupportTicketsForUser(
      {
        userId: member.userId,
        teamId: member.teamId
      },
      "当前账号已离开原 Team，原 Team 工单已失效。如需继续咨询，请按当前归属重新创建工单。"
    );

    await this.prisma.$transaction(async (tx) => {
      if (subscription) {
        await this.queuePanelDisableJobsForSubscriptionTx(tx, subscription.id, {
          userId: member.userId
        });
        await this.queueLeaseRevocationJobsForSubscriptionTx(tx, subscription.id, "team_member_removed", {
          userId: member.userId
        });
      }
      await tx.teamMember.delete({
        where: { id: memberId }
      });
    });

    if (subscription) {
      await this.revokeSubscriptionLeasesBestEffort(subscription.id, "team_member_removed", {
        userId: member.userId
      });
    }

    if (subscription) {
      await this.publishSubscriptionUpdatedEvent({
        subscriptionId: subscription.id,
        teamId: subscription.teamId,
        state: subscription.state
      });
    }

    this.clientRuntimeEventsService.publishToUser(member.userId, {
      type: "subscription_updated",
      occurredAt: new Date().toISOString(),
      subscriptionId: null,
      subscriptionState: null,
      state: null,
      reasonCode: "team_access_revoked",
      reasonMessage: "你已被移出当前团队，当前不再拥有团队订阅。"
    });
    this.clientRuntimeEventsService.publishToUser(member.userId, {
      type: "node_access_updated",
      occurredAt: new Date().toISOString(),
      subscriptionId: null,
      nodeId: null,
      reasonCode: "team_access_revoked",
      reasonMessage: "团队节点授权已被移除。"
    });

    return { ok: true };
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

    let disconnectedSessionCount = 0;
    let panelSyncStatus: KickTeamMemberResultDto["panelSyncStatus"] = "synced";
    let panelSyncMessage: string | null = null;
    const subscription = await this.findCurrentTeamSubscription(teamId);
    if (subscription) {
      const pendingPanelSyncCount = await this.runtimeSessionService.markPanelBindingsDisabledForSubscription(
        subscription.id,
        {
          userId: member.userId
        }
      );
      disconnectedSessionCount = await this.runtimeSessionService.revokeSubscriptionLeases(
        subscription.id,
        "team_member_disconnected",
        {
          userId: member.userId
        }
      );
      if (pendingPanelSyncCount > 0) {
        panelSyncStatus = "pending";
        panelSyncMessage = "3x-ui 客户端禁用已加入后台队列。";
      }
    }

    let user: AdminUserRecordDto | null = null;
    let accountDisabled = false;
    if (input.disableAccount) {
      user = await this.updateUser(member.userId, { status: "disabled" });
      accountDisabled = true;
    }

    let message = disconnectedSessionCount > 0 ? "已立即断开该成员会话连接" : "当前无活跃会话，未发生断开";
    if (accountDisabled) {
      message = disconnectedSessionCount > 0 ? "已立即断开会话并禁用账号" : "账号已禁用，当前无活跃会话";
    }
    if (panelSyncMessage) {
      message = `${message}，${panelSyncMessage}`;
    }

    return {
      ok: true,
      action: "disconnect_session",
      disconnectedSessionCount,
      accountDisabled,
      panelSyncStatus,
      panelSyncMessage,
      message,
      reasonCode: input.disableAccount ? "account_disabled" : "admin_paused_connection",
      reasonMessage: input.disableAccount ? "当前账号已禁用，连接已失效。" : "管理员已暂停当前连接，可稍后恢复使用。",
      team: await this.requireTeamRecord(teamId),
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

    const panelSync = await this.syncSubscriptionPanelAccessBestEffort(row.id);
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
    const rows = await this.prisma.trafficLedger.findMany({
      where: { teamId },
      include: { user: true, node: true },
      orderBy: [{ recordedAt: "desc" }, { createdAt: "desc" }]
    });
    return summarizeTeamUsageRecords(rows);
  }

  private async resetSubscriptionTrafficCounters(
    subscription: AdminSubscriptionEntity,
    options: {
      requestedUserId?: string | null;
      allowTeamWideReset: boolean;
      totalTrafficGb?: number;
      expireAt?: Date;
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

    await runWithSubscriptionUsageLock(subscription.id, async () => {
      const bindings = await this.prisma.panelClientBinding.findMany({
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

      let staleBindingCount = 0;
      const baselineSamples = await Promise.all(
        bindings.map(async (binding) => {
          const nodeConfig = {
            id: binding.node.id,
            panelBaseUrl: binding.node.panelBaseUrl,
            panelApiBasePath: binding.node.panelApiBasePath,
            panelUsername: binding.node.panelUsername,
            panelPassword: binding.node.panelPassword,
            panelInboundId: binding.panelInboundId
          };
          const resetApplied = await this.xuiService.resetClientTraffic(nodeConfig, binding.panelClientEmail);
          if (!resetApplied) {
            staleBindingCount += 1;
            return null;
          }
          const baseline = await this.readPanelClientBaseline(nodeConfig, binding.panelClientEmail);
          return {
            binding,
            uplinkBytes: baseline.uplinkBytes,
            downlinkBytes: baseline.downlinkBytes,
            sampledAt: baseline.sampledAt
          };
        })
      );
      if (staleBindingCount > 0) {
        await this.persistTrafficResetBaselineSamples(baselineSamples.filter((item): item is NonNullable<typeof item> => Boolean(item)));
        throw new BadGatewayException("Reset traffic was not applied to every 3x-ui client; local traffic counters were left unchanged.");
      }

      updatedSubscription = await this.prisma.$transaction(async (tx) => {
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
        const expireAt = options.expireAt ?? new Date(lockedSubscription.expireAt);
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

    return {
      subscription: updatedSubscription,
      targetUserId,
      clearedBindingCount
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
    const userIds = await this.resolveTargetUserIdsForSubscriptionTarget(target);
    this.clientRuntimeEventsService.publishToUsers(userIds, {
      type: "subscription_updated",
      occurredAt: new Date().toISOString(),
      subscriptionId: target.subscriptionId ?? null,
      subscriptionState: target.state ?? null,
      state: target.state ?? null
    });
  }

  private async queuePanelDisableJobsForSubscriptionTx(
    writer: any,
    subscriptionId: string,
    filter?: { userId?: string; nodeIds?: string[] }
  ) {
    return this.runtimeSessionService.queuePanelDisableJobsForSubscriptionTx(writer, subscriptionId, filter);
  }

  private async queueLeaseRevocationJobsForSubscriptionTx(
    writer: any,
    subscriptionId: string,
    reason: string,
    filter?: { userId?: string; nodeIds?: string[] }
  ) {
    return this.runtimeSessionService.queueLeaseRevocationJobsForSubscriptionTx(writer, subscriptionId, reason, filter);
  }

  private async syncActiveLeasesForSubscriptionBestEffort(subscription: Parameters<RuntimeSessionService["syncActiveLeasesForSubscription"]>[0]) {
    try {
      await this.runtimeSessionService.syncActiveLeasesForSubscription(subscription);
      return { ok: true as const };
    } catch (error) {
      return {
        ok: false as const,
        errorMessage: `active lease revocation failed: ${readErrorMessage(error, "unknown error")}`
      };
    }
  }

  private async revokeSubscriptionLeasesBestEffort(
    subscriptionId: string,
    reason: string,
    filter?: { userId?: string; nodeIds?: string[] }
  ) {
    try {
      await this.runtimeSessionService.revokeSubscriptionLeases(subscriptionId, reason, filter);
      return { ok: true as const };
    } catch (error) {
      return {
        ok: false as const,
        errorMessage: `active lease revocation failed: ${readErrorMessage(error, "unknown error")}`
      };
    }
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

  private async enforceSubscriptionConcurrentLeaseLimits(subscription: {
    userId?: string | null;
    teamId?: string | null;
    plan: { maxConcurrentSessions: number };
  }) {
    const userIds = await this.resolveTargetUserIdsForSubscriptionTarget(subscription);
    if (userIds.length === 0) {
      return { ok: true as const };
    }

    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, maxConcurrentSessionsOverride: true }
    });
    const failures: string[] = [];
    for (const user of users) {
      const limit = user.maxConcurrentSessionsOverride ?? subscription.plan.maxConcurrentSessions;
      try {
        await this.runtimeSessionService.enforceUserConcurrentLeaseLimit(user.id, limit);
      } catch (error) {
        failures.push(`${user.id}: ${readErrorMessage(error, "unknown error")}`);
      }
    }

    if (failures.length > 0) {
      return {
        ok: false as const,
        errorMessage: `lease concurrency reconciliation failed: ${failures.join("; ")}`
      };
    }
    return { ok: true as const };
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
    try {
      await this.runtimeSessionService.syncSubscriptionPanelAccess(subscriptionId);
      return { ok: true as const };
    } catch (error) {
      return {
        ok: false as const,
        errorMessage: readErrorMessage(error, "3x-ui panel sync failed")
      };
    }
  }

  private async findCurrentPersonalSubscription(userId: string) {
    const rows = await this.prisma.subscription.findMany({
      where: {
        userId
      },
      include: { plan: true, user: true, team: true, nodeAccesses: true },
      orderBy: [{ expireAt: "desc" }, { createdAt: "desc" }]
    });
    return pickCurrentSubscription(rows);
  }

  private async findCurrentTeamSubscription(teamId: string) {
    const rows = await this.prisma.subscription.findMany({
      where: { teamId },
      include: { plan: true, user: true, team: true, nodeAccesses: true },
      orderBy: [{ expireAt: "desc" }, { createdAt: "desc" }]
    });
    return pickCurrentSubscription(rows);
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
    const row = (await this.listAdminTeams()).find((item) => item.id === teamId);
    if (!row) {
      throw new NotFoundException("团队不存在");
    }
    return row;
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

  private async closeTeamSupportTicketsForUser(userId: string, body: string) {
    return this.closeSupportTicketsForUser(
      {
        userId,
        requireTeamOwnership: true
      },
      body
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
      this.clientRuntimeEventsService.publishToUser(ticket.userId, {
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
    panelSyncMessage: `3x-ui 面板同步失败，将在后续连接或手动操作时重试：${panelSync.errorMessage}`
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
    errorMessage: failed.map((item) => item.errorMessage).join("；")
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
