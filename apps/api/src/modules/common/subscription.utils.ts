import { BadRequestException } from "@nestjs/common";
import type {
  AdminSubscriptionRecordDto,
  AdminTeamMemberRecordDto,
  AdminTeamRecordDto,
  AdminTeamUsageNodeSummaryDto,
  AdminTeamUsageRecordDto,
  AdminUserRecordDto,
  SessionReasonCode,
  SubscriptionSourceAction,
  SubscriptionState,
  SubscriptionStatusDto,
  TeamMemberRole,
  TeamStatus,
  UserProfileDto,
  UserSubscriptionSummaryDto
} from "@chordv/shared";

export function normalizeOptionalString(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function pickCurrentSubscription<T extends { state: SubscriptionState; expireAt: Date; remainingTrafficGb: number }>(
  rows: T[]
) {
  return (
    rows.find((item) => readEffectiveSubscriptionState(item) === "active") ??
    rows.find((item) => readEffectiveSubscriptionState(item) === "paused") ??
    rows.sort((left, right) => right.expireAt.getTime() - left.expireAt.getTime())[0] ??
    null
  );
}

export function resolveRenewExpireAt(currentExpireAt: Date, explicitExpireAt?: string) {
  if (explicitExpireAt) {
    const date = new Date(explicitExpireAt);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException("到期时间无效");
    }
    return date;
  }
  return currentExpireAt;
}

export function resolveSubscriptionState(preferred: SubscriptionState, remainingTrafficGb: number, expireAt: Date) {
  if (preferred === "paused") return "paused" as const;
  if (preferred === "expired") return "expired" as const;
  if (preferred === "exhausted") return "exhausted" as const;
  if (expireAt.getTime() <= Date.now()) return "expired" as const;
  if (remainingTrafficGb <= 0) return "exhausted" as const;
  return "active" as const;
}

export function readEffectiveSubscriptionState(subscription: {
  state: SubscriptionState;
  expireAt: Date;
  remainingTrafficGb: number;
}) {
  return resolveSubscriptionState(subscription.state, subscription.remainingTrafficGb, subscription.expireAt);
}

export function isEffectiveSubscription(subscription: {
  state: SubscriptionState;
  expireAt: Date;
  remainingTrafficGb: number;
}) {
  const state = readEffectiveSubscriptionState(subscription);
  return state === "active" || state === "paused";
}

export function getSubscriptionStateReason(state: SubscriptionState): {
  reasonCode: SessionReasonCode | null;
  reasonMessage: string | null;
} {
  if (state === "expired") {
    return {
      reasonCode: "subscription_expired",
      reasonMessage: "当前订阅已到期"
    };
  }
  if (state === "exhausted") {
    return {
      reasonCode: "subscription_exhausted",
      reasonMessage: "当前订阅流量已用尽"
    };
  }
  if (state === "paused") {
    return {
      reasonCode: "subscription_paused",
      reasonMessage: "当前订阅已暂停"
    };
  }
  return {
    reasonCode: null,
    reasonMessage: null
  };
}

export function roundTrafficGb(value: number) {
  return Math.round(value * 1000) / 1000;
}

export function toUserProfile(row: {
  id: string;
  email: string;
  displayName: string;
  role: "user" | "admin";
  status: "active" | "disabled";
  lastSeenAt: Date;
}): UserProfileDto {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    lastSeenAt: row.lastSeenAt.toISOString()
  };
}

export function toUserSubscriptionSummary(
  row: {
    id: string;
    planId: string;
    plan: { name: string };
    remainingTrafficGb: number;
    expireAt: Date;
    state: SubscriptionState;
  },
  team: { id: string; name: string } | null
): UserSubscriptionSummaryDto {
  const state = readEffectiveSubscriptionState(row);
  const stateReason = getSubscriptionStateReason(state);
  return {
    id: row.id,
    ownerType: team ? "team" : "user",
    planId: row.planId,
    planName: row.plan.name,
    remainingTrafficGb: row.remainingTrafficGb,
    expireAt: row.expireAt.toISOString(),
    state,
    stateReasonCode: stateReason.reasonCode,
    stateReasonMessage: stateReason.reasonMessage,
    teamId: team?.id ?? null,
    teamName: team?.name ?? null
  };
}

