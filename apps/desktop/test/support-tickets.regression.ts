import assert from "node:assert/strict";
import type { ClientSupportTicketSummaryDto } from "@chordv/shared";
import {
  consumeSupportTicketBackgroundDetailRefresh,
  isSupportTicketUnread,
  markSupportTicketAsRead,
  markSupportTicketAsUnread,
  markSupportTicketBackgroundDetailRefresh,
  reconcileLocalSupportTicketUnread
} from "../src/lib/supportTickets";

function createTicket(input?: Partial<ClientSupportTicketSummaryDto>): ClientSupportTicketSummaryDto {
  return {
    id: "ticket_1",
    title: "ticket",
    status: "open",
    source: "desktop",
    lastMessagePreview: null,
    lastMessageAt: "2026-06-04T00:00:00.000Z",
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
    hasUnreadMessages: false,
    unreadCount: 0,
    lastReadAt: null,
    ...input
  };
}

function testUnreadPatchSurvivesUntilExplicitRead() {
  const unread = markSupportTicketAsUnread(createTicket(), "ticket_1");
  assert.equal(isSupportTicketUnread(unread), true);

  const read = markSupportTicketAsRead(unread, "ticket_1");
  assert.equal(isSupportTicketUnread(read), false);
}

function testBackgroundDetailRefreshMarkerIsOneShot() {
  markSupportTicketBackgroundDetailRefresh("ticket_1");

  assert.equal(consumeSupportTicketBackgroundDetailRefresh("ticket_1"), true);
  assert.equal(consumeSupportTicketBackgroundDetailRefresh("ticket_1"), false);
}

function testLocalUnreadPatchClearsWhenServerConfirmsRead() {
  const locallyUnread = new Set(["ticket_1"]);
  const ticket = reconcileLocalSupportTicketUnread(createTicket({ hasUnreadMessages: false, unreadCount: 0 }), locallyUnread);

  assert.equal(isSupportTicketUnread(ticket), false);
  assert.equal(locallyUnread.has("ticket_1"), false);
}

function testLocalUnreadPatchKeepsServerUnreadVisible() {
  const locallyUnread = new Set(["ticket_1"]);
  const ticket = reconcileLocalSupportTicketUnread(createTicket({ hasUnreadMessages: true, unreadCount: 1 }), locallyUnread);

  assert.equal(isSupportTicketUnread(ticket), true);
  assert.equal(locallyUnread.has("ticket_1"), true);
}

function main() {
  testUnreadPatchSurvivesUntilExplicitRead();
  testBackgroundDetailRefreshMarkerIsOneShot();
  testLocalUnreadPatchClearsWhenServerConfirmsRead();
  testLocalUnreadPatchKeepsServerUnreadVisible();
  console.log("desktop support tickets regression checks passed");
}

main();
