import type { GeneratedRuntimeConfigDto } from "@chordv/shared";

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