export function toAdminSubscriptionRecord(row: {
  id: string;
  userId: string | null;
  teamId: string | null;
  planId: string;
  totalTrafficGb: number;
  usedTrafficGb: number;
  remainingTrafficGb: number;
  expireAt: Date;
  state: SubscriptionState;
  renewable: boolean;
  sourceAction: SubscriptionSourceAction;
  lastSyncedAt: Date;
  plan: { name: string };
  user: { email: string; displayName: string } | null;
  team: { name: string } | null;
  nodeAccesses?: Array<{ nodeId: string }>;
}): AdminSubscriptionRecordDto {
  const ownerType = row.teamId ? "team" : "user";
  const nodeCount = row.nodeAccesses ? new Set(row.nodeAccesses.map((item) => item.nodeId)).size : 0;
  const state = readEffectiveSubscriptionState(row);
  const stateReason = getSubscriptionStateReason(state);
  return {
    id: row.id,
    ownerType,
    userId: row.userId,
    userEmail: row.user?.email ?? null,
    userDisplayName: row.user?.displayName ?? null,
    teamId: row.teamId,
    teamName: row.team?.name ?? null,
    planId: row.planId,
    planName: row.plan.name,
    totalTrafficGb: row.totalTrafficGb,
    usedTrafficGb: row.usedTrafficGb,
    remainingTrafficGb: row.remainingTrafficGb,
    expireAt: row.expireAt.toISOString(),
    state,
    renewable: row.renewable,
    sourceAction: row.sourceAction,
    lastSyncedAt: row.lastSyncedAt.toISOString(),
    nodeCount,
    hasNodeAccess: nodeCount > 0,
    stateReasonCode: stateReason.reasonCode,
    stateReasonMessage: stateReason.reasonMessage
  };
}

export function toSubscriptionStatusDto(
  row: {
    id: string;
    planId: string;
    totalTrafficGb: number;
    usedTrafficGb: number;
    remainingTrafficGb: number;
    expireAt: Date;
    state: SubscriptionState;
    renewable: boolean;
    lastSyncedAt: Date;
    plan: { name: string };
  },
  team: { id: string; name: string } | null,
  memberUsedTrafficGb: number | null,
  metering: { meteringStatus: "ok" | "degraded"; meteringMessage: string | null }
): SubscriptionStatusDto {
  const state = readEffectiveSubscriptionState(row);
  const stateReason = getSubscriptionStateReason(state);
  return {
    id: row.id,
    ownerType: team ? "team" : "user",
    planId: row.planId,
    planName: row.plan.name,
    totalTrafficGb: row.totalTrafficGb,
    usedTrafficGb: row.usedTrafficGb,
    remainingTrafficGb: row.remainingTrafficGb,
    expireAt: row.expireAt.toISOString(),
    state,
    renewable: row.renewable,
    lastSyncedAt: row.lastSyncedAt.toISOString(),
    teamId: team?.id ?? null,
    teamName: team?.name ?? null,
    memberUsedTrafficGb,
    meteringStatus: metering.meteringStatus,
    meteringMessage: metering.meteringMessage,
    stateReasonCode: stateReason.reasonCode,
    stateReasonMessage: stateReason.reasonMessage
  };
}

export function toAdminTeamMemberRecord(
  row: {
    id: string;
    teamId: string;
    userId: string;
    role: TeamMemberRole;
    createdAt: Date;
    user: { email: string; displayName: string };
  },
  usedTrafficGb: number
): AdminTeamMemberRecordDto {
  return {
    id: row.id,
    teamId: row.teamId,
    userId: row.userId,
    email: row.user.email,
    displayName: row.user.displayName,
    role: row.role,
    usedTrafficGb,
    createdAt: row.createdAt.toISOString()
  };
}

export function summarizeTeamUsageRecords(
  rows: Array<{
    id: string;
    teamId: string;
    userId: string;
    subscriptionId: string;
    nodeId: string | null;
    usedTrafficGb: number;
    recordedAt: Date;
    user: { displayName: string; email: string };
    node: { id: string; name: string; region: string } | null;
  }>
): AdminTeamUsageRecordDto[] {
  const grouped = new Map<
    string,
    {
      id: string;
      teamId: string;
      userId: string;
      userDisplayName: string;
      userEmail: string;
      subscriptionId: string;
      usedTrafficGb: number;
      recordedAt: Date;
      recordCount: number;
      nodeBreakdown: Map<string, AdminTeamUsageNodeSummaryDto>;
    }
  >();

  for (const row of rows) {
    const current =
      grouped.get(row.userId) ??
      {
        id: row.id,
        teamId: row.teamId,
        userId: row.userId,
        userDisplayName: row.user.displayName,
        userEmail: row.user.email,
        subscriptionId: row.subscriptionId,
        usedTrafficGb: 0,
        recordedAt: row.recordedAt,
        recordCount: 0,
        nodeBreakdown: new Map<string, AdminTeamUsageNodeSummaryDto>()
      };

    current.usedTrafficGb += row.usedTrafficGb;
    current.recordCount += 1;
    if (row.recordedAt.getTime() > current.recordedAt.getTime()) {
      current.recordedAt = row.recordedAt;
      current.id = row.id;
    }

    const currentNode =
      current.nodeBreakdown.get(row.nodeId ?? "unknown") ??
      {
        nodeId: row.node?.id ?? row.nodeId ?? "unknown",
        nodeName: row.node?.name ?? "未知节点",
        nodeRegion: row.node?.region ?? "未知",
        usedTrafficGb: 0,
        recordCount: 0,
        lastRecordedAt: row.recordedAt.toISOString()
      };
    currentNode.usedTrafficGb += row.usedTrafficGb;
    currentNode.recordCount += 1;
    if (new Date(currentNode.lastRecordedAt).getTime() < row.recordedAt.getTime()) {
      currentNode.lastRecordedAt = row.recordedAt.toISOString();
    }
    current.nodeBreakdown.set(row.nodeId ?? "unknown", currentNode);
    grouped.set(row.userId, current);
  }

  return Array.from(grouped.values())
    .map((row) => ({
      id: row.id,
      teamId: row.teamId,
      userId: row.userId,
      userDisplayName: row.userDisplayName,
      userEmail: row.userEmail,
      subscriptionId: row.subscriptionId,
      usedTrafficGb: roundTrafficGb(row.usedTrafficGb),
      memberTotalUsedTrafficGb: roundTrafficGb(row.usedTrafficGb),
      recordedAt: row.recordedAt.toISOString(),
      recordCount: row.recordCount,
      nodeBreakdown: Array.from(row.nodeBreakdown.values()).sort(
        (left, right) => new Date(right.lastRecordedAt).getTime() - new Date(left.lastRecordedAt).getTime()
      )
    }))
    .sort((left, right) => new Date(right.recordedAt).getTime() - new Date(left.recordedAt).getTime());
}

