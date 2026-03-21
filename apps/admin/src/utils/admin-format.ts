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
