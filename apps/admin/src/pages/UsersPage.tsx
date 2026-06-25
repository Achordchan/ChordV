import { useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Accordion, ActionIcon, Badge, Button, Divider, Drawer, Group, Paper, Select, Stack, Table, Tabs, Text, TextInput } from "@mantine/core";
import type {
  AdminLeaseRevocationJobDto,
  AdminSubscriptionRecordDto,
  AdminTeamRecordDto,
  AdminTeamUsageRecordDto,
  AdminUserRecordDto,
  TeamMemberRole,
  TeamStatus
} from "@chordv/shared";
import {
  IconGaugeOff,
  IconListDetails,
  IconLock,
  IconLockOpen2,
  IconMapPin,
  IconPencil,
  IconPlugConnectedX,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconUsers
} from "@tabler/icons-react";
import { DataTable } from "../features/shared/DataTable";
import { SectionCard } from "../features/shared/SectionCard";
import { StatusBadge } from "../features/shared/StatusBadge";
import type { PanelSyncQueueFilter } from "../utils/admin-queue-filters";
import type { TeamFormState, TeamMemberFormState } from "../utils/admin-forms";
import { summarizeAdminDiagnosticMessage, summarizeTeamUsage } from "../utils/admin-filters";
import { formatDateTime, formatTrafficGb } from "../utils/admin-format";
import { getRenewActionText, subscriptionStateColor, translateRole, translateSubscriptionState, translateUserStatus } from "../utils/admin-translate";

