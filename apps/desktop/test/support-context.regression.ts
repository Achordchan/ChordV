import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  clearRecentErrorCodes,
  normalizeRecentErrorCode,
  readRecentErrorCodes,
  recordRecentErrorCode,
  RECENT_ERROR_CODE_LIMIT
} from "../src/lib/recentErrorCodes";
import {
  buildSupportLaunchContext,
  cleanLocale,
  cleanOsLabel,
  collectSupportLaunchContext,
  describeAppVersion,
  describeComponents,
  describeLineStatus,
  describeTimeZone,
  describeUpdateChannel,
  mapConnectionState,
  SUPPORT_CONTEXT_TIMEOUT_MS,
  type SupportContextSnapshot
} from "../src/lib/supportContext";

/**
 * 打开工单时附带给客服的诊断信息（客户端部分）：输出结构、不含敏感数据、最近错误只有编号、取不到时显示“未知”、
 * 收集有时间上限，以及这些代码确实接在打开工单和错误提示的路径上。
 */

// Windows 检出时可能是 CRLF 换行，统一成 LF 再匹配。
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const SECRET_NODE = { serverHost: "203.0.113.9", serverPort: 443, uuid: "11111111-2222-3333-4444-555555555555", realityPublicKey: "pk_secret" };

function snapshot(overrides: Partial<SupportContextSnapshot> = {}): SupportContextSnapshot {
  return {
    appVersion: "1.1.11",
    appBuild: 21,
    pendingUpdate: { version: "1.1.12", ready: true },
    updateChannel: "stable",
    autoDownload: true,
    runtimeStatus: "connected",
    runtimeErrorCode: null,
    sessionId: "sess_abc",
    serverProbe: { status: "healthy", elapsedMs: 180 },
    cachedComponents: { xrayVersion: "25.8.3", geoVersion: "2026-09-20" },
    ...overrides
  };
}

function testRecentErrorRing() {
  clearRecentErrorCodes();
  const t0 = Date.parse("2026-09-28T02:00:00.000Z");
  recordRecentErrorCode("http_5xx", t0);
  recordRecentErrorCode("http_5xx", t0 + 10_000);
  assert.equal(readRecentErrorCodes().length, 1, "同一编号 1 分钟内反复出现只更新时间");
  assert.equal(readRecentErrorCodes()[0].at, new Date(t0 + 10_000).toISOString());
  recordRecentErrorCode("RUNTIME_EXITED", t0 + 20_000);
  recordRecentErrorCode("network_timeout", t0 + 30_000);
  recordRecentErrorCode("http_5xx", t0 + 200_000);
  const entries = readRecentErrorCodes();
  assert.equal(entries.length, RECENT_ERROR_CODE_LIMIT, "最多 3 条");
  assert.deepEqual(entries.map((entry) => entry.code), ["http_5xx", "network_timeout", "runtime_exited"], "新的在前，编号统一小写");
  for (const raw of ["连接失败：/Users/me/xray", "Error: ECONNREFUSED 1.2.3.4:443", "https://sub.example.com", "", null, 42, "a".repeat(49), "bad code"]) {
    assert.equal(normalizeRecentErrorCode(raw), null, `${String(raw)} 不是错误编号`);
    recordRecentErrorCode(raw, t0 + 300_000);
  }
  assert.deepEqual(readRecentErrorCodes().map((entry) => entry.code), ["http_5xx", "network_timeout", "runtime_exited"], "原始文本一律不记录");
  for (const entry of readRecentErrorCodes()) {
    assert.deepEqual(Object.keys(entry), ["code", "at"], "只有编号和时间");
  }
  clearRecentErrorCodes();
  assert.deepEqual(readRecentErrorCodes(), []);
}

