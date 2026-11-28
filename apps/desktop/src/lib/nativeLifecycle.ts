import { isNativeDesktop, listenNative } from "./nativeBridge";
import type { NoticeTone } from "../components/NoticeRow";

type RuntimeInterruption = {
  cause: "watchdog-exited" | "kernel-exited" | "lease-ended";
  proxyRestored: boolean;
  message: string;
};

export type NativeLifecycleNotice =
  | { kind: "exit-cleanup-failed"; message: string }
  | { kind: "startup-recovery-failed"; message: string }
  | { kind: "shell-tray-unavailable"; message: string }
  | ({ kind: "runtime-interrupted" } & RuntimeInterruption);

function withAdvice(message: string, advice: string) {
  return `${message.trim().replace(/[。.!！]+$/u, "")}。${advice}`;
}

export type NativeLifecyclePresentation = { title: string; tone: NoticeTone; message: string };

export function nativeLifecyclePresentation(notice: NativeLifecycleNotice): NativeLifecyclePresentation {
  switch (notice.kind) {
    case "exit-cleanup-failed":
      return { title: "退出未完成", tone: "danger",
        message: withAdvice(notice.message, "请稍后再次选择“退出 ChordV”重试。") };
    case "runtime-interrupted":
      return { title: notice.proxyRestored ? "连接已断开" : "系统代理待恢复",
        tone: notice.proxyRestored ? "warning" : "danger", message: notice.message };
    case "startup-recovery-failed":
      return { title: "启动恢复未完成", tone: "danger",
        message: withAdvice(notice.message, "请重试断开连接以恢复系统代理。") };
    case "shell-tray-unavailable":
      return { title: "系统托盘不可用", tone: "warning", message: notice.message };
  }
}

export async function subscribeNativeLifecycleNotices(handler: (notice: NativeLifecycleNotice) => void) {
  if (!isNativeDesktop()) return () => {};
  const cleanups: (() => void)[] = [];
  try {
    for (const kind of ["exit-cleanup-failed", "startup-recovery-failed", "shell-tray-unavailable"] as const) {
      cleanups.push(await listenNative<string>(`chordv://${kind}`, ({ payload }) => {
        if (typeof payload === "string") handler({ kind, message: payload });
      }));
    }
    cleanups.push(await listenNative<RuntimeInterruption>("chordv://runtime-interrupted", ({ payload }) => {
      if (payload && (payload.cause === "watchdog-exited" || payload.cause === "kernel-exited" || payload.cause === "lease-ended") &&
        typeof payload.proxyRestored === "boolean" && typeof payload.message === "string") {
        handler({ ...payload, kind: "runtime-interrupted" });
      }
    }));
  } catch (error) {
    cleanups.forEach(cleanup => cleanup());
    throw error;
  }
  return () => cleanups.forEach(cleanup => cleanup());
}
