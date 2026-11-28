import { isNativeDesktop, listenNative as listen } from "./nativeBridge";
import { isAndroidPlatform, loadInvoke } from "./nativeEnvironment";
import { SupportPortalStaleError } from "./supportPortal";

/** 桌面端有独立工单窗口；安卓端和网页预览用系统浏览器打开。 */
export function supportsSupportWindow() {
  return isNativeDesktop() && !isAndroidPlatform();
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
  if (isNativeDesktop() && isAndroidPlatform()) {
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

/** 工单页面通过原生桥接报告的未读总数（原生端已校验为 0–99999 的整数），带着发出它的窗口所属批次号。 */
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
