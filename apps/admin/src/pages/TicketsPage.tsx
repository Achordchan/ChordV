import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { SupportTicketStatus } from "@chordv/shared";
import {
  closeAdminSupportTicket,
  fetchAdminSupportTicketDetail,
  fetchAdminSupportTickets,
  reopenAdminSupportTicket,
  replyAdminSupportTicket,
  type AdminSupportTicketDetailDto,
  type AdminSupportTicketSummaryDto
} from "../api/client";
import { DataTable } from "../features/shared/DataTable";
import { RowActions } from "../features/shared/RowActions";
import { SectionCard } from "../features/shared/SectionCard";
import { StatusBadge } from "../features/shared/StatusBadge";
import { filterByKeyword, readError } from "../utils/admin-filters";
import { formatDateTime, formatDateTimeWithYear } from "../utils/admin-format";

type TicketOwnerFilter = "all" | "personal" | "team";
type TicketStatusFilter = "all" | SupportTicketStatus;

const ticketStatusOptions = [
  { value: "all", label: "全部状态" },
  { value: "open", label: "处理中" },
  { value: "waiting_admin", label: "待管理员回复" },
  { value: "waiting_user", label: "待用户回复" },
  { value: "closed", label: "已关闭" }
] as const;

const ownerTypeOptions = [
  { value: "all", label: "全部归属" },
  { value: "personal", label: "个人订阅" },
  { value: "team", label: "Team 订阅" }
] as const;

