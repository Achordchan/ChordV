import type {
  AdminAnnouncementRecordDto,
  AdminNodeRecordDto,
  AdminPlanRecordDto,
  AdminPolicyRecordDto,
  AdminSnapshotDto,
  AdminSubscriptionRecordDto,
  AdminTeamRecordDto,
  AdminUserRecordDto,
  AnnouncementDto,
  AuthSessionDto,
  ClientBootstrapDto,
  ClientVersionDto,
  GeneratedRuntimeConfigDto,
  NodeSummaryDto,
  PolicyBundleDto,
  SubscriptionStatusDto,
  UserProfileDto,
  UserSubscriptionSummaryDto
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
  id: "subscription_demo_001",
  ownerType: "user",
  planId: "plan_pro_100",
  planName: "专业版 100G",
  totalTrafficGb: 100,
  usedTrafficGb: 36.4,
  remainingTrafficGb: 63.6,
  expireAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 18).toISOString(),
  state: "active",
  renewable: true,
  lastSyncedAt: new Date().toISOString(),
  teamId: null,
  teamName: null,
  memberUsedTrafficGb: null,
  meteringStatus: "ok",
  meteringMessage: null
};

export const mockNodes: NodeSummaryDto[] = [
  {
    id: "node_hk_01",
    name: "香港 01",
    region: "香港",
    provider: "自有节点",
    tags: ["流媒体", "低延迟"],
    recommended: true,
    latencyMs: 32,
    protocol: "vless",
    security: "reality",
    serverHost: "hk.edge.chordv.app",
    serverPort: 443,
    serverName: "cdn.cloudflare.com"
  },
  {
    id: "node_sg_01",
    name: "新加坡 01",
    region: "新加坡",
    provider: "自有节点",
    tags: ["AI", "稳定"],
    recommended: false,
    latencyMs: 68,
    protocol: "vless",
    security: "reality",
    serverHost: "sg.edge.chordv.app",
    serverPort: 443,
    serverName: "cdn.cloudflare.com"
  },
  {
    id: "node_jp_01",
    name: "日本 01",
    region: "日本",
    provider: "自有节点",
    tags: ["游戏", "备用"],
    recommended: false,
    latencyMs: 83,
    protocol: "vless",
    security: "reality",
    serverHost: "jp.edge.chordv.app",
    serverPort: 443,
    serverName: "cdn.cloudflare.com"
  }
];

export const mockPolicies: PolicyBundleDto = {
  defaultMode: "rule",
  modes: ["global", "rule", "direct"],
  features: {
    blockAds: true,
    chinaDirect: true,
    aiServicesProxy: true
  }
};

export const mockAnnouncements: AnnouncementDto[] = [
  {
    id: "ann_001",
    title: "客户端已升级",
    body: "管理后台已支持完整资源维护。",
    level: "success",
    publishedAt: new Date().toISOString(),
    displayMode: "passive",
    countdownSeconds: 0
  },
  {
    id: "ann_002",
    title: "维护提醒",
    body: "本周末将进行规则集更新。",
    level: "warning",
    publishedAt: new Date().toISOString(),
    displayMode: "modal_confirm",
    countdownSeconds: 0
  }
];

export const mockVersion: ClientVersionDto = {
  currentVersion: "0.1.0",
  minimumVersion: "0.1.0",
  forceUpgrade: false,
  changelog: ["后台工作台已上线", "节点导入改为订阅驱动", "客户端规则模式已更新"],
  downloadUrl: "https://github.com/Achordchan/ChordV/releases"
};

export const mockBootstrap: ClientBootstrapDto = {
  user: mockUser,
  subscription: mockSubscription,
  policies: mockPolicies,
  announcements: mockAnnouncements,
  version: mockVersion,
  team: null
};

export const mockRuntimeConfig = (nodeId: string): GeneratedRuntimeConfigDto => {
  const node = mockNodes.find((item) => item.id === nodeId) ?? mockNodes[0];
  return {
    sessionId: `session_${node.id}`,
    leaseId: `lease_${node.id}`,
    leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    leaseHeartbeatIntervalSeconds: 20,
    leaseGraceSeconds: 60,
    node,
    mode: "rule",
    localHttpPort: 17890,
    localSocksPort: 17891,
    routingProfile: "managed-rule-default",
    generatedAt: new Date().toISOString(),
    features: {
      blockAds: true,
      chinaDirect: true,
      aiServicesProxy: true
    },
    outbound: {
      protocol: "vless",
      server: `${node.region.toLowerCase()}.edge.chordv.app`,
      port: 443,
      uuid: "d5076fbe-b935-4dc6-8f59-a056d05db6f3",
      flow: "xtls-rprx-vision",
      realityPublicKey: "5C3G02RWVBX3e2tHAh9d69Vk4g8JwG2Zx2N0TTTPD2M",
      shortId: "6ba85179",
      serverName: "cdn.cloudflare.com",
      fingerprint: "chrome",
      spiderX: "/"
    }
  };
};

