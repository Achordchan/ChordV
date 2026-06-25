import { ActionIcon, Badge, Button, Drawer, Group, Stack, Table, Text } from "@mantine/core";
import type { AdminLeaseRevocationJobDto, AdminNodeRecordDto, AdminPanelSyncJobDto } from "@chordv/shared";
import { IconBolt, IconListDetails, IconPencil, IconRefresh, IconTrash } from "@tabler/icons-react";
import { CountryFlag } from "../components/CountryFlag";
import { DataTable } from "../features/shared/DataTable";
import { RowActions } from "../features/shared/RowActions";
import { SectionCard } from "../features/shared/SectionCard";
import { StatusBadge } from "../features/shared/StatusBadge";
import { formatDateTime } from "../utils/admin-format";
import { summarizeAdminDiagnosticMessage } from "../utils/admin-filters";
import {
  filterLeaseRevocationJobs,
  filterPanelSyncJobs,
  hasPanelSyncQueueFilter,
  type PanelSyncQueueFilter
} from "../utils/admin-queue-filters";
import { nodePanelColor, nodeProbeColor, translatePanelStatus, translateProbeStatus } from "../utils/admin-translate";

type NodesPageProps = {
  searchValue: string;
  onSearchChange: (value: string) => void;
  nodes: AdminNodeRecordDto[];
  panelSyncJobs: AdminPanelSyncJobDto[];
  leaseRevocationJobs: AdminLeaseRevocationJobDto[];
  panelSyncQueueOpened: boolean;
  panelSyncRetryBusyKey: string | null;
  leaseRevocationRetryBusyKey: string | null;
  probingNodeId: string | null;
  probingAll: boolean;
  refreshingNodeId: string | null;
  onOpenPanelSyncQueue: (filter?: PanelSyncQueueFilter) => void;
  onClosePanelSyncQueue: () => void;
  onRetryPanelSyncJob: (jobId: string) => void;
  onRetryNodePanelSyncJobs: (nodeId: string) => void;
  onRetryLeaseRevocationJob: (jobId: string) => void;
  onRetryNodeLeaseRevocationJobs: (nodeId: string) => void;
  onProbeNode: (nodeId: string) => void;
  onRefreshNode: (nodeId: string) => void;
  onOpenNodeDrawer: (nodeId: string) => void;
  onDeleteNode: (node: AdminNodeRecordDto) => void;
};

export function NodesPage(props: NodesPageProps) {
  const queueCount = props.panelSyncJobs.length + props.leaseRevocationJobs.length;

  return (
    <>
      <SectionCard
        title="节点与同步"
        description="节点状态、面板探测和后台同步任务集中在这里。"
        searchValue={props.searchValue}
        onSearchChange={props.onSearchChange}
        searchPlaceholder="搜索节点、地区或地址"
        actions={
          <Button
            variant="default"
            leftSection={<IconListDetails size={16} />}
            onClick={() => props.onOpenPanelSyncQueue()}
          >
            同步任务
            {queueCount > 0 ? ` · ${queueCount}` : ""}
          </Button>
        }
      >
        <Stack gap="md">
          <DataTable>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>节点</Table.Th>
                <Table.Th>状态</Table.Th>
                <Table.Th>地址</Table.Th>
                <Table.Th>3x-ui</Table.Th>
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
                    <StatusBadge
                      color={nodePanelColor(item.panelStatus, item.panelEnabled)}
                      label={translatePanelStatus(item.panelStatus, item.panelEnabled)}
                    />
                  </Table.Td>
                  <Table.Td>
                    <NodeSyncQueueCell
                      node={item}
                      panelSyncJobs={props.panelSyncJobs}
                      leaseRevocationJobs={props.leaseRevocationJobs}
                      panelRetryBusyKey={props.panelSyncRetryBusyKey}
                      leaseRetryBusyKey={props.leaseRevocationRetryBusyKey}
                      onOpenPanelSyncQueue={props.onOpenPanelSyncQueue}
                      onRetryNodePanelSyncJobs={props.onRetryNodePanelSyncJobs}
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
                        item.panelError || item.probeError,
                        item.panelError ? "面板连接失败，请检查面板配置或同步任务。" : "节点探测失败，请稍后重试。"
                      ) ?? "-"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <RowActions>
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
                        title="从 3x-ui/订阅源重新读取运行参数；面板离线会失败，但不影响本地配置"
                        aria-label="从 3x-ui/订阅源重新读取运行参数"
                        onClick={() => props.onRefreshNode(item.id)}
                        loading={props.refreshingNodeId === item.id}
                        disabled={props.refreshingNodeId !== null && props.refreshingNodeId !== item.id}
                      >
                        <IconRefresh size={16} />
                      </ActionIcon>
                      <ActionIcon variant="subtle" title="编辑本地节点配置" aria-label="编辑本地节点配置" onClick={() => props.onOpenNodeDrawer(item.id)}>
                        <IconPencil size={16} />
                      </ActionIcon>
                      <ActionIcon color="red" variant="subtle" title="停用节点并清理" aria-label="停用节点并清理" onClick={() => props.onDeleteNode(item)}>
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
    </>
  );
}

