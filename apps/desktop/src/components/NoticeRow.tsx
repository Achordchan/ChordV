import type { ReactNode } from "react";
import { IconAlertCircle, IconAlertTriangle, IconCircleCheck, IconInfoCircle } from "@tabler/icons-react";
import styles from "./NoticeRow.module.css";

export type NoticeTone = "info" | "warning" | "danger" | "success";

const TONE_ICONS = {
  info: IconInfoCircle,
  warning: IconAlertTriangle,
  danger: IconAlertCircle,
  success: IconCircleCheck
} as const;

type NoticeRowProps = {
  tone?: NoticeTone;
  children: ReactNode;
  /** Optional trailing control, e.g. a compact button. */
  action?: ReactNode;
  role?: "alert" | "status";
  className?: string;
};

/** Compact inline notice: replaces Mantine's large rounded Alert blocks. */
export function NoticeRow({ tone = "info", children, action, role, className }: NoticeRowProps) {
  const Icon = TONE_ICONS[tone];
  return (
    <div className={className ? `${styles.notice} ${className}` : styles.notice} data-tone={tone} role={role}>
      <Icon size={16} className={styles.icon} aria-hidden="true" />
      <div className={styles.text}>{children}</div>
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}

export function toneIcon(tone: NoticeTone) {
  return TONE_ICONS[tone];
}
