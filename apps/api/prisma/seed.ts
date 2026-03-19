import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import {
  mockAnnouncements,
  mockNodes,
  mockPolicies,
  mockSubscription,
  mockUser,
  mockVersion
} from "@chordv/shared";

const prisma = new PrismaClient();
const BUILTIN_ADMIN_ID = "admin_001";
const BUILTIN_ADMIN_ACCOUNT = "admin";
const BUILTIN_ADMIN_PASSWORD = "woshichen123";

async function main() {
  const demoPasswordHash = await bcrypt.hash("demo123456", 10);
  const adminPasswordHash = await bcrypt.hash(BUILTIN_ADMIN_PASSWORD, 10);
  const ownerPasswordHash = await bcrypt.hash("team123456", 10);
  const memberPasswordHash = await bcrypt.hash("team123456", 10);

  await prisma.user.upsert({
    where: { email: mockUser.email },
    update: {
      displayName: mockUser.displayName,
      role: mockUser.role,
      status: mockUser.status,
      authVersion: 1,
      maxConcurrentSessionsOverride: null,
      passwordHash: demoPasswordHash,
      lastSeenAt: new Date(mockUser.lastSeenAt)
    },
    create: {
      id: mockUser.id,
      email: mockUser.email,
      displayName: mockUser.displayName,
      role: mockUser.role,
      status: mockUser.status,
      authVersion: 1,
      maxConcurrentSessionsOverride: null,
      passwordHash: demoPasswordHash,
      lastSeenAt: new Date(mockUser.lastSeenAt)
    }
  });

  await prisma.user.upsert({
    where: { id: BUILTIN_ADMIN_ID },
    update: {
      email: BUILTIN_ADMIN_ACCOUNT,
      displayName: "系统管理员",
      role: "admin",
      status: "active",
      authVersion: 1,
      maxConcurrentSessionsOverride: null,
      passwordHash: adminPasswordHash,
      lastSeenAt: new Date()
    },
    create: {
      id: BUILTIN_ADMIN_ID,
      email: BUILTIN_ADMIN_ACCOUNT,
      displayName: "系统管理员",
      role: "admin",
      status: "active",
      authVersion: 1,
      maxConcurrentSessionsOverride: null,
      passwordHash: adminPasswordHash,
      lastSeenAt: new Date()
    }
  });

  await prisma.user.upsert({
    where: { email: "team-owner@chordv.app" },
    update: {
      displayName: "团队负责人",
      role: "user",
      status: "active",
      authVersion: 1,
      maxConcurrentSessionsOverride: null,
      passwordHash: ownerPasswordHash,
      lastSeenAt: new Date()
    },
    create: {
      id: "user_team_owner_001",
      email: "team-owner@chordv.app",
      displayName: "团队负责人",
      role: "user",
      status: "active",
      authVersion: 1,
      maxConcurrentSessionsOverride: null,
      passwordHash: ownerPasswordHash,
      lastSeenAt: new Date()
    }
  });

  await prisma.user.upsert({
    where: { email: "team-member@chordv.app" },
    update: {
      displayName: "团队成员",
      role: "user",
      status: "active",
      authVersion: 1,
      maxConcurrentSessionsOverride: null,
      passwordHash: memberPasswordHash,
      lastSeenAt: new Date()
    },
    create: {
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
  });

  await prisma.plan.upsert({
    where: { id: mockSubscription.planId },
    update: {
      name: mockSubscription.planName,
      scope: "personal",
      totalTrafficGb: mockSubscription.totalTrafficGb,
      renewable: mockSubscription.renewable,
      maxConcurrentSessions: 1,
      isActive: true
    },
    create: {
      id: mockSubscription.planId,
      name: mockSubscription.planName,
      scope: "personal",
      totalTrafficGb: mockSubscription.totalTrafficGb,
      renewable: mockSubscription.renewable,
      maxConcurrentSessions: 1,
      isActive: true
    }
  });

  await prisma.plan.upsert({
    where: { id: "plan_team_500" },
    update: {
      name: "团队版 500G",
      scope: "team",
      totalTrafficGb: 500,
      renewable: true,
      maxConcurrentSessions: 1,
      isActive: true
    },
    create: {
      id: "plan_team_500",
      name: "团队版 500G",
      scope: "team",
      totalTrafficGb: 500,
      renewable: true,
      maxConcurrentSessions: 1,
      isActive: true
    }
  });

  await prisma.subscription.upsert({
    where: { id: "subscription_demo_001" },
    update: {
      userId: mockUser.id,
      teamId: null,
      planId: mockSubscription.planId,
      totalTrafficGb: mockSubscription.totalTrafficGb,
      usedTrafficGb: mockSubscription.usedTrafficGb,
      remainingTrafficGb: mockSubscription.remainingTrafficGb,
      expireAt: new Date(mockSubscription.expireAt),
      state: mockSubscription.state,
      renewable: mockSubscription.renewable,
      sourceAction: "created",
      lastSyncedAt: new Date(mockSubscription.lastSyncedAt)
    },
    create: {
      id: "subscription_demo_001",
      userId: mockUser.id,
      teamId: null,
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

  await prisma.team.upsert({
    where: { id: "team_demo_001" },
    update: {
      name: "示例团队",
      ownerUserId: "user_team_owner_001",
      status: "active"
    },
    create: {
      id: "team_demo_001",
      name: "示例团队",
      ownerUserId: "user_team_owner_001",
      status: "active"
    }
  });

  await prisma.teamMember.upsert({
    where: { userId: "user_team_owner_001" },
    update: {
      id: "member_owner_001",
      teamId: "team_demo_001",
      userId: "user_team_owner_001",
      role: "owner"
    },
    create: {
      id: "member_owner_001",
      teamId: "team_demo_001",
      userId: "user_team_owner_001",
      role: "owner"
    }
  });

  await prisma.teamMember.upsert({
    where: { userId: "user_team_member_001" },
    update: {
      id: "member_user_001",
      teamId: "team_demo_001",
      userId: "user_team_member_001",
      role: "member"
    },
    create: {
      id: "member_user_001",
      teamId: "team_demo_001",
      userId: "user_team_member_001",
      role: "member"
    }
  });

  await prisma.subscription.upsert({
    where: { id: "subscription_team_001" },
    update: {
      userId: null,
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
    },
    create: {
      id: "subscription_team_001",
      userId: null,
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

  await prisma.trafficLedger.upsert({
    where: { id: "ledger_001" },
    update: {
      teamId: "team_demo_001",
      userId: "user_team_owner_001",
      subscriptionId: "subscription_team_001",
      usedTrafficGb: 42,
      recordedAt: new Date()
    },
    create: {
      id: "ledger_001",
      teamId: "team_demo_001",
      userId: "user_team_owner_001",
      subscriptionId: "subscription_team_001",
      usedTrafficGb: 42,
      recordedAt: new Date()
    }
  });

  await prisma.trafficLedger.upsert({
    where: { id: "ledger_002" },
    update: {
      teamId: "team_demo_001",
      userId: "user_team_member_001",
      subscriptionId: "subscription_team_001",
      usedTrafficGb: 78,
      recordedAt: new Date()
    },
    create: {
      id: "ledger_002",
      teamId: "team_demo_001",
      userId: "user_team_member_001",
      subscriptionId: "subscription_team_001",
      usedTrafficGb: 78,
      recordedAt: new Date()
    }
  });

  for (const node of mockNodes) {
    await prisma.node.upsert({
      where: { id: node.id },
      update: {
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
        probeLatencyMs: null,
        probeCheckedAt: null,
        probeError: null
      },
      create: {
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
        probeStatus: "unknown"
      }
    });
  }

  const nodeAccessSeeds = [
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
  ];

  for (const item of nodeAccessSeeds) {
    await prisma.subscriptionNodeAccess.upsert({
      where: { id: item.id },
      update: {
        subscriptionId: item.subscriptionId,
        nodeId: item.nodeId
      },
      create: {
        id: item.id,
        subscriptionId: item.subscriptionId,
        nodeId: item.nodeId
      }
    });
  }

  await prisma.policyProfile.upsert({
    where: { id: "default" },
    update: {
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
    },
    create: {
      id: "default",
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

  await prisma.strategyGroup.deleteMany({
    where: { policyId: "default" }
  });

  for (const announcement of mockAnnouncements) {
    await prisma.announcement.upsert({
      where: { id: announcement.id },
      update: {
        title: announcement.title,
        body: announcement.body,
        level: announcement.level,
        publishedAt: new Date(announcement.publishedAt),
        isActive: true,
        displayMode: announcement.displayMode,
        countdownSeconds: announcement.countdownSeconds
      },
      create: {
        id: announcement.id,
        title: announcement.title,
        body: announcement.body,
        level: announcement.level,
        publishedAt: new Date(announcement.publishedAt),
        isActive: true,
        displayMode: announcement.displayMode,
        countdownSeconds: announcement.countdownSeconds
      }
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
