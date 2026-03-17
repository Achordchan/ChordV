import type { GeneratedRuntimeConfigDto } from "@chordv/shared";

type RuntimeStatusResponse = {
  status: string;
  activeSessionId: string | null;
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

export async function loadDesktopRuntimeStatus(): Promise<RuntimeStatusResponse> {
  const invoke = await loadInvoke();
  if (!invoke) {
    return {
      status: "idle",
      activeSessionId: null
    };
  }

  return invoke("runtime_status");
}

