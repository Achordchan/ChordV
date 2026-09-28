import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActionIcon, getDefaultZIndex, Modal, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { copyText } from "../lib/clipboard";
import { toneIcon, type NoticeTone } from "./NoticeRow";
import styles from "./AppDialog.module.css";

type AppDialogProps = {
  opened: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Adds a tone icon before the title; used by alert-style dialogs only. */
  tone?: NoticeTone;
  size?: number | string;
  /** false: no close button, Escape or outside click (forced dialogs). */
  dismissible?: boolean;
  closeLabel?: string;
  /** Right-aligned actions: secondary (variant="default") first, primary last. */
  actions?: ReactNode;
  /** Low-emphasis content on the left of the footer (hint, checkbox, error code). */
  footerStart?: ReactNode;
  /** Fixed-height layout where the body fills the dialog (lists, logs). */
  fill?: boolean;
  classNames?: { content?: string; body?: string };
  children: ReactNode;
};

/**
 * Shared dialog frame (1.1.9 design language): 16px/600 title, 20px side
 * padding, a scrolling body, and a hairline footer whose actions stay visible
 * in the small fixed-size window.
 */
export function AppDialog(props: AppDialogProps) {
  const dismissible = props.dismissible ?? true;
  const ToneIcon = props.tone ? toneIcon(props.tone) : null;
  const hasFooter = Boolean(props.actions || props.footerStart);
  return (
    <Modal
      opened={props.opened}
      onClose={props.onClose}
      centered
      size={props.size ?? 420}
      radius="lg"
      withCloseButton={dismissible}
      closeOnEscape={dismissible}
      closeOnClickOutside={dismissible}
      closeButtonProps={props.closeLabel ? { "aria-label": props.closeLabel } : undefined}
      title={ToneIcon ? (
        <span className={styles.titleRow}>
          <ToneIcon size={18} className={styles.titleIcon} data-tone={props.tone} aria-hidden="true" />
          <span>{props.title}</span>
        </span>
      ) : props.title}
      classNames={{
        title: styles.title,
        header: styles.header,
        content: [styles.content, props.fill ? styles.contentFill : "", props.classNames?.content ?? ""].filter(Boolean).join(" "),
        body: [styles.body, props.classNames?.body ?? ""].filter(Boolean).join(" ")
      }}
    >
      <div className={styles.main}>{props.children}</div>
      {hasFooter ? (
        <div className={styles.footer}>
          {props.footerStart ? <div className={styles.footerStart}>{props.footerStart}</div> : null}
          {props.actions ? <div className={styles.actions}>{props.actions}</div> : null}
        </div>
      ) : null}
    </Modal>
  );
}

/** Plain dialog copy: 14px body text that keeps line breaks from the source. */
export function DialogText({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <p className={muted ? `${styles.text} ${styles.textMuted}` : styles.text}>{children}</p>;
}

/** "错误编号 xxx" with a copy button; secondary information for support. */
export function ErrorCodeHint({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  async function copy() {
    if (!(await copyText(code))) return;
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  }
  return (
    <span className={styles.errorCode}>
      <span className={styles.errorCodeLabel}>错误编号</span>
      <code className={styles.errorCodeValue} title={code}>{code}</code>
      {/* 提示卡片（toast）层级高于默认浮层，复制提示必须压在它上面才看得见。 */}
      <Tooltip label={copied ? "已复制" : "复制错误编号"} withArrow openDelay={200} zIndex={getDefaultZIndex("max")}>
        <ActionIcon size="sm" variant="subtle" color={copied ? "green" : "gray"} aria-label="复制错误编号" onClick={() => void copy()}>
          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
        </ActionIcon>
      </Tooltip>
    </span>
  );
}
