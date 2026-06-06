import { ActionIcon, Badge, Button, Drawer, Group, Stack, Table, Text } from "@mantine/core";
import type { AdminLeaseRevocationJobDto, AdminNodeRecordDto, AdminPanelSyncJobDto } from "@chordv/shared";
import { IconBolt, IconListDetails, IconPencil, IconRefresh, IconTrash } from "@tabler/icons-react";
import { CountryFlag } from "../components/CountryFlag";
import { DataTable } from "../features/shared/DataTable";
import { RowActions } from "../features/shared/RowActions";
import { SectionCard } from "../features/shared/SectionCard";
import { StatusBadge } from "../features/shared/StatusBadge";
import { formatDateTime } from "../utils/admin-format";
import { nodePanelColor, nodeProbeColor, translatePanelStatus, translateProbeStatus } from "../utils/admin-translate";

type NodesPageProps = {
  searchValue: string;
  onSearchChange: (value: string) => void;
  nodes: AdminNodeRecordDto[];
  panelSyncJobs: AdminPanelSyncJobDto[];
  leaseRevocationJobs: AdminLeaseRevocationJobDto[];
  panelSyncQueueOpened: boolean;
  panelSyncRetryBusyKey: string | null;
  probingNodeId: string | null;
  onOpenPanelSyncQueue: () => void;
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
      <SectionCard searchValue={props.searchValue} onSearchChange={props.onSearchChange}>
        <Stack gap="md">
          <Group justify="flex-end">
            <Button
              variant="default"
              leftSection={<IconListDetails size={16} />}
              onClick={props.onOpenPanelSyncQueue}
            >
              同步队列
              {queueCount > 0 ? ` · ${queueCount}` : ""}
            </Button>
          </Group>
          <DataTable>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>节点</Table.Th>
                <Table.Th>状态</Table.Th>
                <Table.Th>地址</Table.Th>
                <Table.Th>3x-ui</Table.Th>
                <Table.Th>同步队列</Table.Th>
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
                      retryBusyKey={props.panelSyncRetryBusyKey}
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
                      {item.panelError || item.probeError || "-"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <RowActions>
                      <ActionIcon
                        variant="subtle"
                        title="探测节点连通性"
                        onClick={() => props.onProbeNode(item.id)}
                        loading={props.probingNodeId === item.id}
                      >
                        <IconBolt size={16} />
                      </ActionIcon>
                      <ActionIcon
                        variant="subtle"
                        title="从 3x-ui/订阅源重新读取运行参数；面板离线会失败，但不影响本地配置"
                        onClick={() => props.onRefreshNode(item.id)}
                      >
                        <IconRefresh size={16} />
                      </ActionIcon>
                      <ActionIcon variant="subtle" title="编辑本地节点配置" onClick={() => props.onOpenNodeDrawer(item.id)}>
                        <IconPencil size={16} />
                      </ActionIcon>
                      <ActionIcon color="red" variant="subtle" title="删除节点" onClick={() => props.onDeleteNode(item)}>
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
      <PanelSyncQueueDrawer
        opened={props.panelSyncQueueOpened}
        jobs={props.panelSyncJobs}
        leaseRevocationJobs={props.leaseRevocationJobs}
        retryBusyKey={props.panelSyncRetryBusyKey}
        onClose={props.onClosePanelSyncQueue}
        onRetryJob={props.onRetryPanelSyncJob}
        onRetryNode={props.onRetryNodePanelSyncJobs}
        onRetryLeaseJob={props.onRetryLeaseRevocationJob}
        onRetryLeaseNode={props.onRetryNodeLeaseRevocationJobs}
      />
    </>
  );
}

