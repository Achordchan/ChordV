import { Button } from "@mantine/core";
import { AppDialog, DialogText, ErrorCodeHint } from "./AppDialog";
import type { NoticeTone } from "./NoticeRow";

/** Structural subset of ConnectionGuidance, so any user-facing error mapping can feed it. */
export type GuidanceDialogContent = {
  title: string;
  message: string;
  tone?: NoticeTone;
  actionLabel?: string | null;
  errorCode?: string | null;
  /** Optional secondary explanation shown below the message. */
  detail?: string | null;
};

export function GuidanceDialog({ guidance, onClose }: { guidance: GuidanceDialogContent | null; onClose: () => void }) {
  return (
    <AppDialog
      opened={guidance !== null}
      onClose={onClose}
      title={guidance?.title ?? ""}
      tone={guidance?.tone ?? "info"}
      closeLabel="关闭提示"
      footerStart={guidance?.errorCode ? <ErrorCodeHint code={guidance.errorCode} /> : null}
      actions={<Button data-autofocus onClick={onClose}>{guidance?.actionLabel || "我知道了"}</Button>}
    >
      <DialogText>{guidance?.message}</DialogText>
      {guidance?.detail ? <DialogText muted>{guidance.detail}</DialogText> : null}
    </AppDialog>
  );
}
