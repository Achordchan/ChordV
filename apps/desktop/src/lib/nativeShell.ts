import { invokeNative, isNativeDesktop, listenNative as listen } from "./nativeBridge";
import { isAndroidPlatform, loadInvoke } from "./nativeEnvironment";

export type ShellAction = "toggle-connection" | "open-logs";

type ShellActionPayload = {
  action: ShellAction;
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

export async function focusDesktopWindow() {
  if (!isNativeDesktop()) { window.focus(); return; }
  await invokeNative("show_main_window");
}

export async function appReady(input: { screen: "login" | "main" }) {
  const invoke = await loadInvoke();
  if (!invoke) {
    return { ok: false, available: false };
  }

  return invoke<{ ok: boolean }>("app_ready", { input });
}

export async function showDesktopWindow() {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return { ok: false, available: false };
  }
  return invoke("show_main_window");
}

export async function hideDesktopWindow() {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return { ok: false, available: false };
  }
  return invoke("hide_main_window");
}

export async function quitDesktopApplication() {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return { ok: false, available: false };
  }
  return invoke("quit_application");
}

export async function updateDesktopShellSummary(summary: DesktopShellSummary) {
  const invoke = await loadInvoke();
  if (!invoke || isAndroidPlatform()) {
    return { ok: false, available: false };
  }
  return invoke("update_shell_summary", { summary });
}

export async function subscribeDesktopShellActions(handler: (action: ShellAction) => void) {
  return listen<ShellActionPayload>("chordv://shell-action", ({ payload }) => {
    if (payload?.action) handler(payload.action);
  });
}

export async function openExternalUrl(url: string) {
  const normalizedUrl = url.trim();
  if (!normalizedUrl) {
    return { ok: false as const };
  }

  if (!isNativeDesktop() || isAndroidPlatform()) {
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

