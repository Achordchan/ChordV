import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException
} from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import * as net from "node:net";
import * as tls from "node:tls";
import { Cron } from "@nestjs/schedule";
import { Agent, fetch as undiciFetch } from "undici";
import {
  mockAnnouncements,
  mockNodes,
  mockPolicies,
  mockSubscription,
  mockUser,
  mockVersion
} from "@chordv/shared";
import type {
  AdminAnnouncementRecordDto,
  AdminNodeRecordDto,
  AdminNodePanelInboundDto,
  AdminPlanRecordDto,
  AdminPolicyRecordDto,
  AdminSnapshotDto,
  AdminSubscriptionRecordDto,
  AdminTeamMemberRecordDto,
  AdminTeamRecordDto,
  AdminTeamUsageRecordDto,
  AdminUserRecordDto,
  AnnouncementDto,
  AuthSessionDto,
  ChangeSubscriptionPlanInputDto,
  ClientBootstrapDto,
  ClientTeamSummaryDto,
  ClientVersionDto,
  ConnectRequestDto,
  CreateAnnouncementInputDto,
  CreatePlanInputDto,
  CreateSubscriptionInputDto,
  CreateTeamInputDto,
  CreateTeamMemberInputDto,
  CreateTeamSubscriptionInputDto,
  CreateUserInputDto,
  GeneratedRuntimeConfigDto,
  ImportNodeInputDto,
  NodeProbeStatus,
  NodeSummaryDto,
  PolicyBundleDto,
  RenewSubscriptionInputDto,
  SubscriptionNodeAccessDto,
  SubscriptionSourceAction,
  SubscriptionState,
  SubscriptionStatusDto,
  TeamMemberRole,
  TeamStatus,
  UpdateAnnouncementInputDto,
  UpdateNodeInputDto,
  UpdatePlanInputDto,
  UpdatePlanSecurityInputDto,
  UpdatePolicyInputDto,
  UpdateSubscriptionInputDto,
  UpdateSubscriptionNodeAccessInputDto,
  UpdateTeamInputDto,
  UpdateTeamMemberInputDto,
  UpdateUserSecurityInputDto,
  UpdateUserInputDto,
  UserProfileDto,
  UserSubscriptionSummaryDto
} from "@chordv/shared";
import { METERING_REASON_NODE_UNAVAILABLE } from "./metering.constants";
import { AuthSessionService } from "./auth-session.service";
import { MeteringIncidentService } from "./metering-incident.service";
import { PrismaService } from "./prisma.service";
import { EdgeGatewayService } from "../edge-gateway/edge-gateway.service";
import { XuiService } from "../xui/xui.service";

const LEASE_TTL_SECONDS = Number(process.env.CHORDV_SESSION_LEASE_TTL_SECONDS ?? 600);
const LEASE_HEARTBEAT_INTERVAL_SECONDS = Number(process.env.CHORDV_SESSION_HEARTBEAT_INTERVAL_SECONDS ?? 20);
const LEASE_GRACE_SECONDS = Number(process.env.CHORDV_SESSION_GRACE_SECONDS ?? 60);
const SECURITY_REASON_CONCURRENCY = "concurrency_limit";
const BUILTIN_ADMIN_ID = "admin_001";
const BUILTIN_ADMIN_ACCOUNT = "admin";
const BUILTIN_ADMIN_PASSWORD = "woshichen123";

@Injectable()
export class DevDataService implements OnModuleInit {
  private readonly logger = new Logger(DevDataService.name);
  private activeRuntime?: GeneratedRuntimeConfigDto;
  private activeRuntimeUsageContext?: {
    subscriptionId: string;
    nodeId: string;
    userId: string;
    teamId: string | null;
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly meteringIncidentService: MeteringIncidentService,
    private readonly authSessionService: AuthSessionService,
    private readonly edgeGatewayService: EdgeGatewayService,
    private readonly xuiService: XuiService
  ) {}

  async onModuleInit() {
    await this.seedIfEmpty();
    await this.ensureBuiltinAdminAccount();
  }

