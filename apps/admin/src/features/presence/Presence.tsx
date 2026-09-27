import { Text } from "@mantine/core";
import type { AdminPresenceSessionDto, AdminUserPresenceDto } from "@chordv/shared";
import { CountryFlag } from "../../components/CountryFlag";
import { formatDateTimeWithYear, formatTrafficGb } from "../../utils/admin-format";
import { translateSubscriptionState } from "../../utils/admin-translate";
import { formatClientLastSeen } from "../../utils/client-versions";
import {
  formatConnectionMode,
  formatNodeProtocol,
  formatPresenceBrief,
  formatPresenceDuration,
  formatTeamPresence,
  presenceTone,
  type TeamPresenceSummary
} from "../../utils/presence";
import styles from "./Presence.module.css";

/** 带状态圆点的一行在线状态。 */
export function PresenceStatus({ entry, text, className }: { entry: AdminUserPresenceDto | null | undefined; text?: string; className?: string }) {
  const label = text ?? formatPresenceBrief(entry);
  return <span className={`${styles.status} ${className ?? ""}`} data-state={presenceTone(entry)} title={entry?.lastOnlineAt ? `最近在线 ${formatDateTimeWithYear(entry.lastOnlineAt)}` : undefined}>
    <i aria-hidden="true"/><span>{label}</span>
  </span>;
}

export function TeamPresenceStatus({ summary, className }: { summary: TeamPresenceSummary; className?: string }) {
  const state = summary.connected ? "connected" : summary.online ? "online" : "offline";
  return <span className={`${styles.status} ${className ?? ""}`} data-state={state}><i aria-hidden="true"/><span>{formatTeamPresence(summary)}</span></span>;
}

/** 节点旗帜与名称。 */
export function PresenceNode({ session }: { session: AdminPresenceSessionDto }) {
  return <span className={styles.nodeName}><CountryFlag code={session.node.countryCode} size="sm"/>{session.node.name}</span>;
}

export function formatSessionLine(session: AdminPresenceSessionDto) {
  return [session.node.region || null, formatNodeProtocol(session.node), formatConnectionMode(session.connectionMode)].filter(Boolean).join(" · ");
}

export function formatSessionUsage(session: AdminPresenceSessionDto) {
  const subscription = session.subscription;
  if (!subscription) return "订阅未知";
  const owner = subscription.ownerType === "team" ? `团队订阅${subscription.teamName ? `（${subscription.teamName}）` : ""}` : "个人订阅";
  return `${owner} · ${subscription.planName} · 已用 ${formatTrafficGb(subscription.usedTrafficGb)} / ${formatTrafficGb(subscription.totalTrafficGb)} GB · ${translateSubscriptionState(subscription.state)}`;
}

/** 详情里的完整在线信息：状态、在线时长、每个连接的节点与线路（客户端版本在旁边的“客户端”一栏展示）。 */
export function PresenceDetails({ entry, loading, error, generatedAt }: { entry: AdminUserPresenceDto | null | undefined; loading?: boolean; error?: string | null; generatedAt?: string | null }) {
  if (!entry) {
    if (loading) return <Text size="sm" c="dimmed">正在读取在线状态…</Text>;
    return <div className={styles.facts}><span>暂无在线记录</span><small>{error ?? "客户端登录并打开后会自动出现"}</small></div>;
  }
  // 以服务端生成时间计算时长，避免浏览器时钟偏差。
  const now = generatedAt ? Date.parse(generatedAt) : Date.now();
  return <div className={styles.facts}>
    <PresenceStatus entry={entry}/>
    {entry.state !== "offline" && entry.onlineSince && <small>客户端已打开 {formatPresenceDuration(entry.onlineSince, now)}（{formatDateTimeWithYear(entry.onlineSince)} 起）</small>}
    {entry.state === "offline" && entry.lastOnlineAt && <small>最近在线 {formatDateTimeWithYear(entry.lastOnlineAt)}</small>}
    {entry.sessions.length > 0 && <div className={styles.sessions}>{entry.sessions.map(session => <div key={session.sessionId} className={styles.session}>
      <CountryFlag code={session.node.countryCode} size="sm"/>
      <strong>{session.node.name}</strong>
      <small>{formatSessionLine(session)}</small>
      <small>已连接 {formatPresenceDuration(session.connectedAt, now)} · 最近心跳 {formatClientLastSeen(session.lastHeartbeatAt, now)}</small>
      <small>{formatSessionUsage(session)}</small>
    </div>)}</div>}
    {error && <small>{error}</small>}
  </div>;
}
