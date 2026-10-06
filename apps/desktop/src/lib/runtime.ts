import type {
  AuthSessionDto,
  ClientNodeProbeResultDto,
  GeneratedRuntimeConfigDto,
  PlatformTarget
} from "@chordv/shared";
import type {
  RuntimeComponentDownloadItem,
  RuntimeComponentDownloadProgress,
  RuntimeComponentFileStatus,
  RuntimeComponentKind
} from "./runtimeComponents";
import type { RuntimeComponentLocalInfo } from "./geoUpdate";
import type { LocalFileEntry, LocalFileKind } from "./localFiles";
import { SupportPortalStaleError } from "./supportPortal";

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

export type RuntimeNodeProbeResult = Omit<ClientNodeProbeResultDto,"status"> & {status:ClientNodeProbeResultDto["status"]|"unknown"};

export type RuntimePlatform = PlatformTarget | "web" | "linux";

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

export type DesktopShellSummary = {
  status: string;
  signedIn?: boolean;
  nodeName: string | null;
  primaryActionLabel: string;
  // Tray menu context: the native side renders these as they are.
  mode?: string | null;
  modes?: string[];
  nodes?: { id: string; name: string; latencyMs: number | null; status: string }[];
  selectedNodeId?: string | null;
  trafficLine?: string | null;
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
  
  // Use __TAURI_INTERNALS__ to get actual OS platform
  try {
    const platform = (window as any).__TAURI_INTERNALS__?.metadata?.currentTarget?.platform;
    if (platform === "windows") return "windows";
    if (platform === "macos") return "macos";
    if (platform === "linux") return "linux";
  } catch {}
  
  // Fallback to userAgent (unreliable for Tauri desktop)
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

/** TCP latency measured by the user's device, never by the backend server. */
export async function probeLocalNodes(nodes: import("@chordv/shared").NodeSummaryDto[]): Promise<RuntimeNodeProbeResult[]> {
  const invoke = await loadInvoke();
  if (!invoke) throw new Error("本机节点检测需要在客户端运行，网页预览无法建立 TCP 连接。");
  return invoke<RuntimeNodeProbeResult[]>("probe_nodes", { nodes });
}

/** Read-only local preflight; runs before component downloads and backend session creation. */
export async function checkRuntimeNetworkConflict() {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) return;
  await invoke("check_network_conflict");
}

/** forceTakeover: 用户已确认，先清空系统代理再写入 ChordV 代理，不再因其他 VPN/代理而拒绝连接。 */
export async function connectRuntime(config: GeneratedRuntimeConfigDto, options?: { forceTakeover?: boolean }) {
  const invoke = await loadInvoke();
  if (!invoke) {
    return { ok: true, mocked: true };
  }

  if (isAndroidPlatform()) {
    return invoke("start_android_runtime", { config });
  }

  return invoke("connect_runtime", { config, forceTakeover: options?.forceTakeover === true });
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

  const invoke = await loadInvoke();
  if (invoke) {
    await invoke("show_main_window").catch(() => null);
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
  packageKind?: "installer";
  currentVersion?: string | null;
  channel?: string | null;
  preferredCandidate?: "mirror" | "origin";
  onProgress?: (progress: DesktopUpdateDownloadProgress) => void;
}) {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return null;
  }
  const commandInput: Record<string, unknown> = {
    fileName: input.fileName,
    expectedVersion: input.expectedVersion,
    packageKind: input.packageKind,
    currentVersion: input.currentVersion,
    channel: input.channel,
    preferredCandidate: input.preferredCandidate
  };
  const { Channel } = await import("@tauri-apps/api/core");
  const progressChannel = new Channel<DesktopUpdateDownloadProgressPayload>((payload) => {
    input.onProgress?.(normalizeDesktopUpdateDownloadProgress(payload));
  });
  return invoke<DesktopInstallerDownloadResult>("download_desktop_installer", {
    input: commandInput,
    progressChannel
  });
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
  return invoke("open_desktop_installer", { path });
}

