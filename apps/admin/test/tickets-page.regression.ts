import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dirname, "../src/pages/TicketsPage.tsx"), "utf8");
const styles = readFileSync(resolve(import.meta.dirname, "../src/styles.css"), "utf8");
const apiClient = readFileSync(resolve(import.meta.dirname, "../src/api/client.ts"), "utf8");
const app = readFileSync(resolve(import.meta.dirname, "../src/App.tsx"), "utf8");

function extractAsyncFunctionBody(functionName: string) {
  const signature = `async function ${functionName}`;
  const signatureIndex = source.indexOf(signature);
  assert.notEqual(signatureIndex, -1, `${functionName} should exist`);

  const bodyStart = source.indexOf("{", signatureIndex);
  assert.notEqual(bodyStart, -1, `${functionName} should have a body`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bodyStart + 1, index);
      }
    }
  }

  assert.fail(`${functionName} body should be closed`);
}

function testTicketAttachmentsOpenInPreviewModal() {
  assert.match(source, /const \[previewAttachment, setPreviewAttachment\]/);
  assert.match(source, /className="admin-ticket-attachment-preview-button"/);
  assert.match(source, /setPreviewAttachment\(\{ url: attachment\.url, fileName: attachment\.fileName \}\)/);
  assert.match(source, /opened=\{previewAttachment !== null\}/);
  assert.match(source, /<TicketAttachmentThumbnail url=\{attachment\.url\} fileName=\{attachment\.fileName\} \/>/);
  assert.match(source, /<TicketAttachmentPreviewContent attachment=\{previewAttachment\} \/>/);
  assert.doesNotMatch(source, /<Anchor[\s\S]{0,300}message\.attachments/);
}

function testTicketAttachmentImagesExposeLoadingFailureAndRecoveryStates() {
  assert.match(source, /type TicketAttachmentImageState = "loading" \| "loaded" \| "failed";/);
  assert.match(source, /缩略图加载失败/);
  assert.match(source, /<DataSkeleton variant="image"/);
  assert.match(source, /预览加载失败/);
  assert.match(source, />\s*重试\s*</);
  assert.match(source, />\s*打开原图\s*</);
  assert.match(source, /appendImageRetryToken/);
}

function testTicketAttachmentPreviewHasScopedStyles() {
  assert.match(styles, /\.admin-ticket-attachment-preview-button/);
  assert.match(styles, /\.admin-ticket-attachment-thumb-frame/);
  assert.match(styles, /\.admin-ticket-attachment-image-state--failed/);
  assert.match(styles, /\.admin-ticket-attachment-preview-state--failed/);
  assert.match(styles, /\.admin-ticket-attachment-preview-frame img/);
}

function testLegacyTicketsPageIsReadOnlyArchive() {
  assert.match(source, /工单系统已迁移到 Achord Connect，这里仅保留历史记录，只读。/);
  assert.match(source, /<Alert color="blue" variant="light" className="admin-tickets-readonly-notice">\s*\{LEGACY_TICKETS_READ_ONLY_NOTICE\}/);
  // 查看、搜索、筛选保留。
  assert.match(source, /fetchAdminSupportTickets\(\)/);
  assert.match(source, /fetchAdminSupportTicketDetail\(ticketId\)/);
  assert.match(source, /<SectionCard searchValue=\{keyword\} onSearchChange=\{setKeyword\}>/);
  // 回复、附件、关闭、重开、状态修改全部移除，不能再从页面发起写操作。
  for (const forbidden of [
    /replyAdminSupportTicket/,
    /closeAdminSupportTicket/,
    /reopenAdminSupportTicket/,
    /handleReply/,
    /handleStatusAction/,
    /<Textarea/,
    /<FileButton/,
    /发送回复/,
    /关闭工单/,
    /重开工单/,
    /onTicketMutated/
  ]) {
    assert.doesNotMatch(source, forbidden, `tickets page must stay read-only: ${forbidden}`);
  }
  assert.doesNotMatch(apiClient, /export async function (replyAdminSupportTicket|replyAdminSupportTicketWithAttachment|closeAdminSupportTicket|reopenAdminSupportTicket)\b/);
  assert.doesNotMatch(app, /onTicketMutated=/);
  assert.match(app, /tickets: \{\s*label: "历史工单"/);
  assert.doesNotMatch(app, /sectionKey === "tickets" && waitingAdminTicketCount/, "只读的历史工单不再在导航上显示待回复数量");
}

testTicketAttachmentsOpenInPreviewModal();
testTicketAttachmentImagesExposeLoadingFailureAndRecoveryStates();
testTicketAttachmentPreviewHasScopedStyles();
testLegacyTicketsPageIsReadOnlyArchive();

console.log("admin tickets page regression checks passed");
