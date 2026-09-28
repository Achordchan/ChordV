import { plainToInstance, Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
  validateSync
} from "class-validator";
import {
  SUPPORT_CONTACT_ATTRIBUTE_MAX_LENGTH,
  type ClientSupportConnectionState,
  type ConnectionMode,
  type SubscriptionState,
  type SupportContactProfileFieldKey
} from "@chordv/shared";

/**
 * 打开工单时附带给 Achord Connect 的联系人资料（user.attributes）。本文件只有纯函数，便于回归测试直接调用：
 * - 客户端上报的诊断信息按白名单逐项校验：不认识的键丢弃，某一项不合格只丢弃这一项（显示为“未知”），不影响打开工单；
 * - 连接详情（模式、节点、时长）与套餐只取后台数据库，客户端只提供连接状态与错误编号；
 * - 任何一项都不含令牌、节点地址/端口/UUID/密钥、订阅地址、IP、文件路径或原始错误文本。
 */

/** 整个 context 序列化后的字节上限，超出时整体丢弃。 */
export const SUPPORT_LAUNCH_CONTEXT_MAX_BYTES = 4 * 1024;
export const SUPPORT_CONTACT_UNKNOWN = "未知";
export const SUPPORT_CONTACT_CONNECTION_STATES: readonly ClientSupportConnectionState[] = ["connected", "connecting", "disconnecting", "disconnected", "error"];
const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,48}$/;
const DEFAULT_TIME_ZONE = "Asia/Shanghai";

export class SupportLaunchRecentErrorDto {
  @IsString() @Matches(ERROR_CODE_PATTERN) code!: string;
  @IsString() @IsISO8601({ strict: true }) @MaxLength(40) at!: string;
}

/** 客户端上报的诊断信息白名单。字段含义见 @chordv/shared 的 ClientSupportLaunchContextDto。 */
export class SupportLaunchContextDto {
  @IsOptional() @IsString() @MaxLength(80) appVersion?: string;
  @IsOptional() @IsString() @MaxLength(120) os?: string;
  @IsOptional() @IsString() @MaxLength(80) timezone?: string;
  @IsOptional() @IsString() @Matches(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/) @MaxLength(35) locale?: string;
  @IsOptional() @IsString() @MaxLength(60) updateChannel?: string;
  @IsOptional() @IsIn(SUPPORT_CONTACT_CONNECTION_STATES) connectionState?: ClientSupportConnectionState;
  @IsOptional() @IsString() @Matches(ERROR_CODE_PATTERN) connectionErrorCode?: string;
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9_-]{1,128}$/) sessionId?: string;
  @IsOptional() @IsString() @MaxLength(80) lineStatus?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => SupportLaunchRecentErrorDto)
  recentErrors?: SupportLaunchRecentErrorDto[];
  @IsOptional() @IsString() @MaxLength(160) components?: string;
}

export type SupportLaunchContext = {
  appVersion?: string;
  os?: string;
  timezone?: string;
  locale?: string;
  updateChannel?: string;
  connectionState?: ClientSupportConnectionState;
  connectionErrorCode?: string;
  sessionId?: string;
  lineStatus?: string;
  recentErrors?: Array<{ code: string; at: string }>;
  components?: string;
};

const TEXT_FIELDS = ["appVersion", "os", "timezone", "locale", "updateChannel", "lineStatus", "components"] as const;
const ALL_CONTEXT_FIELDS = new Set<string>([...TEXT_FIELDS, "connectionState", "connectionErrorCode", "sessionId", "recentErrors"]);

export type ParsedSupportLaunchContext = {
  /** null：客户端没有附带（旧版客户端）或整体不合格。 */
  context: SupportLaunchContext | null;
  /** 被丢弃的字段名（只含白名单里的字段名，便于写日志）。 */
  dropped: string[];
  oversized: boolean;
};

/**
 * 解析打开接口的请求体 { context }。旧版客户端没有请求体；不合格的字段逐项丢弃，
 * 整个 context 超过 4 KB 时整体丢弃。永不抛错：诊断信息不能影响打开工单。
 */
export function parseSupportLaunchContext(body: unknown): ParsedSupportLaunchContext {
  const raw = isPlainRecord(body) ? body.context : undefined;
  if (!isPlainRecord(raw)) {
    return { context: null, dropped: [], oversized: false };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    return { context: null, dropped: [], oversized: true };
  }
  if (Buffer.byteLength(serialized, "utf8") > SUPPORT_LAUNCH_CONTEXT_MAX_BYTES) {
    return { context: null, dropped: [], oversized: true };
  }
  const instance = plainToInstance(SupportLaunchContextDto, raw);
  const errors = validateSync(instance, { whitelist: true, forbidUnknownValues: false });
  const dropped = new Set<string>(errors.map((error) => error.property));
  const context: SupportLaunchContext = {};
  for (const field of TEXT_FIELDS) {
    const value = instance[field];
    if (dropped.has(field) || typeof value !== "string") continue;
    const clean = sanitizeClientText(value);
    if (clean === null) {
      dropped.add(field);
      continue;
    }
    context[field] = clean;
  }
  if (!dropped.has("connectionState") && instance.connectionState) context.connectionState = instance.connectionState;
  if (!dropped.has("connectionErrorCode") && instance.connectionErrorCode) context.connectionErrorCode = instance.connectionErrorCode;
  if (!dropped.has("sessionId") && instance.sessionId) context.sessionId = instance.sessionId;
  if (!dropped.has("recentErrors") && Array.isArray(instance.recentErrors)) {
    context.recentErrors = instance.recentErrors.map((item) => ({ code: item.code, at: item.at }));
  }
  return { context, dropped: [...dropped].filter((name) => ALL_CONTEXT_FIELDS.has(name)), oversized: false };
}

