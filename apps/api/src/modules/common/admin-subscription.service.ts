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
    const data: Record<string, unknown> = {};
    if (input.displayName !== undefined) data.displayName = input.displayName.trim();
    if (input.role !== undefined) data.role = input.role;
    if (input.status !== undefined) data.status = input.status;
    if (input.password !== undefined) data.passwordHash = await bcrypt.hash(input.password, 10);
    if (input.maxConcurrentSessionsOverride !== undefined) {
      data.maxConcurrentSessionsOverride = input.maxConcurrentSessionsOverride;
    }

    await this.prisma.user.update({
      where: { id: userId },
      data
    });

    if (input.status !== undefined && input.status !== currentUser.status) {
      const personalSubscription = await this.findCurrentPersonalSubscription(userId);
      if (personalSubscription) {
        if (input.status === "disabled") {
          await this.runtimeSessionService.revokeUserLeases(userId, "user_disabled", {
            subscriptionId: personalSubscription.id
          });
          const removeResult = await this.runtimeSessionService.removePanelBindingsForSubscription(
            personalSubscription.id,
            { userId }
          );
          this.runtimeSessionService.assertPanelBindingMutation("删除 3x-ui 客户端失败", removeResult);
        } else if (input.status === "active") {
          await this.runtimeSessionService.syncSubscriptionPanelAccess(personalSubscription.id);
        }
      }

      const memberships = await this.prisma.teamMember.findMany({
        where: { userId },
        select: { teamId: true }
      });
      for (const membership of memberships) {
        const teamSubscription = await this.findCurrentTeamSubscription(membership.teamId);
        if (!teamSubscription) {
          continue;
        }
        if (input.status === "disabled") {
          await this.runtimeSessionService.revokeUserLeases(userId, "user_disabled", {
            subscriptionId: teamSubscription.id
          });
          const removeResult = await this.runtimeSessionService.removePanelBindingsForSubscription(
            teamSubscription.id,
            { userId }
          );
          this.runtimeSessionService.assertPanelBindingMutation("删除 3x-ui 客户端失败", removeResult);
        } else if (input.status === "active") {
          await this.runtimeSessionService.syncSubscriptionPanelAccess(teamSubscription.id);
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
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        maxConcurrentSessionsOverride: input.maxConcurrentSessionsOverride ?? null
      }
    });
    return this.requireAdminUserRecord(userId);
  }

  async resetSubscriptionTraffic(
    subscriptionId: string,
    input: ResetSubscriptionTrafficInputDto = {}
  ): Promise<ResetSubscriptionTrafficResultDto> {
    const subscription = await this.requireSubscription(subscriptionId);
    const requestedUserId = normalizeOptionalString(input.userId);

    let targetUserId: string | null;
    if (subscription.teamId) {
      if (!requestedUserId) {
        throw new BadRequestException("Team 订阅重置流量时必须指定成员账号");
      }
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
    } else {
      if (!subscription.userId) {
        throw new BadRequestException("个人订阅缺少所属用户，不能重置流量");
      }
      if (requestedUserId && requestedUserId !== subscription.userId) {
        throw new BadRequestException("个人订阅不能指定其他成员流量");
      }
      targetUserId = subscription.userId;
    }

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

    let staleBindingCount = 0;
    const baselineSamples = await Promise.all(
      bindings.map(async (binding) => {
        const nodeConfig = {
          id: binding.node.id,
          panelBaseUrl: binding.node.panelBaseUrl,
          panelApiBasePath: binding.node.panelApiBasePath,
          panelUsername: binding.node.panelUsername,
          panelPassword: binding.node.panelPassword,
          panelInboundId: binding.node.panelInboundId
        };
        const resetApplied = await this.xuiService.resetClientTraffic(nodeConfig, binding.panelClientEmail);
        if (!resetApplied) {
          staleBindingCount += 1;
          return {
            binding,
            uplinkBytes: 0n,
            downlinkBytes: 0n,
            sampledAt: new Date()
          };
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

    const expireAt = new Date(subscription.expireAt);
    await this.prisma.$transaction(async (tx) => {
      for (const item of baselineSamples) {
        const totalBytes = item.uplinkBytes + item.downlinkBytes;
        const snapshotKey = buildSnapshotKey(item.binding.nodeId, item.binding.subscriptionId, item.binding.userId);
        await tx.trafficSnapshot.upsert({
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

        await tx.panelClientBinding.update({
          where: { id: item.binding.id },
          data: {
            lastUplinkBytes: item.uplinkBytes,
            lastDownlinkBytes: item.downlinkBytes,
            lastSyncedAt: item.sampledAt
          }
        });
      }

      if (subscription.teamId && targetUserId) {
        await tx.trafficLedger.deleteMany({
          where: {
            teamId: subscription.teamId,
            subscriptionId: subscription.id,
            userId: targetUserId
          }
        });

        const aggregate = await tx.trafficLedger.aggregate({
          where: { subscriptionId: subscription.id },
          _sum: { usedTrafficGb: true }
        });
        const usedTrafficGb = aggregate._sum.usedTrafficGb ?? 0;
        const remainingTrafficGb = Math.max(0, subscription.totalTrafficGb - usedTrafficGb);
        await tx.subscription.update({
          where: { id: subscription.id },
          data: {
            usedTrafficGb,
            remainingTrafficGb,
            state: resolveSubscriptionState(
              subscription.state === "paused" ? "paused" : "active",
              remainingTrafficGb,
              expireAt
            ),
            lastSyncedAt: new Date()
          }
        });
      } else {
        await tx.subscription.update({
          where: { id: subscription.id },
          data: {
            usedTrafficGb: 0,
            remainingTrafficGb: subscription.totalTrafficGb,
            state: resolveSubscriptionState(
              subscription.state === "paused" ? "paused" : "active",
              subscription.totalTrafficGb,
              expireAt
            ),
            lastSyncedAt: new Date()
          }
        });
      }
    });

    const updatedSubscription = await this.prisma.subscription.findUnique({
      where: { id: subscription.id },
      include: {
        plan: true,
        user: true,
        team: true,
        nodeAccesses: true
      }
    });
    if (!updatedSubscription) {
      throw new NotFoundException("订阅不存在");
    }

    await this.publishSubscriptionUpdatedEvent({
      subscriptionId: updatedSubscription.id,
      userId: updatedSubscription.userId,
      teamId: updatedSubscription.teamId,
      state: updatedSubscription.state
    });

    const user = targetUserId ? await this.requireAdminUserRecord(targetUserId) : null;
    return {
      ok: true,
      subscriptionId: subscription.id,
      userId: targetUserId,
      clearedBindingCount: bindings.length,
      message:
        bindings.length > 0
          ? staleBindingCount > 0
            ? `已重置订阅流量，并校正 ${staleBindingCount} 条失效的 3x-ui 客户端绑定`
            : "已重置订阅流量，并同步清空 3x-ui 面板计量"
          : "已重置订阅流量，当前没有可同步的 3x-ui 客户端",
      subscription: toAdminSubscriptionRecord(updatedSubscription),
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
    await this.ensurePlanExists(planId);
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
    const subscriptionCount = await this.prisma.subscription.count({ where: { planId } });
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

    await this.closeTeamSupportTicketsForUser(
      input.userId,
      "当前账号已切换为个人订阅，原 Team 工单已失效。如需继续咨询，请在当前个人订阅下重新创建工单。"
    );

    await this.runtimeSessionService.syncSubscriptionPanelAccess(row.id);
    await this.publishSubscriptionUpdatedEvent({
      subscriptionId: row.id,
      userId: row.userId,
      teamId: row.teamId,
      state: row.state
    });

    return toAdminSubscriptionRecord(row);
  }

  async renewSubscription(subscriptionId: string, input: RenewSubscriptionInputDto): Promise<AdminSubscriptionRecordDto> {
    const current = await this.requireSubscription(subscriptionId);
    const nextExpireAt = resolveRenewExpireAt(current.expireAt, input.expireAt);
    const totalTrafficGb = input.totalTrafficGb ?? current.totalTrafficGb;
    const usedTrafficGb = input.resetTraffic ? 0 : current.usedTrafficGb;
    const remainingTrafficGb = Math.max(0, totalTrafficGb - usedTrafficGb);

    const row = await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        totalTrafficGb,
        usedTrafficGb,
        remainingTrafficGb,
        expireAt: nextExpireAt,
        state: resolveSubscriptionState("active", remainingTrafficGb, nextExpireAt),
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

    await this.runtimeSessionService.syncSubscriptionPanelAccess(subscriptionId);
    await this.runtimeSessionService.syncActiveLeasesForSubscription(row);
    await this.publishSubscriptionUpdatedEvent({
      subscriptionId: row.id,
      userId: row.userId,
      teamId: row.teamId,
      state: row.state
    });

    return toAdminSubscriptionRecord(row);
  }

  async changeSubscriptionPlan(
    subscriptionId: string,
    input: ChangeSubscriptionPlanInputDto
  ): Promise<AdminSubscriptionRecordDto> {
    const current = await this.requireSubscription(subscriptionId);
    const plan = await this.ensurePlanExists(input.planId);
    if (!plan.isActive) {
      throw new BadRequestException("套餐已停用，不能切换");
    }

    const expireAt = input.expireAt ? new Date(input.expireAt) : current.expireAt;
    if (Number.isNaN(expireAt.getTime())) {
      throw new BadRequestException("到期时间无效");
    }

    const totalTrafficGb = input.totalTrafficGb ?? plan.totalTrafficGb;
    const remainingTrafficGb = Math.max(0, totalTrafficGb - current.usedTrafficGb);
    const row = await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        planId: plan.id,
        totalTrafficGb,
        remainingTrafficGb,
        expireAt,
        renewable: plan.renewable,
        state: resolveSubscriptionState("active", remainingTrafficGb, expireAt),
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

    await this.runtimeSessionService.syncSubscriptionPanelAccess(subscriptionId);
    await this.runtimeSessionService.syncActiveLeasesForSubscription(row);
    await this.publishSubscriptionUpdatedEvent({
      subscriptionId: row.id,
      userId: row.userId,
      teamId: row.teamId,
      state: row.state
    });

    return toAdminSubscriptionRecord(row);
  }

  async updateSubscription(subscriptionId: string, input: UpdateSubscriptionInputDto): Promise<AdminSubscriptionRecordDto> {
    const current = await this.requireSubscription(subscriptionId);
    const totalTrafficGb = input.totalTrafficGb ?? current.totalTrafficGb;
    const usedTrafficGb = input.usedTrafficGb ?? current.usedTrafficGb;
    const expireAt = input.expireAt ? new Date(input.expireAt) : current.expireAt;
    const remainingTrafficGb = Math.max(0, totalTrafficGb - usedTrafficGb);
    const state = resolveSubscriptionState(input.state ?? current.state, remainingTrafficGb, expireAt);

    const row = await this.prisma.subscription.update({
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

    await this.runtimeSessionService.syncSubscriptionPanelAccess(subscriptionId);
    await this.runtimeSessionService.syncActiveLeasesForSubscription(row);
    await this.publishSubscriptionUpdatedEvent({
      subscriptionId: row.id,
      userId: row.userId,
      teamId: row.teamId,
      state: row.state
    });

    return toAdminSubscriptionRecord(row);
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

      await this.runtimeSessionService.syncSubscriptionPanelAccess(teamSubscription.id);
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
        try {
          await this.runtimeSessionService.syncSubscriptionPanelAccess(teamSubscription.id);
        } catch (rollbackError) {
          rollbackErrors.push(readErrorMessage(rollbackError, "清理 Team 授权失败"));
        }
        try {
          await this.runtimeSessionService.syncSubscriptionPanelAccess(subscriptionId);
        } catch (rollbackError) {
          rollbackErrors.push(readErrorMessage(rollbackError, "恢复个人订阅授权失败"));
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
      message: `个人订阅已删除，账号已转入 Team「${teamRecord.name}」，后续将按团队共享订阅生效。`
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
        },
        trafficLedgerEntries: {
          include: { user: true, node: true },
          orderBy: [{ recordedAt: "desc" }, { createdAt: "desc" }]
        }
      },
      orderBy: { createdAt: "asc" }
    });
    return teams.map((team) => toAdminTeamRecord(team));
  }

  async createTeam(input: CreateTeamInputDto): Promise<AdminTeamRecordDto> {
    const owner = await this.ensureUserExists(input.ownerUserId);
    if (owner.status !== "active") {
      throw new BadRequestException("负责人账号已禁用");
    }

    await this.assertUserCanJoinTeam(owner.id);

    const teamId = createId("team");
    await this.prisma.team.create({
      data: {
        id: teamId,
        name: input.name.trim(),
        ownerUserId: owner.id,
        status: input.status ?? "active"
      }
    });

    await this.prisma.teamMember.create({
      data: {
        id: createId("member"),
        teamId,
        userId: owner.id,
        role: "owner"
      }
    });

    await this.closePersonalSupportTicketsForUser(
      owner.id,
      "当前账号已切换为 Team 归属，原个人订阅工单已失效。如需继续咨询，请在当前 Team 归属下重新创建工单。"
    );

    return this.requireTeamRecord(teamId);
  }

  async updateTeam(teamId: string, input: UpdateTeamInputDto): Promise<AdminTeamRecordDto> {
    const current = await this.requireTeam(teamId);
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.status !== undefined) data.status = input.status;

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
      await this.prisma.teamMember.updateMany({
        where: { teamId, role: "owner" },
        data: { role: "member" }
      });

      await this.prisma.teamMember.upsert({
        where: { userId: nextOwner.id },
        update: { role: "owner" },
        create: {
          id: createId("member"),
          teamId,
          userId: nextOwner.id,
          role: "owner"
        }
      });

      if (joinsCurrentTeamAsNewOwner) {
        await this.closePersonalSupportTicketsForUser(
          nextOwner.id,
          "当前账号已切换为 Team 归属，原个人订阅工单已失效。如需继续咨询，请在当前 Team 归属下重新创建工单。"
        );
      }
    }

    await this.prisma.team.update({
      where: { id: teamId },
      data
    });

    return this.requireTeamRecord(teamId);
  }

  async createTeamMember(teamId: string, input: CreateTeamMemberInputDto): Promise<AdminTeamRecordDto> {
    await this.requireTeam(teamId);
    await this.assertUserCanJoinTeam(input.userId);

    await this.prisma.teamMember.create({
      data: {
        id: createId("member"),
        teamId,
        userId: input.userId,
        role: input.role ?? "member"
      }
    });

    await this.closePersonalSupportTicketsForUser(
      input.userId,
      "当前账号已切换为 Team 归属，原个人订阅工单已失效。如需继续咨询，请在当前 Team 归属下重新创建工单。"
    );

    const subscription = await this.findCurrentTeamSubscription(teamId);
    if (subscription) {
      await this.runtimeSessionService.syncSubscriptionPanelAccess(subscription.id);
      await this.publishSubscriptionUpdatedEvent({
        subscriptionId: subscription.id,
        teamId: subscription.teamId,
        state: subscription.state
      });
    }

    return this.requireTeamRecord(teamId);
  }

  async updateTeamMember(memberId: string, input: UpdateTeamMemberInputDto): Promise<AdminTeamRecordDto> {
    const member = await this.requireTeamMember(memberId);
    const nextRole = input.role ?? member.role;

    await this.prisma.teamMember.update({
      where: { id: memberId },
      data: { role: nextRole }
    });

    if (nextRole === "owner") {
      await this.prisma.teamMember.updateMany({
        where: {
          teamId: member.teamId,
          NOT: { id: memberId }
        },
        data: { role: "member" }
      });
      await this.prisma.team.update({
        where: { id: member.teamId },
        data: { ownerUserId: member.userId }
      });
    }

    return this.requireTeamRecord(member.teamId);
  }

  async deleteTeamMember(memberId: string) {
    const member = await this.requireTeamMember(memberId);
    if (member.role === "owner") {
      throw new BadRequestException("负责人不能直接移除，请先转移负责人");
    }

    const subscription = await this.findCurrentTeamSubscription(member.teamId);
    if (subscription) {
      await this.runtimeSessionService.revokeSubscriptionLeases(subscription.id, "team_member_removed", {
        userId: member.userId
      });
      const removeResult = await this.runtimeSessionService.removePanelBindingsForSubscription(subscription.id, {
        userId: member.userId
      });
      this.runtimeSessionService.assertPanelBindingMutation("删除 3x-ui 客户端失败", removeResult);
    }

    await this.closeSupportTicketsForUser(
      {
        userId: member.userId,
        teamId: member.teamId
      },
      "当前账号已离开原 Team，原 Team 工单已失效。如需继续咨询，请按当前归属重新创建工单。"
    );

    await this.prisma.teamMember.delete({
      where: { id: memberId }
    });

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
    const subscription = await this.findCurrentTeamSubscription(teamId);
    if (subscription) {
      const disableResult = await this.runtimeSessionService.disablePanelBindingsForSubscription(subscription.id, {
        userId: member.userId
      });
      disconnectedSessionCount = await this.runtimeSessionService.revokeSubscriptionLeases(
        subscription.id,
        "team_member_disconnected",
        {
          userId: member.userId
        }
      );
      this.runtimeSessionService.assertPanelBindingMutation(
        disconnectedSessionCount > 0 ? "会话已断开，但禁用 3x-ui 客户端失败" : "禁用 3x-ui 客户端失败",
        disableResult
      );
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

    return {
      ok: true,
      action: "disconnect_session",
      disconnectedSessionCount,
      accountDisabled,
      message,
      reasonCode: input.disableAccount ? "account_disabled" : "admin_paused_connection",
      reasonMessage: input.disableAccount ? "当前账号已禁用，会话已失效。" : "管理员已暂停当前连接，可稍后恢复使用。",
      team: await this.requireTeamRecord(teamId),
      user
    };
  }

  async createTeamSubscription(teamId: string, input: CreateTeamSubscriptionInputDto): Promise<AdminSubscriptionRecordDto> {
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

    await this.runtimeSessionService.syncSubscriptionPanelAccess(row.id);
    await this.publishSubscriptionUpdatedEvent({
      subscriptionId: row.id,
      userId: row.userId,
      teamId: row.teamId,
      state: row.state
    });

    return toAdminSubscriptionRecord(row);
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

  private async findCurrentPersonalSubscription(userId: string) {
    return this.prisma.subscription.findFirst({
      where: {
        userId
      },
      include: { plan: true, user: true, team: true, nodeAccesses: true },
      orderBy: [{ expireAt: "desc" }, { createdAt: "desc" }]
    });
  }

  private async findCurrentTeamSubscription(teamId: string) {
    return this.prisma.subscription.findFirst({
      where: { teamId },
      include: { plan: true, user: true, team: true, nodeAccesses: true },
      orderBy: [{ expireAt: "desc" }, { createdAt: "desc" }]
    });
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
