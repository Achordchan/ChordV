import type { Dispatch, SetStateAction } from "react";
import { Accordion, ActionIcon, Alert, Badge, Button, Card, Group, NumberInput, Paper, Select, SimpleGrid, Stack, Table, Tabs, Text } from "@mantine/core";
import type { AdminPlanRecordDto, AdminSubscriptionRecordDto, AdminTeamRecordDto, AdminTeamUsageRecordDto } from "@chordv/shared";
import { IconBolt, IconListDetails, IconMapPin, IconPencil, IconPlus, IconRefresh, IconUsers } from "@tabler/icons-react";
import { DataTable } from "../features/shared/DataTable";
import { ExpireAtController } from "../features/shared/ExpireAtController";
import { MiniMetric } from "../features/shared/MiniMetric";
import { RowActions } from "../features/shared/RowActions";
import { SectionCard } from "../features/shared/SectionCard";
import { StatusBadge } from "../features/shared/StatusBadge";
import type { TeamSubscriptionFormState } from "../utils/admin-forms";
import { applyPlanToTeamSubscriptionForm } from "../utils/admin-forms";
import { summarizeTeamUsage } from "../utils/admin-filters";
import { formatDateTime, formatTrafficGb } from "../utils/admin-format";
import {
  getRenewActionText,
  subscriptionStateColor,
  translateRenewableState,
  translateSourceAction,
  translateSubscriptionState,
  translateUserStatus
} from "../utils/admin-translate";

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
  teamInlineBusy: boolean;
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
  allUsers: Array<{ id: string; status: "active" | "disabled" }>;
  onOpenKickMemberModal: (teamId: string, memberId: string, memberName: string) => void;
  onOpenTeamUsageDetail: (payload: {
    teamName: string;
    userDisplayName: string;
    userEmail: string;
    entry: AdminTeamUsageRecordDto;
  }) => void;
};

export function SubscriptionsPage(props: SubscriptionsPageProps) {
  const userStatusById = new Map(props.allUsers.map((item) => [item.id, item.status] as const));

  return (
    <SectionCard searchValue={props.searchValue} onSearchChange={props.onSearchChange}>
      <Tabs value={props.subscriptionTab} onChange={(value) => props.onSubscriptionTabChange((value as "personal" | "team") || "personal")}>
        <Tabs.List>
          <Tabs.Tab value="personal">个人订阅</Tabs.Tab>
          <Tabs.Tab value="team">Team 订阅</Tabs.Tab>
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
              {props.subscriptions.filter((item) => item.ownerType === "user").map((item) => {
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
                          {item.stateReasonMessage}
                        </Text>
                      ) : null}
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
                      >
                        <IconRefresh size={16} />
                      </ActionIcon>
                      <ActionIcon variant="subtle" onClick={() => props.onOpenChangePlanDrawer(item.id)}>
                        <IconListDetails size={16} />
                      </ActionIcon>
                      <ActionIcon variant="subtle" onClick={() => props.onOpenAdjustDrawer(item.id)}>
                        <IconPencil size={16} />
                      </ActionIcon>
                      <ActionIcon
                        variant="subtle"
                        color="blue"
                        title={convertDisabledReason}
                        onClick={() => canConvertToTeam && props.onOpenConvertToTeamModal(item)}
                        disabled={!canConvertToTeam}
                      >
                        <IconUsers size={16} />
                      </ActionIcon>
                      <ActionIcon
                        variant="subtle"
                        onClick={() => props.onOpenNodeAccessEditor(item.id, `${item.userDisplayName ?? item.userEmail ?? "个人用户"} · ${item.planName}`)}
                      >
                        <IconMapPin size={16} />
                      </ActionIcon>
                      <ActionIcon
                        color="orange"
                        variant="subtle"
                        title="重置流量"
                        onClick={() => props.onResetSubscriptionTraffic(item.id, item.userDisplayName ?? item.userEmail ?? "当前个人订阅")}
                        loading={props.resetTrafficBusyKey === `${item.id}:all`}
                      >
                        <IconBolt size={16} />
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
              const renewable = teamSubscriptionRecord?.renewable ?? false;
              const usageSummary = summarizeTeamUsage(team.usage);

              return (
                <Accordion.Item key={team.id} value={team.id}>
                  <Accordion.Control>
                    <Group justify="space-between" wrap="nowrap">
                      <Stack gap={2} miw={280}>
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
                            {currentSubscription.stateReasonMessage}
                          </Text>
                        ) : null}
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
                                  校正订阅
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
                                {currentSubscription.stateReasonMessage}
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
                            <ExpireAtController
                              label="到期时间"
                              value={props.teamSubscriptionForm.expireAt}
                              baseValue={props.teamSubscriptionForm.expireAt}
                              onChange={(value) => props.setTeamSubscriptionForm((current) => ({ ...current, expireAt: value }))}
                            />
                            <Group justify="flex-end">
                              <Button variant="default" onClick={props.onCloseTeamSubscriptionInlineEditor}>取消</Button>
                              <Button onClick={() => props.onSaveTeamSubscriptionInlineEditor(team.id)} loading={props.teamInlineBusy}>保存</Button>
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
                                          </Group>
                                          <Text size="sm" c="dimmed">{member.email}</Text>
                                        </Stack>
                                          <SimpleGrid cols={{ base: 1, sm: 1 }} spacing="xs" style={{ flex: 1, minWidth: 180 }}>
                                            <MiniMetric label="成员用量" value={`${formatTrafficGb(member.usedTrafficGb)} GB`} />
                                          </SimpleGrid>
                                          <Group gap="xs" wrap="wrap" justify="flex-end">
                                            {currentSubscription ? (
                                              <Button
                                                size="xs"
                                                color="orange"
                                                variant="default"
                                                leftSection={<IconRefresh size={14} />}
                                                onClick={() => props.onResetSubscriptionTraffic(currentSubscription.id, `${member.displayName} · ${team.name}`, member.userId)}
                                                loading={props.resetTrafficBusyKey === `${currentSubscription.id}:${member.userId}`}
                                              >
                                                重置流量
                                              </Button>
                                            ) : null}
                                            <Button
                                              size="xs"
                                              color="orange"
                                              variant="light"
                                              leftSection={<IconBolt size={14} />}
                                              onClick={() => props.onOpenKickMemberModal(team.id, member.id, member.displayName)}
                                            >
                                              立即断网
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