function testFieldFormatting() {
  assert.equal(describeAppVersion(snapshot()), "1.1.11（构建 21） · 待安装 1.1.12");
  assert.equal(describeAppVersion(snapshot({ pendingUpdate: { version: "1.1.12", ready: false } })), "1.1.11（构建 21） · 有新版本 1.1.12");
  assert.equal(describeAppVersion(snapshot({ appBuild: null, pendingUpdate: null })), "1.1.11");
  assert.equal(describeAppVersion(snapshot({ appVersion: "../../etc" })), "未知");
  assert.equal(describeUpdateChannel(snapshot()), "正式版 · 自动下载开");
  assert.equal(describeUpdateChannel(snapshot({ updateChannel: "beta", autoDownload: false })), "测试版 · 自动下载关");
  assert.equal(mapConnectionState("connected"), "connected");
  assert.equal(mapConnectionState("starting"), "connecting");
  assert.equal(mapConnectionState("error"), "error");
  assert.equal(mapConnectionState("idle"), "disconnected");
  assert.equal(describeLineStatus({ status: "healthy", elapsedMs: 180.4 }), "正常（180 ms）");
  assert.equal(describeLineStatus({ status: "healthy", elapsedMs: null }), "正常");
  assert.equal(describeLineStatus({ status: "failed", elapsedMs: null }), "无法连接服务器");
  assert.equal(describeLineStatus({ status: "idle", elapsedMs: null }), "尚未检查");
  assert.equal(describeComponents({ xrayVersion: "25.8.3", geoVersion: "2026-09-20", complete: true }, { xrayVersion: null, geoVersion: null }), "Xray 25.8.3 · 规则库 2026-09-20 · 完整");
  assert.equal(describeComponents({ xrayVersion: null, geoVersion: null, complete: false }, { xrayVersion: "25.8.3", geoVersion: "已安装" }), "Xray 25.8.3 · 规则库 已安装 · 不完整");
  assert.equal(describeComponents(null, { xrayVersion: "/Applications/ChordV.app/xray", geoVersion: null }), "Xray 未知 · 规则库 未知 · 完整性未知", "路径之类的异常值不带出去");
  assert.equal(describeTimeZone("Asia/Shanghai", 480), "Asia/Shanghai（UTC+8）");
  assert.equal(describeTimeZone("Asia/Kolkata", 330), "Asia/Kolkata（UTC+5:30）");
  assert.equal(describeTimeZone("America/New_York", -240), "America/New_York（UTC-4）");
  assert.equal(describeTimeZone(null, 0), "UTC+0");
  assert.equal(cleanLocale("zh-CN"), "zh-CN");
  assert.equal(cleanLocale("zh-Hans-CN"), "zh-Hans-CN");
  assert.equal(cleanLocale("en-US-u-ca-gregory"), null);
  assert.equal(cleanOsLabel("macOS 15.1（24B83，arm64）"), "macOS 15.1（24B83，arm64）");
  assert.equal(cleanOsLabel("Windows 11 23H2（22631.4317，x64）"), "Windows 11 23H2（22631.4317，x64）");
  assert.equal(cleanOsLabel("C:\\Windows\\System32"), null);
  assert.equal(cleanOsLabel("/usr/bin/sw_vers"), null);
}

