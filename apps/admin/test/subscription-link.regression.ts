import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  describeDistributionStatus,
  describeLinkDistribution,
  describeLinkPreview,
  normalizeOriginInput
} from "../src/features/customers/subscription-link-model";

// The admin side of subscription links: what an operator is told about a link,
// and the handful of things the panel must never do with one.

const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");
const panel = read("../src/features/customers/CustomerSubscriptionLink.tsx");
const workspace = read("../src/features/customers/CustomerWorkspace.tsx");
const settingsModal = read("../src/features/system-settings/SubscriptionLinkSettingsModal.tsx");
const settingsPage = read("../src/pages/SystemSettingsPage.tsx");
const api = read("../src/api/subscription-links.ts");

// --- what the operator is told -------------------------------------------------------

assert.deepEqual(
  [describeLinkDistribution({ state: "live", publishedAt: "2026-11-26T00:00:00Z" }).tone,
    describeLinkDistribution({ state: "pending", publishedAt: null }).tone,
    describeLinkDistribution({ state: "not_configured", publishedAt: null }).tone],
  ["ok", "wait", "off"]
);
// An issued link that nothing serves yet must not read as usable.
assert.match(describeLinkDistribution({ state: "pending", publishedAt: null }).hint, /链接无效/);
assert.match(describeLinkDistribution({ state: "not_configured", publishedAt: null }).hint, /暂时无法访问/);

assert.equal(
  describeLinkPreview({ kind: "nodes", notice: null, nodes: [{ nodeId: "a", name: "A" }, { nodeId: "b", name: "B" }] }),
  "客户端会得到 2 个节点"
);
assert.equal(
  describeLinkPreview({ kind: "notice", notice: "订阅已到期，请联系客服续费", nodes: [] }),
  "客户端会显示一条提示：订阅已到期，请联系客服续费"
);

const status = { configured: true, lastRunAt: "2026-11-26T00:00:00Z", lastSuccessAt: "2026-11-26T00:00:00Z", lastError: null, pending: 0 };
assert.equal(describeDistributionStatus(status).tone, "ok");
assert.equal(describeDistributionStatus({ ...status, configured: false }).tone, "off");
assert.equal(describeDistributionStatus({ ...status, lastRunAt: null, lastSuccessAt: null }).tone, "wait");
assert.deepEqual(describeDistributionStatus({ ...status, pending: 3 }), { tone: "wait", label: "有 3 条链接正在发布" });
// A failure is named, with how much is affected — not folded into "publishing".
assert.deepEqual(
  describeDistributionStatus({ ...status, pending: 3, lastError: "写入分发层失败（HTTP 403）" }),
  { tone: "wait", label: "有 3 条链接未发布：写入分发层失败（HTTP 403）" }
);

assert.equal(normalizeOriginInput("  "), null);
assert.equal(normalizeOriginInput(" https://my.example.com "), "https://my.example.com");

// --- the requests ----------------------------------------------------------------------

assert.match(api, /`\/admin\/users\/\$\{encodeURIComponent\(userId\)\}\/subscription-link`/, "用户 ID 进路径前必须编码");
assert.match(api, /request<AdminSubscriptionLinkStateDto>\(userLinkPath\(userId\)\);/);
assert.match(api, /request<AdminSubscriptionLinkStateDto>\(userLinkPath\(userId\), \{ method: "POST" \}\)/);
assert.match(api, /`\$\{userLinkPath\(userId\)\}\/reset`, \{ method: "POST" \}/);

// --- the panel ---------------------------------------------------------------------------

// Opening the tab only reads. A link is issued when the operator asks for one.
assert.match(panel, /void run\(\(\) => fetchSubscriptionLink\(userId\), "订阅链接读取失败"\);\n    return \(\) => \{ epoch\.current\+\+; \};\n  \}, \[userId\]\);/);
assert.equal(panel.match(/issueSubscriptionLink\(userId\)/g)?.length, 1, "签发只发生在“生成订阅链接”按钮上");
// Resetting invalidates what the customer holds: it is confirmed first, and
// the confirmation says so.
assert.match(panel, /const accepted = await confirmation\.confirm\(\{ title: "重置订阅链接", confirmLabel: "重置", danger: true,/);
assert.match(panel, /旧链接立即失效/);
assert.match(panel, /if \(accepted\) await run\(\(\) => resetSubscriptionLink\(userId\),/);
assert.equal(panel.match(/resetSubscriptionLink\(userId\)/g)?.length, 1);
// A late answer for the previous customer is dropped, and one for a different
// customer is refused outright.
assert.match(panel, /if \(id !== epoch\.current\) return;/);
assert.match(panel, /if \(next\.link && next\.link\.userId !== userId\) throw new Error\("订阅链接归属与当前客户不一致"\);/);
assert.match(panel, /setState\(null\); setQr\(null\);/, "切换客户时先清掉上一位的链接和二维码");
// The link is a credential: it stays in component state and is never written
// to storage or the console.
assert.doesNotMatch(panel, /localStorage|sessionStorage|console\./);
// The QR code is drawn locally from the link; the link is not sent to any
// service to be rendered.
assert.match(panel, /QRCode\.toDataURL\(url,/);
assert.doesNotMatch(panel, /https?:\/\/(?!sub\.example|my\.example)[^"'`\s]*qr/i);
// No domain configured: say so instead of showing a blank field.
assert.match(panel, /还没有配置订阅域名/);

// Both kinds of customer reach it; a team goes through a member picker
// because each member has a link of their own.
assert.match(workspace, /\{ id: "link", label: "订阅链接" \}/);
assert.match(workspace, /tab === "link" && \(customer\.user \? <CustomerSubscriptionLink key=\{customer\.user\.id\} userId=\{customer\.user\.id\}\/>/);
assert.match(workspace, /<TeamSubscriptionLinks key=\{customer\.team\.id\} members=\{customer\.team\.members\}\/>/);
assert.match(panel, /\{selected && <CustomerSubscriptionLink key=\{selected\} userId=\{selected\}\/>\}/);

// --- the settings ------------------------------------------------------------------------

assert.match(settingsPage, /<SubscriptionLinkSettingsModal opened=\{linkOpened\} onClose=\{\(\)=>setLinkOpened\(false\)\}\/>/);
assert.match(settingsModal, /saveSubscriptionLinkSettings\(\{ origin: normalizeOriginInput\(origin\), backupOrigin: normalizeOriginInput\(backupOrigin\) \}\)/);
// Swapping primary and backup only edits the form; nothing changes until saved.
assert.match(settingsModal, /const swap = \(\) => \{ setOrigin\(backupOrigin\); setBackupOrigin\(origin\); \};/);
assert.match(settingsModal, /不会修改 DNS/);

console.log("admin subscription link checks passed");
