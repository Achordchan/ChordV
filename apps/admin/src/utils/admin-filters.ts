import type { AdminTeamUsageRecordDto } from "@chordv/shared";

export function readError(reason: unknown, fallback: string) {
  if (!(reason instanceof Error)) {
    return fallback;
  }
  if (reason.name === "AbortError" || reason.message === "signal is aborted without reason" || /请求超时/i.test(reason.message)) {
    return "请求超时，后台未在限定时间内返回。当前操作状态可能不确定，请刷新列表或同步队列确认最新状态。";
  }
  if (/Failed to fetch|NetworkError/i.test(reason.message)) {
    return "网络请求失败，请检查后台服务、网络连接或跨域配置后重试。";
  }
  try {
    const parsed = JSON.parse(reason.message) as { message?: string[] | string; statusCode?: number; status?: number };
    const status = typeof parsed.statusCode === "number" ? parsed.statusCode : parsed.status;
    const prefix = typeof status === "number" ? `HTTP ${status}: ` : "";
    if (Array.isArray(parsed.message)) return normalizeAdminErrorMessage(`${prefix}${parsed.message.join("；")}`, fallback);
    if (typeof parsed.message === "string") return normalizeAdminErrorMessage(`${prefix}${parsed.message}`, fallback);
  } catch {
    return normalizeAdminErrorMessage(reason.message || fallback, fallback);
  }
  return normalizeAdminErrorMessage(reason.message || fallback, fallback);
}

export function normalizeAdminErrorMessage(message: string, fallback: string) {
  if (!message.trim()) {
    return fallback;
  }
  if (hasSavedAfterFailureSignal(message) && hasSavedAfterFailureWarningSignal(message)) {
    return "操作已保存，后台同步待处理，请在同步队列中查看处理状态。";
  }
  if (hasDefiniteLocalSaveFailureSignal(message) && !hasSavedAfterFailureSignal(message)) {
    return "后台本地数据保存失败，本次操作未保存，请稍后重试。";
  }
  if (/MulterError|payload too large|file too large|file exceeds|too large/i.test(message)) {
    return "文件过大，已超过后台允许的上传限制。";
  }
  if (/Only image attachments are supported|Only image attachments/i.test(message)) {
    return "仅支持上传图片附件。";
  }
  if (/Attachment file is required|Select an installer package file first/i.test(message)) {
    return "请先选择要上传的文件。";
  }
  if (/Image bed API token is not configured|图床 API Token 未配置/i.test(message)) {
    return "图床 API Token 未配置，请先在后台图床配置中填写。";
  }
  if (/只填写图床域名|不要包含路径|图床文件路径无效|文件路径不能为空/i.test(message)) {
    return message.replace(/^HTTP\s*\d+:\s*/i, "");
  }
  if (isSupportTicketAttachmentUploadFailure(message)) {
    return message.replace(/^HTTP\s*\d+:\s*/i, "");
  }
  if (/HTTP\s*401|Unauthorized/i.test(message)) {
    return "登录状态已失效，请重新登录。";
  }
  if (/HTTP\s*403|Forbidden/i.test(message)) {
    return "当前账号没有执行该操作的权限。";
  }
  if (/HTTP\s*404|Not Found/i.test(message)) {
    return "数据不存在或已被删除，请刷新列表后重试。";
  }
  if (/HTTP\s*409|Conflict|unique constraint|already exists/i.test(message)) {
    return "数据已存在或状态已变更，请刷新后重试。";
  }
  if (/HTTP\s*400|Bad Request|Validation failed|should not be empty|must be|is required|invalid/i.test(message)) {
    return "提交内容不完整或格式不正确，请检查后重试。";
  }
  if (isServiceUnavailableMessage(message)) {
    if (!hasSavedAfterFailureSignal(message)) {
      return "后台或外部服务暂不可用，本次操作未确认完成，请稍后重试。";
    }
    return "外部服务或面板暂不可用，已保存的操作请在同步队列中查看处理状态。";
  }
  if (/HTTP\s*5\d\d|Internal server error/i.test(message)) {
    return "后台服务异常，请稍后重试；如果连续出现，请查看服务器日志。";
  }
  return message;
}

