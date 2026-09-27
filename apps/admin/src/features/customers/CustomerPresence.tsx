import { useMemo } from "react";
import { Text } from "@mantine/core";
import type { AdminTeamRecordDto } from "@chordv/shared";
import { formatPresenceBrief, presenceByUserId, summarizeTeamPresence } from "../../utils/presence";
import { PresenceDetails, PresenceStatus, TeamPresenceStatus } from "../presence/Presence";
import { usePresence } from "../presence/usePresence";
import type { CustomerRecord } from "./customer-model";
import styles from "./CustomerWorkspace.module.css";

function usePresenceMap() {
  const presence = usePresence();
  const byUser = useMemo(() => presenceByUserId(presence.snapshot), [presence.snapshot]);
  return { ...presence, byUser };
}

function teamMemberIds(team: AdminTeamRecordDto) {
  return team.members.map(member => member.userId);
}

/** 客户列表与详情抬头的一行在线状态：个人显示本人，团队显示在线人数。数据未就绪时不显示。 */
export function CustomerPresenceBrief({ customer, className }: { customer: CustomerRecord; className?: string }) {
  const { snapshot, byUser } = usePresenceMap();
  if (!snapshot) return null;
  if (customer.team) return <TeamPresenceStatus summary={summarizeTeamPresence(teamMemberIds(customer.team), byUser)} className={className ?? styles.rowPresence}/>;
  if (!customer.user) return null;
  const entry = byUser.get(customer.user.id);
  return <PresenceStatus entry={entry} text={entry ? undefined : "离线 · 暂无在线记录"} className={className ?? styles.rowPresence}/>;
}

/** 账号/团队资料里的在线详情。 */
export function CustomerPresenceFacts({ customer }: { customer: CustomerRecord }) {
  const { snapshot, loading, error, byUser } = usePresenceMap();
  if (customer.user) return <PresenceDetails entry={byUser.get(customer.user.id)} loading={loading && !snapshot} error={error} generatedAt={snapshot?.generatedAt}/>;
  if (!customer.team) return null;
  if (!snapshot) return <Text size="sm" c="dimmed">{loading ? "正在读取在线状态…" : error ?? "正在读取在线状态…"}</Text>;
  const online = customer.team.members.filter(member => {
    const state = byUser.get(member.userId)?.state;
    return state === "connected" || state === "online";
  });
  return <div className={styles.presenceFacts}>
    <TeamPresenceStatus summary={summarizeTeamPresence(teamMemberIds(customer.team), byUser)}/>
    {online.map(member => <Text key={member.id} size="xs" c="dimmed">{member.displayName}：{formatPresenceBrief(byUser.get(member.userId))}</Text>)}
  </div>;
}

/** 团队成员表里的一行在线状态。 */
export function MemberPresenceBrief({ userId }: { userId: string }) {
  const { snapshot, byUser } = usePresenceMap();
  if (!snapshot) return <Text size="sm" c="dimmed">—</Text>;
  const entry = byUser.get(userId);
  return <PresenceStatus entry={entry} text={entry ? undefined : "离线 · 暂无在线记录"} className={styles.memberPresence}/>;
}

/** 成员详情里的在线详情：节点、线路、模式、时长与客户端。 */
export function MemberPresenceDetails({ userId }: { userId: string }) {
  const { snapshot, loading, error, byUser } = usePresenceMap();
  return <PresenceDetails entry={byUser.get(userId)} loading={loading && !snapshot} error={error} generatedAt={snapshot?.generatedAt}/>;
}
