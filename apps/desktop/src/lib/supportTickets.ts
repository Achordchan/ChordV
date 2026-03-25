import type { ClientSupportTicketDetailDto, ClientSupportTicketSummaryDto } from "@chordv/shared";

type DesktopSupportTicket = ClientSupportTicketSummaryDto | ClientSupportTicketDetailDto;

type LegacyTicketFlags = {
  unread?: boolean;
  hasUnread?: boolean;
  unreadMessageCount?: number | null;
  unreadAt?: string | null;
};

type TicketPatchTarget = DesktopSupportTicket & LegacyTicketFlags;

export function isSupportTicketUnread(ticket: DesktopSupportTicket) {
  const current = ticket as TicketPatchTarget;
  if (typeof current.hasUnreadMessages === "boolean") {
    return current.hasUnreadMessages;
  }
  if (typeof current.unreadCount === "number") {
    return current.unreadCount > 0;
  }
  if (typeof current.unread === "boolean") {
    return current.unread;
  }
  if (typeof current.hasUnread === "boolean") {
    return current.hasUnread;
  }
  if (typeof current.unreadMessageCount === "number") {
    return current.unreadMessageCount > 0;
  }
  return Boolean(current.unreadAt);
}

export function markSupportTicketAsRead<T extends DesktopSupportTicket>(ticket: T, ticketId: string): T {
  if (ticket.id !== ticketId) {
    return ticket;
  }
  const current = ticket as TicketPatchTarget;
  const lastReadAt = new Date().toISOString();
  return {
    ...current,
    hasUnreadMessages: false,
    unreadCount: 0,
    lastReadAt,
    unread: false,
    hasUnread: false,
    unreadMessageCount: 0,
    unreadAt: null
  } as unknown as T;
}
