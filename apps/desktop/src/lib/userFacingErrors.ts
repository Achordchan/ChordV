/**
 * 面向客户的错误文案统一出口。
 *
 * 规则：
 * - 客户看到的主文案一律是礼貌、直白的中文：发生了什么 + 下一步怎么做；
 * - 不向客户展示英文原文、堆栈、HTTP 状态码、内部标识、文件路径或开发术语；
 * - 机器错误码保持稳定，只作为次要的「错误编号」展示，方便客服定位；
 * - 无法识别的原始错误统一给出通用友好提示，原文只保留在 detail（日志 / 复制诊断）里。
 *
 * 本文件必须保持纯函数、无运行时依赖，便于回归测试直接加载。
 */

export type UserErrorContext =
  | "general"
  | "login"
  | "session"
  | "logout"
  | "refresh"
  | "connect"
  | "disconnect"
  | "local_stop"
  | "runtime_assets"
  | "update_check"
  | "update_download"
  | "update_install"
  | "ticket"
  | "announcement"
  | "node_probe"
  | "server_probe"
  | "local_files";

export type UserFacingError = {
  /** 简短标题，适合作为弹窗 / 通知标题。 */
  title: string;
  /** 1–2 句中文说明：发生了什么、下一步怎么做。 */
  message: string;
  /** 具体的操作按钮文案；无合适操作时为 null。 */
  action: string | null;
  /** 稳定的机器错误码，只作为「错误编号」次要展示；业务提示没有编号时为 null。 */
  code: string | null;
  /** 原始错误文本，仅用于日志、诊断和复制，不作为主文案展示。 */
  detail: string;
  /** 是否命中了已知错误（false 表示使用了通用兜底文案）。 */
  known: boolean;
};

type CatalogEntry = { title: string; message: string; action: string | null };

export const ERROR_CODE_LABEL = "错误编号";

const CONTACT_SUPPORT = "如果问题持续出现，请联系客服并提供错误编号。";

