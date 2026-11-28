import { invokeNative, isNativeDesktop, type NativeInvoke as NativeCommandInvoke } from "../lib/nativeBridge";

export async function loadCommandInvoke(): Promise<NativeCommandInvoke | null> {
  return isNativeDesktop() ? invokeNative : null;
}

export async function recordClientDiagnosticLog(category: string, message: string) {
  try {
    const invoke = await loadCommandInvoke();
    if (!invoke) {
      return;
    }
    await invoke("record_client_diagnostic", {
      input: {
        category,
        message
      }
    });
  } catch {
    // Diagnostics must never break client runtime behavior.
  }
}

/** 请求原生推送连接尽快补报一次在线（窗口重新显示、网络恢复时）；网页预览或不支持的旧原生壳直接忽略。 */
export async function nudgeClientPresence() {
  try {
    const invoke = await loadCommandInvoke();
    if (!invoke) {
      return;
    }
    await invoke("nudge_client_presence");
  } catch {
    // 在线上报只是尽力而为，失败不影响客户端。
  }
}