function NodeSyncQueueCell(props: {
  node: AdminNodeRecordDto;
  panelSyncJobs: AdminPanelSyncJobDto[];
  leaseRevocationJobs: AdminLeaseRevocationJobDto[];
  retryBusyKey: string | null;
  onRetryNodePanelSyncJobs: (nodeId: string) => void;
  onRetryNodeLeaseRevocationJobs: (nodeId: string) => void;
}) {
  const panelSummary = summarizePanelSyncJobsForNode(props.panelSyncJobs, props.node.id);
  const panelPending = panelSummary.pending;
  const panelRunning = panelSummary.running;
  const panelFailed = panelSummary.failed;
  const panelTotal = panelSummary.total;
  const leaseSummary = summarizeLeaseRevocationJobsForNode(props.leaseRevocationJobs, props.node.id);

  if (panelTotal <= 0 && leaseSummary.total <= 0) {
    return (
      <Badge color="green" variant="light">
        已同步
      </Badge>
    );
  }

  return (
    <Stack gap={2}>
      {panelPending > 0 ? (
        <Badge color="yellow" variant="light">
          面板待同步 {panelPending}
        </Badge>
      ) : null}
      {panelRunning > 0 ? (
        <Badge color="blue" variant="light">
          面板执行中 {panelRunning}
        </Badge>
      ) : null}
      {panelFailed > 0 ? (
        <Badge color="red" variant="light">
          面板失败 {panelFailed}
        </Badge>
      ) : null}
      {leaseSummary.pending > 0 ? (
        <Badge color="yellow" variant="light">
          连接撤销待同步 {leaseSummary.pending}
        </Badge>
      ) : null}
      {leaseSummary.running > 0 ? (
        <Badge color="blue" variant="light">
          连接撤销执行中 {leaseSummary.running}
        </Badge>
      ) : null}
      {leaseSummary.failed > 0 ? (
        <Badge color="red" variant="light">
          连接撤销失败 {leaseSummary.failed}
        </Badge>
      ) : null}
      {panelSummary.lastError ? (
        <Text size="xs" c="dimmed" lineClamp={1}>
          {panelSummary.lastError}
        </Text>
      ) : null}
      {leaseSummary.lastError ? (
        <Text size="xs" c="dimmed" lineClamp={1}>
          {leaseSummary.lastError}
        </Text>
      ) : null}
      <Group gap={4}>
        {panelTotal > 0 ? (
          <Button
            size="xs"
            variant="light"
            loading={props.retryBusyKey === `node:${props.node.id}`}
            disabled={props.retryBusyKey !== null && props.retryBusyKey !== `node:${props.node.id}`}
            onClick={() => props.onRetryNodePanelSyncJobs(props.node.id)}
          >
            重试面板
          </Button>
        ) : null}
        {leaseSummary.total > 0 ? (
          <Button
            size="xs"
            variant="light"
            loading={props.retryBusyKey === `lease-node:${props.node.id}`}
            disabled={props.retryBusyKey !== null && props.retryBusyKey !== `lease-node:${props.node.id}`}
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
    lastError: related.find((job) => job.lastError)?.lastError ?? null
  };
}

function PanelSyncQueueDrawer(props: {
  opened: boolean;
  jobs: AdminPanelSyncJobDto[];
  leaseRevocationJobs: AdminLeaseRevocationJobDto[];
  retryBusyKey: string | null;
  onClose: () => void;
  onRetryJob: (jobId: string) => void;
  onRetryNode: (nodeId: string) => void;
  onRetryLeaseJob: (jobId: string) => void;
  onRetryLeaseNode: (nodeId: string) => void;
}) {
  return (
    <Drawer opened={props.opened} onClose={props.onClose} title="后台同步队列" position="right" size="xl">
      <Stack gap="lg">
        <Stack gap="xs">
          <Text fw={600}>面板客户端同步</Text>
          <DataTable>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>状态</Table.Th>
                <Table.Th>节点</Table.Th>
                <Table.Th>客户端</Table.Th>
                <Table.Th>次数</Table.Th>
                <Table.Th>下次执行</Table.Th>
                <Table.Th>错误</Table.Th>
                <Table.Th>操作</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {props.jobs.length === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={7}>
                    <Text c="dimmed">暂无面板客户端同步任务</Text>
                  </Table.Td>
                </Table.Tr>
              ) : (
                props.jobs.map((job) => (
                  <Table.Tr key={job.id}>
                    <Table.Td>
                      <Badge color={panelSyncStatusColor(job.status)} variant="light">
                        {translatePanelSyncStatus(job.status)}
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
                        {job.lastError ?? "-"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <Button
                          size="xs"
                          variant="light"
                          loading={props.retryBusyKey === `job:${job.id}`}
                          disabled={props.retryBusyKey !== null && props.retryBusyKey !== `job:${job.id}`}
                          onClick={() => props.onRetryJob(job.id)}
                        >
                          重试
                        </Button>
                        <Button
                          size="xs"
                          variant="subtle"
                          loading={props.retryBusyKey === `node:${job.nodeId}`}
                          disabled={props.retryBusyKey !== null && props.retryBusyKey !== `node:${job.nodeId}`}
                          onClick={() => props.onRetryNode(job.nodeId)}
                        >
                          重试节点
                        </Button>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))
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
              {props.leaseRevocationJobs.length === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={7}>
                    <Text c="dimmed">暂无连接撤销同步任务</Text>
                  </Table.Td>
                </Table.Tr>
              ) : (
                props.leaseRevocationJobs.map((job) => (
                  <Table.Tr key={job.id}>
                    <Table.Td>
                      <Badge color={panelSyncStatusColor(job.status)} variant="light">
                        {translatePanelSyncStatus(job.status)}
                      </Badge>
                    </Table.Td>
                    <Table.Td>{leaseRevocationJobTargetLabel(job)}</Table.Td>
                    <Table.Td>{job.reason}</Table.Td>
                    <Table.Td>{job.attempts}</Table.Td>
                    <Table.Td>{formatDateTime(job.nextRunAt)}</Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed" lineClamp={2}>
                        {job.lastError ?? "-"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <Button
                          size="xs"
                          variant="light"
                          loading={props.retryBusyKey === `lease-job:${job.id}`}
                          disabled={props.retryBusyKey !== null && props.retryBusyKey !== `lease-job:${job.id}`}
                          onClick={() => props.onRetryLeaseJob(job.id)}
                        >
                          重试
                        </Button>
                        {job.nodeId ? (
                          <Button
                            size="xs"
                            variant="subtle"
                            loading={props.retryBusyKey === `lease-node:${job.nodeId}`}
                            disabled={props.retryBusyKey !== null && props.retryBusyKey !== `lease-node:${job.nodeId}`}
                            onClick={() => props.onRetryLeaseNode(job.nodeId!)}
                          >
                            重试节点
                          </Button>
                        ) : null}
                      </Group>
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

function summarizeLeaseRevocationJobsForNode(jobs: AdminLeaseRevocationJobDto[], nodeId: string) {
  const related = jobs.filter((job) => job.nodeId === nodeId);
  return {
    total: related.length,
    pending: related.filter((job) => job.status === "pending").length,
    running: related.filter((job) => job.status === "running").length,
    failed: related.filter((job) => job.status === "failed").length,
    lastError: related.find((job) => job.lastError)?.lastError ?? null
  };
}

function leaseRevocationJobTargetLabel(job: AdminLeaseRevocationJobDto) {
  return job.nodeName ?? job.nodeId ?? job.subscriptionId ?? job.userId ?? "全局连接";
}

function translatePanelSyncStatus(status: AdminPanelSyncJobDto["status"]) {
  if (status === "pending") return "等待";
  if (status === "running") return "执行中";
  if (status === "failed") return "失败";
  return "完成";
}

function panelSyncStatusColor(status: AdminPanelSyncJobDto["status"]) {
  if (status === "pending") return "yellow";
  if (status === "running") return "blue";
  if (status === "failed") return "red";
  if (status === "completed") return "green";
  return "gray";
}