const mockCurrentSubscription: UserSubscriptionSummaryDto = {
  id: "subscription_demo_001",
  ownerType: "user",
  planId: mockSubscription.planId,
  planName: mockSubscription.planName,
  remainingTrafficGb: mockSubscription.remainingTrafficGb,
  expireAt: mockSubscription.expireAt,
  state: mockSubscription.state,
  teamId: null,
  teamName: null
};

export const mockAdminUsers: AdminUserRecordDto[] = [
  {
    ...mockAdmin,
    accountType: "personal",
    teamId: null,
    teamName: null,
    maxConcurrentSessionsOverride: null,
    subscriptionCount: 0,
    activeSubscriptionCount: 0,
    currentSubscription: null
  },
  {
    ...mockUser,
    accountType: "personal",
    teamId: null,
    teamName: null,
    maxConcurrentSessionsOverride: null,
    subscriptionCount: 1,
    activeSubscriptionCount: 1,
    currentSubscription: mockCurrentSubscription
  }
];

export const mockAdminPlans: AdminPlanRecordDto[] = [
  {
    id: mockSubscription.planId,
    name: mockSubscription.planName,
    scope: "personal",
    totalTrafficGb: mockSubscription.totalTrafficGb,
    renewable: true,
    maxConcurrentSessions: 1,
    isActive: true,
    subscriptionCount: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
];

export const mockAdminSubscriptions: AdminSubscriptionRecordDto[] = [
  {
    id: "subscription_demo_001",
    ownerType: "user",
    userId: mockUser.id,
    userEmail: mockUser.email,
    userDisplayName: mockUser.displayName,
    teamId: null,
    teamName: null,
    planId: mockSubscription.planId,
    planName: mockSubscription.planName,
    totalTrafficGb: mockSubscription.totalTrafficGb,
    usedTrafficGb: mockSubscription.usedTrafficGb,
    remainingTrafficGb: mockSubscription.remainingTrafficGb,
    expireAt: mockSubscription.expireAt,
    state: mockSubscription.state,
    renewable: mockSubscription.renewable,
    sourceAction: "created",
    lastSyncedAt: mockSubscription.lastSyncedAt,
    nodeCount: 2,
    hasNodeAccess: true
  }
];

export const mockAdminTeams: AdminTeamRecordDto[] = [];

export const mockAdminNodes: AdminNodeRecordDto[] = mockNodes.map((node) => ({
  ...node,
  subscriptionUrl: null,
  gatewayStatus: "online",
  statsLastSyncedAt: null,
  panelBaseUrl: null,
  panelApiBasePath: "/",
  panelUsername: null,
  panelPassword: null,
  panelInboundId: null,
  panelEnabled: false,
  panelStatus: "offline",
  panelLastSyncedAt: null,
  panelError: null,
  serverName: "aws.amazon.com",
  serverHost: `${node.region.toLowerCase()}.edge.chordv.app`,
  serverPort: 443,
  shortId: "6ba85179",
  spiderX: "/",
  probeStatus: "unknown",
  probeLatencyMs: null,
  probeCheckedAt: null,
  probeError: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
}));

export const mockAdminAnnouncements: AdminAnnouncementRecordDto[] = mockAnnouncements.map((item) => ({
  ...item,
  isActive: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
}));

export const mockAdminPolicy: AdminPolicyRecordDto = {
  ...mockPolicies,
  accessMode: "xui",
  currentVersion: mockVersion.currentVersion,
  minimumVersion: mockVersion.minimumVersion,
  forceUpgrade: mockVersion.forceUpgrade,
  changelog: mockVersion.changelog,
  downloadUrl: mockVersion.downloadUrl
};

export const mockAdminSnapshot: AdminSnapshotDto = {
  dashboard: {
    users: mockAdminUsers.length,
    activeSubscriptions: mockAdminSubscriptions.filter((item) => item.state === "active").length,
    activeNodes: mockAdminNodes.length,
    announcements: mockAdminAnnouncements.filter((item) => item.isActive).length,
    activePlans: mockAdminPlans.filter((item) => item.isActive).length
  },
  users: mockAdminUsers,
  plans: mockAdminPlans,
  subscriptions: mockAdminSubscriptions,
  teams: mockAdminTeams,
  nodes: mockAdminNodes,
  announcements: mockAdminAnnouncements,
  policy: mockAdminPolicy
};

export const mockAuthSession = (email: string): AuthSessionDto => ({
  accessToken: `access_${tokenize(email)}`,
  refreshToken: `refresh_${tokenize(email)}`,
  accessTokenExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  user: email.startsWith("admin") ? mockAdmin : { ...mockUser, email }
});

function tokenize(value: string) {
  return value.trim().toLowerCase().replaceAll("@", "_at_").replaceAll(".", "_dot_");
}
