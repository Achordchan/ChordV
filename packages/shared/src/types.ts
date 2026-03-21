export type ConnectionMode = "global" | "rule" | "direct";
export type SubscriptionState = "active" | "expired" | "exhausted" | "paused";
export type RuntimeStatus = "idle" | "connecting" | "connected" | "disconnecting" | "error";
export type PlatformTarget = "macos" | "windows" | "android";
export type UserRole = "user" | "admin";
export type UserStatus = "active" | "disabled";
export type PlanScope = "personal" | "team";
export type TeamStatus = "active" | "disabled";
export type TeamMemberRole = "owner" | "member";
export type AnnouncementLevel = "info" | "warning" | "success";
export type AnnouncementDisplayMode = "passive" | "modal_confirm" | "modal_countdown";
export type SubscriptionSourceAction = "created" | "renewed" | "plan_changed" | "adjusted";
export type NodeProbeStatus = "unknown" | "healthy" | "degraded" | "offline";
export type SubscriptionOwnerType = "user" | "team";
export type MeteringStatus = "ok" | "degraded";
export type SessionLeaseStatus = "active" | "expired" | "revoked" | "evicted";
export type SessionEvictedReason = "concurrency_limit";
export type EdgeGatewayStatus = "online" | "offline" | "degraded";
export type XuiPanelStatus = "online" | "offline" | "degraded";
export type AccessMode = "relay" | "xui";

export interface UserProfileDto {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  lastSeenAt: string;
}

export interface SubscriptionStatusDto {
  id?: string;
  ownerType: SubscriptionOwnerType;
  planId: string;
  planName: string;
  totalTrafficGb: number;
  usedTrafficGb: number;
  remainingTrafficGb: number;
  expireAt: string;
  state: SubscriptionState;
  renewable: boolean;
  lastSyncedAt: string;
  teamId?: string | null;
  teamName?: string | null;
  memberUsedTrafficGb?: number | null;
  meteringStatus: MeteringStatus;
  meteringMessage?: string | null;
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
  serverHost: string;
  serverPort: number;
  serverName: string;
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
  level: AnnouncementLevel;
  publishedAt: string;
  displayMode: AnnouncementDisplayMode;
  countdownSeconds: number;
}

export interface ClientVersionDto {
  currentVersion: string;
  minimumVersion: string;
  forceUpgrade: boolean;
  changelog: string[];
  downloadUrl?: string | null;
}

export interface ClientBootstrapDto {
  user: UserProfileDto;
  subscription: SubscriptionStatusDto;
  policies: PolicyBundleDto;
  announcements: AnnouncementDto[];
  version: ClientVersionDto;
  team?: ClientTeamSummaryDto | null;
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
  spiderX: string;
}

export interface GeneratedRuntimeConfigDto {
  sessionId: string;
  leaseId: string;
  leaseExpiresAt: string;
  leaseHeartbeatIntervalSeconds: number;
  leaseGraceSeconds: number;
  node: NodeSummaryDto;
  mode: ConnectionMode;
  localHttpPort: number;
  localSocksPort: number;
  routingProfile: string;
  generatedAt: string;
  features: {
    blockAds: boolean;
    chinaDirect: boolean;
    aiServicesProxy: boolean;
  };
  outbound: RuntimeOutboundDto;
}

export interface UserSubscriptionSummaryDto {
  id: string;
  ownerType: SubscriptionOwnerType;
  planId: string;
  planName: string;
  remainingTrafficGb: number;
  expireAt: string;
  state: SubscriptionState;
  teamId?: string | null;
  teamName?: string | null;
}

export interface AdminUserRecordDto extends UserProfileDto {
  accountType: "personal" | "team";
  teamId: string | null;
  teamName: string | null;
  maxConcurrentSessionsOverride: number | null;
  subscriptionCount: number;
  activeSubscriptionCount: number;
  currentSubscription: UserSubscriptionSummaryDto | null;
}

