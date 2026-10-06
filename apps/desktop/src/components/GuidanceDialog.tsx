import { useEffect, useState } from "react";
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

/** 其他 VPN / 代理占用时的“强制连接”：先二次确认后果，再由调用方执行。 */
export type GuidanceForceConnect = {
  kind: "vpn" | "proxy";
  onConfirm: () => void;
};

const FORCE_CONNECT_LEAD: Record<GuidanceForceConnect["kind"], string> = {
  vpn: "系统里的其他 VPN 不会被断开，但 ChordV 会清空当前的系统代理设置，再写入 ChordV 的代理。两者同时运行，网络可能变慢、不稳定甚至断开。",
  proxy: "ChordV 会清空当前的系统代理设置，再写入 ChordV 的代理。正在使用系统代理的其他软件会立刻失效。"
};

const FORCE_CONNECT_CONSEQUENCES = [
  "你正在用其他 VPN 或代理软件做的事（下载、远程办公、访问内网等）可能中断。",
  "断开 ChordV 后，系统代理会被关闭，不会恢复成原来的设置，需要回到原软件里重新开启。"
];

export function GuidanceDialog({ guidance, onClose, forceConnect }: { guidance: GuidanceDialogContent | null; onClose: () => void; forceConnect?: GuidanceForceConnect }) {
  const [confirming, setConfirming] = useState(false);
  // 提示被关闭或换成别的提示后，确认步骤一并重置。
  useEffect(() => { if (guidance === null) setConfirming(false); }, [guidance]);

  return (
    <>
      <AppDialog
        opened={guidance !== null && !confirming}
        onClose={onClose}
        title={guidance?.title ?? ""}
        tone={guidance?.tone ?? "info"}
        closeLabel="关闭提示"
        footerStart={guidance?.errorCode ? <ErrorCodeHint code={guidance.errorCode} /> : null}
        actions={
          <>
            {forceConnect ? <Button variant="default" color="red" onClick={() => setConfirming(true)}>强制连接</Button> : null}
            <Button data-autofocus onClick={onClose}>{guidance?.actionLabel || "我知道了"}</Button>
          </>
        }
      >
        <DialogText>{guidance?.message}</DialogText>
        {guidance?.detail ? <DialogText muted>{guidance.detail}</DialogText> : null}
      </AppDialog>
      <AppDialog
        opened={guidance !== null && confirming && forceConnect !== undefined}
        onClose={() => setConfirming(false)}
        title="确认强制连接？"
        tone="danger"
        closeLabel="取消强制连接"
        actions={
          <>
            <Button variant="default" data-autofocus onClick={() => setConfirming(false)}>取消</Button>
            <Button color="red" onClick={() => { setConfirming(false); forceConnect?.onConfirm(); }}>仍要强制连接</Button>
          </>
        }
      >
        <DialogText>{forceConnect ? FORCE_CONNECT_LEAD[forceConnect.kind] : ""}</DialogText>
        <DialogText>{FORCE_CONNECT_CONSEQUENCES.map((line) => `• ${line}`).join("\n")}</DialogText>
        <DialogText muted>不确定时，建议先关闭其他软件，再点“重试连接”。</DialogText>
      </AppDialog>
    </>
  );
}
