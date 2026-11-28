import { useEffect, useLayoutEffect, useState } from "react";
import { Notifications, useNotifications } from "@mantine/notifications";
import styles from "./Notifications.module.css";

export function AdminNotifications() {
  const [dialog, setDialog] = useState<HTMLElement | null>(null);
  const [host] = useState(() => document.createElement("div"));
  const { notifications } = useNotifications();
  const inline = Boolean(dialog);

  useEffect(() => {
    // Mantine弹窗各自挂载Portal；只同步容器位置，不读取或轮询业务数据。
    const update = () => {
      const dialogs = [...document.querySelectorAll<HTMLElement>('.mantine-Modal-content[role="dialog"], .mantine-Drawer-content[role="dialog"]')]
        .filter(element => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
      const current = dialogs.at(-1) ?? null;
      setDialog(previous => previous === current ? previous : current);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "aria-hidden"] });
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    // 固定Portal宿主随弹窗移动，不重建通知或重置自动关闭计时器。
    (dialog ?? document.body).appendChild(host);
    host.className = dialog ? styles.inlineHost : "";
  }, [dialog, host]);

  useEffect(() => () => host.remove(), [host]);

  useLayoutEffect(() => {
    if (!dialog || notifications.length === 0) return;
    dialog.classList.add(styles.modalWithFeedback);
    return () => dialog.classList.remove(styles.modalWithFeedback);
  }, [dialog, notifications.length]);

  return <Notifications position="bottom-right" autoClose={6500} limit={3} containerWidth={400} notificationMaxHeight="calc(100dvh - 32px)"
    portalProps={{ target: host }}
    classNames={{ root: inline ? styles.inlineRoot : styles.floatingRoot, notification: styles.notification }} />;
}
