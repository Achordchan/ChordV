import type { ClientSupportConnectionState, ClientSupportLaunchContextDto, ReleaseChannel } from "@chordv/shared";
import type { RecentErrorCode } from "./recentErrorCodes";

/**
 * 打开工单时附带给客服的诊断信息（客户端部分）。后台会逐项校验，再补上连接详情和套餐，作为联系人资料发给工单系统。
 *
 * 隐私约束：只拼接下面这些固定来源的值——版本号、系统版本、时区、语言、更新设置、连接状态枚举、
 * 错误编号、服务器延迟、组件版本。绝不包含令牌、节点地址 / 端口 / UUID / 密钥、订阅地址、IP、文件路径或原始错误文本。
 * 任何一项取不到（或超时）都写成“未知”，不影响打开工单。
 *
 * 本文件保持无运行时依赖，便于回归测试直接加载。
 */

export const SUPPORT_CONTEXT_UNKNOWN = "未知";
/** 异步部分（系统版本、组件信息）的总等待上限；超时的项按“未知”处理。 */
export const SUPPORT_CONTEXT_TIMEOUT_MS = 250;

export type SupportContextSnapshot = {
  appVersion: string;
  appBuild: number | null;
  /** 有可用更新时的新版本；ready 表示安装包已下载好、等待安装。 */
  pendingUpdate: { version: string; ready: boolean } | null;
  updateChannel: ReleaseChannel;
  autoDownload: boolean;
  /** 原生层的连接状态（connected / connecting / disconnecting / error / idle …）。 */
  runtimeStatus: string;
  /** 连接失败时的错误编号（连接指引或原生层给出的稳定编号）。 */
  runtimeErrorCode: string | null;
  /** 当前连接的会话 ID，只用于后台查找本机的会话记录。 */
  sessionId: string | null;
  serverProbe: { status: string; elapsedMs: number | null };
  /** 已缓存的组件版本（上次检查组件时得到的）。 */
  cachedComponents: { xrayVersion: string | null; geoVersion: string | null };
};

export type SupportComponentsInfo = {
  xrayVersion: string | null;
  geoVersion: string | null;
  /** 三个组件文件（Xray、geoip、geosite）是否都在；不确定时为 null。 */
  complete: boolean | null;
};

export type SupportContextSources = {
  snapshot: () => SupportContextSnapshot;
  loadOsLabel: () => Promise<string | null>;
  loadComponents: () => Promise<SupportComponentsInfo | null>;
  readRecentErrors: () => RecentErrorCode[];
  readTimeZone?: () => string | null;
  readLocale?: () => string | null;
  now?: () => Date;
  timeoutMs?: number;
};

const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,48}$/;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** 版本号、组件版本等标签：只保留版本号里常见的字符，其余一律视为无效。 */
function cleanVersion(value: string | null | undefined, max = 40) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= max && /^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(text) ? text : null;
}

/** 组件版本标签可能是“最新版本 / 已安装”这类中文说明，也可能是 2026-09-20 这样的日期。 */
function cleanComponentLabel(value: string | null | undefined) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 40) return null;
  return /^[0-9A-Za-z\u4e00-\u9fff][0-9A-Za-z\u4e00-\u9fff ._+-]*$/.test(text) ? text : null;
}

function cleanCode(value: string | null | undefined) {
  const code = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ERROR_CODE_PATTERN.test(code) ? code : null;
}

export function describeAppVersion(snapshot: Pick<SupportContextSnapshot, "appVersion" | "appBuild" | "pendingUpdate">) {
  const version = cleanVersion(snapshot.appVersion);
  if (!version) return SUPPORT_CONTEXT_UNKNOWN;
  const build = Number.isInteger(snapshot.appBuild) && (snapshot.appBuild ?? 0) > 0 ? `（构建 ${snapshot.appBuild}）` : "";
  const pending = cleanVersion(snapshot.pendingUpdate?.version);
  const update = pending ? ` · ${snapshot.pendingUpdate?.ready ? "待安装" : "有新版本"} ${pending}` : "";
  return `${version}${build}${update}`;
}

export function describeUpdateChannel(snapshot: Pick<SupportContextSnapshot, "updateChannel" | "autoDownload">) {
  return `${snapshot.updateChannel === "beta" ? "测试版" : "正式版"} · 自动下载${snapshot.autoDownload ? "开" : "关"}`;
}

export function mapConnectionState(status: string): ClientSupportConnectionState {
  switch (status) {
    case "connected":
      return "connected";
    case "connecting":
    case "starting":
      return "connecting";
    case "disconnecting":
      return "disconnecting";
    case "error":
      return "error";
    default:
      return "disconnected";
  }
}

export function describeLineStatus(probe: SupportContextSnapshot["serverProbe"]) {
  if (probe.status === "healthy") {
    const ms = probe.elapsedMs;
    return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? `正常（${Math.round(ms)} ms）` : "正常";
  }
  if (probe.status === "failed") return "无法连接服务器";
  if (probe.status === "checking") return "正在检查";
  return "尚未检查";
}

