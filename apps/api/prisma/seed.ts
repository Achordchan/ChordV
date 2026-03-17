import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import {
  mockAdmin,
  mockAnnouncements,
  mockNodes,
  mockPanels,
  mockPolicies,
  mockSubscription,
  mockUser,
  mockVersion
} from "@chordv/shared";

const prisma = new PrismaClient();

async function main() {
  const demoPasswordHash = await bcrypt.hash("demo123456", 10);
  const adminPasswordHash = await bcrypt.hash("admin123456", 10);
  const demoPanelClientEmail = process.env.CHORDV_DEMO_PANEL_CLIENT_EMAIL || mockUser.email;
  const defaultPanelBaseUrl = process.env.CHORDV_PANEL_DEFAULT_URL;

  await prisma.user.upsert({
    where: { email: mockUser.email },
    update: {
      displayName: mockUser.displayName,
      role: mockUser.role,
      status: mockUser.status,
      passwordHash: demoPasswordHash,
      lastSeenAt: new Date(mockUser.lastSeenAt)
    },
    create: {
      id: mockUser.id,
      email: mockUser.email,
      displayName: mockUser.displayName,
      role: mockUser.role,
      status: mockUser.status,
      passwordHash: demoPasswordHash,
      lastSeenAt: new Date(mockUser.lastSeenAt)
    }
  });

  await prisma.user.upsert({
    where: { email: mockAdmin.email },
    update: {
      displayName: mockAdmin.displayName,
      role: mockAdmin.role,
      status: mockAdmin.status,
      passwordHash: adminPasswordHash,
      lastSeenAt: new Date(mockAdmin.lastSeenAt)
    },
    create: {
      id: mockAdmin.id,
      email: mockAdmin.email,
      displayName: mockAdmin.displayName,
      role: mockAdmin.role,
      status: mockAdmin.status,
      passwordHash: adminPasswordHash,
      lastSeenAt: new Date(mockAdmin.lastSeenAt)
    }
  });

  await prisma.plan.upsert({
    where: { id: mockSubscription.planId },
    update: {
      name: mockSubscription.planName,
      totalTrafficGb: mockSubscription.totalTrafficGb,
      durationDays: 30,
      renewable: mockSubscription.renewable,
      isActive: true
    },
    create: {
      id: mockSubscription.planId,
      name: mockSubscription.planName,
      totalTrafficGb: mockSubscription.totalTrafficGb,
      durationDays: 30,
      renewable: mockSubscription.renewable,
      isActive: true
    }
  });

  await prisma.subscription.upsert({
    where: { id: "subscription_demo_001" },
    update: {
      userId: mockUser.id,
      planId: mockSubscription.planId,
      panelClientEmail: demoPanelClientEmail,
      totalTrafficGb: mockSubscription.totalTrafficGb,
      usedTrafficGb: mockSubscription.usedTrafficGb,
      remainingTrafficGb: mockSubscription.remainingTrafficGb,
      expireAt: new Date(mockSubscription.expireAt),
      state: mockSubscription.state,
      renewable: mockSubscription.renewable,
      lastSyncedAt: new Date(mockSubscription.lastSyncedAt)
    },
    create: {
      id: "subscription_demo_001",
      userId: mockUser.id,
      planId: mockSubscription.planId,
      panelClientEmail: demoPanelClientEmail,
      totalTrafficGb: mockSubscription.totalTrafficGb,
      usedTrafficGb: mockSubscription.usedTrafficGb,
      remainingTrafficGb: mockSubscription.remainingTrafficGb,
      expireAt: new Date(mockSubscription.expireAt),
      state: mockSubscription.state,
      renewable: mockSubscription.renewable,
      lastSyncedAt: new Date(mockSubscription.lastSyncedAt)
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
        fingerprint: "chrome"
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
        fingerprint: "chrome"
      }
    });
  }

  await prisma.policyProfile.upsert({
    where: { id: "default" },
    update: {
      defaultMode: mockPolicies.defaultMode,
      modes: mockPolicies.modes,
      ruleVersion: mockPolicies.ruleVersion,
      ruleUpdatedAt: new Date(mockPolicies.ruleUpdatedAt),
      dnsProfile: mockPolicies.dnsProfile,
      blockAds: mockPolicies.features.blockAds,
      chinaDirect: mockPolicies.features.chinaDirect,
      aiServicesProxy: mockPolicies.features.aiServicesProxy,
      currentVersion: mockVersion.currentVersion,
      minimumVersion: mockVersion.minimumVersion,
      forceUpgrade: mockVersion.forceUpgrade,
      changelog: mockVersion.changelog
    },
    create: {
      id: "default",
      defaultMode: mockPolicies.defaultMode,
      modes: mockPolicies.modes,
      ruleVersion: mockPolicies.ruleVersion,
      ruleUpdatedAt: new Date(mockPolicies.ruleUpdatedAt),
      dnsProfile: mockPolicies.dnsProfile,
      blockAds: mockPolicies.features.blockAds,
      chinaDirect: mockPolicies.features.chinaDirect,
      aiServicesProxy: mockPolicies.features.aiServicesProxy,
      currentVersion: mockVersion.currentVersion,
      minimumVersion: mockVersion.minimumVersion,
      forceUpgrade: mockVersion.forceUpgrade,
      changelog: mockVersion.changelog
    }
  });

  for (const strategy of mockPolicies.strategyGroups) {
    await prisma.strategyGroup.upsert({
      where: { id: strategy.id },
      update: {
        policyId: "default",
        name: strategy.name,
        description: strategy.description,
        defaultNodeId: strategy.defaultNodeId
      },
      create: {
        id: strategy.id,
        policyId: "default",
        name: strategy.name,
        description: strategy.description,
        defaultNodeId: strategy.defaultNodeId
      }
    });
  }

  for (const panel of mockPanels) {
    const panelBaseUrl = panel.panelId === "panel_hk_1" && defaultPanelBaseUrl ? defaultPanelBaseUrl : panel.baseUrl;
    await prisma.panel.upsert({
      where: { id: panel.panelId },
      update: {
        name: panel.name,
        baseUrl: panelBaseUrl,
        apiBasePath: panel.apiBasePath ?? "/panel",
        health: panel.health,
        lastSyncedAt: new Date(panel.lastSyncedAt),
        latencyMs: panel.latencyMs,
        activeUsers: panel.activeUsers,
        syncEnabled: panel.panelId === "panel_hk_1"
      },
      create: {
        id: panel.panelId,
        name: panel.name,
        baseUrl: panelBaseUrl,
        apiBasePath: panel.apiBasePath ?? "/panel",
        health: panel.health,
        lastSyncedAt: new Date(panel.lastSyncedAt),
        latencyMs: panel.latencyMs,
        activeUsers: panel.activeUsers,
        syncEnabled: panel.panelId === "panel_hk_1"
      }
    });
  }

  for (const announcement of mockAnnouncements) {
    await prisma.announcement.upsert({
      where: { id: announcement.id },
      update: {
        title: announcement.title,
        body: announcement.body,
        level: announcement.level,
        publishedAt: new Date(announcement.publishedAt),
        isActive: true
      },
      create: {
        id: announcement.id,
        title: announcement.title,
        body: announcement.body,
        level: announcement.level,
        publishedAt: new Date(announcement.publishedAt),
        isActive: true
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
