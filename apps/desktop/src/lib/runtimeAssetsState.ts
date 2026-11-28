import type { RuntimeStatus } from "./runtime";
import { isRuntimeComponentVerified, type RuntimeComponentLocalInfo } from "./geoUpdate";
import { createIdleRuntimeAssetsState } from "./runtimeComponents";
import type {
  RuntimeAssetsUiState,
  RuntimeComponentDownloadItem,
  RuntimeComponentDownloadProgress,
  RuntimeDownloadFailureReason
} from "./runtimeComponents";

export function resolveRuntimePlanPlatform(platformTarget: RuntimeStatus["platformTarget"]): "macos" | "windows" {
  return platformTarget === "windows" ? "windows" : "macos";
}

export function resolveRuntimeComponentCandidate(component: RuntimeComponentDownloadItem) {
  const selectedCandidate =
    component.candidates.find((candidate) => candidate.url === component.selectedUrl) ?? component.candidates[0];
  return selectedCandidate ? { url: selectedCandidate.url, source: selectedCandidate.source } : null;
}

/** 缺少发布来源是安装前置条件，不是已经发生过的下载失败。 */
export function resolveUnconfiguredRuntimeAssets(input: {
  local: Record<"xray" | "geoip" | "geosite", RuntimeComponentLocalInfo | null>;
  xrayVersion: string | null;
  geoVersion: string | null;
  blocking: boolean;
}) {
  const xrayInstalled = isRuntimeComponentVerified(input.local.xray);
  const geoInstalled = isRuntimeComponentVerified(input.local.geoip) && isRuntimeComponentVerified(input.local.geosite);
  const invalid = (component: RuntimeComponentLocalInfo | null) => component?.exists === true && !isRuntimeComponentVerified(component);
  const xrayInvalid = invalid(input.local.xray);
  const geoInvalid = invalid(input.local.geoip) || invalid(input.local.geosite);
  const ready = xrayInstalled && geoInstalled;
  const state: RuntimeAssetsUiState = {
    ...createIdleRuntimeAssetsState(), phase: ready ? "ready" : "unconfigured",
    message: ready ? "未配置组件来源，继续使用已安装组件。" : xrayInvalid || geoInvalid ? "未配置组件来源，本地组件校验或安装记录未通过。" : "未配置组件来源，本地组件尚未完整安装。",
    blocking: !ready && input.blocking
  };
  return {
    ready, state, sourceConfigured: false as const, current: false,
    xray: { localVersion: xrayInstalled ? input.xrayVersion ?? "已安装" : null, remoteVersion: null,
      current: false, available: false, message: xrayInstalled ? "未配置组件来源，继续使用本地 Xray。" : xrayInvalid ? "未配置组件来源，Xray 本地校验或安装记录未通过。" : "未配置组件来源，Xray 内核未安装。" },
    geo: { localVersion: geoInstalled ? input.geoVersion ?? "已安装" : null, remoteVersion: null,
      current: false, available: false, message: geoInstalled ? "未配置组件来源，继续使用本地 GEO 数据。" : geoInvalid ? "未配置组件来源，GEO 本地校验或安装记录未通过。" : "未配置组件来源，GEO 数据未完整安装。" }
  };
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
  if (phase === "downloading" && nextDownloadedBytes === 0) {
    return 0;
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
  if (phase === "preparing" || phase === "downloading" || phase === "verifying" || phase === "extracting") {
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
    downloadStage: progress.phase,
    currentComponent: progress.component,
    fileName: progress.fileName ?? current.fileName,
    downloadedBytes,
    totalBytes,
    message: resolveRuntimeAssetsProgressMessage(progress, phase, downloadedBytes, totalBytes, current.message),
    errorCode: progress.phase === "failed" ? current.errorCode : null,
    errorMessage: progress.phase === "failed" ? progress.message ?? current.errorMessage : null,
    blocking: phase === "ready" ? false : current.blocking
  };
}

export function extractRuntimeAssetsErrorCode(message: string): RuntimeDownloadFailureReason {
  if (message.includes("mac_update_pending:")) return "mac_update_pending";
  const prefixed = message.match(/^runtime_component_error:([a-z_]+):/i);
  if (prefixed?.[1]) {
    return prefixed[1] as RuntimeDownloadFailureReason;
  }
  if (message.includes("hash")) {
    return "download_failed";
  }
  if (message.includes("extract")) {
    return "extract_failed";
  }
  if (message.includes("write")) {
    return "write_failed";
  }
  if (message.includes("cancel") || message.includes("取消")) {
    return "download_cancelled";
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

/** Clear a previous background warning only after a retry confirms usable, current components. */
export function isSuccessfulComponentSync(success: boolean, summary: {
  checked: boolean;
  failed: readonly string[];
  xray: { current: boolean; available: boolean };
  geo: { current: boolean; available: boolean };
} | null): boolean {
  return Boolean(success && summary?.checked && summary.failed.length === 0
    && summary.xray.current && !summary.xray.available
    && summary.geo.current && !summary.geo.available);
}