function NodeSyncQueueCell(props: {
  node: AdminNodeRecordDto;
  panelSyncJobs: AdminPanelSyncJobDto[];
  leaseRevocationJobs: AdminLeaseRevocationJobDto[];
  panelRetryBusyKey: string | null;
  leaseRetryBusyKey: string | null;
  onOpenPanelSyncQueue: (filter?: PanelSyncQueueFilter) => void;
  onRetryNodePanelSyncJobs: (nodeId: string) => void;
  onRetryNodeLeaseRevocationJobs: (nodeId: string) => void;
}) {
  const queuedPanelSummary = summarizePanelSyncJobsForNode(props.panelSyncJobs, props.node.id);
  const panelTotal = Math.max(props.node.panelSyncTotalCount ?? 0, queuedPanelSummary.total);
  const panelSummary = {
    total: panelTotal,
    pending: Math.max(props.node.panelSyncPendingCount ?? 0, queuedPanelSummary.pending),
    running: Math.max(props.node.panelSyncRunningCount ?? 0, queuedPanelSummary.running),
    failed: Math.max(props.node.panelSyncFailedCount ?? 0, queuedPanelSummary.failed),
    actionLabel: queuedPanelSummary.actionLabel,
    lastError: props.node.panelSyncLastError ?? queuedPanelSummary.lastError
  };
  const leaseSummary = summarizeLeaseRevocationJobsForNode(props.leaseRevocationJobs, props.node.id);
  const panelRetryable = hasRetryableBackgroundSync(panelSummary);
  const leaseRetryable = hasRetryableBackgroundSync(leaseSummary);

  if (panelTotal <= 0 && leaseSummary.total <= 0) {
    return (
      <Badge color="green" variant="light">
        已同步
      </Badge>
    );
  }

  return (
    <Stack gap={2}>
      {panelTotal > 0 ? (
        <>
          <Badge color="yellow" variant="light">
            {buildBackgroundSyncLabel("面板同步", panelSummary)}
          </Badge>
          <Text size="xs" c="dimmed" lineClamp={1}>
            {panelSummary.actionLabel}
          </Text>
        </>
      ) : null}
      {leaseSummary.total > 0 ? (
        <Badge color="yellow" variant="light">
          {buildBackgroundSyncLabel("连接撤销", leaseSummary)}
        </Badge>
      ) : null}
      {panelSummary.failed > 0 && panelSummary.lastError ? (
        <Text size="xs" c="dimmed" lineClamp={1}>
          {summarizeAdminDiagnosticMessage(panelSummary.lastError, "面板同步任务失败，请稍后重试或查看服务器日志。")}
        </Text>
      ) : null}
      {leaseSummary.failed > 0 && leaseSummary.lastError ? (
        <Text size="xs" c="dimmed" lineClamp={1}>
          {summarizeAdminDiagnosticMessage(leaseSummary.lastError, "连接撤销任务失败，请稍后重试或查看服务器日志。")}
        </Text>
      ) : null}
      <Group gap={4}>
        <Button
          size="xs"
          variant="subtle"
          onClick={() => props.onOpenPanelSyncQueue({ nodeId: props.node.id, title: props.node.name })}
        >
          查看任务
        </Button>
        {panelRetryable ? (
          <Button
            size="xs"
            variant="light"
            loading={props.panelRetryBusyKey === `node:${props.node.id}`}
            disabled={props.panelRetryBusyKey !== null && props.panelRetryBusyKey !== `node:${props.node.id}`}
            onClick={() => props.onRetryNodePanelSyncJobs(props.node.id)}
          >
            重试面板
          </Button>
        ) : null}
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

function summarizePanelSyncJobsForNode(jobs: AdminPanelSyncJobDto[], nodeId: string) {
  const related = jobs.filter((job) => job.nodeId === nodeId && job.status !== "completed");
  return {
    total: related.length,
    pending: related.filter((job) => job.status === "pending").length,
    running: related.filter((job) => job.status === "running").length,
    failed: related.filter((job) => job.status === "failed").length,
    actionLabel: summarizePanelSyncActions(related),
    lastError: related.find((job) => job.lastError)?.lastError ?? null
  };
}

export function PanelSyncQueueDrawer(props: {
  opened: boolean;
  jobs: AdminPanelSyncJobDto[];
  leaseRevocationJobs: AdminLeaseRevocationJobDto[];
  panelRetryBusyKey: string | null;
  leaseRetryBusyKey: string | null;
  filter?: PanelSyncQueueFilter | null;
  onClose: () => void;
  onShowAll?: () => void;
  onRetryJob: (jobId: string) => void;
  onRetryNode: (nodeId: string) => void;
  onRetryLeaseJob: (jobId: string) => void;
  onRetryLeaseNode: (nodeId: string) => void;
}) {
  const filteredJobs = filterPanelSyncJobs(props.jobs, props.filter);
  const filteredLeaseRevocationJobs = filterLeaseRevocationJobs(props.leaseRevocationJobs, props.filter);
  const hasFilter = hasPanelSyncQueueFilter(props.filter);
  const drawerTitle = hasFilter ? props.filter?.title ?? "当前对象待同步任务" : "后台同步任务";

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
          <Text fw={600}>面板客户端同步</Text>
          <DataTable>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>状态</Table.Th>
                <Table.Th>动作</Table.Th>
                <Table.Th>节点</Table.Th>
                <Table.Th>客户端</Table.Th>
                <Table.Th>次数</Table.Th>
                <Table.Th>下次执行</Table.Th>
                <Table.Th>错误</Table.Th>
                <Table.Th>操作</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {filteredJobs.length === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={8}>
                    <Text c="dimmed">暂无面板客户端同步任务</Text>
                  </Table.Td>
                </Table.Tr>
              ) : (
                filteredJobs.map((job) => {
                  const retryable = isRetryableBackgroundSyncStatus(job.status);
                  const nodeRetryable =
                    canRetryFilteredQueueByNode(props.filter) &&
                    filteredJobs.some(
                      (candidate) => candidate.nodeId === job.nodeId && isRetryableBackgroundSyncStatus(candidate.status)
                    );
                  return (
                  <Table.Tr key={job.id}>
                    <Table.Td>
                      <Badge color={panelSyncStatusColor(job.status)} variant="light">
                        {translatePanelSyncStatus(job.status)}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Badge color={panelSyncActionColor(job.action)} variant="light">
                        {translatePanelSyncAction(job.action)}
                      </Badge>
                    </Table.Td>
                    <Table.Td>{job.nodeName}</Table.Td>
                    <Table.Td>
                      <Text size="sm" lineClamp={1}>
                        {job.panelClientEmail}
                      </Text>
                    </Table.Td>
                    <Table.Td>{job.attempts}</Table.Td>
                    <Table.Td>{formatDateTime(job.nextRunAt)}</Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed" lineClamp={2}>
                        {summarizeAdminDiagnosticMessage(job.lastError, "面板同步任务失败，请稍后重试或查看服务器日志。") ?? "-"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <Button
                          size="xs"
                          variant="light"
                          loading={props.panelRetryBusyKey === `job:${job.id}`}
                          disabled={!retryable || (props.panelRetryBusyKey !== null && props.panelRetryBusyKey !== `job:${job.id}`)}
                          onClick={() => props.onRetryJob(job.id)}
                          title={retryable ? "重试这个同步任务" : "执行中的任务不可重试"}
                        >
                          重试
                        </Button>
                        {canRetryFilteredQueueByNode(props.filter) ? (
                          <Button
                            size="xs"
                            variant="subtle"
                            loading={props.panelRetryBusyKey === `node:${job.nodeId}`}
                            disabled={!nodeRetryable || (props.panelRetryBusyKey !== null && props.panelRetryBusyKey !== `node:${job.nodeId}`)}
                            onClick={() => props.onRetryNode(job.nodeId)}
                            title={nodeRetryable ? "重试这个节点的待同步任务" : "这个节点暂无可重试任务"}
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
                      <Badge color={panelSyncStatusColor(job.status)} variant="light">
                        {translatePanelSyncStatus(job.status)}
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
      </Stack>
    </Drawer>
  );
}

function canRetryFilteredQueueByNode(filter?: PanelSyncQueueFilter | null) {
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

function isRetryableBackgroundSyncStatus(status: AdminPanelSyncJobDto["status"] | AdminLeaseRevocationJobDto["status"]) {
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

function summarizePanelSyncActions(jobs: AdminPanelSyncJobDto[]) {
  const labels = Array.from(new Set(jobs.map((job) => translatePanelSyncAction(job.action))));
  return labels.length > 0 ? `动作：${labels.join(" / ")}` : "动作：待同步";
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
    node_panel_config_changed: "节点面板配置变更",
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

function translatePanelSyncStatus(status: AdminPanelSyncJobDto["status"]) {
  if (status === "pending") return "等待";
  if (status === "running") return "执行中";
  if (status === "failed") return "待重试";
  return "完成";
}

function translatePanelSyncAction(action: AdminPanelSyncJobDto["action"]) {
  if (action === "ensure_client") return "新增/恢复客户端";
  if (action === "disable_client") return "禁用客户端";
  if (action === "delete_client") return "删除客户端";
  if (action === "reset_client_traffic") return "重置流量";
  return action;
}

function panelSyncActionColor(action: AdminPanelSyncJobDto["action"]) {
  if (action === "ensure_client") return "blue";
  if (action === "disable_client") return "orange";
  if (action === "delete_client") return "red";
  if (action === "reset_client_traffic") return "teal";
  return "gray";
}

function panelSyncStatusColor(status: AdminPanelSyncJobDto["status"]) {
  if (status === "pending") return "yellow";
  if (status === "running") return "blue";
  if (status === "failed") return "yellow";
  if (status === "completed") return "green";
  return "gray";
}
