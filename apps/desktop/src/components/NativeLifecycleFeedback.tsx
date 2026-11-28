import { useState } from "react";
import { ActionIcon, Button } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { nativeLifecyclePresentation, type NativeLifecycleNotice } from "../lib/nativeLifecycle";
import { AppDialog, DialogText } from "./AppDialog";
import { NoticeRow } from "./NoticeRow";
import styles from "./NativeLifecycleFeedback.module.css";

export type NativeLifecycleFeedbackProps = {
  notice: NativeLifecycleNotice;
  onDismiss: () => void;
  login?: boolean;
};

export function NativeLifecycleFeedback({ notice, onDismiss, login = false }: NativeLifecycleFeedbackProps) {
  const [detailsOpened, setDetailsOpened] = useState(false);
  const presentation = nativeLifecyclePresentation(notice);
  return <>
    <NoticeRow tone={presentation.tone} role="alert"
      className={`${styles.feedback}${login ? " auth-screen__error" : ""}`}
      action={<div className={styles.actions}>
        <Button size="compact-xs" variant="subtle" color="gray" aria-label="查看系统提示详情" onClick={() => setDetailsOpened(true)}>详情</Button>
        <ActionIcon size={22} variant="subtle" color="gray" aria-label="关闭系统提示" onClick={onDismiss}><IconX size={14} /></ActionIcon>
      </div>}>
      <div className={styles.copy}><strong>{presentation.title}：</strong>{presentation.message}</div>
    </NoticeRow>
    <AppDialog opened={detailsOpened} onClose={() => setDetailsOpened(false)} title={presentation.title}
      tone={presentation.tone} closeLabel="关闭系统提示详情" size={480}>
      <DialogText>{presentation.message}</DialogText>
    </AppDialog>
  </>;
}
