export function toDateTimeLocal(value: string) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

export function fromDateTimeLocal(value: string) {
  return value ? new Date(value).toISOString() : undefined;
}

export function applyExpireOffset(baseValue: string, amount: number, unit: "day" | "month" | "year") {
  const base = baseValue ? new Date(baseValue) : new Date();
  const safeBase = Number.isNaN(base.getTime()) ? new Date() : base;
  const next = new Date(safeBase);
  if (unit === "day") {
    next.setDate(next.getDate() + amount);
  } else if (unit === "month") {
    next.setMonth(next.getMonth() + amount);
  } else {
    next.setFullYear(next.getFullYear() + amount);
  }
  return toDateTimeLocal(next.toISOString());
}

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function formatTrafficGb(value: number) {
  if (!Number.isFinite(value)) return "0";
  const fixed = value.toFixed(3);
  return fixed.replace(/\.?0+$/, "");
}

export function formatDateTimeWithYear(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function addDays(base: Date, value: number) {
  const next = new Date(base);
  next.setDate(next.getDate() + value);
  return next;
}

/** 订阅的每月流量重置说明，例如“每月 15 号 · 下次 12/15 00:00”。 */
export function describeTrafficReset(record: { trafficResetDay?: number | null; nextTrafficResetAt?: string | null } | null | undefined) {
  if (!record || typeof record.trafficResetDay !== "number") return "不自动重置";
  const day = `每月 ${record.trafficResetDay} 号`;
  return record.nextTrafficResetAt ? `${day} · 下次 ${formatDateTime(record.nextTrafficResetAt)}` : day;
}

/**
 * 设了每月重置日时，订阅的“总流量”其实是每月额度、“已用”是本月已用；
 * 没设时仍是整个订阅期的总量。界面按这个口径取文字。
 */
export function trafficQuotaLabels(resetDay: number | "" | null | undefined) {
  const monthly = typeof resetDay === "number";
  return {
    monthly,
    totalInput: monthly ? "每月流量 (GB)" : "总流量 (GB)",
    usedInput: monthly ? "本月已用 (GB)" : "已用流量 (GB)",
    totalShort: monthly ? "每月额度" : "总额度",
    usedShort: monthly ? "本月已用" : "已用",
    totalDescription: monthly ? "每到重置日已用流量清零，重新从这个额度开始用。" : undefined
  };
}

/** 表单里显示的 GB 数保留 3 位小数，避免出现 19.7382175354287 这样的长小数。 */
export function roundTrafficGbForForm(value: number) {
  return Math.round(value * 1000) / 1000;
}
