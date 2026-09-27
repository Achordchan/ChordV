import type {
  AdminPresenceSessionDto,
  AdminPresenceSnapshotDto,
  AdminPresenceState,
  AdminUserPresenceDto,
  ConnectionMode
} from "@chordv/shared";
import { formatClientLastSeen } from "./client-versions";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const STATE_LABELS: Record<AdminPresenceState, string> = {
  connected: "已连接",
  online: "在线",
  offline: "离线"
};

const MODE_LABELS: Record<ConnectionMode, string> = {
  rule: "规则模式",
  global: "全局代理",
  direct: "直连模式"
};

export type PresenceTone = "connected" | "online" | "offline" | "unknown";

export function presenceByUserId(snapshot: AdminPresenceSnapshotDto | null | undefined) {
  return new Map((snapshot?.users ?? []).map((entry) => [entry.userId, entry]));
}

export function presenceTone(entry: AdminUserPresenceDto | null | undefined): PresenceTone {
  return entry ? entry.state : "unknown";
}

export function formatPresenceState(state: AdminPresenceState) {
  return STATE_LABELS[state] ?? "离线";
}

export function formatConnectionMode(mode: ConnectionMode | null | undefined) {
  return mode ? MODE_LABELS[mode] ?? "未知模式" : "模式未记录";
}

/** 持续时长，例如「12 分钟」「2 小时 5 分钟」「3 天」。 */
export function formatPresenceDuration(since: string | null | undefined, now = Date.now()) {
  const time = since ? Date.parse(since) : Number.NaN;
  if (!Number.isFinite(time)) return "时长未知";
  const elapsed = Math.max(0, now - time);
  if (elapsed < MINUTE_MS) return "不到 1 分钟";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} 分钟`;
  if (elapsed < DAY_MS) {
    const hours = Math.floor(elapsed / HOUR_MS);
    const minutes = Math.floor((elapsed % HOUR_MS) / MINUTE_MS);
    return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
  }
  return `${Math.floor(elapsed / DAY_MS)} 天`;
}

/** 协议与安全层，例如「VLESS · Reality」。 */
export function formatNodeProtocol(node: Pick<AdminPresenceSessionDto["node"], "protocol" | "security">) {
  const protocol = node.protocol?.trim().toUpperCase();
  const security = node.security?.trim();
  const securityLabel = !security || security === "none" ? null : security === "reality" ? "Reality" : security === "tls" ? "TLS" : security;
  return [protocol || null, securityLabel].filter(Boolean).join(" · ") || "协议未知";
}

/** 列表里的一行，例如「已连接 · 香港 01」「在线 · 未连接节点」「离线 · 最近在线 3 小时前」。 */
export function formatPresenceBrief(entry: AdminUserPresenceDto | null | undefined, now = Date.now()) {
  if (!entry) return "暂无在线记录";
  if (entry.state === "connected") {
    const [first, ...rest] = entry.sessions;
    const node = first?.node.name ?? "节点";
    return rest.length ? `已连接 · ${node} 等 ${entry.sessions.length} 个连接` : `已连接 · ${node}`;
  }
  if (entry.state === "online") return "在线 · 未连接节点";
  return entry.lastOnlineAt ? `离线 · 最近在线 ${formatClientLastSeen(entry.lastOnlineAt, now)}` : "离线";
}

export type TeamPresenceSummary = {
  members: number;
  online: number;
  connected: number;
};

/** 团队成员在线人数；已连接的成员同时计入在线。 */
export function summarizeTeamPresence(
  memberUserIds: string[],
  presence: Map<string, AdminUserPresenceDto>
): TeamPresenceSummary {
  let online = 0;
  let connected = 0;
  for (const userId of new Set(memberUserIds)) {
    const state = presence.get(userId)?.state;
    if (state === "connected") connected += 1;
    if (state === "connected" || state === "online") online += 1;
  }
  return { members: new Set(memberUserIds).size, online, connected };
}

export function formatTeamPresence(summary: TeamPresenceSummary) {
  if (!summary.online) return "成员均离线";
  return summary.connected ? `${summary.online} 人在线 · ${summary.connected} 人已连接` : `${summary.online} 人在线`;
}

/** 首页“在线用户”只列在线与已连接的用户，已连接在前，同一状态下在线更久的在前。 */
export function listOnlineUsers(snapshot: AdminPresenceSnapshotDto | null | undefined) {
  const order: Record<AdminPresenceState, number> = { connected: 0, online: 1, offline: 2 };
  return (snapshot?.users ?? [])
    .filter((entry) => entry.state !== "offline")
    .sort((left, right) =>
      order[left.state] - order[right.state] ||
      Date.parse(left.onlineSince ?? "") - Date.parse(right.onlineSince ?? "") ||
      left.displayName.localeCompare(right.displayName, "zh-CN")
    );
}

/** 各节点当前连接数，按连接数从多到少。 */
export function summarizeNodeConnections(snapshot: AdminPresenceSnapshotDto | null | undefined) {
  const byNode = new Map<string, { nodeId: string; name: string; countryCode: string | null; sessions: number; users: Set<string> }>();
  for (const entry of snapshot?.users ?? []) {
    if (entry.state !== "connected") continue;
    for (const session of entry.sessions) {
      const current = byNode.get(session.node.id) ?? { nodeId: session.node.id, name: session.node.name, countryCode: session.node.countryCode, sessions: 0, users: new Set<string>() };
      current.sessions += 1;
      current.users.add(entry.userId);
      byNode.set(session.node.id, current);
    }
  }
  return [...byNode.values()]
    .map((item) => ({ nodeId: item.nodeId, name: item.name, countryCode: item.countryCode, sessions: item.sessions, users: item.users.size }))
    .sort((left, right) => right.users - left.users || right.sessions - left.sessions || left.name.localeCompare(right.name, "zh-CN"));
}
