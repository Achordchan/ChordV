import { DataSkeleton } from "../features/shared/DataSkeleton";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Modal,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
  Title
} from "@mantine/core";
import type { SupportTicketStatus } from "@chordv/shared";
import { IconRefresh } from "@tabler/icons-react";
import {
  fetchAdminSupportTicketDetail,
  fetchAdminSupportTickets,
  type AdminSupportTicketDetailDto,
  type AdminSupportTicketSummaryDto
} from "../api/client";
import { SectionCard } from "../features/shared/SectionCard";
import { StatusBadge } from "../features/shared/StatusBadge";
import { filterByKeyword, readError } from "../utils/admin-filters";
import { formatDateTime, formatDateTimeWithYear } from "../utils/admin-format";

type TicketOwnerFilter = "all" | "personal" | "team";
type TicketStatusFilter = "all" | SupportTicketStatus;
type TicketAttachmentPreview = {
  url: string;
  fileName: string;
};
type TicketAttachmentImageState = "loading" | "loaded" | "failed";

/** 自建工单已迁移到 Achord Connect：这里只保留历史记录的查看与搜索，不能回复或修改状态。 */
export const LEGACY_TICKETS_READ_ONLY_NOTICE = "工单系统已迁移到 Achord Connect，这里仅保留历史记录，只读。";

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

type TicketsPageProps = {
  refreshSignal?: number;
};

