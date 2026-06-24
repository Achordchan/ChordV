export type ConnectionMode = "global" | "rule" | "direct";
export type SubscriptionState = "active" | "expired" | "exhausted" | "paused";
export type RuntimeStatus = "idle" | "connecting" | "connected" | "disconnecting" | "error";
export type PlatformTarget = "macos" | "windows" | "android" | "ios";
export type ReleaseChannel = "stable";
export type ReleaseStatus = "draft" | "published" | "archived";
export type ReleaseArtifactType = "dmg" | "app" | "exe" | "setup.exe" | "zip" | "apk" | "ipa" | "external";
export type UpdateDeliveryMode = "desktop_installer_download" | "desktop_full_replace" | "apk_download" | "external_download" | "none";
export type RuntimeComponentArchitecture = "x64" | "arm64";
export type RuntimeComponentKind = "xray" | "geoip" | "geosite";
export type RuntimeComponentSource = "uploaded" | "github_remote" | "custom_remote";
export type RuntimeComponentClientDeliveryStatus =
  | "ready"
  | "disabled"
  | "pending_validation"
  | "unreachable"
  | "save_failed"
  | "missing_hash"
  | "metadata_mismatch"
  | "missing_file"
  | "invalid_url";
export type RuntimeComponentValidationStatus =
  | "ready"
  | "disabled"
  | "pending_validation"
  | "invalid_url"
  | "unreachable"
  | "save_failed"
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
export type SupportTicketStatus = "open" | "waiting_admin" | "waiting_user" | "closed";
export type SupportTicketSource = "desktop";
export type SupportTicketAuthorRole = "user" | "admin" | "system";
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
  | "announcement_updated"
  | "policy_updated"
  | "announcement_read_state_updated"
  | "ticket_updated"
  | "ticket_read_state_updated"
  | "version_updated"
  | "account_updated"
  | "sync_queue_updated"
  | "keepalive";
export type XuiPanelStatus = "online" | "offline" | "degraded";

export interface UserProfileDto {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  lastSeenAt: string;
}

export interface UpdateCurrentAdminSecurityInputDto {
  currentPassword: string;
  email: string;
  newPassword?: string;
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
  countryCode: string | null;
  region: string;
  provider: string;
  tags: string[];
  isActive?: boolean;
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
  passiveSeenAt: string | null;
  acknowledgedAt: string | null;
  isUnread: boolean;
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
  clientDeliverable?: boolean;
  clientDeliveryStatus?: RuntimeComponentClientDeliveryStatus;
  clientDeliveryMessage?: string;
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
  actualFileSizeBytes?: string | null;
  actualFileHash?: string | null;
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
  supportTickets: {
    totalCount: number;
    unreadCount: number;
  };
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
  mldsa65Verify?: string | null;
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
  panelSyncStatus?: "synced" | "pending";
  panelSyncMessage?: string | null;
  panelSyncSummary?: AdminPanelSyncSummaryDto | null;
  message?: string | null;
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
  panelSyncStatus?: "synced" | "pending";
  panelSyncMessage?: string | null;
  message?: string | null;
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
  panelSyncStatus?: "synced" | "pending";
  panelSyncMessage?: string | null;
  panelSyncSummary?: AdminPanelSyncSummaryDto | null;
  message?: string | null;
}

export interface SubscriptionNodeAccessDto {
  subscriptionId: string;
  nodeIds: string[];
  nodes: NodeSummaryDto[];
  revokedSessionCount?: number;
  reasonCode?: SessionReasonCode | null;
  reasonMessage?: string | null;
  panelSyncStatus?: "synced" | "pending";
  panelSyncMessage?: string | null;
  message?: string | null;
}

export interface UpdateSubscriptionNodeAccessInputDto {
  nodeIds: string[];
}

