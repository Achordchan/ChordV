/**
 * 本次运行期间最近出现过的面向客户的错误编号（最多 3 条），打开工单时附带给客服。
 *
 * - 只保存稳定的错误编号（小写字母、数字、下划线）和发生时间，绝不保存原始错误文本；
 * - 只在内存里，退出应用即清空，不写入磁盘；
 * - 同一编号在 1 分钟内反复出现只更新时间，不挤掉其他记录。
 *
 * 本文件保持无运行时依赖，便于回归测试直接加载。
 */

export const RECENT_ERROR_CODE_LIMIT = 3;
const REPEAT_WINDOW_MS = 60_000;
const CODE_PATTERN = /^[a-z0-9_]{1,48}$/;

export type RecentErrorCode = { code: string; at: string };

let entries: Array<{ code: string; at: number }> = [];

/** 规范化错误编号：不是稳定编号（含空格、路径、中文等）时返回 null。 */
export function normalizeRecentErrorCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toLowerCase();
  return CODE_PATTERN.test(code) ? code : null;
}

export function recordRecentErrorCode(value: unknown, now = Date.now()) {
  const code = normalizeRecentErrorCode(value);
  if (!code || !Number.isFinite(now)) return;
  const latest = entries[0];
  if (latest && latest.code === code && now - latest.at < REPEAT_WINDOW_MS) {
    latest.at = Math.max(latest.at, now);
    return;
  }
  entries = [{ code, at: now }, ...entries].slice(0, RECENT_ERROR_CODE_LIMIT);
}

/** 新的在前。 */
export function readRecentErrorCodes(): RecentErrorCode[] {
  return entries.map((entry) => ({ code: entry.code, at: new Date(entry.at).toISOString() }));
}

export function clearRecentErrorCodes() {
  entries = [];
}
