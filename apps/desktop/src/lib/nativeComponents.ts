import type { DownloadProbeResult } from "./downloadMirrorRanking";
import type { RuntimeComponentDownloadItem, RuntimeComponentDownloadProgress, RuntimeComponentFileStatus, RuntimeComponentKind } from "./runtimeComponents";
import type { RuntimeComponentLocalInfo } from "./geoUpdate";
import type { LocalFileEntry, LocalFileKind } from "./localFiles";
import type { RuntimePlatform } from "./nativeRuntime";
import { invokeNative, isNativeDesktop, listenNative as listen } from "./nativeBridge";
import { isAndroidPlatform, loadInvoke } from "./nativeEnvironment";
import { readRuntimeProgressString, readRuntimeProgressNumber, readRuntimeProgressNullableNumber } from "./nativeDownloadProgress";

export type DesktopRuntimeEnvironment = {
  platform: Extract<RuntimePlatform, "macos" | "windows">;
  architecture: "x64" | "arm64";
  runtimeBinDir: string | null;
};

export type BundledRuntimeComponentsStatus = {
  ready: boolean;
  runtimeBinDir: string | null;
  copiedComponents: string[];
  missingComponents: string[];
  message: string | null;
};

export type RemoteTextFetchResult = {
  link?: string;
  url: string;
  status: number;
  body: string;
};

export type RuntimeComponentDownloadResult = {
  component: string;
  localPath: string | null;
};

type RuntimeComponentDownloadProgressPayload = {
  phase?: RuntimeComponentDownloadProgress["phase"] | string | null;
  component?: RuntimeComponentDownloadProgress["component"] | string | null;
  fileName?: string | null;
  file_name?: string | null;
  downloadedBytes?: number | string | null;
  downloaded_bytes?: number | string | null;
  totalBytes?: number | string | null;
  total_bytes?: number | string | null;
  message?: string | null;
};

export async function loadDesktopRuntimeEnvironment() {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return null;
  }
  return invoke<DesktopRuntimeEnvironment>("desktop_runtime_environment");
}

export async function checkRuntimeComponentFile(component: RuntimeComponentDownloadItem) {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return null;
  }
  return invoke<RuntimeComponentFileStatus>("check_runtime_component_file", { component });
}

export async function ensureBundledRuntimeComponents() {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return null;
  }
  return invoke<BundledRuntimeComponentsStatus>("ensure_bundled_runtime_components");
}

export async function downloadRuntimeComponent(input: {
  component: RuntimeComponentDownloadItem;
  url: string;
  minBytesPerSecond?: number | null;
}) {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return null;
  }
  return invoke<RuntimeComponentDownloadResult>("download_runtime_component", { input });
}

/** Measures each mirror with a short ranged request; returns fastest first. Empty when unsupported. */
export async function probeDownloadCandidates(urls: string[]) {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform() || urls.length === 0) {
    return [] as DownloadProbeResult[];
  }
  return invoke<DownloadProbeResult[]>("probe_download_candidates", { urls });
}

export async function cancelRuntimeComponentDownload() {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return false;
  }
  await invoke("cancel_runtime_component_download");
  return true;
}

export async function getRuntimeComponentLocalInfo(component: RuntimeComponentKind) {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return null;
  }
  return invoke<RuntimeComponentLocalInfo>("get_runtime_component_local_info", { component });
}

/** 本地文件位置：路径由原生端解析，前端不拼接路径。 */
export async function listLocalFileLocations() {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return null;
  }
  return invoke<LocalFileEntry[]>("list_local_file_locations");
}

/** 只传固定条目，原生端自行解析并校验路径位于应用数据目录内。 */
export async function revealLocalFile(kind: LocalFileKind) {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return false;
  }
  await invoke("reveal_local_file", { kind });
  return true;
}

export async function fetchRemoteText(url: string) {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return null;
  }
  return invoke<RemoteTextFetchResult>("fetch_remote_text", { url });
}

export async function subscribeRuntimeComponentDownloadProgress(
  handler: (progress: RuntimeComponentDownloadProgress) => void
) {
  if (!isNativeDesktop() || isAndroidPlatform()) {
    return () => {};
  }
  const unlisten = await listen<RuntimeComponentDownloadProgressPayload>(
    "chordv://runtime-component-download-progress",
    (event) => {
      if (event.payload) {
        handler(normalizeRuntimeComponentDownloadProgress(event.payload));
      }
    }
  );
  return () => {
    unlisten();
  };
}

function normalizeRuntimeComponentDownloadProgress(
  payload: RuntimeComponentDownloadProgressPayload
): RuntimeComponentDownloadProgress {
  const phase = readRuntimeProgressPhase(payload.phase);
  const component = readRuntimeProgressComponent(payload.component);
  const fileName = readRuntimeProgressString(payload.fileName) ?? readRuntimeProgressString(payload.file_name);
  const downloadedBytes = readRuntimeProgressNumber(payload.downloadedBytes, payload.downloaded_bytes);
  const totalBytes = readRuntimeProgressNullableNumber(payload.totalBytes, payload.total_bytes);
  const message = readRuntimeProgressString(payload.message);
  return {
    phase,
    component,
    fileName,
    downloadedBytes,
    totalBytes,
    message
  };
}

function readRuntimeProgressPhase(value: unknown): RuntimeComponentDownloadProgress["phase"] {
  if (value === "preparing") return "preparing";
  if (value === "downloading") return "downloading";
  if (value === "verifying") return "verifying";
  if (value === "extracting") return "extracting";
  if (value === "completed") return "completed";
  if (value === "failed") return "failed";
  return "preparing";
}

function readRuntimeProgressComponent(value: unknown): RuntimeComponentDownloadProgress["component"] {
  if (value === "xray") return "xray";
  if (value === "geoip") return "geoip";
  if (value === "geosite") return "geosite";
  return "xray";
}

export async function verifyReleaseManifestSignature(input: { manifest: string; signature: string; publicKey: string }) {
  return invokeNative<boolean>("verify_release_manifest_signature", input);
}

export async function authorizeReleaseManifest(input: { manifest: string; signature?: string; tag: string }) {
  return invokeNative("authorize_release_manifest", input);
}
