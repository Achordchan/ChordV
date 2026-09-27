type ListenerTarget = {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

export type PresenceNudgeOptions = {
  windowTarget: ListenerTarget;
  documentTarget: ListenerTarget & { readonly visibilityState: string };
  nudge: () => Promise<unknown> | unknown;
};

/**
 * 登录期间，窗口重新显示或网络恢复时请求原生推送连接尽快补报一次在线（最小间隔由原生侧控制）。
 * 定期上报本身在原生推送连接里进行，窗口隐藏到托盘时也不受网页定时器节流影响；这里只是补一次，失败静默忽略。
 * 返回的函数在退出登录或卸载时调用，移除监听。
 */
export function startPresenceNudges(options: PresenceNudgeOptions) {
  const { windowTarget, documentTarget, nudge } = options;
  const trigger = () => {
    try {
      void Promise.resolve(nudge()).catch(() => undefined);
    } catch {
      // 在线上报只是尽力而为，不影响客户端。
    }
  };
  const onVisibilityChange = () => {
    if (documentTarget.visibilityState === "visible") {
      trigger();
    }
  };
  windowTarget.addEventListener("online", trigger);
  documentTarget.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    windowTarget.removeEventListener("online", trigger);
    documentTarget.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
