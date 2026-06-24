import type { Dispatch, SetStateAction } from "react";
import { Accordion, ActionIcon, Badge, Button, Group, Paper, Select, Stack, Table, Tabs, Text, TextInput } from "@mantine/core";
import type { AdminLeaseRevocationJobDto, AdminTeamRecordDto, AdminUserRecordDto, TeamMemberRole, TeamStatus } from "@chordv/shared";
import {
  IconListDetails,
  IconLock,
  IconLockOpen2,
  IconPencil,
  IconPlugConnectedX,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconUsers
} from "@tabler/icons-react";
import { DataTable } from "../features/shared/DataTable";
import { RowActions } from "../features/shared/RowActions";
import { SectionCard } from "../features/shared/SectionCard";
import { StatusBadge } from "../features/shared/StatusBadge";
import type { PanelSyncQueueFilter } from "../utils/admin-queue-filters";
import type { TeamFormState, TeamMemberFormState } from "../utils/admin-forms";
import { summarizeAdminDiagnosticMessage } from "../utils/admin-filters";
import { translateRole, translateUserStatus } from "../utils/admin-translate";

type UsersPageProps = {
  searchValue: string;
  onSearchChange: (value: string) => void;
  userTab: "personal" | "team";
  onUserTabChange: (value: "personal" | "team") => void;
  users: AdminUserRecordDto[];
  filteredTeams: AdminTeamRecordDto[];
  allUsers: AdminUserRecordDto[];
  leaseRevocationJobs: AdminLeaseRevocationJobDto[];
  leaseRevocationRetryBusyKey: string | null;
  actionBusyKey: string | null;
  teamInlineEditorId: string | null;
  teamMemberInlineEditor: { teamId: string; memberId: string | null } | null;
  teamProfileBusyKey: string | null;
  teamMemberBusyKey: string | null;
  teamForm: TeamFormState;
  setTeamForm: Dispatch<SetStateAction<TeamFormState>>;
  teamMemberForm: TeamMemberFormState;
  setTeamMemberForm: Dispatch<SetStateAction<TeamMemberFormState>>;
  buildTeamMemberOptions: (currentUserId?: string) => Array<{ value: string; label: string }>;
  onOpenUserDrawer: (userId: string) => void;
  onOpenUserSubscriptions: (user: AdminUserRecordDto) => void;
  onCreateSubscriptionForUser: (user: AdminUserRecordDto) => void;
  onOpenTeamSubscriptions: (team: AdminTeamRecordDto) => void;
  onOpenTeamInlineEditor: (teamId: string) => void;
  onCloseTeamInlineEditor: () => void;
  onSaveTeamInlineEditor: (teamId: string) => void;
  onOpenTeamMemberInlineEditor: (teamId: string, memberId?: string | null) => void;
  onCloseTeamMemberInlineEditor: () => void;
  onSaveTeamMemberInlineEditor: () => void;
  onDeleteTeamMember: (teamId: string, memberId: string) => void;
  onToggleUserStatus: (userId: string, nextStatus: "active" | "disabled", displayName: string) => void;
  onToggleTeamUserStatus: (userId: string, nextStatus: "active" | "disabled", displayName: string) => void;
  onDisconnectUser: (userId: string, displayName: string, source?: "personal" | "team-member") => void;
  onRetryLeaseRevocationJob: (jobId: string) => void;
  onOpenPanelSyncQueue: (filter?: PanelSyncQueueFilter) => void;
};

