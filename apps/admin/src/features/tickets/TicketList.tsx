import { ActionIcon, Text, TextInput } from "@mantine/core";
import { IconArchive, IconMessageCircle, IconRefresh, IconSearch } from "@tabler/icons-react";
import type { AdminSupportTicketSummaryDto } from "@chordv/shared";
import {
  formatTicketListTime,
  ticketOwnerFilters,
  ticketStatusFilters,
  ticketStatusTone,
  translateTicketStatus,
  translateTicketStatusShort,
  type TicketOwnerFilter,
  type TicketStatusFilter
} from "./ticket-model";
import styles from "./TicketsWorkspace.module.css";

export type TicketListProps = {
  tickets: AdminSupportTicketSummaryDto[];
  totalCount: number;
  selectedId: string | null;
  onSelect: (ticketId: string) => void;
  keyword: string;
  onKeywordChange: (value: string) => void;
  status: TicketStatusFilter;
  onStatusChange: (value: TicketStatusFilter) => void;
  owner: TicketOwnerFilter;
  onOwnerChange: (value: TicketOwnerFilter) => void;
  onClearFilters: () => void;
  readOnly: boolean;
  refreshing: boolean;
  onRefresh: () => void;
};

export function TicketList(props: TicketListProps) {
  const filtered = props.keyword.trim() !== "" || props.status !== "all" || props.owner !== "all";
  return (
    <aside className={styles.sidebar} aria-label="工单列表">
      <div className={styles.sidebarTools}>
        <div className={styles.sidebarHeading}>
          <h2>
            {props.readOnly ? "历史工单" : "工单"}
            <span>{props.tickets.length}</span>
          </h2>
          <ActionIcon variant="subtle" color="#65746b" aria-label="刷新工单" loading={props.refreshing} onClick={props.onRefresh}>
            <IconRefresh size={17} />
          </ActionIcon>
        </div>
        <TextInput
          aria-label="搜索工单"
          placeholder="搜索标题、客户、邮箱或内容"
          leftSection={<IconSearch size={17} />}
          value={props.keyword}
          onChange={(event) => props.onKeywordChange(event.currentTarget.value)}
          classNames={{ input: styles.searchInput }}
        />
        <div className={styles.segmented} role="group" aria-label="按状态筛选">
          {ticketStatusFilters.map((item) => (
            <button key={item.value} type="button" aria-pressed={props.status === item.value} onClick={() => props.onStatusChange(item.value)}>
              {item.label}
            </button>
          ))}
        </div>
        <div className={styles.ownerTabs} role="group" aria-label="按归属筛选">
          {ticketOwnerFilters.map((item) => (
            <button key={item.value} type="button" aria-pressed={props.owner === item.value} onClick={() => props.onOwnerChange(item.value)}>
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.ticketList}>
        {props.tickets.map((ticket) => {
          const selected = ticket.id === props.selectedId;
          // 只读存档里“待管理员回复”只是历史状态，不再提示为待处理。
          const needsReply = !props.readOnly && ticket.status === "waiting_admin";
          return (
            <button
              key={ticket.id}
              type="button"
              className={`${styles.ticketRow} ${selected ? styles.selected : ""}`}
              aria-pressed={selected}
              onClick={() => props.onSelect(ticket.id)}
            >
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>
                  {needsReply ? <span className={styles.attentionDot} role="img" aria-label="待回复" /> : null}
                  <strong title={ticket.title}>{ticket.title}</strong>
                </span>
                <small>
                  {ticket.userDisplayName} · {ticket.teamName ?? "个人订阅"}
                </small>
                <small className={styles.rowPreview}>{ticket.lastMessagePreview ?? "暂无内容"}</small>
              </span>
              <span className={styles.rowState}>
                <span
                  className={styles.tone}
                  data-tone={ticketStatusTone(ticket.status)}
                  data-archived={props.readOnly}
                  title={translateTicketStatus(ticket.status)}
                >
                  {translateTicketStatusShort(ticket.status)}
                </span>
                <small>{formatTicketListTime(ticket.updatedAt)}</small>
              </span>
            </button>
          );
        })}
        {props.tickets.length === 0 ? (
          <div className={styles.listEmpty}>
            {filtered ? <IconSearch size={26} /> : props.readOnly ? <IconArchive size={26} /> : <IconMessageCircle size={26} />}
            <Text fw={600}>{filtered ? "没有匹配的工单" : props.readOnly ? "没有历史工单" : "暂无工单"}</Text>
            {filtered ? (
              <>
                <p>共 {props.totalCount} 条工单，调整筛选条件后查看。</p>
                <button type="button" className={styles.textButton} onClick={props.onClearFilters}>
                  清除筛选
                </button>
              </>
            ) : (
              <p>{props.readOnly ? "迁移前没有留下自建工单记录。" : "用户在客户端提交的工单会出现在这里。"}</p>
            )}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
