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

export const LEASE_TTL_SECONDS = Number(process.env.CHORDV_SESSION_LEASE_TTL_SECONDS ?? 600);
export const LEASE_HEARTBEAT_INTERVAL_SECONDS = Number(process.env.CHORDV_SESSION_HEARTBEAT_INTERVAL_SECONDS ?? 30);
export const LEASE_GRACE_SECONDS = Number(process.env.CHORDV_SESSION_GRACE_SECONDS ?? 60);
export const SECURITY_REASON_CONCURRENCY = "concurrency_limit";
export const DEFAULT_MAX_CONCURRENT_SESSIONS = 3;

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
        reasonMessage: "当前账号已禁用，会话已失效",
        detailReason: revokedReason,
        evictedReason: null
      };
    case "team_membership_missing":
    case "team_member_removed":
    case "team_disabled":
      return {
        reasonCode: "team_access_revoked",
        reasonMessage: "当前成员已失去团队访问权限，会话已失效",
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
