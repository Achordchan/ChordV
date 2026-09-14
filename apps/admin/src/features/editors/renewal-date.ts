import { toDateTimeLocal } from "../../utils/admin-format";

export function renewalBase(expireAt: string, now = new Date()): string {
  const expiry = new Date(expireAt);
  return toDateTimeLocal(Number.isFinite(expiry.getTime()) && expiry > now ? expiry.toISOString() : now.toISOString());
}

// Clamp month-end dates instead of overflowing a short month into the next one.
export function renewalDate(baseValue: string, months: number): string {
  const date = new Date(baseValue);
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, end));
  return toDateTimeLocal(date.toISOString());
}
