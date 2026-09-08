import { useState } from "react";
import { ActionIcon, Badge, Button, Drawer, Group, Stack, Table, Text } from "@mantine/core";
import type { AdminLeaseRevocationJobDto, AdminNodeCommandQueueDto, AdminNodeCommandSummariesDto, AdminNodeRecordDto } from "@chordv/shared";
import { IconBolt, IconListDetails, IconPencil, IconPlus, IconSettingsAutomation, IconTrash } from "@tabler/icons-react";
import { CountryFlag } from "../components/CountryFlag";
import { DataTable } from "../features/shared/DataTable";
import { RowActions } from "../features/shared/RowActions";
import { SectionCard } from "../features/shared/SectionCard";
import { StatusBadge } from "../features/shared/StatusBadge";
import { NodeControlCell, NodeControlDrawer } from "../features/nodes/NodeControlCenter";
import { formatDateTime } from "../utils/admin-format";
import { findNodeCommandSummary, sumNodeCommandSummaries } from "../utils/node-command-summary";
import { summarizeAdminDiagnosticMessage } from "../utils/admin-filters";
import {
  filterLeaseRevocationJobs,
  filterNodeCommandJobs,
  hasLeaseRevocationQueueFilter,
  type LeaseRevocationQueueFilter
} from "../utils/admin-queue-filters";
import {
  nodeCommandStatusColor,
  nodeProbeColor,
  translateNodeCommandStatus,
  translateNodeCommandType,
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

export function NodesPage(props: NodesPageProps) {
  const queueCount = props.leaseRevocationJobs.length;
  const [controlNodeId, setControlNodeId] = useState<string | null>(null);
  const controlNode = props.nodes.find((node) => node.id === controlNodeId) ?? null;

  return (
    <>
      <SectionCard
        title="节点与同步"
        searchValue={props.searchValue}
        onSearchChange={props.onSearchChange}
        searchPlaceholder="搜索节点、地区或地址"
        actions={
          <Group gap="xs">
            <Button
              size="xs"
              leftSection={<IconPlus size={14} />}
              onClick={props.onOpenAgentNodeCreate}
            >
              添加节点
            </Button>
            <Button
              variant="default"
              leftSection={<IconListDetails size={16} />}
              onClick={() => props.onOpenLeaseRevocationQueue()}
            >
              同步任务
              {queueCount > 0 ? ` · ${queueCount}` : ""}
            </Button>
          </Group>
        }
      >
        <Stack gap="md">
          <DataTable>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>节点</Table.Th>
                <Table.Th>状态</Table.Th>
                <Table.Th>地址</Table.Th>
                <Table.Th>控制链路</Table.Th>
                <Table.Th>同步任务</Table.Th>
                <Table.Th>探测状态</Table.Th>
                <Table.Th>延迟</Table.Th>
                <Table.Th>最后检测</Table.Th>
                <Table.Th>错误</Table.Th>
                <Table.Th>操作</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {props.nodes.map((item) => (
                <Table.Tr key={item.id}>
                  <Table.Td>
                    <div>
                      <Text>{item.name}</Text>
                      <Group gap={6} wrap="nowrap" align="center">
                        <CountryFlag code={item.countryCode} size="sm" />
                        <Text size="sm" c="dimmed" lineClamp={1} style={{ minWidth: 0, flex: 1 }}>
                          {item.region} · {item.provider}
                        </Text>
                      </Group>
                    </div>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={item.isActive === false ? "red" : "green"} variant="light">
                      {item.isActive === false ? "已禁用" : "启用"}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{item.serverHost}:{item.serverPort}</Table.Td>
                  <Table.Td>
                    <NodeControlCell node={item} onOpen={() => setControlNodeId(item.id)} />
                  </Table.Td>
                  <Table.Td>
                    <NodeSyncQueueCell
                      node={item}
                      leaseRevocationJobs={props.leaseRevocationJobs}
                      nodeCommandSummaries={props.nodeCommandQueue.summaries}
                      leaseRetryBusyKey={props.leaseRevocationRetryBusyKey}
                      onOpenLeaseRevocationQueue={props.onOpenLeaseRevocationQueue}
                      onRetryNodeLeaseRevocationJobs={props.onRetryNodeLeaseRevocationJobs}
                    />
                  </Table.Td>
                  <Table.Td>
                    <StatusBadge color={nodeProbeColor(item.probeStatus)} label={translateProbeStatus(item.probeStatus)} />
                  </Table.Td>
                  <Table.Td>{item.probeLatencyMs !== null ? `${item.probeLatencyMs} ms` : "-"}</Table.Td>
                  <Table.Td>{item.probeCheckedAt ? formatDateTime(item.probeCheckedAt) : "-"}</Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed" lineClamp={2}>
                      {summarizeAdminDiagnosticMessage(
                        item.probeError,
                        "节点探测失败，请稍后重试。"
                      ) ?? "-"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <RowActions>
                      {item.registrationStatus === "pending_register" ? (
                        <Button size="compact-xs" variant="light" onClick={() => props.onResumeAgentNode(item.id)}>继续接入</Button>
                      ) : null}
                      <ActionIcon
                        variant="subtle"
                        title="探测节点连通性"
                        aria-label="探测节点连通性"
                        onClick={() => props.onProbeNode(item.id)}
                        loading={props.probingNodeId === item.id}
                        disabled={props.probingAll || (props.probingNodeId !== null && props.probingNodeId !== item.id)}
                      >
                        <IconBolt size={16} />
                      </ActionIcon>
                      <ActionIcon
                        variant="subtle"
                        title="打开节点控制器"
                        aria-label="打开节点控制器"
                        onClick={() => setControlNodeId(item.id)}
                      >
                        <IconSettingsAutomation size={16} />
                      </ActionIcon>
                      <ActionIcon variant="subtle" title="编辑本地节点配置" aria-label="编辑本地节点配置" onClick={() => props.onOpenNodeDrawer(item.id)}>
                        <IconPencil size={16} />
                      </ActionIcon>
                      <ActionIcon color="red" variant="subtle" title="删除节点" aria-label="删除节点" onClick={() => props.onDeleteNode(item)}>
                        <IconTrash size={16} />
                      </ActionIcon>
                    </RowActions>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </DataTable>
        </Stack>
      </SectionCard>
      <NodeControlDrawer
        node={controlNode}
        opened={Boolean(controlNode)}
        busy={false}
        onClose={() => setControlNodeId(null)}
        onNodeRecordChanged={props.onNodeRecordChanged}
      />
    </>
  );
}

function NodeSyncQueueCell(props: {
  node: AdminNodeRecordDto;
  leaseRevocationJobs: AdminLeaseRevocationJobDto[];
  // Exact per-node aggregates, not the paginated detail list: a node whose
  // commands fell off the first page must still read as busy.
  nodeCommandSummaries: AdminNodeCommandSummariesDto;
  leaseRetryBusyKey: string | null;
  onOpenLeaseRevocationQueue: (filter?: LeaseRevocationQueueFilter) => void;
  onRetryNodeLeaseRevocationJobs: (nodeId: string) => void;
}) {
  const leaseSummary = summarizeLeaseRevocationJobsForNode(props.leaseRevocationJobs, props.node.id);
  const commandSummary = findNodeCommandSummary(props.nodeCommandSummaries, "nodes", props.node.id);
  const leaseRetryable = hasRetryableBackgroundSync(leaseSummary);

  if (leaseSummary.total <= 0 && (commandSummary?.total ?? 0) <= 0) {
    return (
      <Badge color="green" variant="light">
        已同步
      </Badge>
    );
  }

  return (
    <Stack gap={2}>
      {leaseSummary.total > 0 ? (
        <Badge color="yellow" variant="light">
          {buildBackgroundSyncLabel("连接撤销", leaseSummary)}
        </Badge>
      ) : null}
      {commandSummary && commandSummary.total > 0 ? (
        <Badge color="yellow" variant="light">
          {buildBackgroundSyncLabel("节点命令", commandSummary)}
        </Badge>
      ) : null}
      {leaseSummary.failed > 0 && leaseSummary.lastError ? (
        <Text size="xs" c="dimmed" lineClamp={1}>
          {summarizeAdminDiagnosticMessage(leaseSummary.lastError, "连接撤销任务失败，请稍后重试或查看服务器日志。")}
        </Text>
      ) : null}
      {commandSummary && commandSummary.failed > 0 && commandSummary.lastError ? (
        <Text size="xs" c="dimmed" lineClamp={1}>
          {summarizeAdminDiagnosticMessage(commandSummary.lastError, "节点命令执行失败，Agent 会自动重试。")}
        </Text>
      ) : null}
      <Group gap={4}>
        <Button
          size="xs"
          variant="subtle"
          onClick={() => props.onOpenLeaseRevocationQueue({ nodeId: props.node.id, title: props.node.name })}
        >
          查看任务
        </Button>
        {leaseRetryable ? (
          <Button
            size="xs"
            variant="light"
            loading={props.leaseRetryBusyKey === `lease-node:${props.node.id}`}
            disabled={props.leaseRetryBusyKey !== null && props.leaseRetryBusyKey !== `lease-node:${props.node.id}`}
            onClick={() => props.onRetryNodeLeaseRevocationJobs(props.node.id)}
          >
            重试连接撤销
          </Button>
        ) : null}
      </Group>
    </Stack>
  );
}

export function PanelSyncQueueDrawer(props: {
  opened: boolean;
  leaseRevocationJobs: AdminLeaseRevocationJobDto[];
  nodeCommandQueue: AdminNodeCommandQueueDto;
  leaseRetryBusyKey: string | null;
  filter?: LeaseRevocationQueueFilter | null;
  onClose: () => void;
  onShowAll?: () => void;
  onRetryLeaseJob: (jobId: string) => void;
  onRetryLeaseNode: (nodeId: string) => void;
}) {
  const filteredLeaseRevocationJobs = filterLeaseRevocationJobs(props.leaseRevocationJobs, props.filter);
  const filteredNodeCommandJobs = filterNodeCommandJobs(props.nodeCommandQueue.jobs, props.filter);
  const listedCommandTotal = sumNodeCommandSummaries(props.nodeCommandQueue.summaries, "nodes");
  const hasFilter = hasLeaseRevocationQueueFilter(props.filter);
  const drawerTitle = hasFilter ? props.filter?.title ?? "当前对象待处理任务" : "后台同步任务";

  return (
    <Drawer opened={props.opened} onClose={props.onClose} title={drawerTitle} position="right" size="xl">
      <Stack gap="lg">
        {hasFilter ? (
          <Group justify="space-between" gap="sm">
            <Text size="sm" c="dimmed">
              仅显示当前对象相关的后台同步任务。
            </Text>
            <Button size="xs" variant="default" onClick={props.onShowAll}>
              查看全部
            </Button>
          </Group>
        ) : null}
        <Stack gap="xs">
          <Text fw={600}>连接撤销同步</Text>
          <DataTable>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>状态</Table.Th>
                <Table.Th>节点/目标</Table.Th>
                <Table.Th>原因</Table.Th>
                <Table.Th>次数</Table.Th>
                <Table.Th>下次执行</Table.Th>
                <Table.Th>错误</Table.Th>
                <Table.Th>操作</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {filteredLeaseRevocationJobs.length === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={7}>
                    <Text c="dimmed">暂无连接撤销同步任务</Text>
                  </Table.Td>
                </Table.Tr>
              ) : (
                filteredLeaseRevocationJobs.map((job) => {
                  const retryable = isRetryableBackgroundSyncStatus(job.status);
                  const nodeRetryable = job.nodeId && canRetryFilteredQueueByNode(props.filter)
                    ? filteredLeaseRevocationJobs.some(
                        (candidate) => candidate.nodeId === job.nodeId && isRetryableBackgroundSyncStatus(candidate.status)
                      )
                    : false;
                  return (
                  <Table.Tr key={job.id}>
                    <Table.Td>
                      <Badge color={leaseRevocationStatusColor(job.status)} variant="light">
                        {translateLeaseRevocationStatus(job.status)}
                      </Badge>
                    </Table.Td>
                    <Table.Td>{leaseRevocationJobTargetLabel(job)}</Table.Td>
                    <Table.Td>{translateLeaseRevocationReason(job.reason)}</Table.Td>
                    <Table.Td>{job.attempts}</Table.Td>
                    <Table.Td>{formatDateTime(job.nextRunAt)}</Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed" lineClamp={2}>
                        {summarizeAdminDiagnosticMessage(job.lastError, "连接撤销任务失败，请稍后重试或查看服务器日志。") ?? "-"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <Button
                          size="xs"
                          variant="light"
                          loading={props.leaseRetryBusyKey === `lease-job:${job.id}`}
                          disabled={!retryable || (props.leaseRetryBusyKey !== null && props.leaseRetryBusyKey !== `lease-job:${job.id}`)}
                          onClick={() => props.onRetryLeaseJob(job.id)}
                          title={retryable ? "重试这个连接撤销任务" : "执行中的任务不可重试"}
                        >
                          重试
                        </Button>
                        {job.nodeId && canRetryFilteredQueueByNode(props.filter) ? (
                          <Button
                            size="xs"
                            variant="subtle"
                            loading={props.leaseRetryBusyKey === `lease-node:${job.nodeId}`}
                            disabled={!nodeRetryable || (props.leaseRetryBusyKey !== null && props.leaseRetryBusyKey !== `lease-node:${job.nodeId}`)}
                            onClick={() => props.onRetryLeaseNode(job.nodeId!)}
                            title={nodeRetryable ? "重试这个节点的连接撤销任务" : "这个节点暂无可重试任务"}
                          >
                            重试节点
                          </Button>
                        ) : null}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                  );
                })
              )}
            </Table.Tbody>
          </DataTable>
        </Stack>
        <Stack gap="xs">
          <Text fw={600}>节点命令同步</Text>
          {!hasFilter && listedCommandTotal > props.nodeCommandQueue.jobs.length ? (
            <Text size="xs" c="dimmed">
              {`仅显示最近 ${props.nodeCommandQueue.jobs.length} 条，共 ${listedCommandTotal} 条待处理；节点状态列显示的是完整计数。`}
            </Text>
          ) : null}
          <DataTable>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>状态</Table.Th>
                <Table.Th>节点</Table.Th>
                <Table.Th>命令</Table.Th>
                <Table.Th>次数</Table.Th>
                <Table.Th>下次执行</Table.Th>
                <Table.Th>错误</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {filteredNodeCommandJobs.length === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={6}>
                    <Text c="dimmed">暂无待处理的节点命令</Text>
                  </Table.Td>
                </Table.Tr>
              ) : (
                filteredNodeCommandJobs.map((job) => (
                  <Table.Tr key={job.id}>
                    <Table.Td>
                      <Badge color={nodeCommandStatusColor(job.status)} variant="light">
                        {translateNodeCommandStatus(job.status)}
                      </Badge>
                    </Table.Td>
                    <Table.Td>{job.nodeName ?? job.nodeId}</Table.Td>
                    <Table.Td>{translateNodeCommandType(job.commandType)}</Table.Td>
                    <Table.Td>{job.attempts}</Table.Td>
                    <Table.Td>{formatDateTime(job.nextRunAt)}</Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed" lineClamp={2}>
                        {summarizeAdminDiagnosticMessage(job.lastError, "节点命令执行失败，Agent 会自动重试，超过上限后取消。") ?? "-"}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))
              )}
            </Table.Tbody>
          </DataTable>
        </Stack>
      </Stack>
    </Drawer>
  );
}

function canRetryFilteredQueueByNode(filter?: LeaseRevocationQueueFilter | null) {
  return !filter?.subscriptionId && !filter?.userId && !filter?.teamId;
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

function buildBackgroundSyncLabel(
  prefix: string,
  summary: { pending: number; running: number; failed: number; total: number }
) {
  const parts = [
    summary.pending > 0 ? `待同步 ${summary.pending}` : null,
    summary.running > 0 ? `执行中 ${summary.running}` : null,
    summary.failed > 0 ? `待重试 ${summary.failed}` : null
  ].filter(Boolean);
  return parts.length > 0 ? `${prefix}${parts.join(" / ")}` : `${prefix}待同步`;
}

function leaseRevocationJobTargetLabel(job: AdminLeaseRevocationJobDto) {
  return job.nodeName ?? job.nodeId ?? job.subscriptionId ?? job.userId ?? "全局连接";
}

function translateLeaseRevocationReason(reason: string) {
  const labels: Record<string, string> = {
    admin_user_disconnected: "管理员断开连接",
    connection_taken_over: "连接被接管",
    lease_expired: "连接租约过期",
    node_access_revoked: "节点授权取消",
    node_deleted: "节点删除",
    subscription_expired: "订阅到期",
    subscription_exhausted: "流量耗尽",
    subscription_inactive: "订阅不可用",
    subscription_paused: "订阅暂停",
    subscription_user_disabled: "账号禁用",
    team_disabled: "团队停用",
    team_member_removed: "团队成员移除",
    team_membership_missing: "团队成员关系失效",
    user_disabled: "账号禁用"
  };
  return labels[reason] ?? reason.replace(/_/g, " ");
}

function translateLeaseRevocationStatus(status: AdminLeaseRevocationJobDto["status"]) {
  if (status === "pending") return "等待";
  if (status === "running") return "执行中";
  if (status === "failed") return "待重试";
  return "完成";
}

function leaseRevocationStatusColor(status: AdminLeaseRevocationJobDto["status"]) {
  if (status === "pending") return "yellow";
  if (status === "running") return "blue";
  if (status === "failed") return "yellow";
  if (status === "completed") return "green";
  return "gray";
}
