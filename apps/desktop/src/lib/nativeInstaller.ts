import { isNativeDesktop, listenNative as listen } from "./nativeBridge";
import { isAndroidPlatform, loadInvoke } from "./nativeEnvironment";
import { readRuntimeProgressString, readRuntimeProgressNumber, readRuntimeProgressNullableNumber } from "./nativeDownloadProgress";

export type DesktopUpdateDownloadPhase =
  | "idle"
  | "preparing"
  | "downloading"
  | "verifying"
  | "completed"
  | "failed";

export type DesktopUpdateDownloadProgress = {
  phase: DesktopUpdateDownloadPhase;
  fileName: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  localPath: string | null;
  message: string | null;
};

export type DesktopInstallerDownloadResult = {
  fileName: string;
  localPath: string;
  totalBytes: number | null;
};

type DesktopUpdateDownloadProgressPayload = {
  phase?: DesktopUpdateDownloadPhase | string | null;
  fileName?: string | null;
  file_name?: string | null;
  downloadedBytes?: number | string | null;
  downloaded_bytes?: number | string | null;
  totalBytes?: number | string | null;
  total_bytes?: number | string | null;
  localPath?: string | null;
  local_path?: string | null;
  message?: string | null;
};

export async function subscribeDesktopUpdateDownloadProgress(
  handler: (progress: DesktopUpdateDownloadProgress) => void
) {
  if (!isNativeDesktop() || isAndroidPlatform()) {
    return () => {};
  }
  const unlisten = await listen<DesktopUpdateDownloadProgressPayload>("chordv://update-download-progress", (event) => {
    if (event.payload) {
      handler(normalizeDesktopUpdateDownloadProgress(event.payload));
    }
  });
  return () => {
    unlisten();
  };
}

export async function downloadDesktopInstaller(input: {
  expectedVersion?: string;
  fileName?: string | null;
  url?: string;
  urls?: string[];
  sha256?: string;
  fileSizeBytes?: number | null;
  signature?: string | null;
  minBytesPerSecond?: number | null;
  packageKind?: "installer";
  currentVersion?: string | null;
  channel?: string | null;
  preferredCandidate?: "fastest" | "mirror" | "origin";
  onProgress?: (progress: DesktopUpdateDownloadProgress) => void;
}) {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return null;
  }
  const commandInput: Record<string, unknown> = {
    fileName: input.fileName,
    url: input.url,
    urls: input.urls,
    sha256: input.sha256,
    fileSizeBytes: input.fileSizeBytes,
    signature: input.signature,
    minBytesPerSecond: input.minBytesPerSecond,
    expectedVersion: input.expectedVersion,
    packageKind: input.packageKind,
    currentVersion: input.currentVersion,
    channel: input.channel,
    preferredCandidate: input.preferredCandidate
  };
  const stopProgress = input.onProgress
    ? await subscribeDesktopUpdateDownloadProgress((progress) => {
        if (!input.fileName || !progress.fileName || progress.fileName === input.fileName) input.onProgress?.(progress);
      })
    : () => {};
  try {
    return await invoke<DesktopInstallerDownloadResult>("download_desktop_installer", { input: commandInput });
  } finally {
    stopProgress();
  }
}

function normalizeDesktopUpdateDownloadProgress(
  payload: DesktopUpdateDownloadProgressPayload
): DesktopUpdateDownloadProgress {
  return {
    phase: readDesktopUpdateProgressPhase(payload.phase),
    fileName: readRuntimeProgressString(payload.fileName) ?? readRuntimeProgressString(payload.file_name),
    downloadedBytes: readRuntimeProgressNumber(payload.downloadedBytes, payload.downloaded_bytes),
    totalBytes: readRuntimeProgressNullableNumber(payload.totalBytes, payload.total_bytes),
    localPath: readRuntimeProgressString(payload.localPath) ?? readRuntimeProgressString(payload.local_path),
    message: readRuntimeProgressString(payload.message)
  };
}

function readDesktopUpdateProgressPhase(value: unknown): DesktopUpdateDownloadPhase {
  if (value === "preparing") return "preparing";
  if (value === "downloading") return "downloading";
  if (value === "verifying") return "verifying";
  if (value === "completed") return "completed";
  if (value === "failed") return "failed";
  return "idle";
}

export async function openDesktopInstaller(path: string) {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return { ok: false as const };
  }
  return invoke<{ ok: boolean }>("open_desktop_installer", { path });
}

export async function installWindowsUpdate(_input?: {
  path?: string;
  expectedTotalBytes?: number | null;
  expectedHash?: string | null;
}) {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return { ok: false as const };
  }
  // Path/hash must come from native pending state created by a verified download.
  return invoke<{ ok: boolean }>("install_windows_update");
}

export async function quitForUpdate() {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return { ok: false as const };
  }
  return invoke<{ ok: boolean }>("quit_for_update");
}

export async function cancelPreparedDesktopUpdate() {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) return { ok: false as const };
  return invoke<{ ok: boolean }>("cancel_desktop_update_install");
}

export type DesktopUpdateInstallReport = {
  ok: boolean;
  platform: string;
  mode: string;
  summary: string | null;
  detail: string | null;
  logPath: string | null;
  createdAt: string | null;
  recoveryPending?: true;
};

export async function consumeDesktopUpdateInstallReport() {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return null;
  }
  return invoke<DesktopUpdateInstallReport | { state: "pending_recovery" } | null>("consume_desktop_update_install_report");
}
