export type ConnectionMode = "global" | "rule" | "direct";
export type SubscriptionState = "active" | "expired" | "exhausted" | "paused";
export type RuntimeStatus = "idle" | "connecting" | "connected" | "disconnecting" | "error";
export type PlatformTarget = "macos" | "windows" | "android" | "ios";
export type ReleaseChannel = "stable";
export type ReleaseStatus = "draft" | "published";
export type ReleaseArtifactType = "dmg" | "app" | "exe" | "setup.exe" | "apk" | "ipa" | "external";
export type UpdateDeliveryMode = "desktop_installer_download" | "apk_download" | "external_download" | "none";
export type RuntimeComponentArchitecture = "x64" | "arm64";
export type RuntimeComponentKind = "xray" | "geoip" | "geosite";
export type RuntimeComponentSource = "uploaded" | "github_remote" | "custom_remote";
export type RuntimeComponentValidationStatus =
  | "ready"
  | "disabled"
  | "invalid_url"
  | "unreachable"
  | "missing_file"
  | "metadata_mismatch";
export type RuntimeDownloadFailureReason =
  | "download_failed"
  | "http_error"
  | "hash_mismatch"
  | "archive_entry_missing"
  | "filesystem_write_failed"
  | "permission_denied"
  | "unknown";
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
export type SessionReasonCode =
  | "admin_paused_connection"
  | "node_access_revoked"
  | "subscription_expired"
  | "subscription_exhausted"
  | "subscription_paused"
  | "connection_taken_over"
  | "auth_invalid"
  | "session_invalid"
  | "session_expired"
  | "account_disabled"
  | "team_access_revoked"
  | "runtime_credentials_rotated";
export type ClientRuntimeEventType =
  | "session_revoked"
  | "subscription_updated"
  | "node_access_updated"
  | "account_updated"
  | "keepalive";
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
  stateReasonCode?: SessionReasonCode | null;
  stateReasonMessage?: string | null;
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

