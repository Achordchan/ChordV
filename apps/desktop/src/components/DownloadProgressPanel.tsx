import { useId, useState } from "react";
import { Button, Loader, Progress } from "@mantine/core";
import { IconAlertTriangle, IconCheck, IconChevronDown, IconDownload } from "@tabler/icons-react";
import styles from "./DownloadProgressPanel.module.css";

type Props = {
  label: string; title: string; amount: string; percent: number | null;
  completed?: boolean; failed?: boolean; waiting?: boolean;
  details: string[];
  onResetLegacyMirror?: (() => void) | null;
  onCancel?: (() => void) | null;
  action?: { label: string; onClick: () => void } | null;
};

/** Shared presentation for every application-managed download. */
export function DownloadProgressPanel({label,title,amount,percent,completed,failed,waiting,details,onCancel,action,onResetLegacyMirror}: Props) {
  const percentLabel = percent === null ? null : percent >= 100 ? 100 : Math.min(99, Math.round(percent));
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  return <section className={styles.panel} data-failed={failed || undefined} aria-label={label}>
    <div className={styles.heading}>
      <span className={styles.icon} aria-hidden="true">{failed ? <IconAlertTriangle size={20}/> : completed ? <IconCheck size={20}/> : waiting ? <Loader size={18} color="cyan"/> : <IconDownload size={20}/>}</span>
      <span className={styles.title} role="status" aria-live="polite">{title}</span>
      {percent !== null ? <span className={styles.percent}>{percentLabel}%</span> : null}
    </div>
    {percent !== null ? <Progress className={styles.progress} value={percent} size={6} radius="xl" color="cyan.5"
      aria-label="文件下载进度" aria-valuetext={`${percentLabel}%`} /> : <div className={styles.progress} aria-hidden="true"><Progress value={0} size={6} radius="xl" /></div>}
    <div className={styles.footer}>
      <span className={styles.amount}>{amount}</span>
      <div className={styles.actions}>
        <Button variant="transparent" color="gray.6" size="compact-xs" className={styles.detailButton} aria-expanded={expanded} aria-controls={detailsId} onClick={()=>setExpanded(value=>!value)}
          leftSection={<IconChevronDown size={15} className={expanded ? styles.expandedIcon : undefined}/>}>详情</Button>
        {onCancel ? <Button variant="transparent" color="dark.7" size="compact-xs" className={styles.actionButton} onClick={onCancel}>取消</Button> : null}
        {action ? <Button variant="transparent" color="cyan.8" size="compact-xs" className={styles.actionButton} onClick={action.onClick}>{action.label}</Button> : null}
      </div>
    </div>
    {expanded ? <div id={detailsId} className={styles.details}>
      {details.map((line,index)=><p key={index}>{line}</p>)}
      {failed && onResetLegacyMirror ? <Button size="compact-xs" variant="subtle" onClick={onResetLegacyMirror}>清除旧下载镜像</Button> : null}
    </div> : null}
  </section>;
}
