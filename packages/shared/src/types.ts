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
  statsEnabled: boolean;
  statsApiUrl: string | null;
  statsLastSyncedAt: string | null;
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
  user: UserProfileDto;
}

export interface CreateUserInputDto {
  email: string;
  password: string;
  displayName: string;
  role: UserRole;
}

export interface UpdateUserInputDto {
  displayName?: string;
  role?: UserRole;
  status?: UserStatus;
  password?: string;
}

export interface CreatePlanInputDto {
  name: string;
  scope: PlanScope;
  totalTrafficGb: number;
  renewable: boolean;
  isActive?: boolean;
}

export interface UpdatePlanInputDto {
  name?: string;
  scope?: PlanScope;
  totalTrafficGb?: number;
  renewable?: boolean;
  isActive?: boolean;
}

export interface CreateSubscriptionInputDto {
  userId: string;
  planId: string;
  totalTrafficGb?: number;
  usedTrafficGb?: number;
  expireAt: string;
  state?: SubscriptionState;
  renewable?: boolean;
}

export interface RenewSubscriptionInputDto {
  expireAt?: string;
  extendDays?: number;
  resetTraffic?: boolean;
  totalTrafficGb?: number;
}

export interface ChangeSubscriptionPlanInputDto {
  planId: string;
  totalTrafficGb?: number;
  expireAt?: string;
  renewable?: boolean;
}

export interface UpdateSubscriptionInputDto {
  totalTrafficGb?: number;
  usedTrafficGb?: number;
  expireAt?: string;
  state?: SubscriptionState;
  renewable?: boolean;
}

export interface ImportNodeInputDto {
  subscriptionUrl: string;
  name?: string;
  region?: string;
  provider?: string;
  tags?: string[];
  recommended?: boolean;
  statsEnabled?: boolean;
  statsApiUrl?: string;
  statsApiToken?: string;
}

export interface UpdateNodeInputDto {
  name?: string;
  region?: string;
  provider?: string;
  tags?: string[];
  recommended?: boolean;
  subscriptionUrl?: string;
  statsEnabled?: boolean;
  statsApiUrl?: string;
  statsApiToken?: string;
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

export interface CreateTeamSubscriptionInputDto {
  planId: string;
  expireAt: string;
  totalTrafficGb?: number;
  usedTrafficGb?: number;
  renewable?: boolean;
}

export interface UpdatePolicyInputDto {
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
