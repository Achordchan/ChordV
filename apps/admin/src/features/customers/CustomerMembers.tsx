import { CustomerRoutingRules } from "./CustomerRoutingRules";
import { DataSkeleton } from "../shared/DataSkeleton";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Modal, Group, Stack, Table, Tabs, Text } from "@mantine/core";
import { IconListDetails, IconLock, IconLockOpen2, IconPencil, IconPlugConnectedX, IconPlus, IconTrash, IconUsers } from "@tabler/icons-react";
import type { AdminTeamRecordDto } from "@chordv/shared";
import { formatDateTime, formatTrafficGb } from "../../utils/admin-format";
import { summarizeTeamUsage } from "../../utils/admin-filters";
import { translateUserStatus } from "../../utils/admin-translate";
import { findNodeCommandSummary } from "../../utils/node-command-summary";
import { PanelSyncInlineStatus, LeaseRevocationInlineStatus, isTeamMemberLeaseRevocationJob } from "./CustomerTaskStatus";
import { TeamMemberEditorPanel } from "./TeamEditors";
import type { UsersPageProps } from "./types";
import dialogStyles from "../editors/EditorDialog.module.css";
import styles from "./CustomerWorkspace.module.css";

export function CustomerMembers({ team, actions }: { team: AdminTeamRecordDto; actions: UsersPageProps }) {
  const [memberId, setMemberId] = useState<string | null>(null);
  const load = useRef(actions.onLoadTeamUsage); load.current = actions.onLoadTeamUsage;
  useEffect(() => { load.current(team.id); }, [team.id]);
  const loaded = Object.prototype.hasOwnProperty.call(actions.teamUsageByTeamId, team.id);
  const loading = Boolean(actions.teamUsageLoadingByTeamId[team.id]);
  const error = actions.teamUsageErrorByTeamId[team.id];
  const usage = summarizeTeamUsage(actions.teamUsageByTeamId[team.id] ?? []);
  const member = team.members.find(item => item.id === memberId);
  const user = member ? actions.allUsers.find(item => item.id === member.userId) : undefined;
  const entry = member ? usage.find(item => item.userId === member.userId) : undefined;
  const outside = (action: () => void) => { setMemberId(null); action(); };
  return <>
    <div className={styles.sectionHeading}><div><h2>团队成员</h2><Text size="sm" c="dimmed" mt={6}>共 {team.memberCount} 人 · 共用团队订阅额度</Text></div>
      <Button variant="default" leftSection={<IconPlus size={16}/>} onClick={() => actions.onOpenTeamMemberInlineEditor(team.id)}>添加成员</Button></div>
    {actions.teamMemberInlineEditor?.teamId === team.id && <TeamMemberEditorPanel {...actions}/>}
    {error && <Group mt="md"><Text size="sm" c="red">{error}</Text><Button size="compact-xs" variant="default" onClick={() => actions.onLoadTeamUsage(team.id, { force: true })}>重新加载</Button></Group>}
    <Table.ScrollContainer minWidth={520}><Table verticalSpacing="md" className={styles.memberTable}><Table.Thead><Table.Tr><Table.Th>成员</Table.Th><Table.Th>角色</Table.Th><Table.Th>本期已用</Table.Th><Table.Th>账号状态</Table.Th><Table.Th>操作</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
      {team.members.map(item => {
        const account = actions.allUsers.find(u => u.id === item.userId);
        const itemUsage = usage.find(u => u.userId === item.userId);
        const pendingCommands = findNodeCommandSummary(actions.nodeCommandQueue.summaries, "users", item.userId);
        const pendingRevocation = actions.leaseRevocationJobs.some(job => isTeamMemberLeaseRevocationJob(job, item.userId, team.currentSubscription?.id) && ["pending", "running", "failed"].includes(job.status));
        return <Table.Tr key={item.id}><Table.Td><Text fw={600}>{item.displayName}</Text><Text size="xs" c="dimmed">{item.email}</Text></Table.Td><Table.Td>{item.role === "owner" ? "负责人" : "成员"}</Table.Td>
          <Table.Td>{!loaded && !error ? <DataSkeleton variant="line"/> : !loaded ? "未加载" : itemUsage ? `${formatTrafficGb(itemUsage.totalUsedTrafficGb)} GB` : "暂无用量"}</Table.Td>
          <Table.Td><Text size="sm" c={account?.status === "active" ? "#3b734d" : "dimmed"}>{account ? translateUserStatus(account.status) : "待同步"}</Text>
            {((pendingCommands?.total ?? 0) > 0 || pendingRevocation) && <Text size="xs" c="orange.7">操作待确认</Text>}
          </Table.Td>
          <Table.Td><button className={styles.textButton} onClick={() => setMemberId(item.id)}>详情</button></Table.Td></Table.Tr>;
      })}
    </Table.Tbody></Table></Table.ScrollContainer>
    {!team.members.length && <div className={styles.empty}><IconUsers size={28}/><p>暂无成员，添加后可共用团队订阅。</p></div>}
    <Modal opened={Boolean(member) && actions.teamMemberInlineEditor?.teamId !== team.id} onClose={() => setMemberId(null)} title="成员详情" centered size={620} overlayProps={{ backgroundOpacity: .35, blur: 2 }} classNames={{ content: dialogStyles.content, header: dialogStyles.header, title: dialogStyles.title, body: dialogStyles.body }}>
      {member && <Stack gap="lg" className={dialogStyles.memberDetail}><section><Text fw={700} size="lg">{member.displayName}</Text><Text c="dimmed" size="sm">{member.email}</Text><Badge mt="sm" variant="light" color="gray">{member.role === "owner" ? "负责人" : "成员"}</Badge></section>
        <Tabs key={member.id} defaultValue="usage" keepMounted={false} color="teal.9">
          <Tabs.List className={styles.tabs} aria-label="成员详情"><Tabs.Tab value="usage">用量详情</Tabs.Tab><Tabs.Tab value="routing">自定义规则</Tabs.Tab></Tabs.List>
          <Tabs.Panel value="usage" pt="lg"><Stack gap="lg" className={dialogStyles.memberDetail}>
        <section className={dialogStyles.preview}><Text fw={600}>使用情况</Text><Text mt="sm">{!loaded && !error ? <DataSkeleton variant="line"/> : !loaded ? "未加载" : entry ? `${formatTrafficGb(entry.totalUsedTrafficGb)} GB` : "暂无用量"}</Text>
          {entry && <><Text size="sm" c="dimmed">{entry.nodeBreakdown?.length ?? 0} 个节点 · {formatDateTime(entry.lastRecordedAt)}</Text><Button mt="sm" variant="default" leftSection={<IconListDetails size={16}/>} onClick={() => outside(() => actions.onOpenTeamUsageDetail({ teamName: team.name, userDisplayName: entry.userDisplayName, userEmail: entry.userEmail, entry }))}>用量详情</Button></>}
        </section>
        <section><Text fw={600} mb="sm">账号操作</Text><Group gap="xs"><Button variant="default" leftSection={<IconPencil size={16}/>} onClick={() => outside(() => actions.onOpenUserDrawer(member.userId))}>编辑账号</Button>
          <Button variant="default" color={user?.status === "active" ? "red" : "green"} leftSection={user?.status === "active" ? <IconLock size={16}/> : <IconLockOpen2 size={16}/>}
            loading={actions.actionBusyKey === `user-status:${member.userId}`} disabled={!user || (actions.actionBusyKey !== null && actions.actionBusyKey !== `user-status:${member.userId}`)}
            onClick={() => actions.onToggleTeamUserStatus(member.userId, user?.status === "active" ? "disabled" : "active", member.displayName)}>{user?.status === "active" ? "禁用账号" : "启用账号"}</Button>
          <Button variant="default" color="orange" leftSection={<IconPlugConnectedX size={16}/>} loading={actions.actionBusyKey === `user-disconnect:${member.userId}`}
            disabled={actions.actionBusyKey !== null && actions.actionBusyKey !== `user-disconnect:${member.userId}`} onClick={() => actions.onDisconnectUser(member.userId, member.displayName, "team-member")}>断开连接</Button>
        </Group></section>
        <section><Text fw={600} mb="sm">团队关系</Text><Group gap="xs"><Button variant="default" onClick={() => actions.onOpenTeamMemberInlineEditor(team.id, member.id)}>编辑角色</Button>
          {member.role !== "owner" && <Button variant="default" color="red" leftSection={<IconTrash size={16}/>} loading={actions.actionBusyKey === `team-member-delete:${member.id}`}
            disabled={actions.actionBusyKey !== null && actions.actionBusyKey !== `team-member-delete:${member.id}`} onClick={() => actions.onDeleteTeamMember(team.id, member.id)}>移出团队</Button>}</Group>
        </section>
        <section><Text fw={600} mb="sm">执行状态</Text>
          {!findNodeCommandSummary(actions.nodeCommandQueue.summaries, "users", member.userId)?.total && user?.panelSyncStatus !== "pending" && !user?.panelSyncSummary?.total && !actions.leaseRevocationJobs.some(job => isTeamMemberLeaseRevocationJob(job, member.userId, team.currentSubscription?.id) && ["pending", "running", "failed"].includes(job.status)) && <Text size="sm" c="dimmed">暂无待处理任务</Text>}
          <PanelSyncInlineStatus item={user} commandSummary={findNodeCommandSummary(actions.nodeCommandQueue.summaries, "users", member.userId)}
          onOpenLeaseRevocationQueue={() => outside(() => actions.onOpenLeaseRevocationQueue({ userId: member.userId, title: `${member.displayName} · ${team.name}` }))}/>
          <LeaseRevocationInlineStatus jobs={actions.leaseRevocationJobs.filter(job => isTeamMemberLeaseRevocationJob(job, member.userId, team.currentSubscription?.id))} retryBusyKey={actions.leaseRevocationRetryBusyKey} onRetryJob={actions.onRetryLeaseRevocationJob}/>
        </section>
          </Stack></Tabs.Panel>
          <Tabs.Panel value="routing" pt="lg"><Text size="sm" c="#52604c" mb="md">账号级规则，非团队专属；与该成员的个人订阅共用。</Text><CustomerRoutingRules key={member.userId} userId={member.userId}/></Tabs.Panel>
        </Tabs>
        <footer className={dialogStyles.footer}><Button variant="default" onClick={() => setMemberId(null)}>关闭</Button></footer>
      </Stack>}
    </Modal>
  </>;
}
