import type { PlatformTarget } from "@chordv/shared";
import type { ClientUpdateCheckResult, ReleaseArtifactType } from "../api/client";
import { detectRuntimePlatform, type DesktopUpdateDownloadProgress, type RuntimeStatus } from "./runtime";
import { describeUserError } from "./userFacingErrors";

export type UpdateDownloadState = {
  phase: "idle" | "preparing" | "downloading" | "verifying" | "completed" | "failed";
  fileName: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  localPath: string | null;
  message: string | null;
  /** 失败时的稳定错误码，只作为「错误编号」次要展示。 */
  errorCode?: string | null;
};

/**
 * 下载失败的展示内容。useUpdateFlow 已经映射并存下了文案和编号（errorCode 字段存在，可能为 null），
 * 直接沿用，不能再映射一次（否则 403 业务提示会被改判成本机权限问题、凭空多出编号）；
 * 只有没有 errorCode 字段的旧状态才按原文映射。
 */
export function describeUpdateDownloadFailure(state: UpdateDownloadState): { message: string; code: string | null } | null {
  if (state.phase !== "failed") {
    return null;
  }
  if (state.errorCode !== undefined) {
    const message = state.message?.trim();
    return { message: message || describeUserError("", { context: "update_download" }).message, code: state.errorCode };
  }
  const failure = describeUserError(state.message ?? "", { context: "update_download" });
  return { message: failure.message, code: failure.code };
}

export type ResolvedUpdatePlatform = Extract<PlatformTarget, "macos" | "windows" | "android">;

export { parseSemver, compareVersion } from "./releaseVersion";
import { compareVersion } from "./releaseVersion";

export function resolveUpdatePlatform(platformTarget: RuntimeStatus["platformTarget"]): ResolvedUpdatePlatform {
  if (platformTarget === "web") {
    const detected = detectRuntimePlatform();
    return detected === "windows" || detected === "android" ? detected : "macos";
  }
  return platformTarget === "windows" || platformTarget === "android" ? platformTarget : "macos";
}

export function preferredArtifactType(platformTarget: ResolvedUpdatePlatform): ReleaseArtifactType {
  if (platformTarget === "windows") {
    return "setup.exe";
  }
  if (platformTarget === "android") {
    return "apk";
  }
  return "dmg";
}

