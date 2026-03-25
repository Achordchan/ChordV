import type {
  AdminSupportTicketDetailDto,
  AdminSupportTicketSummaryDto,
  ClientSupportTicketDetailDto,
  ClientSupportTicketSummaryDto,
  SupportTicketAuthorRole,
  SupportTicketSource,
  SupportTicketStatus
} from "@chordv/shared";

type TicketReadState = {
  lastReadAt: Date | null;
  lastReadMessageAt: Date | null;
} | null | undefined;

type TicketSummaryRow = {
  id: string;
  title: string;
  status: SupportTicketStatus;
  source: SupportTicketSource;
  subscriptionId: string | null;
  teamId: string | null;
  team?: { id: string; name: string } | null;
  lastMessageAt: Date;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  messages?: Array<{ body: string; createdAt: Date }>;
  readStates?: Array<{ lastReadAt: Date | null; lastReadMessageAt: Date | null }>;
};

type TicketDetailRow = {
  id: string;
  title: string;
  status: SupportTicketStatus;
  source: SupportTicketSource;
  subscriptionId: string | null;
  teamId: string | null;
  team?: { id: string; name: string } | null;
  lastMessageAt: Date;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  messages: Array<{
    id: string;
    ticketId: string;
    authorRole: SupportTicketAuthorRole;
    body: string;
    createdAt: Date;
    authorUser?: { displayName: string } | null;
  }>;
  readStates?: Array<{ lastReadAt: Date | null; lastReadMessageAt: Date | null }>;
};

type AdminTicketSummaryRow = {
  id: string;
  title: string;
  status: SupportTicketStatus;
  source: SupportTicketSource;
  userId: string;
  subscriptionId: string | null;
  teamId: string | null;
  lastMessageAt: Date;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  user: { id: string; email: string; displayName: string };
  team?: { id: string; name: string } | null;
  messages?: Array<{ body: string; createdAt: Date }>;
};

type AdminTicketDetailRow = {
  id: string;
  title: string;
  status: SupportTicketStatus;
  source: SupportTicketSource;
  userId: string;
  subscriptionId: string | null;
  teamId: string | null;
  lastMessageAt: Date;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  user: { id: string; email: string; displayName: string };
  team?: { id: string; name: string } | null;
  messages: Array<{
    id: string;
    ticketId: string;
    authorRole: SupportTicketAuthorRole;
    authorUserId: string | null;
    body: string;
    createdAt: Date;
    authorUser?: { id: string; email: string; displayName: string } | null;
  }>;
};

export function summarizeSupportTicketMessage(body: string) {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (normalized.length <= 60) {
    return normalized;
  }
  return `${normalized.slice(0, 60)}…`;
}

export function hasUnreadTicketMessages(latestAdminMessageAt: Date | null, readState?: TicketReadState) {
  if (!latestAdminMessageAt) {
    return false;
  }
  if (!readState?.lastReadMessageAt) {
    return true;
  }
  return latestAdminMessageAt.getTime() > readState.lastReadMessageAt.getTime();
}

export function readSupportTicketAuthorDisplayName(role: SupportTicketAuthorRole, displayName: string | null) {
  if (displayName) {
    return displayName;
  }
  if (role === "admin") {
    return "客服";
  }
  if (role === "system") {
    return "系统";
  }
  return "用户";
}

export function toClientSupportTicketSummary(
  row: TicketSummaryRow,
  latestAdminMessageAt?: Date | null
): ClientSupportTicketSummaryDto {
  const latestMessage = row.messages?.[0] ?? null;
  const readState = row.readStates?.[0] ?? null;
  const hasUnreadMessages = hasUnreadTicketMessages(latestAdminMessageAt ?? null, readState);
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    source: row.source,
    subscriptionId: row.subscriptionId,
    teamId: row.teamId,
    teamName: row.team?.name ?? null,
    lastMessageAt: row.lastMessageAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastMessagePreview: latestMessage ? summarizeSupportTicketMessage(latestMessage.body) : null,
    hasUnreadMessages,
    unreadCount: hasUnreadMessages ? 1 : 0,
    lastReadAt: readState?.lastReadAt?.toISOString() ?? null
  };
}

export function toClientSupportTicketDetail(row: TicketDetailRow): ClientSupportTicketDetailDto {
  const latestAdminMessageAt =
    row.messages
      .filter((message) => message.authorRole === "admin")
      .slice(-1)[0]?.createdAt ?? null;
  const base = toClientSupportTicketSummary(row, latestAdminMessageAt);
  return {
    ...base,
    messages: row.messages.map((message) => ({
      id: message.id,
      ticketId: message.ticketId,
      authorRole: message.authorRole,
      authorDisplayName: readSupportTicketAuthorDisplayName(message.authorRole, message.authorUser?.displayName ?? null),
      body: message.body,
      createdAt: message.createdAt.toISOString()
    }))
  };
}

export function toAdminSupportTicketSummary(row: AdminTicketSummaryRow): AdminSupportTicketSummaryDto {
  const latestMessage = row.messages?.[0] ?? null;
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    source: row.source,
    ownerType: row.teamId ? "team" : "personal",
    userId: row.userId,
    userEmail: row.user.email,
    userDisplayName: row.user.displayName,
    subscriptionId: row.subscriptionId,
    teamId: row.teamId,
    teamName: row.team?.name ?? null,
    lastMessageAt: row.lastMessageAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastMessagePreview: latestMessage ? summarizeSupportTicketMessage(latestMessage.body) : null
  };
}

export function toAdminSupportTicketDetail(row: AdminTicketDetailRow): AdminSupportTicketDetailDto {
  const base = toAdminSupportTicketSummary(row);
  return {
    ...base,
    messages: row.messages.map((message) => ({
      id: message.id,
      ticketId: message.ticketId,
      authorRole: message.authorRole,
      authorUserId: message.authorUserId,
      authorDisplayName: readSupportTicketAuthorDisplayName(message.authorRole, message.authorUser?.displayName ?? null),
      authorEmail: message.authorUser?.email ?? null,
      body: message.body,
      createdAt: message.createdAt.toISOString()
    }))
  };
}
