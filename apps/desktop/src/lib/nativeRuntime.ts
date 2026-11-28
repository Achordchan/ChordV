import type { ClientNodeProbeResultDto, GeneratedRuntimeConfigDto, PlatformTarget } from "@chordv/shared";
import { listenNative as listen, nativePlatform } from "./nativeBridge";
import { isAndroidPlatform, loadInvoke } from "./nativeEnvironment";

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

export function detectRuntimePlatform(): RuntimePlatform {
  return nativePlatform();
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

/** TCP latency measured by the user's device, never by the backend server. */
export async function probeLocalNodes(nodes: import("@chordv/shared").NodeSummaryDto[]): Promise<RuntimeNodeProbeResult[]> {
  const invoke = await loadInvoke();
  if (!invoke) throw new Error("本机节点检测需要在客户端运行，网页预览无法建立 TCP 连接。");
  return invoke<RuntimeNodeProbeResult[]>("probe_nodes", { nodes });
}

/** Read-only local preflight; runs before component downloads and backend session creation. */
export async function checkRuntimeNetworkConflict(forceTakeover = false) {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) return;
  await invoke("check_network_conflict", { forceTakeover });
}

/** forceTakeover: 用户已确认，先清空系统代理再写入 ChordV 代理，不再因其他 VPN/代理而拒绝连接。 */
export async function connectRuntime(config: GeneratedRuntimeConfigDto, options?: { forceTakeover?: boolean }) {
  const invoke = await loadInvoke();
  if (!invoke) throw new Error("连接功能需要在 MyGo 客户端中运行，网页预览不能启动内核。");

  if (isAndroidPlatform()) {
    return invoke("start_android_runtime", { config });
  }

  return invoke("connect_runtime", { config, forceTakeover: options?.forceTakeover === true });
}

export async function disconnectRuntime() {
  const invoke = await loadInvoke();
  if (!invoke) return { ok: true, stopped: true };

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

export async function subscribeRuntimeStatusChanged(handler: () => void) {
  return listen("chordv://runtime-status", handler);
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
