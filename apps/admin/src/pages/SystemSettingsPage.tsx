import { Badge, Button, Text } from "@mantine/core";
import { useState } from "react";
import { NetworkSettingsModal } from "../features/system-settings/NetworkSettingsModal";
import { IconListDetails, IconLogout, IconPhoto, IconRoute, IconShieldLock } from "@tabler/icons-react";
import styles from "../features/system-settings/SystemSettings.module.css";

type SystemSettingsPageProps = {
  accountLabel: string;
  pendingTaskCount: number;
  onOpenSecurity: () => void;
  onOpenTasks: () => void;
  onOpenPolicies: () => void;
  onOpenImageBed: () => void;
  onLogout: () => void;
};

export function SystemSettingsPage(props: SystemSettingsPageProps) {
  const [networkOpened,setNetworkOpened] = useState(false);
  return <div className={styles.page}>
    <NetworkSettingsModal opened={networkOpened} onClose={()=>setNetworkOpened(false)}/>
    <section className={styles.section} aria-labelledby="settings-account"><h2 id="settings-account">账号与安全</h2>
      <div className={styles.row}><IconShieldLock className={styles.icon} size={22}/><div className={styles.copy}><h3>管理员账号</h3><p>当前登录：{props.accountLabel}</p><small>管理登录账号与密码</small></div><Button variant="default" onClick={props.onOpenSecurity}>账号安全</Button></div>
    </section>
    <section className={styles.section} aria-labelledby="settings-runtime"><h2 id="settings-runtime">运行管理</h2>
      <div className={styles.row}><IconRoute className={styles.icon} size={22}/><div className={styles.copy}><h3>站点地址与下载镜像</h3><p>管理客户端主地址、域名迁移与全局镜像</p></div><Button variant="default" onClick={()=>setNetworkOpened(true)}>管理地址</Button></div>
      <div className={styles.row}><IconListDetails className={styles.icon} size={22}/><div className={styles.copy}><h3>同步任务 {props.pendingTaskCount > 0 && <Badge size="xs" color="orange" variant="light">{props.pendingTaskCount}</Badge>}</h3><p>查看节点命令、连接撤销与失败重试</p></div><Button variant="default" onClick={props.onOpenTasks}>查看任务</Button></div>
      <div className={styles.row}><IconRoute className={styles.icon} size={22}/><div className={styles.copy}><h3>连接策略</h3><p>配置客户端默认模式与分流规则</p></div><Button variant="default" onClick={props.onOpenPolicies}>管理策略</Button></div>
      <div className={styles.row}><IconPhoto className={styles.icon} size={22}/><div className={styles.copy}><h3>附件与图床</h3><p>管理附件存储及图床配置</p></div><Button variant="default" onClick={props.onOpenImageBed}>管理存储</Button></div>
    </section>
    <section className={styles.section} aria-labelledby="settings-session"><h2 id="settings-session">登录会话</h2>
      <div className={styles.row}><IconLogout className={styles.icon} size={22}/><div className={styles.copy}><h3>退出当前账号</h3><p>退出后需重新登录运营后台</p></div><Button variant="light" color="red" onClick={props.onLogout}>退出登录</Button></div>
    </section>
    <Text size="xs" c="dimmed" mt="md">系统版本与更新入口位于左侧导航底部。</Text>
  </div>;
}