/** GitHub-generated notes end with "by @author in #123"; that tail is noise for end users. */
export function cleanChangelogItem(item: string) {
  return item
    .trim()
    .replace(/\s+by\s+@[\w-]+(?:\[bot\])?\s+in\s+(?:#\d+|https?:\/\/\S+)\s*$/i, "")
    .trim();
}

export function formatVersionLabel(version: string) {
  return version;
}

// A release can be forced while minimumVersion stays at 0.0.0; only claim
// "below the supported version" when that is actually true.
export function describeRequiredUpdate(
  update: Pick<ClientUpdateCheckResult, "latestVersion" | "minimumVersion">,
  appVersion: string
) {
  const target = formatVersionLabel(update.latestVersion);
  if (compareVersion(update.minimumVersion, appVersion) > 0) {
    return `当前版本 ${formatVersionLabel(appVersion)} 已低于最低支持版本，请更新到 ${target} 后继续使用。`;
  }
  return `这是一次必要更新，请更新到 ${target} 后继续使用。`;
}

export function resolveUpdateDownloadUrl(downloadUrl: string | null) {
  if (!downloadUrl) {
    return null;
  }
  try {
    const url = new URL(downloadUrl);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

export function inferInstallerFileName(downloadUrl: string, fileType: string) {
  try {
    const url = new URL(downloadUrl);
    const lastSegment = url.pathname.split("/").filter(Boolean).pop();
    if (lastSegment) {
      return decodeURIComponent(lastSegment);
    }
  } catch {
    return inferInstallerFileNameByType(fileType);
  }
  return inferInstallerFileNameByType(fileType);
}

function inferInstallerFileNameByType(fileType: string) {
  if (fileType === "setup.exe") {
    return "ChordV-setup.exe";
  }
  if (fileType === "zip") {
    return "ChordV-full-update.zip";
  }
  if (fileType === "apk") {
    return "ChordV.apk";
  }
  if (fileType === "ipa") {
    return "ChordV.ipa";
  }
  return "ChordV.dmg";
}

export function updateActionLabel(update: ClientUpdateCheckResult, downloadState?: UpdateDownloadState) {
  if (downloadState?.phase === "verifying") return "正在校验更新包";
  if (update.deliveryMode === "desktop_full_replace") {
    if (downloadState?.phase === "preparing") {
      return "正在准备更新包";
    }
    if (downloadState?.phase === "downloading") {
      return "正在下载更新包";
    }
    if (downloadState?.phase === "completed") {
      return "安装并重启";
    }
    return "下载并更新";
  }
  if (downloadState?.phase === "preparing") {
    return "正在准备下载";
  }
  if (downloadState?.phase === "downloading") {
    return "正在下载安装包";
  }
  if (downloadState?.phase === "completed") {
    return "安装并重启";
  }
  if (update.deliveryMode === "apk_download") {
    return "下载 APK 安装包";
  }
  if (update.deliveryMode === "external_download") {
    return "打开下载页";
  }
  return "下载更新";
}

export function createIdleUpdateDownloadState(): UpdateDownloadState {
  return {
    phase: "idle",
    fileName: null,
    downloadedBytes: 0,
    totalBytes: null,
    localPath: null,
    message: null
  };
}

export function normalizeDownloadedBytes(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function hasKnownTotalBytes(totalBytes: number | null): totalBytes is number {
  return typeof totalBytes === "number" && Number.isFinite(totalBytes) && totalBytes > 0;
}

export function mergeKnownTotalBytes(currentTotalBytes: number | null, nextTotalBytes: number | null) {
  if (hasKnownTotalBytes(nextTotalBytes)) {
    return nextTotalBytes;
  }
  return currentTotalBytes;
}

export function mergeKnownDownloadedBytes(
  currentDownloadedBytes: number,
  nextDownloadedBytes: number,
  totalBytes: number | null,
  phase: UpdateDownloadState["phase"]
) {
  const currentValue = normalizeDownloadedBytes(currentDownloadedBytes);
  const nextValue = normalizeDownloadedBytes(nextDownloadedBytes);
  if (phase === "completed") {
    if (hasKnownTotalBytes(totalBytes)) {
      return totalBytes;
    }
    return Math.max(currentValue, nextValue);
  }
  if (nextValue > 0) {
    return hasKnownTotalBytes(totalBytes) ? Math.min(nextValue, totalBytes) : nextValue;
  }
  if (phase === "downloading" && currentValue > 0) {
    return currentValue;
  }
  return nextValue;
}

export function normalizeUpdateDownloadProgress(
  current: UpdateDownloadState,
  progress: DesktopUpdateDownloadProgress
): UpdateDownloadState {
  const totalBytes = mergeKnownTotalBytes(current.totalBytes, progress.totalBytes);
  return {
    phase: progress.phase,
    fileName: progress.fileName ?? current.fileName,
    downloadedBytes: mergeKnownDownloadedBytes(current.downloadedBytes, progress.downloadedBytes, totalBytes, progress.phase),
    totalBytes,
    localPath: progress.localPath ?? current.localPath,
    message: progress.message ?? current.message
  };
}

export function downloadProgressPercent(downloadState: UpdateDownloadState) {
  if (!hasKnownTotalBytes(downloadState.totalBytes)) {
    return downloadState.phase === "completed" ? 100 : 0;
  }
  return Math.max(0, Math.min(100, (downloadState.downloadedBytes / downloadState.totalBytes) * 100));
}

export function formatByteSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}