/** 已知错误码 → 客户文案。错误码本身保持稳定，客服依赖它定位问题。 */
export const USER_ERROR_CATALOG: Record<string, CatalogEntry> = {
  // 网络
  network_offline: {
    title: "网络连接异常",
    message: "暂时无法连接到 ChordV 服务，请检查网络后重试。",
    action: "重试"
  },
  network_timeout: {
    title: "请求超时",
    message: "服务器响应超时，请检查网络后重试。",
    action: "重试"
  },

  // HTTP 状态
  http_400: {
    title: "提交的信息有误",
    message: "提交的信息格式不正确，请检查后重试。",
    action: "返回修改"
  },
  http_401: {
    title: "登录已失效",
    message: "登录状态已失效，请重新登录。",
    action: "重新登录"
  },
  http_403: {
    title: "暂无权限",
    message: "当前账号暂时无法进行此操作，如有疑问请联系客服。",
    action: "我知道了"
  },
  http_404: {
    title: "内容不存在",
    message: "请求的内容不存在或已被移除，请刷新后重试。",
    action: "刷新"
  },
  http_409: {
    title: "请求处理中",
    message: "上一次请求仍在处理中或状态已变化，请稍后重试。",
    action: "稍后重试"
  },
  http_413: {
    title: "文件过大",
    message: "上传的文件过大，请压缩或更换文件后重试。",
    action: "重新选择"
  },
  http_429: {
    title: "操作过于频繁",
    message: "操作过于频繁，请稍等片刻再试。",
    action: "稍后重试"
  },
  http_5xx: {
    title: "服务暂时不可用",
    message: `服务器暂时繁忙，请稍后重试。${CONTACT_SUPPORT}`,
    action: "稍后重试"
  },

  // 必要组件下载（与 RuntimeDownloadFailureReason / Rust runtime_component_error 前缀保持一致）
  plan_missing: {
    title: "组件暂不可用",
    message: `暂时无法获取连接所需组件，请稍后点击“重新下载”。${CONTACT_SUPPORT}`,
    action: "重新下载"
  },
  plan_fetch_failed: {
    title: "组件信息获取失败",
    message: "暂时无法获取组件信息，请检查网络后点击“重新下载”。",
    action: "重新下载"
  },
  component_missing: {
    title: "组件缺失",
    message: "连接所需组件缺失，请点击“重新下载”。",
    action: "重新下载"
  },
  component_invalid: {
    title: "组件已损坏",
    message: "连接所需组件已损坏，请点击“重新下载”。",
    action: "重新下载"
  },
  download_failed: {
    title: "组件下载失败",
    message: "组件没有下载成功，请检查网络后点击“重新下载”。",
    action: "重新下载"
  },
  download_timeout: {
    title: "组件下载超时",
    message: "组件下载长时间没有响应，请检查网络后点击“重新下载”。",
    action: "重新下载"
  },
  download_cancelled: {
    title: "下载已取消",
    message: "下载已取消，需要时可点击“重新下载”。",
    action: "重新下载"
  },
  extract_failed: {
    title: "组件解压失败",
    message: "组件文件没有解压成功，请点击“重新下载”。",
    action: "重新下载"
  },
  write_failed: {
    title: "组件保存失败",
    message: "组件无法保存到本机，请确认磁盘空间充足后点击“重新下载”。",
    action: "重新下载"
  },
  hash_mismatch: {
    title: "组件校验未通过",
    message: "下载的组件未通过完整性校验，请点击“重新下载”。",
    action: "重新下载"
  },
  metadata_invalid: {
    title: "组件校验未通过",
    message: `组件信息校验未通过，请点击“重新下载”。${CONTACT_SUPPORT}`,
    action: "重新下载"
  },
  metadata_mismatch: {
    title: "组件校验未通过",
    message: "下载的组件大小与预期不一致，请点击“重新下载”。",
    action: "重新下载"
  },
  content_invalid: {
    title: "组件校验未通过",
    message: "下载的组件内容无效，请点击“重新下载”。",
    action: "重新下载"
  },
  runtime_component_unavailable: {
    title: "连接所需组件不完整",
    message: "连接所需组件不完整或已损坏，请在“更新中心”重新下载组件后再连接。",
    action: "打开更新中心"
  },

  // 本机运行时（与 connectionGuidance 的 reasonCode 一致）
  external_vpn_conflict: {
    title: "检测到其他 VPN",
    message: "系统中已有其他 VPN 处于连接状态，请先断开它，再连接 ChordV。",
    action: "重试连接"
  },
  external_proxy_conflict: {
    title: "检测到其他代理软件",
    message: "系统代理正被其他应用占用，请先关闭该代理软件，再连接 ChordV。",
    action: "重试连接"
  },
  windows_proxy_failed: {
    title: "系统代理设置失败",
    message: "ChordV 未能设置系统代理，请检查安全软件是否拦截后重新连接。",
    action: "重新连接"
  },
  windows_local_proxy_failed: {
    title: "本地代理启动失败",
    message: `本地代理没有成功启动，请重新连接。${CONTACT_SUPPORT}`,
    action: "重新连接"
  },
  runtime_exited: {
    title: "连接意外中断",
    message: `连接服务意外停止，请重新连接。${CONTACT_SUPPORT}`,
    action: "重新连接"
  },

  // 客户端更新
  update_signature_invalid: {
    title: "更新包校验未通过",
    message: "为保证安全，未通过签名校验的更新包不会被安装。请重新下载，或前往官网下载最新版本。",
    action: "重新下载"
  },
  update_checksum_mismatch: {
    title: "更新包不完整",
    message: "更新包可能没有完整下载，请重新下载。",
    action: "重新下载"
  },
  update_artifact_invalid: {
    title: "更新包暂不可用",
    message: `当前版本的更新包暂时不可用，请稍后再试，或前往官网下载最新版本。${CONTACT_SUPPORT}`,
    action: "稍后重试"
  },
  update_install_failed: {
    title: "安装未能启动",
    message: "更新安装没有成功启动，请重试；如仍失败，请前往官网下载最新安装包。",
    action: "重试安装"
  },

  // 本机系统
  disk_full: {
    title: "磁盘空间不足",
    message: "本机磁盘空间不足，请清理后重试。",
    action: "重试"
  },
  permission_denied: {
    title: "系统拒绝了操作",
    message: "系统拒绝了 ChordV 的操作，请检查安全软件是否拦截，或重新打开 ChordV 后重试。",
    action: "重试"
  },
  node_unreachable: {
    title: "节点无法连接",
    message: "当前网络无法连接到该节点，请稍后重新测速或切换其他节点。",
    action: "重新测速"
  },
  node_provisioning_pending: {
    title: "节点开通同步中",
    message: "节点正在开通，请稍后重试。",
    action: "稍后重试"
  }
};

