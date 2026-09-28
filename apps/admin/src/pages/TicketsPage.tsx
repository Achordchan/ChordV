import { DataSkeleton } from "../features/shared/DataSkeleton";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Modal, Stack } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertCircle, IconArchive, IconArrowLeft, IconExternalLink, IconMessageCircle } from "@tabler/icons-react";
import {
  closeAdminSupportTicket,
  fetchAdminUploadLimits,
  fetchAdminSupportTicketDetail,
  fetchAdminSupportTickets,
  reopenAdminSupportTicket,
  replyAdminSupportTicket,
  replyAdminSupportTicketWithAttachment,
  type AdminSupportTicketDetailDto,
  type AdminSupportTicketSummaryDto
} from "../api/client";
import { fetchSupportIntegrationConfig } from "../api/support-integration";
import { TicketList } from "../features/tickets/TicketList";
import { TicketDetail } from "../features/tickets/TicketDetail";
import { TicketComposer } from "../features/tickets/TicketComposer";
import { TicketAttachmentPreviewContent } from "../features/tickets/TicketAttachments";
import {
  filterTickets,
  LEGACY_TICKETS_READ_ONLY_NOTICE,
  readSafeExternalUrl,
  type TicketAttachmentPreview,
  type TicketCustomerTarget,
  type TicketOwnerFilter,
  type TicketStatusFilter
} from "../features/tickets/ticket-model";
import styles from "../features/tickets/TicketsWorkspace.module.css";
import {
  isPotentiallyCompletedMutationFailure,
  isSupportTicketAttachmentUploadFailure,
  buildUncertainMutationMessage,
  readError,
  summarizeAdminDiagnosticMessage
} from "../utils/admin-filters";

export { LEGACY_TICKETS_READ_ONLY_NOTICE };

const ADMIN_TICKET_REPLY_MAX_BODY_LENGTH = 4000;
const DEFAULT_ADMIN_TICKET_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

type TicketsPageProps = {
  refreshSignal?: number;
  /** 已启用新工单系统：只读存档，隐藏回复、附件、关闭、重开（后台接口同样拒绝）。 */
  readOnly?: boolean;
  onTicketMutated?: () => void;
  /** 从工单跳到“客户与订阅”并定位到对应客户或团队。 */
  onOpenCustomer?: (target: TicketCustomerTarget) => void;
};

