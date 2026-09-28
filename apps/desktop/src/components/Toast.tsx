import { notifications, type NotificationsStore } from "@mantine/notifications";
import { recordRecentErrorCode } from "../lib/recentErrorCodes";
import { toToastModel, type ToastInput } from "../lib/toast";
import { ErrorCodeHint } from "./AppDialog";
import { toneIcon } from "./NoticeRow";
import styles from "./Toast.module.css";

/** 挂在 <Notifications /> 上：位置、间距和层级。 */
export const toastContainerClassNames = { root: styles.container, notification: styles.item };

const toastClassNames = {
  root: styles.toast,
  icon: styles.icon,
  body: styles.body,
  title: styles.title,
  description: styles.description,
  closeButton: styles.close
};

/**
 * 客户端唯一的提示出口（1.1.9 设计语言）：白色卡片 + 细边框 + 柔和阴影，
 * 左侧是与 NoticeRow / AppDialog 相同的语义图标，错误编号用 ErrorCodeHint 单独成行。
 */
export function showToast(input: ToastInput, store?: NotificationsStore) {
  const toast = toToastModel(input);
  // 出错时的错误编号记入“最近错误”（只有编号和时间），打开工单时附带给客服。
  if (toast.code && (toast.tone === "danger" || toast.tone === "warning")) recordRecentErrorCode(toast.code);
  const Icon = toneIcon(toast.tone);
  return notifications.show(
    {
      id: toast.id,
      title: toast.title ?? undefined,
      message: toast.code ? (
        <>
          {toast.message ? <span className={styles.message}>{toast.message}</span> : null}
          <span className={styles.code}><ErrorCodeHint code={toast.code} /></span>
        </>
      ) : toast.message,
      icon: <Icon size={18} stroke={1.9} aria-hidden="true" />,
      autoClose: toast.autoClose,
      role: toast.role,
      "aria-live": toast.role === "alert" ? "assertive" : "polite",
      "data-tone": toast.tone,
      classNames: toastClassNames,
      closeButtonProps: { "aria-label": "关闭提示", size: 24, iconSize: 14 }
    },
    store
  );
}