function testContextShapeAndPrivacy() {
  const context = buildSupportLaunchContext({
    snapshot: snapshot({ runtimeErrorCode: "should_not_be_sent_when_connected" }),
    osLabel: "macOS 15.1（24B83，arm64）",
    components: { xrayVersion: "25.8.3", geoVersion: "2026-09-20", complete: true },
    recentErrors: [{ code: "runtime_exited", at: "2026-09-28T02:21:00.000Z" }, { code: "http_5xx", at: "2026-09-28T02:18:00.000Z" }],
    timeZone: "Asia/Shanghai",
    offsetMinutes: 480,
    locale: "zh-CN"
  });
  assert.deepEqual(context, {
    appVersion: "1.1.11（构建 21） · 待安装 1.1.12",
    os: "macOS 15.1（24B83，arm64）",
    timezone: "Asia/Shanghai（UTC+8）",
    locale: "zh-CN",
    updateChannel: "正式版 · 自动下载开",
    connectionState: "connected",
    lineStatus: "正常（180 ms）",
    recentErrors: [{ code: "runtime_exited", at: "2026-09-28T02:21:00.000Z" }, { code: "http_5xx", at: "2026-09-28T02:18:00.000Z" }],
    components: "Xray 25.8.3 · 规则库 2026-09-20 · 完整",
    sessionId: "sess_abc"
  });
  // 后台限制：整个 context 不超过 4 KB。
  assert.ok(new TextEncoder().encode(JSON.stringify(context)).length < 4096);

  const failed = buildSupportLaunchContext({
    snapshot: snapshot({ runtimeStatus: "error", runtimeErrorCode: "runtime_exited", sessionId: "sess_abc", serverProbe: { status: "failed", elapsedMs: null } }),
    osLabel: null,
    components: null,
    recentErrors: [{ code: "bad code with text", at: "2026-09-28T02:21:00.000Z" }, { code: "ok_code", at: "not a date" }],
    timeZone: null,
    offsetMinutes: 480,
    locale: "en-US-u-ca-gregory"
  });
  assert.equal(failed.connectionState, "error");
  assert.equal(failed.connectionErrorCode, "runtime_exited");
  assert.equal(failed.sessionId, undefined, "未连接时不带会话 ID");
  assert.equal(failed.os, "未知", "取不到系统版本显示未知");
  assert.equal(failed.components, "Xray 25.8.3 · 规则库 2026-09-20 · 完整性未知", "组件信息超时时用已缓存的版本");
  assert.equal(failed.lineStatus, "无法连接服务器");
  assert.deepEqual(failed.recentErrors, [], "不合格的错误条目丢弃");
  assert.equal("locale" in failed, false, "无效的语言标签不发送");
  const errorWithText = buildSupportLaunchContext({
    snapshot: snapshot({ runtimeStatus: "error", runtimeErrorCode: "内核已退出：/Users/me/xray" }),
    osLabel: null, components: null, recentErrors: [], timeZone: null, offsetMinutes: 0, locale: null
  });
  assert.equal(errorWithText.connectionErrorCode, undefined, "原始错误文本不作为错误编号发送");
}

