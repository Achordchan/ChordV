import { Table, Text } from "@mantine/core";
import { IconChevronRight } from "@tabler/icons-react";
import { CountryFlag } from "../../components/CountryFlag";
import { formatDateTimeWithYear } from "../../utils/admin-format";
import { formatClientLastSeen, formatClientVersionDetail } from "../../utils/client-versions";
import { formatPresenceDuration, listOnlineUsers, summarizeNodeConnections } from "../../utils/presence";
import { formatSessionLine, formatSessionUsage, PresenceNode, PresenceStatus } from "./Presence";
import { usePresence } from "./usePresence";
import dashboardStyles from "../dashboard/Dashboard.module.css";
import styles from "./Presence.module.css";

/** 首页“在线用户”：当前在线人数、各节点连接数，以及每位在线用户的节点、线路、模式、时长与客户端。 */
export function OnlineUsersPanel({ onOpenCustomers }: { onOpenCustomers: () => void }) {
  const { snapshot, loading, error } = usePresence();
  const now = snapshot ? Date.parse(snapshot.generatedAt) : Date.now();
  const users = listOnlineUsers(snapshot);
  const nodes = summarizeNodeConnections(snapshot);
  const counts = snapshot?.counts ?? { online: 0, connected: 0, idle: 0 };
  const connectedMinutes = Math.round((snapshot?.connectedWindowSeconds ?? 120) / 60);
  return <section className={styles.panel} aria-label="在线用户">
    <div className={dashboardStyles.sectionHeading}><div><h2>在线用户</h2>
      <Text size="sm" c="dimmed" mt={6}>{!snapshot ? loading ? "正在读取在线状态…" : error ?? "正在读取在线状态…" : counts.online ? `当前 ${counts.online} 人在线，其中 ${counts.connected} 人正在使用节点` : "当前没有用户在线"}</Text></div>
      <button onClick={onOpenCustomers}>查看客户<IconChevronRight size={16}/></button></div>
    {snapshot && <div className={styles.counts}><span>在线<strong>{counts.online}</strong></span><span>已连接节点<strong>{counts.connected}</strong></span><span>已打开客户端未连接<strong>{counts.idle}</strong></span></div>}
    {nodes.length > 0 && <div className={styles.nodeLoad} aria-label="各节点在线人数">{nodes.map(node => <span key={node.nodeId}><CountryFlag code={node.countryCode} size="sm"/>{node.name} {node.users} 人{node.sessions > node.users ? `（${node.sessions} 个连接）` : ""}</span>)}</div>}
    {users.length > 0 && <Table.ScrollContainer minWidth={920}><Table className={styles.table}>
      <Table.Thead><Table.Tr><Table.Th>用户</Table.Th><Table.Th>状态</Table.Th><Table.Th>节点 / 线路</Table.Th><Table.Th>在线时长</Table.Th><Table.Th>客户端</Table.Th><Table.Th>订阅用量</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{users.map(entry => <Table.Tr key={entry.userId}>
        <Table.Td><Text size="sm" fw={600}>{entry.displayName}</Text><Text size="xs" c="dimmed">{entry.teamName ? `团队 ${entry.teamName}` : entry.email}</Text></Table.Td>
        <Table.Td><PresenceStatus entry={entry} text={entry.state === "connected" ? `已连接${entry.sessions.length > 1 ? ` ${entry.sessions.length} 台设备` : ""}` : "在线 · 未连接"}/></Table.Td>
        <Table.Td>{entry.sessions.length ? <div className={styles.cellLines}>{entry.sessions.map(session => <div key={session.sessionId}>
          <PresenceNode session={session}/>
          <small>{formatSessionLine(session)}</small>
          <small title={formatDateTimeWithYear(session.lastHeartbeatAt)}>已连接 {formatPresenceDuration(session.connectedAt, now)} · 最近心跳 {formatClientLastSeen(session.lastHeartbeatAt, now)}</small>
        </div>)}</div> : <span className={styles.muted}>未连接节点</span>}</Table.Td>
        <Table.Td><span title={entry.onlineSince ? `${formatDateTimeWithYear(entry.onlineSince)} 起` : undefined}>{formatPresenceDuration(entry.onlineSince, now)}</span></Table.Td>
        <Table.Td>{entry.client ? <span>{formatClientVersionDetail(entry.client)}</span> : <span className={styles.muted}>暂无记录</span>}</Table.Td>
        <Table.Td>{entry.sessions[0] ? <span>{formatSessionUsage(entry.sessions[0])}</span> : <span className={styles.muted}>—</span>}</Table.Td>
      </Table.Tr>)}</Table.Tbody>
    </Table></Table.ScrollContainer>}
    {snapshot && !users.length && <Text className={styles.empty}>当前没有用户在线</Text>}
    {snapshot && error && <Text className={styles.footnote} c="orange.8">{error}</Text>}
    <Text className={styles.footnote}>“已连接”指节点连接近 {connectedMinutes} 分钟内仍有心跳；“在线”指客户端已打开并登录。约 30 秒自动刷新，上下线时即时更新。</Text>
  </section>;
}
