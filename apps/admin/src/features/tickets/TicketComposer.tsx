import type { RefObject } from "react";
import { Button, FileButton, Textarea } from "@mantine/core";
import { IconPaperclip, IconSend, IconX } from "@tabler/icons-react";
import styles from "./TicketsWorkspace.module.css";

export type TicketComposerProps = {
  draft: string;
  onDraftChange: (value: string) => void;
  maxLength: number;
  attachment: File | null;
  onAttachmentChange: (file: File | null) => void;
  attachmentResetRef: RefObject<(() => void) | null>;
  /** 工单已关闭：需要先重开才能回复。 */
  closed: boolean;
  sending: boolean;
  sendDisabled: boolean;
  onSend: () => void;
};

export function TicketComposer(props: TicketComposerProps) {
  const overLimit = props.draft.length > props.maxLength;
  return (
    <div className={styles.composer}>
      <Textarea
        aria-label="回复内容"
        autosize
        minRows={2}
        maxRows={8}
        placeholder={props.closed ? "工单已关闭，请先重开再回复。" : "输入回复内容"}
        value={props.draft}
        onChange={(event) => props.onDraftChange(event.currentTarget.value)}
        disabled={props.closed}
        classNames={{ input: styles.composerInput }}
      />
      <div className={styles.composerBar}>
        <div className={styles.composerTools}>
          <FileButton resetRef={props.attachmentResetRef} onChange={props.onAttachmentChange} accept="image/png,image/jpeg,image/webp,image/gif">
            {(fileButtonProps) => (
              <Button
                {...fileButtonProps}
                size="xs"
                variant="subtle"
                color="#52604c"
                leftSection={<IconPaperclip size={14} />}
                disabled={props.sending || props.closed}
              >
                添加图片
              </Button>
            )}
          </FileButton>
          {props.attachment ? (
            <Button
              size="xs"
              variant="light"
              rightSection={<IconX size={14} />}
              className={styles.attachmentPill}
              aria-label={`移除附件 ${props.attachment.name}`}
              onClick={() => props.onAttachmentChange(null)}
            >
              {props.attachment.name}
            </Button>
          ) : null}
        </div>
        <span className={styles.counter} data-over={overLimit}>
          {props.draft.length}/{props.maxLength}
        </span>
        <Button className={styles.sendButton} leftSection={<IconSend size={15} />} onClick={props.onSend} loading={props.sending} disabled={props.sendDisabled}>
          发送回复
        </Button>
      </div>
    </div>
  );
}
