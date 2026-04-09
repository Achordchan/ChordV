import type { RuntimeStatus } from "./runtime";
import type {
  RuntimeAssetsUiState,
  RuntimeComponentDownloadItem,
  RuntimeComponentDownloadProgress,
  RuntimeDownloadFailureReason
} from "./runtimeComponents";

export function resolveRuntimePlanPlatform(platformTarget: RuntimeStatus["platformTarget"]): "macos" | "windows" {
  return platformTarget === "windows" ? "windows" : "macos";
}

export function trimRuntimeMirrorPrefix(value: string) {
  return value.replace(/\/+$/, "");
}

export function resolveRuntimeComponentCandidate(component: RuntimeComponentDownloadItem, customPrefix: string) {
  const normalizedPrefix = customPrefix.trim();
  if (normalizedPrefix) {
    const originCandidate = component.candidates.find((candidate) => candidate.source === "origin") ?? component.candidates[0];
    if (originCandidate?.url) {
      return {
        url: `${trimRuntimeMirrorPrefix(normalizedPrefix)}/${originCandidate.url}`,
        source: "client_override" as const
      };
    }
  }
  const selectedCandidate =
    component.candidates.find((candidate) => candidate.url === component.selectedUrl) ?? component.candidates[0];
  return selectedCandidate ? { url: selectedCandidate.url, source: selectedCandidate.source } : null;
}

export function canOpenRuntimeAssetsDialog(
  forceUpdateRequired: boolean,
  forcedAnnouncementActive: boolean,
  updateDialogOpened: boolean,
  announcementDrawerOpened: boolean,
  updateDownloadPhase: "idle" | "preparing" | "downloading" | "completed" | "failed"
) {
  if (forcedAnnouncementActive) {
    return false;
  }
  if (updateDialogOpened) {
    return false;
  }
  if (updateDownloadPhase === "preparing" || updateDownloadPhase === "downloading") {
    return false;
  }
  if (announcementDrawerOpened) {
    return false;
  }
  return !forceUpdateRequired;
}

function hasKnownTotalBytes(totalBytes: number | null): totalBytes is number {
  return typeof totalBytes === "number" && Number.isFinite(totalBytes) && totalBytes > 0;
}

function mergeKnownTotalBytes(currentTotalBytes: number | null, nextTotalBytes: number | null) {
  if (hasKnownTotalBytes(nextTotalBytes)) {
    return nextTotalBytes;
  }
  return currentTotalBytes;
}

export function normalizeRuntimeAssetsDownloadedBytes(
  currentDownloadedBytes: number,
  nextDownloadedBytes: number,
  phase: RuntimeAssetsUiState["phase"]
) {
  if (phase === "failed") {
    return currentDownloadedBytes;
  }
  if (!Number.isFinite(nextDownloadedBytes) || nextDownloadedBytes < 0) {
    return currentDownloadedBytes;
  }
  return Math.max(currentDownloadedBytes, nextDownloadedBytes);
}

export function normalizeRuntimeAssetsPhase(
  phase: RuntimeComponentDownloadProgress["phase"],
  current: RuntimeAssetsUiState
): RuntimeAssetsUiState["phase"] {
  if (phase === "failed") {
    return "failed";
  }
  if (phase === "completed") {
    return "completed";
  }
  if (phase === "preparing" || phase === "downloading" || phase === "extracting") {
    return "downloading";
  }
  if (current.phase === "completed") {
    return "completed";
  }
  return "checking";
}

export function resolveRuntimeAssetsProgressMessage(
  progress: RuntimeComponentDownloadProgress,
  phase: RuntimeAssetsUiState["phase"],
  downloadedBytes: number,
  totalBytes: number | null,
  fallbackMessage: string | null
) {
  if (progress.message?.trim()) {
    return progress.message;
  }
  if (phase === "downloading") {
    if (progress.phase === "extracting") {
      return "正在写入并校验组件文件…";
    }
    if (!totalBytes || totalBytes <= 0) {
      if (downloadedBytes > 0) {
        return "已连接下载源，正在持续接收数据…";
      }
      return "正在建立下载连接…";
    }
  }
  return fallbackMessage;
}

export function normalizeRuntimeAssetsProgress(
  current: RuntimeAssetsUiState,
  progress: RuntimeComponentDownloadProgress
): RuntimeAssetsUiState {
  const sameComponent = current.currentComponent === progress.component;
  const phase = normalizeRuntimeAssetsPhase(progress.phase, current);
  const downloadedBytes = sameComponent
    ? normalizeRuntimeAssetsDownloadedBytes(current.downloadedBytes, progress.downloadedBytes, phase)
    : normalizeRuntimeAssetsDownloadedBytes(0, progress.downloadedBytes, phase);
  const mergedTotalBytes = sameComponent ? mergeKnownTotalBytes(current.totalBytes, progress.totalBytes) : progress.totalBytes;
  const totalBytes = phase === "completed" && !hasKnownTotalBytes(mergedTotalBytes) && downloadedBytes > 0 ? downloadedBytes : mergedTotalBytes;
  return {
    phase,
    currentComponent: progress.component,
    fileName: progress.fileName ?? current.fileName,
    downloadedBytes,
    totalBytes,
    message: resolveRuntimeAssetsProgressMessage(progress, phase, downloadedBytes, totalBytes, current.message),
    errorCode: progress.phase === "failed" ? current.errorCode : null,
    errorMessage: progress.phase === "failed" ? progress.message ?? current.errorMessage : null,
    blocking: phase !== "ready"
  };
}

export function extractRuntimeAssetsErrorCode(message: string): RuntimeDownloadFailureReason {
  const prefixed = message.match(/^runtime_component_error:([a-z_]+):/i);
  if (prefixed?.[1]) {
    return prefixed[1] as RuntimeDownloadFailureReason;
  }
  if (message.includes("hash")) {
    return "hash_mismatch";
  }
  if (message.includes("extract")) {
    return "extract_failed";
  }
  if (message.includes("write")) {
    return "write_failed";
  }
  if (message.includes("download")) {
    return "download_failed";
  }
  if (message.includes("not found") || message.includes("404")) {
    return "component_missing";
  }
  return "unknown";
}

export function stripRuntimeAssetsErrorPrefix(message: string) {
  return message.replace(/^runtime_component_error:[a-z_]+:/i, "").trim();
}
