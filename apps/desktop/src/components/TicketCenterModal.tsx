import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Group, Loader, Modal, Paper, SegmentedControl, Stack, Text, TextInput, Textarea } from "@mantine/core";
import type { ClientSupportTicketDetailDto, ClientSupportTicketSummaryDto } from "@chordv/shared";
import { IconMessageCirclePlus, IconPaperclip, IconRefresh, IconSearch, IconSend } from "@tabler/icons-react";
import { isSupportTicketUnread } from "../lib/supportTickets";

type TicketCenterModalProps = {
  opened: boolean;
  email: string;
  tickets: ClientSupportTicketSummaryDto[];
  selectedTicketId: string | null;
  ticketDetail: ClientSupportTicketDetailDto | null;
  listBusy: boolean;
  detailBusy: boolean;
  submitting: boolean;
  createMode: boolean;
  error: string | null;
  createTitle: string;
  createBody: string;
  replyBody: string;
  onClose: () => void;
  onRefresh: () => void;
  onOpenCreate: () => void;
  onCancelCreate: () => void;
  onSelectTicket: (ticketId: string) => void;
  onCreateTitleChange: (value: string) => void;
  onCreateBodyChange: (value: string) => void;
  onReplyBodyChange: (value: string) => void;
  onSubmitCreate: () => void;
  onSubmitReply: () => void;
};

type TicketStatusFilter = "all" | "waiting_user" | "replied" | "closed";