export interface AdminPlanRecordDto {
  id: string;
  name: string;
  scope: PlanScope;
  totalTrafficGb: number;
  renewable: boolean;
  maxConcurrentSessions: number;
  isActive: boolean;
  subscriptionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSubscriptionRecordDto {
  id: string;
  ownerType: SubscriptionOwnerType;
  userId: string | null;
  userEmail: string | null;
  userDisplayName: string | null;
  teamId: string | null;
  teamName: string | null;
  planId: string;
  planName: string;
  totalTrafficGb: number;
  usedTrafficGb: number;
  remainingTrafficGb: number;
  expireAt: string;
  state: SubscriptionState;
  renewable: boolean;
  sourceAction: SubscriptionSourceAction;
  lastSyncedAt: string;
  nodeCount: number;
  hasNodeAccess: boolean;
}

export interface SubscriptionNodeAccessDto {
  subscriptionId: string;
  nodeIds: string[];
  nodes: NodeSummaryDto[];
}

export interface UpdateSubscriptionNodeAccessInputDto {
  nodeIds: string[];
}

export interface AdminNodeRecordDto extends NodeSummaryDto {
  subscriptionUrl: string | null;
  gatewayStatus: EdgeGatewayStatus;
  statsLastSyncedAt: string | null;
  panelBaseUrl: string | null;
  panelApiBasePath: string | null;
  panelUsername: string | null;
  panelPassword: string | null;
  panelInboundId: number | null;
  panelEnabled: boolean;
  panelStatus: XuiPanelStatus;
  panelLastSyncedAt: string | null;
  panelError: string | null;
  serverName: string;
  serverHost: string;
  serverPort: number;
  shortId: string;
  spiderX: string;
  probeStatus: NodeProbeStatus;
  probeLatencyMs: number | null;
  probeCheckedAt: string | null;
  probeError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminNodePanelInboundDto {
  id: number;
  remark: string;
  port: number;
  protocol: string;
  clientCount: number;
}

export interface AdminAnnouncementRecordDto {
  id: string;
  title: string;
  body: string;
  level: AnnouncementLevel;
  publishedAt: string;
  isActive: boolean;
  displayMode: AnnouncementDisplayMode;
  countdownSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminPolicyRecordDto extends PolicyBundleDto {
  accessMode: AccessMode;
  currentVersion: string;
  minimumVersion: string;
  forceUpgrade: boolean;
  changelog: string[];
  downloadUrl?: string | null;
}

export interface ClientTeamSummaryDto {
  id: string;
  name: string;
  status: TeamStatus;
  role: TeamMemberRole;
}

export interface AdminTeamSubscriptionSummaryDto {
  id: string;
  planId: string;
  planName: string;
  totalTrafficGb: number;
  usedTrafficGb: number;
  remainingTrafficGb: number;
  expireAt: string;
  state: SubscriptionState;
}

export interface AdminTeamMemberRecordDto {
  id: string;
  teamId: string;
  userId: string;
  email: string;
  displayName: string;
  role: TeamMemberRole;
  usedTrafficGb: number;
  createdAt: string;
}

export interface AdminTeamUsageRecordDto {
  id: string;
  teamId: string;
  userId: string;
  userDisplayName: string;
  userEmail: string;
  subscriptionId: string;
  usedTrafficGb: number;
  recordedAt: string;
  recordCount?: number;
  nodeId?: string | null;
  nodeName?: string | null;
  nodeRegion?: string | null;
  memberTotalUsedTrafficGb?: number;
  nodeBreakdown?: AdminTeamUsageNodeSummaryDto[];
}

export interface AdminTeamUsageNodeSummaryDto {
  nodeId: string;
  nodeName: string;
  nodeRegion: string;
  usedTrafficGb: number;
  recordCount: number;
  lastRecordedAt: string;
}

export interface AdminTeamRecordDto {
  id: string;
  name: string;
  ownerUserId: string;
  ownerDisplayName: string;
  ownerEmail: string;
  status: TeamStatus;
  memberCount: number;
  currentSubscription: AdminTeamSubscriptionSummaryDto | null;
  members: AdminTeamMemberRecordDto[];
  usage: AdminTeamUsageRecordDto[];
  createdAt: string;
  updatedAt: string;
}

export interface DashboardSnapshotDto {
  users: number;
  activeSubscriptions: number;
  activeNodes: number;
  announcements: number;
  activePlans: number;
}

export interface AdminSnapshotDto {
  dashboard: DashboardSnapshotDto;
  users: AdminUserRecordDto[];
  plans: AdminPlanRecordDto[];
  subscriptions: AdminSubscriptionRecordDto[];
  teams: AdminTeamRecordDto[];
  nodes: AdminNodeRecordDto[];
  announcements: AdminAnnouncementRecordDto[];
  policy: AdminPolicyRecordDto;
}

export interface AuthSessionDto {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  user: UserProfileDto;
}

export interface CreateUserInputDto {
  email: string;
  password: string;
  displayName: string;
  role: UserRole;
  maxConcurrentSessionsOverride?: number | null;
}

export interface UpdateUserInputDto {
  displayName?: string;
  role?: UserRole;
  status?: UserStatus;
  password?: string;
  maxConcurrentSessionsOverride?: number | null;
}

export interface CreatePlanInputDto {
  name: string;
  scope: PlanScope;
  totalTrafficGb: number;
  renewable: boolean;
  maxConcurrentSessions?: number;
  isActive?: boolean;
}

export interface UpdatePlanInputDto {
  name?: string;
  scope?: PlanScope;
  totalTrafficGb?: number;
  renewable?: boolean;
  maxConcurrentSessions?: number;
  isActive?: boolean;
}

export interface UpdatePlanSecurityInputDto {
  maxConcurrentSessions: number;
}

export interface UpdateUserSecurityInputDto {
  maxConcurrentSessionsOverride?: number | null;
}

export interface SessionHeartbeatInputDto {
  sessionId: string;
}

export interface SessionLeaseStatusDto {
  sessionId: string;
  status: SessionLeaseStatus;
  leaseExpiresAt: string;
  evictedReason?: SessionEvictedReason | null;
}

export interface CreateSubscriptionInputDto {
  userId: string;
  planId: string;
  totalTrafficGb?: number;
  usedTrafficGb?: number;
  expireAt: string;
  state?: SubscriptionState;
}

export interface RenewSubscriptionInputDto {
  expireAt?: string;
  resetTraffic?: boolean;
  totalTrafficGb?: number;
}

export interface ChangeSubscriptionPlanInputDto {
  planId: string;
  totalTrafficGb?: number;
  expireAt?: string;
}

export interface UpdateSubscriptionInputDto {
  totalTrafficGb?: number;
  usedTrafficGb?: number;
  expireAt?: string;
  state?: SubscriptionState;
}

export interface ImportNodeInputDto {
  subscriptionUrl?: string;
  name?: string;
  region?: string;
  provider?: string;
  tags?: string[];
  recommended?: boolean;
  panelBaseUrl?: string;
  panelApiBasePath?: string;
  panelUsername?: string;
  panelPassword?: string;
  panelInboundId?: number;
  panelEnabled?: boolean;
}

export interface UpdateNodeInputDto {
  name?: string;
  region?: string;
  provider?: string;
  tags?: string[];
  recommended?: boolean;
  subscriptionUrl?: string;
  panelBaseUrl?: string | null;
  panelApiBasePath?: string | null;
  panelUsername?: string | null;
  panelPassword?: string | null;
  panelInboundId?: number | null;
  panelEnabled?: boolean;
}

export interface EdgeRelayNodeDto {
  nodeId: string;
  serverHost: string;
  serverPort: number;
  uuid: string;
  flow: string;
  realityPublicKey: string;
  shortId: string;
  serverName: string;
  fingerprint: string;
  spiderX: string;
}

export interface EdgeSessionOpenInputDto {
  sessionId: string;
  leaseId: string;
  subscriptionId: string;
  userId: string;
  node: EdgeRelayNodeDto;
  xrayUserEmail: string;
  xrayUserUuid: string;
  expiresAt: string;
}

export interface EdgeSessionCloseInputDto {
  sessionId: string;
  leaseId: string;
  nodeId: string;
}

export interface EdgeTrafficRecordDto {
  sessionId: string;
  leaseId: string;
  xrayUserEmail: string;
  xrayUserUuid: string;
  uplinkBytes: string;
  downlinkBytes: string;
  sampledAt: string;
}

export interface EdgeTrafficReportInputDto {
  nodeId: string;
  reportedAt: string;
  records: EdgeTrafficRecordDto[];
}

export interface CreateAnnouncementInputDto {
  title: string;
  body: string;
  level: AnnouncementLevel;
  publishedAt?: string;
  isActive?: boolean;
  displayMode?: AnnouncementDisplayMode;
  countdownSeconds?: number;
}

export interface UpdateAnnouncementInputDto {
  title?: string;
  body?: string;
  level?: AnnouncementLevel;
  publishedAt?: string;
  isActive?: boolean;
  displayMode?: AnnouncementDisplayMode;
  countdownSeconds?: number;
}

export interface StrategyGroupInputDto {
  id?: string;
  name: string;
  description: string;
  defaultNodeId: string;
}

export interface CreateTeamInputDto {
  name: string;
  ownerUserId: string;
  status?: TeamStatus;
}

export interface UpdateTeamInputDto {
  name?: string;
  ownerUserId?: string;
  status?: TeamStatus;
}

export interface CreateTeamMemberInputDto {
  userId: string;
  role?: TeamMemberRole;
}

export interface UpdateTeamMemberInputDto {
  role?: TeamMemberRole;
}

export interface KickTeamMemberInputDto {
  disableAccount?: boolean;
}

export interface KickTeamMemberResultDto {
  ok: boolean;
  action: "disconnect_session";
  disconnectedSessionCount: number;
  accountDisabled: boolean;
  message: string;
  team: AdminTeamRecordDto;
  user: AdminUserRecordDto | null;
}

export interface ResetSubscriptionTrafficInputDto {
  userId?: string | null;
}

export interface ResetSubscriptionTrafficResultDto {
  ok: boolean;
  subscriptionId: string;
  userId: string | null;
  clearedBindingCount: number;
  message: string;
  subscription: AdminSubscriptionRecordDto;
  user: AdminUserRecordDto | null;
}

export type ResetUserTrafficResultDto = ResetSubscriptionTrafficResultDto;

export interface CreateTeamSubscriptionInputDto {
  planId: string;
  expireAt: string;
  totalTrafficGb?: number;
  usedTrafficGb?: number;
}

export interface UpdatePolicyInputDto {
  accessMode?: AccessMode;
  defaultMode?: ConnectionMode;
  modes?: ConnectionMode[];
  blockAds?: boolean;
  chinaDirect?: boolean;
  aiServicesProxy?: boolean;
  currentVersion?: string;
  minimumVersion?: string;
  forceUpgrade?: boolean;
  changelog?: string[];
  downloadUrl?: string | null;
}
