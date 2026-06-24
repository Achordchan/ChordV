import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dirname, "../src/pages/TicketsPage.tsx"), "utf8");
const styles = readFileSync(resolve(import.meta.dirname, "../src/styles.css"), "utf8");

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
  assert.match(source, /正在加载预览/);
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

testTicketAttachmentsOpenInPreviewModal();
testTicketAttachmentImagesExposeLoadingFailureAndRecoveryStates();
testTicketAttachmentPreviewHasScopedStyles();

console.log("admin tickets page regression checks passed");
