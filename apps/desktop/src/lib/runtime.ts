import type {
  AuthSessionDto,
  ClientNodeProbeResultDto,
  GeneratedRuntimeConfigDto,
  PlatformTarget
} from "@chordv/shared";
import type {
  RuntimeComponentDownloadItem,
  RuntimeComponentDownloadProgress,
  RuntimeComponentFileStatus
} from "./runtimeComponents";

export type RuntimeStatus = {
  status: string;
  activeSessionId: string | null;
  configPath: string | null;
  logPath: string | null;
  xrayBinaryPath: string | null;
  activePid: number | null;
  lastError: string | null;
  platformTarget: RuntimePlatform;
  activeNodeId?: string | null;
  tunName?: string | null;
  lastStartedAt?: string | null;
  reasonCode?: string | null;
  recoveryHint?: string | null;
  vpnActive?: boolean | null;
  connectivityVerified?: boolean | null;
};

export type RuntimeLogs = {
  log: string;
};

export type RuntimeNodeProbeResult = ClientNodeProbeResultDto;

export type RuntimePlatform = PlatformTarget | "web";

type AndroidRuntimeStatus = {
  status: string;
  activeSessionId: string | null;
  activeNodeId: string | null;
  configPath: string | null;
  tunName: string | null;
  lastError: string | null;
  lastStartedAt: string | null;
  reasonCode?: string | null;
  recoveryHint?: string | null;
  vpnActive?: boolean | null;
  connectivityVerified?: boolean | null;
};

export type ShellAction = "toggle-connection" | "open-logs";

type ShellActionPayload = {
  action: ShellAction;
};

export type DesktopUpdateDownloadPhase =
  | "idle"
  | "preparing"
  | "downloading"
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

export type DesktopRuntimeEnvironment = {
  platform: Extract<RuntimePlatform, "macos" | "windows">;
  architecture: "x64" | "arm64";
  runtimeBinDir: string | null;
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
  downloadedBytes?: number | null;
  downloaded_bytes?: number | null;
  totalBytes?: number | null;
  total_bytes?: number | null;
  message?: string | null;
};

export type DesktopShellSummary = {
  status: string;
  signedIn?: boolean;
  nodeName: string | null;
  primaryActionLabel: string;
};

export type NativeLeaseHeartbeatEvent = {
  sessionId: string;
  status: "ok" | "error";
  leaseExpiresAt: string | null;
  reasonCode: string | null;
  message: string | null;
};

function isTauriApp() {
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

function isAndroidPlatform() {
  return /android/i.test(window.navigator.userAgent);
}

function isIosPlatform() {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}

export function detectRuntimePlatform(): RuntimePlatform {
  if (!isTauriApp()) {
    return "web";
  }
  if (isAndroidPlatform()) {
    return "android";
  }
  if (isIosPlatform()) {
    return "ios";
  }
  if (/windows/i.test(window.navigator.userAgent)) {
    return "windows";
  }
  return "macos";
}

export function createIdleRuntimeStatus(platformTarget = detectRuntimePlatform()): RuntimeStatus {
  return {
    status: "idle",
    activeSessionId: null,
    configPath: null,
    logPath: null,
    xrayBinaryPath: null,
    activePid: null,
    lastError: null,
    platformTarget,
    activeNodeId: null,
    tunName: null,
    lastStartedAt: null,
    reasonCode: null,
    recoveryHint: null,
    vpnActive: null,
    connectivityVerified: null
  };
}

async function loadInvoke() {
  if (!isTauriApp()) {
    return null;
  }

  const module = await import("@tauri-apps/api/core");
  return module.invoke;
}

export async function connectRuntime(config: GeneratedRuntimeConfigDto) {
  const invoke = await loadInvoke();
  if (!invoke) {
    return { ok: true, mocked: true };
  }

  if (isAndroidPlatform()) {
    return invoke("start_android_runtime", { config });
  }

  return invoke("connect_runtime", { config });
}

export async function disconnectRuntime() {
  const invoke = await loadInvoke();
  if (!invoke) {
    return { ok: true, mocked: true };
  }

  if (isAndroidPlatform()) {
    return invoke("stop_android_runtime");
  }

  return invoke("disconnect_runtime");
}

export async function ensureRuntimeStopped() {
  try {
    await disconnectRuntime();
  } catch {
    return {
      ok: false as const
    };
  }

  return {
    ok: true as const
  };
}

export async function loadRuntimeStatus(): Promise<RuntimeStatus> {
  const platformTarget = detectRuntimePlatform();
  const invoke = await loadInvoke();
  if (!invoke) {
    return createIdleRuntimeStatus(platformTarget);
  }

  if (isAndroidPlatform()) {
    const status = await invoke<AndroidRuntimeStatus>("android_runtime_status");
    return {
      status: status.status,
      activeSessionId: status.activeSessionId,
      configPath: status.configPath,
      logPath: null,
      xrayBinaryPath: null,
      activePid: null,
      lastError: status.lastError,
      platformTarget,
      activeNodeId: status.activeNodeId,
      tunName: status.tunName,
      lastStartedAt: status.lastStartedAt,
      reasonCode: status.reasonCode ?? null,
      recoveryHint: status.recoveryHint ?? null,
      vpnActive: status.vpnActive ?? null,
      connectivityVerified: status.connectivityVerified ?? null
    };
  }

  const status = await invoke<Omit<RuntimeStatus, "platformTarget">>("runtime_status");
  return {
    ...status,
    platformTarget,
    activeNodeId: status.activeNodeId ?? null,
    tunName: status.tunName ?? null,
    lastStartedAt: status.lastStartedAt ?? null,
    reasonCode: status.reasonCode ?? null,
    recoveryHint: status.recoveryHint ?? null,
    vpnActive: status.vpnActive ?? null,
    connectivityVerified: status.connectivityVerified ?? null
  };
}

export async function loadRuntimeLogs(): Promise<RuntimeLogs> {
  const invoke = await loadInvoke();
  if (!invoke) {
    return {
      log: ""
    };
  }

  if (isAndroidPlatform()) {
    return {
      log: ""
    };
  }

  return invoke("runtime_logs");
}

export async function loadRuntimeSnapshot(): Promise<GeneratedRuntimeConfigDto | null> {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return null;
  }

  const response = await invoke<{ runtime: GeneratedRuntimeConfigDto | null }>("runtime_snapshot");
  return response.runtime ?? null;
}

