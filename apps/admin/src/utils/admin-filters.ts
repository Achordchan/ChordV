import type { AdminTeamUsageRecordDto } from "@chordv/shared";

export function readError(reason: unknown, fallback: string) {
  if (!(reason instanceof Error)) {
    return fallback;
  }
  if (reason.name === "AbortError" || reason.message === "signal is aborted without reason") {
    return "请求超时，通常是文件较大或服务器处理较慢，请稍后重试。";
  }
  if (reason.message === "请求超时") {
    return "请求超时，通常是文件较大或服务器处理较慢，请稍后重试。";
  }
  try {
    const parsed = JSON.parse(reason.message) as { message?: string[] | string };
    if (Array.isArray(parsed.message)) return parsed.message.join("，");
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    return reason.message || fallback;
  }
  return reason.message || fallback;
}

export function filterByKeyword<T>(items: T[], keyword: string, projector: (item: T) => string[]) {
  if (!keyword.trim()) return items;
  const normalized = keyword.trim().toLowerCase();
  return items.filter((item) => projector(item).join(" ").toLowerCase().includes(normalized));
}

export function summarizeTeamUsage(entries: AdminTeamUsageRecordDto[]) {
  return [...entries]
    .map((entry) => ({
      ...entry,
      totalUsedTrafficGb: entry.memberTotalUsedTrafficGb ?? entry.usedTrafficGb,
      lastRecordedAt: entry.recordedAt,
      nodeBreakdown: [...(entry.nodeBreakdown ?? [])].sort(
        (left, right) => new Date(right.lastRecordedAt).getTime() - new Date(left.lastRecordedAt).getTime()
      )
    }))
    .sort((left, right) => new Date(right.lastRecordedAt).getTime() - new Date(left.lastRecordedAt).getTime());
}