export function TicketsPage(props: TicketsPageProps) {
  const readOnly = props.readOnly === true;
  const [keyword, setKeyword] = useState("");
  const [statusFilter, setStatusFilter] = useState<TicketStatusFilter>("all");
  const [ownerFilter, setOwnerFilter] = useState<TicketOwnerFilter>("all");
  const [mobileDetail, setMobileDetail] = useState(false);
  const [connectUrl, setConnectUrl] = useState<string | null>(null);
  const [tickets, setTickets] = useState<AdminSupportTicketSummaryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [selectedTicket, setSelectedTicket] = useState<AdminSupportTicketDetailDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [replyAttachment, setReplyAttachment] = useState<File | null>(null);
  const [attachmentMaxBytes, setAttachmentMaxBytes] = useState(DEFAULT_ADMIN_TICKET_ATTACHMENT_MAX_BYTES);
  const [replySaving, setReplySaving] = useState(false);
  const [statusChanging, setStatusChanging] = useState<string | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<TicketAttachmentPreview | null>(null);
  const selectedTicketIdRef = useRef<string | null>(null);
  const ticketListRequestSeqRef = useRef(0);
  const detailRequestSeqRef = useRef(0);
  const ticketListLoadingSeqRef = useRef<number | null>(null);
  const ticketDetailLoadingSeqRef = useRef<number | null>(null);
  const replySavingRef = useRef(false);
  const statusChangingRef = useRef<string | null>(null);
  const replyAttachmentResetRef = useRef<() => void>(null);

  useEffect(() => {
    void loadTickets();
    void loadUploadLimits();
  }, []);

  async function loadUploadLimits() {
    try {
      const limits = await fetchAdminUploadLimits();
      setAttachmentMaxBytes(limits.supportTicketAttachmentMaxBytes || DEFAULT_ADMIN_TICKET_ATTACHMENT_MAX_BYTES);
    } catch {
      setAttachmentMaxBytes(DEFAULT_ADMIN_TICKET_ATTACHMENT_MAX_BYTES);
    }
  }

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
      setReplyDraft("");
      setReplyAttachment(null);
      replyAttachmentResetRef.current?.();
      return;
    }
    setReplyDraft("");
    setReplyAttachment(null);
    replyAttachmentResetRef.current?.();
    void loadTicketDetail(selectedTicketId);
  }, [selectedTicketId]);

  // 只读存档提供“打开 Achord Connect”入口；地址取自“工单系统接入”设置，读取失败时不显示入口。
  useEffect(() => {
    if (!readOnly) {
      setConnectUrl(null);
      return;
    }
    let disposed = false;
    fetchSupportIntegrationConfig()
      .then((config) => {
        if (!disposed) setConnectUrl(readSafeExternalUrl(config.baseUrl));
      })
      .catch(() => {
        if (!disposed) setConnectUrl(null);
      });
    return () => {
      disposed = true;
    };
  }, [readOnly]);

  const visibleTickets = useMemo(
    () => filterTickets(tickets, { keyword, status: statusFilter, owner: ownerFilter }),
    [keyword, ownerFilter, statusFilter, tickets]
  );

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

  function handleReplyAttachmentChange(file: File | null) {
    if (!file) {
      setReplyAttachment(null);
      replyAttachmentResetRef.current?.();
      return;
    }
    if (!file.type.startsWith("image/")) {
      notifications.show({
        color: "yellow",
        title: "附件格式不支持",
        message: "工单附件只支持图片文件。"
      });
      setReplyAttachment(null);
      replyAttachmentResetRef.current?.();
      return;
    }
    if (file.size > attachmentMaxBytes) {
      notifications.show({
        color: "yellow",
        title: "附件过大",
        message: `工单附件不能超过 ${formatUploadBytes(attachmentMaxBytes)}。`
      });
      setReplyAttachment(null);
      return;
    }
    setReplyAttachment(file);
  }

  async function handleReply() {
    if (replySavingRef.current || statusChangingRef.current || props.readOnly) {
      return;
    }
    const body = replyDraft.trim();
    if (!selectedTicket || (!body && !replyAttachment)) {
      return;
    }
    if (body.length > ADMIN_TICKET_REPLY_MAX_BODY_LENGTH) {
      notifications.show({
        color: "yellow",
        title: "回复内容过长",
        message: `回复内容不能超过 ${ADMIN_TICKET_REPLY_MAX_BODY_LENGTH} 字。`
      });
      return;
    }

    try {
      replySavingRef.current = true;
      setReplySaving(true);
      const detail = replyAttachment
        ? await replyAdminSupportTicketWithAttachment(selectedTicket.id, { body: body || null }, replyAttachment)
        : await replyAdminSupportTicket(selectedTicket.id, { body });
      detailRequestSeqRef.current += 1;
      ticketListRequestSeqRef.current += 1;
      const stillSelected = selectedTicketIdRef.current === detail.id;
      if (stillSelected) {
        setSelectedTicket(detail);
        setReplyDraft("");
        setReplyAttachment(null);
        replyAttachmentResetRef.current?.();
      }
      upsertTicketSummary(detail);
      props.onTicketMutated?.();
      if (detail.attachmentUploadStatus === "failed") {
        notifications.show({
          color: "yellow",
          title: "附件上传失败",
          message: `文字回复已保存，附件上传失败：${
            summarizeAdminDiagnosticMessage(detail.attachmentUploadError, "附件上传失败，请检查图床配置或稍后重试。") ?? "请稍后重试"
          }`
        });
      } else {
        notifications.show({
          color: "green",
          title: "工单",
          message: "回复已发送"
        });
      }
    } catch (reason) {
      const message = readError(reason, "发送回复失败");
      const uncertain = isPotentiallyCompletedMutationFailure(message);
      const attachmentUploadFailed = Boolean(replyAttachment) && !uncertain && isSupportTicketAttachmentUploadFailure(message);
      notifications.show({
        color: uncertain ? "yellow" : "red",
        title: uncertain ? "回复状态不确定" : attachmentUploadFailed ? "附件上传失败" : "工单",
        message: uncertain
          ? buildTicketReplyUncertainMessage(message)
          : attachmentUploadFailed
            ? buildTicketAttachmentFailureMessage(message)
            : message
      });
      if (uncertain && selectedTicket) {
        void loadTickets({ silent: true });
        void loadTicketDetail(selectedTicket.id, { silent: true });
      }
    } finally {
      replySavingRef.current = false;
      setReplySaving(false);
    }
  }

  async function handleStatusAction(ticket: AdminSupportTicketSummaryDto | AdminSupportTicketDetailDto, next: "close" | "reopen") {
    if (statusChangingRef.current || replySavingRef.current || props.readOnly) {
      return;
    }
    try {
      statusChangingRef.current = ticket.id;
      setStatusChanging(ticket.id);
      const detail = next === "close" ? await closeAdminSupportTicket(ticket.id) : await reopenAdminSupportTicket(ticket.id);
      detailRequestSeqRef.current += 1;
      ticketListRequestSeqRef.current += 1;
      if (selectedTicketIdRef.current === detail.id) {
        setSelectedTicket(detail);
      }
      upsertTicketSummary(detail);
      props.onTicketMutated?.();
      notifications.show({
        color: "green",
        title: "工单",
        message: next === "close" ? "工单已关闭" : "工单已重新打开"
      });
    } catch (reason) {
      const message = readError(reason, next === "close" ? "关闭工单失败" : "重开工单失败");
      const uncertain = isPotentiallyCompletedMutationFailure(message);
      notifications.show({
        color: uncertain ? "yellow" : "red",
        title: uncertain ? "工单状态不确定" : "工单",
        message: uncertain ? buildUncertainMutationMessage("工单操作") : message
      });
      if (uncertain) {
        void loadTickets({ silent: true });
        void loadTicketDetail(ticket.id, { silent: true });
      }
    } finally {
      statusChangingRef.current = null;
      setStatusChanging(null);
    }
  }

  const replyClosed = !selectedTicket || selectedTicket.status === "closed";
  const canSendReply = Boolean(selectedTicket && selectedTicket.status !== "closed" && (replyDraft.trim() || replyAttachment));
  const detailPending = detailLoading && selectedTicket?.id !== selectedTicketId;

  function reloadTickets() {
    void loadTickets();
    const ticketId = selectedTicketIdRef.current;
    if (ticketId) {
      void loadTicketDetail(ticketId);
    }
  }

  return (
    <Stack gap="md">
      {props.readOnly ? (
        <Alert color="teal.9" variant="light" icon={<IconArchive size={20} />} className={styles.archiveNotice}>
          <div className={styles.archiveNoticeBody}>
            <span>{LEGACY_TICKETS_READ_ONLY_NOTICE}</span>
            {connectUrl ? (
              <Button component="a" href={connectUrl} target="_blank" rel="noreferrer" size="xs" variant="default" rightSection={<IconExternalLink size={14} />}>
                打开 Achord Connect
              </Button>
            ) : null}
          </div>
        </Alert>
      ) : null}

      {error ? (
        <Alert color="red" variant="light" icon={<IconAlertCircle size={20} />} className={styles.errorNotice}>
          <span>{error}</span>
          <Button variant="subtle" color="red" size="xs" onClick={reloadTickets}>
            重新加载
          </Button>
        </Alert>
      ) : null}

      {loading && tickets.length === 0 ? (
        <DataSkeleton variant="workspace" rows={5} />
      ) : (
        <div className={[styles.workspace, readOnly ? styles.archived : "", mobileDetail && selectedTicketId ? styles.detailOpen : ""].join(" ")}>
          <TicketList
            tickets={visibleTickets}
            totalCount={tickets.length}
            selectedId={selectedTicketId}
            onSelect={(ticketId) => {
              setSelectedTicketId(ticketId);
              setMobileDetail(true);
            }}
            keyword={keyword}
            onKeywordChange={setKeyword}
            status={statusFilter}
            onStatusChange={setStatusFilter}
            owner={ownerFilter}
            onOwnerChange={setOwnerFilter}
            onClearFilters={() => {
              setKeyword("");
              setStatusFilter("all");
              setOwnerFilter("all");
            }}
            readOnly={readOnly}
            refreshing={loading || detailLoading}
            onRefresh={reloadTickets}
          />

          <main className={styles.detail}>
            {/* 窄屏返回按钮放在详情分支之外，详情加载中或失败时也能回到列表。 */}
            <button type="button" className={styles.backButton} onClick={() => setMobileDetail(false)}>
              <IconArrowLeft size={17} />
              返回列表
            </button>
            {detailError ? (
              <Alert color="red" variant="light" icon={<IconAlertCircle size={20} />} className={styles.errorNotice}>
                <span>{detailError}</span>
                {selectedTicketId ? (
                  <Button variant="subtle" color="red" size="xs" onClick={() => void loadTicketDetail(selectedTicketId)}>
                    重试
                  </Button>
                ) : null}
              </Alert>
            ) : null}

            {detailPending ? (
              <DataSkeleton variant="page" rows={4} />
            ) : selectedTicket ? (
              <TicketDetail
                ticket={selectedTicket}
                readOnly={readOnly}
                statusChanging={statusChanging}
                replySaving={replySaving}
                onStatusAction={(ticket, next) => void handleStatusAction(ticket, next)}
                onPreviewAttachment={setPreviewAttachment}
                onOpenCustomer={props.onOpenCustomer}
                composer={
                  props.readOnly ? null : (
                    <TicketComposer
                      draft={replyDraft}
                      onDraftChange={setReplyDraft}
                      maxLength={ADMIN_TICKET_REPLY_MAX_BODY_LENGTH}
                      attachment={replyAttachment}
                      onAttachmentChange={handleReplyAttachmentChange}
                      attachmentResetRef={replyAttachmentResetRef}
                      closed={replyClosed}
                      sending={replySaving}
                      sendDisabled={!canSendReply || replySaving || statusChanging !== null}
                      onSend={() => void handleReply()}
                    />
                  )
                }
              />
            ) : detailError ? null : (
              <div className={styles.empty}>
                {readOnly ? <IconArchive size={32} /> : <IconMessageCircle size={32} />}
                <h2>{tickets.length === 0 ? (readOnly ? "没有历史工单" : "暂无工单") : "选择一条工单"}</h2>
                <p>
                  {tickets.length === 0
                    ? readOnly
                      ? "迁移到 Achord Connect 之前没有留下自建工单记录。"
                      : "用户在客户端提交工单后，会在这里查看会话并回复。"
                    : visibleTickets.length === 0
                      ? "当前筛选条件下没有工单，调整筛选后查看详情。"
                      : "从左侧列表选择工单，查看会话记录与客户信息。"}
                </p>
              </div>
            )}
          </main>
        </div>
      )}
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

function formatUploadBytes(value: number) {
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, "")}GB`;
  }
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")}MB`;
  }
  return `${value}B`;
}

function buildTicketReplyUncertainMessage(message: string) {
  return `${message} 请求没有返回确认结果，回复可能已保存；请刷新工单详情确认，避免重复提交。`;
}

function buildTicketAttachmentFailureMessage(message: string) {
  return `${message} 请求没有返回成功结果；如果工单里没有出现新回复，请先发送纯文字回复或调整附件后重试。`;
}
