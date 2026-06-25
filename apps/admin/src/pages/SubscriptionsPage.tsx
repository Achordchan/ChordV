import type { Dispatch, SetStateAction } from "react";
import { Accordion, ActionIcon, Alert, Badge, Button, Card, Group, NumberInput, Paper, Select, SimpleGrid, Stack, Table, Tabs, Text } from "@mantine/core";
import type {
  AdminLeaseRevocationJobDto,
  AdminPlanRecordDto,
  AdminSubscriptionRecordDto,
  AdminTeamRecordDto,
  AdminTeamUsageRecordDto,
  AdminUserRecordDto
} from "@chordv/shared";
import {
  IconGaugeOff,
  IconListDetails,
  IconMapPin,
  IconPencil,
  IconPlugConnectedX,
  IconPlus,
  IconRefresh,
  IconUsers
} from "@tabler/icons-react";
import { DataTable } from "../features/shared/DataTable";
import { ExpireAtController } from "../features/shared/ExpireAtController";
import { MiniMetric } from "../features/shared/MiniMetric";
import { RowActions } from "../features/shared/RowActions";
import { SectionCard } from "../features/shared/SectionCard";
import { StatusBadge } from "../features/shared/StatusBadge";
import type { PanelSyncQueueFilter } from "../utils/admin-queue-filters";
import type { TeamSubscriptionFormState } from "../utils/admin-forms";
import { applyPlanToTeamSubscriptionForm } from "../utils/admin-forms";
import { summarizeAdminDiagnosticMessage, summarizeTeamUsage } from "../utils/admin-filters";
import { formatDateTime, formatTrafficGb } from "../utils/admin-format";
import {
  getRenewActionText,
  subscriptionStateColor,
  translateRenewableState,
  translateSourceAction,
  translateSubscriptionState,
  translateUserStatus
} from "../utils/admin-translate";

type PanelSyncInlineItem = {
  panelSyncStatus?: "synced" | "pending";
  panelSyncMessage?: string | null;
  panelSyncSummary?: { pending: number; running: number; failed: number; total: number; lastError: string | null } | null;
} | null | undefined;

type SubscriptionsPageProps = {
  searchValue: string;
  onSearchChange: (value: string) => void;
  subscriptionTab: "personal" | "team";
  onSubscriptionTabChange: (value: "personal" | "team") => void;
  subscriptions: AdminSubscriptionRecordDto[];
  filteredTeamSubscriptions: AdminTeamRecordDto[];
  allSubscriptions: AdminSubscriptionRecordDto[];
  plans: AdminPlanRecordDto[];
  teamSubscriptionInlineEditorId: string | null;
  teamSubscriptionForm: TeamSubscriptionFormState;
  setTeamSubscriptionForm: Dispatch<SetStateAction<TeamSubscriptionFormState>>;
  teamSubscriptionBusyKey: string | null;
  onOpenRenewDrawer: (subscriptionId: string) => void;
  onOpenChangePlanDrawer: (subscriptionId: string) => void;
  onOpenAdjustDrawer: (subscriptionId: string) => void;
  onOpenNodeAccessEditor: (subscriptionId: string, ownerLabel: string) => void;
  onOpenConvertToTeamModal: (record: AdminSubscriptionRecordDto) => void;
  hasAvailableTeamTransferTarget: boolean;
  onOpenTeamSubscriptionInlineEditor: (teamId: string) => void;
  onCloseTeamSubscriptionInlineEditor: () => void;
  onSaveTeamSubscriptionInlineEditor: (teamId: string) => void;
  onResetSubscriptionTraffic: (subscriptionId: string, ownerLabel: string, userId?: string) => void;
  resetTrafficBusyKey: string | null;
  allUsers: AdminUserRecordDto[];
  leaseRevocationJobs: AdminLeaseRevocationJobDto[];
  leaseRevocationRetryBusyKey: string | null;
  onOpenKickMemberModal: (teamId: string, memberId: string, memberName: string) => void;
  onRetryLeaseRevocationJob: (jobId: string) => void;
  onOpenTeamUsageDetail: (payload: {
    teamName: string;
    userDisplayName: string;
    userEmail: string;
    entry: AdminTeamUsageRecordDto;
  }) => void;
  teamUsageByTeamId: Record<string, AdminTeamUsageRecordDto[]>;
  teamUsageLoadingByTeamId: Record<string, boolean>;
  teamUsageErrorByTeamId: Record<string, string | null>;
  onLoadTeamUsage: (teamId: string, options?: { force?: boolean }) => void;
  onOpenPanelSyncQueue: (filter?: PanelSyncQueueFilter) => void;
};

