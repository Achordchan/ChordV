import type {
  AdminPanelConfigDto,
  AdminNodeRecordDto,
  AdminSnapshotDto,
  AdminSubscriptionRecordDto,
  AnnouncementDto,
  AuthSessionDto,
  ClientBootstrapDto,
  ClientVersionDto,
  GeneratedRuntimeConfigDto,
  NodeSummaryDto,
  PanelSyncStatusDto,
  PolicyBundleDto,
  SubscriptionStatusDto,
  UserProfileDto
} from "./types";

export const mockUser: UserProfileDto = {
  id: "user_001",
  email: "demo@chordv.app",
  displayName: "演示用户",
  role: "user",
  status: "active",
  lastSeenAt: new Date().toISOString()
};

export const mockAdmin: UserProfileDto = {
  id: "admin_001",
  email: "admin@chordv.app",
  displayName: "运营管理员",
  role: "admin",
  status: "active",
  lastSeenAt: new Date().toISOString()
};

export const mockSubscription: SubscriptionStatusDto = {
  planId: "plan_pro_100",
  planName: "Pro 100G",
  totalTrafficGb: 100,
  usedTrafficGb: 36.4,
  remainingTrafficGb: 63.6,
  expireAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 18).toISOString(),
  state: "active",
  renewable: true,
  lastSyncedAt: new Date().toISOString()
};

export const mockNodes: NodeSummaryDto[] = [
  {
    id: "node_hk_01",
    name: "Hong Kong 01",
    region: "Hong Kong",
    provider: "Akari",
    tags: ["streaming", "low-latency"],
    recommended: true,
    latencyMs: 32,
    protocol: "vless",
    security: "reality"
  },
  {
    id: "node_sg_01",
    name: "Singapore 01",
    region: "Singapore",
    provider: "Akari",
    tags: ["ai", "stable"],
    recommended: false,
    latencyMs: 68,
    protocol: "vless",
    security: "reality"
  },
  {
    id: "node_jp_01",
    name: "Tokyo 01",
    region: "Japan",
    provider: "Akari",
    tags: ["gaming", "backup"],
    recommended: false,
    latencyMs: 83,
    protocol: "vless",
    security: "reality"
  }
];

export const mockPolicies: PolicyBundleDto = {
  defaultMode: "rule",
  modes: ["global", "rule", "direct"],
  strategyGroups: [
    {
      id: "sg_auto",
      name: "Auto Route",
      description: "Balanced routing for AI, streaming, and direct mainland traffic",
      defaultNodeId: "node_hk_01"
    },
    {
      id: "sg_streaming",
      name: "Streaming Priority",
      description: "Prefer media optimized routes",
      defaultNodeId: "node_sg_01"
    }
  ],
  ruleVersion: "2026.03.17",
  ruleUpdatedAt: new Date().toISOString(),
  dnsProfile: "remote-secure",
  features: {
    blockAds: true,
    chinaDirect: true,
    aiServicesProxy: true
  }
};

export const mockAnnouncements: AnnouncementDto[] = [
  {
    id: "ann_001",
    title: "运行架构已就绪",
    body: "ChordV 现在已经通过业务后端统一下发受控运行配置。",
    level: "success",
    publishedAt: new Date().toISOString()
  },
  {
    id: "ann_002",
    title: "例行维护提醒",
    body: "香港面板将在本周末进行证书轮换维护。",
    level: "warning",
    publishedAt: new Date().toISOString()
  }
];

export const mockVersion: ClientVersionDto = {
  currentVersion: "0.1.0",
  minimumVersion: "0.1.0",
  forceUpgrade: false,
  changelog: [
    "桌面端原型已具备连接与断开链路",
    "后台已具备用户、面板与公告视图",
    "已接入 3x-ui 同步契约"
  ]
};

export const mockPanels: PanelSyncStatusDto[] = [
  {
    panelId: "panel_hk_1",
    name: "Hong Kong Edge",
    health: "healthy",
    baseUrl: "https://panel.hk.example.com",
    apiBasePath: "/panel",
    lastSyncedAt: new Date().toISOString(),
    latencyMs: 118,
    activeUsers: 142
  },
  {
    panelId: "panel_sg_1",
    name: "Singapore Edge",
    health: "degraded",
    baseUrl: "https://panel.sg.example.com",
    apiBasePath: "/panel",
    lastSyncedAt: new Date().toISOString(),
    latencyMs: 191,
    activeUsers: 88
  }
];

