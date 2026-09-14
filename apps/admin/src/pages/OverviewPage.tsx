import { Button, Table, Text } from "@mantine/core";
import type { AdminNodeRecordDto, AdminSnapshotDto } from "@chordv/shared";
import { IconArrowRight, IconChevronRight } from "@tabler/icons-react";
import { CountryFlag } from "../components/CountryFlag";
import { sumNodeCommandSummaries } from "../utils/node-command-summary";
import { translateAgentStatus, translateProbeStatus, translateSubscriptionState } from "../utils/admin-translate";
import styles from "../features/dashboard/Dashboard.module.css";

type OverviewPageProps = {
  snapshot: AdminSnapshotDto;
  onOpenSubscriptions: () => void;
  onOpenCustomers: () => void;
  onOpenTeams: () => void;
  onOpenNodes: () => void;
  onOpenTickets: () => void;
  onOpenSyncQueue: () => void;
};

function nodeAttention(node: AdminNodeRecordDto) {
  if (node.isActive === false) return 3;
  const agent = node.controlStatus ?? node.agent?.status;
  if (["offline", "degraded"].includes(node.probeStatus) || ["offline", "degraded"].includes(agent ?? "")) return 0;
  if (node.probeStatus !== "healthy" || !["online", "active"].includes(agent ?? "")) return 1;
  return 2;
}

export function OverviewPage(props: OverviewPageProps) {
  const { snapshot } = props;
  const now = Date.now();
  const queueCount = snapshot.leaseRevocationJobs.filter(job=>["pending","running","failed"].includes(job.status)).length + sumNodeCommandSummaries(snapshot.nodeCommandQueue.summaries,"nodes");
  const abnormalNodes = snapshot.nodes.filter(node=>nodeAttention(node)===0);
  const pendingNodes = snapshot.nodes.filter(node=>nodeAttention(node)===1);
  const nodeList = [...snapshot.nodes].sort((a,b)=>nodeAttention(a)-nodeAttention(b)||a.name.localeCompare(b.name)).slice(0,4);
  const subscriptions = snapshot.subscriptions.filter(item=>["active","paused"].includes(item.state)&&Date.parse(item.expireAt)>now)
    .sort((a,b)=>Date.parse(a.expireAt)-Date.parse(b.expireAt)).slice(0,4);
  const metrics = [
    {label:"客户",value:snapshot.dashboard.users,open:props.onOpenCustomers},
    {label:"团队",value:snapshot.dashboard.teams,open:props.onOpenTeams},
    {label:"有效订阅",value:snapshot.dashboard.activeSubscriptions,open:props.onOpenSubscriptions},
    {label:"启用节点",value:snapshot.dashboard.activeNodes,open:props.onOpenNodes}
  ];
  return <section className={styles.dashboard} aria-label="仪表台">
    <div className={styles.topline}><Text className={styles.date}>{new Intl.DateTimeFormat("zh-CN",{year:"numeric",month:"long",day:"numeric",weekday:"long"}).format(now)}</Text><Button color="teal.9" rightSection={<IconArrowRight size={16}/>} onClick={props.onOpenNodes}>管理节点</Button></div>
    <div className={styles.tasks} aria-label="待处理事项">
      <button onClick={props.onOpenTickets}>待回复工单 <strong>{snapshot.dashboard.waitingAdminTickets ?? 0}</strong><IconChevronRight size={16}/></button>
      <button onClick={props.onOpenSyncQueue}>后台同步 <strong>{queueCount}</strong><IconChevronRight size={16}/></button>
      <button onClick={props.onOpenNodes}>异常节点 <strong>{abnormalNodes.length}</strong><IconChevronRight size={16}/></button>
      {pendingNodes.length>0?<span>{pendingNodes.length} 个节点状态待确认</span>:null}
    </div>
    <div className={styles.metrics}>{metrics.map(metric=><button key={metric.label} onClick={metric.open}><span>{metric.label}</span><strong>{metric.value.toLocaleString("zh-CN")}</strong></button>)}</div>
    <div className={styles.columns}>
      <section className={styles.subscriptions}><div className={styles.sectionHeading}><h2>最近到期订阅</h2><button onClick={props.onOpenSubscriptions}>查看全部<IconChevronRight size={16}/></button></div>
        <Table.ScrollContainer minWidth={520}><Table className={styles.table}>
          <Table.Thead><Table.Tr><Table.Th>客户</Table.Th><Table.Th>套餐</Table.Th><Table.Th>到期日</Table.Th><Table.Th>状态</Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>{subscriptions.map(item=>{
            const soon = item.state === "active" && Date.parse(item.expireAt)-now <= 7*24*60*60*1000;
            return <Table.Tr key={item.id}><Table.Td><Text size="sm" fw={550}>{item.ownerType === "team" ? item.teamName || "团队订阅" : item.userDisplayName || item.userEmail || "个人订阅"}</Text></Table.Td><Table.Td>{item.planName}</Table.Td><Table.Td>{new Intl.DateTimeFormat("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(item.expireAt))}</Table.Td><Table.Td><Text size="sm" c={soon?"orange.9":item.state==="active"?"teal.9":"dimmed"}>{soon?"7 天内到期":translateSubscriptionState(item.state)}</Text></Table.Td></Table.Tr>;
          })}{!subscriptions.length?<Table.Tr><Table.Td colSpan={4}><Text className={styles.empty}>暂无待到期的有效或暂停订阅</Text></Table.Td></Table.Tr>:null}</Table.Tbody>
        </Table></Table.ScrollContainer>
      </section>
      <section className={styles.nodes}><div className={styles.sectionHeading}><h2>节点状态</h2><button onClick={props.onOpenNodes}>查看全部<IconChevronRight size={16}/></button></div><Text size="sm" c="dimmed" mb="md">优先显示异常及状态待确认的节点</Text>
        {nodeList.map(node=><button key={node.id} className={styles.node} onClick={props.onOpenNodes}><CountryFlag code={node.countryCode}/><div><strong>{node.name}</strong><span>{node.isActive===false?"已停用":`Agent ${translateAgentStatus(node.controlStatus ?? node.agent?.status)}`}</span></div><span className={styles.probe} data-alert={["offline","degraded"].includes(node.probeStatus)}>{node.probeStatus==="healthy"&&node.probeLatencyMs!=null?`TCP ${node.probeLatencyMs} ms`:`TCP ${translateProbeStatus(node.probeStatus)}`}</span></button>)}
        {!nodeList.length?<Text className={styles.empty}>尚未添加节点</Text>:null}
      </section>
    </div>
  </section>;
}