type UsersPageProps = {
  searchValue: string;
  onSearchChange: (value: string) => void;
  userTab: "personal" | "team";
  onUserTabChange: (value: "personal" | "team") => void;
  users: AdminUserRecordDto[];
  filteredTeams: AdminTeamRecordDto[];
  subscriptions: AdminSubscriptionRecordDto[];
  allSubscriptions: AdminSubscriptionRecordDto[];
  allUsers: AdminUserRecordDto[];
  leaseRevocationJobs: AdminLeaseRevocationJobDto[];
  leaseRevocationRetryBusyKey: string | null;
  teamUsageByTeamId: Record<string, AdminTeamUsageRecordDto[]>;
  teamUsageLoadingByTeamId: Record<string, boolean>;
  teamUsageErrorByTeamId: Record<string, string | null>;
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
  onCreateSubscriptionForUser: (user: AdminUserRecordDto) => void;
  onOpenTeamSubscriptions: (team: AdminTeamRecordDto) => void;
  onOpenRenewDrawer: (subscriptionId: string) => void;
  onOpenChangePlanDrawer: (subscriptionId: string) => void;
  onOpenAdjustDrawer: (subscriptionId: string) => void;
  onOpenNodeAccessEditor: (subscriptionId: string, ownerLabel: string) => void;
  onResetSubscriptionTraffic: (subscriptionId: string, ownerLabel: string, userId?: string) => void;
  resetTrafficBusyKey: string | null;
  onLoadTeamUsage: (teamId: string, options?: { force?: boolean }) => void;
  onOpenTeamUsageDetail: (payload: {
    teamName: string;
    userDisplayName: string;
    userEmail: string;
    entry: AdminTeamUsageRecordDto;
  }) => void;
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

type DetailTarget =
  | { type: "personal"; userId: string }
  | { type: "team"; teamId: string }
  | { type: "team-member"; teamId: string; memberId: string };

type TeamMemberRoleOption = { value: TeamMemberRole; label: string; disabled?: boolean };

export function UsersPage(props: UsersPageProps) {
  const [detailTarget, setDetailTarget] = useState<DetailTarget | null>(null);
  const personalUsers = props.users.filter((item) => item.accountType === "personal");
  const subscriptionById = new Map(props.allSubscriptions.map((item) => [item.id, item]));
  const personalSubscriptionByUserId = new Map(
    props.subscriptions.filter((item) => item.ownerType === "user" && item.userId).map((item) => [item.userId!, item])
  );
  const teamMemberRoleOptions: TeamMemberRoleOption[] =
    props.teamMemberForm.role === "owner"
      ? [
          { value: "owner", label: "负责人", disabled: true },
          { value: "member", label: "成员" }
        ]
      : [{ value: "member", label: "成员" }];

  return (
    <Stack gap="lg">
      <SectionCard
        title="客户与团队"
        searchValue={props.searchValue}
        onSearchChange={props.onSearchChange}
        searchPlaceholder="搜索邮箱、名称或团队"
      >
        <Tabs value={props.userTab} onChange={(value) => props.onUserTabChange((value as "personal" | "team") || "personal")}>
          <Tabs.List>
            <Tabs.Tab value="personal">个人用户 · {personalUsers.length}</Tabs.Tab>
            <Tabs.Tab value="team">团队管理 · {props.filteredTeams.length}</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="personal" pt="md">
            <DataTable>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>客户</Table.Th>
                  <Table.Th>当前订阅</Table.Th>
                  <Table.Th>流量 / 节点</Table.Th>
                  <Table.Th>到期</Table.Th>
                  <Table.Th>状态</Table.Th>
                  <Table.Th>详情</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {personalUsers.map((item) => {
                  const fullSubscription = findUserSubscription(item, subscriptionById, personalSubscriptionByUserId);
                  const subscriptionSummary = fullSubscription ?? item.currentSubscription;
                  const subscriptionId = subscriptionSummary?.id ?? null;

                  return (
                  <Table.Tr key={item.id}>
                    <Table.Td>
                      <Stack gap={2}>
                        <Text fw={600}>{item.displayName}</Text>
                        <Text size="sm" c="dimmed">{item.email}</Text>
                        <Group gap={6}>
                          <Badge variant="light">{translateRole(item.role)}</Badge>
                          <Badge variant="light" color={item.accountType === "personal" ? "blue" : "gray"}>
                            个人
                          </Badge>
                        </Group>
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      {subscriptionSummary ? (
                        <Stack gap={2}>
                          <Text fw={600}>{subscriptionSummary.planName}</Text>
                          <StatusBadge
                            color={subscriptionStateColor(subscriptionSummary.state)}
                            label={translateSubscriptionState(subscriptionSummary.state)}
                          />
                          {fullSubscription?.stateReasonMessage ? (
                            <Text size="xs" c="dimmed" lineClamp={1}>
                              {fullSubscription.stateReasonMessage}
                            </Text>
                          ) : null}
                        </Stack>
                      ) : (
                        <Text c="orange.7">未分配订阅</Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Stack gap={4}>
                        <Text>{readTrafficText(fullSubscription, item.currentSubscription)}</Text>
                        <Text c={fullSubscription?.hasNodeAccess ? undefined : "orange.7"} size="sm">
                          {readNodeAccessText(fullSubscription)}
                        </Text>
                      </Stack>
                    </Table.Td>
                    <Table.Td>{subscriptionSummary ? formatDateTime(subscriptionSummary.expireAt) : "-"}</Table.Td>
                    <Table.Td>
                      <Stack gap={4}>
                        <StatusBadge color={item.status === "active" ? "green" : "gray"} label={`账号${translateUserStatus(item.status)}`} />
                        <PanelSyncInlineStatus
                          item={fullSubscription ?? item}
                          onOpenPanelSyncQueue={() =>
                            props.onOpenPanelSyncQueue({
                              subscriptionId: subscriptionId ?? undefined,
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
                      <Button size="xs" variant="light" onClick={() => setDetailTarget({ type: "personal", userId: item.id })}>
                        详情
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                );
                })}
              </Table.Tbody>
            </DataTable>
          </Tabs.Panel>
          <Tabs.Panel value="team" pt="md">
            <Accordion variant="separated" radius="xl">
              {props.filteredTeams.map((item) => {
                const usageLoaded = Object.prototype.hasOwnProperty.call(props.teamUsageByTeamId, item.id);
                const usageLoading = Boolean(props.teamUsageLoadingByTeamId[item.id]);
                const usageError = props.teamUsageErrorByTeamId[item.id] ?? null;
                const usageSummary = summarizeTeamUsage(props.teamUsageByTeamId[item.id] ?? []);
                const usageByUserId = new Map(usageSummary.map((entry) => [entry.userId, entry]));

                return (
                <Accordion.Item key={item.id} value={item.id}>
                  <Accordion.Control onClick={() => props.onLoadTeamUsage(item.id)}>
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
                        <TeamSubscriptionSummary team={item} allSubscriptions={props.allSubscriptions} />
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
                      <Group justify="space-between" align="flex-start">
                        <Stack gap={2}>
                          <Text fw={600}>成员</Text>
                          <Text size="sm" c="dimmed">
                            共 {item.memberCount} 人
                          </Text>
                        </Stack>
                        <Button
                          size="xs"
                          variant="light"
                          onClick={() => {
                            props.onLoadTeamUsage(item.id);
                            setDetailTarget({ type: "team", teamId: item.id });
                          }}
                        >
                          团队详情
                        </Button>
                      </Group>
                      {usageError ? (
                        <Paper withBorder radius="lg" p="md">
                          <Group justify="space-between" gap="sm">
                            <Text size="sm" c="orange.7">{usageError}</Text>
                            <Button size="xs" variant="default" onClick={() => props.onLoadTeamUsage(item.id, { force: true })}>
                              重试
                            </Button>
                          </Group>
                        </Paper>
                      ) : null}

                      <DataTable>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>账号</Table.Th>
                            <Table.Th>角色</Table.Th>
                            <Table.Th>使用情况</Table.Th>
                            <Table.Th>状态</Table.Th>
                            <Table.Th>详情</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {item.members.map((member) => {
                            const userRecord = props.allUsers.find((user) => user.id === member.userId);
                            const usageEntry = usageByUserId.get(member.userId);
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
                                  <MemberUsageCell
                                    entry={usageEntry}
                                    loading={usageLoading}
                                    loaded={usageLoaded}
                                  />
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
                                  <Button
                                    size="xs"
                                    variant="light"
                                    onClick={() => {
                                      props.onLoadTeamUsage(item.id);
                                      setDetailTarget({ type: "team-member", teamId: item.id, memberId: member.id });
                                    }}
                                  >
                                    详情
                                  </Button>
                                </Table.Td>
                              </Table.Tr>
                            );
                          })}
                        </Table.Tbody>
                      </DataTable>
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              );
              })}
            </Accordion>
          </Tabs.Panel>
        </Tabs>
      </SectionCard>
      <CustomerDetailDrawer
        target={detailTarget}
        onClose={() => setDetailTarget(null)}
        onSelectTarget={setDetailTarget}
        personalUsers={personalUsers}
        teams={props.filteredTeams}
        allUsers={props.allUsers}
        allSubscriptions={props.allSubscriptions}
        subscriptionById={subscriptionById}
        personalSubscriptionByUserId={personalSubscriptionByUserId}
        leaseRevocationJobs={props.leaseRevocationJobs}
        leaseRevocationRetryBusyKey={props.leaseRevocationRetryBusyKey}
        teamUsageByTeamId={props.teamUsageByTeamId}
        teamUsageLoadingByTeamId={props.teamUsageLoadingByTeamId}
        teamUsageErrorByTeamId={props.teamUsageErrorByTeamId}
        actionBusyKey={props.actionBusyKey}
        teamInlineEditorId={props.teamInlineEditorId}
        teamMemberInlineEditor={props.teamMemberInlineEditor}
        teamProfileBusyKey={props.teamProfileBusyKey}
        teamMemberBusyKey={props.teamMemberBusyKey}
        teamForm={props.teamForm}
        setTeamForm={props.setTeamForm}
        teamMemberForm={props.teamMemberForm}
        setTeamMemberForm={props.setTeamMemberForm}
        teamMemberRoleOptions={teamMemberRoleOptions}
        buildTeamMemberOptions={props.buildTeamMemberOptions}
        resetTrafficBusyKey={props.resetTrafficBusyKey}
        onOpenUserDrawer={props.onOpenUserDrawer}
        onCreateSubscriptionForUser={props.onCreateSubscriptionForUser}
        onOpenTeamSubscriptions={props.onOpenTeamSubscriptions}
        onOpenRenewDrawer={props.onOpenRenewDrawer}
        onOpenChangePlanDrawer={props.onOpenChangePlanDrawer}
        onOpenAdjustDrawer={props.onOpenAdjustDrawer}
        onOpenNodeAccessEditor={props.onOpenNodeAccessEditor}
        onResetSubscriptionTraffic={props.onResetSubscriptionTraffic}
        onLoadTeamUsage={props.onLoadTeamUsage}
        onOpenTeamUsageDetail={props.onOpenTeamUsageDetail}
        onOpenTeamInlineEditor={props.onOpenTeamInlineEditor}
        onCloseTeamInlineEditor={props.onCloseTeamInlineEditor}
        onSaveTeamInlineEditor={props.onSaveTeamInlineEditor}
        onOpenTeamMemberInlineEditor={props.onOpenTeamMemberInlineEditor}
        onCloseTeamMemberInlineEditor={props.onCloseTeamMemberInlineEditor}
        onSaveTeamMemberInlineEditor={props.onSaveTeamMemberInlineEditor}
        onDeleteTeamMember={props.onDeleteTeamMember}
        onToggleUserStatus={props.onToggleUserStatus}
        onToggleTeamUserStatus={props.onToggleTeamUserStatus}
        onDisconnectUser={props.onDisconnectUser}
        onRetryLeaseRevocationJob={props.onRetryLeaseRevocationJob}
        onOpenPanelSyncQueue={props.onOpenPanelSyncQueue}
      />
    </Stack>
  );
}

function MemberUsageCell(props: {
  entry?: ReturnType<typeof summarizeTeamUsage>[number];
  loading: boolean;
  loaded: boolean;
}) {
  if (props.loading) {
    return <Text size="sm" c="dimmed">加载中</Text>;
  }

  if (!props.loaded) {
    return <Text size="sm" c="dimmed">未加载</Text>;
  }

  if (!props.entry) {
    return <Text size="sm" c="dimmed">暂无用量</Text>;
  }

  return (
    <Stack gap={2}>
      <Text fw={600}>{formatTrafficGb(props.entry.totalUsedTrafficGb)} GB</Text>
      <Text size="sm" c="dimmed">
        {props.entry.nodeBreakdown?.length ?? 0} 个节点 · {formatDateTime(props.entry.lastRecordedAt)}
      </Text>
    </Stack>
  );
}

type CustomerDetailDrawerProps = {
  target: DetailTarget | null;
  onClose: () => void;
  onSelectTarget: (target: DetailTarget) => void;
  personalUsers: AdminUserRecordDto[];
  teams: AdminTeamRecordDto[];
  allUsers: AdminUserRecordDto[];
  allSubscriptions: AdminSubscriptionRecordDto[];
  subscriptionById: Map<string, AdminSubscriptionRecordDto>;
  personalSubscriptionByUserId: Map<string, AdminSubscriptionRecordDto>;
  leaseRevocationJobs: AdminLeaseRevocationJobDto[];
  leaseRevocationRetryBusyKey: string | null;
  teamUsageByTeamId: Record<string, AdminTeamUsageRecordDto[]>;
  teamUsageLoadingByTeamId: Record<string, boolean>;
  teamUsageErrorByTeamId: Record<string, string | null>;
  actionBusyKey: string | null;
  teamInlineEditorId: string | null;
  teamMemberInlineEditor: { teamId: string; memberId: string | null } | null;
  teamProfileBusyKey: string | null;
  teamMemberBusyKey: string | null;
  teamForm: TeamFormState;
  setTeamForm: Dispatch<SetStateAction<TeamFormState>>;
  teamMemberForm: TeamMemberFormState;
  setTeamMemberForm: Dispatch<SetStateAction<TeamMemberFormState>>;
  teamMemberRoleOptions: TeamMemberRoleOption[];
  buildTeamMemberOptions: (currentUserId?: string) => Array<{ value: string; label: string }>;
  resetTrafficBusyKey: string | null;
  onOpenUserDrawer: (userId: string) => void;
  onCreateSubscriptionForUser: (user: AdminUserRecordDto) => void;
  onOpenTeamSubscriptions: (team: AdminTeamRecordDto) => void;
  onOpenRenewDrawer: (subscriptionId: string) => void;
  onOpenChangePlanDrawer: (subscriptionId: string) => void;
  onOpenAdjustDrawer: (subscriptionId: string) => void;
  onOpenNodeAccessEditor: (subscriptionId: string, ownerLabel: string) => void;
  onResetSubscriptionTraffic: (subscriptionId: string, ownerLabel: string, userId?: string) => void;
  onLoadTeamUsage: (teamId: string, options?: { force?: boolean }) => void;
  onOpenTeamUsageDetail: (payload: {
    teamName: string;
    userDisplayName: string;
    userEmail: string;
    entry: AdminTeamUsageRecordDto;
  }) => void;
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

function CustomerDetailDrawer(props: CustomerDetailDrawerProps) {
  const title = readDetailTitle(props);

  return (
    <Drawer opened={props.target !== null} onClose={props.onClose} position="right" size="lg" padding="lg" title={title}>
      {props.target ? <CustomerDetailContent {...props} target={props.target} /> : null}
    </Drawer>
  );
}

type CustomerDetailContentProps = Omit<CustomerDetailDrawerProps, "target"> & { target: DetailTarget };

function CustomerDetailContent(props: CustomerDetailContentProps) {
  const target = props.target;
  const openOutsideDetail = (action: () => void) => {
    props.onClose();
    action();
  };

  if (target.type === "personal") {
    const user = props.personalUsers.find((item) => item.id === target.userId);
    if (!user) return <Text c="dimmed">客户不存在</Text>;

    const fullSubscription = findUserSubscription(user, props.subscriptionById, props.personalSubscriptionByUserId);
    const subscriptionSummary = fullSubscription ?? user.currentSubscription;
    const subscriptionId = subscriptionSummary?.id ?? null;
    const ownerLabel = `${user.displayName || user.email} · ${subscriptionSummary?.planName ?? "未分配订阅"}`;

    return (
      <Stack gap="lg">
        <DrawerSection title="客户摘要">
          <Stack gap={4}>
            <Text fw={700}>{user.displayName}</Text>
            <Text size="sm" c="dimmed">{user.email}</Text>
            <Group gap={6}>
              <Badge variant="light">{translateRole(user.role)}</Badge>
              <StatusBadge color={user.status === "active" ? "green" : "gray"} label={`账号${translateUserStatus(user.status)}`} />
            </Group>
          </Stack>
        </DrawerSection>

        <DrawerSection title="订阅与节点">
          {subscriptionSummary ? (
            <Stack gap="sm">
              <DetailRow label="套餐" value={subscriptionSummary.planName} />
              <DetailRow label="订阅状态" value={translateSubscriptionState(subscriptionSummary.state)} />
              <DetailRow label="流量" value={readTrafficText(fullSubscription, user.currentSubscription)} />
              <DetailRow label="节点" value={readNodeAccessText(fullSubscription)} />
              <DetailRow label="到期" value={formatDateTime(subscriptionSummary.expireAt)} />
              <SubscriptionOperationButtons
                subscriptionId={subscriptionId}
                ownerLabel={ownerLabel}
                resetTrafficBusyKey={props.resetTrafficBusyKey}
                renewable={fullSubscription?.renewable}
                onOpenRenewDrawer={(id) => openOutsideDetail(() => props.onOpenRenewDrawer(id))}
                onOpenChangePlanDrawer={(id) => openOutsideDetail(() => props.onOpenChangePlanDrawer(id))}
                onOpenAdjustDrawer={(id) => openOutsideDetail(() => props.onOpenAdjustDrawer(id))}
                onOpenNodeAccessEditor={(id, label) => openOutsideDetail(() => props.onOpenNodeAccessEditor(id, label))}
                onResetTraffic={() => subscriptionId ? props.onResetSubscriptionTraffic(subscriptionId, user.displayName || user.email) : undefined}
              />
            </Stack>
          ) : (
            <Button leftSection={<IconPlus size={16} />} onClick={() => openOutsideDetail(() => props.onCreateSubscriptionForUser(user))}>
              创建订阅
            </Button>
          )}
        </DrawerSection>

        <DrawerSection title="状态与同步">
          <Stack gap="sm">
            <PanelSyncInlineStatus
              item={fullSubscription ?? user}
              onOpenPanelSyncQueue={() =>
                openOutsideDetail(() =>
                  props.onOpenPanelSyncQueue({
                    subscriptionId: subscriptionId ?? undefined,
                    userId: user.id,
                    title: user.displayName
                  })
                )
              }
            />
            <LeaseRevocationInlineStatus
              jobs={props.leaseRevocationJobs.filter((job) => job.userId === user.id)}
              retryBusyKey={props.leaseRevocationRetryBusyKey}
              onRetryJob={props.onRetryLeaseRevocationJob}
            />
            {!fullSubscription?.panelSyncSummary?.total && user.panelSyncStatus !== "pending" ? <Text size="sm" c="dimmed">暂无待处理任务</Text> : null}
          </Stack>
        </DrawerSection>

        <DrawerSection title="账号操作">
          <Group gap="xs" wrap="wrap">
            <Button variant="default" leftSection={<IconPencil size={16} />} onClick={() => openOutsideDetail(() => props.onOpenUserDrawer(user.id))}>
              编辑账号
            </Button>
            <Button
              variant="default"
              color="orange"
              leftSection={<IconPlugConnectedX size={16} />}
              onClick={() => props.onDisconnectUser(user.id, user.displayName, "personal")}
              loading={props.actionBusyKey === `user-disconnect:${user.id}`}
              disabled={props.actionBusyKey !== null && props.actionBusyKey !== `user-disconnect:${user.id}`}
            >
              断开连接
            </Button>
            <Button
              variant="default"
              color={user.status === "active" ? "red" : "green"}
              leftSection={user.status === "active" ? <IconLock size={16} /> : <IconLockOpen2 size={16} />}
              onClick={() => props.onToggleUserStatus(user.id, user.status === "active" ? "disabled" : "active", user.displayName)}
              loading={props.actionBusyKey === `user-status:${user.id}`}
              disabled={props.actionBusyKey !== null && props.actionBusyKey !== `user-status:${user.id}`}
            >
              {user.status === "active" ? "禁用账号" : "启用账号"}
            </Button>
          </Group>
        </DrawerSection>
      </Stack>
    );
  }

  const team = props.teams.find((item) => item.id === target.teamId);
  if (!team) return <Text c="dimmed">团队不存在</Text>;

  if (target.type === "team") {
    const usageError = props.teamUsageErrorByTeamId[team.id] ?? null;

    return (
      <Stack gap="lg">
        <DrawerSection title="团队摘要">
          <Stack gap={4}>
            <Text fw={700}>{team.name}</Text>
            <Text size="sm" c="dimmed">{team.ownerDisplayName} · {team.ownerEmail}</Text>
            <Group gap={6}>
              <StatusBadge color={team.status === "active" ? "green" : "gray"} label={team.status === "active" ? "启用" : "停用"} />
              <Badge variant="light">{team.memberCount} 人</Badge>
            </Group>
          </Stack>
        </DrawerSection>

        <DrawerSection title="订阅与节点">
          <Stack gap="sm">
            <Group gap="xl" wrap="wrap">
              <TeamSubscriptionSummary team={team} allSubscriptions={props.allSubscriptions} />
            </Group>
            <TeamSubscriptionActions
              team={team}
              allSubscriptions={props.allSubscriptions}
              resetTrafficBusyKey={props.resetTrafficBusyKey}
              onOpenTeamSubscriptions={(targetTeam) => openOutsideDetail(() => props.onOpenTeamSubscriptions(targetTeam))}
              onOpenRenewDrawer={(id) => openOutsideDetail(() => props.onOpenRenewDrawer(id))}
              onOpenChangePlanDrawer={(id) => openOutsideDetail(() => props.onOpenChangePlanDrawer(id))}
              onOpenAdjustDrawer={(id) => openOutsideDetail(() => props.onOpenAdjustDrawer(id))}
              onOpenNodeAccessEditor={(id, label) => openOutsideDetail(() => props.onOpenNodeAccessEditor(id, label))}
              onResetSubscriptionTraffic={props.onResetSubscriptionTraffic}
            />
          </Stack>
        </DrawerSection>

        <DrawerSection title="团队操作">
          <Group gap="xs" wrap="wrap">
            <Button variant="default" leftSection={<IconPencil size={16} />} onClick={() => props.onOpenTeamInlineEditor(team.id)}>
              编辑团队
            </Button>
            <Button variant="default" leftSection={<IconUsers size={16} />} onClick={() => props.onOpenTeamMemberInlineEditor(team.id)}>
              添加成员
            </Button>
          </Group>
          {props.teamInlineEditorId === team.id ? <TeamProfileEditorPanel {...props} team={team} /> : null}
          {props.teamMemberInlineEditor?.teamId === team.id ? <TeamMemberEditorPanel {...props} /> : null}
        </DrawerSection>

        <DrawerSection title="状态与同步">
          <Stack gap="sm">
            <PanelSyncInlineStatus
              item={team}
              onOpenPanelSyncQueue={() =>
                openOutsideDetail(() =>
                  props.onOpenPanelSyncQueue({
                    subscriptionId: team.currentSubscription?.id,
                    teamId: team.id,
                    title: team.name
                  })
                )
              }
            />
            <LeaseRevocationInlineStatus
              jobs={props.leaseRevocationJobs.filter((job) =>
                team.currentSubscription?.id ? job.subscriptionId === team.currentSubscription.id && job.userId === null : false
              )}
              retryBusyKey={props.leaseRevocationRetryBusyKey}
              onRetryJob={props.onRetryLeaseRevocationJob}
            />
            {usageError ? (
              <Group justify="space-between" gap="sm">
                <Text size="sm" c="orange.7">{usageError}</Text>
                <Button size="xs" variant="default" onClick={() => props.onLoadTeamUsage(team.id, { force: true })}>
                  重试
                </Button>
              </Group>
            ) : null}
          </Stack>
        </DrawerSection>

        <DrawerSection title="成员">
          <Stack gap="sm">
            {team.members.map((member) => (
              <Group key={member.id} justify="space-between" align="center" gap="sm">
                <Stack gap={0} style={{ minWidth: 0 }}>
                  <Text fw={600}>{member.displayName}</Text>
                  <Text size="sm" c="dimmed" lineClamp={1}>{member.email}</Text>
                </Stack>
                <Button
                  size="xs"
                  variant="light"
                  onClick={() => {
                    props.onLoadTeamUsage(team.id);
                    props.onSelectTarget({ type: "team-member", teamId: team.id, memberId: member.id });
                  }}
                >
                  详情
                </Button>
              </Group>
            ))}
          </Stack>
        </DrawerSection>
      </Stack>
    );
  }

  const member = team.members.find((item) => item.id === target.memberId);
  if (!member) return <Text c="dimmed">成员不存在</Text>;

  const userRecord = props.allUsers.find((user) => user.id === member.userId);
  const usageSummary = summarizeTeamUsage(props.teamUsageByTeamId[team.id] ?? []);
  const usageEntry = usageSummary.find((entry) => entry.userId === member.userId);
  const usageLoaded = Object.prototype.hasOwnProperty.call(props.teamUsageByTeamId, team.id);
  const usageLoading = Boolean(props.teamUsageLoadingByTeamId[team.id]);

  return (
    <Stack gap="lg">
      <DrawerSection title="成员摘要">
        <Stack gap={4}>
          <Text fw={700}>{member.displayName}</Text>
          <Text size="sm" c="dimmed">{member.email}</Text>
          <Group gap={6}>
            <Badge variant="light">{member.role === "owner" ? "负责人" : "成员"}</Badge>
            <StatusBadge color={userRecord?.status === "active" ? "green" : "gray"} label={translateUserStatus(userRecord?.status ?? "disabled")} />
          </Group>
        </Stack>
      </DrawerSection>

      <DrawerSection title="使用情况">
        <Stack gap="sm">
          <MemberUsageCell entry={usageEntry} loading={usageLoading} loaded={usageLoaded} />
          {usageEntry ? (
            <Button
              variant="default"
              leftSection={<IconListDetails size={16} />}
              onClick={() =>
                openOutsideDetail(() =>
                  props.onOpenTeamUsageDetail({
                    teamName: team.name,
                    userDisplayName: usageEntry.userDisplayName,
                    userEmail: usageEntry.userEmail,
                    entry: usageEntry
                  })
                )
              }
            >
              用量详情
            </Button>
          ) : null}
        </Stack>
      </DrawerSection>

      <DrawerSection title="账号操作">
        <Group gap="xs" wrap="wrap">
          <Button variant="default" leftSection={<IconPencil size={16} />} onClick={() => openOutsideDetail(() => props.onOpenUserDrawer(member.userId))}>
            编辑账号
          </Button>
          <Button
            variant="default"
            color={userRecord?.status === "active" ? "red" : "green"}
            leftSection={userRecord?.status === "active" ? <IconLock size={16} /> : <IconLockOpen2 size={16} />}
            loading={props.actionBusyKey === `user-status:${member.userId}`}
            disabled={props.actionBusyKey !== null && props.actionBusyKey !== `user-status:${member.userId}`}
            onClick={() =>
              props.onToggleTeamUserStatus(member.userId, userRecord?.status === "active" ? "disabled" : "active", member.displayName)
            }
          >
            {userRecord?.status === "active" ? "禁用账号" : "启用账号"}
          </Button>
          <Button
            variant="default"
            color="orange"
            leftSection={<IconPlugConnectedX size={16} />}
            loading={props.actionBusyKey === `user-disconnect:${member.userId}`}
            disabled={props.actionBusyKey !== null && props.actionBusyKey !== `user-disconnect:${member.userId}`}
            onClick={() => props.onDisconnectUser(member.userId, member.displayName, "team-member")}
          >
            断开连接
          </Button>
        </Group>
      </DrawerSection>

      <DrawerSection title="团队关系">
        <Group gap="xs" wrap="wrap">
          <Button variant="default" leftSection={<IconUsers size={16} />} onClick={() => props.onOpenTeamMemberInlineEditor(team.id, member.id)}>
            编辑角色
          </Button>
          {member.role !== "owner" ? (
            <Button
              variant="default"
              color="red"
              leftSection={<IconTrash size={16} />}
              loading={props.actionBusyKey === `team-member-delete:${member.id}`}
              disabled={props.actionBusyKey !== null && props.actionBusyKey !== `team-member-delete:${member.id}`}
              onClick={() => props.onDeleteTeamMember(team.id, member.id)}
            >
              移出团队
            </Button>
          ) : null}
        </Group>
        {props.teamMemberInlineEditor?.teamId === team.id ? <TeamMemberEditorPanel {...props} /> : null}
      </DrawerSection>

      <DrawerSection title="状态与同步">
        <PanelSyncInlineStatus
          item={userRecord}
          onOpenPanelSyncQueue={() =>
            openOutsideDetail(() =>
              props.onOpenPanelSyncQueue({
                subscriptionId: team.currentSubscription?.id,
                userId: member.userId,
                teamId: team.id,
                title: `${member.displayName} · ${team.name}`
              })
            )
          }
        />
        <LeaseRevocationInlineStatus
          jobs={props.leaseRevocationJobs.filter((job) => isTeamMemberLeaseRevocationJob(job, member.userId, team.currentSubscription?.id))}
          retryBusyKey={props.leaseRevocationRetryBusyKey}
          onRetryJob={props.onRetryLeaseRevocationJob}
        />
      </DrawerSection>
    </Stack>
  );
}

function DrawerSection(props: { title: string; children: ReactNode }) {
  return (
    <Stack gap="sm">
      <Text fw={700}>{props.title}</Text>
      {props.children}
      <Divider />
    </Stack>
  );
}

function DetailRow(props: { label: string; value: string }) {
  return (
    <Group justify="space-between" align="flex-start" gap="md">
      <Text size="sm" c="dimmed">{props.label}</Text>
      <Text size="sm" fw={600} ta="right">{props.value}</Text>
    </Group>
  );
}

function SubscriptionOperationButtons(props: {
  subscriptionId: string | null;
  ownerLabel: string;
  resetTrafficBusyKey: string | null;
  renewable?: boolean;
  onOpenRenewDrawer: (subscriptionId: string) => void;
  onOpenChangePlanDrawer: (subscriptionId: string) => void;
  onOpenAdjustDrawer: (subscriptionId: string) => void;
  onOpenNodeAccessEditor: (subscriptionId: string, ownerLabel: string) => void;
  onResetTraffic: () => void;
}) {
  if (!props.subscriptionId) return null;

  return (
    <Group gap="xs" wrap="wrap">
      <Button
        variant="default"
        leftSection={<IconRefresh size={16} />}
        disabled={props.renewable === false}
        onClick={() => props.onOpenRenewDrawer(props.subscriptionId!)}
      >
        {props.renewable === undefined ? "续期" : getRenewActionText(props.renewable)}
      </Button>
      <Button variant="default" leftSection={<IconListDetails size={16} />} onClick={() => props.onOpenChangePlanDrawer(props.subscriptionId!)}>
        变更套餐
      </Button>
      <Button variant="default" leftSection={<IconPencil size={16} />} onClick={() => props.onOpenAdjustDrawer(props.subscriptionId!)}>
        调整订阅
      </Button>
      <Button variant="default" leftSection={<IconMapPin size={16} />} onClick={() => props.onOpenNodeAccessEditor(props.subscriptionId!, props.ownerLabel)}>
        节点授权
      </Button>
      <Button
        variant="default"
        color="orange"
        leftSection={<IconGaugeOff size={16} />}
        onClick={props.onResetTraffic}
        loading={props.resetTrafficBusyKey === `${props.subscriptionId}:all`}
        disabled={props.resetTrafficBusyKey !== null}
      >
        重置流量
      </Button>
    </Group>
  );
}

function TeamProfileEditorPanel(props: CustomerDetailDrawerProps & { team: AdminTeamRecordDto }) {
  return (
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
                (user.teamId === null || user.id === props.teamForm.ownerUserId || user.id === props.team.ownerUserId)
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
          onChange={(value) => props.setTeamForm((current) => ({ ...current, status: (value || "active") as TeamStatus }))}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={props.onCloseTeamInlineEditor}>
            取消
          </Button>
          <Button onClick={() => props.onSaveTeamInlineEditor(props.team.id)} loading={props.teamProfileBusyKey === props.team.id}>
            保存
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

function TeamMemberEditorPanel(props: CustomerDetailDrawerProps) {
  if (!props.teamMemberInlineEditor) return null;

  return (
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
          data={props.teamMemberRoleOptions}
          disabled={props.teamMemberForm.role === "owner"}
          value={props.teamMemberForm.role}
          onChange={(value) => props.setTeamMemberForm((current) => ({ ...current, role: (value || "member") as TeamMemberRole }))}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={props.onCloseTeamMemberInlineEditor}>
            取消
          </Button>
          <Button
            onClick={props.onSaveTeamMemberInlineEditor}
            loading={props.teamMemberBusyKey === `${props.teamMemberInlineEditor.teamId}:${props.teamMemberInlineEditor.memberId ?? "new"}`}
          >
            保存
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

function readDetailTitle(props: CustomerDetailDrawerProps) {
  const target = props.target;
  if (!target) return "详情";
  if (target.type === "personal") {
    return props.personalUsers.find((item) => item.id === target.userId)?.displayName ?? "客户详情";
  }
  const team = props.teams.find((item) => item.id === target.teamId);
  if (target.type === "team") {
    return team?.name ?? "团队详情";
  }
  const member = team?.members.find((item) => item.id === target.memberId);
  return member ? `${member.displayName} · ${team?.name ?? ""}` : "成员详情";
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
    summarizeAdminDiagnosticMessage(props.item?.panelSyncMessage, "后台同步状态待确认，请打开同步任务查看。")
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
          title="查看后台同步任务"
        >
          查看任务
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

function findUserSubscription(
  user: AdminUserRecordDto,
  subscriptionById: Map<string, AdminSubscriptionRecordDto>,
  personalSubscriptionByUserId: Map<string, AdminSubscriptionRecordDto>
) {
  if (user.currentSubscription?.id) {
    const byId = subscriptionById.get(user.currentSubscription.id);
    if (byId) return byId;
  }
  return personalSubscriptionByUserId.get(user.id) ?? null;
}

function findTeamSubscription(team: AdminTeamRecordDto, allSubscriptions: AdminSubscriptionRecordDto[]) {
  if (!team.currentSubscription) return null;
  return allSubscriptions.find((item) => item.id === team.currentSubscription?.id) ?? null;
}

function readTrafficText(fullSubscription?: AdminSubscriptionRecordDto | null, summary?: { remainingTrafficGb: number } | null) {
  if (fullSubscription) {
    return `剩余 ${formatTrafficGb(fullSubscription.remainingTrafficGb)} / 总量 ${formatTrafficGb(fullSubscription.totalTrafficGb)} GB`;
  }
  if (summary) {
    return `剩余 ${formatTrafficGb(summary.remainingTrafficGb)} GB`;
  }
  return "-";
}

function readNodeAccessText(subscription?: AdminSubscriptionRecordDto | null) {
  if (!subscription) return "未分配节点";
  return subscription.hasNodeAccess ? `${subscription.nodeCount} 个节点` : "未分配节点";
}

function TeamSubscriptionSummary(props: { team: AdminTeamRecordDto; allSubscriptions: AdminSubscriptionRecordDto[] }) {
  const fullSubscription = findTeamSubscription(props.team, props.allSubscriptions);
  const subscription = fullSubscription ?? props.team.currentSubscription;

  if (!subscription) {
    return (
      <Stack gap={0} miw={180}>
        <Text size="sm" c="dimmed">共享订阅</Text>
        <Text c="orange.7" fw={600}>未分配</Text>
      </Stack>
    );
  }

  return (
    <>
      <Stack gap={0} miw={180}>
        <Text size="sm" c="dimmed">共享订阅</Text>
        <Text fw={600}>{subscription.planName}</Text>
      </Stack>
      <Stack gap={0} miw={180}>
        <Text size="sm" c="dimmed">流量 / 节点</Text>
        <Text fw={600}>{readTrafficText(fullSubscription, props.team.currentSubscription)}</Text>
        <Text size="sm" c={fullSubscription?.hasNodeAccess ? "dimmed" : "orange.7"}>
          {readNodeAccessText(fullSubscription)}
        </Text>
      </Stack>
      <Stack gap={0} miw={150}>
        <Text size="sm" c="dimmed">到期</Text>
        <Text fw={600}>{formatDateTime(subscription.expireAt)}</Text>
      </Stack>
    </>
  );
}

function TeamSubscriptionActions(props: {
  team: AdminTeamRecordDto;
  allSubscriptions: AdminSubscriptionRecordDto[];
  resetTrafficBusyKey: string | null;
  onOpenTeamSubscriptions: (team: AdminTeamRecordDto) => void;
  onOpenRenewDrawer: (subscriptionId: string) => void;
  onOpenChangePlanDrawer: (subscriptionId: string) => void;
  onOpenAdjustDrawer: (subscriptionId: string) => void;
  onOpenNodeAccessEditor: (subscriptionId: string, ownerLabel: string) => void;
  onResetSubscriptionTraffic: (subscriptionId: string, ownerLabel: string, userId?: string) => void;
}) {
  const fullSubscription = findTeamSubscription(props.team, props.allSubscriptions);
  const subscriptionId = fullSubscription?.id ?? props.team.currentSubscription?.id ?? null;
  const ownerLabel = `${props.team.name} · ${fullSubscription?.planName ?? props.team.currentSubscription?.planName ?? "Team 订阅"}`;

  if (!subscriptionId) {
    return (
      <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => props.onOpenTeamSubscriptions(props.team)}>
        分配订阅
      </Button>
    );
  }

  return (
    <Group gap="xs" wrap="wrap">
      <Button
        size="xs"
        variant="default"
        leftSection={<IconRefresh size={14} />}
        disabled={fullSubscription ? !fullSubscription.renewable : false}
        onClick={() => props.onOpenRenewDrawer(subscriptionId)}
      >
        {fullSubscription ? getRenewActionText(fullSubscription.renewable) : "续期"}
      </Button>
      <Button size="xs" variant="default" leftSection={<IconListDetails size={14} />} onClick={() => props.onOpenChangePlanDrawer(subscriptionId)}>
        变更套餐
      </Button>
      <Button size="xs" variant="default" leftSection={<IconPencil size={14} />} onClick={() => props.onOpenAdjustDrawer(subscriptionId)}>
        调整订阅
      </Button>
      <Button size="xs" variant="default" leftSection={<IconMapPin size={14} />} onClick={() => props.onOpenNodeAccessEditor(subscriptionId, ownerLabel)}>
        节点授权
      </Button>
      <Button
        size="xs"
        color="orange"
        variant="default"
        leftSection={<IconGaugeOff size={14} />}
        onClick={() => props.onResetSubscriptionTraffic(subscriptionId, props.team.name)}
        loading={props.resetTrafficBusyKey === `${subscriptionId}:all`}
        disabled={props.resetTrafficBusyKey !== null}
      >
        重置流量
      </Button>
    </Group>
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
            aria-label="重试连接撤销"
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
