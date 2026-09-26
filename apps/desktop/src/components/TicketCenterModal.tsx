import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  CloseButton,
  FileButton,
  Loader,
  Modal,
  SegmentedControl,
  Text,
  TextInput,
  Textarea,
  Tooltip
} from "@mantine/core";
import type { ClientSupportTicketDetailDto, ClientSupportTicketSummaryDto } from "@chordv/shared";
import {
  IconAlertCircle,
  IconArrowLeft,
  IconFileText,
  IconLock,
  IconMessageCircle,
  IconPaperclip,
  IconPhoto,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSend2,
  IconX
} from "@tabler/icons-react";
import type { TicketAttachmentUploadState } from "../hooks/useSupportTickets";
import { openExternalUrl } from "../lib/runtime";
import { isSupportTicketUnread } from "../lib/supportTickets";
import styles from "./TicketCenterModal.module.css";

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
  replyAttachment: File | null;
  replyAttachmentUpload: TicketAttachmentUploadState;
  onClose: () => void;
  onRefresh: () => void;
  onOpenCreate: () => void;
  onCancelCreate: () => void;
  onSelectTicket: (ticketId: string) => void;
  onCreateTitleChange: (value: string) => void;
  onCreateBodyChange: (value: string) => void;
  onReplyBodyChange: (value: string) => void;
  onReplyAttachmentChange: (value: File | null) => void;
  onSubmitCreate: () => void;
  onSubmitReply: () => void;
};

type TicketStatusFilter = "all" | "waiting_user" | "replied" | "closed";
type TicketMessage = ClientSupportTicketDetailDto["messages"][number];
type TicketAttachmentPreview = TicketMessage["attachments"][number];
// Below the narrow breakpoint only one pane is shown at a time; this picks which.
type PaneView = "list" | "thread";

const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
const GROUP_WINDOW_MS = 5 * 60 * 1000;
// Touch keyboards expect Enter to insert a line break, so only hardware keyboards send on Enter.
const enterSends = typeof window === "undefined" || !window.matchMedia?.("(pointer: coarse)").matches;

