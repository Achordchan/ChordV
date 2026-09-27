import { useEffect, useMemo, useRef, useState } from "react";
import { ActionIcon, Button, Loader, Text, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy, IconFolderOpen } from "@tabler/icons-react";
import { copyText } from "../lib/clipboard";
import { buildLocalFileRows, type LocalFileEntry, type LocalFileKind, type LocalFileRow, type LocalFileVersions } from "../lib/localFiles";
import { listLocalFileLocations } from "../lib/runtime";
import { AppDialog, DialogText } from "./AppDialog";
import styles from "./LocalFilesDialog.module.css";

type LocalFilesDialogProps = {
  opened: boolean;
  versions: LocalFileVersions;
  onClose: () => void;
  onReveal: (kind: LocalFileKind) => void;
};

/** 低频排查入口：列出组件与运行目录的实际位置，可复制路径或在文件夹中显示。 */
export function LocalFilesDialog(props: LocalFilesDialogProps) {
  const [entries, setEntries] = useState<LocalFileEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const { opened, versions } = props;
  const rows = useMemo(() => (entries ? buildLocalFileRows(entries, versions) : null), [entries, versions]);

  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    setFailed(false);
    setLoading(true);
    // 每次打开都重新读取，刚下载完的组件也能立刻看到。
    void listLocalFileLocations()
      .then((result) => {
        if (cancelled) return;
        setEntries(result ?? []);
        setFailed(!result);
      })
      .catch(() => {
        if (cancelled) return;
        setEntries([]);
        setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [opened, reloadKey]);

  return (
    <AppDialog
      opened={opened}
      onClose={props.onClose}
      title="本地文件"
      size={560}
      closeLabel="关闭本地文件"
      footerStart="用于排查组件与配置问题。登录凭据不会在这里显示。"
      actions={<Button data-autofocus onClick={props.onClose}>关闭</Button>}
    >
      {rows === null || (loading && rows.length === 0) ? (
        <div className={styles.state}><Loader size={16} /><Text size="sm" c="dimmed">正在读取文件位置…</Text></div>
      ) : failed ? (
        <div className={styles.state}>
          <DialogText muted>暂时无法读取本地文件位置，请稍后重试。</DialogText>
          <Button size="compact-sm" variant="light" onClick={() => setReloadKey((value) => value + 1)}>重试</Button>
        </div>
      ) : (
        <ul className={styles.list}>
          {rows.map((row) => <LocalFileRowItem key={row.kind} row={row} onReveal={props.onReveal} />)}
        </ul>
      )}
    </AppDialog>
  );
}

function LocalFileRowItem({ row, onReveal }: { row: LocalFileRow; onReveal: (kind: LocalFileKind) => void }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  async function copy() {
    if (!(await copyText(row.path))) return;
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  }
  return (
    <li className={styles.row}>
      <div className={styles.info}>
        <div className={styles.head}>
          <span className={styles.label}>{row.label}</span>
          {row.status ? <span className={styles.status} data-missing={!row.exists || undefined}>{row.status}</span> : null}
          {row.hint ? <span className={styles.hint}>{row.hint}</span> : null}
        </div>
        <code className={styles.path} title={row.path}>{row.path}</code>
      </div>
      <div className={styles.actions}>
        <Tooltip label={copied ? "已复制" : "复制路径"} withArrow openDelay={200}>
          <ActionIcon variant="subtle" color={copied ? "green" : "gray"} aria-label={`复制${row.label}路径`} onClick={() => void copy()}>
            {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
          </ActionIcon>
        </Tooltip>
        <Tooltip label={row.revealLabel} withArrow openDelay={200}>
          <ActionIcon variant="subtle" color="gray" aria-label={`${row.label}：${row.revealLabel}`} onClick={() => onReveal(row.kind)}>
            <IconFolderOpen size={16} />
          </ActionIcon>
        </Tooltip>
      </div>
    </li>
  );
}
