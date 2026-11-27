import { ForbiddenException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type {
  ClientRuntimeEventType,
  SessionEvictedReason,
  SessionReasonCode,
  SubscriptionState,
  TeamStatus
} from "@chordv/shared";
import { getSubscriptionStateReason, readEffectiveSubscriptionState } from "./subscription.utils";

export const LEASE_TTL_SECONDS = Number(process.env.CHORDV_SESSION_LEASE_TTL_SECONDS ?? 1800);
export const LEASE_HEARTBEAT_INTERVAL_SECONDS = Number(process.env.CHORDV_SESSION_HEARTBEAT_INTERVAL_SECONDS ?? 30);
export const LEASE_GRACE_SECONDS = Number(process.env.CHORDV_SESSION_GRACE_SECONDS ?? 300);

/**
 * How long a connected client may go WITHOUT reaching the control plane before
 * its session is given up on — by the client, which keeps its tunnel up for
 * this long while heartbeats fail for reasons that are not an answer (no route,
 * timeout, 5xx), and by the control plane, which keeps the silent lease
 * resumable for the same period.
 *
 * It exists because the tunnel does not depend on the control plane: the
 * client talks to the node, and the node serves from its own configuration.
 * Before this, the only thing that took a desktop user offline when the
 * control plane was unreachable was the client itself, disconnecting after
 * LEASE_GRACE_SECONDS of failed heartbeats.
 *
 * 0 restores that behaviour exactly.
 */
export const DEFAULT_LEASE_OFFLINE_HOLD_SECONDS = 24 * 60 * 60;

export function resolveLeaseOfflineHoldSeconds(raw: string | undefined): number {
  const value = raw?.trim() ?? "";
  if (!/^\d+$/.test(value)) return DEFAULT_LEASE_OFFLINE_HOLD_SECONDS;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : DEFAULT_LEASE_OFFLINE_HOLD_SECONDS;
}

export const LEASE_OFFLINE_HOLD_SECONDS = resolveLeaseOfflineHoldSeconds(
  process.env.CHORDV_SESSION_OFFLINE_HOLD_SECONDS
);
export const SECURITY_REASON_CONCURRENCY = "concurrency_limit";
export const DEFAULT_MAX_CONCURRENT_SESSIONS = 3;

export type LeaseDiagnosticFields = {
  sessionId: string;
  status: string;
  lastHeartbeatAt: string;
  expiresAt: string;
  graceDeadline: string;
  revokedReason: string | null;
};

export type PanelBindingFailure = {
  bindingId: string;
  nodeId: string;
  nodeName: string;
  panelClientEmail: string;
  error: string;
};

export type PanelBindingMutationResult = {
  requested: number;
  updated: number;
  failed: PanelBindingFailure[];
};

export function buildLeaseEmail(userId: string, leaseId: string) {
  return `${userId}.${leaseId}@lease.chordv`;
}

export function buildPanelClientEmail(userEmail: string, subscriptionId: string, nodeId: string, userId: string) {
  const sanitizedEmail = userEmail.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const sanitizedSubscription = subscriptionId.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const sanitizedUser = userId.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const nodeHash = createHash("sha1").update(nodeId).digest("hex").slice(0, 10);
  return [sanitizedEmail || "user", sanitizedSubscription.slice(-8), `node${nodeHash}`, sanitizedUser.slice(-8)].join("_");
}

export function buildSnapshotKey(nodeId: string, subscriptionId: string, userId: string | null) {
  const userPart = userId ?? "subscription";
  return `${nodeId}:${subscriptionId}:${userPart}`;
}

export function getLeaseGraceDeadline(expiresAt: Date, graceSeconds = LEASE_GRACE_SECONDS) {
  return new Date(expiresAt.getTime() + graceSeconds * 1000);
}

export function isLeaseHardExpired(expiresAt: Date, now: Date, graceSeconds = LEASE_GRACE_SECONDS) {
  return now.getTime() > getLeaseGraceDeadline(expiresAt, graceSeconds).getTime();
}

export function getLeaseHardExpireCutoff(now: Date, graceSeconds = LEASE_GRACE_SECONDS) {
  return new Date(now.getTime() - graceSeconds * 1000);
}

/**
 * A lease is STALE once it is hard-expired (isLeaseHardExpired): the client has
 * been silent past the TTL and the grace. Stale is not gone. It no longer counts
 * as a connection anywhere — presence and the concurrency limit both read
 * expiresAt — but for LEASE_OFFLINE_HOLD_SECONDS more its client may resume it
 * with a heartbeat. Past that it is abandoned, and only then revoked.
 */
export function isLeaseAbandoned(
  expiresAt: Date,
  now: Date,
  graceSeconds = LEASE_GRACE_SECONDS,
  offlineHoldSeconds = LEASE_OFFLINE_HOLD_SECONDS
) {
  return isLeaseHardExpired(expiresAt, now, graceSeconds + offlineHoldSeconds);
}

export function getLeaseAbandonCutoff(
  now: Date,
  graceSeconds = LEASE_GRACE_SECONDS,
  offlineHoldSeconds = LEASE_OFFLINE_HOLD_SECONDS
) {
  return getLeaseHardExpireCutoff(now, graceSeconds + offlineHoldSeconds);
}

export function buildLeaseDiagnosticFields(
  lease: {
    sessionId: string;
    status: string;
    lastHeartbeatAt: Date;
    expiresAt: Date;
    revokedReason?: string | null;
  },
  graceSeconds = LEASE_GRACE_SECONDS
): LeaseDiagnosticFields {
  return {
    sessionId: lease.sessionId,
    status: lease.status,
    lastHeartbeatAt: lease.lastHeartbeatAt.toISOString(),
    expiresAt: lease.expiresAt.toISOString(),
    graceDeadline: getLeaseGraceDeadline(lease.expiresAt, graceSeconds).toISOString(),
    revokedReason: lease.revokedReason ?? null
  };
}

export function shouldProvisionPanelClients(subscription: {
  state: SubscriptionState;
  expireAt: Date;
  remainingTrafficGb: number;
  team?: { status: TeamStatus } | null;
  user?: { status: "active" | "disabled" } | null;
}) {
  if (readEffectiveSubscriptionState(subscription) !== "active") {
    return false;
  }
  if (subscription.team && subscription.team.status !== "active") {
    return false;
  }
  if (subscription.user && subscription.user.status !== "active") {
    return false;
  }
  return true;
}

export function shouldDeletePanelClients(subscription: {
  state: SubscriptionState;
  expireAt: Date;
  remainingTrafficGb: number;
}) {
  const state = readEffectiveSubscriptionState(subscription);
  return state === "expired" || state === "exhausted";
}

export function assertSubscriptionConnectable(subscription: {
  state: SubscriptionState;
  remainingTrafficGb: number;
  expireAt: Date;
}) {
  const state = readEffectiveSubscriptionState(subscription);
  if (state === "paused") {
    throw new ForbiddenException("当前订阅已暂停");
  }
  if (state === "expired") {
    throw new ForbiddenException("当前订阅已到期");
  }
  if (state === "exhausted") {
    throw new ForbiddenException("当前订阅流量已用尽");
  }
}

export function getLeaseFailureDetails(
  status: "expired" | "revoked" | "evicted",
  revokedReason?: string | null
): {
  reasonCode: SessionReasonCode;
  reasonMessage: string;
  detailReason: string | null;
  evictedReason: SessionEvictedReason | null;
} {
  switch (revokedReason) {
    case SECURITY_REASON_CONCURRENCY:
      return {
        reasonCode: "connection_taken_over",
        reasonMessage: "当前连接已被其他设备接管",
        detailReason: revokedReason,
        evictedReason: "concurrency_limit"
      };
    case "team_member_disconnected":
    case "admin_user_disconnected":
      return {
        reasonCode: "admin_paused_connection",
        reasonMessage: "管理员已暂停当前连接",
        detailReason: revokedReason,
        evictedReason: null
      };
    case "node_access_revoked":
      return {
        reasonCode: "node_access_revoked",
        reasonMessage: "当前节点已被取消授权",
        detailReason: revokedReason,
        evictedReason: null
      };
    case "subscription_expired":
    case "subscription_exhausted":
    case "subscription_paused": {
      const reason = getSubscriptionStateReason(revokedReason.replace("subscription_", "") as SubscriptionState);
      return {
        reasonCode: reason.reasonCode ?? "session_invalid",
        reasonMessage: reason.reasonMessage ?? "当前连接已失效，请重新连接",
        detailReason: revokedReason,
        evictedReason: null
      };
    }
    case "user_disabled":
    case "subscription_user_disabled":
      return {
        reasonCode: "account_disabled",
        reasonMessage: "当前账号已禁用，连接已失效",
        detailReason: revokedReason,
        evictedReason: null
      };
    case "team_membership_missing":
    case "team_member_removed":
    case "team_disabled":
      return {
        reasonCode: "team_access_revoked",
        reasonMessage: "当前成员已失去团队访问权限，连接已失效",
        detailReason: revokedReason,
        evictedReason: null
      };
    case "panel_client_rotated":
      return {
        reasonCode: "runtime_credentials_rotated",
        reasonMessage: "当前连接凭据已更新，请重新连接",
        detailReason: revokedReason,
        evictedReason: null
      };
    case "lease_expired":
      return {
        reasonCode: "session_expired",
        reasonMessage: "当前连接已过期，请重新连接",
        detailReason: revokedReason,
        evictedReason: null
      };
    case "revoked_by_client":
      return {
        reasonCode: "session_invalid",
        reasonMessage: "当前连接已断开",
        detailReason: revokedReason,
        evictedReason: null
      };
    case "subscription_missing":
    case "subscription_owner_missing":
    case "subscription_owner_mismatch":
    case "lease_renew_failed":
    case "edge_open_failed":
    case "panel_client_disabled":
      return {
        reasonCode: "session_invalid",
        reasonMessage: "当前连接已失效，请重新连接",
        detailReason: revokedReason,
        evictedReason: null
      };
    default:
      if (status === "expired") {
        return {
          reasonCode: "session_expired",
          reasonMessage: "当前连接已过期，请重新连接",
          detailReason: revokedReason ?? null,
          evictedReason: null
        };
      }
      if (status === "evicted") {
        return {
          reasonCode: "connection_taken_over",
          reasonMessage: "当前连接已被其他设备接管",
          detailReason: revokedReason ?? null,
          evictedReason: "concurrency_limit"
        };
      }
      return {
        reasonCode: "session_invalid",
        reasonMessage: "当前连接已失效，请重新连接",
        detailReason: revokedReason ?? null,
        evictedReason: null
      };
  }
}

export function toClientRuntimeEventType(reasonCode: SessionReasonCode): ClientRuntimeEventType {
  if (
    reasonCode === "subscription_expired" ||
    reasonCode === "subscription_exhausted" ||
    reasonCode === "subscription_paused"
  ) {
    return "subscription_updated";
  }
  if (reasonCode === "node_access_revoked") {
    return "node_access_updated";
  }
  if (reasonCode === "account_disabled" || reasonCode === "team_access_revoked") {
    return "account_updated";
  }
  return "session_revoked";
}
