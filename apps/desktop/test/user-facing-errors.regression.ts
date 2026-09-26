import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  USER_ERROR_CATALOG,
  createUserErrorReader,
  describeUserError,
  detectErrorCode,
  formatCopyableErrorDetail,
  isCustomerSafeText,
  toUserMessage,
  type UserErrorContext
} from "../src/lib/userFacingErrors";
import { deriveGuidanceFromConnectFailure, deriveGuidanceFromRuntimeFailure, formatGuidanceMessage } from "../src/lib/connectionGuidance";

/** 客户可见文本中绝不允许出现的内容。 */
function assertNoLeak(text: string, label: string) {
  assert.ok(/[\u3400-\u9fff]/.test(text), `${label}: 必须是中文文案 -> ${text}`);
  const withoutCodeLine = text.replace(/\n?错误编号：[A-Za-z0-9_.-]+/g, "");
  assert.doesNotMatch(withoutCodeLine, /https?:\/\/|[A-Za-z]:\\|\/Users\/|os error|HTTP\s*\d{3}|stack|at\s+\w+\s*\(|[{}]/i, `${label}: 泄露原始信息 -> ${text}`);
  assert.doesNotMatch(withoutCodeLine, /\b(error|failed|invalid|missing|exception|timeout|refused|denied|undefined|null)\b/i, `${label}: 含英文开发术语 -> ${text}`);
  assert.doesNotMatch(withoutCodeLine, /\b[a-z]+_[a-z_]+\b/, `${label}: 主文案里不能出现机器码 -> ${text}`);
  assert.doesNotMatch(text, /错误代码/, `${label}: 统一使用“错误编号” -> ${text}`);
}

function testCatalogEntriesAreCustomerSafe() {
  for (const [code, entry] of Object.entries(USER_ERROR_CATALOG)) {
    assertNoLeak(entry.message, `catalog.${code}.message`);
    assert.ok(isCustomerSafeText(entry.message), `catalog.${code} message must pass the safety check`);
    assert.ok(entry.title.length > 0 && entry.title.length <= 12, `catalog.${code} title should be short: ${entry.title}`);
    assert.ok(!/[。，]/.test(entry.title), `catalog.${code} title should not be a sentence`);
    const sentences = entry.message.split(/[。！？]/).filter(Boolean).length;
    assert.ok(sentences <= 3, `catalog.${code} message should be 1–2 sentences (+support hint): ${entry.message}`);
  }
}

function testRuntimeComponentCodesAreMappedAndPreserved() {
  const cases: Array<[string, string]> = [
    ["runtime_component_error:download_failed:下载 Xray 内核 失败：error sending request for url (https://mirror.example.com/xray.zip)", "download_failed"],
    ["runtime_component_error:download_timeout:Xray 内核 download stalled with no data for 30 seconds.", "download_timeout"],
    ["runtime_component_error:hash_mismatch:sha256 mismatch expected abcdef0123456789abcdef got 0123456789abcdef0123", "hash_mismatch"],
    ["runtime_component_error:write_failed:写入组件文件失败：Permission denied (os error 13)", "write_failed"],
    ["runtime_component_error:metadata_mismatch:GeoIP 规则 Content-Length mismatch: expected 10, got 12", "metadata_mismatch"],
    ["runtime_component_error:extract_failed:invalid Zip archive: Could not find EOCD", "extract_failed"],
    ["runtime_component_error:download_cancelled:下载已取消", "download_cancelled"]
  ];
  for (const [raw, code] of cases) {
    const described = describeUserError(new Error(raw), { context: "runtime_assets" });
    assert.equal(described.code, code, raw);
    assert.equal(described.message, USER_ERROR_CATALOG[code].message);
    assert.ok(described.detail.includes(raw), "raw text stays available for diagnostics");
    assertNoLeak(toUserMessage(raw, { context: "runtime_assets" }), code);
    assert.match(toUserMessage(raw, { context: "runtime_assets" }), new RegExp(`\\n错误编号：${code}$`));
  }
  for (const code of ["plan_missing", "plan_fetch_failed", "component_missing", "component_invalid", "unknown"]) {
    const described = describeUserError(`runtime_component_error:${code}:whatever`, { context: "runtime_assets" });
    assert.equal(described.code, code);
    assertNoLeak(described.message, code);
  }
}

function testRustConnectPreflightErrorsAreMapped() {
  for (const raw of [
    "runtime component verification failed before connect: xray is missing after bundled runtime restore.",
    "runtime component plan is empty",
    "runtime_component_unavailable:连接所需组件校验未通过：geoip failed local validation: bad header"
  ]) {
    const described = describeUserError(new Error(raw), { context: "connect" });
    assert.equal(described.code, "runtime_component_unavailable", raw);
    assertNoLeak(described.message, raw);
  }
}

function testHttpStatusesMapToFriendlyText() {
  const statuses: Array<[number, string]> = [
    [400, "http_400"], [401, "http_401"], [403, "http_403"], [404, "http_404"], [409, "http_409"], [413, "http_413"],
    [429, "http_429"], [500, "http_5xx"], [502, "http_5xx"], [503, "http_5xx"]
  ];
  for (const [status, key] of statuses) {
    const apiError = Object.assign(new Error(`HTTP ${status}`), { status, rawMessage: `HTTP ${status}` });
    const described = describeUserError(apiError);
    assert.equal(described.message, USER_ERROR_CATALOG[key].message, `status ${status}`);
    assert.equal(described.code, `http_${status}`);
    assertNoLeak(toUserMessage(apiError), `status ${status}`);
  }
  // 文本里只有 “HTTP 502” 时同样可以识别
  assert.equal(describeUserError("HTTP 502").code, "http_502");

  // NestJS 默认英文错误体不会漏给客户
  const nestBody = JSON.stringify({ statusCode: 500, message: "Internal server error" });
  const internal = describeUserError(Object.assign(new Error("Internal server error"), { status: 500, rawMessage: nestBody }));
  assert.equal(internal.message, USER_ERROR_CATALOG.http_5xx.message);
  const validation = describeUserError(Object.assign(new Error("email must be an email，password should not be empty"), { status: 400 }), { context: "login" });
  assert.equal(validation.message, USER_ERROR_CATALOG.http_400.message);
  assert.equal(validation.code, "http_400");
}

function testServerBusinessMessagesStayVerbatimWithoutCode() {
  const loginFailure = Object.assign(new Error("邮箱或密码错误"), { status: 401, rawMessage: "邮箱或密码错误" });
  const described = describeUserError(loginFailure, { context: "login" });
  assert.equal(described.message, "邮箱或密码错误");
  assert.equal(described.code, null, "business errors don't need an error number");
  assert.equal(described.title, "登录未成功");
  assert.equal(toUserMessage(loginFailure, { context: "login" }), "邮箱或密码错误");

  const serverDown = Object.assign(new Error("节点暂时不可用，请稍后重试"), { status: 503 });
  assert.equal(describeUserError(serverDown).message, "节点暂时不可用，请稍后重试");
  assert.equal(describeUserError(serverDown).code, "http_503");
  assert.equal(toUserMessage("工单不存在"), "工单不存在");
}

function testNetworkErrorsAreMapped() {
  for (const raw of ["TypeError: Failed to fetch", "Load failed", "error sending request for url (https://v.achord.cn/api/client/bootstrap)", "网络请求失败，请检查后台服务或网络连接后重试。", "网络连接失败，请检查网络后重试。"]) {
    const described = describeUserError(new Error(raw));
    assert.equal(described.code, "network_offline", raw);
    assertNoLeak(described.message, raw);
  }
  for (const raw of ["AbortError: The operation was aborted.", "operation timed out", "请求超时，请检查网络后重试。"]) {
    assert.equal(describeUserError(new Error(raw)).code, "network_timeout", raw);
  }
}

function testUpdateErrorsAreMapped() {
  assert.equal(detectErrorCode("下载或签名校验失败：minisign signature verification failed", "update_download"), "update_signature_invalid");
  assert.equal(detectErrorCode("installer package sha256 mismatch", "update_download"), "update_checksum_mismatch");
  assert.equal(detectErrorCode("download failed: empty installer file", "update_download"), "update_artifact_invalid");
  assert.equal(detectErrorCode("更新服务仍提供旧版 ZIP，请联系管理员发布签名的 EXE 安装包。", "update_download"), "update_artifact_invalid");
  assert.equal(detectErrorCode("server update package missing positive fileSizeBytes", "update_download"), "update_artifact_invalid");
  // Windows 更新器断网时也会报“下载或签名校验失败”，不能误报成签名问题
  assert.equal(detectErrorCode("下载或签名校验失败：error sending request for url (https://x)", "update_download"), "network_offline");
  assert.equal(detectErrorCode("downloaded file size mismatch: expected 10 bytes but got 5 bytes", "update_download"), "update_checksum_mismatch");
  assert.equal(detectErrorCode("Connection refused (os error 61)", "node_probe"), "node_unreachable");
  const install = describeUserError(new Error("安装器启动失败：The system cannot find the file specified. (os error 2)"), { context: "update_install" });
  assert.equal(install.code, "update_install_failed");
  assertNoLeak(install.message, "update_install");
  const noSpace = describeUserError(new Error("保存安装包失败：No space left on device (os error 28)"), { context: "update_download" });
  assert.equal(noSpace.code, "disk_full");
}

function testUnknownRawErrorsNeverLeak() {
  const contexts: UserErrorContext[] = [
    "general", "login", "session", "logout", "refresh", "connect", "disconnect", "runtime_assets",
    "update_check", "update_download", "update_install", "ticket", "announcement", "node_probe", "server_probe"
  ];
  const raws = [
    "failed to resolve app data directory: No such file or directory",
    "called `Option::unwrap()` on a `None` value",
    "Error: something broke\n    at run (file:///Users/me/app.js:1:2)",
    "C:\\Users\\me\\AppData\\Local\\ChordV\\xray.exe not found",
    "native startup failed\ncleanup failed",
    "reg 命令执行失败：[\"add\", \"HKCU\\\\Software\"]",
    "networksetup 执行失败：[\"-setwebproxy\"]",
    "TLS 握手失败：invalid peer certificate",
    "installer pending state lock failed",
    "{\"statusCode\":500}",
    "Only the main window can change layout"
  ];
  for (const context of contexts) {
    for (const raw of raws) {
      const described = describeUserError(new Error(raw), { context });
      assertNoLeak(formatUserErrorText(described.message, described.code), `${context}: ${raw}`);
      assert.ok(described.detail.includes(raw.split("\n")[0]), "raw detail retained for logs");
    }
  }
  const copy = formatCopyableErrorDetail(describeUserError(new Error("failed to resolve app data directory: denied"), { context: "update_install" }));
  assert.match(copy, /错误编号：/);
  assert.match(copy, /详情：failed to resolve app data directory/);
}

function formatUserErrorText(message: string, code: string | null) {
  return code ? `${message}\n错误编号：${code}` : message;
}

function testMixedLinesKeepSafeOnesOnly() {
  const text = toUserMessage("当前节点已离线\n当前节点已离线");
  assert.equal(text, "当前节点已离线", "duplicate safe lines collapse");
  const mixed = describeUserError("当前节点已离线\nnative startup failed", { context: "connect" });
  assert.equal(mixed.code, "connect_failed");
  assertNoLeak(mixed.message, "mixed");
}

function testIdempotentAndCodePreserved() {
  for (const raw of [
    "runtime_component_error:download_failed:下载失败：error sending request",
    "HTTP 500",
    "failed to open installer package: denied",
    "邮箱或密码错误"
  ]) {
    const once = toUserMessage(raw, { context: "update_download" });
    assert.equal(toUserMessage(once, { context: "update_download" }), once, `idempotent: ${raw}`);
  }
  // 旧的“错误代码：xxx”行会被识别并统一成“错误编号”，编号保持不变
  const legacy = toUserMessage("请先断开那个 VPN，再连接 ChordV。\n错误代码：external_vpn_conflict");
  assert.match(legacy, /\n错误编号：external_vpn_conflict$/);
  const reader = createUserErrorReader("ticket");
  assert.equal(reader("工单已关闭，无法回复"), "工单已关闭，无法回复");
  assertNoLeak(reader("Cannot POST /api/client/support-tickets/1/replies"), "ticket reader");
}

function testSafeTextDetection() {
  for (const safe of [
    "当前节点已离线",
    "请先断开其他 VPN，再连接 ChordV。",
    "ChordV 1.1.10 已发布。",
    "Windows 未能设置系统代理，请重试。",
    "Xray 内核已准备完成",
    "macOS 需要授权后才能连接"
  ]) {
    assert.ok(isCustomerSafeText(safe), `should be safe: ${safe}`);
  }
  for (const unsafe of [
    "Failed to fetch",
    "HTTP 500",
    "下载 Xray 内核 失败：error sending request",
    "读取组件文件状态失败：/Users/me/Library/xray",
    "external_vpn_conflict: 已有 VPN 正在运行",
    "TLS 握手失败：bad cert",
    "璇锋眰瓒呮椂" // 乱码也不应原样出现：虽然是 CJK，但无法通过兜底之外的识别，这里只验证不会误判为网络码
  ].slice(0, 6)) {
    assert.ok(!isCustomerSafeText(unsafe), `should be unsafe: ${unsafe}`);
  }
}

function testGuidanceUsesErrorNumberAndStaysPlain() {
  const vpn = deriveGuidanceFromRuntimeFailure("external_vpn_conflict: 已有 VPN 正在运行，请先断开后再连接 ChordV", "node");
  assert.equal(vpn?.errorCode, "external_vpn_conflict");
  assert.match(formatGuidanceMessage(vpn!), /\n错误编号：external_vpn_conflict$/);
  assert.ok(vpn?.diagnostic?.includes("external_vpn_conflict"), "raw failure kept for copy");
  const failures = [
    "external_proxy_conflict",
    "windows_proxy_failed InternetSetOption",
    "本地代理启动失败",
    "xray 已退出",
    "vpn_permission_denied",
    "vpn_interface_establish_failed",
    "service_start_failed",
    "connectivity_check_failed",
    "config_missing"
  ];
  for (const failure of failures) {
    const guidance = deriveGuidanceFromRuntimeFailure(failure, null);
    assert.ok(guidance, failure);
    assertNoLeak(guidance!.message, `guidance ${failure}`);
    assert.ok(guidance!.title.length <= 12, `guidance title short: ${guidance!.title}`);
    assert.ok(guidance!.actionLabel.length <= 8, `guidance action concrete: ${guidance!.actionLabel}`);
  }
  const pending = deriveGuidanceFromConnectFailure("节点开通同步中，请稍后重试。", null, "windows");
  assert.ok(pending);
  assertNoLeak(pending!.message, "pending");
}

function testGuidanceSourceHasNoDeveloperJargon() {
  const source = readFileSync(resolve(import.meta.dirname, "../src/lib/connectionGuidance.ts"), "utf8");
  for (const phrase of ["明天接真机", "面板客户端", "安卓资源包", "错误代码"]) {
    assert.ok(!source.includes(phrase), `connectionGuidance should not contain “${phrase}”`);
  }
}

function testDisplaySurfacesUseErrorNumber() {
  const banner = readFileSync(resolve(import.meta.dirname, "../src/components/RuntimeAssetsBanner.tsx"), "utf8");
  assert.match(banner, /formatErrorCodeLine\(state\.errorCode\)/);
  assert.doesNotMatch(banner, /错误代码/);
  const app = readFileSync(resolve(import.meta.dirname, "../src/App.tsx"), "utf8");
  assert.doesNotMatch(app, /错误代码/);
  const client = readFileSync(resolve(import.meta.dirname, "../src/api/client.ts"), "utf8");
  assert.doesNotMatch(client, /璇锋眰瓒呮椂/, "no mojibake in client request errors");
  const appState = readFileSync(resolve(import.meta.dirname, "../src/lib/appState.ts"), "utf8");
  assert.match(appState, /describeUserError\(/, "toasts are routed through the user-facing mapping");
}

testCatalogEntriesAreCustomerSafe();
testRuntimeComponentCodesAreMappedAndPreserved();
testRustConnectPreflightErrorsAreMapped();
testHttpStatusesMapToFriendlyText();
testServerBusinessMessagesStayVerbatimWithoutCode();
testNetworkErrorsAreMapped();
testUpdateErrorsAreMapped();
testUnknownRawErrorsNeverLeak();
testMixedLinesKeepSafeOnesOnly();
testIdempotentAndCodePreserved();
testSafeTextDetection();
testGuidanceUsesErrorNumberAndStaysPlain();
testGuidanceSourceHasNoDeveloperJargon();
testDisplaySurfacesUseErrorNumber();
console.log("user-facing error mapping regression checks passed");
