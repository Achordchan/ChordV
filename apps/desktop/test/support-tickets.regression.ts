import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

function testAttachmentFormRequestHasTimeout() {
  const source = readFileSync(resolve(import.meta.dirname, "../src/api/client.ts"), "utf8");

  assert.match(source, /const FORM_REQUEST_TIMEOUT_MS = 60_000;/);
  assert.match(source, /const controller = new AbortController\(\);/);
  assert.match(source, /controller\.abort\(new Error\("请求超时"\)\);/);
  assert.match(source, /signal: init\?\.signal \?\? controller\.signal/);
  assert.match(source, /window\.clearTimeout\(timeout\);/);
}

function testReplyAttachmentUsesUploadProgressBeforeSubmit() {
  const apiSource = readFileSync(resolve(import.meta.dirname, "../src/api/client.ts"), "utf8");
  const hookSource = readFileSync(resolve(import.meta.dirname, "../src/hooks/useSupportTickets.ts"), "utf8");

  assert.match(apiSource, /export function uploadSupportTicketAttachment/);
  assert.match(apiSource, /\/client\/tickets\/\$\{encodeURIComponent\(ticketId\)\}\/attachments\/upload/);
  assert.match(apiSource, /new XMLHttpRequest\(\)/);
  assert.match(apiSource, /xhr\.upload\.onprogress/);
  assert.match(hookSource, /ticketReplyAttachmentUpload\.phase !== "uploaded"/);
  assert.match(hookSource, /attachment: ticketReplyAttachment \? ticketReplyAttachmentUpload\.attachment : null/);
  assert.doesNotMatch(hookSource, /replySupportTicketWithAttachment/);
}

function testJsonRequestsHaveTimeoutAndNetworkErrorNormalization() {
  const source = readFileSync(resolve(import.meta.dirname, "../src/api/client.ts"), "utf8");
  const normalizedErrorThrows = source.match(/throw normalizeNetworkRequestError\(error\);/g) ?? [];

  assert.match(source, /const JSON_REQUEST_TIMEOUT_MS = 60_000;/);
  assert.match(source, /}, JSON_REQUEST_TIMEOUT_MS\);/);
  assert.equal(normalizedErrorThrows.length >= 2, true, "JSON and form requests must both normalize network failures");
}

function testVisibleTicketUpdateMarksDetailRead() {
  const runtimeActionsSource = readFileSync(resolve(import.meta.dirname, "../src/hooks/useRuntimeActions.ts"), "utf8");
  const supportTicketsSource = readFileSync(resolve(import.meta.dirname, "../src/hooks/useSupportTickets.ts"), "utf8");

  assert.match(runtimeActionsSource, /const isVisibleSelectedTicket =/);
  assert.match(runtimeActionsSource, /const shouldMarkIncomingTicketRead =/);
  assert.match(runtimeActionsSource, /!shouldMarkIncomingTicketRead[\s\S]*options\.markTicketUnread\(runtimeEvent\.ticketId\);/);
  assert.match(
    runtimeActionsSource,
    /if \(shouldMarkIncomingTicketRead\) \{[\s\S]*loadTicketDetail\(preferredTicketId, \{ markRead: true, silent: true \}\)[\s\S]*loadTicketList\(preferredTicketId, \{ silent: true \}\)[\s\S]*\} else \{[\s\S]*Promise\.all/
  );
  assert.match(supportTicketsSource, /if \(!loadOptions\?\.silent\) \{\s*setTicketListBusy\(true\)/);
  assert.match(supportTicketsSource, /if \(!loadOptions\?\.silent\) \{\s*setTicketDetailBusy\(true\)/);
  assert.match(supportTicketsSource, /await markTicketAsRead\(ticketId, options\.accessToken\);/);
}

function testNewTicketMessageScrollsToLatestWithoutRefreshJitter() {
  const modalSource = readFileSync(resolve(import.meta.dirname, "../src/components/TicketCenterModal.tsx"), "utf8");
  const stylesSource = readFileSync(resolve(import.meta.dirname, "../src/styles.css"), "utf8");

  assert.match(modalSource, /scrollContainer\.scrollTop = scrollContainer\.scrollHeight;/);
  assert.match(modalSource, /props\.ticketDetail\?\.id, latestMessageId/);
  assert.doesNotMatch(modalSource, /followLatestMessageRef|bottomDistance <= 48/);
  assert.doesNotMatch(modalSource, /props\.ticketDetail, latestMessageId/);
  assert.match(stylesSource, /\.desktop-runtime-overlay \{[\s\S]*?z-index: 320;/);
}

function main() {
  testUnreadPatchSurvivesUntilExplicitRead();
  testBackgroundDetailRefreshMarkerIsOneShot();
  testLocalUnreadPatchClearsWhenServerConfirmsRead();
  testLocalUnreadPatchKeepsServerUnreadVisible();
  testAttachmentFormRequestHasTimeout();
  testReplyAttachmentUsesUploadProgressBeforeSubmit();
  testJsonRequestsHaveTimeoutAndNetworkErrorNormalization();
  testVisibleTicketUpdateMarksDetailRead();
  testNewTicketMessageScrollsToLatestWithoutRefreshJitter();
  console.log("desktop support tickets regression checks passed");
}

main();