export function TicketCenterModal(props: TicketCenterModalProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<TicketStatusFilter>("all");
  const [paneView, setPaneView] = useState<PaneView>("list");
  const [previewAttachment, setPreviewAttachment] = useState<TicketAttachmentPreview | null>(null);
  const [previewOpenError, setPreviewOpenError] = useState<string | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  // Mirrors the ref as state so effects re-run once the modal transition actually mounts the thread.
  const [messagesElement, setMessagesElement] = useState<HTMLDivElement | null>(null);
  const attachMessagesScroll = useCallback((node: HTMLDivElement | null) => {
    messagesScrollRef.current = node;
    setMessagesElement(node);
  }, []);
  const createTitleRef = useRef<HTMLInputElement | null>(null);
  const detail = props.ticketDetail;
  const ticketClosed = detail?.status === "closed";
  const replyingDisabled =
    props.submitting ||
    props.replyAttachmentUpload.phase === "uploading" ||
    (Boolean(props.replyAttachment) && props.replyAttachmentUpload.phase !== "uploaded") ||
    !props.ticketDetail ||
    props.ticketDetail.status === "closed" ||
    (!props.replyBody.trim() && !props.replyAttachment);
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
  // A detail left over from the previously selected ticket is never shown under the new selection.
  const threadReady = Boolean(detail) && (!props.selectedTicketId || detail?.id === props.selectedTicketId);
  const threadVisible = props.opened && !props.createMode && threadReady;

  useEffect(() => {
    if (!threadVisible) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const scrollContainer = messagesScrollRef.current;
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [props.opened, props.createMode, props.ticketDetail?.id, latestMessageId, threadVisible, paneView, messagesElement]);

  // When the composer grows (multi-line text, attachment chip) keep the bottom of the thread in view.
  useEffect(() => {
    const scrollContainer = messagesElement;
    if (!scrollContainer || typeof ResizeObserver === "undefined") {
      return;
    }
    let lastHeight = scrollContainer.clientHeight;
    const observer = new ResizeObserver(() => {
      const shrunkBy = lastHeight - scrollContainer.clientHeight;
      lastHeight = scrollContainer.clientHeight;
      if (shrunkBy > 0) {
        scrollContainer.scrollTop += shrunkBy;
      }
    });
    observer.observe(scrollContainer);
    return () => observer.disconnect();
  }, [messagesElement]);

  useEffect(() => {
    if (!props.opened) {
      setPreviewAttachment(null);
      setPreviewOpenError(null);
      return;
    }
    setPaneView(props.createMode ? "thread" : "list");
  }, [props.opened]);

  useEffect(() => {
    if (!props.createMode) {
      return;
    }
    setPaneView("thread");
    const frame = window.requestAnimationFrame(() => createTitleRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [props.createMode]);

  const selectTicket = (ticketId: string) => {
    setPaneView("thread");
    props.onSelectTicket(ticketId);
  };

  const cancelCreate = () => {
    setPaneView("list");
    props.onCancelCreate();
  };

  const handleReplyKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!enterSends || event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }
    event.preventDefault();
    if (!replyingDisabled) {
      props.onSubmitReply();
    }
  };

  const handleCreateKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!creatingDisabled) {
        props.onSubmitCreate();
      }
    }
  };

  const openAttachment = (attachment: TicketAttachmentPreview) => {
    if (isImageAttachment(attachment)) {
      setPreviewAttachment(attachment);
      setPreviewOpenError(null);
      return;
    }
    void openExternalUrl(attachment.url).catch(() => undefined);
  };

  const handleOpenPreviewOriginal = async () => {
    if (!previewAttachment) {
      return;
    }
    try {
      await openExternalUrl(previewAttachment.url);
      setPreviewOpenError(null);
    } catch (error) {
      setPreviewOpenError(error instanceof Error ? error.message : String(error));
    }
  };

  const hasFilter = search.trim().length > 0 || statusFilter !== "all";
  const refreshing = props.listBusy || props.detailBusy;

  const paneActions = (
    <div className={styles.paneActions}>
      <Tooltip label="刷新" withArrow openDelay={300}>
        <ActionIcon variant="subtle" color="gray" size={30} aria-label="刷新工单" loading={refreshing} onClick={props.onRefresh}>
          <IconRefresh size={17} />
        </ActionIcon>
      </Tooltip>
      <CloseButton size="md" aria-label="关闭工单窗口" onClick={props.onClose} />
    </div>
  );

  const renderPane = () => {
    if (props.createMode) {
      return (
        <section className={styles.pane} aria-labelledby="ticket-create-heading">
          <header className={styles.threadHead}>
            <BackButton onClick={cancelCreate} />
            <h2 id="ticket-create-heading" className={styles.threadTitle}>新建工单</h2>
            {paneActions}
          </header>
          <ErrorBar message={props.error} />
          <div className={styles.createBody}>
            <Text size="xs" c="dimmed">
              写清楚遇到的问题、出现的时间和提示信息，客服会在这里回复你。
            </Text>
            <TextInput
              ref={createTitleRef}
              label="标题"
              placeholder="例如：Windows 连接后无法打开网页"
              size="sm"
              maxLength={120}
              value={props.createTitle}
              onChange={(event) => props.onCreateTitleChange(event.currentTarget.value)}
            />
            <Textarea
              label="问题描述"
              placeholder="你做了什么、看到了什么提示、希望怎么解决。"
              size="sm"
              classNames={{ root: styles.createField, wrapper: styles.createFieldWrapper, input: styles.createFieldInput }}
              value={props.createBody}
              onChange={(event) => props.onCreateBodyChange(event.currentTarget.value)}
              onKeyDown={handleCreateKeyDown}
            />
          </div>
          <footer className={styles.createFoot}>
            <Text size="xs" c="dimmed" className={styles.createHint}>
              {creatingDisabled && !props.submitting ? "标题至少 2 个字，描述至少 5 个字" : "Ctrl/⌘ + Enter 提交"}
            </Text>
            <Button size="xs" variant="default" onClick={cancelCreate}>
              取消
            </Button>
            <Button size="xs" onClick={props.onSubmitCreate} loading={props.submitting} disabled={creatingDisabled}>
              提交工单
            </Button>
          </footer>
        </section>
      );
    }

    if (detail && threadReady) {
      return (
        <section className={styles.pane} aria-labelledby="ticket-thread-heading">
          <header className={styles.threadHead}>
            <BackButton onClick={() => setPaneView("list")} />
            <div className={styles.threadHeading}>
              <h2 id="ticket-thread-heading" className={styles.threadTitle} title={detail.title}>
                {detail.title}
              </h2>
              <StatusBadge status={detail.status} />
            </div>
            {props.detailBusy ? <Loader size={14} aria-label="正在更新对话" /> : null}
            {paneActions}
          </header>
          <ErrorBar message={props.error} />
          <div
            ref={attachMessagesScroll}
            className={styles.messages}
            role="log"
            aria-live="polite"
            aria-label="对话记录"
            tabIndex={0}
          >
            <div className={styles.messagesStack}>
              <p className={styles.threadIntro}>
                工单编号 {ticketCode(detail)} · 创建于 {formatDateTime(detail.createdAt)}
              </p>
              {orderedMessages.length === 0 ? (
                <Text size="xs" c="dimmed" ta="center">暂时还没有消息</Text>
              ) : (
                orderedMessages.map((message, index) => {
                  const previous = orderedMessages[index - 1];
                  const newDay = !previous || dayKey(previous.createdAt) !== dayKey(message.createdAt);
                  const grouped = !newDay && previous !== undefined && isSameSpeakerBurst(previous, message);
                  return (
                    <MessageItem
                      key={message.id}
                      message={message}
                      dayLabel={newDay ? formatDayLabel(message.createdAt) : null}
                      grouped={grouped}
                      onOpenAttachment={openAttachment}
                    />
                  );
                })
              )}
            </div>
          </div>
          {ticketClosed ? (
            <div className={styles.closedBar}>
              <IconLock size={15} aria-hidden="true" />
              <Text size="xs" className={styles.closedText}>
                此工单已关闭。如果问题仍未解决，请新建一条工单。
              </Text>
              <Button size="compact-xs" variant="light" onClick={props.onOpenCreate}>
                新建工单
              </Button>
            </div>
          ) : (
            <div className={styles.composer}>
              {props.replyAttachment ? (
                <PendingAttachment
                  file={props.replyAttachment}
                  upload={props.replyAttachmentUpload}
                  onRemove={() => props.onReplyAttachmentChange(null)}
                />
              ) : null}
              <div className={styles.composerBox}>
                <FileButton onChange={props.onReplyAttachmentChange} accept={IMAGE_ACCEPT}>
                  {(fileButtonProps) => (
                    <Tooltip label="添加图片" withArrow openDelay={300}>
                      <ActionIcon
                        {...fileButtonProps}
                        variant="subtle"
                        color="gray"
                        size={32}
                        aria-label="添加图片附件"
                        disabled={props.submitting || props.replyAttachmentUpload.phase === "uploading"}
                      >
                        <IconPaperclip size={18} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                </FileButton>
                <Textarea
                  data-autofocus
                  aria-label="回复内容"
                  placeholder={enterSends ? "输入回复，Enter 发送，Shift + Enter 换行" : "输入回复内容"}
                  variant="unstyled"
                  autosize
                  minRows={1}
                  maxRows={6}
                  className={styles.composerInputRoot}
                  classNames={{ input: styles.composerInput }}
                  value={props.replyBody}
                  onChange={(event) => props.onReplyBodyChange(event.currentTarget.value)}
                  onKeyDown={handleReplyKeyDown}
                />
                <Button
                  size="xs"
                  className={styles.sendButton}
                  leftSection={<IconSend2 size={15} />}
                  onClick={props.onSubmitReply}
                  loading={props.submitting}
                  disabled={replyingDisabled}
                >
                  发送
                </Button>
              </div>
            </div>
          )}
        </section>
      );
    }

    let body: ReactNode;
    let tone: "error" | undefined;
    if (props.detailBusy || props.listBusy) {
      body = (
        <>
          <Loader size="sm" />
          <Text size="sm" c="dimmed">{props.detailBusy ? "正在打开对话…" : "正在加载工单…"}</Text>
        </>
      );
    } else if (props.error) {
      tone = "error";
      body = (
        <>
          <Text fw={600}>{props.tickets.length === 0 ? "工单暂时加载不出来" : "这条工单暂时打不开"}</Text>
          <Text size="sm" c="dimmed">{props.error}</Text>
          <Button size="xs" variant="default" mt={4} leftSection={<IconRefresh size={14} />} onClick={props.onRefresh}>
            重试
          </Button>
        </>
      );
    } else if (props.tickets.length === 0) {
      body = (
        <>
          <Text fw={600}>还没有工单</Text>
          <Text size="sm" c="dimmed">遇到连接、账号或订阅问题时，可以在这里直接联系客服。</Text>
          <Button size="xs" mt={4} leftSection={<IconPlus size={14} />} onClick={props.onOpenCreate}>
            新建工单
          </Button>
        </>
      );
    } else {
      body = (
        <>
          <Text fw={600}>选择一条工单</Text>
          <Text size="sm" c="dimmed">打开左侧的工单，就能看到和客服的对话。</Text>
        </>
      );
    }
    const busy = props.detailBusy || props.listBusy;
    return (
      <section className={styles.pane} aria-label="工单对话">
        <header className={styles.threadHead}>
          <BackButton onClick={() => setPaneView("list")} />
          {paneActions}
        </header>
        <div className={styles.empty} aria-live="polite">
          {busy ? null : (
            <span className={styles.emptyIcon} data-tone={tone} aria-hidden="true">
              {tone === "error" ? <IconAlertCircle size={22} /> : <IconMessageCircle size={22} />}
            </span>
          )}
          {body}
        </div>
      </section>
    );
  };

  return (
    <>
      <Modal.Root
        opened={props.opened}
        onClose={props.onClose}
        size="min(calc(100vw - 24px), 1040px)"
        centered
        classNames={{ inner: styles.inner, content: styles.content, body: styles.body, title: styles.title }}
      >
        <Modal.Overlay />
        <Modal.Content>
          <Modal.Body>
            <div className={styles.layout} data-view={paneView}>
              <nav className={styles.rail} aria-label="工单列表">
                <div className={styles.railHead}>
                  <Modal.Title>我的工单</Modal.Title>
                  <Button size="compact-sm" leftSection={<IconPlus size={14} />} onClick={props.onOpenCreate} disabled={props.createMode}>
                    新建工单
                  </Button>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size={30}
                    className={styles.railNarrowOnly}
                    aria-label="刷新工单"
                    loading={refreshing}
                    onClick={props.onRefresh}
                  >
                    <IconRefresh size={17} />
                  </ActionIcon>
                  <CloseButton size="md" className={styles.railNarrowOnly} aria-label="关闭工单窗口" onClick={props.onClose} />
                </div>
                <div className={styles.railTools}>
                  <TextInput
                    value={search}
                    onChange={(event) => setSearch(event.currentTarget.value)}
                    placeholder="搜索工单"
                    aria-label="搜索工单"
                    size="xs"
                    leftSection={<IconSearch size={14} />}
                    rightSection={search ? <CloseButton size="xs" aria-label="清除搜索" onClick={() => setSearch("")} /> : null}
                  />
                  <SegmentedControl
                    value={statusFilter}
                    onChange={(value) => setStatusFilter(value as TicketStatusFilter)}
                    size="xs"
                    fullWidth
                    aria-label="按状态筛选"
                    classNames={{ root: styles.filter, label: styles.filterLabel }}
                    data={[
                      { value: "all", label: "全部" },
                      { value: "waiting_user", label: "待补充" },
                      { value: "replied", label: "处理中" },
                      { value: "closed", label: "已关闭" }
                    ]}
                  />
                </div>
                <div className={styles.railScroll}>
                  {props.listBusy && props.tickets.length === 0 ? (
                    <div className={styles.railEmpty}>
                      <Loader size="xs" />
                      <Text size="xs" c="dimmed">正在加载…</Text>
                    </div>
                  ) : filteredTickets.length > 0 ? (
                    <ul className={styles.ticketList}>
                      {filteredTickets.map((ticket) => {
                        const active = ticket.id === props.selectedTicketId && !props.createMode;
                        const unread = isSupportTicketUnread(ticket);
                        return (
                          <li key={ticket.id}>
                            <button
                              type="button"
                              className={styles.ticket}
                              data-active={active || undefined}
                              data-unread={unread || undefined}
                              aria-current={active ? "true" : undefined}
                              onClick={() => selectTicket(ticket.id)}
                            >
                              <span className={styles.ticketRow}>
                                <span className={styles.ticketTitle}>{ticket.title}</span>
                                <time className={styles.ticketTime} dateTime={ticket.lastMessageAt}>
                                  {formatListTime(ticket.lastMessageAt)}
                                </time>
                              </span>
                              <span className={styles.ticketRow}>
                                <span className={styles.ticketStatus} data-status={ticket.status}>
                                  {statusLabel(ticket.status)}
                                </span>
                                <span className={styles.ticketPreview}>{ticket.lastMessagePreview || "暂无消息"}</span>
                                {unread ? <span className={styles.unreadDot} aria-label="有新回复" /> : null}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : props.error && props.tickets.length === 0 ? (
                    <div className={styles.railEmpty} role="alert">
                      <Text size="xs" fw={600}>工单暂时加载不出来</Text>
                      <Text size="xs" c="dimmed">{props.error}</Text>
                      <Button size="compact-xs" variant="default" leftSection={<IconRefresh size={12} />} onClick={props.onRefresh}>
                        重试
                      </Button>
                    </div>
                  ) : (
                    <div className={styles.railEmpty}>
                      <Text size="xs" c="dimmed">{props.tickets.length > 0 ? "没有符合条件的工单" : "暂无工单"}</Text>
                      {hasFilter && props.tickets.length > 0 ? (
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          onClick={() => {
                            setSearch("");
                            setStatusFilter("all");
                          }}
                        >
                          清除筛选
                        </Button>
                      ) : null}
                    </div>
                  )}
                </div>
                {props.email ? (
                  <div className={styles.railFoot} title={props.email}>
                    联系邮箱 {props.email}
                  </div>
                ) : null}
              </nav>
              {renderPane()}
            </div>
          </Modal.Body>
        </Modal.Content>
      </Modal.Root>
      <Modal
        opened={previewAttachment !== null}
        onClose={() => {
          setPreviewAttachment(null);
          setPreviewOpenError(null);
        }}
        title={previewAttachment?.fileName ?? "附件预览"}
        size="min(92vw, 980px)"
        centered
        closeButtonProps={{ "aria-label": "关闭预览" }}
        classNames={{ title: styles.previewTitle, header: styles.previewHeader, body: styles.previewBody }}
      >
        {previewAttachment ? (
          <>
            {previewOpenError ? (
              <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />} className={styles.previewError}>
                <Text size="sm">无法打开原图，请稍后再试。</Text>
                <details className={styles.errorDetails}>
                  <summary>详细信息</summary>
                  <code>{previewOpenError}</code>
                </details>
              </Alert>
            ) : null}
            <div className={styles.previewFrame}>
              <img src={previewAttachment.url} alt={previewAttachment.fileName} />
            </div>
            <div className={styles.previewFoot}>
              <Button variant="default" size="xs" onClick={() => void handleOpenPreviewOriginal()}>
                打开原图
              </Button>
              <Button size="xs" onClick={() => setPreviewAttachment(null)}>
                关闭
              </Button>
            </div>
          </>
        ) : null}
      </Modal>
    </>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <ActionIcon variant="subtle" color="gray" size={28} className={styles.back} aria-label="返回工单列表" onClick={onClick}>
      <IconArrowLeft size={17} />
    </ActionIcon>
  );
}

function ErrorBar({ message }: { message: string | null }) {
  if (!message) {
    return null;
  }
  return (
    <div className={styles.errorBar} role="alert">
      <IconAlertCircle size={15} aria-hidden="true" className={styles.errorIcon} />
      <span>{message}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: ClientSupportTicketSummaryDto["status"] }) {
  return (
    <Badge size="sm" variant="light" color={statusColor(status)} className={styles.statusBadge}>
      {statusLabel(status)}
    </Badge>
  );
}

function MessageItem(props: {
  message: TicketMessage;
  dayLabel: string | null;
  grouped: boolean;
  onOpenAttachment: (attachment: TicketAttachmentPreview) => void;
}) {
  const { message } = props;
  const attachments = message.attachments ?? [];
  const role = message.authorRole === "user" ? "user" : message.authorRole === "system" ? "system" : "admin";
  const time = formatTime(message.createdAt);
  return (
    <>
      {props.dayLabel ? (
        <div className={styles.day} role="separator">
          <span>{props.dayLabel}</span>
        </div>
      ) : null}
      {role === "system" ? (
        <div className={styles.systemRow}>
          <span className={styles.systemText}>
            {message.body}
            <time dateTime={message.createdAt}> · {time}</time>
          </span>
        </div>
      ) : (
        <div className={styles.messageRow} data-role={role} data-grouped={props.grouped || undefined}>
          {props.grouped ? null : (
            <div className={styles.messageMeta}>
              {role === "admin" ? <span className={styles.author}>{message.authorDisplayName ?? authorLabel(message.authorRole)}</span> : null}
              <time dateTime={message.createdAt} title={formatDateTime(message.createdAt)}>{time}</time>
            </div>
          )}
          <div
            className={styles.bubble}
            aria-label={`${role === "user" ? "我" : message.authorDisplayName ?? "客服"}，${formatDateTime(message.createdAt)}`}
          >
            {message.body ? <div className={styles.bubbleText}>{message.body}</div> : null}
            {attachments.length > 0 ? (
              <div className={styles.attachments} data-solo={!message.body || undefined}>
                {attachments.map((attachment) =>
                  isImageAttachment(attachment) ? (
                    <button
                      key={attachment.id}
                      type="button"
                      className={styles.thumb}
                      title={attachment.fileName}
                      aria-label={`查看图片 ${attachment.fileName}`}
                      onClick={() => props.onOpenAttachment(attachment)}
                    >
                      <img src={attachment.url} alt="" loading="lazy" />
                    </button>
                  ) : (
                    <button
                      key={attachment.id}
                      type="button"
                      className={styles.fileChip}
                      title={attachment.fileName}
                      onClick={() => props.onOpenAttachment(attachment)}
                    >
                      <IconFileText size={14} aria-hidden="true" />
                      <span>{attachment.fileName}</span>
                    </button>
                  )
                )}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}

function PendingAttachment(props: { file: File; upload: TicketAttachmentUploadState; onRemove: () => void }) {
  const previewUrl = useObjectUrl(props.file);
  const [thumbFailed, setThumbFailed] = useState(false);
  const { phase, progress, error } = props.upload;
  useEffect(() => setThumbFailed(false), [previewUrl]);
  return (
    <div className={styles.pending} data-phase={phase}>
      {previewUrl && !thumbFailed ? (
        <img src={previewUrl} alt="" className={styles.pendingThumb} onError={() => setThumbFailed(true)} />
      ) : (
        <span className={styles.pendingThumb} aria-hidden="true"><IconPhoto size={16} /></span>
      )}
      <div className={styles.pendingInfo}>
        <div className={styles.pendingHead}>
          <span className={styles.pendingName} title={props.file.name}>{props.file.name}</span>
          <span className={styles.pendingStatus} title={phase === "failed" && error ? error : undefined}>
            {attachmentUploadLabel(phase, progress)}
          </span>
        </div>
        {phase === "uploading" || phase === "idle" ? (
          <div
            className={styles.pendingBar}
            role="progressbar"
            aria-label="附件上传进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress)}
          >
            <span style={{ width: `${Math.max(2, Math.min(100, progress))}%` }} />
          </div>
        ) : null}
      </div>
      <CloseButton size="sm" aria-label="移除附件" onClick={props.onRemove} icon={<IconX size={14} />} />
    </div>
  );
}

function useObjectUrl(file: File | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file || !file.type.startsWith("image/")) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}

function isImageAttachment(attachment: TicketAttachmentPreview) {
  return !attachment.mimeType || attachment.mimeType.startsWith("image/");
}

function isSameSpeakerBurst(previous: TicketMessage, next: TicketMessage) {
  return (
    previous.authorRole === next.authorRole &&
    previous.authorRole !== "system" &&
    previous.authorDisplayName === next.authorDisplayName &&
    new Date(next.createdAt).getTime() - new Date(previous.createdAt).getTime() < GROUP_WINDOW_MS
  );
}

function statusLabel(status: ClientSupportTicketSummaryDto["status"]) {
  switch (status) {
    case "waiting_admin":
      return "等待客服";
    case "waiting_user":
      return "待补充";
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
      return "orange";
    case "closed":
      return "gray";
    default:
      return "teal";
  }
}

function authorLabel(role: TicketMessage["authorRole"]) {
  switch (role) {
    case "admin":
      return "客服";
    case "system":
      return "系统";
    default:
      return "我";
  }
}

function attachmentUploadLabel(phase: TicketAttachmentUploadState["phase"], progress: number) {
  switch (phase) {
    case "uploading":
      return `上传中 ${Math.round(progress)}%`;
    case "uploaded":
      return "已上传";
    case "failed":
      return "上传失败，请重新选择";
    default:
      return "等待上传";
  }
}

function ticketCode(ticket: ClientSupportTicketSummaryDto) {
  const shortId = ticket.id.replace(/[^a-zA-Z0-9]/g, "").slice(-4).toUpperCase();
  return `TK${formatCompactDateTime(ticket.createdAt)}${shortId}`;
}

function pad(value: number) {
  return `${value}`.padStart(2, "0");
}

function formatCompactDateTime(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatTime(value: string) {
  const date = new Date(value);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dayKey(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function daysAgo(value: string) {
  const date = new Date(value);
  const today = new Date();
  const startOfDay = (target: Date) => new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  return Math.round((startOfDay(today) - startOfDay(date)) / 86_400_000);
}

function formatDayLabel(value: string) {
  const date = new Date(value);
  const ago = daysAgo(value);
  if (ago === 0) return "今天";
  if (ago === 1) return "昨天";
  if (date.getFullYear() === new Date().getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function formatListTime(value: string) {
  const date = new Date(value);
  const ago = daysAgo(value);
  if (ago === 0) return formatTime(value);
  if (ago === 1) return "昨天";
  if (date.getFullYear() === new Date().getFullYear()) return `${date.getMonth() + 1}/${date.getDate()}`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}
