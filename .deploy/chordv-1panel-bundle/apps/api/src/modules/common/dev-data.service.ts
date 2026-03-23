import {
  BadGatewayException,
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
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as tls from "node:tls";
import { Cron } from "@nestjs/schedule";
import { Agent, fetch as undiciFetch } from "undici";
import {
  mockAnnouncements,
  mockAdminReleases,
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
  AdminReleaseArtifactDto,
  AdminReleaseArtifactValidationDto,
  AdminReleaseRecordDto,
  AdminSnapshotDto,
  AdminSubscriptionRecordDto,
  AdminTeamMemberRecordDto,
  AdminTeamRecordDto,
  AdminTeamUsageNodeSummaryDto,
  AdminTeamUsageRecordDto,
  AdminUserRecordDto,
  AnnouncementDto,
  AuthSessionDto,
  ChangeSubscriptionPlanInputDto,
  ClientBootstrapDto,
  ClientNodeProbeResultDto,
  ClientRuntimeEventDto,
  ClientTeamSummaryDto,
  ClientUpdateCheckDto,
  ClientUpdateCheckResultDto,
  ClientVersionDto,
  ConnectRequestDto,
  CreateAnnouncementInputDto,
  CreatePlanInputDto,
  CreateReleaseArtifactInputDto,
  CreateReleaseInputDto,
  CreateSubscriptionInputDto,
  CreateTeamInputDto,
  KickTeamMemberInputDto,
  KickTeamMemberResultDto,
  ResetSubscriptionTrafficInputDto,
  ResetSubscriptionTrafficResultDto,
  CreateTeamMemberInputDto,
  CreateTeamSubscriptionInputDto,
  CreateUserInputDto,
  GeneratedRuntimeConfigDto,
  ImportNodeInputDto,
  NodeProbeStatus,
  NodeSummaryDto,
  PlatformTarget,
  PolicyBundleDto,
  ReleaseArtifactType,
  ReleaseChannel,
  ReleaseStatus,
  RenewSubscriptionInputDto,
  SessionEvictedReason,
  SessionReasonCode,
  SubscriptionNodeAccessDto,
  SubscriptionSourceAction,
  SubscriptionState,
  SubscriptionStatusDto,
  TeamMemberRole,
  TeamStatus,
  UploadReleaseArtifactInputDto,
  UpdateDeliveryMode,
  UpdateAnnouncementInputDto,
  UpdateNodeInputDto,
  UpdatePlanInputDto,
  UpdatePlanSecurityInputDto,
  UpdatePolicyInputDto,
  UpdateReleaseArtifactInputDto,
  UpdateReleaseInputDto,
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
import { ClientRuntimeEventsService } from "./client-runtime-events.service";
import { MeteringIncidentService } from "./metering-incident.service";
import { PrismaService } from "./prisma.service";
import { EdgeGatewayService } from "../edge-gateway/edge-gateway.service";
import { XuiService } from "../xui/xui.service";

const LEASE_TTL_SECONDS = Number(process.env.CHORDV_SESSION_LEASE_TTL_SECONDS ?? 600);
const LEASE_HEARTBEAT_INTERVAL_SECONDS = Number(process.env.CHORDV_SESSION_HEARTBEAT_INTERVAL_SECONDS ?? 30);
const LEASE_GRACE_SECONDS = Number(process.env.CHORDV_SESSION_GRACE_SECONDS ?? 60);
const SECURITY_REASON_CONCURRENCY = "concurrency_limit";
const DEFAULT_MAX_CONCURRENT_SESSIONS = 3;
const BUILTIN_ADMIN_ID = "admin_001";
const BUILTIN_ADMIN_ACCOUNT = "admin";
const BUILTIN_ADMIN_PASSWORD = "woshichen123";
const RELEASE_ARTIFACT_DOWNLOAD_PREFIX = "/api/downloads/releases";

type PanelBindingFailure = {
  bindingId: string;
  nodeId: string;
  nodeName: string;
  panelClientEmail: string;
  error: string;
};

type UploadedReleaseFile = {
  path: string;
  originalname: string;
  size: number;
};

type PanelBindingMutationResult = {
  requested: number;
  updated: number;
  failed: PanelBindingFailure[];
};

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
    private readonly clientRuntimeEventsService: ClientRuntimeEventsService,
    private readonly edgeGatewayService: EdgeGatewayService,
    private readonly xuiService: XuiService
  ) {}

  async onModuleInit() {
    await this.seedIfEmpty();
    await this.ensureReleaseCenterSeeded();
    await this.migrateLegacyDefaultConcurrentSessions();
    await this.ensureBuiltinAdminAccount();
    await this.backfillTrafficLedgerNodeIds();
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

  async streamRuntimeEvents(token?: string) {
    const user = await this.resolveActiveUserFromToken(token);
    return this.clientRuntimeEventsService.streamForUser(user.id);
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

  async probeClientNodes(nodeIds: string[], token?: string): Promise<ClientNodeProbeResultDto[]> {
    const user = await this.resolveActiveUserFromToken(token);
    const access = await this.resolveSubscriptionAccessForUser(user.id);
    if (!access.subscription) {
      return [];
    }

    const requestedNodeIds = Array.from(new Set(nodeIds.filter((item) => typeof item === "string" && item.trim().length > 0)));
    if (requestedNodeIds.length === 0) {
      return [];
    }

    const rows = await this.prisma.subscriptionNodeAccess.findMany({
      where: {
        subscriptionId: access.subscription.id,
        nodeId: { in: requestedNodeIds }
      },
      include: { node: true }
    });

    const rowMap = new Map(rows.map((row) => [row.nodeId, row.node]));
    const results = await Promise.all(
      requestedNodeIds.map(async (nodeId) => {
        const node = rowMap.get(nodeId);
        if (!node) {
          return {
            nodeId,
            status: "offline" as const,
            latencyMs: null,
            checkedAt: new Date().toISOString(),
            error: "当前订阅未开通该节点"
          };
        }

        const probe = await probeNodeConnectivity(node.serverHost, node.serverPort, node.serverName, node.subscriptionUrl);
        return {
          nodeId,
          status: probe.status === "healthy" ? "healthy" as const : "offline" as const,
          latencyMs: probe.latencyMs,
          checkedAt: new Date().toISOString(),
          error: probe.error
        };
      })
    );

    return results;
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
    const latestRelease = await this.findLatestPublishedRelease("beta");
    if (!latestRelease) {
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

    const primaryArtifact = pickPrimaryReleaseArtifact(latestRelease.artifacts);

    return {
      currentVersion: latestRelease.version,
      minimumVersion: latestRelease.minimumVersion,
      forceUpgrade: latestRelease.forceUpgrade,
      changelog: latestRelease.changelog,
      downloadUrl: primaryArtifact?.downloadUrl ?? null
    };
  }

  private async findLatestPublishedRelease(channel: ReleaseChannel, platform?: ClientUpdateCheckDto["platform"]) {
    const rows = await this.prisma.release.findMany({
      where: {
        channel,
        status: "published",
        ...(platform ? { platform } : {})
      },
      include: {
        artifacts: {
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
        }
      }
    });

    if (rows.length === 0) {
      return null;
    }

    return rows.sort((left, right) => {
      const versionDiff = compareSemver(right.version, left.version);
      if (versionDiff !== 0) {
        return versionDiff;
      }
      return (right.publishedAt?.getTime() ?? 0) - (left.publishedAt?.getTime() ?? 0);
    })[0];
  }

  async checkClientUpdate(input: ClientUpdateCheckDto): Promise<ClientUpdateCheckResultDto> {
    const release = await this.findLatestPublishedRelease(input.channel, input.platform);
    if (!release) {
      return {
        hasUpdate: false,
        forceUpgrade: false,
        blockedByMinimumVersion: false,
        forcedByRelease: false,
        updateRequirement: "optional",
        currentVersion: input.currentVersion,
        latestVersion: input.currentVersion,
        minimumVersion: input.currentVersion,
        platform: input.platform,
        channel: input.channel,
        changelog: [],
        releaseNotes: null,
        deliveryMode: "none",
        recommendedArtifact: null,
        downloadUrl: null,
        fileName: null,
        fileSizeBytes: null,
        fileHash: null,
        publishedAt: null
      };
    }

    const recommendedArtifact = pickPrimaryReleaseArtifact(release.artifacts, input.artifactType);
    const mustUpgrade = compareSemver(input.currentVersion, release.minimumVersion) < 0;
    const forcedByRelease = release.forceUpgrade;

    return {
      hasUpdate: compareSemver(release.version, input.currentVersion) > 0,
      forceUpgrade: mustUpgrade || forcedByRelease,
      blockedByMinimumVersion: mustUpgrade,
      forcedByRelease,
      updateRequirement: mustUpgrade ? "required_minimum" : forcedByRelease ? "required_release" : "optional",
      currentVersion: input.currentVersion,
      latestVersion: release.version,
      minimumVersion: release.minimumVersion,
      platform: input.platform,
      channel: input.channel,
      changelog: release.changelog,
      releaseNotes: release.releaseNotes,
      deliveryMode: (recommendedArtifact?.deliveryMode as UpdateDeliveryMode | undefined) ?? defaultDeliveryModeForPlatform(input.platform),
      recommendedArtifact: recommendedArtifact ? toAdminReleaseArtifactRecord(recommendedArtifact) : null,
      downloadUrl: recommendedArtifact?.downloadUrl ?? null,
      fileName: recommendedArtifact?.fileName ?? null,
      fileSizeBytes: recommendedArtifact?.fileSizeBytes?.toString() ?? null,
      fileHash: recommendedArtifact?.fileHash ?? null,
      publishedAt: release.publishedAt?.toISOString() ?? null
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
      throw new NotFoundException("当前连接已失效，请重新连接");
    }
    if (lease.status !== "active") {
      throw new ForbiddenException(getLeaseFailureDetails(lease.status, lease.revokedReason).reasonMessage);
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

    await this.assertLeaseCanHeartbeat(lease, user.id);

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

  async getActiveRuntime(token?: string) {
    const runtime = this.activeRuntime;
    const usageContext = this.activeRuntimeUsageContext;
    if (!runtime || !usageContext) {
      return null;
    }

    const user = await this.resolveActiveUserFromToken(token);
    if (usageContext.userId !== user.id) {
      return null;
    }

    const activeLease = await this.prisma.nodeSessionLease.findUnique({
      where: { sessionId: runtime.sessionId },
      select: {
        userId: true,
        status: true
      }
    });
    if (!activeLease || activeLease.userId !== user.id || activeLease.status !== "active") {
      return null;
    }

    return runtime;
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
      },
      orderBy: { createdAt: "desc" }
    });

    const panelClientEmail =
      existing?.panelClientEmail ??
      buildPanelClientEmail(input.userEmail, input.subscriptionId, input.node.id, input.userId);
    const panelClientId = existing?.status === "deleted" ? randomUUID() : existing?.panelClientId ?? randomUUID();
    const panelInboundId = input.node.panelInboundId ?? existing?.panelInboundId ?? null;
    const nodeConfig = {
      id: input.node.id,
      panelBaseUrl: input.node.panelBaseUrl,
      panelApiBasePath: input.node.panelApiBasePath,
      panelUsername: input.node.panelUsername,
      panelPassword: input.node.panelPassword,
      panelInboundId
    };

    const ensured = await this.xuiService.ensureClient(
      nodeConfig,
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
          panelClientId,
          panelInboundId: resolvedPanelInboundId ?? existing.panelInboundId,
          status: "active",
          lastUplinkBytes: baseline.uplinkBytes,
          lastDownlinkBytes: baseline.downlinkBytes,
          lastSyncedAt: baseline.sampledAt
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
        panelClientId,
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

  private async disablePanelBindingsForSubscription(subscriptionId: string, filter?: { userId?: string; nodeIds?: string[] }) {
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
    } satisfies PanelBindingMutationResult;
  }

  private async removePanelBindingsForSubscription(subscriptionId: string, filter?: { userId?: string; nodeIds?: string[] }) {
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
    } satisfies PanelBindingMutationResult;
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

  private assertPanelBindingMutation(action: string, result: PanelBindingMutationResult) {
    if (result.failed.length === 0) {
      return;
    }

    const detail = result.failed
      .map((item) => `${item.nodeName} / ${item.panelClientEmail}: ${item.error}`)
      .join("；");
    throw new BadGatewayException(`${action}。以下节点未完成同步：${detail}`);
  }

  private async syncSubscriptionPanelAccess(subscriptionId: string) {
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
        ? new Set(
            subscription.team.members
              .filter((item) => item.user.status === "active")
              .map((item) => item.userId)
          )
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
    }
  }

  private async revokeUserLeases(
    userId: string,
    reason: string,
    filter?: { subscriptionId?: string; nodeIds?: string[] }
  ) {
    const activeLeases = await this.prisma.nodeSessionLease.findMany({
      where: {
        userId,
        status: "active",
        expiresAt: { gt: new Date() },
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

  private async revokeSubscriptionLeases(
    subscriptionId: string,
    reason: string,
    filter?: { userId?: string; nodeIds?: string[] }
  ) {
    const activeLeases = await this.prisma.nodeSessionLease.findMany({
      where: {
        subscriptionId,
        status: "active",
        expiresAt: { gt: new Date() },
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
      if (!membership || membership.teamId !== ensuredSubscription.teamId) {
        await revokeAndThrow("当前成员已失去团队访问权限，会话已失效", "team_membership_missing");
      }
      const ensuredMembership = membership as NonNullable<typeof membership>;
      if (ensuredMembership.team.status !== "active") {
        await revokeAndThrow("当前团队已停用，会话已失效", "team_disabled");
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
      }
      const ensuredBinding = binding as NonNullable<typeof binding>;

      if (ensuredBinding.panelClientEmail !== lease.xrayUserEmail || ensuredBinding.panelClientId !== lease.xrayUserUuid) {
        await revokeAndThrow("当前节点客户端凭据已更新，会话已失效", "panel_client_rotated");
      }
    }
  }

  private async syncActiveLeasesForSubscription(subscription: {
    id: string;
    state: SubscriptionState;
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
    const details = getLeaseFailureDetails(reason === SECURITY_REASON_CONCURRENCY ? "evicted" : "revoked", reason);
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
    const [users, plans, subscriptions, teams, nodes, announcements, policy, releases] = await Promise.all([
      this.listAdminUsers(),
      this.listAdminPlans(),
      this.listAdminSubscriptions(),
      this.listAdminTeams(),
      this.listAdminNodes(),
      this.listAdminAnnouncements(),
      this.getAdminPolicy(),
      this.listAdminReleases()
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
      policy,
      releases
    };
  }

  async listAdminReleases(): Promise<AdminReleaseRecordDto[]> {
    const rows = await this.prisma.release.findMany({
      include: {
        artifacts: {
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
        }
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }]
    });
    return rows.map(toAdminReleaseRecord);
  }

  async createRelease(input: CreateReleaseInputDto): Promise<AdminReleaseRecordDto> {
    const created = await this.prisma.release.create({
      data: {
        id: createId("release"),
        platform: input.platform,
        channel: input.channel,
        version: normalizeVersion(input.version),
        displayTitle: input.displayTitle.trim(),
        releaseNotes: normalizeNullableText(input.releaseNotes),
        changelog: normalizeChangelog(input.changelog),
        minimumVersion: normalizeVersion(input.minimumVersion),
        forceUpgrade: input.forceUpgrade ?? false,
        status: input.status ?? "draft",
        publishedAt: normalizePublishedAt(input.status ?? "draft", input.publishedAt)
      },
      include: {
        artifacts: true
      }
    });
    return toAdminReleaseRecord(created);
  }

  async updateRelease(releaseId: string, input: UpdateReleaseInputDto): Promise<AdminReleaseRecordDto> {
    await this.ensureReleaseExists(releaseId);
    const updated = await this.prisma.release.update({
      where: { id: releaseId },
      data: {
        ...(input.displayTitle !== undefined ? { displayTitle: input.displayTitle.trim() } : {}),
        ...(input.releaseNotes !== undefined ? { releaseNotes: normalizeNullableText(input.releaseNotes) } : {}),
        ...(input.changelog !== undefined ? { changelog: normalizeChangelog(input.changelog) } : {}),
        ...(input.minimumVersion !== undefined ? { minimumVersion: normalizeVersion(input.minimumVersion) } : {}),
        ...(input.forceUpgrade !== undefined ? { forceUpgrade: input.forceUpgrade } : {}),
        ...(input.status !== undefined
          ? {
              status: input.status,
              publishedAt: normalizePublishedAt(input.status, input.publishedAt)
            }
          : {}),
        ...(input.status === undefined && input.publishedAt !== undefined
          ? { publishedAt: input.publishedAt ? new Date(input.publishedAt) : null }
          : {})
      },
      include: {
        artifacts: {
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
        }
      }
    });
    return toAdminReleaseRecord(updated);
  }

  async publishRelease(releaseId: string): Promise<AdminReleaseRecordDto> {
    const release = await this.prisma.release.findUnique({
      where: { id: releaseId },
      include: {
        artifacts: {
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
        }
      }
    });
    if (!release) {
      throw new NotFoundException("发布记录不存在");
    }
    const primaryArtifact = release.artifacts.find((item) => item.isPrimary) ?? release.artifacts[0];
    if (!primaryArtifact) {
      throw new BadRequestException("请先上传或配置至少一个安装产物，再发布版本");
    }
    const validation = await this.validateReleaseArtifact(releaseId, primaryArtifact.id);
    if (validation.status !== "ready") {
      throw new BadRequestException(`主下载产物当前不可发布：${validation.message}`);
    }
    const updated = await this.prisma.release.update({
      where: { id: releaseId },
      data: {
        status: "published",
        publishedAt: new Date()
      },
      include: {
        artifacts: {
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
        }
      }
    });
    return toAdminReleaseRecord(updated);
  }

  async archiveRelease(releaseId: string): Promise<AdminReleaseRecordDto> {
    await this.ensureReleaseExists(releaseId);
    const updated = await this.prisma.release.update({
      where: { id: releaseId },
      data: {
        status: "archived"
      },
      include: {
        artifacts: {
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
        }
      }
    });
    return toAdminReleaseRecord(updated);
  }

  async createReleaseArtifact(releaseId: string, input: CreateReleaseArtifactInputDto): Promise<AdminReleaseRecordDto> {
    const release = await this.ensureReleaseExists(releaseId);
    assertReleaseArtifactTypeAllowed(release.platform as PlatformTarget, input.type);
    const artifactId = createId("artifact");
    const isPrimary = normalizeOptionalBoolean(input.isPrimary);
    const isFullPackage = normalizeOptionalBoolean(input.isFullPackage);
    await this.prisma.$transaction(async (tx) => {
      if (isPrimary) {
        await tx.releaseArtifact.updateMany({
          where: { releaseId },
          data: { isPrimary: false }
        });
      }
      await tx.releaseArtifact.create({
        data: {
          id: artifactId,
          releaseId,
          source: input.source ?? "external",
          type: toPrismaReleaseArtifactType(input.type),
          deliveryMode: input.deliveryMode ?? defaultDeliveryModeForArtifact(input.type),
          downloadUrl: input.downloadUrl.trim(),
          fileName: normalizeNullableText(input.fileName),
          storedFilePath: null,
          fileSizeBytes: normalizeBigInt(input.fileSizeBytes),
          fileHash: normalizeNullableText(input.fileHash),
          isPrimary: isPrimary ?? false,
          isFullPackage: isFullPackage ?? true
        }
      });
    });
    return this.getAdminRelease(releaseId);
  }

  async updateReleaseArtifact(
    releaseId: string,
    artifactId: string,
    input: UpdateReleaseArtifactInputDto
  ): Promise<AdminReleaseRecordDto> {
    const current = await this.prisma.releaseArtifact.findFirst({
      where: { id: artifactId, releaseId }
    });
    if (!current) {
      throw new NotFoundException("发布产物不存在");
    }
    const release = await this.ensureReleaseExists(releaseId);
    if (input.type !== undefined) {
      assertReleaseArtifactTypeAllowed(release.platform as PlatformTarget, input.type);
    }
    const isPrimary = normalizeOptionalBoolean(input.isPrimary);
    const isFullPackage = normalizeOptionalBoolean(input.isFullPackage);
    await this.prisma.$transaction(async (tx) => {
      if (isPrimary) {
        await tx.releaseArtifact.updateMany({
          where: { releaseId },
          data: { isPrimary: false }
        });
      }
      await tx.releaseArtifact.update({
        where: { id: artifactId },
        data: {
          ...(input.source !== undefined ? { source: input.source } : {}),
          ...(input.type !== undefined ? { type: toPrismaReleaseArtifactType(input.type) } : {}),
          ...(input.deliveryMode !== undefined ? { deliveryMode: input.deliveryMode } : {}),
          ...(input.downloadUrl !== undefined ? { downloadUrl: input.downloadUrl.trim() } : {}),
          ...(input.fileName !== undefined ? { fileName: normalizeNullableText(input.fileName) } : {}),
          ...(input.fileSizeBytes !== undefined ? { fileSizeBytes: normalizeBigInt(input.fileSizeBytes) } : {}),
          ...(input.fileHash !== undefined ? { fileHash: normalizeNullableText(input.fileHash) } : {}),
          ...(isPrimary !== undefined ? { isPrimary } : {}),
          ...(isFullPackage !== undefined ? { isFullPackage } : {}),
          ...(input.source === "external" ? { storedFilePath: null } : {})
        }
      });
    });
    if (current.storedFilePath && input.source === "external") {
      await removeReleaseArtifactFile(resolveReleaseArtifactAbsolutePath(current.storedFilePath));
    }
    return this.getAdminRelease(releaseId);
  }

  async uploadReleaseArtifact(
    releaseId: string,
    input: UploadReleaseArtifactInputDto,
    file?: UploadedReleaseFile
  ): Promise<AdminReleaseRecordDto> {
    const release = await this.ensureReleaseExists(releaseId);
    assertReleaseArtifactTypeAllowed(release.platform as PlatformTarget, input.type);
    if (!file) {
      throw new BadRequestException("请先选择要上传的安装包文件");
    }
    const isPrimary = normalizeOptionalBoolean(input.isPrimary);
    const isFullPackage = normalizeOptionalBoolean(input.isFullPackage);

    const artifactId = createId("artifact");
    const prepared = await this.prepareUploadedReleaseArtifactFile(releaseId, artifactId, file, input.fileName);

    try {
      await this.prisma.$transaction(async (tx) => {
        if (isPrimary) {
          await tx.releaseArtifact.updateMany({
            where: { releaseId },
            data: { isPrimary: false }
          });
        }
        await tx.releaseArtifact.create({
          data: {
            id: artifactId,
            releaseId,
            source: "uploaded",
            type: toPrismaReleaseArtifactType(input.type),
            deliveryMode: input.deliveryMode ?? defaultDeliveryModeForArtifact(input.type),
            downloadUrl: prepared.downloadUrl,
            fileName: prepared.fileName,
            storedFilePath: prepared.storedFilePath,
            fileSizeBytes: prepared.fileSizeBytes,
            fileHash: prepared.fileHash,
            isPrimary: isPrimary ?? false,
            isFullPackage: isFullPackage ?? true
          }
        });
      });
    } catch (error) {
      await removeReleaseArtifactFile(prepared.absolutePath);
      throw error;
    }

    return this.getAdminRelease(releaseId);
  }

  async replaceReleaseArtifactUpload(
    releaseId: string,
    artifactId: string,
    input: UploadReleaseArtifactInputDto,
    file?: UploadedReleaseFile
  ): Promise<AdminReleaseRecordDto> {
    if (!file) {
      throw new BadRequestException("请先选择要上传的安装包文件");
    }
    const current = await this.prisma.releaseArtifact.findFirst({
      where: { id: artifactId, releaseId }
    });
    if (!current) {
      throw new NotFoundException("发布产物不存在");
    }
    const release = await this.ensureReleaseExists(releaseId);
    assertReleaseArtifactTypeAllowed(release.platform as PlatformTarget, input.type);

    const previousStoredFilePath = current.storedFilePath;
    const isPrimary = normalizeOptionalBoolean(input.isPrimary);
    const isFullPackage = normalizeOptionalBoolean(input.isFullPackage);
    const prepared = await this.prepareUploadedReleaseArtifactFile(releaseId, artifactId, file, input.fileName);

    try {
      await this.prisma.$transaction(async (tx) => {
        if (isPrimary) {
          await tx.releaseArtifact.updateMany({
            where: { releaseId },
            data: { isPrimary: false }
          });
        }
        await tx.releaseArtifact.update({
          where: { id: artifactId },
          data: {
            source: "uploaded",
            type: toPrismaReleaseArtifactType(input.type),
            deliveryMode: input.deliveryMode ?? defaultDeliveryModeForArtifact(input.type),
            downloadUrl: prepared.downloadUrl,
            fileName: prepared.fileName,
            storedFilePath: prepared.storedFilePath,
            fileSizeBytes: prepared.fileSizeBytes,
            fileHash: prepared.fileHash,
            isPrimary: isPrimary ?? current.isPrimary,
            isFullPackage: isFullPackage ?? current.isFullPackage
          }
        });
      });
    } catch (error) {
      await removeReleaseArtifactFile(prepared.absolutePath);
      throw error;
    }

    if (previousStoredFilePath && previousStoredFilePath !== prepared.storedFilePath) {
      await removeReleaseArtifactFile(resolveReleaseArtifactAbsolutePath(previousStoredFilePath));
    }

    return this.getAdminRelease(releaseId);
  }

  async deleteReleaseArtifact(releaseId: string, artifactId: string): Promise<AdminReleaseRecordDto> {
    const artifact = await this.prisma.releaseArtifact.findFirst({
      where: { id: artifactId, releaseId }
    });
    if (!artifact) {
      throw new NotFoundException("发布产物不存在");
    }
    await this.prisma.releaseArtifact.delete({
      where: { id: artifactId }
    });
    if (artifact.storedFilePath) {
      await removeReleaseArtifactFile(resolveReleaseArtifactAbsolutePath(artifact.storedFilePath));
    }
    return this.getAdminRelease(releaseId);
  }

  async validateReleaseArtifact(releaseId: string, artifactId: string): Promise<AdminReleaseArtifactValidationDto> {
    const artifact = await this.prisma.releaseArtifact.findFirst({
      where: { id: artifactId, releaseId }
    });
    if (!artifact) {
      throw new NotFoundException("发布产物不存在");
    }

    if (artifact.source === "external") {
      const url = artifact.downloadUrl.trim();
      if (!url || !/^https?:\/\//i.test(url)) {
        return {
          artifactId,
          status: "missing_download_url",
          message: "外部下载地址为空或格式不正确，请填写完整的 http/https 地址。"
        };
      }
      return {
        artifactId,
        status: "ready",
        message: "外部下载地址已配置。"
      };
    }

    if (!artifact.storedFilePath) {
      return {
        artifactId,
        status: "missing_file",
        message: "上传文件记录不完整，请重新上传安装包。"
      };
    }

    const absolutePath = resolveReleaseArtifactAbsolutePath(artifact.storedFilePath);
    try {
      await fs.access(absolutePath);
    } catch {
      return {
        artifactId,
        status: "missing_file",
        message: "服务器上的安装包文件已丢失，请重新上传。"
      };
    }

    const stat = await fs.stat(absolutePath);
    const actualFileHash = await calculateFileSha256(absolutePath);
    const actualFileSizeBytes = stat.size.toString();
    const hashMatches = !artifact.fileHash || artifact.fileHash === actualFileHash;
    const sizeMatches = !artifact.fileSizeBytes || artifact.fileSizeBytes.toString() === actualFileSizeBytes;

    if (!hashMatches || !sizeMatches) {
      return {
        artifactId,
        status: "metadata_mismatch",
        message: "服务器文件存在，但记录里的大小或 Hash 与真实文件不一致，建议重新上传覆盖。",
        actualFileSizeBytes,
        actualFileHash
      };
    }

    return {
      artifactId,
      status: "ready",
      message: "服务器文件可用，下载地址和文件元信息已匹配。",
      actualFileSizeBytes,
      actualFileHash
    };
  }

  async getReleaseArtifactDownloadDescriptor(artifactId: string) {
    const artifact = await this.prisma.releaseArtifact.findUnique({
      where: { id: artifactId }
    });
    if (!artifact || artifact.source !== "uploaded" || !artifact.storedFilePath) {
      throw new NotFoundException("安装包不存在");
    }
    const absolutePath = resolveReleaseArtifactAbsolutePath(artifact.storedFilePath);
    await ensureFileReadable(absolutePath);
    return {
      absolutePath,
      fileName: artifact.fileName ?? path.basename(absolutePath)
    };
  }

  private async prepareUploadedReleaseArtifactFile(
    releaseId: string,
    artifactId: string,
    file: UploadedReleaseFile,
    preferredFileName?: string | null
  ) {
    const finalFileName = sanitizeReleaseArtifactFileName(preferredFileName?.trim() || file.originalname || `${artifactId}.bin`);
    const storedFilePath = path.join(releaseId, artifactId, finalFileName);
    const absolutePath = resolveReleaseArtifactAbsolutePath(storedFilePath);

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.rm(absolutePath, { force: true });
    await fs.rename(file.path, absolutePath);

    return {
      absolutePath,
      storedFilePath,
      fileName: finalFileName,
      fileSizeBytes: BigInt(file.size),
      fileHash: await calculateFileSha256(absolutePath),
      downloadUrl: buildReleaseArtifactDownloadUrl(artifactId)
    };
  }

  private async getAdminRelease(releaseId: string): Promise<AdminReleaseRecordDto> {
    const row = await this.prisma.release.findUnique({
      where: { id: releaseId },
      include: {
        artifacts: {
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }]
        }
      }
    });
    if (!row) {
      throw new NotFoundException("发布记录不存在");
    }
    return toAdminReleaseRecord(row);
  }

  private async ensureReleaseExists(releaseId: string) {
    const row = await this.prisma.release.findUnique({
      where: { id: releaseId },
      select: { id: true, platform: true }
    });
    if (!row) {
      throw new NotFoundException("发布记录不存在");
    }
    return row;
  }

  private async ensureReleaseArtifactExists(releaseId: string, artifactId: string) {
    const row = await this.prisma.releaseArtifact.findFirst({
      where: {
        id: artifactId,
        releaseId
      },
      select: { id: true }
    });
    if (!row) {
      throw new NotFoundException("发布产物不存在");
    }
    return row;
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
          await this.revokeUserLeases(userId, "user_disabled", { subscriptionId: personalSubscription.id });
          const removeResult = await this.removePanelBindingsForSubscription(personalSubscription.id, { userId });
          this.assertPanelBindingMutation("删除 3x-ui 客户端失败", removeResult);
        } else if (input.status === "active") {
          await this.syncSubscriptionPanelAccess(personalSubscription.id);
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
          await this.revokeUserLeases(userId, "user_disabled", { subscriptionId: teamSubscription.id });
          const removeResult = await this.removePanelBindingsForSubscription(teamSubscription.id, { userId });
          this.assertPanelBindingMutation("删除 3x-ui 客户端失败", removeResult);
        } else if (input.status === "active") {
          await this.syncSubscriptionPanelAccess(teamSubscription.id);
        }
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
        await this.xuiService.resetClientTraffic(nodeConfig, binding.panelClientEmail);
        const baseline = await this.readPanelClientBaseline(nodeConfig, binding.panelClientEmail);
        return {
          binding,
          uplinkBytes: baseline.uplinkBytes,
          downlinkBytes: baseline.downlinkBytes,
          sampledAt: baseline.sampledAt.toISOString()
        };
      })
    );
    const expireAt = new Date(subscription.expireAt);

    await this.prisma.$transaction(async (tx) => {
      for (const item of baselineSamples) {
        const sampledAt = item.sampledAt ? new Date(item.sampledAt) : new Date();
        const totalBytes = item.uplinkBytes + item.downlinkBytes;
        const snapshotKey = buildSnapshotKey(item.binding.nodeId, item.binding.subscriptionId, item.binding.userId);
        await tx.trafficSnapshot.upsert({
          where: { snapshotKey },
          update: {
            uplinkBytes: item.uplinkBytes,
            downlinkBytes: item.downlinkBytes,
            totalBytes,
            sampledAt
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
            sampledAt
          }
        });

        await tx.panelClientBinding.update({
          where: { id: item.binding.id },
          data: {
            lastUplinkBytes: item.uplinkBytes,
            lastDownlinkBytes: item.downlinkBytes,
            lastSyncedAt: sampledAt
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
            state: resolveSubscriptionState(subscription.state === "paused" ? "paused" : "active", remainingTrafficGb, expireAt),
            lastSyncedAt: new Date()
          }
        });
      } else {
        await tx.subscription.update({
          where: { id: subscription.id },
          data: {
            usedTrafficGb: 0,
            remainingTrafficGb: subscription.totalTrafficGb,
            state: resolveSubscriptionState(subscription.state === "paused" ? "paused" : "active", subscription.totalTrafficGb, expireAt),
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
    const user = targetUserId ? await this.requireAdminUserRecord(targetUserId) : null;
    return {
      ok: true,
      subscriptionId: subscription.id,
      userId: targetUserId,
      clearedBindingCount: bindings.length,
      message:
        bindings.length > 0
          ? "已重置订阅流量，并同步清空 3x-ui 面板计量"
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

    await this.syncSubscriptionPanelAccess(row.id);

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

    await this.syncSubscriptionPanelAccess(subscriptionId);
    await this.syncActiveLeasesForSubscription(row);

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

    await this.syncSubscriptionPanelAccess(subscriptionId);
    await this.syncActiveLeasesForSubscription(row);

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

    await this.syncSubscriptionPanelAccess(subscriptionId);
    await this.syncActiveLeasesForSubscription(row);

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
      await this.revokeSubscriptionLeases(subscription.id, "team_member_removed", {
        userId: member.userId
      });
      const removeResult = await this.removePanelBindingsForSubscription(subscription.id, { userId: member.userId });
      this.assertPanelBindingMutation("删除 3x-ui 客户端失败", removeResult);
    }

    await this.prisma.teamMember.delete({
      where: { id: memberId }
    });

    return { ok: true };
  }

  async kickTeamMember(teamId: string, memberId: string, input: KickTeamMemberInputDto): Promise<KickTeamMemberResultDto> {
    const member = await this.requireTeamMember(memberId);
    if (member.teamId !== teamId) {
      throw new BadRequestException("团队成员不属于当前团队");
    }

    let disconnectedSessionCount = 0;
    const subscription = await this.findCurrentTeamSubscription(teamId);
    if (subscription) {
      const disableResult = await this.disablePanelBindingsForSubscription(subscription.id, { userId: member.userId });
      disconnectedSessionCount = await this.revokeSubscriptionLeases(subscription.id, "team_member_disconnected", {
        userId: member.userId
      });
      this.assertPanelBindingMutation(
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

    const uniqueNodeIds = [...new Set(input.nodeIds)];
    const existingRows = await this.prisma.subscriptionNodeAccess.findMany({
      where: { subscriptionId },
      select: { id: true, nodeId: true }
    });
    const existingNodeIds = new Set(existingRows.map((item) => item.nodeId));
    let revokedSessionCount = 0;
    let reasonCode: SessionReasonCode | null = null;
    let reasonMessage: string | null = null;
    let message: string | null = null;

    if (uniqueNodeIds.length === 0) {
      if (existingRows.length > 0) {
        const disableResult = await this.disablePanelBindingsForSubscription(subscriptionId);
        this.assertPanelBindingMutation("禁用 3x-ui 客户端失败，节点授权未清空", disableResult);
        await this.prisma.subscriptionNodeAccess.deleteMany({
          where: { subscriptionId }
        });
        revokedSessionCount = await this.revokeSubscriptionLeases(subscriptionId, "node_access_revoked");
        reasonCode = "node_access_revoked";
        reasonMessage = "当前订阅的节点授权已全部取消，现有连接会立即失效。";
        message =
          revokedSessionCount > 0
            ? `节点授权已清空，已断开 ${revokedSessionCount} 条现有连接。`
            : "节点授权已清空，当前没有活跃连接。";
      }

      await this.syncSubscriptionPanelAccess(subscriptionId);
      return {
        subscriptionId,
        nodeIds: [],
        nodes: [],
        revokedSessionCount,
        reasonCode,
        reasonMessage,
        message
      };
    }

    const availableNodes = await this.prisma.node.findMany({
      where: { id: { in: uniqueNodeIds } }
    });

    if (availableNodes.length !== uniqueNodeIds.length) {
      throw new BadRequestException("存在无效节点");
    }

    const removedNodeIds = existingRows
      .filter((item) => !uniqueNodeIds.includes(item.nodeId))
      .map((item) => item.nodeId);
    const addedNodeIds = uniqueNodeIds.filter((nodeId) => !existingNodeIds.has(nodeId));

    if (removedNodeIds.length > 0) {
      const disableResult = await this.disablePanelBindingsForSubscription(subscriptionId, { nodeIds: removedNodeIds });
      this.assertPanelBindingMutation("禁用 3x-ui 客户端失败，节点授权未保存", disableResult);
      await this.prisma.subscriptionNodeAccess.deleteMany({
        where: {
          subscriptionId,
          nodeId: { in: removedNodeIds }
        }
      });
      revokedSessionCount = await this.revokeSubscriptionLeases(subscriptionId, "node_access_revoked", { nodeIds: removedNodeIds });
      reasonCode = "node_access_revoked";
      reasonMessage = "已取消部分节点授权，正在使用这些节点的连接会立即失效。";
      message =
        revokedSessionCount > 0
          ? `节点授权已保存，已断开 ${revokedSessionCount} 条受影响连接。`
          : "节点授权已保存。";
    }

    if (addedNodeIds.length > 0) {
      await this.prisma.subscriptionNodeAccess.createMany({
        data: addedNodeIds.map((nodeId) => ({
          id: createId("subscription_node"),
          subscriptionId,
          nodeId
        }))
      });
    }

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
      nodes: deduped.map((item) => toNodeSummary(item.node)),
      revokedSessionCount,
      reasonCode,
      reasonMessage,
      message: message ?? "节点授权已保存。"
    };
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

  async listAdminNodes(): Promise<AdminNodeRecordDto[]> {
    const rows = await this.prisma.node.findMany({
      orderBy: [{ recommended: "desc" }, { latencyMs: "asc" }, { createdAt: "desc" }]
    });
    return rows.map(toAdminNodeRecord);
  }

  async importNodeFromSubscription(input: ImportNodeInputDto): Promise<AdminNodeRecordDto> {
    const panelBaseUrl = input.panelBaseUrl?.trim() || null;
    const panelApiBasePath = normalizePanelApiBasePath(input.panelApiBasePath);
    const panelUsername = input.panelUsername?.trim() || null;
    const panelPassword = input.panelPassword?.trim() || null;
    const panelEnabled = await this.resolveNodePanelEnabled({
      inputValue: input.panelEnabled,
      currentValue: null,
      panelBaseUrl,
      panelUsername,
      panelPassword,
      applyXuiDefault: true
    });
    const imported = await this.resolveNodeRuntimeSource(input, panelEnabled);
    const nodeId = toNodeId(imported.serverHost, imported.serverPort);
    const current = await this.prisma.node.findUnique({ where: { id: nodeId } });
    const nextPanelBaseUrl = panelBaseUrl ?? current?.panelBaseUrl ?? null;
    const nextPanelApiBasePath = normalizePanelApiBasePath(input.panelApiBasePath ?? current?.panelApiBasePath ?? "/");
    const nextPanelUsername = panelUsername ?? current?.panelUsername ?? null;
    const nextPanelPassword = panelPassword ?? current?.panelPassword ?? null;
    const resolvedInboundId = readRuntimeInboundId(imported);
    const nextPanelInboundId = input.panelInboundId ?? current?.panelInboundId ?? resolvedInboundId ?? null;
    const nextPanelEnabled = await this.resolveNodePanelEnabled({
      inputValue: input.panelEnabled,
      currentValue: current?.panelEnabled ?? null,
      panelBaseUrl: nextPanelBaseUrl,
      panelUsername: nextPanelUsername,
      panelPassword: nextPanelPassword,
      applyXuiDefault: true
    });

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
        panelBaseUrl: nextPanelBaseUrl,
        panelApiBasePath: nextPanelApiBasePath,
        panelUsername: nextPanelUsername,
        panelPassword: nextPanelPassword,
        panelInboundId: nextPanelInboundId,
        panelEnabled: nextPanelEnabled,
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
        panelBaseUrl: nextPanelBaseUrl,
        panelApiBasePath: nextPanelApiBasePath,
        panelUsername: nextPanelUsername,
        panelPassword: nextPanelPassword,
        panelInboundId: nextPanelInboundId,
        panelEnabled: nextPanelEnabled
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
    }, {
      forceRelogin: true,
      strictCredentialCheck: true
    });

    return inbounds;
  }

  async updateNode(nodeId: string, input: UpdateNodeInputDto): Promise<AdminNodeRecordDto> {
    const current = await this.prisma.node.findUnique({ where: { id: nodeId } });
    if (!current) {
      throw new NotFoundException("节点不存在");
    }

    const panelConfigTouched =
      input.panelBaseUrl !== undefined ||
      input.panelApiBasePath !== undefined ||
      input.panelUsername !== undefined ||
      input.panelPassword !== undefined ||
      input.panelInboundId !== undefined;
    const nextPanelBaseUrl = input.panelBaseUrl !== undefined ? input.panelBaseUrl?.trim() || null : current.panelBaseUrl;
    const nextPanelUsername = input.panelUsername !== undefined ? input.panelUsername?.trim() || null : current.panelUsername;
    const nextPanelPassword = input.panelPassword !== undefined ? input.panelPassword?.trim() || null : current.panelPassword;
    const nextPanelEnabled = await this.resolveNodePanelEnabled({
      inputValue: input.panelEnabled,
      currentValue: current.panelEnabled,
      panelBaseUrl: nextPanelBaseUrl,
      panelUsername: nextPanelUsername,
      panelPassword: nextPanelPassword,
      applyXuiDefault: panelConfigTouched
    });

    let derived: ReturnType<typeof parseVlessLink> | null = null;
    if (input.subscriptionUrl !== undefined && input.subscriptionUrl.trim()) {
      derived = await this.fetchSubscriptionNode(input.subscriptionUrl);
    } else if (
      nextPanelEnabled &&
      panelConfigTouched
    ) {
      derived = await this.xuiService.getInboundRuntime({
        id: current.id,
        panelBaseUrl: input.panelBaseUrl ?? current.panelBaseUrl,
        panelApiBasePath: input.panelApiBasePath ?? current.panelApiBasePath,
        panelUsername: input.panelUsername ?? current.panelUsername,
        panelPassword: input.panelPassword ?? current.panelPassword,
        panelInboundId: input.panelInboundId ?? current.panelInboundId ?? null
      });
    }
    const derivedInboundId = readRuntimeInboundId(derived);
    const shouldPersistPanelEnabledByDefault = panelConfigTouched && input.panelEnabled === undefined && nextPanelEnabled !== current.panelEnabled;
    const shouldPersistDerivedInboundId = input.panelInboundId === undefined && derivedInboundId !== null;

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
        ...(input.panelInboundId !== undefined
          ? { panelInboundId: input.panelInboundId }
          : shouldPersistDerivedInboundId
            ? { panelInboundId: derivedInboundId }
            : {}),
        ...(input.panelEnabled !== undefined
          ? { panelEnabled: input.panelEnabled }
          : shouldPersistPanelEnabledByDefault
            ? { panelEnabled: nextPanelEnabled }
            : {}),
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

  private async resolveNodeRuntimeSource(input: ImportNodeInputDto, panelEnabled: boolean) {
    if (input.subscriptionUrl?.trim()) {
      return this.fetchSubscriptionNode(input.subscriptionUrl.trim());
    }

    if (panelEnabled && input.panelBaseUrl && input.panelUsername && input.panelPassword) {
      return this.xuiService.getInboundRuntime({
        id: createId("panel_runtime"),
        panelBaseUrl: input.panelBaseUrl,
        panelApiBasePath: input.panelApiBasePath ?? "/",
        panelUsername: input.panelUsername,
        panelPassword: input.panelPassword,
        panelInboundId: input.panelInboundId ?? null
      });
    }

    throw new BadRequestException("请填写订阅地址，或完整配置 3x-ui 面板账号后读取入站并导入节点");
  }

  private async resolveNodePanelEnabled(input: {
    inputValue?: boolean;
    currentValue: boolean | null;
    panelBaseUrl: string | null;
    panelUsername: string | null;
    panelPassword: string | null;
    applyXuiDefault: boolean;
  }) {
    if (input.inputValue !== undefined) {
      return input.inputValue;
    }
    if (!input.applyXuiDefault) {
      return input.currentValue ?? false;
    }

    const hasPanelConfig = Boolean(input.panelBaseUrl && input.panelUsername && input.panelPassword);
    if (!hasPanelConfig) {
      return input.currentValue ?? false;
    }

    const profile = await this.prisma.policyProfile.findUnique({
      where: { id: "default" },
      select: { accessMode: true }
    });
    if (profile?.accessMode === "xui") {
      return true;
    }
    return input.currentValue ?? false;
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
        ...(input.aiServicesProxy !== undefined ? { aiServicesProxy: input.aiServicesProxy } : {})
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

  private async requireAdminUserRecord(userId: string) {
    const rows = await this.listAdminUsers();
    const row = rows.find((item) => item.id === userId);
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
          maxConcurrentSessions: DEFAULT_MAX_CONCURRENT_SESSIONS,
          isActive: true
        },
        {
          id: "plan_team_500",
          name: "团队版 500G",
          scope: "team",
          totalTrafficGb: 500,
          renewable: true,
          maxConcurrentSessions: DEFAULT_MAX_CONCURRENT_SESSIONS,
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

    await this.prisma.trafficLedger.createMany({
      data: [
        {
          id: "ledger_001",
          teamId: "team_demo_001",
          userId: "user_team_owner_001",
          subscriptionId: "subscription_team_001",
          nodeId: mockNodes[0]?.id ?? "node_hk_01",
          usedTrafficGb: 42,
          recordedAt: new Date()
        },
        {
          id: "ledger_002",
          teamId: "team_demo_001",
          userId: "user_team_member_001",
          subscriptionId: "subscription_team_001",
          nodeId: mockNodes[1]?.id ?? "node_sg_01",
          usedTrafficGb: 78,
          recordedAt: new Date()
        }
      ]
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

    for (const release of mockAdminReleases) {
      await this.prisma.release.create({
        data: {
          id: release.id,
          platform: release.platform,
          channel: release.channel,
          version: release.version,
          displayTitle: release.displayTitle,
          releaseNotes: release.releaseNotes,
          changelog: release.changelog,
          minimumVersion: release.minimumVersion,
          forceUpgrade: release.forceUpgrade,
          status: release.status,
          publishedAt: release.publishedAt ? new Date(release.publishedAt) : null,
          artifacts: {
            create: release.artifacts.map((artifact) => ({
              id: artifact.id,
              type: toPrismaReleaseArtifactType(artifact.type),
              deliveryMode: artifact.deliveryMode,
              downloadUrl: artifact.downloadUrl,
              fileName: artifact.fileName,
              fileSizeBytes: artifact.fileSizeBytes ? BigInt(artifact.fileSizeBytes) : null,
              fileHash: artifact.fileHash,
              isPrimary: artifact.isPrimary,
              isFullPackage: artifact.isFullPackage
            }))
          }
        }
      });
    }

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

  private async migrateLegacyDefaultConcurrentSessions() {
    const plans = await this.prisma.plan.findMany({
      select: {
        id: true,
        name: true,
        maxConcurrentSessions: true
      }
    });

    if (plans.length === 0) {
      return;
    }

    const legacyPlans = plans.filter((plan) => plan.maxConcurrentSessions < DEFAULT_MAX_CONCURRENT_SESSIONS);
    if (legacyPlans.length === 0) {
      return;
    }

    const isPureLegacyDataset = legacyPlans.length === plans.length;
    if (!isPureLegacyDataset) {
      return;
    }

    await this.prisma.plan.updateMany({
      where: {
        id: {
          in: legacyPlans.map((plan) => plan.id)
        }
      },
      data: {
        maxConcurrentSessions: DEFAULT_MAX_CONCURRENT_SESSIONS
      }
    });

    this.logger.log(
      `已将 ${legacyPlans.length} 个历史套餐的默认并发从旧值迁移为 ${DEFAULT_MAX_CONCURRENT_SESSIONS}`
    );
  }

  private async ensureReleaseCenterSeeded() {
    const count = await this.prisma.release.count();
    if (count > 0) {
      return;
    }

    for (const release of mockAdminReleases) {
      await this.prisma.release.create({
        data: {
          id: release.id,
          platform: release.platform,
          channel: release.channel,
          version: release.version,
          displayTitle: release.displayTitle,
          releaseNotes: release.releaseNotes,
          changelog: release.changelog,
          minimumVersion: release.minimumVersion,
          forceUpgrade: release.forceUpgrade,
          status: release.status,
          publishedAt: release.publishedAt ? new Date(release.publishedAt) : null,
          artifacts: {
            create: release.artifacts.map((artifact) => ({
              id: artifact.id,
              type: toPrismaReleaseArtifactType(artifact.type),
              deliveryMode: artifact.deliveryMode,
              downloadUrl: artifact.downloadUrl,
              fileName: artifact.fileName,
              fileSizeBytes: artifact.fileSizeBytes ? BigInt(artifact.fileSizeBytes) : null,
              fileHash: artifact.fileHash,
              isPrimary: artifact.isPrimary,
              isFullPackage: artifact.isFullPackage
            }))
          }
        }
      });
    }
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

  private async backfillTrafficLedgerNodeIds() {
    const missingRows = await this.prisma.$queryRaw<Array<{
      id: string;
      userId: string;
      subscriptionId: string;
      recordedAt: Date;
    }>>`
      SELECT "id", "userId", "subscriptionId", "recordedAt"
      FROM "TrafficLedger"
      WHERE "nodeId" IS NULL
      ORDER BY "recordedAt" ASC
    `;

    if (missingRows.length === 0) {
      return;
    }

    const subscriptionIds = [...new Set(missingRows.map((row) => row.subscriptionId))];
    const userIds = [...new Set(missingRows.map((row) => row.userId))];
    const leases = await this.prisma.nodeSessionLease.findMany({
      where: {
        subscriptionId: { in: subscriptionIds },
        userId: { in: userIds }
      },
      select: {
        userId: true,
        subscriptionId: true,
        nodeId: true,
        issuedAt: true,
        expiresAt: true,
        lastHeartbeatAt: true,
        revokedAt: true
      },
      orderBy: { issuedAt: "asc" }
    });

    const leaseMap = new Map<string, typeof leases>();
    for (const lease of leases) {
      const key = `${lease.userId}:${lease.subscriptionId}`;
      const current = leaseMap.get(key) ?? [];
      current.push(lease);
      leaseMap.set(key, current);
    }

    let updatedCount = 0;
    for (const row of missingRows) {
      const key = `${row.userId}:${row.subscriptionId}`;
      const candidates = leaseMap.get(key) ?? [];
      const matched = pickLedgerNodeCandidate(candidates, row.recordedAt);
      if (!matched) {
        continue;
      }
      await this.prisma.$executeRaw`
        UPDATE "TrafficLedger"
        SET "nodeId" = ${matched.nodeId}
        WHERE "id" = ${row.id}
      `;
      updatedCount += 1;
    }

    const remainingRows = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS "count"
      FROM "TrafficLedger"
      WHERE "nodeId" IS NULL
    `;
    const remaining = Number(remainingRows[0]?.count ?? 0n);
    this.logger.log(`历史账单节点归属回填完成：已补 ${updatedCount} 条，剩余 ${remaining} 条`);
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
  const state = readEffectiveSubscriptionState(row);
  const stateReason = getSubscriptionStateReason(state);
  return {
    id: row.id,
    ownerType: team ? "team" : "user",
    planId: row.planId,
    planName: row.plan.name,
    remainingTrafficGb: row.remainingTrafficGb,
    expireAt: row.expireAt.toISOString(),
    state,
    stateReasonCode: stateReason.reasonCode,
    stateReasonMessage: stateReason.reasonMessage,
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
    security: row.security as "reality"
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
  const state = readEffectiveSubscriptionState(row);
  const stateReason = getSubscriptionStateReason(state);
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
    state,
    renewable: row.renewable,
    sourceAction: row.sourceAction,
    lastSyncedAt: row.lastSyncedAt.toISOString(),
    nodeCount,
    hasNodeAccess: nodeCount > 0,
    stateReasonCode: stateReason.reasonCode,
    stateReasonMessage: stateReason.reasonMessage
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

function toAdminPolicyRecord(
  row: {
    accessMode: string;
    defaultMode: string;
    modes: string[];
    blockAds: boolean;
    chinaDirect: boolean;
    aiServicesProxy: boolean;
  }
): AdminPolicyRecordDto {
  return {
    accessMode: row.accessMode as AdminPolicyRecordDto["accessMode"],
    defaultMode: row.defaultMode as PolicyBundleDto["defaultMode"],
    modes: row.modes as PolicyBundleDto["modes"],
    features: {
      blockAds: row.blockAds,
      chinaDirect: row.chinaDirect,
      aiServicesProxy: row.aiServicesProxy
    }
  };
}

function toAdminReleaseArtifactRecord(row: {
  id: string;
  releaseId: string;
  source: string;
  type: string;
  deliveryMode: string;
  downloadUrl: string;
  fileName: string | null;
  fileSizeBytes: bigint | null;
  fileHash: string | null;
  isPrimary: boolean;
  isFullPackage: boolean;
  createdAt: Date;
  updatedAt: Date;
}): AdminReleaseArtifactDto {
  return {
    id: row.id,
    releaseId: row.releaseId,
    source: row.source as "uploaded" | "external",
    type: fromPrismaReleaseArtifactType(row.type),
    deliveryMode: row.deliveryMode as UpdateDeliveryMode,
    downloadUrl: row.downloadUrl,
    fileName: row.fileName,
    fileSizeBytes: row.fileSizeBytes?.toString() ?? null,
    fileHash: row.fileHash,
    isPrimary: row.isPrimary,
    isFullPackage: row.isFullPackage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function toAdminReleaseRecord(row: {
  id: string;
  platform: string;
  channel: string;
  version: string;
  displayTitle: string;
  releaseNotes: string | null;
  changelog: string[];
  minimumVersion: string;
  forceUpgrade: boolean;
  status: string;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
    artifacts: Array<{
      id: string;
      releaseId: string;
      source: string;
      type: string;
      deliveryMode: string;
      downloadUrl: string;
    fileName: string | null;
    fileSizeBytes: bigint | null;
    fileHash: string | null;
    isPrimary: boolean;
    isFullPackage: boolean;
    createdAt: Date;
    updatedAt: Date;
  }>;
}): AdminReleaseRecordDto {
  return {
    id: row.id,
    platform: row.platform as AdminReleaseRecordDto["platform"],
    channel: row.channel as ReleaseChannel,
    version: row.version,
    displayTitle: row.displayTitle,
    releaseNotes: row.releaseNotes,
    changelog: row.changelog,
    minimumVersion: row.minimumVersion,
    forceUpgrade: row.forceUpgrade,
    status: row.status as ReleaseStatus,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    artifacts: row.artifacts.map(toAdminReleaseArtifactRecord)
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
  const state = readEffectiveSubscriptionState(row);
  const stateReason = getSubscriptionStateReason(state);
  return {
    id: row.id,
    ownerType: team ? "team" : "user",
    planId: row.planId,
    planName: row.plan.name,
    totalTrafficGb: row.totalTrafficGb,
    usedTrafficGb: row.usedTrafficGb,
    remainingTrafficGb: row.remainingTrafficGb,
    expireAt: row.expireAt.toISOString(),
    state,
    renewable: row.renewable,
    lastSyncedAt: row.lastSyncedAt.toISOString(),
    teamId: team?.id ?? null,
    teamName: team?.name ?? null,
    memberUsedTrafficGb,
    meteringStatus: metering.meteringStatus,
    meteringMessage: metering.meteringMessage,
    stateReasonCode: stateReason.reasonCode,
    stateReasonMessage: stateReason.reasonMessage
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
    nodeId: string | null;
    usedTrafficGb: number;
    recordedAt: Date;
    user: { displayName: string; email: string };
    node: { id: string; name: string; region: string } | null;
  }>;
}): AdminTeamRecordDto {
  const currentSubscription = pickCurrentSubscription(row.subscriptions);
  const usage = summarizeTeamUsageRecords(row.trafficLedgerEntries);
  const usageByUser = new Map(usage.map((entry) => [entry.userId, entry.usedTrafficGb]));

  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.ownerUserId,
    ownerDisplayName: row.owner.displayName,
    ownerEmail: row.owner.email,
    status: row.status,
    memberCount: row.members.length,
    currentSubscription: currentSubscription
      ? (() => {
          const state = readEffectiveSubscriptionState(currentSubscription);
          const stateReason = getSubscriptionStateReason(state);
          return {
          id: currentSubscription.id,
          planId: currentSubscription.planId,
          planName: currentSubscription.plan.name,
          totalTrafficGb: currentSubscription.totalTrafficGb,
          usedTrafficGb: currentSubscription.usedTrafficGb,
          remainingTrafficGb: currentSubscription.remainingTrafficGb,
          expireAt: currentSubscription.expireAt.toISOString(),
          state,
          stateReasonCode: stateReason.reasonCode,
          stateReasonMessage: stateReason.reasonMessage
        };
        })()
      : null,
    members: row.members.map((member) => toAdminTeamMemberRecord(member, usageByUser.get(member.userId) ?? 0)),
    usage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function summarizeTeamUsageRecords(
  rows: Array<{
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
): AdminTeamUsageRecordDto[] {
  const grouped = new Map<
    string,
    {
      id: string;
      teamId: string;
      userId: string;
      userDisplayName: string;
      userEmail: string;
      subscriptionId: string;
      usedTrafficGb: number;
      recordedAt: Date;
      recordCount: number;
      nodeBreakdown: Map<string, AdminTeamUsageNodeSummaryDto>;
    }
  >();

  for (const row of rows) {
    const current =
      grouped.get(row.userId) ??
      {
        id: row.id,
        teamId: row.teamId,
        userId: row.userId,
        userDisplayName: row.user.displayName,
        userEmail: row.user.email,
        subscriptionId: row.subscriptionId,
        usedTrafficGb: 0,
        recordedAt: row.recordedAt,
        recordCount: 0,
        nodeBreakdown: new Map<string, AdminTeamUsageNodeSummaryDto>()
      };

    current.usedTrafficGb += row.usedTrafficGb;
    current.recordCount += 1;
    if (row.recordedAt.getTime() > current.recordedAt.getTime()) {
      current.recordedAt = row.recordedAt;
      current.id = row.id;
    }

    const currentNode =
      current.nodeBreakdown.get(row.nodeId ?? "unknown") ??
      {
        nodeId: row.node?.id ?? row.nodeId ?? "unknown",
        nodeName: row.node?.name ?? "未知节点",
        nodeRegion: row.node?.region ?? "未知",
        usedTrafficGb: 0,
        recordCount: 0,
        lastRecordedAt: row.recordedAt.toISOString()
      };
    currentNode.usedTrafficGb += row.usedTrafficGb;
    currentNode.recordCount += 1;
    if (new Date(currentNode.lastRecordedAt).getTime() < row.recordedAt.getTime()) {
      currentNode.lastRecordedAt = row.recordedAt.toISOString();
    }
    current.nodeBreakdown.set(row.nodeId ?? "unknown", currentNode);
    grouped.set(row.userId, current);
  }

  return Array.from(grouped.values())
    .map((row) => ({
      id: row.id,
      teamId: row.teamId,
      userId: row.userId,
      userDisplayName: row.userDisplayName,
      userEmail: row.userEmail,
      subscriptionId: row.subscriptionId,
      usedTrafficGb: roundTrafficGb(row.usedTrafficGb),
      memberTotalUsedTrafficGb: roundTrafficGb(row.usedTrafficGb),
      recordedAt: row.recordedAt.toISOString(),
      recordCount: row.recordCount,
      nodeBreakdown: Array.from(row.nodeBreakdown.values()).sort(
        (left, right) => new Date(right.lastRecordedAt).getTime() - new Date(left.lastRecordedAt).getTime()
      )
    }))
    .sort((left, right) => new Date(right.recordedAt).getTime() - new Date(left.recordedAt).getTime());
}

function normalizeVersion(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new BadRequestException("版本号不能为空");
  }
  return normalized;
}

function normalizeChangelog(items?: string[]) {
  return (items ?? []).map((item) => item.trim()).filter(Boolean);
}

function normalizeNullableText(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value === null ? "" : value.trim();
  return normalized ? normalized : null;
}

function normalizeBigInt(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (!value) {
    return null;
  }
  return BigInt(value.trim());
}

function normalizeOptionalBoolean(value: boolean | string | null | undefined) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return undefined;
}

function normalizePublishedAt(status: ReleaseStatus, publishedAt?: string | null) {
  if (status === "published") {
    return publishedAt ? new Date(publishedAt) : new Date();
  }
  if (publishedAt === undefined) {
    return undefined;
  }
  return publishedAt ? new Date(publishedAt) : null;
}

function compareSemver(left: string, right: string) {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts.core[index] !== rightParts.core[index]) {
      return leftParts.core[index] - rightParts.core[index];
    }
  }
  if (leftParts.prerelease === rightParts.prerelease) {
    return 0;
  }
  if (!leftParts.prerelease) {
    return 1;
  }
  if (!rightParts.prerelease) {
    return -1;
  }
  return leftParts.prerelease.localeCompare(rightParts.prerelease, undefined, { numeric: true });
}

function parseSemver(value: string) {
  const [corePart, prerelease = ""] = value.trim().split("-", 2);
  const core = corePart.split(".").map((item) => Number.parseInt(item, 10) || 0);
  while (core.length < 3) {
    core.push(0);
  }
  return { core, prerelease };
}

function defaultDeliveryModeForArtifact(type: ReleaseArtifactType): UpdateDeliveryMode {
  if (type === "apk") {
    return "apk_download";
  }
  if (type === "external" || type === "ipa") {
    return "external_download";
  }
  return "desktop_installer_download";
}

function assertReleaseArtifactTypeAllowed(platform: PlatformTarget, type: ReleaseArtifactType) {
  const allowed =
    platform === "macos"
      ? ["dmg", "external"]
      : platform === "windows"
        ? ["setup.exe", "external"]
        : platform === "android"
          ? ["apk", "external"]
          : ["ipa", "external"];

  if (!allowed.includes(type)) {
    throw new BadRequestException(`当前平台仅支持这些产物类型：${allowed.join("、")}`);
  }
}

async function ensureFileReadable(filePath: string) {
  try {
    await fs.access(filePath);
  } catch {
    throw new NotFoundException("安装包文件不存在或已丢失");
  }
}

async function removeReleaseArtifactFile(filePath: string) {
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    return;
  }
}

function releaseArtifactStorageRoot() {
  const customRoot = (process.env.CHORDV_RELEASE_STORAGE_ROOT ?? "").trim();
  if (customRoot) {
    return path.resolve(customRoot);
  }
  return path.resolve(process.cwd(), "storage", "releases");
}

function resolveReleaseArtifactAbsolutePath(storedFilePath: string) {
  return path.resolve(releaseArtifactStorageRoot(), storedFilePath);
}

function buildReleaseArtifactDownloadUrl(artifactId: string) {
  const publicBaseUrl = (process.env.CHORDV_PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const relativeUrl = `${RELEASE_ARTIFACT_DOWNLOAD_PREFIX}/${artifactId}`;
  return publicBaseUrl ? `${publicBaseUrl}${relativeUrl}` : relativeUrl;
}

function sanitizeReleaseArtifactFileName(fileName: string) {
  const trimmed = fileName.trim();
  const safe = trimmed.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/_+/g, "_");
  return safe || `artifact_${Date.now()}`;
}

async function calculateFileSha256(filePath: string) {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

function defaultDeliveryModeForPlatform(platform: ClientUpdateCheckResultDto["platform"]): UpdateDeliveryMode {
  if (platform === "android") {
    return "apk_download";
  }
  if (platform === "ios") {
    return "external_download";
  }
  return "desktop_installer_download";
}

function toPrismaReleaseArtifactType(type: ReleaseArtifactType) {
  if (type === "setup.exe") {
    return "setup_exe";
  }
  return type;
}

function fromPrismaReleaseArtifactType(type: string): ReleaseArtifactType {
  if (type === "setup_exe") {
    return "setup.exe";
  }
  return type as ReleaseArtifactType;
}

function pickPrimaryReleaseArtifact(
  artifacts: Array<{
    id: string;
    releaseId: string;
    source: string;
    type: string;
    deliveryMode: string;
    downloadUrl: string;
    fileName: string | null;
    fileSizeBytes: bigint | null;
    fileHash: string | null;
    isPrimary: boolean;
    isFullPackage: boolean;
    createdAt: Date;
    updatedAt: Date;
  }>,
  preferredType?: ReleaseArtifactType | null
) {
  const normalizedType = preferredType ? toPrismaReleaseArtifactType(preferredType) : null;
  const typedPrimary = normalizedType ? artifacts.find((item) => item.type === normalizedType && item.isPrimary) : null;
  if (typedPrimary) {
    return typedPrimary;
  }
  const typedFallback = normalizedType ? artifacts.find((item) => item.type === normalizedType) : null;
  if (typedFallback) {
    return typedFallback;
  }
  return artifacts.find((item) => item.isPrimary) ?? artifacts[0] ?? null;
}

function createId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function buildLeaseEmail(userId: string, leaseId: string) {
  return `${userId}.${leaseId}@lease.chordv`;
}

function buildPanelClientEmail(userEmail: string, subscriptionId: string, nodeId: string, userId: string) {
  const sanitizedEmail = userEmail.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const sanitizedSubscription = subscriptionId.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const sanitizedUser = userId.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const nodeHash = createHash("sha1").update(nodeId).digest("hex").slice(0, 10);
  return [sanitizedEmail || "user", sanitizedSubscription.slice(-8), `node${nodeHash}`, sanitizedUser.slice(-8)].join("_");
}

function buildSnapshotKey(nodeId: string, subscriptionId: string, userId: string | null) {
  const userPart = userId ?? "subscription";
  return `${nodeId}:${subscriptionId}:${userPart}`;
}

function pickLedgerNodeCandidate(
  leases: Array<{
    nodeId: string;
    issuedAt: Date;
    expiresAt: Date;
    lastHeartbeatAt: Date;
    revokedAt: Date | null;
  }>,
  recordedAt: Date
) {
  const recordedMs = recordedAt.getTime();
  const strict = leases
    .filter((lease) => {
      const start = lease.issuedAt.getTime() - 30_000;
      const end = Math.max(
        lease.expiresAt.getTime(),
        lease.lastHeartbeatAt.getTime(),
        lease.revokedAt?.getTime() ?? 0
      ) + 90_000;
      return recordedMs >= start && recordedMs <= end;
    })
    .sort((left, right) => right.issuedAt.getTime() - left.issuedAt.getTime());

  if (strict[0]) {
    return strict[0];
  }

  const fallback = leases
    .map((lease) => {
      const distance = Math.min(
        Math.abs(recordedMs - lease.issuedAt.getTime()),
        Math.abs(recordedMs - lease.expiresAt.getTime()),
        Math.abs(recordedMs - lease.lastHeartbeatAt.getTime()),
        Math.abs(recordedMs - (lease.revokedAt?.getTime() ?? lease.expiresAt.getTime()))
      );
      return { lease, distance };
    })
    .filter((item) => item.distance <= 10 * 60 * 1000)
    .sort((left, right) => left.distance - right.distance);

  return fallback[0]?.lease;
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

function normalizeOptionalString(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
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

function readRuntimeInboundId(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const inboundId = Reflect.get(value, "inboundId");
  if (typeof inboundId === "number" && Number.isFinite(inboundId) && inboundId > 0) {
    return inboundId;
  }
  return null;
}

function pickCurrentSubscription<T extends { state: SubscriptionState; expireAt: Date; remainingTrafficGb: number }>(rows: T[]) {
  return rows.find((item) => readEffectiveSubscriptionState(item) === "active")
    ?? rows.find((item) => readEffectiveSubscriptionState(item) === "paused")
    ?? rows.sort((a, b) => b.expireAt.getTime() - a.expireAt.getTime())[0]
    ?? null;
}

function resolveRenewExpireAt(currentExpireAt: Date, explicitExpireAt?: string) {
  if (explicitExpireAt) {
    const date = new Date(explicitExpireAt);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException("到期时间无效");
    }
    return date;
  }

  return currentExpireAt;
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
  const state = readEffectiveSubscriptionState(subscription);
  return state === "active" || state === "paused";
}

function shouldProvisionPanelClients(subscription: {
  state: SubscriptionState;
  expireAt: Date;
  remainingTrafficGb: number;
  team?: { status: TeamStatus } | null;
  user?: { status: "active" | "disabled" } | null;
}) {
  if (readEffectiveSubscriptionState(subscription) !== "active") {
    return false;
  }
  if (subscription.team && subscription.team.status !== "active") {
    return false;
  }
  if (subscription.user && subscription.user.status !== "active") {
    return false;
  }
  return true;
}

function shouldDeletePanelClients(subscription: {
  state: SubscriptionState;
  expireAt: Date;
  remainingTrafficGb: number;
}) {
  const state = readEffectiveSubscriptionState(subscription);
  return state === "expired" || state === "exhausted";
}

function assertSubscriptionConnectable(subscription: {
  state: SubscriptionState;
  remainingTrafficGb: number;
  expireAt: Date;
}) {
  const state = readEffectiveSubscriptionState(subscription);
  if (state === "paused") {
    throw new ForbiddenException("当前订阅已暂停");
  }
  if (state === "expired") {
    throw new ForbiddenException("当前订阅已到期");
  }
  if (state === "exhausted") {
    throw new ForbiddenException("当前订阅流量已用尽");
  }
}

function getSubscriptionStateReason(state: SubscriptionState): {
  reasonCode: SessionReasonCode | null;
  reasonMessage: string | null;
} {
  if (state === "expired") {
    return {
      reasonCode: "subscription_expired",
      reasonMessage: "当前订阅已到期"
    };
  }
  if (state === "exhausted") {
    return {
      reasonCode: "subscription_exhausted",
      reasonMessage: "当前订阅流量已用尽"
    };
  }
  if (state === "paused") {
    return {
      reasonCode: "subscription_paused",
      reasonMessage: "当前订阅已暂停"
    };
  }
  return {
    reasonCode: null,
    reasonMessage: null
  };
}

function getLeaseFailureDetails(
  status: "expired" | "revoked" | "evicted",
  revokedReason?: string | null
): {
  reasonCode: SessionReasonCode;
  reasonMessage: string;
  detailReason: string | null;
  evictedReason: SessionEvictedReason | null;
} {
  switch (revokedReason) {
    case SECURITY_REASON_CONCURRENCY:
      return {
        reasonCode: "connection_taken_over",
        reasonMessage: "当前连接已被其他设备接管",
        detailReason: revokedReason,
        evictedReason: "concurrency_limit"
      };
    case "team_member_disconnected":
      return {
        reasonCode: "admin_paused_connection",
        reasonMessage: "管理员已暂停当前连接",
        detailReason: revokedReason,
        evictedReason: null
      };
    case "node_access_revoked":
      return {
        reasonCode: "node_access_revoked",
        reasonMessage: "当前节点已被取消授权",
        detailReason: revokedReason,
        evictedReason: null
      };
    case "subscription_expired":
      return {
        reasonCode: "subscription_expired",
        reasonMessage: "当前订阅已到期",
        detailReason: revokedReason,
        evictedReason: null
      };
    case "subscription_exhausted":
      return {
        reasonCode: "subscription_exhausted",
        reasonMessage: "当前订阅流量已用尽",
        detailReason: revokedReason,
        evictedReason: null
      };
    case "subscription_paused":
      return {
        reasonCode: "subscription_paused",
        reasonMessage: "当前订阅已暂停",
        detailReason: revokedReason,
        evictedReason: null
      };
    case "user_disabled":
    case "subscription_user_disabled":
      return {
        reasonCode: "account_disabled",
        reasonMessage: "当前账号已禁用，会话已失效",
        detailReason: revokedReason,
        evictedReason: null
      };
    case "team_membership_missing":
    case "team_member_removed":
    case "team_disabled":
      return {
        reasonCode: "team_access_revoked",
        reasonMessage: "当前成员已失去团队访问权限，会话已失效",
        detailReason: revokedReason,
        evictedReason: null
      };
    case "panel_client_rotated":
      return {
        reasonCode: "runtime_credentials_rotated",
        reasonMessage: "当前连接凭据已更新，请重新连接",
        detailReason: revokedReason,
        evictedReason: null
      };
    case "lease_expired":
      return {
        reasonCode: "session_expired",
        reasonMessage: "当前连接已过期，请重新连接",
        detailReason: revokedReason,
        evictedReason: null
      };
    case "revoked_by_client":
      return {
        reasonCode: "session_invalid",
        reasonMessage: "当前连接已断开",
        detailReason: revokedReason,
        evictedReason: null
      };
    case "subscription_missing":
    case "subscription_owner_missing":
    case "subscription_owner_mismatch":
    case "lease_renew_failed":
    case "edge_open_failed":
    case "panel_client_disabled":
      return {
        reasonCode: "session_invalid",
        reasonMessage: "当前连接已失效，请重新连接",
        detailReason: revokedReason,
        evictedReason: null
      };
    default:
      if (status === "expired") {
        return {
          reasonCode: "session_expired",
          reasonMessage: "当前连接已过期，请重新连接",
          detailReason: revokedReason ?? null,
          evictedReason: null
        };
      }
      if (status === "evicted") {
        return {
          reasonCode: "connection_taken_over",
          reasonMessage: "当前连接已被其他设备接管",
          detailReason: revokedReason ?? null,
          evictedReason: "concurrency_limit"
        };
      }
      return {
        reasonCode: "session_invalid",
        reasonMessage: "当前连接已失效，请重新连接",
        detailReason: revokedReason ?? null,
        evictedReason: null
      };
  }
}

function toClientRuntimeEventType(reasonCode: SessionReasonCode) {
  if (reasonCode === "subscription_expired" || reasonCode === "subscription_exhausted" || reasonCode === "subscription_paused") {
    return "subscription_updated" as const;
  }
  if (reasonCode === "node_access_revoked") {
    return "node_access_updated" as const;
  }
  if (reasonCode === "account_disabled" || reasonCode === "team_access_revoked") {
    return "account_updated" as const;
  }
  return "session_revoked" as const;
}

function readEffectiveSubscriptionState(subscription: {
  state: SubscriptionState;
  expireAt: Date;
  remainingTrafficGb: number;
}) {
  return resolveSubscriptionState(subscription.state, subscription.remainingTrafficGb, subscription.expireAt);
}

function roundTrafficGb(value: number) {
  return Math.round(value * 1000) / 1000;
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
