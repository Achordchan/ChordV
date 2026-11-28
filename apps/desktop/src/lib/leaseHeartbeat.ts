import type { SessionLeaseStatusDto, SessionReasonCode } from "@chordv/shared";
import { getApiErrorStatus } from "../api/http";

const MAX_LEASE_SECONDS = 2_147_483;

export function readLeaseHeartbeatTiming(value: { leaseHeartbeatIntervalSeconds: number; leaseGraceSeconds: number }) {
  const heartbeat = value.leaseHeartbeatIntervalSeconds, grace = value.leaseGraceSeconds;
  if (!Number.isInteger(heartbeat) || heartbeat < 5 || heartbeat > MAX_LEASE_SECONDS ||
      !Number.isInteger(grace) || grace < 30 || grace > MAX_LEASE_SECONDS) {
    throw new Error("租约心跳参数无效，请重新连接。");
  }
  return { intervalMs: heartbeat * 1000, graceMs: grace * 1000 };
}

type LeaseHeartbeatOutcome =
  | { kind: "active"; lease: SessionLeaseStatusDto }
  | { kind: "terminal"; reasonCode: SessionReasonCode; message: string }
  | { kind: "transient" | "forbidden"; reason: unknown }
  | { kind: "auth_invalid" | "stale" };

type LeaseHeartbeatAttempt = {
  scope: string;
  accessToken: string;
  sessionId: string;
  isCurrent: () => boolean;
  request: (accessToken: string, sessionId: string) => Promise<unknown>;
  recover: () => Promise<{ accessToken: string } | null>;
};

function readReply(value: unknown, sessionId: string): SessionLeaseStatusDto {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("服务器未返回有效续租状态。");
  const reply = value as Record<string, unknown>;
  if (reply.sessionId !== sessionId || typeof reply.status !== "string" || !["active", "expired", "revoked", "evicted"].includes(reply.status)) {
    throw new Error("服务器未返回匹配的续租状态。");
  }
  for (const key of ["reasonCode", "reasonMessage"]) if (reply[key] != null && typeof reply[key] !== "string") throw new Error("服务器未返回有效续租原因。");
  if (reply.status === "active" && (typeof reply.leaseExpiresAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(reply.leaseExpiresAt) ||
      !Number.isFinite(Date.parse(reply.leaseExpiresAt)))) {
    throw new Error("服务器未返回有效续租时间。");
  }
  return reply as unknown as SessionLeaseStatusDto;
}

function failure(reason: unknown): LeaseHeartbeatOutcome {
  const status = getApiErrorStatus(reason);
  if (status === 401) return { kind: "auth_invalid" };
  if (status === 403) return { kind: "forbidden", reason };
  if (status === 404 || status === 409) return { kind: "terminal", reasonCode: "session_invalid", message: "当前连接已失效，请重新连接。" };
  return { kind: "transient", reason };
}

async function attempt(input: LeaseHeartbeatAttempt): Promise<LeaseHeartbeatOutcome> {
  let response: unknown;
  try {
    response = await input.request(input.accessToken, input.sessionId);
  } catch (reason) {
    if (!input.isCurrent()) return { kind: "stale" };
    if (getApiErrorStatus(reason) !== 401) return failure(reason);
    let recovered: { accessToken: string } | null;
    try { recovered = await input.recover(); }
    catch (refreshReason) {
      if (!input.isCurrent()) return { kind: "stale" };
      const status = getApiErrorStatus(refreshReason);
      return status === 401 || status === 403 ? { kind: "auth_invalid" } : { kind: "transient", reason: refreshReason };
    }
    if (!input.isCurrent()) return { kind: "stale" };
    if (!recovered) return { kind: "auth_invalid" };
    if (!recovered.accessToken || recovered.accessToken === input.accessToken) {
      return { kind: "transient", reason: new Error("连接会话暂时无法续期。") };
    }
    try { response = await input.request(recovered.accessToken, input.sessionId); }
    catch (retryReason) { return input.isCurrent() ? failure(retryReason) : { kind: "stale" }; }
  }
  if (!input.isCurrent()) return { kind: "stale" };
  try {
    const lease = readReply(response, input.sessionId);
    if (lease.status === "active") return { kind: "active", lease };
    const knownReasons: SessionReasonCode[] = ["admin_paused_connection", "node_access_revoked", "subscription_expired", "subscription_exhausted", "subscription_paused", "connection_taken_over", "auth_invalid", "session_invalid", "session_expired", "account_disabled", "team_access_revoked", "runtime_credentials_rotated"];
    const fallback = lease.status === "expired" ? "session_expired" : lease.status === "evicted" ? "connection_taken_over" : "session_invalid";
    return { kind: "terminal", reasonCode: lease.reasonCode && knownReasons.includes(lease.reasonCode) ? lease.reasonCode : fallback,
      message: lease.reasonMessage || "当前连接已失效，请重新连接。" };
  } catch (reason) { return { kind: "transient", reason }; }
}

export function createLeaseHeartbeatRunner() {
  let inFlight: { scope: string; task: Promise<LeaseHeartbeatOutcome> } | null = null;
  return {
    run(input: LeaseHeartbeatAttempt): Promise<LeaseHeartbeatOutcome> {
      if (!input.isCurrent()) return Promise.resolve({ kind: "stale" });
      if (inFlight?.scope === input.scope) return inFlight.task;
      const task = attempt(input).finally(() => { if (inFlight?.task === task) inFlight = null; });
      inFlight = { scope: input.scope, task };
      return task;
    }
  };
}

// A timer and a resume check may await the same request; apply its result once.
export function createLeaseHeartbeatObserver(failedAt: { current: number | null } = { current: null }) {
  const handled = new WeakSet<LeaseHeartbeatOutcome>();
  let owner: string | null = null;
  return {
    observe(scope: string, outcome: LeaseHeartbeatOutcome, graceMs: number, nowMs = Date.now()) {
      if (outcome.kind === "stale" || handled.has(outcome)) return "ignore" as const;
      handled.add(outcome);
      if (owner !== scope) { owner = scope; failedAt.current = null; }
      if (outcome.kind === "active") failedAt.current = null;
      if (outcome.kind === "transient") {
        if (failedAt.current === null) failedAt.current = nowMs;
        if (nowMs - failedAt.current >= graceMs) return "grace_exceeded" as const;
      }
      return outcome.kind;
    }
  };
}

export function classifyNativeLeaseHeartbeat(
  event: import("./nativeSession").NativeLeaseHeartbeatEvent,
  activeSessionId: string | null | undefined
) {
  if (!activeSessionId || activeSessionId !== event.sessionId) return "ignore" as const;
  if (event.status === "ok" && event.terminal === false && event.leaseExpiresAt && Number.isFinite(Date.parse(event.leaseExpiresAt))) return "active" as const;
  if (event.status === "error" && event.terminal === true) return "terminal" as const;
  return "transient" as const;
}
