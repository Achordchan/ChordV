import type { AuthSessionDto, GeneratedRuntimeConfigDto, NodeSummaryDto } from "@chordv/shared";

export type DesktopRuntimeStatus = {
  status: string;
  activeSessionId: string | null;
  configPath: string | null;
  logPath: string | null;
  xrayBinaryPath: string | null;
  activePid: number | null;
  lastError: string | null;
};

export type DesktopRuntimeLogs = {
  log: string;
};

export type DesktopNodeProbeResult = {
  nodeId: string;
  status: "healthy" | "offline";
  latencyMs: number | null;
  checkedAt: string;
  error: string | null;
};

async function loadInvoke() {
  if (!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    return null;
  }

  const module = await import("@tauri-apps/api/core");
  return module.invoke;
}

export async function invokeDesktopConnect(config: GeneratedRuntimeConfigDto) {
  const invoke = await loadInvoke();
  if (!invoke) {
    return { ok: true, mocked: true };
  }

  return invoke("connect_runtime", { config });
}

export async function invokeDesktopDisconnect() {
  const invoke = await loadInvoke();
  if (!invoke) {
    return { ok: true, mocked: true };
  }

  return invoke("disconnect_runtime");
}

export async function loadDesktopRuntimeStatus(): Promise<DesktopRuntimeStatus> {
  const invoke = await loadInvoke();
  if (!invoke) {
    return {
      status: "idle",
      activeSessionId: null,
      configPath: null,
      logPath: null,
      xrayBinaryPath: null,
      activePid: null,
      lastError: null
    };
  }

  return invoke("runtime_status");
}

export async function loadDesktopRuntimeLogs(): Promise<DesktopRuntimeLogs> {
  const invoke = await loadInvoke();
  if (!invoke) {
    return {
      log: ""
    };
  }

  return invoke("runtime_logs");
}

export async function focusDesktopWindow() {
  if (!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    window.focus();
    return;
  }

  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setFocus();
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

export async function clearStoredSession() {
  const invoke = await loadInvoke();
  if (!invoke) {
    return { ok: true, mocked: true };
  }

  return invoke("clear_session");
}

export async function probeNodes(nodes: NodeSummaryDto[]): Promise<DesktopNodeProbeResult[]> {
  const invoke = await loadInvoke();
  if (!invoke) {
    return nodes.map((node) => ({
      nodeId: node.id,
      status: "healthy",
      latencyMs: node.latencyMs,
      checkedAt: new Date().toISOString(),
      error: null
    }));
  }

  return invoke("probe_nodes", { nodes });
}
