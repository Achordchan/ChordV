import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const modal = readFileSync(resolve(import.meta.dirname, "../src/features/system-settings/SupportIntegrationModal.tsx"), "utf8");
const settingsPage = readFileSync(resolve(import.meta.dirname, "../src/pages/SystemSettingsPage.tsx"), "utf8");
const api = readFileSync(resolve(import.meta.dirname, "../src/api/support-integration.ts"), "utf8");
const sharedTypes = readFileSync(resolve(import.meta.dirname, "../../../packages/shared/src/types.ts"), "utf8");

function readInterface(name: string) {
  const match = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(sharedTypes);
  assert.ok(match, `${name} should exist`);
  return match[1];
}

function testSettingsDtoNeverCarriesSecrets() {
  const dto = readInterface("AdminSupportIntegrationConfigDto");
  assert.match(dto, /hasClientSecret: boolean;/);
  assert.match(dto, /hasWebhookSecret: boolean;/);
  assert.match(dto, /webhookUrl: string;/);
  assert.doesNotMatch(dto, /\bclientSecret\b|\bwebhookSecret\b/, "后台读取的设置不能带密钥本身");
}

function testModalNeverRendersStoredSecrets() {
  // 密钥输入框只绑定本次新输入的草稿值，读取到的设置里没有密钥，也不会把草稿以外的值填进去。
  assert.doesNotMatch(modal, /config\??\.(clientSecret|webhookSecret)\b/);
  assert.match(modal, /setDraft\(\{ enabled: next\.enabled, baseUrl: next\.baseUrl \?\? "", clientId: next\.clientId \?\? "", clientSecret: "", webhookSecret: "" \}\)/,
    "每次读取或保存后，密钥草稿都要清空");
  assert.match(modal, /<PasswordInput[^>]*autoComplete="new-password"[^>]*value=\{draft\[key\]\}/);
  assert.doesNotMatch(modal, /<TextInput[^>]*value=\{draft\.(clientSecret|webhookSecret)\}/, "密钥不能用明文输入框");
  assert.match(modal, /\{hasValue \? "已设置" : "未设置"\}/);
  // 留空不提交（保持不变），清除才提交 null。
  assert.match(modal, /if \(draft\.clientSecret\.trim\(\)\) input\.clientSecret = draft\.clientSecret\.trim\(\);/);
  assert.match(modal, /if \(draft\.webhookSecret\.trim\(\)\) input\.webhookSecret = draft\.webhookSecret\.trim\(\);/);
  assert.match(modal, /\{ clientSecret: null, enabled: false \}/);
  assert.match(modal, /\{ webhookSecret: null \}/);
  // 关闭弹窗后草稿（可能含新粘贴的密钥）也要清掉。
  assert.match(modal, /if \(opened\) void load\(\); else setDraft\(emptyDraft\(\)\);/);
}

function testModalShowsWebhookUrlAndConnectionTest() {
  assert.match(modal, /<CopyButton value=\{config\.webhookUrl\}/);
  assert.match(modal, /测试连接/);
  assert.match(modal, /disabled=\{saving \|\| dirty\}/, "有未保存修改时不能测试，避免测到旧设置却以为是新设置");
  assert.match(modal, /创建工单入口：\{testResult\.launch\.message\}/);
  assert.match(modal, /未读查询：\{testResult\.unread\.message\}/);
  assert.match(api, /"\/admin\/support-integration"/);
  assert.match(api, /method: "PUT"/);
  assert.match(api, /"\/admin\/support-integration\/test"/);
}

function testSystemSettingsLinksToModal() {
  assert.match(settingsPage, /<SupportIntegrationModal opened=\{supportOpened\} onClose=\{\(\)=>setSupportOpened\(false\)\} onSaved=\{props\.onSupportIntegrationChanged\}\/>/);
  assert.match(modal, /apply\(next\);\s*onSaved\?\.\(\);/, "保存后通知刷新仪表台，旧工单只读状态随开关切换");
  assert.match(settingsPage, /<h3>工单系统接入<\/h3>/);
  assert.match(settingsPage, /onClick=\{\(\)=>setSupportOpened\(true\)\}>管理接入</);
}

testSettingsDtoNeverCarriesSecrets();
testModalNeverRendersStoredSecrets();
testModalShowsWebhookUrlAndConnectionTest();
testSystemSettingsLinksToModal();

console.log("admin support integration settings regression checks passed");
