import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  describeDistributionStatus,
  describeElsewhere,
  describeLinkDistribution,
  describeLinkPreview,
  describeLinkRevocation,
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
  [describeLinkDistribution({ state: "live", publishedAt: "2026-11-26T00:00:00Z", revoking: 0 }).tone,
    describeLinkDistribution({ state: "pending", publishedAt: null, revoking: 0 }).tone,
    describeLinkDistribution({ state: "not_configured", publishedAt: null, revoking: 0 }).tone],
  ["ok", "wait", "off"]
);
// An issued link that nothing serves yet must not read as usable.
assert.match(describeLinkDistribution({ state: "pending", publishedAt: null, revoking: 0 }).hint, /链接无效/);
assert.match(describeLinkDistribution({ state: "not_configured", publishedAt: null, revoking: 0 }).hint, /暂时无法访问/);

// A reset starts taking the old link down; it is only called gone once the
// server says nothing of this user's is left to revoke — whatever the state
// of the new link.
for (const state of ["live", "pending"] as const) {
  const waiting = describeLinkRevocation({ state, publishedAt: null, revoking: 1 });
  assert.equal(waiting.tone, "wait");
  assert.match(waiting.label, /正在撤销，完成前旧链接仍可使用/);
  assert.doesNotMatch(waiting.label, /已从分发层撤销/);
  const done = describeLinkRevocation({ state, publishedAt: null, revoking: 0 });
  assert.equal(done.tone, "ok");
  assert.match(done.label, /已从分发层撤销/);
}
// With distribution off the server revokes nothing, and must not be read as having done so.
assert.equal(describeLinkRevocation({ state: "not_configured", publishedAt: null, revoking: 0 }).tone, "off");
assert.doesNotMatch(describeLinkRevocation({ state: "not_configured", publishedAt: null, revoking: 0 }).label, /已从分发层撤销/);

assert.equal(
  describeLinkPreview({ kind: "nodes", notice: null, nodes: [{ nodeId: "a", name: "A" }, { nodeId: "b", name: "B" }] }),
  "客户端会得到 2 个节点"
);
assert.equal(
  describeLinkPreview({ kind: "notice", notice: "订阅已到期，请联系客服续费", nodes: [] }),
  "客户端会显示一条提示：订阅已到期，请联系客服续费"
);

const status = { configured: true, lastRunAt: "2026-11-26T00:00:00Z", lastSuccessAt: "2026-11-26T00:00:00Z", lastError: null, pending: 0, revoking: 0, elsewhere: 0 };
assert.equal(describeDistributionStatus(status).tone, "ok");
assert.equal(describeDistributionStatus({ ...status, configured: false }).tone, "off");
assert.equal(describeDistributionStatus({ ...status, lastRunAt: null, lastSuccessAt: null }).tone, "wait");
assert.deepEqual(describeDistributionStatus({ ...status, pending: 3 }), { tone: "wait", label: "有 3 条链接正在发布" });
// A failure is named, with how much is affected — not folded into "publishing".
assert.deepEqual(
  describeDistributionStatus({ ...status, pending: 3, lastError: "写入分发层失败（HTTP 403）" }),
  { tone: "wait", label: "有 3 条链接未发布：写入分发层失败（HTTP 403）" }
);

// Links still waiting to be taken down are not "everything is published".
assert.deepEqual(describeDistributionStatus({ ...status, revoking: 2 }), { tone: "wait", label: "有 2 条已重置或已删除的链接正在撤销" });
assert.deepEqual(
  describeDistributionStatus({ ...status, revoking: 2, lastError: "从分发层删除失败（HTTP 503）" }),
  { tone: "wait", label: "有 2 条旧链接未撤销：从分发层删除失败（HTTP 503）" }
);
assert.deepEqual(
  describeDistributionStatus({ ...status, pending: 1, revoking: 2, lastError: "连不上分发层" }),
  { tone: "wait", label: "有 1 条链接未发布、2 条旧链接未撤销：连不上分发层" }
);
// A pass that could not run leaves the last counts at zero; the error alone
// must be enough to stop the summary reading as healthy.
assert.deepEqual(
  describeDistributionStatus({ ...status, lastError: "对账未能执行（读取数据库出错），发布和撤销都已停下，稍后自动重试" }),
  { tone: "wait", label: "对账未能执行（读取数据库出错），发布和撤销都已停下，稍后自动重试" }
);
// Records left behind in a namespace that is no longer the configured one.
assert.equal(describeElsewhere(status), null);
assert.match(describeElsewhere({ ...status, elsewhere: 4 }) ?? "", /有 4 条发布记录属于之前配置的分发层.*不会被撤销/);
assert.equal(describeElsewhere({ ...status, configured: false, elsewhere: 4 }), null);

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
// …without promising what a reset cannot deliver: the old link goes when the
// distribution layer has dropped it, not when the button is pressed, and
// nodes already imported keep working.
assert.doesNotMatch(panel, /立即失效/);
assert.match(panel, /开始从分发层撤销旧链接。撤销通常在一分钟内完成，分发层故障或被限流时会更久；完成之前旧链接仍可使用/);
assert.match(panel, /已经导入客户端的节点不受影响，仍可继续使用/);
assert.match(panel, /const revocation = state \? describeLinkRevocation\(state\.distribution\) : null;/);
assert.match(panel, /\{link\.rotatedAt && revocation \? <div><dt>旧链接<\/dt>/);
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
assert.match(settingsModal, /const elsewhere = status \? describeElsewhere\(status\) : null;/);

console.log("admin subscription link checks passed");