export function summarizeAdminDiagnosticMessage(message?: string | null, fallback = "后台同步任务失败，请稍后重试或查看服务器日志。") {
  const trimmed = message?.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = normalizeAdminErrorMessage(trimmed, fallback);
  if (normalized !== trimmed) {
    return normalized;
  }
  if (!hasTechnicalErrorSignal(trimmed)) {
    return trimmed;
  }
  return fallback;
}

function hasTechnicalErrorSignal(message: string) {
  return /HTTP\s*\d+|[A-Z][A-Za-z]+Error|Exception|ECONN|ETIMEDOUT|ENOTFOUND|socket|fetch|JSON|Prisma|TypeError|ReferenceError|https?:\/\/|queued|background|sync|panel|lease|node access|subscription/i.test(
    message
  );
}

const UNCERTAIN_REQUEST_PATTERN =
  /超时|网络|网络请求失败|timeout|timed out|aborted|aborterror|failed to fetch|networkerror|network error|unexpected end of json|unexpected token/i;

export function isUncertainRequestFailure(message: string) {
  return (
    UNCERTAIN_REQUEST_PATTERN.test(message) ||
    isServiceUnavailableMessage(message) ||
    /still being processed|still running in background|running in background|background retry|queued for background|retry shortly|partial|partially|暂不可用|未确认完成|状态不确定|正在处理|并发|部分成功|部分完成/i.test(message)
  );
}

export function isDefiniteLocalSaveFailure(message: string) {
  return hasDefiniteLocalSaveFailureSignal(message) && !hasSavedAfterFailureSignal(message);
}

export function isPotentiallyCompletedMutationFailure(message: string) {
  return isUncertainRequestFailure(message) || isLikelySavedAfterFailure(message);
}

export function buildUncertainMutationMessage(actionLabel: string, detail?: string) {
  const trimmedDetail = detail?.trim();
  const suffix = "请刷新列表或打开同步队列确认最新状态；不要重复提交同一操作。";
  return trimmedDetail ? `${trimmedDetail} ${suffix}` : `${actionLabel}状态不确定，${suffix}`;
}

export function isLikelySavedAfterFailure(message: string) {
  return hasSavedAfterFailureSignal(message);
}

export function isSupportTicketAttachmentUploadFailure(message: string) {
  return /image bed|图床|attachment|附件|upload|上传|file exceeds|file too large|payload too large|multererror|too large|文件过大|Only image attachments|Attachment file/i.test(message);
}

export function filterByKeyword<T>(items: T[], keyword: string, projector: (item: T) => string[]) {
  if (!keyword.trim()) return items;
  const normalized = keyword.trim().toLowerCase();
  return items.filter((item) => projector(item).join(" ").toLowerCase().includes(normalized));
}

function isServiceUnavailableMessage(message: string) {
  return /HTTP\s*502|HTTP\s*503|HTTP\s*504|Bad Gateway|Gateway Timeout|Service Unavailable|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|socket hang up|fetch failed|network timeout|connect timeout/i.test(
    message
  );
}

function hasDefiniteLocalSaveFailureSignal(message: string) {
  return /before local .* was saved|no .* was saved|import failed and no node was saved|本地.*未保存|没有保存|本次操作未保存|保存失败|创建失败|更新失败|删除失败/i.test(
    message
  );
}

function hasSavedAfterFailureSignal(message: string) {
  return /local .* saved|saved locally|already saved|已保存|后台处理|background processing|background retry|queued for background|still running in background|panel synchronization is pending|pending background|partial success|partially completed|部分成功|部分完成/i.test(
    message
  );
}

function hasSavedAfterFailureWarningSignal(message: string) {
  return /HTTP\s*5\d\d|failed|failure|error|Exception|暂不可用|失败|异常|background|pending|queued|同步待|后台处理|部分成功|部分完成/i.test(
    message
  );
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