export const mockBootstrap: ClientBootstrapDto = {
  user: mockUser,
  subscription: mockSubscription,
  policies: mockPolicies,
  announcements: mockAnnouncements,
  version: mockVersion
};

export const mockRuntimeConfig = (nodeId: string): GeneratedRuntimeConfigDto => {
  const node = mockNodes.find((item) => item.id === nodeId) ?? mockNodes[0];
  return {
    sessionId: `session_${node.id}`,
    node,
    mode: "rule",
    localHttpPort: 17890,
    localSocksPort: 17891,
    routingProfile: "managed-rule-default",
    generatedAt: new Date().toISOString(),
    outbound: {
      protocol: "vless",
      server: `${node.region.toLowerCase().replaceAll(" ", "-")}.edge.chordv.app`,
      port: 443,
      uuid: "d5076fbe-b935-4dc6-8f59-a056d05db6f3",
      flow: "xtls-rprx-vision",
      realityPublicKey: "5C3G02RWVBX3e2tHAh9d69Vk4g8JwG2Zx2N0TTTPD2M",
      shortId: "6ba85179",
      serverName: "cdn.cloudflare.com",
      fingerprint: "chrome"
      ,
      spiderX: "/"
    }
  };
};

export const mockAdminSnapshot: AdminSnapshotDto = {
  dashboard: {
    users: 248,
    activeSubscriptions: 201,
    activeNodes: mockNodes.length,
    announcements: mockAnnouncements.length,
    panelHealth: "healthy"
  },
  users: [mockAdmin, mockUser],
  subscriptions: [toAdminSubscription(mockSubscription)],
  nodes: toAdminNodes(mockNodes),
  panels: toAdminPanels(mockPanels),
  announcements: mockAnnouncements
};

export const mockAuthSession = (email: string): AuthSessionDto => ({
  accessToken: `access_${tokenize(email)}`,
  refreshToken: `refresh_${tokenize(email)}`,
  user: email.startsWith("admin") ? mockAdmin : { ...mockUser, email }
});

function tokenize(value: string) {
  return value.trim().toLowerCase().replaceAll("@", "_at_").replaceAll(".", "_dot_");
}

function toAdminSubscription(subscription: typeof mockSubscription): AdminSubscriptionRecordDto {
  return {
    id: "subscription_demo_001",
    userId: mockUser.id,
    userEmail: mockUser.email,
    userDisplayName: mockUser.displayName,
    planId: subscription.planId,
    planName: subscription.planName,
    panelClientEmail: "Admin",
    totalTrafficGb: subscription.totalTrafficGb,
    usedTrafficGb: subscription.usedTrafficGb,
    remainingTrafficGb: subscription.remainingTrafficGb,
    expireAt: subscription.expireAt,
    state: subscription.state,
    renewable: subscription.renewable,
    lastSyncedAt: subscription.lastSyncedAt
  };
}

function toAdminPanels(panels: typeof mockPanels): AdminPanelConfigDto[] {
  return panels.map((panel) => ({
    panelId: panel.panelId,
    name: panel.name,
    baseUrl: panel.baseUrl,
    apiBasePath: panel.apiBasePath ?? "/panel",
    username: panel.panelId === "panel_hk_1" ? "achord" : null,
    syncEnabled: panel.panelId === "panel_hk_1",
    health: panel.health,
    lastSyncedAt: panel.lastSyncedAt,
    latencyMs: panel.latencyMs,
    activeUsers: panel.activeUsers
  }));
}

function toAdminNodes(nodes: typeof mockNodes): AdminNodeRecordDto[] {
  return nodes.map((node) => ({
    ...node,
    panelId: node.id === "node_hk_01" ? "panel_hk_1" : null,
    subscriptionUrl: null,
    serverName: "aws.amazon.com",
    serverHost: `${node.region.toLowerCase().replaceAll(" ", "-")}.edge.chordv.app`,
    serverPort: 443,
    shortId: "6ba85179",
    spiderX: "/"
  }));
}
