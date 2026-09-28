import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");
const source = read("../src/pages/TicketsPage.tsx");
const detail = read("../src/features/tickets/TicketDetail.tsx");
const list = read("../src/features/tickets/TicketList.tsx");
const composer = read("../src/features/tickets/TicketComposer.tsx");
const attachments = read("../src/features/tickets/TicketAttachments.tsx");
const styles = read("../src/features/tickets/TicketsWorkspace.module.css");
const globalStyles = read("../src/styles.css");
const app = read("../src/App.tsx");
const appearance = read("../src/features/shared/AdminAppearance.tsx");
const overview = read("../src/pages/OverviewPage.tsx");

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
  assert.match(source, /onPreviewAttachment=\{setPreviewAttachment\}/);
  assert.match(detail, /className=\{styles\.attachmentButton\}/);
  assert.match(detail, /props\.onPreviewAttachment\(\{ url: attachment\.url, fileName: attachment\.fileName \}\)/);
  assert.match(source, /opened=\{previewAttachment !== null\}/);
  assert.match(detail, /<TicketAttachmentThumbnail url=\{attachment\.url\} fileName=\{attachment\.fileName\} \/>/);
  assert.match(source, /<TicketAttachmentPreviewContent attachment=\{previewAttachment\} \/>/);
  assert.doesNotMatch(detail, /<Anchor[\s\S]{0,300}message\.attachments/);
}

function testTicketAttachmentImagesExposeLoadingFailureAndRecoveryStates() {
  assert.match(attachments, /type TicketAttachmentImageState = "loading" \| "loaded" \| "failed";/);
  // 状态绑定到图片地址而不是在 effect 里重置，缓存图片先触发 load 也不会卡在“加载中”。
  assert.match(attachments, /const status = state\.url === url \? state\.status : "loading";/);
  assert.doesNotMatch(attachments, /useEffect/);
  assert.match(attachments, /缩略图加载失败/);
  assert.match(attachments, /<DataSkeleton variant="image"/);
  assert.match(attachments, /预览加载失败/);
  assert.match(attachments, />\s*重试\s*</);
  assert.match(attachments, />\s*打开原图\s*</);
  assert.match(attachments, /appendImageRetryToken/);
}