export function toAdminTeamRecord(row: {
  id: string;
  name: string;
  ownerUserId: string;
  status: TeamStatus;
  createdAt: Date;
  updatedAt: Date;
  owner: { displayName: string; email: string };
  members: Array<{
    id: string;
    teamId: string;
    userId: string;
    role: TeamMemberRole;
    createdAt: Date;
    user: { email: string; displayName: string };
  }>;
  subscriptions: Array<{
    id: string;
    planId: string;
    totalTrafficGb: number;
    usedTrafficGb: number;
    remainingTrafficGb: number;
    expireAt: Date;
    state: SubscriptionState;
    plan: { name: string };
  }>;
  trafficLedgerEntries: Array<{
    id: string;
    teamId: string;
    userId: string;
    subscriptionId: string;
    nodeId: string | null;
    usedTrafficGb: number;
    recordedAt: Date;
    user: { displayName: string; email: string };
    node: { id: string; name: string; region: string } | null;
  }>;
}): AdminTeamRecordDto {
  const currentSubscription = pickCurrentSubscription(row.subscriptions);
  const usage = summarizeTeamUsageRecords(row.trafficLedgerEntries);
  const usageByUser = new Map(usage.map((item) => [item.userId, item.usedTrafficGb]));

  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.ownerUserId,
    ownerDisplayName: row.owner.displayName,
    ownerEmail: row.owner.email,
    status: row.status,
    memberCount: row.members.length,
    currentSubscription: currentSubscription
      ? (() => {
          const state = readEffectiveSubscriptionState(currentSubscription);
          const stateReason = getSubscriptionStateReason(state);
          return {
            id: currentSubscription.id,
            planId: currentSubscription.planId,
            planName: currentSubscription.plan.name,
            totalTrafficGb: currentSubscription.totalTrafficGb,
            usedTrafficGb: currentSubscription.usedTrafficGb,
            remainingTrafficGb: currentSubscription.remainingTrafficGb,
            expireAt: currentSubscription.expireAt.toISOString(),
            state,
            stateReasonCode: stateReason.reasonCode,
            stateReasonMessage: stateReason.reasonMessage
          };
        })()
      : null,
    members: row.members.map((member) => toAdminTeamMemberRecord(member, usageByUser.get(member.userId) ?? 0)),
    usage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function toAdminUserRecord(row: {
  id: string;
  email: string;
  displayName: string;
  role: "user" | "admin";
  status: "active" | "disabled";
  lastSeenAt: Date;
  maxConcurrentSessionsOverride: number | null;
}, extras: {
  accountType: "personal" | "team";
  teamId: string | null;
  teamName: string | null;
  subscriptionCount: number;
  activeSubscriptionCount: number;
  currentSubscription: UserSubscriptionSummaryDto | null;
}): AdminUserRecordDto {
  return {
    ...toUserProfile(row),
    accountType: extras.accountType,
    teamId: extras.teamId,
    teamName: extras.teamName,
    maxConcurrentSessionsOverride: row.maxConcurrentSessionsOverride ?? null,
    subscriptionCount: extras.subscriptionCount,
    activeSubscriptionCount: extras.activeSubscriptionCount,
    currentSubscription: extras.currentSubscription
  };
}