export interface ClientNodeProbeResultDto {
  nodeId: string;
  status: "healthy" | "offline";
  latencyMs: number | null;
  checkedAt: string;
  error: string | null;
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

export interface AdminReleaseArtifactDto {
  id: string;
  releaseId: string;
  source: "uploaded" | "external";
  type: ReleaseArtifactType;
  deliveryMode: UpdateDeliveryMode;
  downloadUrl: string;
  originDownloadUrl?: string | null;
  finalUrlPreview?: string | null;
  defaultMirrorPrefix: string | null;
  allowClientMirror: boolean;
  fileName: string | null;
  fileSizeBytes: string | null;
  fileHash: string | null;
  isPrimary: boolean;
  isFullPackage: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminReleaseArtifactValidationDto {
  artifactId: string;
  status: "ready" | "missing_file" | "metadata_mismatch" | "missing_download_url" | "invalid_link";
  message: string;
  actualFileSizeBytes?: string | null;
  actualFileHash?: string | null;
}

export interface AdminReleaseRecordDto {
  id: string;
  platform: PlatformTarget;
  channel: ReleaseChannel;
  version: string;
  displayTitle: string;
  changelog: string[];
  minimumVersion: string;
  forceUpgrade: boolean;
  status: ReleaseStatus;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  artifacts: AdminReleaseArtifactDto[];
}

export interface AdminRuntimeComponentRecordDto {
  id: string;
  platform: PlatformTarget;
  architecture: RuntimeComponentArchitecture;
  kind: RuntimeComponentKind;
  source: RuntimeComponentSource;
  originUrl: string;
  defaultMirrorPrefix: string | null;
  allowClientMirror: boolean;
  fileName: string;
  archiveEntryName: string | null;
  expectedHash: string | null;
  fileSizeBytes?: string | null;
  fileHash?: string | null;
  enabled: boolean;
  finalUrlPreview: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminRuntimeComponentValidationDto {
  componentId: string;
  status: RuntimeComponentValidationStatus;
  message: string;
  finalUrlPreview: string;
  httpStatus?: number | null;
}

export interface AdminRuntimeComponentFailureReportDto {
  id: string;
  componentId: string | null;
  componentLabel: string;
  platform: PlatformTarget;
  architecture: RuntimeComponentArchitecture;
  kind: RuntimeComponentKind;
  reason: RuntimeDownloadFailureReason | string;
  message: string | null;
  effectiveUrl: string | null;
  appVersion: string | null;
  userId: string | null;
  createdAt: string;
}

export interface ClientRuntimeComponentDownloadCandidateDto {
  label: "client_mirror" | "default_mirror" | "origin";
  url: string;
}

export interface ClientRuntimeComponentPlanItemDto {
  id: string;
  platform: PlatformTarget;
  architecture: RuntimeComponentArchitecture;
  kind: RuntimeComponentKind;
  fileName: string;
  fileSizeBytes?: string | null;
  archiveEntryName?: string | null;
  expectedHash?: string | null;
  allowClientMirror: boolean;
  originUrl: string;
  defaultMirrorPrefix?: string | null;
  resolvedUrl: string;
  candidates: ClientRuntimeComponentDownloadCandidateDto[];
}

export interface ClientRuntimeComponentsPlanDto {
  platform: PlatformTarget;
  architecture: RuntimeComponentArchitecture;
  components: ClientRuntimeComponentPlanItemDto[];
}

export interface ClientUpdateCheckDto {
  currentVersion: string;
  platform: PlatformTarget;
  channel: ReleaseChannel;
  artifactType?: ReleaseArtifactType | null;
  clientMirrorPrefix?: string | null;
}

export interface ClientUpdateCheckResultDto {
  hasUpdate: boolean;
  forceUpgrade: boolean;
  blockedByMinimumVersion?: boolean;
  forcedByRelease?: boolean;
  updateRequirement?: "optional" | "required_minimum" | "required_release";
  currentVersion: string;
  latestVersion: string;
  minimumVersion: string;
  platform: PlatformTarget;
  channel: ReleaseChannel;
  changelog: string[];
  deliveryMode: UpdateDeliveryMode;
  downloadUrl?: string | null;
  fileName?: string | null;
  fileSizeBytes?: string | null;
  fileHash?: string | null;
  recommendedArtifact?: AdminReleaseArtifactDto | null;
  publishedAt?: string | null;
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
  stateReasonCode?: SessionReasonCode | null;
  stateReasonMessage?: string | null;
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
  stateReasonCode?: SessionReasonCode | null;
  stateReasonMessage?: string | null;
}

export interface SubscriptionNodeAccessDto {
  subscriptionId: string;
  nodeIds: string[];
  nodes: NodeSummaryDto[];
  revokedSessionCount?: number;
  reasonCode?: SessionReasonCode | null;
  reasonMessage?: string | null;
  message?: string | null;
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
  stateReasonCode?: SessionReasonCode | null;
  stateReasonMessage?: string | null;
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
  releases: AdminReleaseRecordDto[];
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
  reasonCode?: SessionReasonCode | null;
  reasonMessage?: string | null;
  detailReason?: string | null;
}

export interface ClientRuntimeEventDto {
  type: ClientRuntimeEventType;
  occurredAt: string;
  sessionId?: string | null;
  subscriptionId?: string | null;
  nodeId?: string | null;
  reasonCode?: SessionReasonCode | null;
  reasonMessage?: string | null;
  subscriptionState?: SubscriptionState | null;
  state?: SubscriptionState | null;
  reconnectRecommended?: boolean | null;
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

export interface ConvertSubscriptionToTeamInputDto {
  targetTeamId: string;
}

export interface ConvertSubscriptionToTeamResultDto {
  ok: boolean;
  deletedSubscriptionId: string;
  teamId: string;
  teamName: string;
  teamSubscriptionId: string;
  message: string;
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
  reasonCode: SessionReasonCode;
  reasonMessage: string;
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

export interface CreateReleaseInputDto {
  platform: PlatformTarget;
  channel: ReleaseChannel;
  version: string;
  displayTitle: string;
  changelog?: string[];
  minimumVersion: string;
  forceUpgrade?: boolean;
  status?: ReleaseStatus;
  publishedAt?: string | null;
  initialArtifact?: CreateReleaseArtifactInputDto | null;
}

export interface UpdateReleaseInputDto {
  displayTitle?: string;
  changelog?: string[];
  minimumVersion?: string;
  forceUpgrade?: boolean;
  status?: ReleaseStatus;
  publishedAt?: string | null;
}

export interface CreateReleaseArtifactInputDto {
  source?: "uploaded" | "external";
  type: ReleaseArtifactType;
  deliveryMode?: UpdateDeliveryMode;
  downloadUrl: string;
  defaultMirrorPrefix?: string | null;
  allowClientMirror?: boolean;
  fileName?: string | null;
  fileSizeBytes?: string | null;
  fileHash?: string | null;
  isPrimary?: boolean;
  isFullPackage?: boolean;
}

export interface CreateRuntimeComponentInputDto {
  platform: PlatformTarget;
  architecture: RuntimeComponentArchitecture;
  kind: RuntimeComponentKind;
  source?: RuntimeComponentSource;
  originUrl?: string;
  defaultMirrorPrefix?: string | null;
  allowClientMirror?: boolean;
  fileName: string;
  archiveEntryName?: string | null;
  expectedHash?: string | null;
  enabled?: boolean;
}

export interface UploadRuntimeComponentInputDto {
  platform: PlatformTarget;
  architecture: RuntimeComponentArchitecture;
  kind: RuntimeComponentKind;
  fileName?: string | null;
  expectedHash?: string | null;
  enabled?: boolean;
}

export interface UpdateRuntimeComponentInputDto {
  source?: RuntimeComponentSource;
  originUrl?: string;
  defaultMirrorPrefix?: string | null;
  allowClientMirror?: boolean;
  fileName?: string;
  archiveEntryName?: string | null;
  expectedHash?: string | null;
  enabled?: boolean;
}

export interface ClientRuntimeComponentsPlanInputDto {
  platform: PlatformTarget;
  architecture: RuntimeComponentArchitecture;
  clientMirrorPrefix?: string | null;
}

export interface ClientRuntimeComponentFailureReportInputDto {
  componentId?: string | null;
  platform: PlatformTarget;
  architecture: RuntimeComponentArchitecture;
  kind: RuntimeComponentKind;
  reason: RuntimeDownloadFailureReason | string;
  message?: string | null;
  effectiveUrl?: string | null;
  appVersion?: string | null;
}

export interface UpdateReleaseArtifactInputDto {
  source?: "uploaded" | "external";
  type?: ReleaseArtifactType;
  deliveryMode?: UpdateDeliveryMode;
  downloadUrl?: string;
  defaultMirrorPrefix?: string | null;
  allowClientMirror?: boolean;
  fileName?: string | null;
  fileSizeBytes?: string | null;
  fileHash?: string | null;
  isPrimary?: boolean;
  isFullPackage?: boolean;
}

export interface UploadReleaseArtifactInputDto {
  source?: "uploaded" | "external";
  type: ReleaseArtifactType;
  deliveryMode?: UpdateDeliveryMode;
  defaultMirrorPrefix?: string | null;
  allowClientMirror?: boolean;
  fileName?: string | null;
  isPrimary?: boolean;
  isFullPackage?: boolean;
}

export interface UpdatePolicyInputDto {
  accessMode?: AccessMode;
  defaultMode?: ConnectionMode;
  modes?: ConnectionMode[];
  blockAds?: boolean;
  chinaDirect?: boolean;
  aiServicesProxy?: boolean;
}
