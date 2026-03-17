export type ConnectionMode = "global" | "rule" | "direct";
export type SubscriptionState = "active" | "expired" | "exhausted" | "paused";
export type PanelHealth = "healthy" | "degraded" | "offline";
export type RuntimeStatus = "idle" | "connecting" | "connected" | "disconnecting" | "error";
export type PlatformTarget = "macos" | "windows" | "android";

export interface UserProfileDto {
  id: string;
  email: string;
  displayName: string;
  role: "user" | "admin";
  status: "active" | "disabled";
  lastSeenAt: string;
}

export interface SubscriptionStatusDto {
  planId: string;
  planName: string;
  totalTrafficGb: number;
  usedTrafficGb: number;
  remainingTrafficGb: number;
  expireAt: string;
  state: SubscriptionState;
  renewable: boolean;
  lastSyncedAt: string;
}

export interface NodeSummaryDto {
  id: string;
  name: string;
  region: string;
  provider: string;
  tags: string[];
  recommended: boolean;
  latencyMs: number;
  protocol: "vless";
  security: "reality";
}

export interface StrategyGroupDto {
  id: string;
  name: string;
  description: string;
  defaultNodeId: string;
}

export interface PolicyBundleDto {
  defaultMode: ConnectionMode;
  modes: ConnectionMode[];
  strategyGroups: StrategyGroupDto[];
  ruleVersion: string;
  ruleUpdatedAt: string;
  dnsProfile: string;
  features: {
    blockAds: boolean;
    chinaDirect: boolean;
    aiServicesProxy: boolean;
  };
}

export interface AnnouncementDto {
  id: string;
  title: string;
  body: string;
  level: "info" | "warning" | "success";
  publishedAt: string;
}

export interface ClientVersionDto {
  currentVersion: string;
  minimumVersion: string;
  forceUpgrade: boolean;
  changelog: string[];
}

export interface ClientBootstrapDto {
  user: UserProfileDto;
  subscription: SubscriptionStatusDto;
  policies: PolicyBundleDto;
  announcements: AnnouncementDto[];
  version: ClientVersionDto;
}

export interface ConnectRequestDto {
  nodeId: string;
  mode: ConnectionMode;
  strategyGroupId?: string;
}

export interface RuntimeOutboundDto {
  protocol: "vless";
  server: string;
  port: number;
  uuid: string;
  flow: string;
  realityPublicKey: string;
  shortId: string;
  serverName: string;
  fingerprint: string;
}

export interface GeneratedRuntimeConfigDto {
  sessionId: string;
  node: NodeSummaryDto;
  mode: ConnectionMode;
  localHttpPort: number;
  localSocksPort: number;
  routingProfile: string;
  generatedAt: string;
  outbound: RuntimeOutboundDto;
}

export interface PanelSyncStatusDto {
  panelId: string;
  name: string;
  health: PanelHealth;
  baseUrl: string;
  apiBasePath?: string;
  lastSyncedAt: string;
  latencyMs: number;
  activeUsers: number;
}

export interface PanelSyncRunDto {
  panelId: string;
  health: PanelHealth;
  synchronizedUsers: number;
  matchedSubscriptions: number;
  latencyMs: number;
  lastSyncedAt: string;
  error?: string | null;
}

export interface AdminSubscriptionRecordDto {
  id: string;
  userId: string;
  userEmail: string;
  userDisplayName: string;
  planId: string;
  planName: string;
  panelClientEmail: string | null;
  totalTrafficGb: number;
  usedTrafficGb: number;
  remainingTrafficGb: number;
  expireAt: string;
  state: SubscriptionState;
  renewable: boolean;
  lastSyncedAt: string;
}

export interface AdminPanelConfigDto {
  panelId: string;
  name: string;
  baseUrl: string;
  apiBasePath: string;
  username: string | null;
  syncEnabled: boolean;
  health: PanelHealth;
  lastSyncedAt: string;
  latencyMs: number;
  activeUsers: number;
}

export interface UpdateSubscriptionInputDto {
  panelClientEmail?: string | null;
  totalTrafficGb?: number;
  expireAt?: string;
  state?: SubscriptionState;
  renewable?: boolean;
}

export interface UpdatePanelInputDto {
  name?: string;
  baseUrl?: string;
  apiBasePath?: string;
  username?: string | null;
  password?: string | null;
  syncEnabled?: boolean;
}

export interface DashboardSnapshotDto {
  users: number;
  activeSubscriptions: number;
  activeNodes: number;
  announcements: number;
  panelHealth: PanelHealth;
}

export interface AdminSnapshotDto {
  dashboard: DashboardSnapshotDto;
  users: UserProfileDto[];
  subscriptions: AdminSubscriptionRecordDto[];
  nodes: NodeSummaryDto[];
  panels: AdminPanelConfigDto[];
  announcements: AnnouncementDto[];
}

export interface AuthSessionDto {
  accessToken: string;
  refreshToken: string;
  user: UserProfileDto;
}