export function TicketCenterModal(props: TicketCenterModalProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<TicketStatusFilter>("all");
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const replyingDisabled =
    props.submitting || !props.ticketDetail || props.ticketDetail.status === "closed" || !props.replyBody.trim();
  const creatingDisabled = props.submitting || props.createTitle.trim().length < 2 || props.createBody.trim().length < 5;
  const filteredTickets = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return props.tickets.filter((ticket) => {
      const matchStatus =
        statusFilter === "all" ||
        (statusFilter === "waiting_user" && ticket.status === "waiting_user") ||
        (statusFilter === "replied" && (ticket.status === "open" || ticket.status === "waiting_admin")) ||
        (statusFilter === "closed" && ticket.status === "closed");
      if (!matchStatus) {
        return false;
      }
      if (!keyword) {
        return true;
      }
      return [ticket.title, ticket.lastMessagePreview ?? "", statusLabel(ticket.status), formatDateTime(ticket.lastMessageAt)]
        .join(" ")
        .toLowerCase()
        .includes(keyword);
    });
  }, [props.tickets, search, statusFilter]);
  const orderedMessages = useMemo(() => {
    if (!props.ticketDetail) {
      return [];
    }
    return [...props.ticketDetail.messages].sort(
      (previous, next) => new Date(previous.createdAt).getTime() - new Date(next.createdAt).getTime()
    );
  }, [props.ticketDetail]);
  const latestMessageId = orderedMessages[orderedMessages.length - 1]?.id ?? null;

  useEffect(() => {
    if (!props.opened || props.createMode || !props.ticketDetail) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ block: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [props.opened, props.createMode, props.ticketDetail, latestMessageId]);

  return (
    <Modal
      opened={props.opened}
      onClose={props.onClose}
      title="工单中心"
      size="94%"
      centered
      classNames={{
        content: "ticket-center__modal-content",
        header: "ticket-center__modal-header",
        body: "ticket-center__modal-body"
      }}
    >
      <Stack gap="xs" className="ticket-center">
        <div className="ticket-center__topbar">
          <div className="ticket-center__headline">
            <Text fw={700} size="sm">
              联系邮箱：{props.email}
            </Text>
            <Text size="xs" c="dimmed">
              您可以在这里查看与客服的沟通记录并继续补充信息。
            </Text>
          </div>
          <Group gap="xs">
            <Button
              size="xs"
              variant="default"
              leftSection={<IconRefresh size={15} />}
              className="ticket-center__toolbar-button"
              onClick={props.onRefresh}
              loading={props.listBusy || props.detailBusy}
            >
              刷新列表
            </Button>
            {props.createMode ? (
              <Button size="xs" variant="default" className="ticket-center__toolbar-button" onClick={props.onCancelCreate}>
                返回详情
              </Button>
            ) : null}
            <Button
              size="xs"
              leftSection={<IconMessageCirclePlus size={15} />}
              className="ticket-center__toolbar-button"
              onClick={props.onOpenCreate}
            >
              新建工单
            </Button>
          </Group>
        </div>

        <div className="ticket-center__layout">
          <Paper withBorder radius="md" p="sm" className="ticket-center__sidebar">
            <div className="ticket-center__sidebar-head">
              <Text fw={700}>工单列表</Text>
              <Badge variant="light" color="gray">
                {filteredTickets.length}/{props.tickets.length}
              </Badge>
            </div>
            <TextInput
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              placeholder="搜索工单标题或内容"
              size="xs"
              leftSection={<IconSearch size={15} />}
              className="ticket-center__search"
            />
            <SegmentedControl
              value={statusFilter}
              onChange={(value) => setStatusFilter(value as TicketStatusFilter)}
              size="xs"
              fullWidth
              className="ticket-center__status-filter"
              data={[
                { value: "all", label: "全部" },
                { value: "waiting_user", label: "等待补充" },
                { value: "replied", label: "已回复" },
                { value: "closed", label: "已关闭" }
              ]}
            />
            <div className="ticket-center__sidebar-scroll">
              <Stack gap="xs">
                {props.listBusy ? (
                  <div className="ticket-center__empty">
                    <Loader size="sm" />
                    <Text size="sm" c="dimmed">
                      正在加载工单列表…
                    </Text>
                  </div>
                ) : filteredTickets.length > 0 ? (
                  filteredTickets.map((ticket) => {
                    const active = ticket.id === props.selectedTicketId && !props.createMode;
                    return (
                      <button
                        key={ticket.id}
                        type="button"
                        className={active ? "ticket-center__ticket ticket-center__ticket--active" : "ticket-center__ticket"}
                        onClick={() => props.onSelectTicket(ticket.id)}
                      >
                        <div className="ticket-center__ticket-head">
                          <Text fw={700} lineClamp={1}>
                            {ticket.title}
                          </Text>
                          <Badge size="sm" color={statusColor(ticket.status)} variant="light">
                            {statusLabel(ticket.status)}
                          </Badge>
                        </div>
                        <Text size="sm" c="dimmed" lineClamp={2}>
                          {ticket.lastMessagePreview || "暂无最新消息"}
                        </Text>
                        <div className="ticket-center__ticket-foot">
                          <Text size="xs" c="dimmed">
                            最后更新：{formatDateTime(ticket.lastMessageAt)}
                          </Text>
                          {isSupportTicketUnread(ticket) ? <span className="ticket-center__unread-dot" /> : null}
                        </div>
                      </button>
                    );
                  })
                ) : (
                  <div className="ticket-center__empty">
                    <Text fw={600}>{props.tickets.length > 0 ? "没有匹配的工单" : "还没有工单"}</Text>
                    <Text size="sm" c="dimmed">
                      {props.tickets.length > 0 ? "可以调整搜索内容或状态筛选。" : "你可以直接点击右上角“新建工单”发起问题。"}
                    </Text>
                  </div>
                )}
              </Stack>
            </div>
          </Paper>

          <Paper withBorder radius="md" p="md" className="ticket-center__detail">
            {props.error ? (
              <Alert color="red" variant="light">
                {props.error}
              </Alert>
            ) : null}

            {props.createMode ? (
              <Stack gap="md" className="ticket-center__composer">
                <div>
                  <Text fw={700}>新建工单</Text>
                  <Text size="sm" c="dimmed">
                    标题尽量直接说明问题，正文里把出错步骤、时间和现象写清楚。
                  </Text>
                </div>
                <TextInput
                  label="工单标题"
                  placeholder="例如：Windows 连接后无法打开网页"
                  size="sm"
                  className="ticket-center__field"
                  value={props.createTitle}
                  onChange={(event) => props.onCreateTitleChange(event.currentTarget.value)}
                  maxLength={120}
                />
                <Textarea
                  label="问题描述"
                  placeholder="请把你做了什么、看到什么提示、希望怎么解决写清楚。"
                  size="sm"
                  className="ticket-center__field"
                  minRows={10}
                  autosize
                  value={props.createBody}
                  onChange={(event) => props.onCreateBodyChange(event.currentTarget.value)}
                />
                <Group justify="flex-end">
                  <Button size="sm" variant="default" className="ticket-center__action-button" onClick={props.onCancelCreate}>
                    取消
                  </Button>
                  <Button
                    size="sm"
                    className="ticket-center__action-button"
                    onClick={props.onSubmitCreate}
                    loading={props.submitting}
                    disabled={creatingDisabled}
                  >
                    提交工单
                  </Button>
                </Group>
              </Stack>
            ) : props.detailBusy ? (
              <div className="ticket-center__empty ticket-center__empty--detail">
                <Loader size="sm" />
                <Text size="sm" c="dimmed">
                  正在加载工单详情…
                </Text>
              </div>
            ) : props.ticketDetail ? (
              <Stack gap="md" className="ticket-center__detail-shell">
                <div className="ticket-center__detail-head">
                  <div>
                    <Text fw={700} size="lg">
                      {props.ticketDetail.title}
                    </Text>
                    <Group gap="xs" mt={4} wrap="nowrap" className="ticket-center__detail-meta">
                      <Badge size="sm" color={statusColor(props.ticketDetail.status)} variant="light">
                        {statusLabel(props.ticketDetail.status)}
                      </Badge>
                      <Text size="xs" c="dimmed">
                        创建时间：{formatDateTime(props.ticketDetail.createdAt)}
                      </Text>
                      <Text size="xs" c="dimmed">
                        工单编号：{ticketCode(props.ticketDetail)}
                      </Text>
                    </Group>
                  </div>
                </div>

                <div className="ticket-center__messages">
                  <Stack gap="sm" className="ticket-center__messages-stack">
                    {orderedMessages.map((message) => (
                      <div
                        key={message.id}
                        className={
                          message.authorRole === "user"
                            ? "ticket-center__message-row ticket-center__message-row--user"
                            : "ticket-center__message-row ticket-center__message-row--admin"
                        }
                      >
                        <div
                          className={
                            message.authorRole === "user"
                              ? "ticket-center__message ticket-center__message--user"
                              : "ticket-center__message ticket-center__message--admin"
                          }
                        >
                          <div className="ticket-center__message-meta">
                            <Text fw={700}>{message.authorDisplayName ?? authorLabel(message.authorRole)}</Text>
                            <Text size="xs" c="dimmed">
                              {formatDateTime(message.createdAt)}
                            </Text>
                          </div>
                          <Text size="sm" className="ticket-center__message-body">
                            {message.body}
                          </Text>
                        </div>
                      </div>
                    ))}
                    <div ref={messagesEndRef} className="ticket-center__messages-end" />
                  </Stack>
                </div>

                <Stack gap="sm" className="ticket-center__reply-panel">
                  {props.ticketDetail.status === "closed" ? (
                    <Alert color="gray" variant="light">
                      当前工单已经关闭，如需继续处理，请新建一条工单说明新情况。
                    </Alert>
                  ) : null}
                  <Textarea
                    label="继续补充"
                    placeholder={props.ticketDetail.status === "closed" ? "当前工单已关闭" : "继续描述新的现象或补充截图说明。"}
                    size="sm"
                    className="ticket-center__field"
                    minRows={3}
                    disabled={props.ticketDetail.status === "closed"}
                    value={props.replyBody}
                    onChange={(event) => props.onReplyBodyChange(event.currentTarget.value)}
                  />
                  <Group justify="space-between" align="center">
                    <Text size="xs" c="dimmed">
                      {props.replyBody.length} 字
                    </Text>
                    <Group gap="xs">
                      <Button size="sm" variant="default" leftSection={<IconPaperclip size={15} />} className="ticket-center__action-button" disabled>
                        添加附件
                      </Button>
                      <Button
                        size="sm"
                        leftSection={<IconSend size={15} />}
                        className="ticket-center__action-button"
                        onClick={props.onSubmitReply}
                        loading={props.submitting}
                        disabled={replyingDisabled}
                      >
                        发送回复
                      </Button>
                    </Group>
                  </Group>
                </Stack>
              </Stack>
            ) : (
              <div className="ticket-center__empty ticket-center__empty--detail">
                <Text fw={600}>请选择一条工单</Text>
                <Text size="sm" c="dimmed">
                  左侧可以查看历史工单，也可以直接新建新的问题单。
                </Text>
              </div>
            )}
          </Paper>
        </div>
      </Stack>
    </Modal>
  );
}

function statusLabel(status: ClientSupportTicketSummaryDto["status"]) {
  switch (status) {
    case "waiting_admin":
      return "等待处理";
    case "waiting_user":
      return "等待补充";
    case "closed":
      return "已关闭";
    default:
      return "处理中";
  }
}

function statusColor(status: ClientSupportTicketSummaryDto["status"]) {
  switch (status) {
    case "waiting_admin":
      return "blue";
    case "waiting_user":
      return "yellow";
    case "closed":
      return "gray";
    default:
      return "green";
  }
}

function authorLabel(role: ClientSupportTicketDetailDto["messages"][number]["authorRole"]) {
  switch (role) {
    case "admin":
      return "客服";
    case "system":
      return "系统";
    default:
      return "我";
  }
}

function ticketCode(ticket: ClientSupportTicketSummaryDto) {
  const shortId = ticket.id.replace(/[^a-zA-Z0-9]/g, "").slice(-4).toUpperCase();
  return `TK${formatCompactDateTime(ticket.createdAt)}${shortId}`;
}

function formatCompactDateTime(value: string) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  return `${year}${month}${day}${hour}${minute}`;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  return `${year}/${month}/${day} ${hour}:${minute}`;
}