export function describeComponents(info: SupportComponentsInfo | null, cached: SupportContextSnapshot["cachedComponents"]) {
  const xray = cleanComponentLabel(info?.xrayVersion) ?? cleanComponentLabel(cached.xrayVersion) ?? SUPPORT_CONTEXT_UNKNOWN;
  const geo = cleanComponentLabel(info?.geoVersion) ?? cleanComponentLabel(cached.geoVersion) ?? SUPPORT_CONTEXT_UNKNOWN;
  const complete = info?.complete === true ? "完整" : info?.complete === false ? "不完整" : "完整性未知";
  return `Xray ${xray} · 规则库 ${geo} · ${complete}`;
}

/** Asia/Shanghai（UTC+8）；offsetMinutes 为 UTC 偏移（东八区为 480）。 */
export function describeTimeZone(timeZone: string | null, offsetMinutes: number) {
  const zone = typeof timeZone === "string" && /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(timeZone) ? timeZone : null;
  if (!Number.isFinite(offsetMinutes)) return zone ?? SUPPORT_CONTEXT_UNKNOWN;
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(Math.round(offsetMinutes));
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  const offset = `UTC${sign}${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`;
  return zone ? `${zone}（${offset}）` : offset;
}

export function cleanLocale(value: string | null | undefined) {
  const text = typeof value === "string" ? value.trim() : "";
  return LOCALE_PATTERN.test(text) && text.length <= 35 ? text : null;
}

/** 系统版本来自原生层（例如 macOS 15.1（24B83，arm64）），这里只做长度与字符的兜底检查。 */
export function cleanOsLabel(value: string | null | undefined) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 80) return null;
  return /^[0-9A-Za-z\u4e00-\u9fff][0-9A-Za-z\u4e00-\u9fff ._+\-（），]*$/.test(text) ? text : null;
}

/** 组装发给后台的 context。所有值都来自上面这些固定来源；错误只带编号和时间。 */
export function buildSupportLaunchContext(input: {
  snapshot: SupportContextSnapshot;
  osLabel: string | null;
  components: SupportComponentsInfo | null;
  recentErrors: RecentErrorCode[];
  timeZone: string | null;
  offsetMinutes: number;
  locale: string | null;
}): ClientSupportLaunchContextDto {
  const { snapshot } = input;
  const connectionState = mapConnectionState(snapshot.runtimeStatus);
  const context: ClientSupportLaunchContextDto = {
    appVersion: describeAppVersion(snapshot),
    os: cleanOsLabel(input.osLabel) ?? SUPPORT_CONTEXT_UNKNOWN,
    timezone: describeTimeZone(input.timeZone, input.offsetMinutes),
    locale: cleanLocale(input.locale) ?? undefined,
    updateChannel: describeUpdateChannel(snapshot),
    connectionState,
    lineStatus: describeLineStatus(snapshot.serverProbe),
    recentErrors: input.recentErrors
      .filter((item) => ERROR_CODE_PATTERN.test(item.code) && Number.isFinite(Date.parse(item.at)))
      .slice(0, 3)
      .map((item) => ({ code: item.code, at: item.at })),
    components: describeComponents(input.components, snapshot.cachedComponents)
  };
  const errorCode = connectionState === "error" ? cleanCode(snapshot.runtimeErrorCode) : null;
  if (errorCode) context.connectionErrorCode = errorCode;
  if ((connectionState === "connected" || connectionState === "connecting") && snapshot.sessionId && SESSION_ID_PATTERN.test(snapshot.sessionId)) {
    context.sessionId = snapshot.sessionId;
  }
  if (!context.locale) delete context.locale;
  return context;
}

function withTimeout<T>(task: () => Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    let promise: Promise<T>;
    try {
      promise = task();
    } catch {
      clearTimeout(timer);
      resolve(null);
      return;
    }
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

function defaultTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function defaultLocale() {
  try {
    return typeof navigator !== "undefined" ? navigator.language || null : null;
  } catch {
    return null;
  }
}

/**
 * 收集诊断信息：同步部分立即读取，系统版本和组件信息并行等待，最多 timeoutMs（默认 250 毫秒）。
 * 永不抛错：整个收集失败时返回 null，打开工单照常进行（后台按旧版客户端处理）。
 */
export async function collectSupportLaunchContext(sources: SupportContextSources): Promise<ClientSupportLaunchContextDto | null> {
  try {
    const timeoutMs = sources.timeoutMs ?? SUPPORT_CONTEXT_TIMEOUT_MS;
    const now = sources.now?.() ?? new Date();
    const snapshot = sources.snapshot();
    const [osLabel, components] = await Promise.all([
      withTimeout(sources.loadOsLabel, timeoutMs),
      withTimeout(sources.loadComponents, timeoutMs)
    ]);
    let recentErrors: RecentErrorCode[] = [];
    try {
      recentErrors = sources.readRecentErrors();
    } catch {
      recentErrors = [];
    }
    return buildSupportLaunchContext({
      snapshot,
      osLabel,
      components,
      recentErrors,
      timeZone: (sources.readTimeZone ?? defaultTimeZone)(),
      offsetMinutes: -now.getTimezoneOffset(),
      locale: (sources.readLocale ?? defaultLocale)()
    });
  } catch {
    return null;
  }
}