export const loadActiveRuntimeConfig = loadRuntimeSnapshot;

export async function focusDesktopWindow() {
  if (!isTauriApp()) {
    window.focus();
    return;
  }

  if (isAndroidPlatform()) {
    window.focus();
    return;
  }

  try {
    const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window");
    const currentWindow = getCurrentWindow();
    await currentWindow.requestUserAttention(UserAttentionType.Critical).catch(() => null);
    await currentWindow.show().catch(() => null);
    await currentWindow.setFocus();
  } catch {
    window.focus();
  }
}

export async function appReady() {
  const invoke = await loadInvoke();
  if (!invoke) {
    return { ok: true, mocked: true };
  }

  return invoke("app_ready");
}

export async function showDesktopWindow() {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return { ok: true, mocked: true };
  }
  return invoke("show_main_window");
}

export async function hideDesktopWindow() {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return { ok: true, mocked: true };
  }
  return invoke("hide_main_window");
}

export async function quitDesktopApplication() {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return { ok: true, mocked: true };
  }
  return invoke("quit_application");
}

export async function updateDesktopShellSummary(summary: DesktopShellSummary) {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return { ok: true, mocked: true };
  }
  return invoke("update_shell_summary", { summary });
}

export async function subscribeDesktopShellActions(handler: (action: ShellAction) => void) {
  if (!isTauriApp() || isAndroidPlatform()) {
    return () => {};
  }
  const { listen } = await import("@tauri-apps/api/event");
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  let lastActionKey: string | null = null;
  let lastActionAt = 0;

  const handlePayload = (payload?: ShellActionPayload) => {
    if (!payload?.action) {
      return;
    }
    const nowMs = Date.now();
    const key = payload.action;
    if (lastActionKey === key && nowMs - lastActionAt < 200) {
      return;
    }
    lastActionKey = key;
    lastActionAt = nowMs;
    handler(payload.action);
  };

  const unlistenApp = await listen<ShellActionPayload>("chordv://shell-action", (event) => {
    handlePayload(event.payload);
  });
  const currentWindow = getCurrentWindow();
  const unlistenWindow = await currentWindow.listen<ShellActionPayload>("chordv://shell-action", (event) => {
    handlePayload(event.payload);
  });
  const domListener = (event: Event) => {
    const customEvent = event as CustomEvent<ShellActionPayload | undefined>;
    handlePayload(customEvent.detail);
  };
  window.addEventListener("chordv-shell-action", domListener as EventListener);

  return () => {
    unlistenApp();
    unlistenWindow();
    window.removeEventListener("chordv-shell-action", domListener as EventListener);
  };
}

export async function subscribeDesktopUpdateDownloadProgress(
  handler: (progress: DesktopUpdateDownloadProgress) => void
) {
  if (!isTauriApp() || isAndroidPlatform()) {
    return () => {};
  }
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<DesktopUpdateDownloadProgress>("chordv://update-download-progress", (event) => {
    if (event.payload) {
      handler(event.payload);
    }
  });
  return () => {
    unlisten();
  };
}