export function SubscriptionsPage(props: SubscriptionsPageProps) {
  const userStatusById = new Map(props.allUsers.map((item) => [item.id, item.status] as const));
  const personalSubscriptions = props.subscriptions.filter((item) => item.ownerType === "user");

  return (
    <SectionCard
      title="订阅与授权"
      searchValue={props.searchValue}
      onSearchChange={props.onSearchChange}
      searchPlaceholder="搜索用户、套餐或团队"
    >
      <Tabs value={props.subscriptionTab} onChange={(value) => props.onSubscriptionTabChange((value as "personal" | "team") || "personal")}>
        <Tabs.List>
          <Tabs.Tab value="personal">个人订阅 · {personalSubscriptions.length}</Tabs.Tab>
          <Tabs.Tab value="team">Team 订阅 · {props.filteredTeamSubscriptions.length}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="personal" pt="md">
          <DataTable>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>用户</Table.Th>
                <Table.Th>套餐</Table.Th>
                <Table.Th>总量</Table.Th>
                <Table.Th>剩余</Table.Th>
                <Table.Th>节点</Table.Th>
                <Table.Th>到期时间</Table.Th>
                <Table.Th>状态</Table.Th>
                <Table.Th>来源</Table.Th>
                <Table.Th>操作</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {personalSubscriptions.map((item) => {
                const ownerIdReady = Boolean(item.userId);
                const ownerStatus = ownerIdReady ? userStatusById.get(item.userId!) : undefined;
                const ownerReady = ownerIdReady && ownerStatus !== undefined;
                const ownerActive = ownerReady && ownerStatus === "active";
                const canConvertToTeam = props.hasAvailableTeamTransferTarget && ownerActive;
                const convertDisabledReason = !props.hasAvailableTeamTransferTarget
                  ? "暂无可转入的 Team 订阅"
                  : !ownerIdReady
                    ? "当前订阅缺少用户归属信息"
                    : !ownerReady
                      ? "当前用户信息未同步，请先刷新重试"
                      : ownerActive
                      ? "转入 Team"
                      : "该账号已禁用，不能转入 Team";

                return (
                <Table.Tr key={item.id}>
                  <Table.Td>
                    <Stack gap={0}>
                      <Text>{item.userDisplayName}</Text>
                      <Text size="sm" c="dimmed">{item.userEmail}</Text>
                    </Stack>
                  </Table.Td>
                  <Table.Td>{item.planName}</Table.Td>
                  <Table.Td>{item.totalTrafficGb} GB</Table.Td>
                  <Table.Td>{item.remainingTrafficGb} GB</Table.Td>
                  <Table.Td>
                    <Text c={item.hasNodeAccess ? undefined : "orange.7"}>
                      {item.hasNodeAccess ? `${item.nodeCount} 个节点` : "未分配节点"}
                    </Text>
                  </Table.Td>
                  <Table.Td>{formatDateTime(item.expireAt)}</Table.Td>
                  <Table.Td>
                    <Stack gap={4}>
                      <StatusBadge color={subscriptionStateColor(item.state)} label={translateSubscriptionState(item.state)} />
                      {item.stateReasonMessage ? (
                        <Text size="xs" c="dimmed">
                          {formatSubscriptionStateReason(item.stateReasonMessage)}
                        </Text>
                      ) : null}
                      <PanelSyncInlineStatus
                        item={item}
                        onOpenPanelSyncQueue={() =>
                          props.onOpenPanelSyncQueue({
                            subscriptionId: item.id,
                            userId: item.userId ?? undefined,
                            title: `${item.userDisplayName ?? item.userEmail ?? "当前用户"} · ${item.planName}`
                          })
                        }
                      />
                      <LeaseRevocationInlineStatus
                        jobs={props.leaseRevocationJobs.filter((job) => job.subscriptionId === item.id)}
                        retryBusyKey={props.leaseRevocationRetryBusyKey}
                        onRetryJob={props.onRetryLeaseRevocationJob}
                      />
                    </Stack>
                  </Table.Td>
                  <Table.Td>{translateSourceAction(item.sourceAction)}</Table.Td>
                  <Table.Td>
                    <RowActions>
                      <ActionIcon
                        variant="subtle"
                        onClick={() => props.onOpenRenewDrawer(item.id)}
                        disabled={!item.renewable}
                        title={getRenewActionText(item.renewable)}
                        aria-label={getRenewActionText(item.renewable)}
                      >
                        <IconRefresh size={16} />
                      </ActionIcon>
                      <ActionIcon
                        variant="subtle"
                        onClick={() => props.onOpenChangePlanDrawer(item.id)}
                        title="变更套餐"
                        aria-label="变更套餐"
                      >
                        <IconListDetails size={16} />
                      </ActionIcon>
                      <ActionIcon
                        variant="subtle"
                        onClick={() => props.onOpenAdjustDrawer(item.id)}
                        title="调整订阅"
                        aria-label="调整订阅"
                      >
                        <IconPencil size={16} />
                      </ActionIcon>
                      <ActionIcon
                        variant="subtle"
                        color="blue"
                        title={convertDisabledReason}
                        aria-label="转为团队订阅"
                        onClick={() => canConvertToTeam && props.onOpenConvertToTeamModal(item)}
                        disabled={!canConvertToTeam}
                      >
                        <IconUsers size={16} />
                      </ActionIcon>
                      <ActionIcon
                        variant="subtle"
                        onClick={() => props.onOpenNodeAccessEditor(item.id, `${item.userDisplayName ?? item.userEmail ?? "个人用户"} · ${item.planName}`)}
                        title="节点授权"
                        aria-label="节点授权"
                      >
                        <IconMapPin size={16} />
                      </ActionIcon>
                      <ActionIcon
                        color="orange"
                        variant="subtle"
                        title="重置流量"
                        aria-label="重置流量"
                        onClick={() => props.onResetSubscriptionTraffic(item.id, item.userDisplayName ?? item.userEmail ?? "当前个人订阅")}
                        loading={props.resetTrafficBusyKey === `${item.id}:all`}
                        disabled={props.resetTrafficBusyKey !== null}
                      >
                        <IconGaugeOff size={16} />
                      </ActionIcon>
                    </RowActions>
                  </Table.Td>
                </Table.Tr>
              );
              })}
            </Table.Tbody>
          </DataTable>
        </Tabs.Panel>
        <Tabs.Panel value="team" pt="md">
          <Accordion variant="separated" radius="xl">
            {props.filteredTeamSubscriptions.map((team) => {
              const currentSubscription = team.currentSubscription;
              const teamSubscriptionRecord = team.currentSubscription
                ? props.allSubscriptions.find((item) => item.id === team.currentSubscription?.id)
                : null;
              const teamPanelSyncItem = pickPanelSyncInlineItem(teamSubscriptionRecord, team);
              const renewable = teamSubscriptionRecord?.renewable ?? false;
              const usageLoaded = Object.prototype.hasOwnProperty.call(props.teamUsageByTeamId, team.id);
              const usageLoading = Boolean(props.teamUsageLoadingByTeamId[team.id]);
              const usageError = props.teamUsageErrorByTeamId[team.id] ?? null;
              const usageSummary = summarizeTeamUsage(props.teamUsageByTeamId[team.id] ?? []);
              const usageByUserId = new Map(usageSummary.map((entry) => [entry.userId, entry]));

              return (
                <Accordion.Item key={team.id} value={team.id}>
                  <Accordion.Control onClick={() => props.onLoadTeamUsage(team.id)}>
                    <Group justify="space-between" wrap="wrap">
                      <Stack gap={2} miw={280} style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                        <Text fw={600}>{team.name}</Text>
                        <Text size="sm" c="dimmed">
                          {team.ownerDisplayName} · {team.memberCount} 人
                        </Text>
                        <Text size="sm" c="dimmed">
                          {currentSubscription
                            ? `${currentSubscription.planName} · 剩余 ${formatTrafficGb(currentSubscription.remainingTrafficGb)} GB · 到期 ${formatDateTime(currentSubscription.expireAt)}`
                            : "未分配共享订阅"}
                        </Text>
                        {currentSubscription?.stateReasonMessage ? (
                          <Text size="sm" c="orange.7">
                            {formatSubscriptionStateReason(currentSubscription.stateReasonMessage)}
                          </Text>
                        ) : null}
                        <PanelSyncInlineStatus
                          item={teamPanelSyncItem}
                          onOpenPanelSyncQueue={() =>
                            props.onOpenPanelSyncQueue({
                              subscriptionId: teamSubscriptionRecord?.id ?? currentSubscription?.id,
                              teamId: team.id,
                              title: `${team.name} · ${teamSubscriptionRecord?.planName ?? "Team 订阅"}`
                            })
                          }
                        />
                        <LeaseRevocationInlineStatus
                          jobs={props.leaseRevocationJobs.filter((job) =>
                            currentSubscription?.id ? job.subscriptionId === currentSubscription.id && job.userId === null : false
                          )}
                          retryBusyKey={props.leaseRevocationRetryBusyKey}
                          onRetryJob={props.onRetryLeaseRevocationJob}
                        />
                      </Stack>
                      <StatusBadge
                        color={subscriptionStateColor(currentSubscription?.state ?? "paused")}
                        label={currentSubscription ? translateSubscriptionState(currentSubscription.state) : "未分配"}
                      />
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Stack gap="md">
                      <Paper withBorder radius="lg" p="md">
                        <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
                          <Stack gap={2}>
                            <Text fw={600}>共享订阅</Text>
                            <Text size="sm" c="dimmed">
                              这里只保留共享订阅、节点授权、会话动作和账单查看。
                            </Text>
                          </Stack>
                          <Group gap="xs" wrap="wrap">
                            {currentSubscription ? (
                              <>
                                <Button
                                  size="xs"
                                  variant="default"
                                  leftSection={<IconRefresh size={14} />}
                                  onClick={() => props.onOpenRenewDrawer(currentSubscription.id)}
                                  disabled={!renewable}
                                  title={getRenewActionText(renewable)}
                                >
                                  {getRenewActionText(renewable)}
                                </Button>
                                <Button size="xs" variant="default" leftSection={<IconListDetails size={14} />} onClick={() => props.onOpenChangePlanDrawer(currentSubscription.id)}>
                                  变更套餐
                                </Button>
                                <Button size="xs" variant="default" leftSection={<IconPencil size={14} />} onClick={() => props.onOpenAdjustDrawer(currentSubscription.id)}>
                                  调整订阅
                                </Button>
                                <Button
                                  size="xs"
                                  variant="default"
                                  leftSection={<IconMapPin size={14} />}
                                  onClick={() => props.onOpenNodeAccessEditor(currentSubscription.id, `${team.name} · ${currentSubscription.planName}`)}
                                >
                                  节点授权
                                </Button>
                              </>
                            ) : (
                              <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => props.onOpenTeamSubscriptionInlineEditor(team.id)}>
                                分配 Team 套餐
                              </Button>
                            )}
                          </Group>
                        </Group>
                        {currentSubscription ? (
                          <>
                            <SimpleGrid cols={{ base: 1, sm: 2, xl: 4 }} spacing="sm" verticalSpacing="sm" mt="md">
                              <MiniMetric label="共享套餐" value={currentSubscription.planName} />
                              <MiniMetric
                                label="流量情况"
                                value={`总量 ${formatTrafficGb(currentSubscription.totalTrafficGb)} GB · 剩余 ${formatTrafficGb(currentSubscription.remainingTrafficGb)} GB`}
                              />
                              <MiniMetric
                                label="节点授权"
                                value={teamSubscriptionRecord?.hasNodeAccess ? `${teamSubscriptionRecord.nodeCount} 个节点` : "未分配节点"}
                              />
                              <MiniMetric
                                label="续期规则"
                                value={translateRenewableState(renewable)}
                              />
                            </SimpleGrid>
                            {currentSubscription.stateReasonMessage ? (
                              <Alert color={subscriptionStateColor(currentSubscription.state)} variant="light" mt="md">
                                {formatSubscriptionStateReason(currentSubscription.stateReasonMessage)}
                              </Alert>
                            ) : null}
                            {teamSubscriptionRecord?.panelSyncStatus === "pending" ? (
                              <Alert color="yellow" variant="light" mt="md">
                                {buildPanelSyncInlineMessage(teamSubscriptionRecord)}
                              </Alert>
                            ) : null}
                          </>
                        ) : (
                          <Alert color="blue" variant="light" mt="md">
                            当前团队还没有共享订阅，请先分配 Team 套餐，再进行节点授权和会话管理。
                          </Alert>
                        )}
                      </Paper>

                      {props.teamSubscriptionInlineEditorId === team.id ? (
                        <Paper withBorder radius="lg" p="md">
                          <Stack gap="sm">
                            <Text fw={600}>分配 Team 套餐</Text>
                            <Select
                              label="套餐"
                              data={props.plans.filter((item) => item.isActive && item.scope === "team").map((item) => ({ value: item.id, label: item.name }))}
                              value={props.teamSubscriptionForm.planId}
                              onChange={(value) =>
                                props.setTeamSubscriptionForm((current) =>
                                  applyPlanToTeamSubscriptionForm({ plans: props.plans }, current, value || "")
                                )
                              }
                            />
                            <NumberInput
                              label="总流量 (GB)"
                              min={0}
                              value={props.teamSubscriptionForm.totalTrafficGb}
                              onChange={(value) => props.setTeamSubscriptionForm((current) => ({ ...current, totalTrafficGb: Number(value) || 0 }))}
                            />
                            <NumberInput
                              label="已用流量 (GB)"
                              min={0}
                              value={props.teamSubscriptionForm.usedTrafficGb}
                              onChange={(value) => props.setTeamSubscriptionForm((current) => ({ ...current, usedTrafficGb: Number(value) || 0 }))}
                            />
                            <ExpireAtController
                              label="到期时间"
                              value={props.teamSubscriptionForm.expireAt}
                              baseValue={props.teamSubscriptionForm.expireAt}
                              onChange={(value) => props.setTeamSubscriptionForm((current) => ({ ...current, expireAt: value }))}
                            />
                            <Group justify="flex-end">
                              <Button variant="default" onClick={props.onCloseTeamSubscriptionInlineEditor}>取消</Button>
                              <Button onClick={() => props.onSaveTeamSubscriptionInlineEditor(team.id)} loading={props.teamSubscriptionBusyKey === team.id}>保存</Button>
                            </Group>
                          </Stack>
                        </Paper>
                      ) : null}

                      <SimpleGrid cols={{ base: 1, xl: 2 }} spacing="md" verticalSpacing="md">
                        <Stack gap="md">
                          <Card withBorder radius="lg" p="md">
                            <Stack gap="sm">
                              <Group justify="space-between" wrap="wrap" gap="sm">
                                <div>
                                  <Text fw={600}>团队成员</Text>
                                  <Text size="sm" c="dimmed">在这里查看成员状态、用量，并执行团队范围内的角色和会话操作。</Text>
                                </div>
                                <Badge variant="light">{team.memberCount} 人</Badge>
                              </Group>
                              {team.members.length > 0 ? (
                                <Stack gap="sm">
                                  {team.members.map((member) => {
                                    const userRecord = props.allUsers.find((item) => item.id === member.userId);
                                    return (
                                      <Paper key={member.id} withBorder radius="lg" p="md">
                                        <Group justify="space-between" align="center" wrap="wrap" gap="md">
                                          <Stack gap={4} style={{ flex: 1, minWidth: 220 }}>
                                            <Group gap="xs" wrap="wrap">
                                              <Text fw={600}>{member.displayName}</Text>
                                              <Badge variant="light">{member.role === "owner" ? "负责人" : "成员"}</Badge>
                                              <StatusBadge
                                                color={userRecord?.status === "active" ? "green" : "gray"}
                                                label={translateUserStatus(userRecord?.status ?? "disabled")}
                                              />
                                              <PanelSyncInlineStatus
                                                item={userRecord}
                                                onOpenPanelSyncQueue={() =>
                                                  props.onOpenPanelSyncQueue({
                                                    subscriptionId: currentSubscription?.id,
                                                    userId: member.userId,
                                                    teamId: team.id,
                                                    title: `${member.displayName} · ${team.name}`
                                                  })
                                                }
                                              />
                                              <LeaseRevocationInlineStatus
                                                jobs={props.leaseRevocationJobs.filter((job) =>
                                                  isTeamMemberLeaseRevocationJob(job, member.userId, currentSubscription?.id)
                                                )}
                                                retryBusyKey={props.leaseRevocationRetryBusyKey}
                                                onRetryJob={props.onRetryLeaseRevocationJob}
                                              />
                                          </Group>
                                          <Text size="sm" c="dimmed">{member.email}</Text>
                                        </Stack>
                                          <SimpleGrid cols={{ base: 1, sm: 1 }} spacing="xs" style={{ flex: 1, minWidth: 180 }}>
                                            <MiniMetric
                                              label="成员用量"
                                              value={
                                                usageLoaded
                                                  ? `${formatTrafficGb(usageByUserId.get(member.userId)?.usedTrafficGb ?? 0)} GB`
                                                  : usageLoading
                                                    ? "加载中"
                                                    : "未加载"
                                              }
                                            />
                                          </SimpleGrid>
                                          <Group gap="xs" wrap="wrap" justify="flex-end">
                                            {currentSubscription ? (
                                              <Button
                                                size="xs"
                                                color="orange"
                                                variant="default"
                                                leftSection={<IconGaugeOff size={14} />}
                                                onClick={() => props.onResetSubscriptionTraffic(currentSubscription.id, `${member.displayName} · ${team.name}`, member.userId)}
                                                loading={props.resetTrafficBusyKey === `${currentSubscription.id}:${member.userId}`}
                                                disabled={props.resetTrafficBusyKey !== null}
                                              >
                                                重置流量
                                              </Button>
                                            ) : null}
                                            <Button
                                              size="xs"
                                              color="orange"
                                              variant="light"
                                              leftSection={<IconPlugConnectedX size={14} />}
                                              onClick={() => props.onOpenKickMemberModal(team.id, member.id, member.displayName)}
                                              title="Team 范围：断开该成员在当前 Team 订阅下的连接"
                                            >
                                              断开本 Team 连接
                                            </Button>
                                          </Group>
                                        </Group>
                                      </Paper>
                                    );
                                  })}
                                </Stack>
                              ) : (
                                <Text size="sm" c="dimmed">当前团队还没有成员</Text>
                              )}
                            </Stack>
                          </Card>
                        </Stack>

                        <Card withBorder radius="lg" p="md">
                          <Stack gap="sm">
                            <Group justify="space-between" wrap="wrap" gap="sm">
                              <div>
                                <Text fw={600}>成员流量汇总</Text>
                                <Text size="sm" c="dimmed">这里直接看成员总量和节点分布，需要更细时再打开二级弹窗。</Text>
                              </div>
                              <Badge variant="light">{usageSummary.length} 人</Badge>
                            </Group>
                            {usageError ? (
                              <Alert color="yellow" variant="light">
                                <Group justify="space-between" gap="sm">
                                  <Text size="sm">{usageError}</Text>
                                  <Button size="xs" variant="default" onClick={() => props.onLoadTeamUsage(team.id, { force: true })}>
                                    重试
                                  </Button>
                                </Group>
                              </Alert>
                            ) : null}
                            {!usageLoaded && !usageLoading && !usageError ? (
                              <Alert color="blue" variant="light">
                                展开 Team 后会按需加载成员流量，避免后台列表被历史账单拖慢。
                              </Alert>
                            ) : null}
                            {usageLoading ? (
                              <Text size="sm" c="dimmed">正在加载成员流量...</Text>
                            ) : null}
                            {usageSummary.length > 0 ? (
                              <Stack gap="sm">
                                {usageSummary.map((entry) => (
                                  <Paper key={entry.userId} withBorder radius="lg" p="md">
                                    <Group justify="space-between" align="center" wrap="wrap" gap="md">
                                      <Stack gap={4} style={{ flex: 1, minWidth: 220 }}>
                                        <Text fw={600}>{entry.userDisplayName}</Text>
                                        <Text size="sm" c="dimmed">{entry.userEmail}</Text>
                                        <Text size="sm" c="dimmed">最近使用 {formatDateTime(entry.lastRecordedAt)}</Text>
                                        {entry.nodeBreakdown?.length ? (
                                          <Group gap="xs" wrap="wrap">
                                            {entry.nodeBreakdown.map((node) => (
                                              <Badge key={node.nodeId} variant="light" leftSection={<IconMapPin size={12} />}>
                                                {node.nodeName} · {formatTrafficGb(node.usedTrafficGb)} GB
                                              </Badge>
                                            ))}
                                          </Group>
                                        ) : null}
                                      </Stack>
                                      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs" style={{ flex: 1, minWidth: 220 }}>
                                        <MiniMetric label="累计用量" value={`${formatTrafficGb(entry.totalUsedTrafficGb)} GB`} />
                                        <MiniMetric label="节点数量" value={`${entry.nodeBreakdown?.length ?? 0} 个`} />
                                      </SimpleGrid>
                                      <Button
                                        size="xs"
                                        variant="default"
                                        onClick={() =>
                                          props.onOpenTeamUsageDetail({
                                            teamName: team.name,
                                            userDisplayName: entry.userDisplayName,
                                            userEmail: entry.userEmail,
                                            entry
                                          })
                                        }
                                      >
                                        查看节点明细
                                      </Button>
                                    </Group>
                                  </Paper>
                                ))}
                              </Stack>
                            ) : (
                              <Text size="sm" c="dimmed">暂无流量明细</Text>
                            )}
                          </Stack>
                        </Card>
                      </SimpleGrid>
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              );
            })}
          </Accordion>
        </Tabs.Panel>
      </Tabs>
    </SectionCard>
  );
}

