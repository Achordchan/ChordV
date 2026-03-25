import type { ClientVersionDto, PlatformTarget } from "@chordv/shared";
import type { ClientUpdateArtifact, ClientUpdateCheckResult, ReleaseArtifactType, ReleaseChannel } from "../api/client";
import { detectRuntimePlatform, type DesktopUpdateDownloadProgress, type RuntimeStatus } from "./runtime";

export type UpdateDownloadState = {
  phase: "idle" | "preparing" | "downloading" | "completed" | "failed";
  fileName: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  localPath: string | null;
  message: string | null;
};

export type ResolvedUpdatePlatform = Extract<PlatformTarget, "macos" | "windows" | "android">;

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

export function parseSemver(version: string): ParsedSemver | null {
  const match = version.trim().match(
    /^v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<prerelease>[0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
  );
  if (!match?.groups) {
    return null;
  }
  return {
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
    patch: Number(match.groups.patch),
    prerelease: match.groups.prerelease ? match.groups.prerelease.split(".") : []
  };
}

export function compareVersion(left: string, right: string) {
  const leftSemver = parseSemver(left);
  const rightSemver = parseSemver(right);

  if (!leftSemver || !rightSemver) {
    return left.localeCompare(right);
  }

  for (const key of ["major", "minor", "patch"] as const) {
    if (leftSemver[key] > rightSemver[key]) {
      return 1;
    }
    if (leftSemver[key] < rightSemver[key]) {
      return -1;
    }
  }

  if (leftSemver.prerelease.length === 0 && rightSemver.prerelease.length > 0) {
    return 1;
  }
  if (leftSemver.prerelease.length > 0 && rightSemver.prerelease.length === 0) {
    return -1;
  }

  const length = Math.max(leftSemver.prerelease.length, rightSemver.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftSemver.prerelease[index];
    const rightPart = rightSemver.prerelease[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }
    if (leftPart === rightPart) {
      continue;
    }
    const leftNumber = Number(leftPart);
    const rightNumber = Number(rightPart);
    const leftNumeric = Number.isFinite(leftNumber) && leftPart.trim() !== "";
    const rightNumeric = Number.isFinite(rightNumber) && rightPart.trim() !== "";

    if (leftNumeric && rightNumeric) {
      return leftNumber > rightNumber ? 1 : -1;
    }
    if (leftNumeric) {
      return -1;
    }
    if (rightNumeric) {
      return 1;
    }
    return leftPart.localeCompare(rightPart);
  }

  return 0;
}

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

export function formatVersionLabel(version: string) {
  return version;
}

export function resolveUpdateDownloadUrl(downloadUrl: string | null) {
  if (!downloadUrl) {
    return null;
  }
  if (/^https?:\/\//i.test(downloadUrl)) {
    return downloadUrl;
  }
  return new URL(downloadUrl, import.meta.env.VITE_API_BASE_URL ?? "https://v.baymaxgroup.com").toString();
}

export function normalizeMirrorPrefix(mirrorPrefix?: string | null) {
  const normalized = mirrorPrefix?.trim();
  return normalized ? normalized : null;
}

export function applyUpdateMirrorPrefix(originUrl: string, mirrorPrefix?: string | null) {
  const normalizedPrefix = normalizeMirrorPrefix(mirrorPrefix);
  if (!normalizedPrefix) {
    return originUrl;
  }
  if (normalizedPrefix.includes("{url}")) {
    return normalizedPrefix.replaceAll("{url}", originUrl);
  }
  return `${normalizedPrefix}${originUrl}`;
}

export function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
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
  if (fileType === "apk") {
    return "ChordV.apk";
  }
  if (fileType === "ipa") {
    return "ChordV.ipa";
  }
  return "ChordV.dmg";
}

