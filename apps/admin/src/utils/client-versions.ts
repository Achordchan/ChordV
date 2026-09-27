import type { AdminUserClientVersionDto, AdminUserRecordDto, PlatformTarget } from "@chordv/shared";

/** 版本分布只统计近 7 天用过客户端的用户，长期不用的旧记录不干扰判断。 */
export const CLIENT_VERSION_ACTIVE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

const PLATFORM_LABELS: Record<PlatformTarget, string> = {
  macos: "macOS",
  windows: "Windows",
  android: "Android",
  ios: "iOS"
};

export type ClientVersionSummary = {
  activeUsers: number;
  versions: Array<{
    version: string;
    users: number;
    platforms: Array<{ platform: PlatformTarget; label: string; users: number }>;
  }>;
};

export function formatClientPlatform(platform: PlatformTarget) {
  return PLATFORM_LABELS[platform] ?? "其他平台";
}

/** 列表里的紧凑写法，例如「1.1.10 · macOS」。 */
export function formatClientVersion(entry: AdminUserClientVersionDto) {
  return `${entry.version} · ${formatClientPlatform(entry.platform)}`;
}

/**
 * 详情里的完整写法，带构建号与更新通道，例如「1.1.10 · 构建 3 · macOS · 接收测试版更新」。
 * 通道取自检查更新请求，表示用户选择接收哪类更新，不代表当前安装的包是测试版。
 */
export function formatClientVersionDetail(entry: AdminUserClientVersionDto) {
  return [entry.version, entry.build ? `构建 ${entry.build}` : null, formatClientPlatform(entry.platform), entry.channel === "beta" ? "接收测试版更新" : null]
    .filter(Boolean)
    .join(" · ");
}

export function formatClientLastSeen(value: string, now = Date.now()) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "时间未知";
  const elapsed = Math.max(0, now - time);
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / (60 * 60_000))} 小时前`;
  if (elapsed < 30 * DAY_MS) return `${Math.floor(elapsed / DAY_MS)} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(time));
}

/** 用户各平台的记录按最近活跃时间倒序，不依赖接口返回顺序。 */
export function sortClientVersions(entries: AdminUserClientVersionDto[] | null | undefined) {
  return [...(entries ?? [])].sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt));
}

export function latestClientVersion(user: Pick<AdminUserRecordDto, "clientVersions"> | null | undefined) {
  return sortClientVersions(user?.clientVersions)[0] ?? null;
}

/** 近 N 天活跃用户按客户端版本分组；同一用户在多个平台用同一版本只算一人。 */
export function summarizeClientVersions(
  users: Array<Pick<AdminUserRecordDto, "id" | "clientVersions">>,
  now = Date.now(),
  days = CLIENT_VERSION_ACTIVE_DAYS
): ClientVersionSummary {
  const since = now - days * DAY_MS;
  const activeUsers = new Set<string>();
  const byVersion = new Map<string, { users: Set<string>; platforms: Map<PlatformTarget, Set<string>> }>();
  for (const user of users) {
    for (const entry of user.clientVersions ?? []) {
      const seenAt = Date.parse(entry.lastSeenAt);
      if (!Number.isFinite(seenAt) || seenAt < since) continue;
      activeUsers.add(user.id);
      const group = byVersion.get(entry.version) ?? { users: new Set<string>(), platforms: new Map<PlatformTarget, Set<string>>() };
      group.users.add(user.id);
      const platformUsers = group.platforms.get(entry.platform) ?? new Set<string>();
      platformUsers.add(user.id);
      group.platforms.set(entry.platform, platformUsers);
      byVersion.set(entry.version, group);
    }
  }
  const versions = [...byVersion.entries()]
    .map(([version, group]) => ({
      version,
      users: group.users.size,
      platforms: [...group.platforms.entries()]
        .map(([platform, platformUsers]) => ({ platform, label: formatClientPlatform(platform), users: platformUsers.size }))
        .sort((left, right) => right.users - left.users || left.label.localeCompare(right.label))
    }))
    .sort((left, right) => compareClientVersion(right.version, left.version));
  return { activeUsers: activeUsers.size, versions };
}

export function compareClientVersion(left: string, right: string) {
  const [leftCore, leftPre] = splitPrerelease(left);
  const [rightCore, rightPre] = splitPrerelease(right);
  const leftParts = leftCore.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = rightCore.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  // 同一版本号下，正式版排在预发布版之前。
  if (leftPre && !rightPre) return -1;
  if (!leftPre && rightPre) return 1;
  return comparePrerelease(leftPre ?? "", rightPre ?? "");
}

/** 按 SemVer 规则逐段比较预发布标识：纯数字段按数值比较且低于字母段，段数多者在前缀相同时更新。 */
function comparePrerelease(left: string, right: string) {
  const leftIds = left ? left.split(".") : [];
  const rightIds = right ? right.split(".") : [];
  for (let index = 0; index < Math.max(leftIds.length, rightIds.length); index += 1) {
    const a = leftIds[index];
    const b = rightIds[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const diff = Number(a) - Number(b);
      if (diff !== 0) return diff;
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    } else if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

function splitPrerelease(version: string): [string, string | undefined] {
  const index = version.indexOf("-");
  return index < 0 ? [version, undefined] : [version.slice(0, index), version.slice(index + 1)];
}
