import { Badge, Button, Group, Text } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { formatDateTime, formatTrafficGb } from "../../utils/admin-format";
import { subscriptionStateColor, translateSourceAction, translateSubscriptionState } from "../../utils/admin-translate";
import { CustomerNodes } from "./CustomerNodes";
import type { CustomerRecord } from "./customer-model";
import type { UsersPageProps } from "./types";
import styles from "./CustomerWorkspace.module.css";

export function CustomerSubscription({ customer, actions }: { customer: CustomerRecord; actions: UsersPageProps }) {
  const record = customer.subscription;
  const subscription = record ?? customer.summary;
  const create = () => customer.user ? actions.onCreateSubscriptionForUser(customer.user) : customer.team && actions.onOpenTeamSubscriptions(customer.team);
  if (!subscription) return <div className={styles.empty}><IconPlus size={30}/><h2>为{customer.name}开通订阅</h2><p>选择套餐后，再分配可使用的节点。</p><Button color="#1c4d37" onClick={create}>开通订阅</Button></div>;
  const total = record?.totalTrafficGb ?? (customer.team ? customer.team.currentSubscription?.totalTrafficGb : undefined);
  const used = record?.usedTrafficGb ?? (customer.team ? customer.team.currentSubscription?.usedTrafficGb : undefined);
  const percent = total !== undefined && used !== undefined && total > 0 ? Math.max(0, Math.min(100, used / total * 100)) : null;
  const manage = () => actions.onOpenNodeAccessEditor(subscription.id, `${customer.name} · ${subscription.planName}`);
  return <>
    <div className={styles.planHeader}><div><Group gap="md"><h2>{subscription.planName}</h2><Badge variant="light" color={subscriptionStateColor(subscription.state)}>{translateSubscriptionState(subscription.state)}</Badge></Group><p>到期时间 <span>{formatDateTime(subscription.expireAt)}</span></p></div>
      <div className={styles.textActions}><button onClick={() => actions.onOpenChangePlanDrawer(subscription.id)}>变更套餐</button><button onClick={() => actions.onOpenAdjustDrawer(subscription.id)}>调整订阅</button></div>
    </div>
    <section className={styles.usage}><h3>{customer.team ? "团队共享剩余流量" : "剩余流量"}</h3>
      <div className={styles.usageNumbers}><strong>{formatTrafficGb(subscription.remainingTrafficGb)}<span>GB</span></strong>{total !== undefined && <span>/ {formatTrafficGb(total)} GB</span>}</div>
      {percent !== null && <div className={styles.usageBarRow}><div className={styles.usageBar} role="progressbar" aria-label="已用流量比例" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}><span style={{ width: `${percent}%`, background: subscription.state === "exhausted" ? "#b32b3c" : undefined }}/></div><span>已用 {Math.round(percent)}%</span></div>}
      <p>{total !== undefined ? `总额度 ${formatTrafficGb(total)} GB` : "总额度待同步"}{used !== undefined ? ` · 已用 ${formatTrafficGb(used)} GB` : ""} · 剩余 {formatTrafficGb(subscription.remainingTrafficGb)} GB</p>
      {customer.team && <Text size="sm" c="dimmed" mt="xs">{customer.team.memberCount} 位成员共用团队额度</Text>}
    </section>
    <div className={styles.subscriptionBottom}>
      {record ? <CustomerNodes subscription={record} compact onManage={manage}/> : <section><div className={styles.sectionHeading}><h3>节点授权</h3><button className={styles.textButton} onClick={manage}>管理授权</button></div><Text size="sm" c="dimmed">订阅详情尚未同步，请刷新客户数据。</Text></section>}
      <section className={styles.facts}><h3>订阅信息</h3><dl><div><dt>开通方式</dt><dd>{record ? translateSourceAction(record.sourceAction) : "待同步"}</dd></div><div><dt>到期时间</dt><dd>{formatDateTime(subscription.expireAt)}</dd></div><div><dt>订阅类型</dt><dd>{customer.team ? "团队共享" : "个人订阅"}</dd></div></dl></section>
    </div>
  </>;
}
