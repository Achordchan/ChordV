import { useEffect, useRef, useState } from "react";
import { Button } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { copyText } from "../lib/clipboard";
import { AppDialog } from "./AppDialog";

type LogDrawerProps = {
  opened: boolean;
  log: string;
  onClose: () => void;
};

export function LogDrawer(props: LogDrawerProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  useEffect(() => { if (!props.opened) setCopied(false); }, [props.opened]);

  async function copyLog() {
    if (!props.log || !(await copyText(props.log))) return;
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <AppDialog
      opened={props.opened}
      onClose={props.onClose}
      title="连接诊断"
      closeLabel="关闭连接诊断"
      size={600}
      fill
      footerStart="如遇连接问题，请复制日志联系管理员"
      actions={
        <Button
          variant="default"
          disabled={!props.log}
          leftSection={copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
          onClick={() => void copyLog()}
        >
          {copied ? "已复制" : "复制日志"}
        </Button>
      }
    >
      <pre className="log-viewer" tabIndex={0} aria-label="连接诊断日志">{props.log || "当前没有日志"}</pre>
    </AppDialog>
  );
}