export function UsersPage(props: UsersPageProps) {
  const teamMemberRoleOptions =
    props.teamMemberForm.role === "owner"
      ? [
          { value: "owner", label: "负责人", disabled: true },
          { value: "member", label: "成员" }
        ]
      : [{ value: "member", label: "成员" }];

  return (
    <Stack gap="lg">
      <SectionCard searchValue={props.searchValue} onSearchChange={props.onSearchChange}>
        <Tabs value={props.userTab} onChange={(value) => props.onUserTabChange((value as "personal" | "team") || "personal")}>
          <Tabs.List>
            <Tabs.Tab value="personal">个人用户</Tabs.Tab>
            <Tabs.Tab value="team">Team 用户</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="personal" pt="md">
            <DataTable>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>邮箱</Table.Th>
                  <Table.Th>名称</Table.Th>
                  <Table.Th>角色</Table.Th>
                  <Table.Th>状态</Table.Th>
                  <Table.Th>操作</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {props.users.filter((item) => item.accountType === "personal").map((item) => (
                  <Table.Tr key={item.id}>
                    <Table.Td>{item.email}</Table.Td>
                    <Table.Td>{item.displayName}</Table.Td>
                    <Table.Td>
                      <Badge variant="light">{translateRole(item.role)}</Badge>
                    </Table.Td>
                    <Table.Td>
                      <Stack gap={4}>
                        <StatusBadge color={item.status === "active" ? "green" : "gray"} label={translateUserStatus(item.status)} />
                        <PanelSyncInlineStatus
                          item={item}
                          onOpenPanelSyncQueue={() =>
                            props.onOpenPanelSyncQueue({
                              subscriptionId: item.currentSubscription?.id,
                              userId: item.id,
                              title: item.displayName
                            })
                          }
                        />
                        <LeaseRevocationInlineStatus
                          jobs={props.leaseRevocationJobs.filter((job) => job.userId === item.id)}
                          retryBusyKey={props.leaseRevocationRetryBusyKey}
                          onRetryJob={props.onRetryLeaseRevocationJob}
                        />
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      <RowActions>
                        <ActionIcon variant="subtle" onClick={() => props.onOpenUserDrawer(item.id)} title="编辑账号">
                          <IconPencil size={16} />
                        </ActionIcon>
                        {item.subscriptionCount > 0 || item.currentSubscription ? (
                          <ActionIcon variant="subtle" onClick={() => props.onOpenUserSubscriptions(item)} title="打开订阅管理">
                            <IconListDetails size={16} />
                          </ActionIcon>
                        ) : null}
                        {!item.currentSubscription ? (
                          <ActionIcon variant="subtle" color="blue" onClick={() => props.onCreateSubscriptionForUser(item)} title="为此用户创建订阅">
                            <IconPlus size={16} />
                          </ActionIcon>
                        ) : null}
                        <ActionIcon
                          variant="subtle"
                          color="orange"
                          onClick={() => props.onDisconnectUser(item.id, item.displayName, "personal")}
                          title="账号级：断开当前连接"
                          loading={props.actionBusyKey === `user-disconnect:${item.id}`}
                          disabled={props.actionBusyKey !== null && props.actionBusyKey !== `user-disconnect:${item.id}`}
                        >
                          <IconPlugConnectedX size={16} />
                        </ActionIcon>
                        <ActionIcon
                          variant="subtle"
                          color={item.status === "active" ? "red" : "green"}
                          onClick={() =>
                            props.onToggleUserStatus(
                              item.id,
                              item.status === "active" ? "disabled" : "active",
                              item.displayName
                            )
                          }
                          title={item.status === "active" ? "禁用账号" : "启用账号"}
                          loading={props.actionBusyKey === `user-status:${item.id}`}
                          disabled={props.actionBusyKey !== null && props.actionBusyKey !== `user-status:${item.id}`}
                        >
                          {item.status === "active" ? <IconLock size={16} /> : <IconLockOpen2 size={16} />}
                        </ActionIcon>
                      </RowActions>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </DataTable>
          </Tabs.Panel>
          <Tabs.Panel value="team" pt="md">
            <Accordion variant="separated" radius="xl">
              {props.filteredTeams.map((item) => (
                <Accordion.Item key={item.id} value={item.id}>
                  <Accordion.Control>
                    <Group justify="space-between" wrap="wrap">
                      <Group gap="xl" wrap="wrap" style={{ minWidth: 0 }}>
                        <Stack gap={0} miw={220} style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                          <Text fw={600}>{item.name}</Text>
                          <Text size="sm" c="dimmed">
                            {item.ownerDisplayName} · {item.ownerEmail}
                          </Text>
                        </Stack>
                        <Stack gap={0} miw={120}>
                          <Text size="sm" c="dimmed">
                            成员数
                          </Text>
                          <Text fw={600}>{item.memberCount}</Text>
                        </Stack>
                      </Group>
                      <Stack gap={4} align="flex-end">
                        <StatusBadge color={item.status === "active" ? "green" : "gray"} label={item.status === "active" ? "启用" : "停用"} />
                        <PanelSyncInlineStatus
                          item={item}
                          onOpenPanelSyncQueue={() =>
                            props.onOpenPanelSyncQueue({
                              subscriptionId: item.currentSubscription?.id,
                              teamId: item.id,
                              title: item.name
                            })
                          }
                        />
                        <LeaseRevocationInlineStatus
                          jobs={props.leaseRevocationJobs.filter((job) =>
                            item.currentSubscription?.id ? job.subscriptionId === item.currentSubscription.id && job.userId === null : false
                          )}
                          retryBusyKey={props.leaseRevocationRetryBusyKey}
                          onRetryJob={props.onRetryLeaseRevocationJob}
                        />
                      </Stack>
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Stack gap="md">
                      <Group justify="space-between">
                        <Text size="sm" c="dimmed">
                          这里只处理团队组织、负责人和成员关系，不展示共享订阅、节点和流量账单。
                        </Text>
                        <RowActions>
                          <ActionIcon variant="subtle" onClick={() => props.onOpenTeamSubscriptions(item)} title="Team 订阅：打开共享订阅管理">
                            <IconListDetails size={16} />
                          </ActionIcon>
                          <ActionIcon variant="subtle" onClick={() => props.onOpenTeamInlineEditor(item.id)} title="编辑团队资料">
                            <IconPencil size={16} />
                          </ActionIcon>
                          <ActionIcon variant="subtle" onClick={() => props.onOpenTeamMemberInlineEditor(item.id)} title="添加团队成员关系">
                            <IconUsers size={16} />
                          </ActionIcon>
                        </RowActions>
                      </Group>

                      {props.teamInlineEditorId === item.id ? (
                        <Paper withBorder radius="lg" p="md">
                          <Stack gap="sm">
                            <Text fw={600}>编辑团队</Text>
                            <TextInput
                              label="团队名称"
                              value={props.teamForm.name}
                              onChange={(event) => props.setTeamForm((current) => ({ ...current, name: event.currentTarget.value }))}
                            />
                            <Select
                              label="负责人"
                              data={props.allUsers
                                .filter(
                                  (user) =>
                                    user.role === "user" &&
                                    (user.teamId === null || user.id === props.teamForm.ownerUserId || user.id === item.ownerUserId)
                                )
                                .map((user) => ({ value: user.id, label: `${user.displayName} · ${user.email}` }))}
                              value={props.teamForm.ownerUserId}
                              onChange={(value) => props.setTeamForm((current) => ({ ...current, ownerUserId: value || "" }))}
                            />
                            <Select
                              label="状态"
                              data={[
                                { value: "active", label: "启用" },
                                { value: "disabled", label: "停用" }
                              ]}
                              value={props.teamForm.status}
                              onChange={(value) =>
                                props.setTeamForm((current) => ({ ...current, status: (value || "active") as TeamStatus }))
                              }
                            />
                            <Group justify="flex-end">
                              <Button variant="default" onClick={props.onCloseTeamInlineEditor}>
                                取消
                              </Button>
                              <Button onClick={() => props.onSaveTeamInlineEditor(item.id)} loading={props.teamProfileBusyKey === item.id}>
                                保存
                              </Button>
                            </Group>
                          </Stack>
                        </Paper>
                      ) : null}

                      {props.teamMemberInlineEditor?.teamId === item.id ? (
                        <Paper withBorder radius="lg" p="md">
                          <Stack gap="sm">
                            <Text fw={600}>{props.teamMemberInlineEditor.memberId ? "编辑成员" : "添加成员"}</Text>
                            <Select
                              label="成员账号"
                              disabled={props.teamMemberInlineEditor.memberId !== null}
                              data={props.buildTeamMemberOptions(props.teamMemberForm.userId)}
                              value={props.teamMemberForm.userId}
                              onChange={(value) => props.setTeamMemberForm((current) => ({ ...current, userId: value || "" }))}
                            />
                            <Select
                              label="角色"
                              description="负责人只能通过团队编辑里的负责人字段转移"
                              data={teamMemberRoleOptions}
                              disabled={props.teamMemberForm.role === "owner"}
                              value={props.teamMemberForm.role}
                              onChange={(value) =>
                                props.setTeamMemberForm((current) => ({ ...current, role: (value || "member") as TeamMemberRole }))
                              }
                            />
                            <Group justify="flex-end">
                              <Button variant="default" onClick={props.onCloseTeamMemberInlineEditor}>
                                取消
                              </Button>
                              <Button
                                onClick={props.onSaveTeamMemberInlineEditor}
                                loading={
                                  props.teamMemberBusyKey ===
                                  `${props.teamMemberInlineEditor.teamId}:${props.teamMemberInlineEditor.memberId ?? "new"}`
                                }
                              >
                                保存
                              </Button>
                            </Group>
                          </Stack>
                        </Paper>
                      ) : null}

                      <DataTable>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>账号</Table.Th>
                            <Table.Th>角色</Table.Th>
                            <Table.Th>状态</Table.Th>
                            <Table.Th>操作</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {item.members.map((member) => {
                            const userRecord = props.allUsers.find((user) => user.id === member.userId);
                            return (
                              <Table.Tr key={member.id}>
                                <Table.Td>
                                  <Stack gap={0}>
                                    <Text>{member.displayName}</Text>
                                    <Text size="sm" c="dimmed">
                                      {member.email}
                                    </Text>
                                  </Stack>
                                </Table.Td>
                                <Table.Td>
                                  <Badge variant="light">{member.role === "owner" ? "负责人" : "成员"}</Badge>
                                </Table.Td>
                                <Table.Td>
                                  <Stack gap={4}>
                                    <StatusBadge
                                      color={userRecord?.status === "active" ? "green" : "gray"}
                                      label={translateUserStatus(userRecord?.status ?? "disabled")}
                                    />
                                    <PanelSyncInlineStatus
                                      item={userRecord}
                                      onOpenPanelSyncQueue={() =>
                                        props.onOpenPanelSyncQueue({
                                          subscriptionId: item.currentSubscription?.id,
                                          userId: member.userId,
                                          teamId: item.id,
                                          title: `${member.displayName} · ${item.name}`
                                        })
                                      }
                                    />
                                    <LeaseRevocationInlineStatus
                                      jobs={props.leaseRevocationJobs.filter((job) =>
                                        isTeamMemberLeaseRevocationJob(job, member.userId, item.currentSubscription?.id)
                                      )}
                                      retryBusyKey={props.leaseRevocationRetryBusyKey}
                                      onRetryJob={props.onRetryLeaseRevocationJob}
                                    />
                                  </Stack>
                                </Table.Td>
                                <Table.Td>
                                  <RowActions>
                                    <ActionIcon
                                      variant="subtle"
                                      onClick={() => props.onOpenUserDrawer(member.userId)}
                                      title="账号级：编辑账号资料"
                                    >
                                      <IconPencil size={16} />
                                    </ActionIcon>
                                    <ActionIcon
                                      variant="subtle"
                                      color={userRecord?.status === "active" ? "red" : "green"}
                                      loading={props.actionBusyKey === `user-status:${member.userId}`}
                                      disabled={props.actionBusyKey !== null && props.actionBusyKey !== `user-status:${member.userId}`}
                                      onClick={() =>
                                        props.onToggleTeamUserStatus(
                                          member.userId,
                                          userRecord?.status === "active" ? "disabled" : "active",
                                          member.displayName
                                        )
                                      }
                                      title={userRecord?.status === "active" ? "账号级：禁用账号" : "账号级：启用账号"}
                                    >
                                      {userRecord?.status === "active" ? <IconLock size={16} /> : <IconLockOpen2 size={16} />}
                                    </ActionIcon>
                                    <ActionIcon
                                      variant="subtle"
                                      color="orange"
                                      loading={props.actionBusyKey === `user-disconnect:${member.userId}`}
                                      disabled={props.actionBusyKey !== null && props.actionBusyKey !== `user-disconnect:${member.userId}`}
                                      onClick={() => props.onDisconnectUser(member.userId, member.displayName, "team-member")}
                                      title="账号级：断开当前连接，不移出团队"
                                    >
                                      <IconPlugConnectedX size={16} />
                                    </ActionIcon>
                                    <ActionIcon
                                      variant="subtle"
                                      onClick={() => props.onOpenTeamMemberInlineEditor(item.id, member.id)}
                                      title="团队关系：编辑成员角色"
                                    >
                                      <IconUsers size={16} />
                                    </ActionIcon>
                                    {member.role !== "owner" ? (
                                      <ActionIcon
                                        color="red"
                                        variant="subtle"
                                        loading={props.actionBusyKey === `team-member-delete:${member.id}`}
                                        disabled={props.actionBusyKey !== null && props.actionBusyKey !== `team-member-delete:${member.id}`}
                                        onClick={() => props.onDeleteTeamMember(item.id, member.id)}
                                        title="团队关系：移出团队"
                                      >
                                        <IconTrash size={16} />
                                      </ActionIcon>
                                    ) : null}
                                  </RowActions>
                                </Table.Td>
                              </Table.Tr>
                            );
                          })}
                        </Table.Tbody>
                      </DataTable>
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              ))}
            </Accordion>
          </Tabs.Panel>
        </Tabs>
      </SectionCard>
    </Stack>
  );
}

function PanelSyncInlineStatus(props: {
  item?: {
    panelSyncStatus?: "synced" | "pending";
    panelSyncMessage?: string | null;
    panelSyncSummary?: { pending: number; running: number; failed: number; total: number; lastError: string | null } | null;
  } | null;
  onOpenPanelSyncQueue: () => void;
}) {
  const summary = props.item?.panelSyncSummary;
  if (props.item?.panelSyncStatus !== "pending" && (summary?.total ?? 0) === 0) {
    return null;
  }
  const label = summary ? buildPanelSyncPendingLabel(summary) : "后台同步待处理";
  const detail = [
    summarizeAdminDiagnosticMessage(summary?.lastError, "面板同步任务失败，请稍后重试或查看服务器日志。"),
    summarizeAdminDiagnosticMessage(props.item?.panelSyncMessage, "后台同步状态待确认，请打开同步队列查看。")
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Stack gap={2}>
      <Group gap={4} wrap="nowrap">
        <Badge color="yellow" variant="light">
          {label}
        </Badge>
        <Button
          size="xs"
          variant="subtle"
          color="yellow"
          leftSection={<IconListDetails size={12} />}
          onClick={(event) => {
            event.stopPropagation();
            props.onOpenPanelSyncQueue();
          }}
          title="查看后台同步队列"
        >
          查看队列
        </Button>
      </Group>
      {detail ? (
        <Text size="xs" c="dimmed" lineClamp={2}>
          {detail}
        </Text>
      ) : null}
    </Stack>
  );
}

function isTeamMemberLeaseRevocationJob(job: AdminLeaseRevocationJobDto, userId: string, subscriptionId?: string | null) {
  if (job.userId !== userId) {
    return false;
  }
  return subscriptionId ? job.subscriptionId === subscriptionId || job.subscriptionId === null : true;
}

function LeaseRevocationInlineStatus(props: {
  jobs: AdminLeaseRevocationJobDto[];
  retryBusyKey: string | null;
  onRetryJob: (jobId: string) => void;
}) {
  const activeJobs = props.jobs.filter((job) => job.status === "pending" || job.status === "running" || job.status === "failed");
  if (activeJobs.length === 0) {
    return null;
  }
  const failed = activeJobs.filter((job) => job.status === "failed");
  const running = activeJobs.filter((job) => job.status === "running");
  const retryable = failed[0] ?? null;
  const label =
    failed.length > 0
      ? `连接撤销待重试 ${failed.length}`
      : running.length > 0
        ? "连接撤销执行中"
        : `连接撤销待同步 ${activeJobs.length}`;
  const lastError = summarizeAdminDiagnosticMessage(
    failed.find((job) => job.lastError)?.lastError ?? activeJobs.find((job) => job.lastError)?.lastError,
    "连接撤销任务失败，请稍后重试或查看服务器日志。"
  );

  return (
    <Stack gap={2}>
      <Group gap={4} wrap="nowrap">
        <Badge color="yellow" variant="light">
          {label}
        </Badge>
        {retryable ? (
          <ActionIcon
            size="xs"
            variant="subtle"
            color="yellow"
            loading={props.retryBusyKey === `lease-job:${retryable.id}`}
            disabled={props.retryBusyKey !== null && props.retryBusyKey !== `lease-job:${retryable.id}`}
            onClick={(event) => {
              event.stopPropagation();
              props.onRetryJob(retryable.id);
            }}
            title="重试连接撤销"
          >
            <IconRefresh size={12} />
          </ActionIcon>
        ) : null}
      </Group>
      {lastError ? (
        <Text size="xs" c="dimmed" lineClamp={2}>
          {lastError}
        </Text>
      ) : null}
    </Stack>
  );
}

function buildPanelSyncPendingLabel(summary: { pending: number; running: number; failed: number; total: number }) {
  const parts = [
    summary.pending > 0 ? `待同步 ${summary.pending}` : null,
    summary.running > 0 ? `执行中 ${summary.running}` : null,
    summary.failed > 0 ? `待重试 ${summary.failed}` : null
  ].filter(Boolean);
  return parts.length > 0 ? `面板同步${parts.join(" / ")}` : "后台同步待处理";
}
