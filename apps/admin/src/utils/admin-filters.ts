import type { AdminTeamUsageRecordDto } from "@chordv/shared";

export function readError(reason: unknown, fallback: string) {
  if (!(reason instanceof Error)) {
    return fallback;
  }
  if (reason.name === "AbortError" || reason.message === "signal is aborted without reason") {
    return "请求超时，后台未在限定时间内返回。当前操作状态可能不确定，请刷新列表或同步队列确认最新状态。";
  }
  if (reason.message.includes("Failed to fetch") || reason.message.includes("NetworkError")) {
    return "网络请求失败，请检查后台服务、网络连接或跨域配置后重试。";
  }
  if (reason.message === "请求超时") {
    return "请求超时，后台未在限定时间内返回。当前操作状态可能不确定，请刷新列表或同步队列确认最新状态。";
  }
  try {
    const parsed = JSON.parse(reason.message) as { message?: string[] | string; statusCode?: number; status?: number };
    const status = typeof parsed.statusCode === "number" ? parsed.statusCode : parsed.status;
    const prefix = typeof status === "number" ? `HTTP ${status}: ` : "";
    if (Array.isArray(parsed.message)) return `${prefix}${parsed.message.join("，")}`;
    if (typeof parsed.message === "string") return `${prefix}${parsed.message}`;
  } catch {
    return reason.message || fallback;
  }
  return reason.message || fallback;
}

const UNCERTAIN_REQUEST_PATTERN =
  /超时|网络|网络请求失败|timeout|timed out|aborted|aborterror|failed to fetch|networkerror|network error|unexpected end of json|unexpected token/i;

export function isUncertainRequestFailure(message: string) {
  return (
    UNCERTAIN_REQUEST_PATTERN.test(message) ||
    /http 502|http 503|http 504|bad gateway|gateway timeout|service unavailable/i.test(message) ||
    /still being processed|still running in background|running in background|background retry|queued for background|retry shortly|正在处理|稍后重试|并发/i.test(message)
  );
}

export function isDefiniteLocalSaveFailure(message: string) {
  return /before local .* was saved|no .* was saved|import failed and no node was saved|本地.*未保存|没有保存/i.test(message);
}

export function isPotentiallyCompletedMutationFailure(message: string) {
  return isUncertainRequestFailure(message) || /http 500/i.test(message);
}

export function isSupportTicketAttachmentUploadFailure(message: string) {
  return /image bed|图床|attachment|附件|upload|上传|file exceeds|file too large|payload too large|multererror|too large|文件过大|Only image attachments|Attachment file/i.test(message);
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