export function createLegacyUpdateResult(
  version: ClientVersionDto | null,
  platformTarget: ResolvedUpdatePlatform,
  currentVersion: string,
  clientMirrorPrefix?: string | null,
  fallbackArtifact?: ClientUpdateArtifact | null,
  channel: ReleaseChannel = "stable"
): ClientUpdateCheckResult | null {
  if (!version) {
    return null;
  }

  const hasUpdate =
    compareVersion(version.currentVersion, currentVersion) > 0 ||
    compareVersion(version.minimumVersion, currentVersion) > 0 ||
    version.forceUpgrade;

  if (!hasUpdate) {
    return null;
  }

  const originDownloadUrl = resolveUpdateDownloadUrl(version.downloadUrl ?? null);
  const downloadUrl = originDownloadUrl ? applyUpdateMirrorPrefix(originDownloadUrl, clientMirrorPrefix) : null;
  const fileType = preferredArtifactType(platformTarget);
  const compatibleFallbackArtifact =
    fallbackArtifact &&
    fallbackArtifact.fileType === fileType &&
    (fallbackArtifact.originDownloadUrl === originDownloadUrl || fallbackArtifact.downloadUrl === downloadUrl)
      ? fallbackArtifact
      : null;

  return {
    platform: platformTarget,
    channel,
    currentVersion,
    latestVersion: version.currentVersion,
    minimumVersion: version.minimumVersion,
    hasUpdate: true,
    forceUpgrade: version.forceUpgrade || compareVersion(version.minimumVersion, currentVersion) > 0,
    title: `发现新版本 ${formatVersionLabel(version.currentVersion)}`,
    changelog: version.changelog,
    publishedAt: null,
    deliveryMode: platformTarget === "android" ? "apk_download" : "desktop_installer_download",
    downloadUrl,
    artifact: downloadUrl
      ? {
          fileType,
          downloadUrl,
          originDownloadUrl,
          defaultMirrorPrefix:
            normalizeMirrorPrefix(clientMirrorPrefix) ?? compatibleFallbackArtifact?.defaultMirrorPrefix ?? null,
          allowClientMirror: compatibleFallbackArtifact?.allowClientMirror ?? true,
          fileName: compatibleFallbackArtifact?.fileName ?? inferInstallerFileName(downloadUrl, fileType),
          fileSizeBytes: compatibleFallbackArtifact?.fileSizeBytes ?? null,
          fileHash: compatibleFallbackArtifact?.fileHash ?? null,
          isPrimary: true,
          isFullPackage: true
        }
      : null
  };
}

export function updateActionLabel(update: ClientUpdateCheckResult, downloadState?: UpdateDownloadState) {
  if (downloadState?.phase === "preparing") {
    return "正在准备下载";
  }
  if (downloadState?.phase === "downloading") {
    return "正在下载安装器";
  }
  if (downloadState?.phase === "completed") {
    return "重新打开安装器";
  }
  if (update.deliveryMode === "apk_download") {
    return "下载 APK 安装包";
  }
  if (update.deliveryMode === "external_download") {
    return "打开下载页";
  }
  return "下载并安装更新";
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

export function displayUpdateDownloadProgress(downloadState: UpdateDownloadState, indeterminateValue: number) {
  if (downloadState.phase === "completed") {
    return 100;
  }
  if (downloadState.phase === "failed") {
    return hasKnownTotalBytes(downloadState.totalBytes) ? downloadProgressPercent(downloadState) : 0;
  }
  if (!hasKnownTotalBytes(downloadState.totalBytes)) {
    if (downloadState.phase === "preparing") {
      return 12;
    }
    if (downloadState.phase === "downloading") {
      return indeterminateValue;
    }
    return 0;
  }
  return downloadProgressPercent(downloadState);
}

export function phaseMessage(phase: UpdateDownloadState["phase"]) {
  switch (phase) {
    case "preparing":
      return "正在准备下载";
    case "downloading":
      return "正在下载安装器";
    case "completed":
      return "安装器已下载完成";
    case "failed":
      return "安装器下载失败";
    default:
      return "等待开始下载";
  }
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

export function describeUpdateDownload(downloadState: UpdateDownloadState) {
  if (downloadState.phase === "idle") {
    return "点击下方按钮后，系统会先下载完整安装器。";
  }
  const amount = hasKnownTotalBytes(downloadState.totalBytes)
    ? `${formatByteSize(downloadState.downloadedBytes)} / ${formatByteSize(downloadState.totalBytes)}`
    : downloadState.downloadedBytes > 0
      ? `已下载 ${formatByteSize(downloadState.downloadedBytes)}`
      : null;
  const prefix = downloadState.fileName ? `${downloadState.fileName} · ` : "";
  const message = downloadState.message ?? phaseMessage(downloadState.phase);
  return `${prefix}${message}${
    amount && (downloadState.phase === "downloading" || downloadState.phase === "completed") ? `（${amount}）` : ""
  }`;
}
