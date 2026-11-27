/**
 * 每月流量重置日的日期计算。后台定时任务和管理界面共用这一份，
 * 保证界面上显示的“下次重置”和实际执行的时间一致。
 *
 * 规则：
 * - 重置日是 1 到 31 的整数，按北京时间（UTC+8，无夏令时）当天 0 点执行。
 * - 当月没有这一天时（例如 31 号碰上 30 天的月份或 2 月），在当月最后一天执行。
 */

export const TRAFFIC_RESET_TIMEZONE_LABEL = "北京时间";
export const TRAFFIC_RESET_UTC_OFFSET_MINUTES = 8 * 60;
export const TRAFFIC_RESET_DAY_MIN = 1;
export const TRAFFIC_RESET_DAY_MAX = 31;

const OFFSET_MS = TRAFFIC_RESET_UTC_OFFSET_MINUTES * 60 * 1000;

export function isValidTrafficResetDay(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= TRAFFIC_RESET_DAY_MIN &&
    value <= TRAFFIC_RESET_DAY_MAX
  );
}

function daysInMonth(year: number, monthIndex: number) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** 某年某月（北京时间）的重置时刻，返回 UTC 时间点。 */
function resetInstantForMonth(day: number, year: number, monthIndex: number) {
  const effectiveDay = Math.min(day, daysInMonth(year, monthIndex));
  return new Date(Date.UTC(year, monthIndex, effectiveDay) - OFFSET_MS);
}

/**
 * 严格晚于 `after` 的下一次重置时刻。
 * 长时间停机后补跑也只会落在 `after` 之后的第一次，不会连续补多次。
 */
export function computeNextTrafficResetAt(day: number, after: Date): Date {
  if (!isValidTrafficResetDay(day)) {
    throw new RangeError(`流量重置日必须是 ${TRAFFIC_RESET_DAY_MIN} 到 ${TRAFFIC_RESET_DAY_MAX} 的整数`);
  }
  const local = new Date(after.getTime() + OFFSET_MS);
  let year = local.getUTCFullYear();
  let monthIndex = local.getUTCMonth();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = resetInstantForMonth(day, year, monthIndex);
    if (candidate.getTime() > after.getTime()) {
      return candidate;
    }
    monthIndex += 1;
    if (monthIndex > 11) {
      monthIndex = 0;
      year += 1;
    }
  }
  // 理论上第二个月一定满足；保底返回再下一个月。
  return resetInstantForMonth(day, year, monthIndex);
}

/** 新建订阅时的默认重置日：开通当天（北京时间）是几号。 */
export function defaultTrafficResetDay(now: Date = new Date()): number {
  return new Date(now.getTime() + OFFSET_MS).getUTCDate();
}