export function TicketsPage() {
  const [keyword, setKeyword] = useState("");
  const [statusFilter, setStatusFilter] = useState<TicketStatusFilter>("all");
  const [ownerFilter, setOwnerFilter] = useState<TicketOwnerFilter>("all");
  const [userEmailFilter, setUserEmailFilter] = useState("");
  const [tickets, setTickets] = useState<AdminSupportTicketSummaryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [selectedTicket, setSelectedTicket] = useState<AdminSupportTicketDetailDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [replySaving, setReplySaving] = useState(false);
  const [statusChanging, setStatusChanging] = useState<string | null>(null);

  useEffect(() => {
    void loadTickets();
  }, []);

  useEffect(() => {
    if (!selectedTicketId) {
      setSelectedTicket(null);
      setDetailError(null);
      setReplyDraft("");
      return;
    }
    void loadTicketDetail(selectedTicketId);
  }, [selectedTicketId]);

  const visibleTickets = useMemo(() => {
    const byKeyword = filterByKeyword(tickets, keyword, (item) => [
      item.title,
      item.userDisplayName,
      item.userEmail,
      item.teamName ?? "",
      item.lastMessagePreview ?? ""
    ]);

    return byKeyword
      .filter((item) => {
        if (statusFilter !== "all" && item.status !== statusFilter) return false;
        if (ownerFilter !== "all" && item.ownerType !== ownerFilter) return false;
        if (userEmailFilter.trim() && !item.userEmail.toLowerCase().includes(userEmailFilter.trim().toLowerCase())) {
          return false;
        }
        return true;
      })
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }, [keyword, ownerFilter, statusFilter, tickets, userEmailFilter]);

  async function loadTickets() {
    try {
      setLoading(true);
      setError(null);
      const records = await fetchAdminSupportTickets();
      const sorted = [...records].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
      setTickets(sorted);
      setSelectedTicketId((current) => {
        if (current && sorted.some((item) => item.id === current)) {
          return current;
        }
        return sorted[0]?.id ?? null;
      });
    } catch (reason) {
      setError(readError(reason, "工单接口暂不可用，请先确认后端工单接口是否已合并。"));
    } finally {
      setLoading(false);
    }
  }

  async function loadTicketDetail(ticketId: string) {
    try {
      setDetailLoading(true);
      setDetailError(null);
      const detail = await fetchAdminSupportTicketDetail(ticketId);
      setSelectedTicket(detail);
      upsertTicketSummary(detail);
    } catch (reason) {
      setSelectedTicket(null);
      setDetailError(readError(reason, "加载工单详情失败"));
    } finally {
      setDetailLoading(false);
    }
  }

  function upsertTicketSummary(record: AdminSupportTicketSummaryDto) {
    setTickets((current) =>
      [...current.filter((item) => item.id !== record.id), record].sort(
        (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      )
    );
  }

  async function handleReply() {
    if (!selectedTicket || !replyDraft.trim()) {
      return;
    }

    try {
      setReplySaving(true);
      const detail = await replyAdminSupportTicket(selectedTicket.id, {
        body: replyDraft.trim()
      });
      setSelectedTicket(detail);
      upsertTicketSummary(detail);
      setReplyDraft("");
      notifications.show({
        color: "green",
        title: "工单",
        message: "回复已发送"
      });
    } catch (reason) {
      notifications.show({
        color: "red",
        title: "工单",
        message: readError(reason, "发送回复失败")
      });
    } finally {
      setReplySaving(false);
    }
  }

  async function handleStatusAction(ticket: AdminSupportTicketSummaryDto | AdminSupportTicketDetailDto, next: "close" | "reopen") {
    try {
      setStatusChanging(ticket.id);
      const detail = next === "close" ? await closeAdminSupportTicket(ticket.id) : await reopenAdminSupportTicket(ticket.id);
      if (selectedTicketId === detail.id) {
        setSelectedTicket(detail);
      }
      upsertTicketSummary(detail);
      notifications.show({
        color: "green",
        title: "工单",
        message: next === "close" ? "工单已关闭" : "工单已重新打开"
      });
    } catch (reason) {
      notifications.show({
        color: "red",
        title: "工单",
        message: readError(reason, next === "close" ? "关闭工单失败" : "重开工单失败")
      });
    } finally {
      setStatusChanging(null);
    }
  }

  const orderedMessages = useMemo(
    () =>
      [...(selectedTicket?.messages ?? [])].sort(
        (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
      ),
    [selectedTicket?.messages]
  );

  return (
    <Stack gap="lg">
      <SectionCard searchValue={keyword} onSearchChange={setKeyword}>
        <Stack gap="md">
          <Group align="end" wrap="wrap">
            <Select
              label="状态"
              data={ticketStatusOptions.map((item) => ({ value: item.value, label: item.label }))}
              value={statusFilter}
              onChange={(value) => setStatusFilter((value as TicketStatusFilter) || "all")}
              w={180}
            />
            <TextInput
              label="用户邮箱"
              placeholder="按邮箱筛选"
              value={userEmailFilter}
              onChange={(event) => setUserEmailFilter(event.currentTarget.value)}
              w={260}
            />
            <Select
              label="归属"
              data={ownerTypeOptions.map((item) => ({ value: item.value, label: item.label }))}
              value={ownerFilter}
              onChange={(value) => setOwnerFilter((value as TicketOwnerFilter) || "all")}
              w={180}
            />
          </Group>

          {error ? (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          ) : null}

          {loading ? (
            <Group justify="center" py="xl">
              <Loader size="sm" />
            </Group>
          ) : (
            <SimpleGrid cols={{ base: 1, xl: 2 }} spacing="lg" style={{ alignItems: "start" }}>
              <Card withBorder radius="xl" p="lg">
                <Stack gap="md">
                  <Group justify="space-between">
                    <Title order={4}>工单列表</Title>
                    <Text size="sm" c="dimmed">
                      共 {visibleTickets.length} 条
                    </Text>
                  </Group>

                  <DataTable>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>标题</Table.Th>
                        <Table.Th>用户</Table.Th>
                        <Table.Th>账号邮箱</Table.Th>
                        <Table.Th>归属订阅/团队</Table.Th>
                        <Table.Th>状态</Table.Th>
                        <Table.Th>最近更新时间</Table.Th>
                        <Table.Th>来源</Table.Th>
                        <Table.Th>操作</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {visibleTickets.length === 0 ? (
                        <Table.Tr>
                          <Table.Td colSpan={8}>
                            <Text c="dimmed" ta="center" py="lg">
                              暂无符合条件的工单
                            </Text>
                          </Table.Td>
                        </Table.Tr>
                      ) : (
                        visibleTickets.map((item) => (
                          <Table.Tr
                            key={item.id}
                            style={{
                              backgroundColor: item.id === selectedTicketId ? "var(--mantine-color-blue-light)" : undefined
                            }}
                          >
                            <Table.Td>
                              <Stack gap={2}>
                                <Text fw={600}>{item.title}</Text>
                                <Text size="sm" c="dimmed" lineClamp={1}>
                                  {item.lastMessagePreview ?? "暂无内容"}
                                </Text>
                              </Stack>
                            </Table.Td>
                            <Table.Td>{item.userDisplayName}</Table.Td>
                            <Table.Td>{item.userEmail}</Table.Td>
                            <Table.Td>
                              <Stack gap={2}>
                                <Text size="sm">{item.teamName ?? "个人订阅"}</Text>
                                <Text size="xs" c="dimmed">
                                  {item.subscriptionId ? `订阅 ${item.subscriptionId.slice(0, 8)}` : "无订阅快照"}
                                </Text>
                              </Stack>
                            </Table.Td>
                            <Table.Td>
                              <StatusBadge color={ticketStatusColor(item.status)} label={translateTicketStatus(item.status)} />
                            </Table.Td>
                            <Table.Td>{formatDateTime(item.updatedAt)}</Table.Td>
                            <Table.Td>
                              <Badge variant="light">{translateTicketSource(item.source)}</Badge>
                            </Table.Td>
                            <Table.Td>
                              <RowActions>
                                <Button variant="subtle" size="compact-sm" onClick={() => setSelectedTicketId(item.id)}>
                                  查看详情
                                </Button>
                                <Button variant="subtle" size="compact-sm" onClick={() => setSelectedTicketId(item.id)}>
                                  回复
                                </Button>
                                {item.status === "closed" ? (
                                  <Button
                                    variant="subtle"
                                    size="compact-sm"
                                    color="blue"
                                    loading={statusChanging === item.id}
                                    onClick={() => void handleStatusAction(item, "reopen")}
                                  >
                                    重开
                                  </Button>
                                ) : (
                                  <Button
                                    variant="subtle"
                                    size="compact-sm"
                                    color="red"
                                    loading={statusChanging === item.id}
                                    onClick={() => void handleStatusAction(item, "close")}
                                  >
                                    关闭
                                  </Button>
                                )}
                              </RowActions>
                            </Table.Td>
                          </Table.Tr>
                        ))
                      )}
                    </Table.Tbody>
                  </DataTable>
                </Stack>
              </Card>

              <Card withBorder radius="xl" p="lg">
                <Stack gap="md">
                  <Group justify="space-between" align="center">
                    <Title order={4}>工单详情</Title>
                    {selectedTicket ? (
                      <StatusBadge color={ticketStatusColor(selectedTicket.status)} label={translateTicketStatus(selectedTicket.status)} />
                    ) : null}
                  </Group>

                  {detailError ? (
                    <Alert color="red" variant="light">
                      {detailError}
                    </Alert>
                  ) : null}

                  {detailLoading ? (
                    <Group justify="center" py="xl">
                      <Loader size="sm" />
                    </Group>
                  ) : !selectedTicket ? (
                    <Text c="dimmed">请选择左侧工单查看详情。</Text>
                  ) : (
                    <>
                      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                        <Paper withBorder radius="lg" p="md">
                          <Stack gap={2}>
                            <Text size="sm" c="dimmed">
                              标题
                            </Text>
                            <Text fw={600}>{selectedTicket.title}</Text>
                          </Stack>
                        </Paper>
                        <Paper withBorder radius="lg" p="md">
                          <Stack gap={2}>
                            <Text size="sm" c="dimmed">
                              用户
                            </Text>
                            <Text fw={600}>
                              {selectedTicket.userDisplayName} · {selectedTicket.userEmail}
                            </Text>
                          </Stack>
                        </Paper>
                        <Paper withBorder radius="lg" p="md">
                          <Stack gap={2}>
                            <Text size="sm" c="dimmed">
                              归属
                            </Text>
                            <Text fw={600}>{selectedTicket.teamName ?? "个人订阅"}</Text>
                            <Text size="sm" c="dimmed">
                              {selectedTicket.ownerType === "team" ? "Team 订阅" : "个人订阅"}
                            </Text>
                          </Stack>
                        </Paper>
                        <Paper withBorder radius="lg" p="md">
                          <Stack gap={2}>
                            <Text size="sm" c="dimmed">
                              最近更新时间
                            </Text>
                            <Text fw={600}>{formatDateTimeWithYear(selectedTicket.updatedAt)}</Text>
                          </Stack>
                        </Paper>
                      </SimpleGrid>

                      <Stack gap="sm">
                        <Group justify="space-between">
                          <Title order={5}>会话流</Title>
                          <Text size="sm" c="dimmed">
                            来源：{translateTicketSource(selectedTicket.source)}
                          </Text>
                        </Group>
                        <Stack gap="sm">
                          {orderedMessages.map((message) => (
                            <Paper key={message.id} withBorder radius="lg" p="md">
                              <Stack gap={6}>
                                <Group justify="space-between" align="start">
                                  <Stack gap={2}>
                                    <Text fw={600}>{readMessageAuthorLabel(message.authorRole, message.authorDisplayName)}</Text>
                                    <Text size="sm" c="dimmed">
                                      {message.authorEmail ?? translateMessageRole(message.authorRole)}
                                    </Text>
                                  </Stack>
                                  <Text size="sm" c="dimmed">
                                    {formatDateTimeWithYear(message.createdAt)}
                                  </Text>
                                </Group>
                                <Text style={{ whiteSpace: "pre-wrap" }}>{message.body}</Text>
                              </Stack>
                            </Paper>
                          ))}
                        </Stack>
                      </Stack>

                      <Stack gap="sm">
                        <Group justify="space-between">
                          <Title order={5}>回复</Title>
                          {selectedTicket.status === "closed" ? (
                            <Button
                              variant="default"
                              size="xs"
                              loading={statusChanging === selectedTicket.id}
                              onClick={() => void handleStatusAction(selectedTicket, "reopen")}
                            >
                              重开工单
                            </Button>
                          ) : (
                            <Button
                              variant="default"
                              color="red"
                              size="xs"
                              loading={statusChanging === selectedTicket.id}
                              onClick={() => void handleStatusAction(selectedTicket, "close")}
                            >
                              关闭工单
                            </Button>
                          )}
                        </Group>
                        <Textarea
                          minRows={5}
                          placeholder={selectedTicket.status === "closed" ? "工单已关闭，请先重开再回复。" : "输入回复内容"}
                          value={replyDraft}
                          onChange={(event) => setReplyDraft(event.currentTarget.value)}
                          disabled={selectedTicket.status === "closed"}
                        />
                        <Group justify="flex-end">
                          <Button onClick={() => void handleReply()} loading={replySaving} disabled={!replyDraft.trim() || selectedTicket.status === "closed"}>
                            发送回复
                          </Button>
                        </Group>
                      </Stack>
                    </>
                  )}
                </Stack>
              </Card>
            </SimpleGrid>
          )}
        </Stack>
      </SectionCard>
    </Stack>
  );
}

function translateTicketStatus(status: SupportTicketStatus) {
  if (status === "open") return "处理中";
  if (status === "waiting_admin") return "待管理员回复";
  if (status === "waiting_user") return "待用户回复";
  return "已关闭";
}

function ticketStatusColor(status: SupportTicketStatus) {
  if (status === "open") return "blue";
  if (status === "waiting_admin") return "orange";
  if (status === "waiting_user") return "teal";
  return "gray";
}

function translateTicketSource(source: AdminSupportTicketSummaryDto["source"]) {
  return source === "desktop" ? "桌面端" : source;
}

function translateMessageRole(role: AdminSupportTicketDetailDto["messages"][number]["authorRole"]) {
  if (role === "admin") return "管理员";
  if (role === "user") return "用户";
  return "系统";
}

function readMessageAuthorLabel(
  role: AdminSupportTicketDetailDto["messages"][number]["authorRole"],
  authorDisplayName: string | null
) {
  if (authorDisplayName) {
    return authorDisplayName;
  }
  return translateMessageRole(role);
}