export async function downloadDesktopInstaller(input: {
  url: string;
  fileName?: string | null;
  expectedTotalBytes?: number | null;
  expectedHash?: string | null;
}) {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return null;
  }
  return invoke<DesktopInstallerDownloadResult>("download_desktop_installer", { input });
}

export async function openDesktopInstaller(path: string) {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return { ok: false as const };
  }
  return invoke("open_desktop_installer", { path });
}

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

export async function downloadRuntimeComponent(input: {
  component: RuntimeComponentDownloadItem;
  url: string;
}) {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return null;
  }
  return invoke<RuntimeComponentDownloadResult>("download_runtime_component", { input });
}

export async function subscribeRuntimeComponentDownloadProgress(
  handler: (progress: RuntimeComponentDownloadProgress) => void
) {
  if (!isTauriApp() || isAndroidPlatform()) {
    return () => {};
  }
  const { listen } = await import("@tauri-apps/api/event");
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

function readRuntimeProgressString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function readRuntimeProgressNumber(primary: unknown, fallback: unknown) {
  const candidate = Number.isFinite(primary) ? Number(primary) : Number.isFinite(fallback) ? Number(fallback) : 0;
  if (candidate < 0) {
    return 0;
  }
  return candidate;
}

function readRuntimeProgressNullableNumber(primary: unknown, fallback: unknown) {
  const value = Number.isFinite(primary) ? Number(primary) : Number.isFinite(fallback) ? Number(fallback) : null;
  if (value === null || value <= 0) {
    return null;
  }
  return value;
}

function readRuntimeProgressPhase(value: unknown): RuntimeComponentDownloadProgress["phase"] {
  if (value === "preparing") return "preparing";
  if (value === "downloading") return "downloading";
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

export async function subscribeNativeLeaseHeartbeat(handler: (event: NativeLeaseHeartbeatEvent) => void) {
  if (!isTauriApp() || isAndroidPlatform()) {
    return () => {};
  }
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<NativeLeaseHeartbeatEvent>("chordv://native-lease-heartbeat", (event) => {
    if (event.payload) {
      handler(event.payload);
    }
  });
  return () => {
    unlisten();
  };
}

export async function subscribeNativeSessionRefreshed(handler: (session: AuthSessionDto) => void) {
  if (!isTauriApp() || isAndroidPlatform()) {
    return () => {};
  }
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<AuthSessionDto>("chordv://native-session-refreshed", (event) => {
    if (event.payload) {
      handler(event.payload);
    }
  });
  return () => {
    unlisten();
  };
}

export async function openExternalLink(url: string) {
  if (!url) {
    return { ok: false as const };
  }

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.click();
  return { ok: true as const, method: "browser" as const };
}

export async function loadStoredSession(): Promise<AuthSessionDto | null> {
  const invoke = await loadInvoke();
  if (!invoke) {
    return null;
  }

  return invoke("load_session");
}

export async function saveStoredSession(session: AuthSessionDto) {
  const invoke = await loadInvoke();
  if (!invoke) {
    return { ok: true, mocked: true };
  }

  return invoke("save_session", { session });
}

export async function refreshStoredSessionNative(refreshToken?: string | null) {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return null;
  }

  return invoke<AuthSessionDto>("refresh_session_native", {
    refreshToken: refreshToken ?? null
  });
}

export async function clearStoredSession() {
  const invoke = await loadInvoke();
  if (!invoke) {
    return { ok: true, mocked: true };
  }

  return invoke("clear_session");
}

export function hasActiveRuntime(status: RuntimeStatus | null | undefined) {
  if (!status) {
    return false;
  }

  return (
    status.status === "connected" ||
    status.status === "connecting" ||
    status.status === "disconnecting" ||
    status.status === "error" ||
    Boolean(status.activeSessionId) ||
    Boolean(status.activePid)
  );
}

export function hasActivePlatformRuntime(status: RuntimeStatus | null | undefined) {
  if (!status) {
    return false;
  }

  return hasActiveRuntime(status) || Boolean(status.tunName);
}

export type DesktopRuntimeStatus = RuntimeStatus;
export type DesktopRuntimeLogs = RuntimeLogs;
export type DesktopNodeProbeResult = RuntimeNodeProbeResult;
export async function invokeDesktopConnect(config: GeneratedRuntimeConfigDto) {
  return connectRuntime(config);
}
export async function invokeDesktopDisconnect() {
  return disconnectRuntime();
}
export async function ensureDesktopRuntimeStopped() {
  return ensureRuntimeStopped();
}
export async function loadDesktopRuntimeStatus() {
  return loadRuntimeStatus();
}
export async function loadDesktopRuntimeLogs() {
  return loadRuntimeLogs();
}
export function hasActiveDesktopRuntime(status: RuntimeStatus | null | undefined) {
  return hasActiveRuntime(status);
}
