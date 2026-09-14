import { Button } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";
import styles from "./ComponentDelivery.module.css";

export function ComponentError({title, message, onRetry, retrying = false}:{title:string;message:string;onRetry?:()=>void;retrying?:boolean}) {
  const request = message.match(/(?:请求编号|Request ID)\s*[:：]\s*([\w-]+)/i);
  const reason = (request ? message.replace(request[0], "") : message).trim();
  return <div className={styles.errorPanel} role="alert">
    <IconAlertCircle size={20} aria-hidden="true"/>
    <div className={styles.errorBody}><strong>{title}</strong><p>{reason}</p>
      {onRetry ? <Button variant="subtle" color="red.8" size="sm" loading={retrying} onClick={onRetry}>重新读取</Button> : null}
      {request ? <details><summary>诊断信息</summary><p>请求编号：{request[1]}</p></details> : null}
    </div>
  </div>;
}
