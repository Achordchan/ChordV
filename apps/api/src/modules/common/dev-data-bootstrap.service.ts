import { Injectable, Logger } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import {
  mockAdminReleases,
  mockAnnouncements,
  mockNodes,
  mockPolicies,
  mockSubscription,
  mockUser,
  mockVersion
} from "@chordv/shared";
import { PrismaService } from "./prisma.service";
import { toPrismaReleaseArtifactType } from "./release-center.utils";
import { DEFAULT_MAX_CONCURRENT_SESSIONS } from "./runtime-session.utils";

const BUILTIN_ADMIN_ID = "admin_001";
const BUILTIN_ADMIN_ACCOUNT = "admin";
const BUILTIN_ADMIN_PASSWORD = "woshichen123";

@Injectable()
export class DevDataBootstrapService {
  private readonly logger = new Logger(DevDataBootstrapService.name);

  constructor(private readonly prisma: PrismaService) {}

  async initialize() {
    await this.seedIfEmpty();
    await this.ensureReleaseCenterSeeded();
    await this.migrateLegacyDefaultConcurrentSessions();
    await this.ensureBuiltinAdminAccount();
    await this.backfillTrafficLedgerNodeIds();
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
    if (legacyPlans.length === 0 || legacyPlans.length !== plans.length) {
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

function pickLedgerNodeCandidate(
  leases: Array<{
    nodeId: string;
    issuedAt: Date;
    expiresAt: Date;
    lastHeartbeatAt: Date | null;
    revokedAt: Date | null;
  }>,
  recordedAt: Date
) {
  const targetTime = recordedAt.getTime();
  return leases.find((lease) => {
    const issuedTime = lease.issuedAt.getTime();
    const endedTime = Math.max(
      lease.revokedAt?.getTime() ?? 0,
      lease.lastHeartbeatAt?.getTime() ?? lease.expiresAt.getTime(),
      lease.expiresAt.getTime()
    );
    return issuedTime <= targetTime && endedTime >= targetTime;
  });
}
