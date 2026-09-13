import { Fragment, useState } from "react";
import { ActionIcon, Button, Group, Menu, SegmentedControl, Table, Text, TextInput } from "@mantine/core";
import type { AdminLeaseRevocationJobDto, AdminNodeCommandQueueDto, AdminNodeRecordDto } from "@chordv/shared";
import { IconAlertCircle, IconArrowRight, IconChevronDown, IconChevronUp, IconDots, IconPencil, IconSearch, IconTrash } from "@tabler/icons-react";
import { CountryFlag } from "../components/CountryFlag";
import { DataTable } from "../features/shared/DataTable";
import { NodeControlDetails } from "../features/nodes/NodeControlCenter";
import styles from "../features/nodes/NodesWorkspace.module.css";
import { formatDateTime } from "../utils/admin-format";
import { findNodeCommandSummary } from "../utils/node-command-summary";
import type { LeaseRevocationQueueFilter } from "../utils/admin-queue-filters";
import {
  translateAgentStatus,
  translateProbeStatus
} from "../utils/admin-translate";

type NodesPageProps = {
  searchValue: string;
  onSearchChange: (value: string) => void;
  nodes: AdminNodeRecordDto[];
  leaseRevocationJobs: AdminLeaseRevocationJobDto[];
  nodeCommandQueue: AdminNodeCommandQueueDto;
  leaseRevocationRetryBusyKey: string | null;
  probingNodeId: string | null;
  probingAll: boolean;
  onProbeAll: () => void;
  onOpenLeaseRevocationQueue: (filter?: LeaseRevocationQueueFilter) => void;
  onRetryLeaseRevocationJob: (jobId: string) => void;
  onRetryNodeLeaseRevocationJobs: (nodeId: string) => void;
  onProbeNode: (nodeId: string) => void;
  onNodeRecordChanged: (node: AdminNodeRecordDto) => void;
  onOpenNodeDrawer: (nodeId: string) => void;
  onDeleteNode: (node: AdminNodeRecordDto) => void;
  onOpenAgentNodeCreate: () => void;
  onResumeAgentNode: (nodeId: string) => void;
};

function needsOnboarding(node: AdminNodeRecordDto) {
  return node.registrationStatus === "pending_register" || (node.registrationStatus === "agent_ready" && node.inboundAppliedRevision === "0");
}