export async function openExternalUrl(url: string) {
  const normalizedUrl = url.trim();
  if (!normalizedUrl) {
    return { ok: false as const };
  }

  if (!isTauriApp() || isAndroidPlatform()) {
    // Open a blank page first so popup rejection is observable. Passing noopener
    // to window.open returns null even when a browser successfully opens it.
    const opened = window.open("about:blank", "_blank");
    if (!opened) return { ok: false as const };
    try {
      opened.opener = null;
      opened.location.replace(normalizedUrl);
      return { ok: true as const };
    } catch (error) {
      opened.close();
      throw error;
    }
  }

  const invoke = await loadInvoke();
  if (!invoke) return { ok: false as const };
  return invoke<{ ok: boolean }>("open_external_url", { url: normalizedUrl });
}

/** 桌面端有独立工单窗口；安卓端和网页预览用系统浏览器打开。 */
export function supportsSupportWindow() {
  return isTauriApp() && !isAndroidPlatform();
}

/** 一次“打开工单”的目标：桌面端是原生工单窗口，安卓端和网页预览是系统浏览器。 */
export type SupportWindowTarget = {
  /** 工单窗口仍打开且会话未过期时聚焦它并返回 true；否则返回 false，调用方需要重新签发票据。 */
  focusExisting: () => Promise<boolean>;
  /** 确认要申请票据后立刻调用（不等待）：桌面端先弹出占位窗口，票据到手后同一个窗口再跳转。 */
  prepare?: () => void;
  /** launchUrl 带一次性票据：只交给原生层或预留的浏览器窗口，不能写进日志或错误信息。 */
  open: (launch: { launchUrl: string; supportOrigin: string }) => Promise<void>;
  /** 没有打开（已聚焦、未开放、失败、账号已变化）时释放预留的资源；异步清理返回 Promise，调用方会等它做完。 */
  dispose: () => void | Promise<void>;
};

/** 与原生层 SUPPORT_WINDOW_CLOSED_ERROR 一致：占位窗口被用户关掉。 */
const SUPPORT_WINDOW_CLOSED_ERROR = "support_window_closed";
const SUPPORT_POPUP_BLOCKED_MESSAGE = "无法打开工单页面，请允许弹出窗口后重试。";

/**
 * 必须在点击事件里同步调用：网页预览中浏览器只允许在用户手势内打开新窗口，
 * 所以先预留一个空白窗口，拿到打开地址后再跳转。
 */