/** 无法识别时按场景给出的通用兜底文案。 */
const CONTEXT_FALLBACK: Record<UserErrorContext, CatalogEntry & { code: string | null }> = {
  general: {
    code: null,
    title: "操作未完成",
    message: "操作没有成功完成，请稍后重试。如果问题持续出现，请联系客服。",
    action: "重试"
  },
  login: {
    code: "login_failed",
    title: "登录未成功",
    message: `暂时无法登录，请稍后重试。${CONTACT_SUPPORT}`,
    action: "重新登录"
  },
  session: {
    code: "session_sync_failed",
    title: "账号信息同步失败",
    message: "暂时无法同步账号信息，请检查网络后重试。",
    action: "重试"
  },
  logout: {
    code: "logout_failed",
    title: "退出未完成",
    message: "退出登录时出现问题，请重试。",
    action: "重试"
  },
  refresh: {
    code: "refresh_failed",
    title: "刷新未完成",
    message: "暂时无法刷新最新状态，请检查网络后重试。",
    action: "重试"
  },
  connect: {
    code: "connect_failed",
    title: "连接未成功",
    message: `暂时无法建立连接，请重试或切换其他节点。${CONTACT_SUPPORT}`,
    action: "重新连接"
  },
  disconnect: {
    code: "disconnect_failed",
    title: "断开未完成",
    message: "断开连接时出现问题，请重试；如仍无法断开，请退出并重新打开 ChordV。",
    action: "重试"
  },
  local_stop: {
    code: "local_stop_failed",
    title: "本机连接未能停止",
    message: "本机连接没有完全停止，网络可能仍在使用 ChordV。请退出并重新打开 ChordV；如仍异常，请联系客服并提供错误编号。",
    action: "重新打开"
  },
  runtime_assets: {
    code: "unknown",
    title: "组件准备未完成",
    message: `连接所需组件没有准备好，请点击“重新下载”。${CONTACT_SUPPORT}`,
    action: "重新下载"
  },
  update_check: {
    code: "update_check_failed",
    title: "检查更新失败",
    message: "暂时无法检查更新，请稍后重试。",
    action: "重试"
  },
  update_download: {
    code: "update_download_failed",
    title: "更新包下载失败",
    message: "更新包没有下载完成，请检查网络后点击“重新下载”。",
    action: "重新下载"
  },
  update_install: {
    code: "update_install_failed",
    title: "安装未能启动",
    message: "更新安装没有成功启动，请重试；如仍失败，请前往官网下载最新安装包。",
    action: "重试安装"
  },
  ticket: {
    code: "ticket_request_failed",
    title: "工单操作未完成",
    message: "工单暂时无法处理，请稍后重试。",
    action: "重试"
  },
  announcement: {
    code: null,
    title: "公告同步失败",
    message: "公告状态暂时无法同步，请稍后重试。",
    action: "重试"
  },
  node_probe: {
    code: null,
    title: "测速未完成",
    message: "节点测速没有完成，请稍后重试。",
    action: "重新测速"
  },
  server_probe: {
    code: null,
    title: "无法连接服务器",
    message: "当前无法连接服务器，请检查网络后重试。",
    action: "重试"
  },
  local_files: {
    code: "local_file_open_failed",
    title: "无法打开文件位置",
    message: "暂时无法在文件夹中显示，请复制路径后手动打开。",
    action: "我知道了"
  }
};

