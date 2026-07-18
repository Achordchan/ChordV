-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('user', 'admin');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "PlanScope" AS ENUM ('personal', 'team');

-- CreateEnum
CREATE TYPE "TeamStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "TeamMemberRole" AS ENUM ('owner', 'member');

-- CreateEnum
CREATE TYPE "SubscriptionState" AS ENUM ('active', 'expired', 'exhausted', 'paused');

-- CreateEnum
CREATE TYPE "SubscriptionSourceAction" AS ENUM ('created', 'renewed', 'plan_changed', 'adjusted');

-- CreateEnum
CREATE TYPE "NodeProbeStatus" AS ENUM ('unknown', 'healthy', 'degraded', 'offline');

-- CreateEnum
CREATE TYPE "MeteringIncidentStatus" AS ENUM ('open', 'resolved');

-- CreateEnum
CREATE TYPE "XuiPanelStatus" AS ENUM ('online', 'offline', 'degraded');

-- CreateEnum
CREATE TYPE "NodeSessionLeaseStatus" AS ENUM ('active', 'expired', 'revoked', 'evicted');

-- CreateEnum
CREATE TYPE "SecurityEventType" AS ENUM ('session_evicted', 'session_revoked');

-- CreateEnum
CREATE TYPE "AnnouncementLevel" AS ENUM ('info', 'warning', 'success');

-- CreateEnum
CREATE TYPE "AnnouncementDisplayMode" AS ENUM ('passive', 'modal_confirm', 'modal_countdown');

-- CreateEnum
CREATE TYPE "ReleasePlatform" AS ENUM ('macos', 'windows', 'android', 'ios');

-- CreateEnum
CREATE TYPE "ReleaseChannel" AS ENUM ('stable');

-- CreateEnum
CREATE TYPE "ReleaseStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "ReleaseArtifactType" AS ENUM ('dmg', 'app', 'exe', 'setup_exe', 'zip', 'apk', 'ipa', 'external');

-- CreateEnum
CREATE TYPE "ReleaseArtifactSource" AS ENUM ('uploaded', 'external');

-- CreateEnum
CREATE TYPE "RuntimeComponentArchitecture" AS ENUM ('x64', 'arm64');

-- CreateEnum
CREATE TYPE "RuntimeComponentKind" AS ENUM ('xray', 'geoip', 'geosite');

-- CreateEnum
CREATE TYPE "SupportTicketStatus" AS ENUM ('open', 'waiting_admin', 'waiting_user', 'closed');

-- CreateEnum
CREATE TYPE "SupportTicketSource" AS ENUM ('desktop');

-- CreateEnum
CREATE TYPE "SupportTicketAuthorRole" AS ENUM ('user', 'admin', 'system');

-- CreateEnum
CREATE TYPE "RuntimeComponentSource" AS ENUM ('uploaded', 'github_remote', 'custom_remote');