export function createSupportWindowTarget(
  options: { onEpoch?: (epoch: number) => void; getSupportOrigin?: () => string | null } = {}
): SupportWindowTarget {
  if (isTauriApp() && isAndroidPlatform()) {
    // 安卓端没有独立工单窗口，WebView 里的空白弹窗也不可靠：交给原生层用系统默认应用（浏览器）打开。
    return {
      focusExisting: async () => false,
      open: async ({ launchUrl }) => {
        const invoke = await loadInvoke();
        // 原始错误可能带出地址，统一换成不含地址的提示。
        const opened = invoke
          ? await invoke<{ ok: boolean }>("open_external_url", { url: launchUrl }).then((result) => result.ok, () => false)
          : false;
        if (!opened) throw new Error("无法打开工单页面，请确认已安装浏览器后重试。");
      },
      dispose: () => {}
    };
  }
  if (!supportsSupportWindow()) {
    // 网页预览：浏览器只允许在点击内开新窗口，先预留空白窗口。
    let popup: Window | null = null;
    try {
      popup = window.open("about:blank", "_blank");
    } catch {
      popup = null;
    }
    return {
      focusExisting: async () => false,
      open: async ({ launchUrl }) => {
        const reserved = popup;
        popup = null;
        if (!reserved || reserved.closed) throw new Error(SUPPORT_POPUP_BLOCKED_MESSAGE);
        try {
          reserved.opener = null;
          reserved.location.replace(launchUrl);
        } catch {
          // 原始错误可能带出地址，统一换成不含地址的提示。
          reserved.close();
          throw new Error(SUPPORT_POPUP_BLOCKED_MESSAGE);
        }
      },
      dispose: () => {
        popup?.close();
        popup = null;
      }
    };
  }

  // 原生层每次退出登录都会换一个批次号；打开时带回聚焦时拿到的批次号，账号变化后的旧请求会被拒绝。
  let epoch: number | null = null;
  // 占位窗口：点击后先弹出本地“正在打开工单…”页，票据到手后同一个窗口再跳转。失败时退回到拿到票据后再开窗。
  // 结果是占位窗口的标签；null 表示没有预开成功。创建、接管、取消都带这个标签，不会误碰别的窗口。
  let preparing: Promise<string | null> | null = null;
  return {
    prepare: () => {
      const supportOrigin = options.getSupportOrigin?.();
      if (preparing || epoch === null || !supportOrigin) return;
      const preparedEpoch = epoch;
      preparing = (async () => {
        try {
          const invoke = await loadInvoke();
          if (!invoke) return null;
          const label = await invoke<string>("begin_support_window", { supportOrigin, epoch: preparedEpoch });
          return typeof label === "string" && label ? label : null;
        } catch {
          return null;
        }
      })();
    },
    focusExisting: async () => {
      const invoke = await loadInvoke();
      if (!invoke) throw new Error("无法打开工单窗口，请重新打开 ChordV 后重试。");
      const result = await invoke<{ focused: boolean; epoch: number }>("focus_support_window");
      epoch = result.epoch;
      options.onEpoch?.(result.epoch);
      return result.focused;
    },
    open: async ({ launchUrl, supportOrigin }) => {
      const invoke = await loadInvoke();
      if (!invoke || epoch === null) throw new Error("无法打开工单窗口，请重新打开 ChordV 后重试。");
      const prepared = preparing ? await preparing : null;
      try {
        await invoke("open_support_window", { launchUrl, supportOrigin, epoch, ...(prepared ? { prepared } : {}) });
        // 打开成功才放下清理句柄；失败（地址校验不通过等）时保留，由 dispose 关掉还停在占位页的窗口。
        preparing = null;
      } catch (reason) {
        // 用户在占位窗口等待期间把它关了：静默结束，不再弹出，也不提示错误。
        const text = typeof reason === "string" ? reason : reason instanceof Error ? reason.message : "";
        if (prepared && text === SUPPORT_WINDOW_CLOSED_ERROR) throw new SupportPortalStaleError();
        throw reason;
      }
    },
    dispose: async () => {
      // 没有走到打开（失败、未开放、账号变化）：关掉这次预开的、还停在占位页的窗口。
      // 返回的 Promise 在清理完成后才结束：调用方据此等清理做完再允许下一次点击，
      // 避免迟到的清理碰到重试新开的窗口。
      const pending = preparing;
      const cancelEpoch = epoch;
      preparing = null;
      if (!pending || cancelEpoch === null) return;
      try {
        const label = await pending;
        if (!label) return;
        const invoke = await loadInvoke();
        await invoke?.("cancel_support_loading_window", { epoch: cancelEpoch, label });
      } catch {
        // 清理失败不影响本次结果；残留的占位窗口下次点击时会被取代。
      }
    }
  };
}

export async function closeSupportWindow() {
  if (!supportsSupportWindow()) return;
  const invoke = await loadInvoke();
  if (!invoke) return;
  await invoke("close_support_window");
}

/** 工单页面通过原生桥接报告的未读总数（Rust 已校验为 0–99999 的整数），带着发出它的窗口所属批次号。 */
export type SupportUnreadBridgeEvent = { unreadCount: number; epoch: number; window: string };
/** 桥接结束：窗口关闭 / 被取代、门户报告会话过期、或页面整页重新加载。 */
export type SupportBridgeEndedEvent = { epoch: number; window: string };

