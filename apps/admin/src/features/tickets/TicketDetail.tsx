import type { ReactNode } from "react";
import { Alert, Avatar, Button } from "@mantine/core";
import { IconAlertCircle, IconArrowUpRight } from "@tabler/icons-react";
import type { AdminSupportTicketDetailDto } from "@chordv/shared";
import { formatDateTimeWithYear } from "../../utils/admin-format";
import { summarizeAdminDiagnosticMessage } from "../../utils/admin-filters";
import { TicketAttachmentThumbnail } from "./TicketAttachments";
import {
  countTicketAttachments,
  readMessageAuthorLabel,
  readTicketCustomerTarget,
  readTicketShortId,
  readTicketWriteActions,
  sortTicketMessages,
  ticketStatusTone,
  translateMessageRole,
  translateTicketSource,
  translateTicketStatus,
  type TicketAttachmentPreview,
  type TicketCustomerTarget
} from "./ticket-model";
import styles from "./TicketsWorkspace.module.css";

export type TicketDetailProps = {
  ticket: AdminSupportTicketDetailDto;
  /** 已启用 Achord Connect：只读存档，不渲染回复框、关闭、重开。 */
  readOnly: boolean;
  statusChanging: string | null;
  replySaving: boolean;
  onStatusAction: (ticket: AdminSupportTicketDetailDto, next: "close" | "reopen") => void;
  onPreviewAttachment: (attachment: TicketAttachmentPreview) => void;
  onOpenCustomer?: (target: TicketCustomerTarget) => void;
  /** 回复框由页面持有草稿与附件状态；只读存档时即使传入也不会渲染。 */
  composer?: ReactNode;
};

export function TicketDetail(props: TicketDetailProps) {
  const { ticket } = props;
  const actions = readTicketWriteActions(ticket, props.readOnly);
  const messages = sortTicketMessages(ticket.messages ?? []);
  const attachmentCount = countTicketAttachments(messages);
  const customerTarget = props.onOpenCustomer ? readTicketCustomerTarget(ticket) : null;
  const statusLabel = translateTicketStatus(ticket.status);

  return (
    <>
      <header className={styles.detailHeader}>
        <div className={styles.detailTitle}>
          <h1>{ticket.title}</h1>
          <div className={styles.detailMeta}>
            <span
              className={`${styles.tone} ${styles.statusPill}`}
              data-tone={ticketStatusTone(ticket.status)}
              data-archived={props.readOnly}
            >
              {props.readOnly ? `历史状态：${statusLabel}` : statusLabel}
            </span>
            <span>编号 {readTicketShortId(ticket)}</span>
            <span>来源 {translateTicketSource(ticket.source)}</span>
            <span>创建于 {formatDateTimeWithYear(ticket.createdAt)}</span>
          </div>
        </div>
        {actions.statusAction ? (
          <div className={styles.detailActions}>
            {actions.statusAction === "reopen" ? (
              <Button
                variant="default"
                loading={props.statusChanging === ticket.id}
                disabled={props.replySaving || (props.statusChanging !== null && props.statusChanging !== ticket.id)}
                onClick={() => props.onStatusAction(ticket, "reopen")}
              >
                重开工单
              </Button>
            ) : (
              <Button
                variant="default"
                color="red"
                loading={props.statusChanging === ticket.id}
                disabled={props.replySaving || (props.statusChanging !== null && props.statusChanging !== ticket.id)}
                onClick={() => props.onStatusAction(ticket, "close")}
              >
                关闭工单
              </Button>
            )}
          </div>
        ) : null}
      </header>

      {!props.readOnly && ticket.attachmentUploadStatus === "failed" ? (
        <Alert color="yellow" variant="light" icon={<IconAlertCircle size={18} />} className={styles.uploadNotice}>
          文字回复已保存，附件上传失败：
          {summarizeAdminDiagnosticMessage(ticket.attachmentUploadError, "请检查图床配置或稍后重试。")}
        </Alert>
      ) : null}

      <dl className={styles.facts}>
        <div>
          <dt>客户</dt>
          <dd>
            <strong title={ticket.userDisplayName}>{ticket.userDisplayName}</strong>
            <small title={ticket.userEmail}>{ticket.userEmail}</small>
            {customerTarget ? (
              <button type="button" className={styles.textButton} onClick={() => props.onOpenCustomer?.(customerTarget)}>
                {customerTarget.tab === "team" ? "查看团队" : "查看客户"}
                <IconArrowUpRight size={13} />
              </button>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>归属</dt>
          <dd>
            <strong title={ticket.teamName ?? undefined}>{ticket.ownerType === "team" ? ticket.teamName ?? "团队已不存在" : "个人订阅"}</strong>
            {ticket.ownerType === "team" ? <small>Team 订阅</small> : null}
          </dd>
        </div>
        <div>
          <dt>{props.readOnly ? "最后更新" : "最近更新"}</dt>
          <dd>
            <strong>{formatDateTimeWithYear(ticket.updatedAt)}</strong>
            {ticket.closedAt ? <small>关闭于 {formatDateTimeWithYear(ticket.closedAt)}</small> : null}
          </dd>
        </div>
        <div>
          <dt>会话</dt>
          <dd>
            <strong>{messages.length} 条消息</strong>
            <small>{attachmentCount > 0 ? `${attachmentCount} 个附件` : "无附件"}</small>
          </dd>
        </div>
      </dl>

      <section className={styles.thread} aria-label="会话记录">
        <div className={styles.threadHead}>
          <h3>会话记录</h3>
          <small>{props.readOnly ? "历史存档，仅供查看" : "按时间顺序"}</small>
        </div>
        <ol className={styles.messages}>
          {messages.map((message) =>
            message.authorRole === "system" ? (
              <li key={message.id} className={styles.systemEvent}>
                <span>
                  {message.body}
                  <time dateTime={message.createdAt}>{formatDateTimeWithYear(message.createdAt)}</time>
                </span>
              </li>
            ) : (
              <li key={message.id} className={styles.message} data-role={message.authorRole}>
                <Avatar size={34} radius="xl" className={styles.avatar}>
                  {Array.from(readMessageAuthorLabel(message.authorRole, message.authorDisplayName))[0]}
                </Avatar>
                <div className={styles.bubble}>
                  <div className={styles.bubbleHead}>
                    <strong>{readMessageAuthorLabel(message.authorRole, message.authorDisplayName)}</strong>
                    <span className={styles.role}>{translateMessageRole(message.authorRole)}</span>
                    {message.authorEmail ? <small>{message.authorEmail}</small> : null}
                    <time dateTime={message.createdAt}>{formatDateTimeWithYear(message.createdAt)}</time>
                  </div>
                  {message.body ? <p className={styles.body}>{message.body}</p> : null}
                  {(message.attachments ?? []).length > 0 ? (
                    <div className={styles.attachments}>
                      {(message.attachments ?? []).map((attachment) => (
                        <button
                          key={attachment.id}
                          type="button"
                          className={styles.attachmentButton}
                          aria-label={`预览附件 ${attachment.fileName}`}
                          onClick={() => props.onPreviewAttachment({ url: attachment.url, fileName: attachment.fileName })}
                        >
                          <TicketAttachmentThumbnail url={attachment.url} fileName={attachment.fileName} />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </li>
            )
          )}
          {messages.length === 0 ? <li className={styles.threadEmpty}>这条工单还没有消息。</li> : null}
        </ol>
      </section>

      {actions.showComposer ? props.composer ?? null : null}
    </>
  );
}