function testTicketWorkspaceUsesScopedStyles() {
  for (const selector of [".workspace", ".sidebar", ".ticketRow", ".selected", ".detail", ".facts", ".thread", ".message", ".composer", ".archiveNotice",
    ".attachmentButton", ".thumbFrame", ".imageStateFailed", ".previewStateFailed", ".previewFrame img"]) {
    assert.ok(styles.includes(`${selector} `) || styles.includes(`${selector},`), `ticket styles should define ${selector}`);
  }
  // 旧版全局工单样式（蓝色选中态、圆角卡片）已移除，页面只使用模块样式。
  assert.doesNotMatch(globalStyles, /admin-ticket/);
  assert.doesNotMatch(source + detail + list + composer + attachments, /className="admin-ticket/);
  // 窄屏（约 1024px）时详情整体滚动，回复框吸附在底部，会话不会被压没。
  assert.match(styles, /@media \(max-width: 1100px\)[\s\S]*?\.detail \{ overflow-y: auto;[\s\S]*?\.composer \{ position: sticky; bottom: 0;/);
}

function testTicketsPageSharesAdminAppearance() {
  // 工单页不再单独沿用旧的蓝色大圆角主题。
  assert.match(app, /<AdminAppearance>/);
  assert.doesNotMatch(app, /AdminAppearance enabled=/);
  assert.doesNotMatch(appearance, /enabled/);
  assert.match(source, /<DataSkeleton variant="workspace" rows=\{5\} \/>/);
}

function testTicketCustomerLinksOpenCustomerWorkspace() {
  assert.match(detail, /const customerTarget = props\.onOpenCustomer \? readTicketCustomerTarget\(ticket\) : null;/);
  assert.match(
    app,
    /onOpenCustomer=\{\(target\) => \{\s*setUserTab\(target\.tab\);\s*setSearch\(\(current\) => \(\{ \.\.\.current, users: target\.keyword \}\)\);\s*selectSection\("users"\);\s*\}\}/
  );
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
    /if \(replySavingRef\.current \|\| statusChangingRef\.current \|\| props\.readOnly\) {[\s\S]*?return;[\s\S]*?}/,
    "ticket reply should not start while close/reopen is in flight"
  );
  assert.match(
    extractAsyncFunctionBody("handleStatusAction"),
    /if \(statusChangingRef\.current \|\| replySavingRef\.current \|\| props\.readOnly\) {[\s\S]*?return;[\s\S]*?}/,
    "ticket close/reopen should not start while a reply is in flight"
  );
  assert.equal(
    detail.match(/loading=\{props\.statusChanging === ticket\.id\}\s*disabled=\{props\.replySaving \|\| \(props\.statusChanging !== null && props\.statusChanging !== ticket\.id\)\}/g)?.length,
    2,
    "ticket close/reopen buttons should be disabled while reply or another status mutation is running"
  );
  assert.match(
    source,
    /sendDisabled=\{!canSendReply \|\| replySaving \|\| statusChanging !== null\}/,
    "ticket send button should be disabled while close/reopen is running"
  );
  assert.match(composer, /disabled=\{props\.sendDisabled\}/);
}

function testLegacyTicketsBecomeReadOnlyWhenAchordConnectEnabled() {
  // 切换点是后台“工单系统接入”的启用开关（仪表台返回 legacyTicketsReadOnly）。
  assert.match(app, /const legacyTicketsReadOnly = snapshot\.dashboard\.legacyTicketsReadOnly === true;/);
  assert.match(app, /<TicketsPage\s+refreshSignal=\{ticketRefreshSignal\}\s+readOnly=\{legacyTicketsReadOnly\}/);
  assert.match(app, /const waitingAdminTicketCount = legacyTicketsReadOnly \? 0 : snapshot\.dashboard\.waitingAdminTickets;/, "只读后导航不再提示待回复数量");
  assert.match(overview, /\{snapshot\.dashboard\.legacyTicketsReadOnly \? null : <button onClick=\{props\.onOpenTickets\}>待回复工单/, "只读后仪表台不再把历史待回复当成待处理事项");
  // 只读时显示存档提示；回复框在页面和详情两层都不渲染，关闭、重开由 readTicketWriteActions 统一隐藏；处理函数也直接返回。
  assert.match(source, /export \{ LEGACY_TICKETS_READ_ONLY_NOTICE \};/);
  assert.match(source, /\{props\.readOnly \? \(\s*<Alert color="teal\.9" variant="light" icon=\{<IconArchive size=\{20\} \/>\} className=\{styles\.archiveNotice\}>[\s\S]*?\{LEGACY_TICKETS_READ_ONLY_NOTICE\}/);
  assert.match(source, /composer=\{\s*props\.readOnly \? null : \(\s*<TicketComposer/);
  assert.match(detail, /const actions = readTicketWriteActions\(ticket, props\.readOnly\);/);
  assert.match(detail, /\{actions\.statusAction \? \(/);
  assert.match(detail, /\{actions\.showComposer \? props\.composer \?\? null : null\}/);
  assert.match(extractAsyncFunctionBody("handleReply"), /if \(replySavingRef\.current \|\| statusChangingRef\.current \|\| props\.readOnly\) {/);
  assert.match(extractAsyncFunctionBody("handleStatusAction"), /if \(statusChangingRef\.current \|\| replySavingRef\.current \|\| props\.readOnly\) {/);
  // Achord Connect 入口只在只读时读取接入设置，地址经过 http(s) 校验。
  assert.match(source, /if \(!readOnly\) {\s*setConnectUrl\(null\);\s*return;\s*}[\s\S]*?fetchSupportIntegrationConfig\(\)[\s\S]*?setConnectUrl\(readSafeExternalUrl\(config\.baseUrl\)\)/);
  // 查看与搜索保留。
  assert.match(source, /fetchAdminSupportTicketDetail\(ticketId\)/);
  assert.match(source, /filterTickets\(tickets, \{ keyword, status: statusFilter, owner: ownerFilter \}\)/);
  assert.match(list, /aria-label="搜索工单"/);
}

testTicketAttachmentsOpenInPreviewModal();
testLegacyTicketsBecomeReadOnlyWhenAchordConnectEnabled();
testTicketAttachmentImagesExposeLoadingFailureAndRecoveryStates();
testTicketWorkspaceUsesScopedStyles();
testTicketsPageSharesAdminAppearance();
testTicketCustomerLinksOpenCustomerWorkspace();
testTicketReplyAlwaysReleasesBusyState();
testTicketStatusActionHandlesUncertainStateAndReleasesBusyState();
testTicketReplyAndStatusActionsAreMutuallyExclusive();

console.log("admin tickets page regression checks passed");
