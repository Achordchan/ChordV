import { Alert, Badge, Button, Group, Loader, Modal, Paper, ScrollArea, Stack, Text, TextInput, Textarea } from "@mantine/core";
import type { ClientSupportTicketDetailDto, ClientSupportTicketSummaryDto } from "@chordv/shared";
import { IconMessageCirclePlus, IconRefresh, IconSend } from "@tabler/icons-react";

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

export function TicketCenterModal(props: TicketCenterModalProps) {
  const replyingDisabled =
    props.submitting || !props.ticketDetail || props.ticketDetail.status === "closed" || !props.replyBody.trim();
  const creatingDisabled = props.submitting || props.createTitle.trim().length < 2 || props.createBody.trim().length < 5;

  return (
    <Modal
      opened={props.opened}
      onClose={props.onClose}
      title="工单中心"
      size="92%"
      centered
      classNames={{
        body: "ticket-center__modal-body"
      }}
    >
      <Stack gap="md" className="ticket-center">
        <div className="ticket-center__topbar">
          <div className="ticket-center__headline">
            <Text fw={700}>联系邮箱：{props.email}</Text>
            <Text size="sm" c="dimmed">
              可以直接查看历史工单、补充信息，或新建新的问题单。
            </Text>
          </div>
          <Group gap="xs">
            <Button
              variant="default"
              leftSection={<IconRefresh size={15} />}
              onClick={props.onRefresh}
              loading={props.listBusy || props.detailBusy}
            >
              刷新列表
            </Button>
            {props.createMode ? (
              <Button variant="default" onClick={props.onCancelCreate}>
                返回详情
              </Button>
            ) : null}
            <Button leftSection={<IconMessageCirclePlus size={15} />} onClick={props.onOpenCreate}>
              新建工单
            </Button>
          </Group>
        </div>

        <div className="ticket-center__layout">
          <Paper withBorder radius="lg" p="sm" className="ticket-center__sidebar">
            <div className="ticket-center__sidebar-head">
              <Text fw={700}>工单列表</Text>
              <Badge variant="light" color="gray">
                {props.tickets.length} 条
              </Badge>
            </div>
            <ScrollArea className="ticket-center__sidebar-scroll" type="auto">
              <Stack gap="xs">
                {props.listBusy ? (
                  <div className="ticket-center__empty">
                    <Loader size="sm" />
                    <Text size="sm" c="dimmed">
                      正在加载工单列表…
                    </Text>
                  </div>
                ) : props.tickets.length > 0 ? (
                  props.tickets.map((ticket) => {
                    const active = ticket.id === props.selectedTicketId && !props.createMode;
                    return (
                      <button
                        key={ticket.id}
                        type="button"
                        className={active ? "ticket-center__ticket ticket-center__ticket--active" : "ticket-center__ticket"}
                        onClick={() => props.onSelectTicket(ticket.id)}
                      >
                        <div className="ticket-center__ticket-head">
                          <Text fw={600} lineClamp={1}>
                            {ticket.title}
                          </Text>
                          <Badge size="sm" color={statusColor(ticket.status)} variant="light">
                            {statusLabel(ticket.status)}
                          </Badge>
                        </div>
                        <Text size="sm" c="dimmed" lineClamp={2}>
                          {ticket.lastMessagePreview || "暂无最新消息"}
                        </Text>
                        <Text size="xs" c="dimmed">
                          最后更新：{formatDateTime(ticket.lastMessageAt)}
                        </Text>
                      </button>
                    );
                  })
                ) : (
                  <div className="ticket-center__empty">
                    <Text fw={600}>还没有工单</Text>
                    <Text size="sm" c="dimmed">
                      你可以直接点击右上角“新建工单”发起问题。
                    </Text>
                  </div>
                )}
              </Stack>
            </ScrollArea>
          </Paper>

          <Paper withBorder radius="lg" p="lg" className="ticket-center__detail">
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
                  value={props.createTitle}
                  onChange={(event) => props.onCreateTitleChange(event.currentTarget.value)}
                  maxLength={120}
                />
                <Textarea
                  label="问题描述"
                  placeholder="请把你做了什么、看到什么提示、希望怎么解决写清楚。"
                  minRows={10}
                  autosize
                  value={props.createBody}
                  onChange={(event) => props.onCreateBodyChange(event.currentTarget.value)}
                />
                <Group justify="flex-end">
                  <Button variant="default" onClick={props.onCancelCreate}>
                    取消
                  </Button>
                  <Button onClick={props.onSubmitCreate} loading={props.submitting} disabled={creatingDisabled}>
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
                    <Group gap="xs" mt={6}>
                      <Badge color={statusColor(props.ticketDetail.status)} variant="light">
                        {statusLabel(props.ticketDetail.status)}
                      </Badge>
                      <Text size="sm" c="dimmed">
                        创建于 {formatDateTime(props.ticketDetail.createdAt)}
                      </Text>
                    </Group>
                  </div>
                </div>

                <ScrollArea className="ticket-center__messages" type="auto">
                  <Stack gap="sm">
                    {props.ticketDetail.messages.map((message) => (
                      <div
                        key={message.id}
                        className={
                          message.authorRole === "user"
                            ? "ticket-center__message ticket-center__message--user"
                            : "ticket-center__message ticket-center__message--admin"
                        }
                      >
                        <div className="ticket-center__message-meta">
                          <Text fw={600}>{message.authorDisplayName ?? authorLabel(message.authorRole)}</Text>
                          <Text size="xs" c="dimmed">
                            {formatDateTime(message.createdAt)}
                          </Text>
                        </div>
                        <Text size="sm" className="ticket-center__message-body">
                          {message.body}
                        </Text>
                      </div>
                    ))}
                  </Stack>
                </ScrollArea>

                <Stack gap="sm">
                  {props.ticketDetail.status === "closed" ? (
                    <Alert color="gray" variant="light">
                      当前工单已经关闭，如需继续处理，请新建一条工单说明新情况。
                    </Alert>
                  ) : null}
                  <Textarea
                    label="继续补充"
                    placeholder={props.ticketDetail.status === "closed" ? "当前工单已关闭" : "继续描述新的现象或补充截图说明。"}
                    minRows={5}
                    autosize
                    disabled={props.ticketDetail.status === "closed"}
                    value={props.replyBody}
                    onChange={(event) => props.onReplyBodyChange(event.currentTarget.value)}
                  />
                  <Group justify="flex-end">
                    <Button
                      leftSection={<IconSend size={15} />}
                      onClick={props.onSubmitReply}
                      loading={props.submitting}
                      disabled={replyingDisabled}
                    >
                      发送回复
                    </Button>
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

function formatDateTime(value: string) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  return `${year}/${month}/${day} ${hour}:${minute}`;
}
