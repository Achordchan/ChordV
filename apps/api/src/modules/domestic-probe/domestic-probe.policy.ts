import type { DomesticReachabilityStatus } from "@chordv/shared";

/** Consecutive failed rounds before a node is shown as blocked (3 rounds = 15 minutes at the default interval). */
export const DOMESTIC_BLOCK_STREAK = 3;
/** Results older than this are shown as unknown: the probe has stopped reporting. */
export const DOMESTIC_STALE_MS = 15 * 60 * 1000;
/**
 * Most targets handed out in one round, and most results accepted in one
 * report. The two must stay equal: a round is always reported whole, so the
 * "every node failed at once" check sees the complete round.
 */
export const DOMESTIC_MAX_TARGETS = 500;
/** Interval the probe script is told to use. */
export const DOMESTIC_PROBE_INTERVAL_SECONDS = 300;

export type DomesticObservation = {
  tcpOk: boolean;
  tcpLatencyMs: number | null;
  error: string | null;
};

export type DomesticNodeState = {
  domesticStatus: string;
  domesticFailStreak: number;
};

export type DomesticNodeUpdate = {
  domesticStatus: DomesticReachabilityStatus;
  domesticFailStreak: number;
  domesticLatencyMs: number | null;
  domesticError: string | null;
};

/**
 * Next stored state for one node after one probe round.
 *
 * A single failed handshake is not a block: the status only turns to
 * "blocked" after DOMESTIC_BLOCK_STREAK consecutive failures, and keeps the
 * previous value until then. When the node's own agent is offline the
 * machine may simply be down, so a failure says nothing about blocking: the
 * streak is left alone and the status becomes unknown.
 */
export function nextDomesticState(
  previous: DomesticNodeState,
  observation: DomesticObservation,
  agentOnline: boolean
): DomesticNodeUpdate {
  if (observation.tcpOk) {
    return {
      domesticStatus: "reachable",
      domesticFailStreak: 0,
      domesticLatencyMs: observation.tcpLatencyMs,
      domesticError: null
    };
  }
  if (!agentOnline) {
    return {
      domesticStatus: "unknown",
      domesticFailStreak: previous.domesticFailStreak,
      domesticLatencyMs: null,
      domesticError: "节点 Agent 离线，无法判断是否被墙"
    };
  }
  const streak = previous.domesticFailStreak + 1;
  const previousStatus = readDomesticStatus(previous.domesticStatus);
  return {
    domesticStatus: streak >= DOMESTIC_BLOCK_STREAK ? "blocked" : previousStatus,
    domesticFailStreak: streak,
    domesticLatencyMs: null,
    domesticError: observation.error ?? "国内 TCP 握手失败"
  };
}

/**
 * Whether a whole round should be discarded because the probe itself looks
 * unhealthy: its control target (a well-known domestic site) failed, or every
 * node failed at once. Either way a network blip on the probe would otherwise
 * mark every node as blocked.
 */
export function shouldIgnoreRound(controlOk: boolean, observations: DomesticObservation[]): string | null {
  if (!controlOk) {
    return "探针自身的对照目标不可达";
  }
  if (observations.length >= 2 && observations.every((item) => !item.tcpOk)) {
    return "本轮所有节点同时失败，按探针网络故障处理";
  }
  return null;
}

export function readDomesticStatus(value: string | null | undefined): DomesticReachabilityStatus {
  return value === "reachable" || value === "blocked" ? value : "unknown";
}

/** Status as shown to admins: a result older than DOMESTIC_STALE_MS is unknown. */
export function effectiveDomesticStatus(
  status: string | null | undefined,
  checkedAt: Date | null | undefined,
  now = new Date()
): DomesticReachabilityStatus {
  if (!checkedAt || now.getTime() - checkedAt.getTime() > DOMESTIC_STALE_MS) {
    return "unknown";
  }
  return readDomesticStatus(status);
}
