import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dirname, "../src/pages/TicketsPage.tsx"), "utf8");
const styles = readFileSync(resolve(import.meta.dirname, "../src/styles.css"), "utf8");

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

function testTicketReplyAlwaysReleasesBusyState() {
  assert.match(
    source,
    /async function handleReply\(\)[\s\S]*?replySavingRef\.current = true;[\s\S]*?finally\s*{[\s\S]*?replySavingRef\.current = false;[\s\S]*?setReplySaving\(false\);[\s\S]*?}/,
    "admin ticket reply should always release replySaving after text reply, attachment reply, or failed upload"
  );
}

function testTicketStatusActionHandlesUncertainStateAndReleasesBusyState() {
  const body = extractAsyncFunctionBody("handleStatusAction");
  assert.match(body, /const uncertain = isPotentiallyCompletedMutationFailure\(message\);/);
  assert.match(body, /color: uncertain \? "yellow" : "red"/);
  assert.match(body, /if \(uncertain\) {[\s\S]*?void loadTickets\(\{ silent: true \}\);[\s\S]*?void loadTicketDetail\(ticket\.id, \{ silent: true \}\);[\s\S]*?}/);
  assert.match(
    body,
    /finally\s*{[\s\S]*?statusChangingRef\.current = null;[\s\S]*?setStatusChanging\(null\);[\s\S]*?}/,
    "ticket close/reopen must always release statusChanging state"
  );
}

function testTicketReplyAndStatusActionsAreMutuallyExclusive() {
  assert.match(
    extractAsyncFunctionBody("handleReply"),
    /if \(replySavingRef\.current \|\| statusChangingRef\.current\) {[\s\S]*?return;[\s\S]*?}/,
    "ticket reply should not start while close/reopen is in flight"
  );
  assert.match(
    extractAsyncFunctionBody("handleStatusAction"),
    /if \(statusChangingRef\.current \|\| replySavingRef\.current\) {[\s\S]*?return;[\s\S]*?}/,
    "ticket close/reopen should not start while a reply is in flight"
  );
  assert.match(
    source,
    /loading=\{statusChanging === selectedTicket\.id\}[\s\S]*?disabled=\{replySaving \|\| \(statusChanging !== null && statusChanging !== selectedTicket\.id\)\}/,
    "ticket close/reopen buttons should be disabled while reply or another status mutation is running"
  );
  assert.match(
    source,
    /disabled=\{!canSendReply \|\| replySaving \|\| statusChanging !== null\}/,
    "ticket send button should be disabled while close/reopen is running"
  );
}

testTicketAttachmentsOpenInPreviewModal();
testTicketAttachmentImagesExposeLoadingFailureAndRecoveryStates();
testTicketAttachmentPreviewHasScopedStyles();
testTicketReplyAlwaysReleasesBusyState();
testTicketStatusActionHandlesUncertainStateAndReleasesBusyState();
testTicketReplyAndStatusActionsAreMutuallyExclusive();

console.log("admin tickets page regression checks passed");