/**
 * 发给工单系统的文本（客户端上报的值、后台设置的节点名 / 套餐名）的最后一道防线：去掉控制字符并压缩空白；
 * 看起来像地址、邮箱、IP、文件路径或长令牌的值整项丢弃。
 * 客户端本就只拼接固定来源的值，这里是防御性检查。
 */
export function sanitizeClientText(value: string): string | null {
  const clean = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || looksSensitive(clean)) {
    return null;
  }
  return clean;
}

export function looksSensitive(value: string) {
  return (
    /[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
    // 不带协议的域名（hk.example.com、hk.example.com:443）和“主机名:端口”（localhost:443）。
    /(?:^|[^a-z0-9.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z](?::\d{1,5})?(?![a-z0-9-])/i.test(value) ||
    /(?:^|[^a-z0-9.-])[a-z][a-z0-9.-]*:\d{2,5}(?!\d)/i.test(value) ||
    /[^\s@]+@[^\s@]+\.[^\s@]+/.test(value) ||
    /(?:^|[^\d.])\d{1,3}(?:\.\d{1,3}){3}(?:$|[^\d.])/.test(value) ||
    /[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){3,7}/i.test(value) ||
    /(?:^|[\s（(])(?:\/|~\/|[a-z]:\\|\\\\)/i.test(value) ||
    /[A-Za-z0-9+/_=-]{32,}/.test(value)
  );
}

// ---------- 后台补齐的字段 ----------

export type SupportLeaseSnapshot = {
  connectionMode: string | null;
  issuedAt: Date;
  node: { name: string; protocol: string; security: string };
};

const CONNECTION_MODE_LABELS: Record<ConnectionMode, string> = { rule: "规则模式", global: "全局模式", direct: "直连模式" };

function describeLease(lease: SupportLeaseSnapshot, now: Date, withDuration: boolean) {
  const parts: string[] = [];
  const mode = CONNECTION_MODE_LABELS[lease.connectionMode as ConnectionMode];
  if (mode) parts.push(mode);
  parts.push(describeNode(lease.node));
  if (withDuration) parts.push(formatDuration(now.getTime() - lease.issuedAt.getTime()));
  return parts.join(" · ");
}

/** 节点只显示后台设置的名称和协议，不含地址、端口、UUID 或密钥。 */
export function describeNode(node: { name: string; protocol: string; security: string }) {
  const name = describeAdminName(node.name, "未命名节点", "节点名称已隐藏");
  const protocol = /^[a-z0-9-]{1,20}$/i.test(node.protocol) ? node.protocol.toUpperCase() : "";
  const security = /^[a-z0-9-]{1,20}$/i.test(node.security) && !["none", ""].includes(node.security.toLowerCase())
    ? node.security.toLowerCase() === "tls" ? "TLS" : node.security.charAt(0).toUpperCase() + node.security.slice(1).toLowerCase()
    : "";
  const label = [protocol, security].filter(Boolean).join(" ");
  return label ? `${name}（${label}）` : name;
}

/**
 * 后台设置的名称（节点名、套餐名）同样要过敏感内容检查：管理员可能用 IP 或连接地址给节点命名，
 * 这类名称整体换成中性说明，不把地址带给工单系统。
 */
function describeAdminName(value: string, emptyLabel: string, hiddenLabel: string) {
  if (!value.replace(/\s+/g, "")) return emptyLabel;
  const clean = sanitizeClientText(value);
  return clean === null ? hiddenLabel : truncateUnits(clean, 40);
}

/** 连接时长：不到 1 分钟、12 分钟、1 小时 12 分、2 天 3 小时。 */
export function formatDuration(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} 天 ${hours % 24} 小时` : `${days} 天`;
}

/**
 * 连接：状态来自客户端（只是枚举和错误编号），模式、节点、时长来自后台会话记录。
 * lease 为 null 表示后台没有找到对应的有效会话，"unknown" 表示会话记录读取失败。
 */
export function describeConnection(input: {
  state: ClientSupportConnectionState | null;
  errorCode: string | null;
  lease: SupportLeaseSnapshot | null | "unknown";
  now: Date;
}) {
  const { state, errorCode, now } = input;
  const lease = input.lease === "unknown" ? null : input.lease;
  switch (state) {
    case "connected":
      if (lease) return `已连接 · ${describeLease(lease, now, true)}`;
      return input.lease === "unknown" ? "已连接" : "已连接（后台没有对应的有效会话）";
    case "connecting":
      return lease ? `正在连接 · ${describeLease(lease, now, false)}` : "正在连接";
    case "disconnecting":
      return "正在断开";
    case "disconnected":
      return "未连接";
    case "error":
      return errorCode ? `连接失败（${errorCode}）` : "连接失败";
    default:
      return lease ? `未知（后台有进行中的会话 · ${describeLease(lease, now, true)}）` : SUPPORT_CONTACT_UNKNOWN;
  }
}

export type SupportPlanSnapshot = {
  scope: "personal" | "team";
  planName: string;
  state: SubscriptionState;
  expireAt: Date;
  remainingTrafficGb: number;
};

const SUBSCRIPTION_STATE_LABELS: Record<SubscriptionState, string> = {
  active: "正常",
  paused: "已暂停",
  expired: "已到期",
  exhausted: "流量已用尽"
};

/** 套餐：个人 · 标准版 · 正常 · 2026-12-31 到期 · 剩余 120.5 GB。state 应为按到期时间和流量折算后的实际状态。 */
export function describePlan(plan: SupportPlanSnapshot | null) {
  if (!plan) return "无订阅";
  const remaining = Number.isFinite(plan.remainingTrafficGb) ? Math.max(0, plan.remainingTrafficGb) : 0;
  const amount = remaining.toFixed(1).replace(/\.0$/, "");
  return [
    plan.scope === "team" ? "团队" : "个人",
    describeAdminName(plan.planName, "未命名套餐", "套餐名称已隐藏"),
    SUBSCRIPTION_STATE_LABELS[plan.state] ?? plan.state,
    `${formatDate(plan.expireAt, DEFAULT_TIME_ZONE)} 到期`,
    `${plan.scope === "team" ? "团队剩余" : "剩余"} ${amount} GB`
  ].join(" · ");
}

/** 最近错误：runtime_exited 10:21、http_5xx 10:18（按客户端时区显示，不是今天的加上日期）。 */
export function describeRecentErrors(errors: Array<{ code: string; at: string }> | undefined, timeZone: string | undefined, now: Date) {
  if (!errors) return SUPPORT_CONTACT_UNKNOWN;
  const zone = resolveTimeZone(timeZone);
  const items = errors
    .map((item) => ({ code: item.code, at: new Date(item.at) }))
    .filter((item) => ERROR_CODE_PATTERN.test(item.code) && Number.isFinite(item.at.getTime()))
    .sort((left, right) => right.at.getTime() - left.at.getTime())
    .slice(0, 3);
  if (items.length === 0) return "无";
  const today = formatDate(now, zone);
  return items
    .map((item) => {
      const date = formatDate(item.at, zone);
      const time = formatTime(item.at, zone);
      return `${item.code} ${date === today ? time : `${date.slice(5)} ${time}`}`;
    })
    .join("、");
}

/**
 * 组装全部 10 个资料字段（键名见 @chordv/shared 的 SUPPORT_CONTACT_PROFILE_FIELDS）。
 * 值一律为去除首尾空白、不超过 500 个 UTF-16 码元的文本；客户端没有提供的字段填“未知”。
 */
export function buildSupportContactAttributes(input: {
  context: SupportLaunchContext | null;
  connection: string;
  plan: string;
  now: Date;
}): Record<SupportContactProfileFieldKey, string> {
  const { context, now } = input;
  const legacy = context === null;
  const text = (value: string | undefined) => value ?? SUPPORT_CONTACT_UNKNOWN;
  const attributes: Record<SupportContactProfileFieldKey, string> = {
    app_version: legacy ? "未知（旧版客户端）" : text(context.appVersion),
    os: text(context?.os),
    timezone: text(context?.timezone),
    locale: text(context?.locale),
    update_channel: text(context?.updateChannel),
    connection: input.connection,
    line_status: text(context?.lineStatus),
    recent_errors: describeRecentErrors(context?.recentErrors, context?.timezone, now),
    components: text(context?.components),
    plan: input.plan
  };
  for (const key of Object.keys(attributes) as SupportContactProfileFieldKey[]) {
    attributes[key] = truncateUnits(attributes[key].trim(), SUPPORT_CONTACT_ATTRIBUTE_MAX_LENGTH) || SUPPORT_CONTACT_UNKNOWN;
  }
  return attributes;
}

/** 按 UTF-16 码元截断（工单系统按字符串 length 校验），不拆开代理对。 */
export function truncateUnits(value: string, max: number) {
  if (value.length <= max) return value;
  let result = "";
  for (const char of value) {
    if (result.length + char.length > max) break;
    result += char;
  }
  return result;
}

function resolveTimeZone(value: string | undefined) {
  const candidate = value?.split(/[（(\s]/)[0]?.trim();
  if (candidate) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: candidate });
      return candidate;
    } catch {
      // 不是有效的 IANA 时区名，按默认时区显示。
    }
  }
  return DEFAULT_TIME_ZONE;
}

function formatDate(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function formatTime(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
