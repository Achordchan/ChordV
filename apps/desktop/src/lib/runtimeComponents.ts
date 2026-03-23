import type { PlatformTarget } from "@chordv/shared";

export type RuntimeComponentKind = "xray" | "geoip" | "geosite";
export type RuntimeComponentArchitecture = "x64" | "arm64";
export type RuntimeComponentSourceFormat = "direct" | "zip_entry";

export type RuntimeComponentDownloadCandidate = {
  label: string;
  url: string;
  source: "client_override" | "server_mirror" | "origin";
};

export type RuntimeComponentDownloadItem = {
  id: string;
  component: RuntimeComponentKind;
  fileName: string;
  sourceFormat: RuntimeComponentSourceFormat;
  archiveEntryName: string | null;
  checksumSha256: string | null;
  candidates: RuntimeComponentDownloadCandidate[];
  selectedUrl: string | null;
  displayName: string;
};

export type ClientRuntimeComponentsPlan = {
  platform: Extract<PlatformTarget, "macos" | "windows">;
  architecture: RuntimeComponentArchitecture;
  allowClientMirrorOverride: boolean;
  defaultMirrorPrefix: string | null;
  components: RuntimeComponentDownloadItem[];
};

export type RuntimeDownloadFailureReason =
  | "plan_missing"
  | "plan_fetch_failed"
  | "component_missing"
  | "component_invalid"
  | "download_failed"
  | "extract_failed"
  | "write_failed"
  | "hash_mismatch"
  | "unknown";

export type RuntimeComponentFailureReportInput = {
  componentId?: string | null;
  component: RuntimeComponentKind;
  platform: Extract<PlatformTarget, "macos" | "windows">;
  architecture: RuntimeComponentArchitecture;
  failureReason: RuntimeDownloadFailureReason;
  message?: string | null;
  effectiveUrl?: string | null;
  appVersion?: string | null;
};

export type RuntimeComponentDownloadProgress = {
  phase: "preparing" | "downloading" | "extracting" | "completed" | "failed";
  component: RuntimeComponentKind;
  fileName: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  message: string | null;
};

export type RuntimeComponentFileStatus = {
  ready: boolean;
  exists: boolean;
  path: string | null;
  reasonCode: string | null;
  message: string | null;
};

export type RuntimeAssetsUiState = {
  phase: "idle" | "checking" | "downloading" | "ready" | "failed";
  currentComponent: RuntimeComponentKind | null;
  fileName: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  message: string | null;
  errorCode: RuntimeDownloadFailureReason | null;
  errorMessage: string | null;
  blocking: boolean;
};

export function createIdleRuntimeAssetsState(): RuntimeAssetsUiState {
  return {
    phase: "idle",
    currentComponent: null,
    fileName: null,
    downloadedBytes: 0,
    totalBytes: null,
    message: null,
    errorCode: null,
    errorMessage: null,
    blocking: false
  };
}

export function resolveRuntimeAssetsTone(
  phase: RuntimeAssetsUiState["phase"]
): "neutral" | "info" | "warning" | "danger" | "success" {
  if (phase === "checking" || phase === "downloading") {
    return "info";
  }
  if (phase === "failed") {
    return "danger";
  }
  if (phase === "ready") {
    return "success";
  }
  return "neutral";
}

export function formatRuntimeAssetsTitle(state: RuntimeAssetsUiState) {
  if (state.phase === "checking") {
    return "正在检查必要内核组件";
  }
  if (state.phase === "downloading") {
    return "正在下载必要内核组件";
  }
  if (state.phase === "failed") {
    return "必要内核组件暂未就绪";
  }
  if (state.phase === "ready") {
    return "必要内核组件已准备完成";
  }
  return "必要内核组件";
}

export function formatRuntimeAssetsMessage(state: RuntimeAssetsUiState) {
  if (state.phase === "checking") {
    return state.message ?? "正在检查连接所需组件，请稍候。";
  }
  if (state.phase === "downloading") {
    return state.message ?? "正在准备连接所需组件，完成后即可继续使用。";
  }
  if (state.phase === "failed") {
    return state.errorMessage ?? "必要内核组件下载失败，当前暂时不能连接。";
  }
  if (state.phase === "ready") {
    return "连接所需组件已准备完成。";
  }
  return "当前会在启动时自动检查并准备连接所需组件。";
}
