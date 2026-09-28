import { useState } from "react";
import { Button, Group, Stack, Text } from "@mantine/core";
import { DataSkeleton } from "../shared/DataSkeleton";
import type { TicketAttachmentPreview } from "./ticket-model";
import styles from "./TicketsWorkspace.module.css";

type TicketAttachmentImageState = "loading" | "loaded" | "failed";

/**
 * 加载状态绑定到具体地址：换图或重试时自动回到“加载中”。
 * 不在 effect 里重置，避免缓存图片的 load 事件先于 effect 触发后又被改回“加载中”。
 */
function useImageState(url: string) {
  const [state, setState] = useState<{ url: string; status: TicketAttachmentImageState }>({ url, status: "loading" });
  const status = state.url === url ? state.status : "loading";
  return [status, (next: TicketAttachmentImageState) => setState({ url, status: next })] as const;
}

export function TicketAttachmentThumbnail(props: { url: string; fileName: string }) {
  const [imageState, setImageState] = useImageState(props.url);

  return (
    <div className={styles.attachmentCard}>
      <div className={styles.thumbFrame} aria-busy={imageState === "loading"}>
        {imageState !== "failed" ? (
          <img src={props.url} alt={props.fileName} onLoad={() => setImageState("loaded")} onError={() => setImageState("failed")} />
        ) : null}
        {imageState === "loading" ? (
          <div className={styles.imageState}>
            <DataSkeleton variant="image" />
          </div>
        ) : null}
        {imageState === "failed" ? (
          <div className={`${styles.imageState} ${styles.imageStateFailed}`}>
            <strong>缩略图加载失败</strong>
            <span>点击查看原图</span>
          </div>
        ) : null}
      </div>
      <span title={props.fileName}>{props.fileName}</span>
    </div>
  );
}

export function TicketAttachmentPreviewContent(props: { attachment: TicketAttachmentPreview }) {
  const [retry, setRetry] = useState({ url: props.attachment.url, token: 0 });
  const retryToken = retry.url === props.attachment.url ? retry.token : 0;
  const previewUrl = retryToken === 0 ? props.attachment.url : appendImageRetryToken(props.attachment.url, retryToken);
  const [imageState, setImageState] = useImageState(previewUrl);

  return (
    <Stack gap="sm">
      <div className={styles.previewFrame} aria-busy={imageState === "loading"}>
        {imageState !== "failed" ? (
          <img
            key={previewUrl}
            src={previewUrl}
            alt={props.attachment.fileName}
            onLoad={() => setImageState("loaded")}
            onError={() => setImageState("failed")}
          />
        ) : null}
        {imageState === "loading" ? (
          <div className={styles.previewState}>
            <DataSkeleton variant="image" />
          </div>
        ) : null}
        {imageState === "failed" ? (
          <div className={`${styles.previewState} ${styles.previewStateFailed}`}>
            <Text fw={600}>预览加载失败</Text>
            <Text size="sm" c="dimmed">
              可以重试，或在新窗口打开原图。
            </Text>
          </div>
        ) : null}
      </div>
      <Group justify="flex-end">
        {imageState === "failed" ? (
          <Button
            variant="light"
            onClick={() => setRetry({ url: props.attachment.url, token: retryToken + 1 })}
          >
            重试
          </Button>
        ) : null}
        <Button component="a" href={props.attachment.url} target="_blank" rel="noreferrer" variant="default">
          打开原图
        </Button>
      </Group>
    </Stack>
  );
}

export function appendImageRetryToken(url: string, retryToken: number) {
  const hashIndex = url.indexOf("#");
  const baseUrl = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${separator}previewRetry=${retryToken}${hash}`;
}