/**
 * 订阅工单窗口的原生事件：桥接未读数，以及桥接结束（窗口关闭 / 被重开取代，或门户报告会话过期）。
 * 两者都带着窗口所属的批次号，由调用方丢弃其他账号的窗口发出的事件。
 */
export async function subscribeSupportWindowEvents(handlers: {
  onUnread: (event: SupportUnreadBridgeEvent) => void;
  onEnded: (event: SupportBridgeEndedEvent) => void;
}) {
  if (!supportsSupportWindow()) {
    return () => {};
  }
  const { listen } = await import("@tauri-apps/api/event");
  const unlistenUnread = await listen<SupportUnreadBridgeEvent>("chordv://support-unread", (event) => {
    if (event.payload) handlers.onUnread(event.payload);
  });
  const unlistenEnded = await listen<SupportBridgeEndedEvent>("chordv://support-bridge-ended", (event) => {
    if (event.payload) handlers.onEnded(event.payload);
  }).catch((error) => {
    unlistenUnread();
    throw error;
  });
  return () => {
    unlistenUnread();
    unlistenEnded();
  };
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
  return invoke("install_windows_update");
}

export async function quitForUpdate() {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return { ok: false as const };
  }
  return invoke("quit_for_update");
}

export type DesktopUpdateInstallReport = {
  ok: boolean;
  platform: string;
  mode: string;
  summary: string | null;
  detail: string | null;
  logPath: string | null;
  createdAt: string | null;
};

export async function consumeDesktopUpdateInstallReport() {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return null;
  }
  return invoke<DesktopUpdateInstallReport | null>("consume_desktop_update_install_report");
}

let osLabelTask: Promise<string | null> | null = null;

/**
 * 系统版本标签（例如 macOS 15.1（24B83，arm64）），打开工单时附带给客服。
 * 原生层取到后本次运行内缓存；这里缓存成功的结果，取不到时下次再试。
 */
export function loadDesktopOsLabel(): Promise<string | null> {
  if (!osLabelTask) {
    osLabelTask = (async () => {
      const invoke = await loadInvoke();
      if (!invoke || isAndroidPlatform()) {
        return null;
      }
      const label = await invoke<string | null>("desktop_os_label");
      return typeof label === "string" && label.trim() ? label.trim() : null;
    })().catch(() => null);
    const task = osLabelTask;
    void task.then((label) => {
      if (label === null && osLabelTask === task) osLabelTask = null;
    });
  }
  return osLabelTask;
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
}) {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return null;
  }
  return invoke<RuntimeComponentDownloadResult>("download_runtime_component", { input });
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
  const candidate = readFiniteProgressNumber(primary) ?? readFiniteProgressNumber(fallback) ?? 0;
  if (candidate < 0) {
    return 0;
  }
  return candidate;
}

function readRuntimeProgressNullableNumber(primary: unknown, fallback: unknown) {
  const value = readFiniteProgressNumber(primary) ?? readFiniteProgressNumber(fallback);
  if (value === null || value <= 0) {
    return null;
  }
  return value;
}

function readFiniteProgressNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
  }
  return null;
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

export async function subscribeNativeExitFailure(handler:(message:string)=>void) {
  if(!isTauriApp())return ()=>{};
  const {listen}=await import("@tauri-apps/api/event");
  return listen<string>("chordv://exit-cleanup-failed",event=>{
    if(typeof event.payload==="string")handler(event.payload);
  });
}

export type NativeSessionRefreshEvent = AuthSessionDto & { previousRefreshToken: string };

export async function subscribeNativeSessionRefreshed(handler: (session: NativeSessionRefreshEvent) => void) {
  if (!isTauriApp() || isAndroidPlatform()) {
    return () => {};
  }
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<NativeSessionRefreshEvent>("chordv://native-session-refreshed", (event) => {
    if (event.payload) {
      handler(event.payload);
    }
  });
  return () => {
    unlisten();
  };
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
