export type ProtectedAccessReason = "account_disabled" | "team_access_revoked";

export function resolveProtectedAccessReason(rawMessage: string): ProtectedAccessReason | null {
  if (!rawMessage) {
    return null;
  }
  if (rawMessage.includes("当前账号已禁用") || rawMessage.includes("当前用户已禁用")) {
    return "account_disabled";
  }
  if (rawMessage.includes("当前成员已失去团队访问权限")) {
    return "team_access_revoked";
  }
  return null;
}

export function buildProtectedAccessNotice(reason: ProtectedAccessReason) {
  if (reason === "account_disabled") {
    return {
      title: "账号已禁用",
      message: "当前账号已被管理员禁用，请联系管理员处理。"
    };
  }
  return {
    title: "你已被移出团队",
    message: "当前账号已失去团队订阅，请重新登录或联系管理员处理。"
  };
}

export type LeaseSilencePolicy = {
  leaseGraceSeconds?: number | null;
  leaseOfflineHoldSeconds?: number | null;
};

const MIN_LEASE_GRACE_SECONDS = 30;
const DEFAULT_LEASE_GRACE_SECONDS = 300;

function finiteOr(value: number | null | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * How long the connection is kept while lease heartbeats fail WITHOUT an answer
 * from the control plane — no route, a timeout, a 5xx. Counted from the first
 * such failure.
 *
 * The tunnel does not run through the control plane: it goes to the node, and
 * the node serves from its own configuration. So a control plane that cannot be
 * reached is not a reason to stop, and before the offline hold existed the
 * client disconnecting itself after the grace was the only thing that took a
 * connected user offline during a control-plane outage.
 *
 * A control plane that predates the hold does not send it, and one that sets it
 * to 0 has turned it off; either way this is the grace alone, as before. The
 * control plane keeps a silent lease resumable for TTL + grace + hold from the
 * last heartbeat it saw, which is always later than this window ends, so a
 * client still holding on is one the control plane will still take back.
 *
 * An ANSWER that the session is over (403/404) is never held: see
 * isDefinitiveLeaseFailure.
 */
export function resolveLeaseSilenceToleranceMs(policy: LeaseSilencePolicy | null | undefined) {
  const graceSeconds = Math.max(MIN_LEASE_GRACE_SECONDS, finiteOr(policy?.leaseGraceSeconds, DEFAULT_LEASE_GRACE_SECONDS));
  const holdSeconds = Math.max(0, finiteOr(policy?.leaseOfflineHoldSeconds, 0));
  return (graceSeconds + holdSeconds) * 1000;
}

/**
 * Whether a run of unanswered heartbeats that began at firstFailedAtMs has gone
 * on long enough to give the connection up. A clock that moved backwards
 * (negative elapsed time) has not.
 */
export function hasLeaseSilenceRunOut(
  firstFailedAtMs: number,
  nowMs: number,
  policy: LeaseSilencePolicy | null | undefined
) {
  return nowMs - firstFailedAtMs >= resolveLeaseSilenceToleranceMs(policy);
}

/**
 * The control plane answered, and the answer is that this session is over.
 * Everything else the native heartbeat reports — "heartbeat_failed" for a
 * request that got no usable answer, or a reason this build does not know —
 * is silence, and is waited out.
 */
export function isDefinitiveLeaseFailure(reasonCode: string | null | undefined) {
  return reasonCode === "session_invalid" || reasonCode === "session_expired" || reasonCode === "session_replaced";
}
