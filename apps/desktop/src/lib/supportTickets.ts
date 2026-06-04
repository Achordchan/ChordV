import type { ClientSupportTicketDetailDto, ClientSupportTicketSummaryDto } from "@chordv/shared";

type DesktopSupportTicket = ClientSupportTicketSummaryDto | ClientSupportTicketDetailDto;

type LegacyTicketFlags = {
  unread?: boolean;
  hasUnread?: boolean;
  unreadMessageCount?: number | null;
  unreadAt?: string | null;
};

type TicketPatchTarget = DesktopSupportTicket & LegacyTicketFlags;

const backgroundDetailRefreshes = new Map<string, number>();

export function markSupportTicketBackgroundDetailRefresh(ticketId: string) {
  const normalizedTicketId = ticketId.trim();
  if (!normalizedTicketId) {
    return;
  }
  backgroundDetailRefreshes.set(normalizedTicketId, (backgroundDetailRefreshes.get(normalizedTicketId) ?? 0) + 1);
}

export function consumeSupportTicketBackgroundDetailRefresh(ticketId: string) {
  const current = backgroundDetailRefreshes.get(ticketId) ?? 0;
  if (current <= 0) {
    return false;
  }
  if (current === 1) {
    backgroundDetailRefreshes.delete(ticketId);
  } else {
    backgroundDetailRefreshes.set(ticketId, current - 1);
  }
  return true;
}

export function clearSupportTicketBackgroundDetailRefresh(ticketId: string) {
  backgroundDetailRefreshes.delete(ticketId);
}

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

export function markSupportTicketAsUnread<T extends DesktopSupportTicket>(ticket: T, ticketId: string): T {
  if (ticket.id !== ticketId) {
    return ticket;
  }
  const current = ticket as TicketPatchTarget;
  return {
    ...current,
    hasUnreadMessages: true,
    unreadCount: Math.max(typeof current.unreadCount === "number" ? current.unreadCount : 0, 1),
    unread: true,
    hasUnread: true,
    unreadMessageCount: Math.max(typeof current.unreadMessageCount === "number" ? current.unreadMessageCount : 0, 1),
    unreadAt: new Date().toISOString()
  } as unknown as T;
}

export function reconcileLocalSupportTicketUnread<T extends DesktopSupportTicket>(
  ticket: T,
  locallyUnreadTicketIds: Set<string>
): T {
  if (!locallyUnreadTicketIds.has(ticket.id)) {
    return ticket;
  }
  if (isSupportTicketUnread(ticket)) {
    return markSupportTicketAsUnread(ticket, ticket.id);
  }
  locallyUnreadTicketIds.delete(ticket.id);
  return ticket;
}