export function TicketsPage(props: TicketsPageProps) {
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
  const [previewAttachment, setPreviewAttachment] = useState<TicketAttachmentPreview | null>(null);
  const selectedTicketIdRef = useRef<string | null>(null);
  const ticketListRequestSeqRef = useRef(0);
  const detailRequestSeqRef = useRef(0);
  const ticketListLoadingSeqRef = useRef<number | null>(null);
  const ticketDetailLoadingSeqRef = useRef<number | null>(null);

  useEffect(() => {
    void loadTickets();
  }, []);

  useEffect(() => {
    if (!props.refreshSignal) {
      return;
    }
    void loadTickets({ silent: true });
    const ticketId = selectedTicketIdRef.current;
    if (ticketId) {
      void loadTicketDetail(ticketId, { silent: true });
    }
  }, [props.refreshSignal]);

  useEffect(() => {
    selectedTicketIdRef.current = selectedTicketId;
  }, [selectedTicketId]);

  useEffect(() => {
    if (!selectedTicketId) {
      setSelectedTicket(null);
      setDetailError(null);
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

  useEffect(() => {
    setSelectedTicketId((current) => {
      if (current && visibleTickets.some((item) => item.id === current)) {
        return current;
      }
      return visibleTickets[0]?.id ?? null;
    });
  }, [visibleTickets]);

  async function loadTickets(options?: { silent?: boolean }) {
    const requestSeq = ++ticketListRequestSeqRef.current;
    try {
      if (!options?.silent) {
        ticketListLoadingSeqRef.current = requestSeq;
        setLoading(true);
        setError(null);
      }
      const records = await fetchAdminSupportTickets();
      if (requestSeq !== ticketListRequestSeqRef.current) {
        return;
      }
      const sorted = [...records].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
      setTickets(sorted);
      setSelectedTicketId((current) => {
        if (current && sorted.some((item) => item.id === current)) {
          return current;
        }
        return sorted[0]?.id ?? null;
      });
    } catch (reason) {
      if (requestSeq !== ticketListRequestSeqRef.current) {
        return;
      }
      if (!options?.silent) {
        setError(readError(reason, "工单加载失败，请检查后台服务或稍后重试。"));
      }
    } finally {
      if (ticketListLoadingSeqRef.current === requestSeq) {
        ticketListLoadingSeqRef.current = null;
        setLoading(false);
      }
    }
  }

  async function loadTicketDetail(ticketId: string, options?: { silent?: boolean }) {
    const requestSeq = ++detailRequestSeqRef.current;
    try {
      if (!options?.silent) {
        ticketDetailLoadingSeqRef.current = requestSeq;
        setDetailLoading(true);
        setDetailError(null);
      }
      const detail = await fetchAdminSupportTicketDetail(ticketId);
      if (requestSeq !== detailRequestSeqRef.current || selectedTicketIdRef.current !== ticketId) {
        return;
      }
      setSelectedTicket(detail);
      upsertTicketSummary(detail);
    } catch (reason) {
      if (requestSeq !== detailRequestSeqRef.current || selectedTicketIdRef.current !== ticketId) {
        return;
      }
      if (options?.silent) {
        return;
      }
      setSelectedTicket(null);
      setDetailError(readError(reason, "加载工单详情失败"));
    } finally {
      if (ticketDetailLoadingSeqRef.current === requestSeq) {
        ticketDetailLoadingSeqRef.current = null;
        setDetailLoading(false);
      }
    }
  }

  function upsertTicketSummary(record: AdminSupportTicketSummaryDto) {
    setTickets((current) =>
      [...current.filter((item) => item.id !== record.id), record].sort(
        (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      )
    );
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
          <Alert color="blue" variant="light" className="admin-tickets-readonly-notice">
            {LEGACY_TICKETS_READ_ONLY_NOTICE}
          </Alert>
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
            <Button
              variant="light"
              leftSection={<IconRefresh size={16} />}
              onClick={() => {
                void loadTickets();
                const ticketId = selectedTicketIdRef.current;
                if (ticketId) {
                  void loadTicketDetail(ticketId);
                }
              }}
              loading={loading || detailLoading}
            >
              刷新
            </Button>
          </Group>

          {error ? (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          ) : null}

          {loading && tickets.length === 0 ? (
            <DataSkeleton rows={5}/>
          ) : (
            <div className="admin-tickets-workspace">
              <Card withBorder radius="xl" p="lg" className="admin-tickets-list-card">
                <Stack gap="sm" h="100%">
                  <Group justify="space-between">
                    <Title order={4}>工单列表</Title>
                    <Text size="sm" c="dimmed">
                      共 {visibleTickets.length} 条
                    </Text>
                  </Group>

                  <div className="admin-tickets-list">
                    {visibleTickets.length === 0 ? (
                      <Text c="dimmed" ta="center" py="xl">
                        暂无符合条件的工单
                      </Text>
                    ) : (
                      visibleTickets.map((item) => {
                        const active = item.id === selectedTicketId;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            className={active ? "admin-ticket-list-item admin-ticket-list-item--active" : "admin-ticket-list-item"}
                            onClick={() => setSelectedTicketId(item.id)}
                          >
                            <div className="admin-ticket-list-item__head">
                              <Text fw={700} lineClamp={1}>
                                {item.title}
                              </Text>
                              <StatusBadge color={ticketStatusColor(item.status)} label={translateTicketStatus(item.status)} />
                            </div>
                            <Text size="sm" c="dimmed" lineClamp={2}>
                              {item.lastMessagePreview ?? "暂无内容"}
                            </Text>
                            <div className="admin-ticket-list-item__meta">
                              <Text size="xs" c="dimmed" lineClamp={1}>
                                {item.userDisplayName} · {item.userEmail}
                              </Text>
                              <Text size="xs" c="dimmed">
                                {formatDateTime(item.updatedAt)}
                              </Text>
                            </div>
                            <div className="admin-ticket-list-item__foot">
                              <Badge variant="light">{translateTicketSource(item.source)}</Badge>
                              <Text size="xs" c="dimmed" lineClamp={1}>
                                {item.teamName ?? "个人订阅"}
                              </Text>
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </Stack>
              </Card>

              <Card withBorder radius="xl" p="lg" className="admin-ticket-detail-card">
                <Stack gap="md" h="100%">
                  <div className="admin-ticket-detail-head">
                    <div>
                      <Title order={4}>工单详情</Title>
                      {selectedTicket ? (
                        <Text size="sm" c="dimmed">
                          来源：{translateTicketSource(selectedTicket.source)}
                        </Text>
                      ) : null}
                    </div>
                    {selectedTicket ? (
                      <StatusBadge color={ticketStatusColor(selectedTicket.status)} label={translateTicketStatus(selectedTicket.status)} />
                    ) : null}
                  </div>

                  {detailError ? (
                    <Alert color="red" variant="light">
                      {detailError}
                    </Alert>
                  ) : null}

                  {detailLoading && selectedTicket?.id !== selectedTicketId ? (
                    <DataSkeleton variant="page" rows={4}/>
                  ) : !selectedTicket ? (
                    <Text c="dimmed">请选择左侧工单查看详情。</Text>
                  ) : (
                    <>
                      <div className="admin-ticket-summary">
                        <Paper withBorder radius="lg" p="md">
                          <Text size="xs" c="dimmed">标题</Text>
                          <Text fw={700}>{selectedTicket.title}</Text>
                        </Paper>
                        <Paper withBorder radius="lg" p="md">
                          <Text size="xs" c="dimmed">用户</Text>
                          <Text fw={700}>{selectedTicket.userDisplayName}</Text>
                          <Text size="sm" c="dimmed">{selectedTicket.userEmail}</Text>
                        </Paper>
                        <Paper withBorder radius="lg" p="md">
                          <Text size="xs" c="dimmed">归属</Text>
                          <Text fw={700}>{selectedTicket.teamName ?? "个人订阅"}</Text>
                          <Text size="sm" c="dimmed">{selectedTicket.ownerType === "team" ? "Team 订阅" : "个人订阅"}</Text>
                        </Paper>
                        <Paper withBorder radius="lg" p="md">
                          <Text size="xs" c="dimmed">最近更新时间</Text>
                          <Text fw={700}>{formatDateTimeWithYear(selectedTicket.updatedAt)}</Text>
                        </Paper>
                      </div>

                      <Stack gap="sm" className="admin-ticket-conversation">
                        <Group justify="space-between">
                          <Title order={5}>会话</Title>
                          <Text size="sm" c="dimmed">共 {orderedMessages.length} 条消息</Text>
                        </Group>
                        <div className="admin-ticket-message-list">
                          {orderedMessages.map((message) => {
                            const adminMessage = message.authorRole === "admin";
                            return (
                              <div
                                key={message.id}
                                className={adminMessage ? "admin-ticket-message-row admin-ticket-message-row--admin" : "admin-ticket-message-row"}
                              >
                                <Paper
                                  withBorder
                                  radius="lg"
                                  p="md"
                                  className={adminMessage ? "admin-ticket-message admin-ticket-message--admin" : "admin-ticket-message"}
                                >
                                  <Group justify="space-between" align="start" gap="md" wrap="nowrap">
                                    <Stack gap={2}>
                                      <Text fw={700}>{readMessageAuthorLabel(message.authorRole, message.authorDisplayName)}</Text>
                                      <Text size="xs" c="dimmed">
                                        {message.authorEmail ?? translateMessageRole(message.authorRole)}
                                      </Text>
                                    </Stack>
                                    <Text size="xs" c="dimmed" className="admin-ticket-message__time">
                                      {formatDateTimeWithYear(message.createdAt)}
                                    </Text>
                                  </Group>
                                  <Text mt="sm" style={{ whiteSpace: "pre-wrap" }}>
                                    {message.body}
                                  </Text>
                                  {(message.attachments ?? []).length > 0 ? (
                                    <Group mt="sm" gap="xs">
                                      {(message.attachments ?? []).map((attachment) => (
                                        <button
                                          key={attachment.id}
                                          type="button"
                                          className="admin-ticket-attachment-preview-button"
                                          onClick={() => setPreviewAttachment({ url: attachment.url, fileName: attachment.fileName })}
                                        >
                                          <TicketAttachmentThumbnail url={attachment.url} fileName={attachment.fileName} />
                                        </button>
                                      ))}
                                    </Group>
                                  ) : null}
                                </Paper>
                              </div>
                            );
                          })}
                        </div>
                      </Stack>

                    </>
                  )}
                </Stack>
              </Card>
            </div>
          )}
        </Stack>
      </SectionCard>
      <Modal
        opened={previewAttachment !== null}
        onClose={() => setPreviewAttachment(null)}
        title={previewAttachment?.fileName ?? "附件预览"}
        centered
        size="xl"
      >
        {previewAttachment ? <TicketAttachmentPreviewContent attachment={previewAttachment} /> : null}
      </Modal>
    </Stack>
  );
}

function TicketAttachmentThumbnail(props: { url: string; fileName: string }) {
  const [imageState, setImageState] = useState<TicketAttachmentImageState>("loading");

  useEffect(() => {
    setImageState("loading");
  }, [props.url]);

  return (
    <Paper withBorder radius="md" p={6} className="admin-ticket-attachment-card">
      <Stack gap={4}>
        <div className="admin-ticket-attachment-thumb-frame" aria-busy={imageState === "loading"}>
          {imageState !== "failed" ? (
            <img
              src={props.url}
              alt={props.fileName}
              onLoad={() => setImageState("loaded")}
              onError={() => setImageState("failed")}
            />
          ) : null}
          {imageState === "loading" ? (
            <div className="admin-ticket-attachment-image-state">
              <DataSkeleton variant="image"/>
            </div>
          ) : null}
          {imageState === "failed" ? (
            <div className="admin-ticket-attachment-image-state admin-ticket-attachment-image-state--failed">
              <Text size="xs" fw={600}>
                缩略图加载失败
              </Text>
              <Text size="xs" c="dimmed">
                点击查看原图
              </Text>
            </div>
          ) : null}
        </div>
        <Text size="xs" lineClamp={1}>
          {props.fileName}
        </Text>
      </Stack>
    </Paper>
  );
}

function TicketAttachmentPreviewContent(props: { attachment: TicketAttachmentPreview }) {
  const [imageState, setImageState] = useState<TicketAttachmentImageState>("loading");
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    setImageState("loading");
    setRetryToken(0);
  }, [props.attachment.url]);

  const previewUrl = retryToken === 0 ? props.attachment.url : appendImageRetryToken(props.attachment.url, retryToken);

  return (
    <Stack gap="sm">
      <div className="admin-ticket-attachment-preview-frame" aria-busy={imageState === "loading"}>
        {imageState !== "failed" ? (
          <img
            key={previewUrl}
            src={previewUrl}
            alt={props.attachment.fileName}
            onLoad={() => setImageState("loaded")}
            onError={() => setImageState("failed")}
          />
        ) : null}
        {imageState === "loading" ? (
          <div className="admin-ticket-attachment-preview-state">
            <DataSkeleton variant="image"/>
          </div>
        ) : null}
        {imageState === "failed" ? (
          <div className="admin-ticket-attachment-preview-state admin-ticket-attachment-preview-state--failed">
            <Text fw={600}>预览加载失败</Text>
            <Text size="sm" c="dimmed">
              可以重试，或在新窗口打开原图。
            </Text>
          </div>
        ) : null}
      </div>
      <Group justify="flex-end">
        {imageState === "failed" ? (
          <Button
            variant="light"
            onClick={() => {
              setImageState("loading");
              setRetryToken((current) => current + 1);
            }}
          >
            重试
          </Button>
        ) : null}
        <Button component="a" href={props.attachment.url} target="_blank" rel="noreferrer" variant="default">
          打开原图
        </Button>
      </Group>
    </Stack>
  );
}

function appendImageRetryToken(url: string, retryToken: number) {
  const hashIndex = url.indexOf("#");
  const baseUrl = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${separator}previewRetry=${retryToken}${hash}`;
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
