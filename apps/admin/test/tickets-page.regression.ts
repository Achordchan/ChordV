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
  assert.doesNotMatch(source, /<Anchor[\s\S]{0,300}message\.attachments/);
}

function testTicketAttachmentPreviewHasScopedStyles() {
  assert.match(styles, /\.admin-ticket-attachment-preview-button/);
  assert.match(styles, /\.admin-ticket-attachment-preview-frame img/);
}

testTicketAttachmentsOpenInPreviewModal();
testTicketAttachmentPreviewHasScopedStyles();

console.log("admin tickets page regression checks passed");
