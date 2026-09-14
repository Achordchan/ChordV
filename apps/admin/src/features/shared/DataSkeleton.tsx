import { Skeleton } from "@mantine/core";
import styles from "./DataSkeleton.module.css";

/** Layout placeholders represent unread data only. Background refreshes keep
 * their last confirmed content mounted, preserving focus and local edits. */
export function DataSkeleton({ variant = "list", rows = 3 }: { variant?: "list" | "workspace" | "page" | "image" | "line"; rows?: number }) {
  const lines = <div className={styles.rows}>{Array.from({ length: rows }, (_, index) => <div className={styles.row} key={index} aria-hidden="true"><Skeleton circle height={32}/><div className={styles.copy}><Skeleton height={12} width="58%"/><Skeleton height={9} width="80%" mt={10}/></div></div>)}</div>;
  return <div className={`${styles.root} ${styles[variant]}`} role="status" aria-label="正在加载数据" aria-busy="true">
    {variant === "line" ? <Skeleton height={13} width={88}/> : variant === "image" ? <Skeleton height="100%" width="100%"/> : variant === "workspace" ? <><aside><Skeleton height={18} width="35%"/><Skeleton height={36} mt={22}/>{lines}</aside><section><div className={styles.identity}><Skeleton circle height={78}/><div className={styles.copy}><Skeleton height={23} width="48%"/><Skeleton height={12} width="65%" mt={15}/></div></div><Skeleton height={14} width="65%" mt={34}/><div className={styles.content}><Skeleton height={22} width="40%"/><Skeleton height={55} width="48%" mt={36}/><Skeleton height={10} mt={22}/>{lines}</div></section></> : <>{variant === "page" && <><Skeleton height={20} width="30%"/><Skeleton height={36} width="60%" mt={24}/></>}{lines}</>}
  </div>;
}
export function AdminBootSkeleton() {
  return <div className={styles.boot}><aside><Skeleton width={112} height={27}/><Skeleton width={64} height={10} mt={14}/><DataSkeleton rows={6}/></aside><main><Skeleton height={22} width={180} mb={28}/><DataSkeleton variant="workspace"/></main></div>;
}