/** 桌面运行时会在错误文本里带出的机器码（与 connectionGuidance.extractRuntimeReasonCode 共享）。 */
export const RUNTIME_REASON_CODES = [
  "vpn_permission_denied",
  "vpn_permission_lost",
  "vpn_interface_establish_failed",
  "vpn_interface_not_ready",
  "libv2ray_start_failed",
  "connectivity_check_failed",
  "config_missing",
  "geo_resource_missing",
  "start_args_missing",
  "service_start_failed",
  "android_runtime_start_failed",
  "service_stop_failed",
  "android_runtime_stop_failed",
  "runtime_stopped",
  "runtime_mismatch",
  "service_task_removed",
  "external_vpn_conflict",
  "external_proxy_conflict",
  "windows_proxy_failed",
  "windows_local_proxy_failed"
] as const;

const RUNTIME_COMPONENT_PREFIX = /runtime_component_error:([a-z_]+):/i;
const CODE_LINE = /^\s*(?:错误编号|错误代码)\s*[：:]\s*([A-Za-z0-9_.-]+)\s*$/;

/** 看起来像开发者文本的英文词：出现即视为不可直接展示。 */
const DEVELOPER_WORDS = new Set([
  "error", "errors", "err", "failed", "failure", "fail", "invalid", "missing", "exception", "panic",
  "panicked", "timeout", "timed", "refused", "denied", "null", "undefined", "unwrap", "stack", "trace",
  "request", "response", "status", "internal", "cannot", "unable", "expected", "unexpected", "got",
  "os", "io", "errno", "tcp", "udp", "tls", "ssl", "reqwest", "hyper", "tauri", "rust", "json", "parse",
  "fetch", "abort", "aborted", "abortError", "url", "uri", "path", "directory", "lock", "poisoned",
  "sha256", "checksum", "signature", "minisign", "stream", "socket", "prisma", "panel", "nest", "http",
  "https", "localhost", "stderr", "stdout", "exit", "code", "spawn", "pid", "mismatch", "metadata",
  "bytes", "header", "content", "length", "handshake", "certificate", "resolve", "lookup",
  "permission", "access", "reg", "networksetup", "powershell", "netsh", "scutil", "osascript", "sudo",
  "api", "sse", "token", "bearer", "forbidden", "unauthorized", "conflict", "gateway", "unavailable",
  "service", "server", "client", "network", "connection", "connect", "reset", "broken", "pipe",
  "agent", "direct", "semver", "baseurl", "inbound", "outbound", "reality", "vless", "grpc"
]);

/** 面向运维 / 开发的中文术语：客户看不懂，出现即视为不可直接展示。 */
const DEVELOPER_PHRASES = ["图床", "入站", "水位", "流量批次", "控制模式", "字节", "后台服务", "面板客户端", "发布配置", "发布产物", "堆栈"];

function normalizeWhitespace(text: string) {
  return text.replace(/\r\n?/g, "\n").trim();
}

function hasCjk(text: string) {
  return /[㐀-鿿]/.test(text);
}

/**
 * 判断一段文本能否原样展示给客户：必须是中文，且不含英文原文、堆栈、路径、状态码、内部标识等。
 * 允许少量品牌 / 产品名（ChordV、VPN、Windows、Xray 等）和普通数字、版本号。
 */