async function testCollectorIsBoundedAndNeverThrows() {
  clearRecentErrorCodes();
  recordRecentErrorCode("http_5xx", Date.parse("2026-09-28T02:18:00.000Z"));
  const fast = await collectSupportLaunchContext({
    snapshot: () => snapshot(),
    loadOsLabel: async () => "Windows 11 23H2（22631.4317，x64）",
    loadComponents: async () => ({ xrayVersion: "25.8.3", geoVersion: "2026-09-20", complete: true }),
    readRecentErrors: readRecentErrorCodes,
    readTimeZone: () => "Asia/Shanghai",
    readLocale: () => "zh-CN",
    now: () => new Date("2026-09-28T02:30:00.000Z")
  });
  assert.equal(fast?.os, "Windows 11 23H2（22631.4317，x64）");
  assert.deepEqual(fast?.recentErrors, [{ code: "http_5xx", at: "2026-09-28T02:18:00.000Z" }]);

  // 系统版本、组件信息很慢或出错：按时间上限返回，对应字段为“未知”。
  const started = Date.now();
  const slow = await collectSupportLaunchContext({
    snapshot: () => snapshot(),
    loadOsLabel: () => new Promise((resolve) => setTimeout(() => resolve("macOS 15.1"), 5_000).unref()),
    loadComponents: async () => {
      throw new Error("ipc failed");
    },
    readRecentErrors: () => {
      throw new Error("ring broke");
    },
    readTimeZone: () => "Asia/Shanghai",
    readLocale: () => "zh-CN"
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 300, `收集必须在 300 毫秒内完成（实际 ${elapsed} 毫秒）`);
  assert.ok(SUPPORT_CONTEXT_TIMEOUT_MS < 300);
  assert.equal(slow?.os, "未知");
  assert.equal(slow?.components, "Xray 25.8.3 · 规则库 2026-09-20 · 完整性未知");
  assert.deepEqual(slow?.recentErrors, []);

  // 快照本身取不到（例如还没渲染到）：整体返回 null，打开工单时不附带。
  assert.equal(await collectSupportLaunchContext({
    snapshot: () => {
      throw new Error("not ready");
    },
    loadOsLabel: async () => null,
    loadComponents: async () => null,
    readRecentErrors: () => []
  }), null);

  // 同步抛错的加载函数也不影响。
  const syncThrow = await collectSupportLaunchContext({
    snapshot: () => snapshot(),
    loadOsLabel: () => {
      throw new Error("sync");
    },
    loadComponents: async () => null,
    readRecentErrors: () => []
  });
  assert.equal(syncThrow?.os, "未知");
  clearRecentErrorCodes();
}

function testNoForbiddenDataInSources() {
  // 收集器只从固定来源拼接：源码里不能读取令牌、节点地址、订阅地址、日志或文件路径。
  const collector = read("../src/lib/supportContext.ts");
  const sources = read("../src/lib/supportContextSources.ts");
  for (const [name, text] of [["supportContext.ts", collector], ["supportContextSources.ts", sources]] as const) {
    assert.doesNotMatch(text, /accessToken|refreshToken|serverHost|serverPort|uuid|realityPublicKey|shortId|subscriptionUrl|lastError|runtimeLog|errorMessage|\.path\b/, `${name} 不读取敏感字段`);
  }
  assert.doesNotMatch(sources, /\.path\b|configPath|logPath/, "组件信息只用版本和是否存在");
  // 快照在 App 里组装：只取这些字段。
  const app = read("../src/App.tsx");
  const snapshotBlock = /supportContextSnapshotRef\.current = \(\) => \{([\s\S]*?)\n  \};/.exec(app)?.[1] ?? "";
  assert.ok(snapshotBlock, "App 组装诊断信息快照");
  assert.doesNotMatch(snapshotBlock, /accessToken|serverHost|serverPort|uuid|lastError|errorMessage|runtimeLog|subscription\./);
  assert.match(snapshotBlock, /sessionId: runtime\?\.sessionId/);
  const fakeSnapshot = snapshot();
  assert.doesNotMatch(JSON.stringify(buildSupportLaunchContext({
    snapshot: fakeSnapshot, osLabel: null, components: null, recentErrors: [], timeZone: null, offsetMinutes: 0, locale: null
  })), new RegExp(Object.values(SECRET_NODE).join("|")));
}

function testWiring() {
  const app = read("../src/App.tsx");
  assert.match(app, /collectContext: \(\) =>\n\s+collectSupportLaunchContext\(\{/, "工单入口附带诊断信息");
  assert.match(app, /loadOsLabel: loadDesktopOsLabel/);
  assert.match(app, /loadComponents: loadSupportComponentsInfo/);
  assert.match(app, /readRecentErrors: readRecentErrorCodes/);
  assert.match(app, /recordRecentErrorCode\(connectionGuidance\.errorCode \?\? connectionGuidance\.code\)/, "连接指引（可能只弹对话框）的编号记入最近错误");
  const toast = read("../src/components/Toast.tsx");
  assert.match(toast, /if \(toast\.code && \(toast\.tone === "danger" \|\| toast\.tone === "warning"\)\) recordRecentErrorCode\(toast\.code\);/, "错误提示条的编号记入最近错误");
  const hook = read("../src/hooks/useSupportPortal.ts");
  assert.match(hook, /launchSupportPortal\(accessToken, context\)/);
  assert.match(hook, /clearRecentErrorCodes\(\)/);
  const runtime = read("../src/lib/runtime.ts");
  assert.match(runtime, /invoke<string \| null>\("desktop_os_label"\)/);
  const permissions = read("../src-tauri/permissions/main-window.toml");
  assert.match(permissions, /"desktop_os_label"/, "新命令只授权给主窗口");
}

async function main() {
  testRecentErrorRing();
  testFieldFormatting();
  testContextShapeAndPrivacy();
  await testCollectorIsBoundedAndNeverThrows();
  testNoForbiddenDataInSources();
  testWiring();
  console.log("support context regression checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