function pickPanelSyncInlineItem(primary: PanelSyncInlineItem, fallback: PanelSyncInlineItem): PanelSyncInlineItem {
  return hasPanelSyncInlineData(primary) ? primary : fallback;
}

function hasPanelSyncInlineData(item: PanelSyncInlineItem) {
  const summary = item?.panelSyncSummary;
  return item?.panelSyncStatus === "pending" || (summary?.total ?? 0) > 0;
}

function PanelSyncInlineStatus(props: {
  item?: PanelSyncInlineItem;
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

function buildPanelSyncInlineMessage(item: {
  panelSyncMessage?: string | null;
  panelSyncSummary?: { pending: number; running: number; failed: number; total: number; lastError: string | null } | null;
}) {
  const summary = item.panelSyncSummary;
  const label = summary ? buildPanelSyncPendingLabel(summary) : "面板同步待处理";
  const detail = [
    summarizeAdminDiagnosticMessage(summary?.lastError, "面板同步任务失败，请稍后重试或查看服务器日志。"),
    summarizeAdminDiagnosticMessage(item.panelSyncMessage, "后台同步状态待确认，请打开同步任务查看。")
  ]
    .filter(Boolean)
    .join(" · ");
  return detail ? `${label}：${detail}` : label;
}

function formatSubscriptionStateReason(message: string) {
  return summarizeAdminDiagnosticMessage(message, "订阅状态已变更，请查看订阅详情。") ?? "订阅状态已变更，请查看订阅详情。";
}