-- CreateEnum
CREATE TYPE "UpdateDeliveryMode" AS ENUM ('desktop_installer_download', 'desktop_full_replace', 'apk_download', 'external_download', 'none');

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "status" "UserStatus" NOT NULL,
    "authVersion" INTEGER NOT NULL DEFAULT 1,
    "maxConcurrentSessionsOverride" INTEGER,
    "passwordHash" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientRoutingRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT,
    "value" TEXT NOT NULL,
    "matchType" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientRoutingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "PlanScope" NOT NULL DEFAULT 'personal',
    "totalTrafficGb" DOUBLE PRECISION NOT NULL,
    "renewable" BOOLEAN NOT NULL,
    "maxConcurrentSessions" INTEGER NOT NULL DEFAULT 3,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "teamId" TEXT,
    "planId" TEXT NOT NULL,
    "totalTrafficGb" DOUBLE PRECISION NOT NULL,
    "usedTrafficGb" DOUBLE PRECISION NOT NULL,
    "remainingTrafficGb" DOUBLE PRECISION NOT NULL,
    "expireAt" TIMESTAMP(3) NOT NULL,
    "state" "SubscriptionState" NOT NULL,
    "renewable" BOOLEAN NOT NULL,
    "sourceAction" "SubscriptionSourceAction" NOT NULL DEFAULT 'created',
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "status" "TeamStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "TeamMemberRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrafficLedger" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "nodeId" TEXT,
    "usedTrafficGb" DOUBLE PRECISION NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrafficLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Node" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "countryCode" TEXT,
    "region" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "tags" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "recommended" BOOLEAN NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "protocol" TEXT NOT NULL,
    "security" TEXT NOT NULL,
    "serverHost" TEXT NOT NULL,
    "serverPort" INTEGER NOT NULL,
    "uuid" TEXT NOT NULL,
    "flow" TEXT NOT NULL,
    "realityPublicKey" TEXT NOT NULL,
    "shortId" TEXT NOT NULL,
    "serverName" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "spiderX" TEXT NOT NULL DEFAULT '/',
    "mldsa65Verify" TEXT NOT NULL DEFAULT '',
    "subscriptionUrl" TEXT,
    "statsLastSyncedAt" TIMESTAMP(3),
    "probeStatus" "NodeProbeStatus" NOT NULL DEFAULT 'unknown',
    "probeLatencyMs" INTEGER,
    "probeCheckedAt" TIMESTAMP(3),
    "probeError" TEXT,
    "panelBaseUrl" TEXT,
    "panelApiBasePath" TEXT DEFAULT '/',
    "panelUsername" TEXT,
    "panelPassword" TEXT,
    "panelInboundId" INTEGER,
    "panelEnabled" BOOLEAN NOT NULL DEFAULT false,
    "panelStatus" "XuiPanelStatus" NOT NULL DEFAULT 'offline',
    "panelLastSyncedAt" TIMESTAMP(3),
    "panelError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Node_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionNodeAccess" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionNodeAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeteringIncident" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "MeteringIncidentStatus" NOT NULL DEFAULT 'open',
    "detail" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeteringIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrafficSnapshot" (
    "id" TEXT NOT NULL,
    "snapshotKey" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "userId" TEXT,
    "teamId" TEXT,
    "uplinkBytes" BIGINT NOT NULL DEFAULT 0,
    "downlinkBytes" BIGINT NOT NULL DEFAULT 0,
    "totalBytes" BIGINT NOT NULL DEFAULT 0,
    "sampledAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrafficSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "blockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "NodeSessionLease" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "xrayUserEmail" TEXT NOT NULL,
    "xrayUserUuid" TEXT NOT NULL,
    "status" "NodeSessionLeaseStatus" NOT NULL DEFAULT 'active',
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NodeSessionLease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" TEXT NOT NULL,
    "type" "SecurityEventType" NOT NULL,
    "userId" TEXT,
    "subscriptionId" TEXT,
    "nodeId" TEXT,
    "leaseId" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PanelClientBinding" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "userId" TEXT,
    "teamId" TEXT,
    "nodeId" TEXT NOT NULL,
    "panelClientEmail" TEXT NOT NULL,
    "panelClientId" TEXT NOT NULL,
    "panelInboundId" INTEGER NOT NULL,
    "lastUplinkBytes" BIGINT NOT NULL DEFAULT 0,
    "lastDownlinkBytes" BIGINT NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PanelClientBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PanelSyncJob" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "userId" TEXT,
    "teamId" TEXT,
    "nodeId" TEXT NOT NULL,
    "panelClientEmail" TEXT NOT NULL,
    "panelClientId" TEXT NOT NULL,
    "panelInboundId" INTEGER NOT NULL,
    "panelBaseUrl" TEXT,
    "panelApiBasePath" TEXT,
    "panelUsername" TEXT,
    "panelPassword" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PanelSyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaseRevocationJob" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "userId" TEXT,
    "nodeId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaseRevocationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyProfile" (
    "id" TEXT NOT NULL,
    "defaultMode" TEXT NOT NULL,
    "modes" TEXT[],
    "ruleVersion" TEXT NOT NULL,
    "ruleUpdatedAt" TIMESTAMP(3) NOT NULL,
    "dnsProfile" TEXT NOT NULL,
    "blockAds" BOOLEAN NOT NULL,
    "chinaDirect" BOOLEAN NOT NULL,
    "aiServicesProxy" BOOLEAN NOT NULL,
    "currentVersion" TEXT NOT NULL,
    "minimumVersion" TEXT NOT NULL,
    "forceUpgrade" BOOLEAN NOT NULL DEFAULT false,
    "changelog" TEXT[],
    "downloadUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolicyProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "teamId" TEXT,
    "title" TEXT NOT NULL,
    "status" "SupportTicketStatus" NOT NULL,
    "source" "SupportTicketSource" NOT NULL DEFAULT 'desktop',
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicketMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorRole" "SupportTicketAuthorRole" NOT NULL,
    "authorUserId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportTicketMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicketAttachment" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSizeBytes" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportTicketAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicketReadState" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastReadMessageAt" TIMESTAMP(3),
    "lastReadAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportTicketReadState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyGroup" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "defaultNodeId" TEXT NOT NULL,

    CONSTRAINT "StrategyGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "level" "AnnouncementLevel" NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "displayMode" "AnnouncementDisplayMode" NOT NULL DEFAULT 'passive',
    "countdownSeconds" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnnouncementReadState" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "passiveSeenAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnnouncementReadState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Release" (
    "id" TEXT NOT NULL,
    "platform" "ReleasePlatform" NOT NULL,
    "channel" "ReleaseChannel" NOT NULL,
    "version" TEXT NOT NULL,
    "displayTitle" TEXT NOT NULL,
    "releaseNotes" TEXT,
    "changelog" TEXT[],
    "minimumVersion" TEXT NOT NULL,
    "forceUpgrade" BOOLEAN NOT NULL DEFAULT false,
    "status" "ReleaseStatus" NOT NULL DEFAULT 'draft',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Release_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReleaseArtifact" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "source" "ReleaseArtifactSource" NOT NULL DEFAULT 'external',
    "type" "ReleaseArtifactType" NOT NULL,
    "deliveryMode" "UpdateDeliveryMode" NOT NULL DEFAULT 'external_download',
    "downloadUrl" TEXT NOT NULL,
    "defaultMirrorPrefix" TEXT,
    "allowClientMirror" BOOLEAN NOT NULL DEFAULT false,
    "fileName" TEXT,
    "storedFilePath" TEXT,
    "fileSizeBytes" BIGINT,
    "fileHash" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isFullPackage" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReleaseArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuntimeComponent" (
    "id" TEXT NOT NULL,
    "platform" "ReleasePlatform" NOT NULL,
    "architecture" "RuntimeComponentArchitecture" NOT NULL,
    "kind" "RuntimeComponentKind" NOT NULL,
    "source" "RuntimeComponentSource" NOT NULL DEFAULT 'github_remote',
    "originUrl" TEXT NOT NULL,
    "defaultMirrorPrefix" TEXT,
    "allowClientMirror" BOOLEAN NOT NULL DEFAULT false,
    "fileName" TEXT NOT NULL,
    "storedFilePath" TEXT,
    "fileSizeBytes" BIGINT,
    "fileHash" TEXT,
    "archiveEntryName" TEXT,
    "expectedHash" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuntimeComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuntimeComponentFailureReport" (
    "id" TEXT NOT NULL,
    "componentId" TEXT,
    "platform" "ReleasePlatform" NOT NULL,
    "architecture" "RuntimeComponentArchitecture" NOT NULL,
    "kind" "RuntimeComponentKind" NOT NULL,
    "reason" TEXT NOT NULL,
    "message" TEXT,
    "effectiveUrl" TEXT,
    "appVersion" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuntimeComponentFailureReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "ClientRoutingRule_userId_enabled_updatedAt_idx" ON "ClientRoutingRule"("userId", "enabled", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClientRoutingRule_userId_matchType_value_key" ON "ClientRoutingRule"("userId", "matchType", "value");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMember_teamId_userId_key" ON "TeamMember"("teamId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMember_userId_key" ON "TeamMember"("userId");

-- CreateIndex
CREATE INDEX "TrafficLedger_teamId_subscriptionId_userId_recordedAt_idx" ON "TrafficLedger"("teamId", "subscriptionId", "userId", "recordedAt");

-- CreateIndex
CREATE INDEX "TrafficLedger_teamId_userId_nodeId_recordedAt_idx" ON "TrafficLedger"("teamId", "userId", "nodeId", "recordedAt");

-- CreateIndex
CREATE INDEX "SubscriptionNodeAccess_subscriptionId_nodeId_idx" ON "SubscriptionNodeAccess"("subscriptionId", "nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionNodeAccess_subscriptionId_nodeId_key" ON "SubscriptionNodeAccess"("subscriptionId", "nodeId");

-- CreateIndex
CREATE INDEX "MeteringIncident_subscriptionId_status_openedAt_idx" ON "MeteringIncident"("subscriptionId", "status", "openedAt");

-- CreateIndex
CREATE INDEX "MeteringIncident_nodeId_status_openedAt_idx" ON "MeteringIncident"("nodeId", "status", "openedAt");

-- CreateIndex
CREATE INDEX "MeteringIncident_subscriptionId_nodeId_reason_status_idx" ON "MeteringIncident"("subscriptionId", "nodeId", "reason", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TrafficSnapshot_snapshotKey_key" ON "TrafficSnapshot"("snapshotKey");

-- CreateIndex
CREATE INDEX "TrafficSnapshot_nodeId_subscriptionId_idx" ON "TrafficSnapshot"("nodeId", "subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_expiresAt_idx" ON "RefreshToken"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_revokedAt_createdAt_idx" ON "RefreshToken"("userId", "revokedAt", "createdAt");

-- CreateIndex
CREATE INDEX "RateLimitBucket_updatedAt_idx" ON "RateLimitBucket"("updatedAt");

-- CreateIndex
CREATE INDEX "RateLimitBucket_blockedUntil_idx" ON "RateLimitBucket"("blockedUntil");

-- CreateIndex
CREATE UNIQUE INDEX "NodeSessionLease_sessionId_key" ON "NodeSessionLease"("sessionId");

-- CreateIndex
CREATE INDEX "NodeSessionLease_userId_status_expiresAt_idx" ON "NodeSessionLease"("userId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "NodeSessionLease_subscriptionId_status_expiresAt_idx" ON "NodeSessionLease"("subscriptionId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "NodeSessionLease_nodeId_status_expiresAt_idx" ON "NodeSessionLease"("nodeId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_type_createdAt_idx" ON "SecurityEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_userId_createdAt_idx" ON "SecurityEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_subscriptionId_createdAt_idx" ON "SecurityEvent"("subscriptionId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_nodeId_createdAt_idx" ON "SecurityEvent"("nodeId", "createdAt");

-- CreateIndex
CREATE INDEX "PanelClientBinding_subscriptionId_nodeId_status_idx" ON "PanelClientBinding"("subscriptionId", "nodeId", "status");

-- CreateIndex
CREATE INDEX "PanelClientBinding_nodeId_panelClientEmail_idx" ON "PanelClientBinding"("nodeId", "panelClientEmail");

-- CreateIndex
CREATE UNIQUE INDEX "PanelClientBinding_subscriptionId_userId_nodeId_key" ON "PanelClientBinding"("subscriptionId", "userId", "nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "PanelSyncJob_dedupeKey_key" ON "PanelSyncJob"("dedupeKey");

-- CreateIndex
CREATE INDEX "PanelSyncJob_status_nextRunAt_idx" ON "PanelSyncJob"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "PanelSyncJob_nodeId_status_nextRunAt_idx" ON "PanelSyncJob"("nodeId", "status", "nextRunAt");

-- CreateIndex
CREATE INDEX "PanelSyncJob_subscriptionId_status_idx" ON "PanelSyncJob"("subscriptionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LeaseRevocationJob_dedupeKey_key" ON "LeaseRevocationJob"("dedupeKey");

-- CreateIndex
CREATE INDEX "LeaseRevocationJob_status_nextRunAt_idx" ON "LeaseRevocationJob"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "LeaseRevocationJob_subscriptionId_status_nextRunAt_idx" ON "LeaseRevocationJob"("subscriptionId", "status", "nextRunAt");

-- CreateIndex
CREATE INDEX "LeaseRevocationJob_userId_status_nextRunAt_idx" ON "LeaseRevocationJob"("userId", "status", "nextRunAt");

-- CreateIndex
CREATE INDEX "LeaseRevocationJob_nodeId_status_nextRunAt_idx" ON "LeaseRevocationJob"("nodeId", "status", "nextRunAt");

-- CreateIndex
CREATE INDEX "SupportTicket_userId_updatedAt_idx" ON "SupportTicket"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "SupportTicket_status_updatedAt_idx" ON "SupportTicket"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "SupportTicket_teamId_updatedAt_idx" ON "SupportTicket"("teamId", "updatedAt");

-- CreateIndex
CREATE INDEX "SupportTicket_subscriptionId_updatedAt_idx" ON "SupportTicket"("subscriptionId", "updatedAt");

-- CreateIndex
CREATE INDEX "SupportTicketMessage_ticketId_createdAt_idx" ON "SupportTicketMessage"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportTicketMessage_authorUserId_createdAt_idx" ON "SupportTicketMessage"("authorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportTicketAttachment_ticketId_createdAt_idx" ON "SupportTicketAttachment"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportTicketAttachment_messageId_createdAt_idx" ON "SupportTicketAttachment"("messageId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportTicketReadState_userId_updatedAt_idx" ON "SupportTicketReadState"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "SupportTicketReadState_ticketId_updatedAt_idx" ON "SupportTicketReadState"("ticketId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportTicketReadState_ticketId_userId_key" ON "SupportTicketReadState"("ticketId", "userId");

-- CreateIndex
CREATE INDEX "AnnouncementReadState_userId_updatedAt_idx" ON "AnnouncementReadState"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "AnnouncementReadState_announcementId_updatedAt_idx" ON "AnnouncementReadState"("announcementId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AnnouncementReadState_announcementId_userId_key" ON "AnnouncementReadState"("announcementId", "userId");

-- CreateIndex
CREATE INDEX "Release_platform_channel_status_publishedAt_idx" ON "Release"("platform", "channel", "status", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Release_platform_channel_version_key" ON "Release"("platform", "channel", "version");

-- CreateIndex
CREATE INDEX "ReleaseArtifact_releaseId_isPrimary_idx" ON "ReleaseArtifact"("releaseId", "isPrimary");

-- CreateIndex
CREATE INDEX "RuntimeComponent_platform_architecture_enabled_idx" ON "RuntimeComponent"("platform", "architecture", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeComponent_platform_architecture_kind_key" ON "RuntimeComponent"("platform", "architecture", "kind");

-- CreateIndex
CREATE INDEX "RuntimeComponentFailureReport_platform_architecture_created_idx" ON "RuntimeComponentFailureReport"("platform", "architecture", "createdAt");

-- CreateIndex
CREATE INDEX "RuntimeComponentFailureReport_componentId_createdAt_idx" ON "RuntimeComponentFailureReport"("componentId", "createdAt");

-- AddForeignKey
ALTER TABLE "ClientRoutingRule" ADD CONSTRAINT "ClientRoutingRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrafficLedger" ADD CONSTRAINT "TrafficLedger_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrafficLedger" ADD CONSTRAINT "TrafficLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrafficLedger" ADD CONSTRAINT "TrafficLedger_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrafficLedger" ADD CONSTRAINT "TrafficLedger_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionNodeAccess" ADD CONSTRAINT "SubscriptionNodeAccess_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionNodeAccess" ADD CONSTRAINT "SubscriptionNodeAccess_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeteringIncident" ADD CONSTRAINT "MeteringIncident_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeteringIncident" ADD CONSTRAINT "MeteringIncident_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrafficSnapshot" ADD CONSTRAINT "TrafficSnapshot_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrafficSnapshot" ADD CONSTRAINT "TrafficSnapshot_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrafficSnapshot" ADD CONSTRAINT "TrafficSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrafficSnapshot" ADD CONSTRAINT "TrafficSnapshot_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeSessionLease" ADD CONSTRAINT "NodeSessionLease_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeSessionLease" ADD CONSTRAINT "NodeSessionLease_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeSessionLease" ADD CONSTRAINT "NodeSessionLease_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "NodeSessionLease"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PanelClientBinding" ADD CONSTRAINT "PanelClientBinding_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PanelClientBinding" ADD CONSTRAINT "PanelClientBinding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PanelClientBinding" ADD CONSTRAINT "PanelClientBinding_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PanelClientBinding" ADD CONSTRAINT "PanelClientBinding_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PanelSyncJob" ADD CONSTRAINT "PanelSyncJob_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "PanelClientBinding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PanelSyncJob" ADD CONSTRAINT "PanelSyncJob_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PanelSyncJob" ADD CONSTRAINT "PanelSyncJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PanelSyncJob" ADD CONSTRAINT "PanelSyncJob_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PanelSyncJob" ADD CONSTRAINT "PanelSyncJob_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicketMessage" ADD CONSTRAINT "SupportTicketMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicketMessage" ADD CONSTRAINT "SupportTicketMessage_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicketAttachment" ADD CONSTRAINT "SupportTicketAttachment_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicketAttachment" ADD CONSTRAINT "SupportTicketAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "SupportTicketMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicketReadState" ADD CONSTRAINT "SupportTicketReadState_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicketReadState" ADD CONSTRAINT "SupportTicketReadState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StrategyGroup" ADD CONSTRAINT "StrategyGroup_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "PolicyProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementReadState" ADD CONSTRAINT "AnnouncementReadState_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementReadState" ADD CONSTRAINT "AnnouncementReadState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseArtifact" ADD CONSTRAINT "ReleaseArtifact_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuntimeComponentFailureReport" ADD CONSTRAINT "RuntimeComponentFailureReport_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "RuntimeComponent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