export function isCustomerSafeText(text: string | null | undefined): boolean {
  const value = normalizeWhitespace(text ?? "");
  if (!value || !hasCjk(value)) {
    return false;
  }
  if (value.length > 240) {
    return false;
  }
  if (
    /\b[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
    /[A-Za-z]:[\\/]/.test(value) ||
    /(?:^|[^\w.])(?:~|\.{1,2})?\/[\w.-]+\/[\w./-]*/.test(value) ||
    /(?:^|[^\w.])\/[\w-]+\.[A-Za-z0-9]{1,6}\b/.test(value) ||
    /[{}[\]<>`\\|]/.test(value) ||
    /\bat\s+[\w.$<>]+\s*\(/.test(value) ||
    /\b[A-Za-z]+_[A-Za-z0-9_]+\b/.test(value) ||
    /\b[a-z]+[A-Z][a-z]+[A-Za-z]*\b/.test(value.replace(/\b(?:iPhone|iPad)\b/g, "")) ||
    /\b[0-9a-f]{16,}\b/i.test(value) ||
    /\b(?:HTTP|status)\s*\d{3}\b/i.test(value) ||
    /\b(?:os error|error code)\b/i.test(value) ||
    /[A-Za-z]{2,}(?:[\s-]+[A-Za-z]{2,}){2,}/.test(value)
  ) {
    return false;
  }
  if (DEVELOPER_PHRASES.some((phrase) => value.includes(phrase))) {
    return false;
  }
  const words = value.match(/[A-Za-z][A-Za-z']*/g) ?? [];
  return !words.some((word) => DEVELOPER_WORDS.has(word.toLowerCase()) || DEVELOPER_WORDS.has(word));
}

/** 解析 NestJS 风格的 JSON 错误体，取出 message 字段。 */
export function parseErrorBody(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return trimmed;
  }
  try {
    const parsed = JSON.parse(trimmed) as { message?: string[] | string; error?: string; statusCode?: number };
    if (Array.isArray(parsed.message)) {
      return parsed.message.filter(Boolean).join("，");
    }
    if (typeof parsed.message === "string") {
      return parsed.message.trim();
    }
  } catch {
    return trimmed;
  }
  return trimmed;
}

type ReasonParts = { text: string; detail: string; status: number | null };

function readReason(reason: unknown): ReasonParts {
  if (typeof reason === "string") {
    return { text: reason, detail: reason, status: null };
  }
  if (reason && typeof reason === "object") {
    const record = reason as { message?: unknown; rawMessage?: unknown; status?: unknown };
    const text = typeof record.message === "string" ? record.message : "";
    const raw = typeof record.rawMessage === "string" && record.rawMessage ? record.rawMessage : text;
    const status = typeof record.status === "number" && Number.isFinite(record.status) ? record.status : null;
    const detail = raw && raw !== text ? `${text}\n${raw}` : text;
    return { text, detail, status };
  }
  if (reason === null || reason === undefined) {
    return { text: "", detail: "", status: null };
  }
  const text = String(reason);
  return { text, detail: text, status: null };
}

export type OsFamily = "windows" | "unix";

/** 当前系统类别；拿不到（非浏览器环境）时返回 null，只按错误名称判断。 */
export function detectOsFamily(): OsFamily | null {
  const agent = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent;
  if (!agent) {
    return null;
  }
  return /Windows/i.test(agent) ? "windows" : "unix";
}

// 同一个 os error 数字在不同系统含义不同（5 在 Windows 是拒绝访问、在 macOS 是 I/O 错误；
// 28 在 Unix 是磁盘已满、在 Windows 是缺纸），只能按平台解读。
const OS_ERROR_CODES: Record<OsFamily, { permission: number[]; diskFull: number[] }> = {
  windows: { permission: [5], diskFull: [39, 112] },
  unix: { permission: [1, 13], diskFull: [28] }
};

function osErrorNumber(text: string) {
  const match = text.match(/os error (\d+)\b/i);
  return match ? Number(match[1]) : null;
}

/** 运行时 / 服务端明确给出的机器码，优先级高于任何文字猜测。 */
function detectMachineErrorCode(text: string): string | null {
  const prefixed = text.match(RUNTIME_COMPONENT_PREFIX)?.[1]?.toLowerCase();
  if (prefixed) {
    return prefixed;
  }
  if (/runtime_component_unavailable|runtime component verification failed|missing after bundled runtime restore|runtime component plan is (?:empty|missing)/i.test(text)) {
    return "runtime_component_unavailable";
  }
  if (/Panel client is queued but not confirmed yet/i.test(text)) {
    return "node_provisioning_pending";
  }
  // 已识别的运行时机器码即使没有专门文案也要原样保留，客服依赖它定位问题。
  const runtimeCode = RUNTIME_REASON_CODES.find((code) => text.includes(code));
  return runtimeCode ?? null;
}

/** 从原始文本里识别稳定的技术错误码；识别不到返回 null。 */
export function detectErrorCode(
  text: string,
  context: UserErrorContext = "general",
  osFamily: OsFamily | null = detectOsFamily()
): string | null {
  const machineCode = detectMachineErrorCode(text);
  if (machineCode) {
    return machineCode;
  }
  const osError = osErrorNumber(text);
  const osCodes = osFamily && osError !== null ? OS_ERROR_CODES[osFamily] : null;
  if (/No space left|ENOSPC|There is not enough space|磁盘空间不足/i.test(text) || osCodes?.diskFull.includes(osError!)) {
    return "disk_full";
  }
  if (/Permission denied|Access is denied|Operation not permitted|EACCES|EPERM|拒绝访问/i.test(text) || osCodes?.permission.includes(osError!)) {
    return "permission_denied";
  }
  // 网络类要先于签名判断：Windows 更新器的“下载或签名校验失败”在断网时也会出现。
  if (/AbortError|timed out|\btimeout\b|deadline has elapsed|请求超时/i.test(text)) {
    return context === "node_probe" ? "node_unreachable" : "network_timeout";
  }
  if (/Failed to fetch|NetworkError|\bLoad failed|\bfetch failed|error sending request|dns error|failed to lookup address|connection refused|connection reset|tcp connect error|network is unreachable|ECONNREFUSED|ENOTFOUND|ECONNRESET|网络请求失败|网络连接失败/i.test(text)) {
    return context === "node_probe" ? "node_unreachable" : "network_offline";
  }
  if (/minisign|signature|签名校验失败|签名无效|下载或签名校验失败/i.test(text)) {
    return context === "runtime_assets" ? "hash_mismatch" : "update_signature_invalid";
  }
  if (/sha-?256|checksum|hash mismatch|哈希|校验和/i.test(text)) {
    return context === "runtime_assets" ? "hash_mismatch" : "update_checksum_mismatch";
  }
  if (context === "update_download" || context === "update_install" || context === "update_check") {
    if (/size mismatch|大小与发布清单不一致/i.test(text)) {
      return "update_checksum_mismatch";
    }
    if (/empty installer file|missing file size|fileSizeBytes|size overflow|exceeds? the maximum download size|too large|trusted size limit|旧版 ZIP|缺少安装包或签名|尚未提供签名安装包|超过清单声明的大小/i.test(text)) {
      return "update_artifact_invalid";
    }
  }
  return null;
}

function statusFromText(text: string): number | null {
  const match = text.match(/\bHTTP\s*(\d{3})\b/i);
  return match ? Number(match[1]) : null;
}

function httpCatalogKey(status: number) {
  if (status >= 500) return "http_5xx";
  const key = `http_${status}`;
  return USER_ERROR_CATALOG[key] ? key : status >= 400 ? "http_400" : null;
}

function splitCodeLines(text: string) {
  let code: string | null = null;
  const lines: string[] = [];
  for (const line of normalizeWhitespace(text).split("\n")) {
    const match = line.match(CODE_LINE);
    if (match) {
      code = code ?? match[1];
    } else if (line.trim()) {
      lines.push(line.trim());
    }
  }
  return { code, lines };
}

/**
 * 把任意错误转换成客户可见的结构化文案。原始文本只放进 detail。
 */
export function describeUserError(
  reason: unknown,
  options: { context?: UserErrorContext } = {}
): UserFacingError {
  const context = options.context ?? "general";
  if (context === "local_stop") {
    // 本机停止失败必须明确告诉客户“连接没有停下来”，不能被识别出的网络 / 权限类说明覆盖；
    // 识别出的机器码仍作为错误编号保留。
    const fallback = CONTEXT_FALLBACK.local_stop;
    const classified = describeUserErrorInContext(reason, "general");
    return { ...fallback, code: classified.code ?? fallback.code, detail: classified.detail, known: true };
  }
  return describeUserErrorInContext(reason, context);
}

function describeUserErrorInContext(reason: unknown, context: UserErrorContext): UserFacingError {
  const fallback = CONTEXT_FALLBACK[context];
  const parts = readReason(reason);
  const { code: existingCode, lines } = splitCodeLines(parts.text);
  const bodies = lines.map(parseErrorBody).filter(Boolean);
  const body = bodies.join("\n");
  const detail = normalizeWhitespace(parts.detail);
  const codeStatus = Number(existingCode?.match(/^http_(\d{3})$/)?.[1] ?? NaN);
  const status = parts.status ?? (Number.isInteger(codeStatus) ? codeStatus : null) ?? statusFromText(`${body}\n${detail}`);

  // 多行（例如「连接失败 + 本机停止失败」）：每行独立判断，只保留安全行。
  const safeLines = bodies.filter((line) => isCustomerSafeText(line));
  const allSafe = bodies.length > 0 && safeLines.length === bodies.length;

  // 已经格式化过的错误（安全文案 + 错误编号）再次映射时沿用原分类和原文案，
  // 不能再被文字猜测改写（例如 504 的“请求超时”在测速场景被改成“节点不可达”）。
  if (existingCode && allSafe) {
    const entry = USER_ERROR_CATALOG[existingCode] ?? (status !== null && status >= 400 ? USER_ERROR_CATALOG[httpCatalogKey(status) ?? ""] : null);
    return {
      title: entry?.title ?? fallback.title,
      message: unique(safeLines).join("\n"),
      action: entry?.action ?? fallback.action,
      code: existingCode,
      detail,
      known: true
    };
  }

  // 服务端明确返回了 HTTP 错误时，以状态码为准：“Gateway Timeout”、上游“connection refused”
  // 是服务端故障，不能被文字猜测成客户的网络问题。只有明确的机器码仍然优先。
  const technicalCode = status !== null && status >= 400
    ? detectMachineErrorCode(`${body}\n${detail}`)
    : detectErrorCode(`${body}\n${detail}`, context);
  if (technicalCode && USER_ERROR_CATALOG[technicalCode]) {
    const entry = USER_ERROR_CATALOG[technicalCode];
    return { ...entry, code: existingCode ?? technicalCode, detail, known: true };
  }
  // 识别出机器码但没有专门文案：文案走场景兜底，编号保留原码。
  const recognizedCode = existingCode ?? technicalCode;

  if (status !== null && status >= 400) {
    const key = httpCatalogKey(status);
    const entry = key ? USER_ERROR_CATALOG[key] : null;
    if (allSafe) {
      // 4xx 通常是服务端给出的业务提示（如“邮箱或密码错误”），原样展示且不带编号；5xx 保留编号便于排查。
      return {
        title: status >= 500 ? entry?.title ?? fallback.title : fallback.title,
        message: unique(safeLines).join("\n"),
        action: entry?.action ?? fallback.action,
        code: recognizedCode ?? (status >= 500 ? `http_${status}` : null),
        detail,
        known: true
      };
    }
    // 401 / 413 / 429 / 5xx 的原因与场景无关，用状态码文案；403 / 404 / 409 在具体场景下用场景文案更贴切。
    const contextSpecific = context !== "general" && (status === 403 || status === 404 || status === 409);
    if (entry && !contextSpecific) {
      return { ...entry, code: recognizedCode ?? `http_${status}`, detail, known: true };
    }
    return { ...fallback, code: recognizedCode ?? `http_${status}`, detail, known: true };
  }

  if (allSafe) {
    return {
      title: fallback.title,
      message: unique(safeLines).join("\n"),
      action: fallback.action,
      code: recognizedCode,
      detail,
      known: true
    };
  }

  return {
    title: fallback.title,
    message: fallback.message,
    action: fallback.action,
    code: recognizedCode ?? fallback.code,
    detail,
    known: recognizedCode !== null
  };
}

function unique(values: string[]) {
  return values.filter((value, index) => values.indexOf(value) === index);
}

/** 「错误编号：xxx」次要行。 */
export function formatErrorCodeLine(code: string | null | undefined) {
  return code ? `${ERROR_CODE_LABEL}：${code}` : null;
}

/** 通知 / 行内提示使用的单段文本：主文案 + 可选的错误编号行。 */
export function formatUserError(error: Pick<UserFacingError, "message" | "code">) {
  const codeLine = formatErrorCodeLine(error.code);
  return codeLine ? `${error.message}\n${codeLine}` : error.message;
}

/**
 * 把「主文案 + 换行 + 错误编号：xxx」拆回两部分，供弹窗 / 面板用 ErrorCodeHint 单独展示编号。
 */
export function splitUserErrorText(text: string | null | undefined): { message: string; code: string | null } {
  const { code, lines } = splitCodeLines(text ?? "");
  return { message: lines.join("\n"), code };
}

/** 直接得到客户可见文本（幂等：对已处理过的文本再次调用结果不变）。 */
export function toUserMessage(reason: unknown, options: { context?: UserErrorContext } = {}) {
  return formatUserError(describeUserError(reason, options));
}

/** 生成可复制给客服的诊断文本（包含错误编号和原始详情）。 */
export function formatCopyableErrorDetail(error: Pick<UserFacingError, "code" | "detail" | "title">) {
  return [
    error.title,
    formatErrorCodeLine(error.code),
    error.detail ? `详情：${error.detail}` : null
  ].filter((line): line is string => Boolean(line)).join("\n");
}

/**
 * 必要组件下载失败：错误码（上报给服务端、客服定位用）保持原样，
 * 主文案优先使用错误码对应的说明，识别不到时再根据原文兜底。
 */
export function describeRuntimeAssetsFailure(code: string | null | undefined, rawMessage: string | null | undefined): UserFacingError {
  const detail = normalizeWhitespace(rawMessage ?? "");
  const entry = code ? USER_ERROR_CATALOG[code] : undefined;
  if (code && entry) {
    return { ...entry, code, detail, known: true };
  }
  const described = describeUserError(detail, { context: "runtime_assets" });
  return { ...described, code: code ?? described.code };
}

/** 生成与旧 readError 签名兼容的读取器，供只负责展示的 hook 使用。 */
export function createUserErrorReader(
  context: UserErrorContext,
  options: { onDiagnostic?: (error: UserFacingError, context: UserErrorContext) => void } = {}
) {
  // 接收完整的错误对象（而不只是 message），这样 HTTP 状态、服务端原文都能参与判断；
  // 被隐藏的原文在转换成展示文本之前交给 onDiagnostic 记录。
  return (reason: unknown) => {
    const error = describeUserError(reason, { context });
    if (shouldRecordDiagnostic(error)) {
      options.onDiagnostic?.(error, context);
    }
    return formatUserError(error);
  };
}

/** 原文与展示文本不同（被映射或被隐藏）时，需要把原文写入诊断日志。 */
export function shouldRecordDiagnostic(error: UserFacingError) {
  return Boolean(error.detail) && (!error.known || error.detail !== error.message);
}
