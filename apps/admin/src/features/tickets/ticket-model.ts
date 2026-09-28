import type {
  AdminSupportTicketDetailDto,
  AdminSupportTicketMessageDto,
  AdminSupportTicketSummaryDto,
  SupportTicketAuthorRole,
  SupportTicketStatus
} from "@chordv/shared";
import { filterByKeyword } from "../../utils/admin-filters";

export type TicketStatusFilter = "all" | SupportTicketStatus;
export type TicketOwnerFilter = "all" | "personal" | "team";
export type TicketStatusTone = "attention" | "active" | "waiting" | "closed";
export type TicketAttachmentPreview = { url: string; fileName: string };
/** 跳转到“客户与订阅”时使用的列表类型与搜索词。 */
export type TicketCustomerTarget = { tab: "personal" | "team"; keyword: string };

/** 启用新工单系统（Achord Connect）后，自建工单只保留历史记录的查看与搜索，不能回复或修改状态。 */
export const LEGACY_TICKETS_READ_ONLY_NOTICE = "工单系统已迁移到 Achord Connect，这里仅保留历史记录，只读。";

export const ticketStatusFilters: ReadonlyArray<{ value: TicketStatusFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "waiting_admin", label: "待回复" },
  { value: "waiting_user", label: "待用户" },
  { value: "open", label: "处理中" },
  { value: "closed", label: "已关闭" }
];

export const ticketOwnerFilters: ReadonlyArray<{ value: TicketOwnerFilter; label: string }> = [
  { value: "all", label: "全部归属" },
  { value: "personal", label: "个人订阅" },
  { value: "team", label: "Team 订阅" }
];

export function filterTickets(
  tickets: AdminSupportTicketSummaryDto[],
  filters: { keyword: string; status: TicketStatusFilter; owner: TicketOwnerFilter }
) {
  return filterByKeyword(tickets, filters.keyword, (item) => [
    item.title,
    item.userDisplayName,
    item.userEmail,
    item.teamName ?? "",
    item.lastMessagePreview ?? ""
  ])
    .filter((item) => (filters.status === "all" || item.status === filters.status) && (filters.owner === "all" || item.ownerType === filters.owner))
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

export function translateTicketStatus(status: SupportTicketStatus) {
  if (status === "open") return "处理中";
  if (status === "waiting_admin") return "待管理员回复";
  if (status === "waiting_user") return "待用户回复";
  return "已关闭";
}

/** 列表行空间有限，使用与筛选项一致的短标签。 */
export function translateTicketStatusShort(status: SupportTicketStatus) {
  if (status === "open") return "处理中";
  if (status === "waiting_admin") return "待回复";
  if (status === "waiting_user") return "待用户";
  return "已关闭";
}

export function ticketStatusTone(status: SupportTicketStatus): TicketStatusTone {
  if (status === "waiting_admin") return "attention";
  if (status === "open") return "active";
  if (status === "waiting_user") return "waiting";
  return "closed";
}

export function translateTicketSource(source: AdminSupportTicketSummaryDto["source"]) {
  return source === "desktop" ? "桌面端" : source;
}

export function translateMessageRole(role: SupportTicketAuthorRole) {
  if (role === "admin") return "管理员";
  if (role === "user") return "用户";
  return "系统";
}

export function readMessageAuthorLabel(role: SupportTicketAuthorRole, authorDisplayName: string | null) {
  return authorDisplayName || translateMessageRole(role);
}

export function sortTicketMessages(messages: AdminSupportTicketMessageDto[]) {
  return [...messages].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
}

export function countTicketAttachments(messages: AdminSupportTicketMessageDto[]) {
  return messages.reduce((total, message) => total + (message.attachments ?? []).length, 0);
}

/**
 * 工单详情可用的写操作。只读存档（已启用 Achord Connect）不提供回复框、关闭或重开；
 * 未启用时已关闭的工单只能先重开，其余工单可以回复或关闭。
 */
export function readTicketWriteActions(ticket: Pick<AdminSupportTicketSummaryDto, "status">, readOnly: boolean) {
  if (readOnly) {
    return { showComposer: false, canReply: false, statusAction: null } as const;
  }
  if (ticket.status === "closed") {
    return { showComposer: true, canReply: false, statusAction: "reopen" } as const;
  }
  return { showComposer: true, canReply: true, statusAction: "close" } as const;
}

/** Team 工单跳到团队列表按团队名定位；个人工单跳到个人客户列表按邮箱定位。团队已不存在时不提供跳转。 */
export function readTicketCustomerTarget(
  ticket: Pick<AdminSupportTicketSummaryDto, "ownerType" | "teamName" | "userEmail">
): TicketCustomerTarget | null {
  if (ticket.ownerType === "team") {
    return ticket.teamName ? { tab: "team", keyword: ticket.teamName } : null;
  }
  return ticket.userEmail ? { tab: "personal", keyword: ticket.userEmail } : null;
}

/** 只接受 http(s) 地址，避免把配置里的异常值渲染成可点击链接。 */
export function readSafeExternalUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** 列表时间：今天只显示时刻，今年显示月日，更早显示完整日期。 */
export function formatTicketListTime(value: string, now = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => `${part}`.padStart(2, "0");
  if (date.toDateString() === now.toDateString()) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

export function readTicketShortId(ticket: Pick<AdminSupportTicketDetailDto, "id">) {
  return ticket.id.slice(-8).toUpperCase();
}
