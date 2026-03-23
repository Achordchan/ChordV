import type {
  AdminAnnouncementRecordDto,
  AdminNodeRecordDto,
  AdminPlanRecordDto,
  AdminPolicyRecordDto,
  AdminReleaseRecordDto,
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
    security: "reality"
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
    security: "reality"
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
    security: "reality"
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
  currentVersion: "1.0.2",
  minimumVersion: "1.0.2",
  forceUpgrade: false,
  changelog: ["发布中心已接入多端版本管理", "桌面端支持检查更新和完整包下载", "安卓端支持 APK 更新链路"],
  downloadUrl: "https://v.baymaxgroup.com/downloads/chordv"
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
    maxConcurrentSessions: 3,
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
  accessMode: "xui"
};

export const mockAdminReleases: AdminReleaseRecordDto[] = [
  {
    id: "release_macos_stable_001",
    platform: "macos",
    channel: "stable",
    version: "1.0.2",
    displayTitle: "ChordV 1.0.2 · macOS",
    releaseNotes: "正式版已支持桌面端完整包更新提示。",
    changelog: mockVersion.changelog,
    minimumVersion: "1.0.2",
    forceUpgrade: false,
    status: "published",
    publishedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    artifacts: [
      {
        id: "artifact_macos_dmg_001",
        releaseId: "release_macos_stable_001",
        source: "external",
        type: "dmg",
        deliveryMode: "desktop_installer_download",
        downloadUrl: "https://v.baymaxgroup.com/downloads/chordv/macos/ChordV_1.0.2.dmg",
        defaultMirrorPrefix: null,
        allowClientMirror: true,
        fileName: "ChordV_1.0.2.dmg",
        fileSizeBytes: "94371840",
        fileHash: "mock-macos-dmg-sha256",
        isPrimary: true,
        isFullPackage: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
  },
  {
    id: "release_windows_stable_001",
    platform: "windows",
    channel: "stable",
    version: "1.0.2",
    displayTitle: "ChordV 1.0.2 · Windows",
    releaseNotes: "正式版已支持桌面端完整包更新提示。",
    changelog: mockVersion.changelog,
    minimumVersion: "1.0.2",
    forceUpgrade: false,
    status: "published",
    publishedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    artifacts: [
      {
        id: "artifact_windows_setup_001",
        releaseId: "release_windows_stable_001",
        source: "external",
        type: "setup.exe",
        deliveryMode: "desktop_installer_download",
        downloadUrl: "https://v.baymaxgroup.com/downloads/chordv/windows/ChordV_1.0.2_setup.exe",
        defaultMirrorPrefix: null,
        allowClientMirror: true,
        fileName: "ChordV_1.0.2_setup.exe",
        fileSizeBytes: "32666812",
        fileHash: "mock-windows-setup-sha256",
        isPrimary: true,
        isFullPackage: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
  },
  {
    id: "release_android_stable_001",
    platform: "android",
    channel: "stable",
    version: "1.0.0",
    displayTitle: "ChordV 1.0.0 · Android",
    releaseNotes: "正式版支持 APK 下载更新。",
    changelog: mockVersion.changelog,
    minimumVersion: "1.0.0",
    forceUpgrade: false,
    status: "published",
    publishedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    artifacts: [
      {
        id: "artifact_android_apk_001",
        releaseId: "release_android_stable_001",
        source: "external",
        type: "apk",
        deliveryMode: "apk_download",
        downloadUrl: "https://v.baymaxgroup.com/downloads/chordv/android/ChordV_1.0.0.apk",
        defaultMirrorPrefix: null,
        allowClientMirror: true,
        fileName: "ChordV_1.0.0.apk",
        fileSizeBytes: "59600000",
        fileHash: "mock-android-apk-sha256",
        isPrimary: true,
        isFullPackage: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
  },
  {
    id: "release_ios_stable_001",
    platform: "ios",
    channel: "stable",
    version: "1.0.0",
    displayTitle: "ChordV 1.0.0 · iOS",
    releaseNotes: "当前仅提供版本提示与侧载说明。",
    changelog: mockVersion.changelog,
    minimumVersion: "1.0.0",
    forceUpgrade: false,
    status: "published",
    publishedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    artifacts: [
      {
        id: "artifact_ios_external_001",
        releaseId: "release_ios_stable_001",
        source: "external",
        type: "external",
        deliveryMode: "external_download",
        downloadUrl: "https://v.baymaxgroup.com/downloads/chordv/ios",
        defaultMirrorPrefix: null,
        allowClientMirror: true,
        fileName: "ChordV iOS 侧载说明",
        fileSizeBytes: null,
        fileHash: null,
        isPrimary: true,
        isFullPackage: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
  }
];

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
  policy: mockAdminPolicy,
  releases: mockAdminReleases
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