  async login(account: string, password: string): Promise<AuthSessionDto> {
    const user = await this.resolveUserForLogin(account.trim().toLowerCase());

    if (!user || user.status !== "active") {
      throw new UnauthorizedException("账号或密码错误");
    }

    const matched = await bcrypt.compare(password, user.passwordHash);
    if (!matched) {
      throw new UnauthorizedException("账号或密码错误");
    }

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { lastSeenAt: new Date() }
    });
    return this.authSessionService.issueSession(updated.id);
  }

  async refresh(token: string): Promise<AuthSessionDto> {
    return this.authSessionService.rotateRefreshToken(token);
  }

  async logout(token?: string) {
    await this.authSessionService.revokeByAccessToken(token);
    return { ok: true };
  }

  async getBootstrap(token?: string): Promise<ClientBootstrapDto> {
    const user = await this.resolveActiveUserFromToken(token);
    const access = await this.resolveSubscriptionAccessForUser(user.id);
    if (!access.subscription) {
      throw new NotFoundException("当前没有可用订阅");
    }
    const metering = await this.meteringIncidentService.getSubscriptionMeteringState(access.subscription.id);

    const [policies, announcements, version] = await Promise.all([
      this.getPolicies(),
      this.getAnnouncements(),
      this.getClientVersion()
    ]);

    return {
      user,
      subscription: toSubscriptionStatusDto(access.subscription, access.team, access.memberUsedTrafficGb, metering),
      policies,
      announcements,
      version,
      team: access.team
        ? {
            id: access.team.id,
            name: access.team.name,
            status: access.team.status as TeamStatus,
            role: access.memberRole ?? "member"
          }
        : null
    };
  }

  async getSubscription(token?: string): Promise<SubscriptionStatusDto> {
    const user = await this.resolveActiveUserFromToken(token);
    const access = await this.resolveSubscriptionAccessForUser(user.id);
    if (!access.subscription) {
      throw new NotFoundException("当前没有可用订阅");
    }
    const metering = await this.meteringIncidentService.getSubscriptionMeteringState(access.subscription.id);
    return toSubscriptionStatusDto(access.subscription, access.team, access.memberUsedTrafficGb, metering);
  }

  async getNodes(token?: string): Promise<NodeSummaryDto[]> {
    const user = await this.resolveActiveUserFromToken(token);
    const access = await this.resolveSubscriptionAccessForUser(user.id);
    if (!access.subscription) {
      return [];
    }

    const rows = await this.prisma.subscriptionNodeAccess.findMany({
      where: { subscriptionId: access.subscription.id },
      include: { node: true },
      orderBy: [{ node: { recommended: "desc" } }, { node: { latencyMs: "asc" } }, { node: { createdAt: "desc" } }]
    });
    const nodeMap = new Map<string, NodeSummaryDto>();
    for (const row of rows) {
      if (!nodeMap.has(row.nodeId)) {
        nodeMap.set(row.nodeId, toNodeSummary(row.node));
      }
    }
    return Array.from(nodeMap.values());
  }

  async getPolicies(): Promise<PolicyBundleDto> {
    const profile = await this.prisma.policyProfile.findUnique({
      where: { id: "default" }
    });

    if (!profile) {
      throw new NotFoundException("策略配置不存在");
    }

    return {
      defaultMode: profile.defaultMode as PolicyBundleDto["defaultMode"],
      modes: profile.modes as PolicyBundleDto["modes"],
      features: {
        blockAds: profile.blockAds,
        chinaDirect: profile.chinaDirect,
        aiServicesProxy: profile.aiServicesProxy
      }
    };
  }

  async getAnnouncements(): Promise<AnnouncementDto[]> {
    const rows = await this.prisma.announcement.findMany({
      where: {
        isActive: true,
        publishedAt: { lte: new Date() }
      },
      orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }]
    });
    return rows.map(toAnnouncementDto);
  }

  async getClientVersion(): Promise<ClientVersionDto> {
    const profile = await this.prisma.policyProfile.findUnique({
      where: { id: "default" }
    });

    if (!profile) {
      throw new NotFoundException("版本配置不存在");
    }

    return {
      currentVersion: profile.currentVersion,
      minimumVersion: profile.minimumVersion,
      forceUpgrade: profile.forceUpgrade,
      changelog: profile.changelog,
      downloadUrl: profile.downloadUrl
    };
  }

  async connect(request: ConnectRequestDto, token?: string): Promise<GeneratedRuntimeConfigDto> {
    const node = await this.prisma.node.findUnique({
      where: { id: request.nodeId }
    });

    if (!node) {
      throw new NotFoundException("节点不存在");
    }

    const user = await this.resolveActiveUserFromToken(token);
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
      throw new ForbiddenException("当前订阅未开通该节点");
    }

    const userSecurity = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { maxConcurrentSessionsOverride: true }
    });
    const concurrentLimit = Math.max(
      1,
      userSecurity?.maxConcurrentSessionsOverride ?? access.subscription.plan.maxConcurrentSessions ?? 1
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
      await this.edgeGatewayService.openSession({
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
      await this.edgeGatewayService.markNodeUnavailable(node.id, detail);
      throw new BadRequestException(`中心中转会话创建失败：${detail}`);
    }

    const edgeConfig = this.edgeGatewayService.getPublicRuntimeConfig();

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
      throw new NotFoundException("会话不存在");
    }
    if (lease.status !== "active") {
      throw new ForbiddenException("会话已失效");
    }

    const now = new Date();
    if (lease.expiresAt.getTime() <= now.getTime()) {
      await this.prisma.nodeSessionLease.update({
        where: { id: lease.id },
        data: {
          status: "expired",
          revokedAt: now,
          revokedReason: "lease_expired"
        }
      });
      throw new ForbiddenException("会话已过期");
    }

    const nextExpiresAt = new Date(now.getTime() + LEASE_TTL_SECONDS * 1000);
    if (lease.accessMode === "xui") {
      await this.prisma.nodeSessionLease.update({
        where: { id: lease.id },
        data: {
          status: "active",
          expiresAt: nextExpiresAt,
          lastHeartbeatAt: now,
          revokedAt: null,
          revokedReason: null
        }
      });
      if (this.activeRuntime?.sessionId === sessionId) {
        this.activeRuntime = {
          ...this.activeRuntime,
          leaseExpiresAt: nextExpiresAt.toISOString()
        };
      }
      return {
        sessionId,
        status: "active" as const,
        leaseExpiresAt: nextExpiresAt.toISOString(),
        evictedReason: null
      };
    }

    try {
      await this.edgeGatewayService.openSession({
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
      await this.prisma.nodeSessionLease.update({
        where: { id: lease.id },
        data: {
          status: "active",
          expiresAt: nextExpiresAt,
          lastHeartbeatAt: now,
          revokedAt: null,
          revokedReason: null
        }
      });
    } catch (error) {
      await this.revokeLease(lease.id, lease.node, "lease_renew_failed");
      await this.edgeGatewayService.markNodeUnavailable(lease.nodeId, error instanceof Error ? error.message : "未知错误");
      throw new ForbiddenException(`会话续租失败：${error instanceof Error ? error.message : "未知错误"}`);
    }

    if (this.activeRuntime?.sessionId === sessionId) {
      this.activeRuntime = {
        ...this.activeRuntime,
        leaseExpiresAt: nextExpiresAt.toISOString()
      };
    }

    return {
      sessionId,
      status: "active" as const,
      leaseExpiresAt: nextExpiresAt.toISOString(),
      evictedReason: null
    };
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
    access: Awaited<ReturnType<DevDataService["resolveSubscriptionAccessForUser"]>>,
    request: ConnectRequestDto,
    policy: Awaited<ReturnType<PrismaService["policyProfile"]["findUnique"]>>
  ): Promise<GeneratedRuntimeConfigDto> {
    const now = new Date();
    const sessionId = `session_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const leaseId = createId("lease");
    const leaseExpiresAt = new Date(now.getTime() + LEASE_TTL_SECONDS * 1000);
    const binding = await this.ensurePanelClientBinding({
      node,
      subscriptionId: access.subscription!.id,
      userId: user.id,
      teamId: access.subscription!.teamId,
      userEmail: user.email,
      userDisplayName: user.displayName,
      expireAt: access.subscription!.expireAt
    });

    await this.prisma.nodeSessionLease.create({
      data: {
        id: leaseId,
        sessionId,
        accessMode: "xui",
        userId: user.id,
        subscriptionId: access.subscription!.id,
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
      subscriptionId: access.subscription!.id,
      nodeId: node.id,
      userId: user.id,
      teamId: access.subscription!.teamId
    };

    await this.prisma.node.update({
      where: { id: node.id },
      data: {
        panelStatus: "online",
        panelError: null
      }
    });
    await this.meteringIncidentService.resolve(access.subscription!.id, node.id, METERING_REASON_NODE_UNAVAILABLE);
    return this.activeRuntime;
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
    if (!sessionId || previous?.sessionId === sessionId) {
      this.activeRuntime = undefined;
      this.activeRuntimeUsageContext = undefined;
    }
    return { ok: true, previousSessionId: previous?.sessionId ?? null };
  }

  getActiveRuntime() {
    return this.activeRuntime ?? null;
  }

  getActiveRuntimeUsageContext() {
    return this.activeRuntimeUsageContext ?? null;
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
      }
    });

    const panelClientEmail =
      existing?.panelClientEmail ??
      buildPanelClientEmail(input.userEmail, input.subscriptionId, input.node.id, input.userId);
    const panelClientId = existing?.panelClientId ?? randomUUID();
    const panelInboundId = input.node.panelInboundId ?? existing?.panelInboundId ?? null;

    await this.xuiService.ensureClient(
      {
        id: input.node.id,
        panelBaseUrl: input.node.panelBaseUrl,
        panelApiBasePath: input.node.panelApiBasePath,
        panelUsername: input.node.panelUsername,
        panelPassword: input.node.panelPassword,
        panelInboundId
      },
      {
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
      }
    );

    if (existing) {
      return this.prisma.panelClientBinding.update({
        where: { id: existing.id },
        data: {
          panelClientEmail,
          panelClientId,
          panelInboundId: panelInboundId ?? existing.panelInboundId,
          status: "active"
        }
      });
    }

    return this.prisma.panelClientBinding.create({
      data: {
        id: createId("panel_client"),
        subscriptionId: input.subscriptionId,
        userId: input.userId,
        teamId: input.teamId,
        nodeId: input.node.id,
        panelClientEmail,
        panelClientId,
        panelInboundId: panelInboundId ?? 0,
        status: "active"
      }
    });
  }

  private async removePanelBindingsForSubscription(subscriptionId: string, filter?: { userId?: string; nodeIds?: string[] }) {
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
      }

      await this.prisma.panelClientBinding.update({
        where: { id: binding.id },
        data: {
          status: "deleted"
        }
      });
    }
  }

  private async syncSubscriptionPanelAccess(subscriptionId: string) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        team: {
          include: {
            members: true
          }
        },
        nodeAccesses: true
      }
    });

    if (!subscription) {
      return;
    }

    const allowedNodeIds = new Set(subscription.nodeAccesses.map((item) => item.nodeId));
    const bindings = await this.prisma.panelClientBinding.findMany({
      where: {
        subscriptionId,
        status: "active"
      }
    });

    const deletedUserIds =
      subscription.teamId && subscription.team
        ? new Set(subscription.team.members.map((item) => item.userId))
        : null;

    for (const binding of bindings) {
      const invalidByNode = !allowedNodeIds.has(binding.nodeId);
      const invalidByUser = deletedUserIds ? !deletedUserIds.has(binding.userId ?? "") : false;
      if (invalidByNode || invalidByUser) {
        await this.removePanelBindingsForSubscription(subscriptionId, {
          userId: invalidByUser ? binding.userId ?? undefined : undefined,
          nodeIds: invalidByNode ? [binding.nodeId] : undefined
        });
      }
    }

    if (!isEffectiveSubscription(subscription)) {
      await this.removePanelBindingsForSubscription(subscriptionId);
    }
  }

  @Cron("*/30 * * * * *")
  async sweepExpiredLeases() {
    const now = new Date();
    const expired = await this.prisma.nodeSessionLease.findMany({
      where: {
        status: "active",
        expiresAt: { lte: now }
      },
      include: { node: true },
      take: 100
    });

    for (const lease of expired) {
      try {
        await this.revokeLease(lease.id, lease.node, "lease_expired");
      } catch (error) {
        this.logger.warn(
          `会话 ${lease.sessionId} 过期回收失败：${error instanceof Error ? error.message : "未知错误"}`
        );
      }
    }
  }

  private async evictExceededUserLeases(userId: string, maxConcurrentSessions: number) {
    const activeLeases = await this.prisma.nodeSessionLease.findMany({
      where: {
        userId,
        status: "active",
        expiresAt: { gt: new Date() }
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
      if (this.activeRuntime?.sessionId === lease.sessionId) {
        this.activeRuntime = undefined;
        this.activeRuntimeUsageContext = undefined;
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

    await this.prisma.nodeSessionLease.update({
      where: { id: lease.id },
      data: {
        status: reason === SECURITY_REASON_CONCURRENCY ? "evicted" : "revoked",
        revokedAt: new Date(),
        revokedReason: reason
      }
    });

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
    if (lease.accessMode === "relay") {
      try {
        await this.edgeGatewayService.closeSession({
          sessionId: lease.sessionId,
          leaseId: lease.id,
          nodeId: lease.nodeId
        });
        await this.meteringIncidentService.resolve(lease.subscriptionId, lease.nodeId, METERING_REASON_NODE_UNAVAILABLE);
      } catch (error) {
        await this.edgeGatewayService.markNodeUnavailable(
          lease.nodeId,
          error instanceof Error ? error.message : "关闭中心中转会话失败"
        );
      }
    }
  }

  async getAdminSnapshot(): Promise<AdminSnapshotDto> {
    const [users, plans, subscriptions, teams, nodes, announcements, policy] = await Promise.all([
      this.listAdminUsers(),
      this.listAdminPlans(),
      this.listAdminSubscriptions(),
      this.listAdminTeams(),
      this.listAdminNodes(),
      this.listAdminAnnouncements(),
      this.getAdminPolicy()
    ]);

    return {
      dashboard: {
        users: users.length,
        activeSubscriptions: subscriptions.filter((item) => item.state === "active").length,
        activeNodes: nodes.length,
        announcements: announcements.filter((item) => item.isActive).length,
        activePlans: plans.filter((item) => item.isActive).length
      },
      users,
      plans,
      subscriptions,
      teams,
      nodes,
      announcements,
      policy
    };
  }

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
        ? pickCurrentSubscription(membership.team.subscriptions)
        : pickCurrentSubscription(row.subscriptions);

      return {
        ...toUserProfile(row),
        accountType: membership ? "team" : "personal",
        teamId: membership?.team.id ?? null,
        teamName: membership?.team.name ?? null,
        maxConcurrentSessionsOverride: row.maxConcurrentSessionsOverride ?? null,
        subscriptionCount: membership
          ? membership.team.subscriptions.length
          : row.subscriptions.length,
        activeSubscriptionCount: membership
          ? membership.team.subscriptions.filter((item) => item.state === "active").length
          : row.subscriptions.filter((item) => item.state === "active").length,
        currentSubscription: currentSubscription
          ? toUserSubscriptionSummary(currentSubscription, membership?.team ?? null)
          : null
      };
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

    return {
      ...toUserProfile(row),
      accountType: "personal",
      teamId: null,
      teamName: null,
      maxConcurrentSessionsOverride: row.maxConcurrentSessionsOverride ?? null,
      subscriptionCount: 0,
      activeSubscriptionCount: 0,
      currentSubscription: null
    };
  }

  async updateUser(userId: string, input: UpdateUserInputDto): Promise<AdminUserRecordDto> {
    await this.ensureUserExists(userId);
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

    if (input.status === "disabled") {
      const personalSubscription = await this.findCurrentPersonalSubscription(userId);
      if (personalSubscription) {
        await this.removePanelBindingsForSubscription(personalSubscription.id, { userId });
      }
    }

    const rows = await this.listAdminUsers();
    const row = rows.find((item) => item.id === userId);
    if (!row) throw new NotFoundException("用户不存在");
    return row;
  }

  async updateUserSecurity(userId: string, input: UpdateUserSecurityInputDto): Promise<AdminUserRecordDto> {
    await this.ensureUserExists(userId);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        maxConcurrentSessionsOverride: input.maxConcurrentSessionsOverride ?? null
      }
    });

    const rows = await this.listAdminUsers();
    const row = rows.find((item) => item.id === userId);
    if (!row) {
      throw new NotFoundException("用户不存在");
    }
    return row;
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
        maxConcurrentSessions: input.maxConcurrentSessions ?? 1,
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
    const renewable = input.renewable ?? plan.renewable;
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
        renewable,
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

    await this.syncSubscriptionPanelAccess(row.id);

    return toAdminSubscriptionRecord(row);
  }

  async renewSubscription(subscriptionId: string, input: RenewSubscriptionInputDto): Promise<AdminSubscriptionRecordDto> {
    const current = await this.requireSubscription(subscriptionId);
    const nextExpireAt = resolveRenewExpireAt(current.expireAt, input.expireAt, input.extendDays);
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

    await this.syncSubscriptionPanelAccess(subscriptionId);

    return toAdminSubscriptionRecord(row);
  }

  async changeSubscriptionPlan(subscriptionId: string, input: ChangeSubscriptionPlanInputDto): Promise<AdminSubscriptionRecordDto> {
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
    const renewable = input.renewable ?? plan.renewable;
    const remainingTrafficGb = Math.max(0, totalTrafficGb - current.usedTrafficGb);

    const row = await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        planId: plan.id,
        totalTrafficGb,
        remainingTrafficGb,
        expireAt,
        renewable,
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

    await this.syncSubscriptionPanelAccess(subscriptionId);

    return toAdminSubscriptionRecord(row);
  }

  async updateSubscription(subscriptionId: string, input: UpdateSubscriptionInputDto): Promise<AdminSubscriptionRecordDto> {
    const current = await this.requireSubscription(subscriptionId);
    const totalTrafficGb = input.totalTrafficGb ?? current.totalTrafficGb;
    const usedTrafficGb = input.usedTrafficGb ?? current.usedTrafficGb;
    const expireAt = input.expireAt ? new Date(input.expireAt) : current.expireAt;
    const renewable = input.renewable ?? current.renewable;
    const remainingTrafficGb = Math.max(0, totalTrafficGb - usedTrafficGb);
    const state = resolveSubscriptionState(input.state ?? current.state, remainingTrafficGb, expireAt);

    const row = await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        totalTrafficGb,
        usedTrafficGb,
        remainingTrafficGb,
        expireAt,
        renewable,
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

    await this.syncSubscriptionPanelAccess(subscriptionId);

    return toAdminSubscriptionRecord(row);
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
          include: { user: true },
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

    const subscription = await this.findCurrentTeamSubscription(teamId);
    if (subscription) {
      await this.syncSubscriptionPanelAccess(subscription.id);
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
      await this.removePanelBindingsForSubscription(subscription.id, { userId: member.userId });
    }

    await this.prisma.teamMember.delete({
      where: { id: memberId }
    });

    return { ok: true };
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
    const renewable = input.renewable ?? plan.renewable;
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
        renewable,
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

    await this.syncSubscriptionPanelAccess(row.id);

    return toAdminSubscriptionRecord(row);
  }

  async getSubscriptionNodeAccess(subscriptionId: string): Promise<SubscriptionNodeAccessDto> {
    const subscription = await this.requireSubscription(subscriptionId);
    const rows = await this.prisma.subscriptionNodeAccess.findMany({
      where: { subscriptionId },
      include: { node: true },
      orderBy: [{ node: { recommended: "desc" } }, { node: { latencyMs: "asc" } }, { node: { createdAt: "desc" } }]
    });
    const deduped = dedupeNodeAccessRows(rows);

    return {
      subscriptionId: subscription.id,
      nodeIds: deduped.map((item) => item.nodeId),
      nodes: deduped.map((item) => toNodeSummary(item.node))
    };
  }

  async updateSubscriptionNodeAccess(
    subscriptionId: string,
    input: UpdateSubscriptionNodeAccessInputDto
  ): Promise<SubscriptionNodeAccessDto> {
    await this.requireSubscription(subscriptionId);

    if (input.nodeIds.length === 0) {
    await this.prisma.subscriptionNodeAccess.deleteMany({
      where: { subscriptionId }
    });

    await this.syncSubscriptionPanelAccess(subscriptionId);
      return {
        subscriptionId,
        nodeIds: [],
        nodes: []
      };
    }

    const uniqueNodeIds = [...new Set(input.nodeIds)];
    const availableNodes = await this.prisma.node.findMany({
      where: { id: { in: uniqueNodeIds } }
    });

    if (availableNodes.length !== uniqueNodeIds.length) {
      throw new BadRequestException("存在无效节点");
    }

    await this.prisma.subscriptionNodeAccess.deleteMany({
      where: { subscriptionId }
    });

    await this.prisma.subscriptionNodeAccess.createMany({
      data: uniqueNodeIds.map((nodeId) => ({
        id: createId("subscription_node"),
        subscriptionId,
        nodeId
      }))
    });

    await this.syncSubscriptionPanelAccess(subscriptionId);

    const rows = await this.prisma.subscriptionNodeAccess.findMany({
      where: { subscriptionId },
      include: { node: true },
      orderBy: [{ node: { recommended: "desc" } }, { node: { latencyMs: "asc" } }, { node: { createdAt: "desc" } }]
    });
    const deduped = dedupeNodeAccessRows(rows);

    return {
      subscriptionId,
      nodeIds: deduped.map((item) => item.nodeId),
      nodes: deduped.map((item) => toNodeSummary(item.node))
    };
  }

  async getTeamUsage(teamId: string): Promise<AdminTeamUsageRecordDto[]> {
    await this.requireTeam(teamId);
    const rows = await this.prisma.trafficLedger.findMany({
      where: { teamId },
      include: { user: true },
      orderBy: [{ recordedAt: "desc" }, { createdAt: "desc" }]
    });

    return rows.map(toAdminTeamUsageRecord);
  }

  async listAdminNodes(): Promise<AdminNodeRecordDto[]> {
    const rows = await this.prisma.node.findMany({
      orderBy: [{ recommended: "desc" }, { latencyMs: "asc" }, { createdAt: "desc" }]
    });
    return rows.map(toAdminNodeRecord);
  }

  async importNodeFromSubscription(input: ImportNodeInputDto): Promise<AdminNodeRecordDto> {
    const imported = await this.resolveNodeRuntimeSource(input);
    const nodeId = toNodeId(imported.serverHost, imported.serverPort);
    const current = await this.prisma.node.findUnique({ where: { id: nodeId } });

    const row = await this.prisma.node.upsert({
      where: { id: nodeId },
      create: {
        id: nodeId,
        name: input.name?.trim() || imported.name,
        region: input.region?.trim() || inferRegion(imported.name, imported.serverHost),
        provider: input.provider?.trim() || "自有节点",
        tags: normalizeTags(input.tags, imported.name),
        recommended: input.recommended ?? true,
        latencyMs: 0,
        protocol: "vless",
        security: "reality",
        serverHost: imported.serverHost,
        serverPort: imported.serverPort,
        uuid: imported.uuid,
        flow: imported.flow,
        realityPublicKey: imported.realityPublicKey,
        shortId: imported.shortId,
        serverName: imported.serverName,
        fingerprint: imported.fingerprint,
        spiderX: imported.spiderX,
        subscriptionUrl: input.subscriptionUrl?.trim() || null,
        gatewayStatus: current?.gatewayStatus ?? "offline",
        panelBaseUrl: input.panelBaseUrl?.trim() || current?.panelBaseUrl || null,
        panelApiBasePath: normalizePanelApiBasePath(input.panelApiBasePath ?? current?.panelApiBasePath ?? "/"),
        panelUsername: input.panelUsername?.trim() || current?.panelUsername || null,
        panelPassword: input.panelPassword?.trim() || current?.panelPassword || null,
        panelInboundId: input.panelInboundId ?? current?.panelInboundId ?? null,
        panelEnabled: input.panelEnabled ?? current?.panelEnabled ?? false,
        panelStatus: current?.panelStatus ?? "offline"
      },
      update: {
        name: input.name?.trim() || imported.name,
        region: input.region?.trim() || inferRegion(imported.name, imported.serverHost),
        provider: input.provider?.trim() || "自有节点",
        tags: normalizeTags(input.tags, imported.name),
        recommended: input.recommended ?? true,
        latencyMs: 0,
        serverHost: imported.serverHost,
        serverPort: imported.serverPort,
        uuid: imported.uuid,
        flow: imported.flow,
        realityPublicKey: imported.realityPublicKey,
        shortId: imported.shortId,
        serverName: imported.serverName,
        fingerprint: imported.fingerprint,
        spiderX: imported.spiderX,
        subscriptionUrl: input.subscriptionUrl?.trim() || null,
        panelBaseUrl: input.panelBaseUrl?.trim() || current?.panelBaseUrl || null,
        panelApiBasePath: normalizePanelApiBasePath(input.panelApiBasePath ?? current?.panelApiBasePath ?? "/"),
        panelUsername: input.panelUsername?.trim() || current?.panelUsername || null,
        panelPassword: input.panelPassword?.trim() || current?.panelPassword || null,
        panelInboundId: input.panelInboundId ?? current?.panelInboundId ?? null,
        panelEnabled: input.panelEnabled ?? current?.panelEnabled ?? false
      }
    });

    return this.probeNode(row.id);
  }

  async listNodePanelInbounds(input: {
    panelBaseUrl: string;
    panelApiBasePath?: string;
    panelUsername: string;
    panelPassword: string;
  }): Promise<AdminNodePanelInboundDto[]> {
    const inbounds = await this.xuiService.listInbounds({
      id: createId("panel"),
      panelBaseUrl: input.panelBaseUrl,
      panelApiBasePath: input.panelApiBasePath ?? "/",
      panelUsername: input.panelUsername,
      panelPassword: input.panelPassword,
      panelInboundId: null
    });

    return inbounds;
  }

  async updateNode(nodeId: string, input: UpdateNodeInputDto): Promise<AdminNodeRecordDto> {
    const current = await this.prisma.node.findUnique({ where: { id: nodeId } });
    if (!current) {
      throw new NotFoundException("节点不存在");
    }

    let derived: ReturnType<typeof parseVlessLink> | null = null;
    if (input.subscriptionUrl !== undefined && input.subscriptionUrl.trim()) {
      derived = await this.fetchSubscriptionNode(input.subscriptionUrl);
    } else if (
      input.panelEnabled === true &&
      (input.panelBaseUrl !== undefined || input.panelApiBasePath !== undefined || input.panelUsername !== undefined || input.panelPassword !== undefined || input.panelInboundId !== undefined)
    ) {
      derived = await this.xuiService.getInboundRuntime({
        id: current.id,
        panelBaseUrl: input.panelBaseUrl ?? current.panelBaseUrl,
        panelApiBasePath: input.panelApiBasePath ?? current.panelApiBasePath,
        panelUsername: input.panelUsername ?? current.panelUsername,
        panelPassword: input.panelPassword ?? current.panelPassword,
        panelInboundId: input.panelInboundId ?? current.panelInboundId
      });
    }

    const row = await this.prisma.node.update({
      where: { id: nodeId },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.region !== undefined ? { region: input.region.trim() } : {}),
        ...(input.provider !== undefined ? { provider: input.provider.trim() } : {}),
        ...(input.tags !== undefined ? { tags: normalizeTags(input.tags, input.name?.trim() || current.name) } : {}),
        ...(input.recommended !== undefined ? { recommended: input.recommended } : {}),
        ...(input.subscriptionUrl !== undefined ? { subscriptionUrl: input.subscriptionUrl?.trim() || null } : {}),
        ...(input.panelBaseUrl !== undefined ? { panelBaseUrl: input.panelBaseUrl?.trim() || null } : {}),
        ...(input.panelApiBasePath !== undefined ? { panelApiBasePath: normalizePanelApiBasePath(input.panelApiBasePath) } : {}),
        ...(input.panelUsername !== undefined ? { panelUsername: input.panelUsername?.trim() || null } : {}),
        ...(input.panelPassword !== undefined ? { panelPassword: input.panelPassword?.trim() || null } : {}),
        ...(input.panelInboundId !== undefined ? { panelInboundId: input.panelInboundId } : {}),
        ...(input.panelEnabled !== undefined ? { panelEnabled: input.panelEnabled } : {}),
        ...(derived
          ? {
              serverHost: derived.serverHost,
              serverPort: derived.serverPort,
              uuid: derived.uuid,
              flow: derived.flow,
              realityPublicKey: derived.realityPublicKey,
              shortId: derived.shortId,
              serverName: derived.serverName,
              fingerprint: derived.fingerprint,
              spiderX: derived.spiderX
            }
          : {})
      }
    });

    return toAdminNodeRecord(row);
  }

  async refreshNode(nodeId: string): Promise<AdminNodeRecordDto> {
    const current = await this.prisma.node.findUnique({ where: { id: nodeId } });
    if (!current) {
      throw new NotFoundException("节点不存在");
    }
    let derived: ReturnType<typeof parseVlessLink> | Awaited<ReturnType<XuiService["getInboundRuntime"]>>;
    if (current.panelEnabled) {
      derived = await this.xuiService.getInboundRuntime({
        id: current.id,
        panelBaseUrl: current.panelBaseUrl,
        panelApiBasePath: current.panelApiBasePath,
        panelUsername: current.panelUsername,
        panelPassword: current.panelPassword,
        panelInboundId: current.panelInboundId
      });
    } else {
      if (!current.subscriptionUrl) {
        throw new BadRequestException("当前节点没有订阅地址");
      }
      derived = await this.fetchSubscriptionNode(current.subscriptionUrl);
    }
    const row = await this.prisma.node.update({
      where: { id: nodeId },
      data: {
        serverHost: derived.serverHost,
        serverPort: derived.serverPort,
        uuid: derived.uuid,
        flow: derived.flow,
        realityPublicKey: derived.realityPublicKey,
        shortId: derived.shortId,
        serverName: derived.serverName,
        fingerprint: derived.fingerprint,
        spiderX: derived.spiderX
      }
    });

    return toAdminNodeRecord(row);
  }

  private async resolveNodeRuntimeSource(input: ImportNodeInputDto) {
    if (input.subscriptionUrl?.trim()) {
      return this.fetchSubscriptionNode(input.subscriptionUrl.trim());
    }

    if (input.panelEnabled && input.panelBaseUrl && input.panelUsername && input.panelPassword && input.panelInboundId) {
      return this.xuiService.getInboundRuntime({
        id: createId("panel_runtime"),
        panelBaseUrl: input.panelBaseUrl,
        panelApiBasePath: input.panelApiBasePath ?? "/",
        panelUsername: input.panelUsername,
        panelPassword: input.panelPassword,
        panelInboundId: input.panelInboundId
      });
    }

    throw new BadRequestException("请填写订阅地址，或完整配置 3x-ui 面板后再导入节点");
  }

  async probeNode(nodeId: string): Promise<AdminNodeRecordDto> {
    const current = await this.prisma.node.findUnique({ where: { id: nodeId } });
    if (!current) {
      throw new NotFoundException("节点不存在");
    }

    const gatewayStatus = await this.edgeGatewayService.getGatewayStatus();
    const result = await probeNodeConnectivity(current.serverHost, current.serverPort, current.serverName, current.subscriptionUrl);
    let panelStatus = current.panelStatus;
    let panelError = current.panelError;
    let panelLastSyncedAt = current.panelLastSyncedAt;
    if (current.panelEnabled) {
      try {
        await this.xuiService.checkNodeHealth({
          id: current.id,
          panelBaseUrl: current.panelBaseUrl,
          panelApiBasePath: current.panelApiBasePath,
          panelUsername: current.panelUsername,
          panelPassword: current.panelPassword,
          panelInboundId: current.panelInboundId
        });
        panelStatus = "online";
        panelError = null;
        panelLastSyncedAt = new Date();
      } catch (error) {
        panelStatus = "degraded";
        panelError = error instanceof Error ? error.message : "3x-ui 面板探测失败";
      }
    }
    const row = await this.prisma.node.update({
      where: { id: nodeId },
      data: {
        probeStatus: result.status,
        probeLatencyMs: result.latencyMs,
        probeCheckedAt: new Date(),
        probeError: result.error,
        latencyMs: result.latencyMs ?? current.latencyMs,
        panelStatus,
        panelError,
        panelLastSyncedAt
      }
    });

    return {
      ...toAdminNodeRecord(row),
      gatewayStatus
    };
  }

  async probeAllNodes() {
    const nodes = await this.prisma.node.findMany({ orderBy: { createdAt: "desc" } });
    const results: AdminNodeRecordDto[] = [];
    for (const node of nodes) {
      results.push(await this.probeNode(node.id));
    }
    return results;
  }

  async deleteNode(nodeId: string) {
    await this.prisma.node.delete({ where: { id: nodeId } });
    return { ok: true };
  }

  async listAdminAnnouncements(): Promise<AdminAnnouncementRecordDto[]> {
    const rows = await this.prisma.announcement.findMany({
      orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }]
    });
    return rows.map(toAdminAnnouncementRecord);
  }

  async createAnnouncement(input: CreateAnnouncementInputDto): Promise<AdminAnnouncementRecordDto> {
    const displayMode = input.displayMode ?? "passive";
    const countdownSeconds = displayMode === "modal_countdown" ? Math.max(1, input.countdownSeconds ?? 5) : 0;

    const row = await this.prisma.announcement.create({
      data: {
        id: createId("announcement"),
        title: input.title.trim(),
        body: input.body.trim(),
        level: input.level,
        publishedAt: input.publishedAt ? new Date(input.publishedAt) : new Date(),
        isActive: input.isActive ?? true,
        displayMode,
        countdownSeconds
      }
    });

    return toAdminAnnouncementRecord(row);
  }

  async updateAnnouncement(announcementId: string, input: UpdateAnnouncementInputDto): Promise<AdminAnnouncementRecordDto> {
    const current = await this.prisma.announcement.findUnique({
      where: { id: announcementId }
    });
    if (!current) {
      throw new NotFoundException("公告不存在");
    }

    const displayMode = input.displayMode ?? current.displayMode;
    const countdownBase = input.countdownSeconds ?? current.countdownSeconds ?? 5;
    const countdownSeconds = displayMode === "modal_countdown" ? Math.max(1, countdownBase) : 0;

    const row = await this.prisma.announcement.update({
      where: { id: announcementId },
      data: {
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.body !== undefined ? { body: input.body.trim() } : {}),
        ...(input.level !== undefined ? { level: input.level } : {}),
        ...(input.publishedAt !== undefined ? { publishedAt: new Date(input.publishedAt) } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.displayMode !== undefined ? { displayMode } : {}),
        ...(input.displayMode !== undefined || input.countdownSeconds !== undefined ? { countdownSeconds } : {})
      }
    });

    return toAdminAnnouncementRecord(row);
  }

  async getAdminPolicy(): Promise<AdminPolicyRecordDto> {
    const profile = await this.prisma.policyProfile.findUnique({
      where: { id: "default" }
    });
    if (!profile) {
      throw new NotFoundException("策略配置不存在");
    }
    return toAdminPolicyRecord(profile);
  }

  async updatePolicy(input: UpdatePolicyInputDto): Promise<AdminPolicyRecordDto> {
    await this.prisma.policyProfile.update({
      where: { id: "default" },
      data: {
        ...(input.accessMode !== undefined ? { accessMode: input.accessMode } : {}),
        ...(input.defaultMode !== undefined ? { defaultMode: input.defaultMode } : {}),
        ...(input.modes !== undefined ? { modes: input.modes } : {}),
        ...(input.blockAds !== undefined ? { blockAds: input.blockAds } : {}),
        ...(input.chinaDirect !== undefined ? { chinaDirect: input.chinaDirect } : {}),
        ...(input.aiServicesProxy !== undefined ? { aiServicesProxy: input.aiServicesProxy } : {}),
        ...(input.currentVersion !== undefined ? { currentVersion: input.currentVersion.trim() } : {}),
        ...(input.minimumVersion !== undefined ? { minimumVersion: input.minimumVersion.trim() } : {}),
        ...(input.forceUpgrade !== undefined ? { forceUpgrade: input.forceUpgrade } : {}),
        ...(input.changelog !== undefined ? { changelog: input.changelog.map((item) => item.trim()).filter(Boolean) } : {}),
        ...(input.downloadUrl !== undefined ? { downloadUrl: input.downloadUrl || null } : {})
      }
    });

    return this.getAdminPolicy();
  }

  async getUsers(): Promise<UserProfileDto[]> {
    const rows = await this.prisma.user.findMany({
      orderBy: { createdAt: "asc" }
    });
    return rows.map(toUserProfile);
  }

  private async resolveSubscriptionAccessForUser(userId: string) {
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
      const subscription = pickCurrentSubscription(membership.team.subscriptions);
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

  private async findCurrentTeamSubscription(teamId: string) {
    return this.prisma.subscription.findFirst({
      where: { teamId },
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

  private async ensureUserExists(userId: string) {
    const row = await this.prisma.user.findUnique({ where: { id: userId } });
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
        team: true
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
    const rows = await this.listAdminTeams();
    const row = rows.find((item) => item.id === teamId);
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

  private async getUserMembership(userId: string) {
    return this.prisma.teamMember.findUnique({
      where: { userId }
    });
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

  private async seedIfEmpty() {
    const count = await this.prisma.user.count();
    if (count > 0) {
      return;
    }

    const demoPasswordHash = await bcrypt.hash("demo123456", 10);
    const adminPasswordHash = await bcrypt.hash(BUILTIN_ADMIN_PASSWORD, 10);
    const ownerPasswordHash = await bcrypt.hash("team123456", 10);
    const memberPasswordHash = await bcrypt.hash("team123456", 10);

    await this.prisma.user.createMany({
      data: [
        {
          id: mockUser.id,
          email: mockUser.email,
          displayName: mockUser.displayName,
          role: mockUser.role,
          status: mockUser.status,
          authVersion: 1,
          maxConcurrentSessionsOverride: null,
          passwordHash: demoPasswordHash,
          lastSeenAt: new Date(mockUser.lastSeenAt)
        },
        {
          id: BUILTIN_ADMIN_ID,
          email: BUILTIN_ADMIN_ACCOUNT,
          displayName: "系统管理员",
          role: "admin",
          status: "active",
          authVersion: 1,
          maxConcurrentSessionsOverride: null,
          passwordHash: adminPasswordHash,
          lastSeenAt: new Date()
        },
        {
          id: "user_team_owner_001",
          email: "team-owner@chordv.app",
          displayName: "团队负责人",
          role: "user",
          status: "active",
          authVersion: 1,
          maxConcurrentSessionsOverride: null,
          passwordHash: ownerPasswordHash,
          lastSeenAt: new Date()
        },
        {
          id: "user_team_member_001",
          email: "team-member@chordv.app",
          displayName: "团队成员",
          role: "user",
          status: "active",
          authVersion: 1,
          maxConcurrentSessionsOverride: null,
          passwordHash: memberPasswordHash,
          lastSeenAt: new Date()
        }
      ]
    });

    await this.prisma.plan.createMany({
      data: [
        {
          id: mockSubscription.planId,
          name: mockSubscription.planName,
          scope: "personal",
          totalTrafficGb: mockSubscription.totalTrafficGb,
          renewable: mockSubscription.renewable,
          maxConcurrentSessions: 1,
          isActive: true
        },
        {
          id: "plan_team_500",
          name: "团队版 500G",
          scope: "team",
          totalTrafficGb: 500,
          renewable: true,
          maxConcurrentSessions: 1,
          isActive: true
        }
      ]
    });

    await this.prisma.subscription.create({
      data: {
        id: "subscription_demo_001",
        userId: mockUser.id,
        planId: mockSubscription.planId,
        totalTrafficGb: mockSubscription.totalTrafficGb,
        usedTrafficGb: mockSubscription.usedTrafficGb,
        remainingTrafficGb: mockSubscription.remainingTrafficGb,
        expireAt: new Date(mockSubscription.expireAt),
        state: mockSubscription.state,
        renewable: mockSubscription.renewable,
        sourceAction: "created",
        lastSyncedAt: new Date(mockSubscription.lastSyncedAt)
      }
    });

    await this.prisma.team.create({
      data: {
        id: "team_demo_001",
        name: "示例团队",
        ownerUserId: "user_team_owner_001",
        status: "active"
      }
    });

    await this.prisma.teamMember.createMany({
      data: [
        {
          id: "member_owner_001",
          teamId: "team_demo_001",
          userId: "user_team_owner_001",
          role: "owner"
        },
        {
          id: "member_user_001",
          teamId: "team_demo_001",
          userId: "user_team_member_001",
          role: "member"
        }
      ]
    });

    await this.prisma.subscription.create({
      data: {
        id: "subscription_team_001",
        teamId: "team_demo_001",
        planId: "plan_team_500",
        totalTrafficGb: 500,
        usedTrafficGb: 120,
        remainingTrafficGb: 380,
        expireAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
        state: "active",
        renewable: true,
        sourceAction: "created",
        lastSyncedAt: new Date()
      }
    });

    await this.prisma.trafficLedger.createMany({
      data: [
        {
          id: "ledger_001",
          teamId: "team_demo_001",
          userId: "user_team_owner_001",
          subscriptionId: "subscription_team_001",
          usedTrafficGb: 42,
          recordedAt: new Date()
        },
        {
          id: "ledger_002",
          teamId: "team_demo_001",
          userId: "user_team_member_001",
          subscriptionId: "subscription_team_001",
          usedTrafficGb: 78,
          recordedAt: new Date()
        }
      ]
    });

    await this.prisma.node.createMany({
      data: mockNodes.map((node) => ({
        id: node.id,
        name: node.name,
        region: node.region,
        provider: node.provider,
        tags: node.tags,
        recommended: node.recommended,
        latencyMs: node.latencyMs,
        protocol: node.protocol,
        security: node.security,
        serverHost: `${node.region.toLowerCase().replaceAll(" ", "-")}.edge.chordv.app`,
        serverPort: 443,
        uuid: "d5076fbe-b935-4dc6-8f59-a056d05db6f3",
        flow: "xtls-rprx-vision",
        realityPublicKey: "5C3G02RWVBX3e2tHAh9d69Vk4g8JwG2Zx2N0TTTPD2M",
        shortId: "6ba85179",
        serverName: "cdn.cloudflare.com",
        fingerprint: "chrome",
        spiderX: "/",
        subscriptionUrl: null,
        probeStatus: "unknown",
        panelApiBasePath: "/",
        panelEnabled: false,
        panelStatus: "offline"
      }))
    });

    await this.prisma.subscriptionNodeAccess.createMany({
      data: [
        {
          id: "subscription_node_demo_001",
          subscriptionId: "subscription_demo_001",
          nodeId: mockNodes[0]?.id ?? "node_hk_01"
        },
        {
          id: "subscription_node_demo_002",
          subscriptionId: "subscription_demo_001",
          nodeId: mockNodes[1]?.id ?? "node_sg_01"
        },
        {
          id: "subscription_node_team_001",
          subscriptionId: "subscription_team_001",
          nodeId: mockNodes[0]?.id ?? "node_hk_01"
        },
        {
          id: "subscription_node_team_002",
          subscriptionId: "subscription_team_001",
          nodeId: mockNodes[2]?.id ?? "node_jp_01"
        }
      ]
    });

    await this.prisma.policyProfile.create({
      data: {
        id: "default",
        accessMode: "xui",
        defaultMode: mockPolicies.defaultMode,
        modes: mockPolicies.modes,
        ruleVersion: "managed",
        ruleUpdatedAt: new Date(),
        dnsProfile: "default",
        blockAds: mockPolicies.features.blockAds,
        chinaDirect: mockPolicies.features.chinaDirect,
        aiServicesProxy: mockPolicies.features.aiServicesProxy,
        currentVersion: mockVersion.currentVersion,
        minimumVersion: mockVersion.minimumVersion,
        forceUpgrade: mockVersion.forceUpgrade,
        changelog: mockVersion.changelog,
        downloadUrl: mockVersion.downloadUrl ?? null
      }
    });

    await this.prisma.announcement.createMany({
      data: mockAnnouncements.map((item) => ({
        id: item.id,
        title: item.title,
        body: item.body,
        level: item.level,
        publishedAt: new Date(item.publishedAt),
        isActive: true,
        displayMode: item.displayMode,
        countdownSeconds: item.countdownSeconds
      }))
    });
  }

  private async resolveUserForLogin(account: string) {
    if (account === BUILTIN_ADMIN_ACCOUNT) {
      const adminByAccount = await this.prisma.user.findUnique({
        where: { email: BUILTIN_ADMIN_ACCOUNT }
      });
      if (adminByAccount) {
        return adminByAccount;
      }
      return this.prisma.user.findFirst({
        where: { role: "admin" },
        orderBy: { createdAt: "asc" }
      });
    }

    return this.prisma.user.findUnique({
      where: { email: account }
    });
  }

  private async ensureBuiltinAdminAccount() {
    const adminPasswordHash = await bcrypt.hash(BUILTIN_ADMIN_PASSWORD, 10);
    const now = new Date();

    const builtInAdmin = await this.prisma.user.findUnique({
      where: { id: BUILTIN_ADMIN_ID }
    });
    if (builtInAdmin) {
      await this.prisma.user.update({
        where: { id: builtInAdmin.id },
        data: {
          email: BUILTIN_ADMIN_ACCOUNT,
          displayName: "系统管理员",
          role: "admin",
          status: "active",
          maxConcurrentSessionsOverride: null,
          passwordHash: adminPasswordHash,
          lastSeenAt: now
        }
      });
      return;
    }

    const accountAdmin = await this.prisma.user.findUnique({
      where: { email: BUILTIN_ADMIN_ACCOUNT }
    });
    if (accountAdmin) {
      await this.prisma.user.update({
        where: { id: accountAdmin.id },
        data: {
          displayName: "系统管理员",
          role: "admin",
          status: "active",
          maxConcurrentSessionsOverride: null,
          passwordHash: adminPasswordHash,
          lastSeenAt: now
        }
      });
      return;
    }

    await this.prisma.user.create({
      data: {
        id: BUILTIN_ADMIN_ID,
        email: BUILTIN_ADMIN_ACCOUNT,
        displayName: "系统管理员",
        role: "admin",
        status: "active",
        authVersion: 1,
        maxConcurrentSessionsOverride: null,
        passwordHash: adminPasswordHash,
        lastSeenAt: now
      }
    });
  }

  private async fetchSubscriptionNode(subscriptionUrl: string) {
    const timeoutMs = Number(process.env.CHORDV_SUBSCRIPTION_TIMEOUT_MS ?? 15000);
    const allowInsecureTls = (process.env.CHORDV_SUBSCRIPTION_ALLOW_INSECURE_TLS ?? "true").toLowerCase() === "true";
    const response = await undiciFetch(subscriptionUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: createDispatcher(timeoutMs, allowInsecureTls)
    });

    if (!response.ok) {
      throw new BadRequestException(`订阅地址请求失败：HTTP ${response.status}`);
    }

    const raw = (await response.text()).trim();
    const decoded = decodeSubscriptionText(raw);
    const first = decoded
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => item.startsWith("vless://"));

    if (!first) {
      throw new BadRequestException("订阅内容里没有可用的 vless 节点");
    }

    return parseVlessLink(first);
  }
}

function toUserProfile(row: {
  id: string;
  email: string;
  displayName: string;
  role: "user" | "admin";
  status: "active" | "disabled";
  lastSeenAt: Date;
}): UserProfileDto {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    lastSeenAt: row.lastSeenAt.toISOString()
  };
}

function toUserSubscriptionSummary(
  row: {
    id: string;
    planId: string;
    plan: { name: string };
    remainingTrafficGb: number;
    expireAt: Date;
    state: SubscriptionState;
  },
  team: { id: string; name: string } | null
): UserSubscriptionSummaryDto {
  return {
    id: row.id,
    ownerType: team ? "team" : "user",
    planId: row.planId,
    planName: row.plan.name,
    remainingTrafficGb: row.remainingTrafficGb,
    expireAt: row.expireAt.toISOString(),
    state: row.state,
    teamId: team?.id ?? null,
    teamName: team?.name ?? null
  };
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
  serverHost: string;
  serverPort: number;
  serverName: string;
}): NodeSummaryDto {
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    provider: row.provider,
    tags: row.tags,
    recommended: row.recommended,
    latencyMs: row.probeLatencyMs ?? row.latencyMs,
    protocol: row.protocol as "vless",
    security: row.security as "reality",
    serverHost: row.serverHost,
    serverPort: row.serverPort,
    serverName: row.serverName
  };
}

function toAdminSubscriptionRecord(row: {
  id: string;
  userId: string | null;
  teamId: string | null;
  planId: string;
  totalTrafficGb: number;
  usedTrafficGb: number;
  remainingTrafficGb: number;
  expireAt: Date;
  state: SubscriptionState;
  renewable: boolean;
  sourceAction: SubscriptionSourceAction;
  lastSyncedAt: Date;
  plan: { name: string };
  user: { email: string; displayName: string } | null;
  team: { name: string } | null;
  nodeAccesses?: Array<{ nodeId: string }>;
}): AdminSubscriptionRecordDto {
  const ownerType = row.teamId ? "team" : "user";
  const nodeCount = row.nodeAccesses ? new Set(row.nodeAccesses.map((item) => item.nodeId)).size : 0;
  return {
    id: row.id,
    ownerType,
    userId: row.userId,
    userEmail: row.user?.email ?? null,
    userDisplayName: row.user?.displayName ?? null,
    teamId: row.teamId,
    teamName: row.team?.name ?? null,
    planId: row.planId,
    planName: row.plan.name,
    totalTrafficGb: row.totalTrafficGb,
    usedTrafficGb: row.usedTrafficGb,
    remainingTrafficGb: row.remainingTrafficGb,
    expireAt: row.expireAt.toISOString(),
    state: row.state,
    renewable: row.renewable,
    sourceAction: row.sourceAction,
    lastSyncedAt: row.lastSyncedAt.toISOString(),
    nodeCount,
    hasNodeAccess: nodeCount > 0
  };
}

function dedupeNodeAccessRows(
  rows: Array<{
    nodeId: string;
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
      serverName: string;
    };
  }>
) {
  const nodeMap = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!nodeMap.has(row.nodeId)) {
      nodeMap.set(row.nodeId, row);
    }
  }
  return Array.from(nodeMap.values());
}

function toAdminNodeRecord(row: {
  id: string;
  name: string;
  region: string;
  provider: string;
  tags: string[];
  recommended: boolean;
  latencyMs: number;
  probeLatencyMs: number | null;
  protocol: string;
  security: string;
  serverHost: string;
  serverPort: number;
  serverName: string;
  shortId: string;
  spiderX: string;
  subscriptionUrl: string | null;
  gatewayStatus: "online" | "offline" | "degraded";
  statsLastSyncedAt: Date | null;
  panelBaseUrl: string | null;
  panelApiBasePath: string | null;
  panelUsername: string | null;
  panelPassword: string | null;
  panelInboundId: number | null;
  panelEnabled: boolean;
  panelStatus: "online" | "offline" | "degraded";
  panelLastSyncedAt: Date | null;
  panelError: string | null;
  probeStatus: NodeProbeStatus;
  probeCheckedAt: Date | null;
  probeError: string | null;
  createdAt: Date;
  updatedAt: Date;
}): AdminNodeRecordDto {
  return {
    ...toNodeSummary(row),
    subscriptionUrl: row.subscriptionUrl,
    gatewayStatus: row.gatewayStatus,
    statsLastSyncedAt: row.statsLastSyncedAt?.toISOString() ?? null,
    panelBaseUrl: row.panelBaseUrl,
    panelApiBasePath: row.panelApiBasePath,
    panelUsername: row.panelUsername,
    panelPassword: row.panelPassword,
    panelInboundId: row.panelInboundId,
    panelEnabled: row.panelEnabled,
    panelStatus: row.panelStatus,
    panelLastSyncedAt: row.panelLastSyncedAt?.toISOString() ?? null,
    panelError: row.panelError,
    serverName: row.serverName,
    serverHost: row.serverHost,
    serverPort: row.serverPort,
    shortId: row.shortId,
    spiderX: row.spiderX,
    probeStatus: row.probeStatus,
    probeLatencyMs: row.probeLatencyMs,
    probeCheckedAt: row.probeCheckedAt?.toISOString() ?? null,
    probeError: row.probeError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function readEdgeProbeConfig() {
  return {
    serverHost: process.env.CHORDV_EDGE_PUBLIC_HOST?.trim() || "127.0.0.1",
    serverPort: Number(process.env.CHORDV_EDGE_PUBLIC_PORT ?? 8443),
    serverName: process.env.CHORDV_EDGE_SERVER_NAME?.trim() || "edge.chordv.app"
  };
}

function toAdminAnnouncementRecord(row: {
  id: string;
  title: string;
  body: string;
  level: "info" | "warning" | "success";
  publishedAt: Date;
  isActive: boolean;
  displayMode: "passive" | "modal_confirm" | "modal_countdown";
  countdownSeconds: number;
  createdAt: Date;
  updatedAt: Date;
}): AdminAnnouncementRecordDto {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    level: row.level,
    publishedAt: row.publishedAt.toISOString(),
    isActive: row.isActive,
    displayMode: row.displayMode,
    countdownSeconds: row.countdownSeconds,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function toAnnouncementDto(row: {
  id: string;
  title: string;
  body: string;
  level: "info" | "warning" | "success";
  publishedAt: Date;
  displayMode: "passive" | "modal_confirm" | "modal_countdown";
  countdownSeconds: number;
}): AnnouncementDto {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    level: row.level,
    publishedAt: row.publishedAt.toISOString(),
    displayMode: row.displayMode,
    countdownSeconds: row.countdownSeconds
  };
}

function toAdminPolicyRecord(row: {
  accessMode: string;
  defaultMode: string;
  modes: string[];
  blockAds: boolean;
  chinaDirect: boolean;
  aiServicesProxy: boolean;
  currentVersion: string;
  minimumVersion: string;
  forceUpgrade: boolean;
  changelog: string[];
  downloadUrl: string | null;
}): AdminPolicyRecordDto {
  return {
    accessMode: row.accessMode as AdminPolicyRecordDto["accessMode"],
    defaultMode: row.defaultMode as PolicyBundleDto["defaultMode"],
    modes: row.modes as PolicyBundleDto["modes"],
    features: {
      blockAds: row.blockAds,
      chinaDirect: row.chinaDirect,
      aiServicesProxy: row.aiServicesProxy
    },
    currentVersion: row.currentVersion,
    minimumVersion: row.minimumVersion,
    forceUpgrade: row.forceUpgrade,
    changelog: row.changelog,
    downloadUrl: row.downloadUrl
  };
}

function toSubscriptionStatusDto(
  row: {
    id: string;
    planId: string;
    totalTrafficGb: number;
    usedTrafficGb: number;
    remainingTrafficGb: number;
    expireAt: Date;
    state: SubscriptionState;
    renewable: boolean;
    lastSyncedAt: Date;
    plan: { name: string };
  },
  team: { id: string; name: string } | null,
  memberUsedTrafficGb: number | null,
  metering: { meteringStatus: "ok" | "degraded"; meteringMessage: string | null }
): SubscriptionStatusDto {
  return {
    id: row.id,
    ownerType: team ? "team" : "user",
    planId: row.planId,
    planName: row.plan.name,
    totalTrafficGb: row.totalTrafficGb,
    usedTrafficGb: row.usedTrafficGb,
    remainingTrafficGb: row.remainingTrafficGb,
    expireAt: row.expireAt.toISOString(),
    state: row.state,
    renewable: row.renewable,
    lastSyncedAt: row.lastSyncedAt.toISOString(),
    teamId: team?.id ?? null,
    teamName: team?.name ?? null,
    memberUsedTrafficGb,
    meteringStatus: metering.meteringStatus,
    meteringMessage: metering.meteringMessage
  };
}

function toAdminTeamMemberRecord(
  row: {
    id: string;
    teamId: string;
    userId: string;
    role: TeamMemberRole;
    createdAt: Date;
    user: { email: string; displayName: string };
  },
  usedTrafficGb: number
): AdminTeamMemberRecordDto {
  return {
    id: row.id,
    teamId: row.teamId,
    userId: row.userId,
    email: row.user.email,
    displayName: row.user.displayName,
    role: row.role,
    usedTrafficGb,
    createdAt: row.createdAt.toISOString()
  };
}

function toAdminTeamUsageRecord(row: {
  id: string;
  teamId: string;
  userId: string;
  subscriptionId: string;
  usedTrafficGb: number;
  recordedAt: Date;
  user: { displayName: string; email: string };
}): AdminTeamUsageRecordDto {
  return {
    id: row.id,
    teamId: row.teamId,
    userId: row.userId,
    userDisplayName: row.user.displayName,
    userEmail: row.user.email,
    subscriptionId: row.subscriptionId,
    usedTrafficGb: row.usedTrafficGb,
    recordedAt: row.recordedAt.toISOString()
  };
}

function toAdminTeamRecord(row: {
  id: string;
  name: string;
  ownerUserId: string;
  status: TeamStatus;
  createdAt: Date;
  updatedAt: Date;
  owner: { displayName: string; email: string };
  members: Array<{
    id: string;
    teamId: string;
    userId: string;
    role: TeamMemberRole;
    createdAt: Date;
    user: { email: string; displayName: string };
  }>;
  subscriptions: Array<{
    id: string;
    planId: string;
    totalTrafficGb: number;
    usedTrafficGb: number;
    remainingTrafficGb: number;
    expireAt: Date;
    state: SubscriptionState;
    plan: { name: string };
  }>;
  trafficLedgerEntries: Array<{
    id: string;
    teamId: string;
    userId: string;
    subscriptionId: string;
    usedTrafficGb: number;
    recordedAt: Date;
    user: { displayName: string; email: string };
  }>;
}): AdminTeamRecordDto {
  const currentSubscription = pickCurrentSubscription(row.subscriptions);
  const usageByUser = new Map<string, number>();
  for (const entry of row.trafficLedgerEntries) {
    usageByUser.set(entry.userId, (usageByUser.get(entry.userId) ?? 0) + entry.usedTrafficGb);
  }

  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.ownerUserId,
    ownerDisplayName: row.owner.displayName,
    ownerEmail: row.owner.email,
    status: row.status,
    memberCount: row.members.length,
    currentSubscription: currentSubscription
      ? {
          id: currentSubscription.id,
          planId: currentSubscription.planId,
          planName: currentSubscription.plan.name,
          totalTrafficGb: currentSubscription.totalTrafficGb,
          usedTrafficGb: currentSubscription.usedTrafficGb,
          remainingTrafficGb: currentSubscription.remainingTrafficGb,
          expireAt: currentSubscription.expireAt.toISOString(),
          state: currentSubscription.state
        }
      : null,
    members: row.members.map((member) => toAdminTeamMemberRecord(member, usageByUser.get(member.userId) ?? 0)),
    usage: row.trafficLedgerEntries.map(toAdminTeamUsageRecord),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function createId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function buildLeaseEmail(userId: string, leaseId: string) {
  return `${userId}.${leaseId}@lease.chordv`;
}

function buildPanelClientEmail(userEmail: string, subscriptionId: string, nodeId: string, userId: string) {
  const sanitizedEmail = userEmail.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const sanitizedNode = nodeId.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const sanitizedSubscription = subscriptionId.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const sanitizedUser = userId.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return [sanitizedEmail || "user", sanitizedSubscription.slice(-8), sanitizedNode.slice(-8), sanitizedUser.slice(-8)].join("_");
}

function toNodeId(host: string, port: number) {
  return `node_${host.replaceAll(".", "_").replaceAll("-", "_")}_${port}`;
}

function normalizePanelApiBasePath(value: string | null | undefined) {
  const raw = value?.trim() || "/";
  if (raw === "/") {
    return "/";
  }
  return `/${raw.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

function normalizeTags(tags: string[] | undefined, name: string) {
  if (tags && tags.length > 0) {
    return tags.map((item) => item.trim()).filter(Boolean);
  }

  const lower = name.toLowerCase();
  if (lower.includes("hk") || lower.includes("香港")) return ["香港"];
  if (lower.includes("sg") || lower.includes("新加坡")) return ["新加坡"];
  if (lower.includes("jp") || lower.includes("日本")) return ["日本"];
  if (lower.includes("us") || lower.includes("美国")) return ["美国"];
  return ["导入"];
}

function inferRegion(name: string, host: string) {
  const value = `${name} ${host}`.toLowerCase();
  if (value.includes("hk") || value.includes("hong kong") || value.includes("香港")) return "香港";
  if (value.includes("sg") || value.includes("singapore") || value.includes("新加坡")) return "新加坡";
  if (value.includes("jp") || value.includes("japan") || value.includes("日本")) return "日本";
  if (value.includes("us") || value.includes("united states") || value.includes("america") || value.includes("美国")) return "美国";
  return "未分组";
}

function decodeSubscriptionText(raw: string) {
  if (raw.includes("vless://")) {
    return raw;
  }

  try {
    return Buffer.from(raw, "base64").toString("utf8");
  } catch {
    return raw;
  }
}

function parseVlessLink(link: string) {
  const parsed = new URL(link);
  const name = decodeURIComponent(parsed.hash.replace(/^#/, "")) || `${parsed.hostname}:${parsed.port}`;

  return {
    name,
    serverHost: parsed.hostname,
    serverPort: Number(parsed.port),
    uuid: decodeURIComponent(parsed.username),
    flow: parsed.searchParams.get("flow") || "xtls-rprx-vision",
    realityPublicKey: parsed.searchParams.get("pbk") || "",
    shortId: parsed.searchParams.get("sid") || "",
    serverName: parsed.searchParams.get("sni") || "",
    fingerprint: parsed.searchParams.get("fp") || "chrome",
    spiderX: decodeURIComponent(parsed.searchParams.get("spx") || "/")
  };
}

function pickCurrentSubscription<T extends { state: string; expireAt: Date }>(rows: T[]) {
  return rows.find((item) => item.state === "active")
    ?? rows.find((item) => item.state === "paused")
    ?? rows.sort((a, b) => b.expireAt.getTime() - a.expireAt.getTime())[0]
    ?? null;
}

function resolveRenewExpireAt(currentExpireAt: Date, explicitExpireAt?: string, extendDays?: number) {
  if (explicitExpireAt) {
    const date = new Date(explicitExpireAt);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException("到期时间无效");
    }
    return date;
  }

  if (!extendDays) {
    throw new BadRequestException("请设置新的到期时间，或填写顺延天数");
  }

  const base = currentExpireAt.getTime() > Date.now() ? currentExpireAt : new Date();
  const next = new Date(base);
  next.setDate(next.getDate() + extendDays);
  return next;
}

function resolveSubscriptionState(preferred: SubscriptionState, remainingTrafficGb: number, expireAt: Date) {
  if (preferred === "paused") return "paused" as const;
  if (preferred === "expired") return "expired" as const;
  if (preferred === "exhausted") return "exhausted" as const;
  if (expireAt.getTime() <= Date.now()) return "expired" as const;
  if (remainingTrafficGb <= 0) return "exhausted" as const;
  return "active" as const;
}

function isEffectiveSubscription(subscription: { state: SubscriptionState; expireAt: Date; remainingTrafficGb: number }) {
  if (subscription.state === "paused") return true;
  if (subscription.expireAt.getTime() <= Date.now()) return false;
  if (subscription.remainingTrafficGb <= 0) return false;
  return subscription.state === "active";
}

function assertSubscriptionConnectable(subscription: {
  state: SubscriptionState;
  remainingTrafficGb: number;
  expireAt: Date;
}) {
  if (subscription.state === "paused") {
    throw new ForbiddenException("当前订阅已暂停");
  }
  if (subscription.expireAt.getTime() <= Date.now() || subscription.state === "expired") {
    throw new ForbiddenException("当前订阅已到期");
  }
  if (subscription.remainingTrafficGb <= 0 || subscription.state === "exhausted") {
    throw new ForbiddenException("当前订阅流量已用尽");
  }
}

function createDispatcher(timeoutMs: number, allowInsecureTls: boolean) {
  return new Agent({
    connectTimeout: timeoutMs,
    connect: {
      rejectUnauthorized: !allowInsecureTls
    }
  });
}

async function probeNodeConnectivity(
  host: string,
  port: number,
  _serverName: string,
  _subscriptionUrl: string | null
): Promise<{ status: NodeProbeStatus; latencyMs: number | null; error: string | null }> {
  try {
    const latencyMs = await probeTcp(host, port);
    return {
      status: "healthy",
      latencyMs,
      error: null
    };
  } catch (error) {
    return {
      status: "offline",
      latencyMs: null,
      error: formatError(error)
    };
  }
}

function probeTcp(host: string, port: number) {
  return new Promise<number>((resolve, reject) => {
    const startedAt = Date.now();
    const socket = net.createConnection({ host, port });
    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    socket.setTimeout(5000);
    socket.once("connect", () => {
      const latency = Math.max(1, Date.now() - startedAt);
      cleanup();
      resolve(latency);
    });
    socket.once("timeout", () => {
      cleanup();
      reject(new Error("TCP 超时"));
    });
    socket.once("error", (error: Error) => {
      cleanup();
      reject(error);
    });
  });
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