export function NodesPage(props: NodesPageProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("全部");
  const rows = props.nodes.map(node => {
    const lease = summarizeLeaseRevocationJobsForNode(props.leaseRevocationJobs, node.id);
    const command = findNodeCommandSummary(props.nodeCommandQueue.summaries, "nodes", node.id);
    const total = lease.total + (command?.total ?? 0);
    const failed = lease.failed + (command?.failed ?? 0);
    const agentStatus = node.controlStatus ?? node.agent?.status;
    const needsAttention = total > 0 || node.probeStatus === "offline" || node.probeStatus === "degraded" || agentStatus === "offline" || agentStatus === "degraded";
    return { node, lease, total, failed, agentStatus, needsAttention };
  }).filter(row => filter === "全部" || (filter === "待接入" ? needsOnboarding(row.node) : row.needsAttention));

  return <section className={styles.workspace} aria-label="节点与同步">
    <div className={styles.toolbar}>
      <TextInput className={styles.search} aria-label="搜索节点" placeholder="搜索节点、地区或地址" leftSection={<IconSearch size={16}/>} value={props.searchValue} onChange={event => props.onSearchChange(event.currentTarget.value)}/>
      <SegmentedControl classNames={{root: styles.filters, label: styles.filterLabel, indicator: styles.filterIndicator}} aria-label="节点筛选" value={filter} onChange={setFilter} data={["全部", "需处理", "待接入"]}/>
      <div className={styles.toolbarActions}><Button variant="subtle" color="gray" loading={props.probingAll} disabled={props.probingNodeId !== null} onClick={props.onProbeAll}>全部探测</Button><Button className={styles.addButton} onClick={props.onOpenAgentNodeCreate}>添加节点</Button></div>
    </div>
    <div className={styles.tableArea}>
      <DataTable minWidth={920}>
        <colgroup><col/><col style={{width:"14%"}}/><col style={{width:"17%"}}/><col style={{width:"16%"}}/><col style={{width:"16%"}}/><col style={{width:190}}/></colgroup>
        <Table.Thead><Table.Tr>{["节点", "服务状态", "控制链路", "连通性", "同步", "操作"].map(label => <Table.Th key={label}>{label}</Table.Th>)}</Table.Tr></Table.Thead>
        <Table.Tbody>
          {rows.length === 0 ? <Table.Tr><Table.Td colSpan={6}><Text className={styles.empty}>没有符合条件的节点</Text></Table.Td></Table.Tr> : rows.map(({node, lease, total, failed, agentStatus}) => {
            const expanded = expandedId === node.id;
            const toggle = () => setExpandedId(expanded ? null : node.id);
            return <Fragment key={node.id}>
              <Table.Tr className={expanded ? styles.expandedRow : undefined}>
                <Table.Td><div className={styles.identity}><CountryFlag code={node.countryCode}/><div><button className={styles.nodeName} onClick={() => props.onOpenNodeDrawer(node.id)}>{node.name}</button><Text size="xs" c="dimmed" className={styles.address}>{node.serverHost}:{node.serverPort}</Text></div></div></Table.Td>
                <Table.Td><Text className={styles.status} data-tone={node.isActive === false ? "muted" : "good"} size="sm">{node.isActive === false ? "已停用" : "已启用"}</Text></Table.Td>
                <Table.Td><Text className={styles.status} data-tone={agentStatus === "online" || agentStatus === "active" ? "good" : agentStatus === "offline" ? "bad" : "muted"} size="sm">{node.registrationStatus === "pending_register" ? "待接入" : `Agent ${translateAgentStatus(agentStatus)}`}</Text></Table.Td>
                <Table.Td><Text className={styles.status} data-tone={node.probeStatus === "healthy" ? "good" : node.probeStatus === "offline" ? "bad" : node.probeStatus === "degraded" ? "warning" : "muted"} size="sm">{node.probeStatus === "healthy" && node.probeLatencyMs != null ? `TCP ${node.probeLatencyMs} ms` : `TCP ${translateProbeStatus(node.probeStatus)}`}</Text></Table.Td>
                <Table.Td>{total > 0 ? <Button className={styles.syncButton} data-tone={failed > 0 ? "warning" : "progress"} variant="subtle" size="compact-sm" color="dark" onClick={() => props.onOpenLeaseRevocationQueue({nodeId: node.id, title: node.name})}>{total} 项待处理</Button> : <Text className={styles.status} data-tone="good" size="sm">无待处理</Text>}</Table.Td>
                <Table.Td className={styles.actionsCell}><Group gap={6} wrap="nowrap" justify="flex-end">
                  {needsOnboarding(node) ? <Button variant="subtle" size="compact-sm" color="teal.9" onClick={() => props.onResumeAgentNode(node.id)}>继续接入</Button> : null}
                  <ActionIcon variant="subtle" color="gray" aria-label={expanded ? "收起节点详情" : "展开节点详情"} aria-expanded={expanded} aria-controls={expanded ? `node-details-${node.id}` : undefined} onClick={toggle}>{expanded ? <IconChevronUp size={17}/> : <IconChevronDown size={17}/>}</ActionIcon>
                  <Menu position="bottom-end" withinPortal><Menu.Target><ActionIcon variant="subtle" color="gray" aria-label={`${node.name}的更多操作`}><IconDots size={17}/></ActionIcon></Menu.Target><Menu.Dropdown>
                    <Menu.Item leftSection={<IconPencil size={16}/>} onClick={() => props.onOpenNodeDrawer(node.id)}>编辑节点</Menu.Item>
                    <Menu.Item color="red" leftSection={<IconTrash size={16}/>} onClick={() => props.onDeleteNode(node)}>删除节点</Menu.Item>
                  </Menu.Dropdown></Menu>
                </Group></Table.Td>
              </Table.Tr>
              {expanded ? <Table.Tr className={styles.detailRow}><Table.Td colSpan={6}><div id={`node-details-${node.id}`} className={styles.details}>
                <Group className={styles.probePanel} justify="space-between" align="center" gap="lg">
                  <div className={styles.probeInfo}>{node.probeError ? <IconAlertCircle className={styles.errorIcon} size={24}/> : null}<div><Text fw={600} c={node.probeError ? "red.8" : undefined}>{node.probeError ? "节点探测异常" : "节点运行详情"}</Text>
                    {node.probeError ? <Text size="sm" className={styles.error}>{node.probeError}</Text> : null}
                    <Text size="xs" c="dimmed" mt={8}>{[node.region, node.provider].filter(Boolean).join(" · ") || "未设置地区与供应商"} · 最后检测 {node.probeCheckedAt ? formatDateTime(node.probeCheckedAt) : "尚未检测"}</Text>
                  </div></div>
                  <Group gap="sm"><Button variant="default" size="sm" loading={props.probingNodeId === node.id} disabled={props.probingAll || (props.probingNodeId !== null && props.probingNodeId !== node.id)} onClick={() => props.onProbeNode(node.id)}>重新探测</Button>
                    {total > 0 ? <Button variant="subtle" color="teal.9" size="sm" onClick={() => props.onOpenLeaseRevocationQueue({nodeId: node.id, title: node.name})} rightSection={<IconArrowRight size={15}/>}>查看 {total} 项同步任务</Button> : null}
                    {hasRetryableBackgroundSync(lease) ? <Button variant="subtle" size="sm" color="teal.9" loading={props.leaseRevocationRetryBusyKey === `lease-node:${node.id}`} disabled={props.leaseRevocationRetryBusyKey !== null && props.leaseRevocationRetryBusyKey !== `lease-node:${node.id}`} onClick={() => props.onRetryNodeLeaseRevocationJobs(node.id)}>重试连接撤销</Button> : null}
                  </Group>
                </Group>
                <NodeControlDetails node={node} onNodeRecordChanged={props.onNodeRecordChanged} onResume={() => props.onResumeAgentNode(node.id)} onEdit={() => props.onOpenNodeDrawer(node.id)}/>
              </div></Table.Td></Table.Tr> : null}
            </Fragment>;
          })}
        </Table.Tbody>
      </DataTable>
    </div>
    <Text size="xs" c="dimmed" ta="right" mt="md">当前显示 {rows.length} 个节点</Text>
  </section>;
}

function summarizeLeaseRevocationJobsForNode(jobs: AdminLeaseRevocationJobDto[], nodeId: string) {
  const related = jobs.filter((job) => job.nodeId === nodeId && job.status !== "completed");
  return {
    total: related.length,
    pending: related.filter((job) => job.status === "pending").length,
    running: related.filter((job) => job.status === "running").length,
    failed: related.filter((job) => job.status === "failed").length,
    lastError: related.find((job) => job.lastError)?.lastError ?? null
  };
}



function isRetryableBackgroundSyncStatus(status: AdminLeaseRevocationJobDto["status"]) {
  return status === "pending" || status === "failed";
}

function hasRetryableBackgroundSync(summary: { pending: number; failed: number }) {
  return summary.pending > 0 || summary.failed > 0;
}


// 兼容现有 App 入口，逐步迁移到 SyncTasksModal。
export { SyncTasksModal as PanelSyncQueueDrawer } from "../features/nodes/SyncTasksModal";