export interface AdminNodeRecordDto extends NodeSummaryDto {
  subscriptionUrl: string | null;
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
  mldsa65Verify?: string | null;
  probeStatus: NodeProbeStatus;
  probeLatencyMs: number | null;
  probeCheckedAt: string | null;
  probeError: string | null;
  panelSyncTotalCount?: number;
  panelSyncPendingCount?: number;
  panelSyncRunningCount?: number;
  panelSyncFailedCount?: number;
  panelSyncLastError?: string | null;
  panelSyncStatus?: "synced" | "pending";
  panelSyncMessage?: string | null;
  message?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AdminPanelSyncJobStatus = "pending" | "running" | "failed" | "completed";
export type AdminPanelSyncJobAction = "ensure_client" | "disable_client" | "delete_client" | "reset_client_traffic";

export interface AdminPanelSyncJobDto {
  id: string;
  action: AdminPanelSyncJobAction;
  status: AdminPanelSyncJobStatus;
  nodeId: string;
  nodeName: string;
  subscriptionId: string;
  userId: string | null;
  teamId: string | null;
  panelClientEmail: string;
  attempts: number;
  nextRunAt: string;
  lockedAt: string | null;
  lastError: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminLeaseRevocationJobDto {
  id: string;
  reason: string;
  status: AdminPanelSyncJobStatus;
  subscriptionId: string | null;
  userId: string | null;
  nodeId: string | null;
  nodeName: string | null;
  attempts: number;
  nextRunAt: string;
  lockedAt: string | null;
  lastError: string | null;
  completedAt: string | null;
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

export type AdminPolicyRecordDto = PolicyBundleDto;

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
  panelSyncStatus?: "synced" | "pending";
  panelSyncMessage?: string | null;
  panelSyncSummary?: AdminPanelSyncSummaryDto | null;
  message?: string | null;
}

export interface AdminPanelSyncSummaryDto {
  pending: number;
  running: number;
  failed: number;
  total: number;
  lastError: string | null;
}

export interface DeleteTeamMemberResultDto {
  ok: true;
  panelSyncStatus?: "synced" | "pending";
  panelSyncMessage?: string | null;
  message?: string | null;
}

export interface DashboardSnapshotDto {
  users: number;
  teams: number;
  activeSubscriptions: number;
  activeNodes: number;
  announcements: number;
  activePlans: number;
  openTickets: number;
  waitingAdminTickets: number;
  closedTickets: number;
}

export interface AdminSnapshotDto {
  dashboard: DashboardSnapshotDto;
  users: AdminUserRecordDto[];
  plans: AdminPlanRecordDto[];
  subscriptions: AdminSubscriptionRecordDto[];
  teams: AdminTeamRecordDto[];
  nodes: AdminNodeRecordDto[];
  panelSyncJobs: AdminPanelSyncJobDto[];
  leaseRevocationJobs: AdminLeaseRevocationJobDto[];
  announcements: AdminAnnouncementRecordDto[];
  policy: AdminPolicyRecordDto;
  releases: AdminReleaseRecordDto[];
}

export interface AdminImageBedConfigDto {
  baseUrl: string;
  uploadFolder: string | null;
  uploadChannel: string | null;
  channelName: string | null;
  hasToken: boolean;
  tokenPreview: string | null;
  tokenSource: "database" | "environment" | "none";
  updatedAt: string | null;
}

export interface AdminUploadLimitsDto {
  releaseArtifactMaxBytes: number;
  runtimeComponentMaxBytes: number;
  supportTicketAttachmentMaxBytes: number;
}

export interface UpdateAdminImageBedConfigInputDto {
  baseUrl?: string;
  apiToken?: string | null;
  uploadFolder?: string | null;
  uploadChannel?: string | null;
  channelName?: string | null;
}

export interface UploadedSupportTicketAttachmentInputDto {
  body?: string | null;
}

export interface AdminImageBedFileDto {
  name: string;
  url: string;
  mimeType: string | null;
  fileSizeBytes: string | null;
  uploadedAt: string | null;
  channel: string | null;
}

export interface AdminImageBedFileListDto {
  files: AdminImageBedFileDto[];
  directories: string[];
  totalCount: number;
  returnedCount: number;
  indexLastUpdated: string | null;
}

export interface DeleteAdminImageBedFileResultDto {
  success: boolean;
  fileId: string | null;
  deleted: string[];
  failed: string[];
}

export interface ClientPingDto {
  ok: boolean;
  serverTime: string;
}

export interface SupportTicketAttachmentDto {
  id: string;
  url: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: string | null;
  createdAt: string;
}

export type SupportTicketAttachmentUploadStatus = "none" | "uploaded" | "failed";

export interface ClientSupportTicketMessageDto {
  id: string;
  ticketId: string;
  authorRole: SupportTicketAuthorRole;
  authorDisplayName: string | null;
  body: string;
  attachments: SupportTicketAttachmentDto[];
  createdAt: string;
}

export interface ClientSupportTicketSummaryDto {
  id: string;
  title: string;
  status: SupportTicketStatus;
  source: SupportTicketSource;
  subscriptionId: string | null;
  teamId: string | null;
  teamName: string | null;
  lastMessageAt: string;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessagePreview: string | null;
  hasUnreadMessages: boolean;
  unreadCount: number;
  lastReadAt: string | null;
}

export interface ClientSupportTicketDetailDto extends ClientSupportTicketSummaryDto {
  messages: ClientSupportTicketMessageDto[];
  attachmentUploadStatus?: SupportTicketAttachmentUploadStatus;
  attachmentUploadError?: string | null;
}

export interface AdminSupportTicketMessageDto {
  id: string;
  ticketId: string;
  authorRole: SupportTicketAuthorRole;
  authorUserId: string | null;
  authorDisplayName: string | null;
  authorEmail: string | null;
  body: string;
  attachments: SupportTicketAttachmentDto[];
  createdAt: string;
}

export interface AdminSupportTicketSummaryDto {
  id: string;
  title: string;
  status: SupportTicketStatus;
  source: SupportTicketSource;
  ownerType: "personal" | "team";
  userId: string;
  userEmail: string;
  userDisplayName: string;
  subscriptionId: string | null;
  teamId: string | null;
  teamName: string | null;
  lastMessageAt: string;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessagePreview: string | null;
}

export interface AdminSupportTicketDetailDto extends AdminSupportTicketSummaryDto {
  messages: AdminSupportTicketMessageDto[];
  attachmentUploadStatus?: SupportTicketAttachmentUploadStatus;
  attachmentUploadError?: string | null;
}

export interface AuthSessionDto {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  user: UserProfileDto;
}

export type AdminSecurityUpdateResultDto =
  | AuthSessionDto
  | {
      ok: true;
      sessionRefreshRequired: true;
      message: string;
    };

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

export interface CreateClientSupportTicketInputDto {
  title: string;
  body: string;
}

export interface ReplyClientSupportTicketInputDto {
  body: string;
}

export interface MarkClientAnnouncementsReadInputDto {
  announcementIds: string[];
  action: "seen" | "ack";
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
  announcementId?: string | null;
  ticketId?: string | null;
  ticketStatus?: SupportTicketStatus | null;
  platform?: PlatformTarget | null;
  channel?: ReleaseChannel | null;
  latestVersion?: string | null;
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
  panelSyncStatus?: "synced" | "pending";
  panelSyncMessage?: string | null;
  message: string;
}

export interface ImportNodeInputDto {
  subscriptionUrl?: string;
  name?: string;
  countryCode?: string;
  region?: string;
  provider?: string;
  tags?: string[];
  isActive?: boolean;
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
  countryCode?: string;
  region?: string;
  provider?: string;
  tags?: string[];
  isActive?: boolean;
  recommended?: boolean;
  subscriptionUrl?: string | null;
  panelBaseUrl?: string | null;
  panelApiBasePath?: string | null;
  panelUsername?: string | null;
  panelPassword?: string | null;
  panelInboundId?: number | null;
  panelEnabled?: boolean;
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
  panelSyncStatus?: "synced" | "pending";
  panelSyncMessage?: string | null;
  message: string;
  reasonCode: SessionReasonCode;
  reasonMessage: string;
  team: AdminTeamRecordDto;
  user: AdminUserRecordDto | null;
}

export interface DisconnectUserResultDto {
  ok: boolean;
  action: "disconnect_session";
  disconnectedSessionCount: number;
  panelSyncStatus?: "synced" | "pending";
  panelSyncMessage?: string | null;
  message: string;
  reasonCode: SessionReasonCode;
  reasonMessage: string;
  user: AdminUserRecordDto;
}

export interface ResetSubscriptionTrafficInputDto {
  userId?: string | null;
}

export interface ResetSubscriptionTrafficResultDto {
  ok: boolean;
  subscriptionId: string;
  userId: string | null;
  clearedBindingCount: number;
  panelSyncStatus?: "synced" | "pending";
  panelSyncMessage?: string | null;
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
  displayTitle?: string;
  changelog?: string[];
  minimumVersion?: string;
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
  status?: Extract<ReleaseStatus, "draft" | "published">;
  publishedAt?: string | null;
}

export interface CreateReleaseArtifactInputDto {
  source?: "external";
  type: ReleaseArtifactType;
  deliveryMode?: UpdateDeliveryMode;
  downloadUrl: string;
  defaultMirrorPrefix?: string | null;
  allowClientMirror?: boolean;
  fileName?: string | null;
  isPrimary?: boolean;
}

export interface CreateRuntimeComponentInputDto {
  platform: PlatformTarget;
  architecture: RuntimeComponentArchitecture;
  kind: RuntimeComponentKind;
  source?: Exclude<RuntimeComponentSource, "uploaded">;
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
  isPrimary?: boolean;
}

export interface UploadReleaseArtifactInputDto {
  source?: "uploaded";
  type: ReleaseArtifactType;
  deliveryMode?: UpdateDeliveryMode;
  defaultMirrorPrefix?: string | null;
  allowClientMirror?: boolean;
  fileName?: string | null;
  isPrimary?: boolean;
}

export interface UpdatePolicyInputDto {
  defaultMode?: ConnectionMode;
  modes?: ConnectionMode[];
  blockAds?: boolean;
  chinaDirect?: boolean;
  aiServicesProxy?: boolean;
}
