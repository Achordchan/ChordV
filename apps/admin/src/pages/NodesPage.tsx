import { ActionIcon, Badge, Button, Drawer, Group, Stack, Table, Text } from "@mantine/core";
import type { AdminNodeRecordDto, AdminPanelSyncJobDto } from "@chordv/shared";
import { IconBolt, IconListDetails, IconPencil, IconRefresh, IconTrash } from "@tabler/icons-react";
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
  panelSyncQueueOpened: boolean;
  probingNodeId: string | null;
  onOpenPanelSyncQueue: () => void;
  onClosePanelSyncQueue: () => void;
  onProbeNode: (nodeId: string) => void;
  onRefreshNode: (nodeId: string) => void;
  onOpenNodeDrawer: (nodeId: string) => void;
  onDeleteNode: (node: AdminNodeRecordDto) => void;
};

export function NodesPage(props: NodesPageProps) {
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
              {props.panelSyncJobs.length > 0 ? ` · ${props.panelSyncJobs.length}` : ""}
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
                      <Text size="sm" c="dimmed">
                        {item.region} · {item.provider}
                      </Text>
                    </div>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={item.isActive === false ? "red" : "green"} variant="light">
                      {item.isActive === false ? "已禁用" : "启用"}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{item.serverHost}:{item.serverPort}</Table.Td>
                  <Table.Td>
                    <StatusBadge color={nodePanelColor(item.panelStatus)} label={translatePanelStatus(item.panelStatus)} />
                  </Table.Td>
                  <Table.Td>
                    {item.panelSyncPendingCount ? (
                      <Stack gap={2}>
                        <Badge color="yellow" variant="light">
                          待同步 {item.panelSyncPendingCount}
                        </Badge>
                        {item.panelSyncLastError ? (
                          <Text size="xs" c="dimmed" lineClamp={1}>
                            {item.panelSyncLastError}
                          </Text>
                        ) : null}
                      </Stack>
                    ) : (
                      <Badge color="green" variant="light">
                        已同步
                      </Badge>
                    )}
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
                      <ActionIcon variant="subtle" onClick={() => props.onProbeNode(item.id)} loading={props.probingNodeId === item.id}>
                        <IconBolt size={16} />
                      </ActionIcon>
                      <ActionIcon variant="subtle" onClick={() => props.onRefreshNode(item.id)}>
                        <IconRefresh size={16} />
                      </ActionIcon>
                      <ActionIcon variant="subtle" onClick={() => props.onOpenNodeDrawer(item.id)}>
                        <IconPencil size={16} />
                      </ActionIcon>
                      <ActionIcon color="red" variant="subtle" onClick={() => props.onDeleteNode(item)}>
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
        onClose={props.onClosePanelSyncQueue}
      />
    </>
  );
}

function PanelSyncQueueDrawer(props: {
  opened: boolean;
  jobs: AdminPanelSyncJobDto[];
  onClose: () => void;
}) {
  return (
    <Drawer opened={props.opened} onClose={props.onClose} title="面板同步队列" position="right" size="xl">
      <DataTable>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>状态</Table.Th>
            <Table.Th>节点</Table.Th>
            <Table.Th>客户端</Table.Th>
            <Table.Th>次数</Table.Th>
            <Table.Th>下次执行</Table.Th>
            <Table.Th>错误</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {props.jobs.length === 0 ? (
            <Table.Tr>
              <Table.Td colSpan={6}>
                <Text c="dimmed">暂无待同步任务</Text>
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
              </Table.Tr>
            ))
          )}
        </Table.Tbody>
      </DataTable>
    </Drawer>
  );
}

function translatePanelSyncStatus(status: AdminPanelSyncJobDto["status"]) {
  if (status === "pending") return "等待";
  if (status === "running") return "执行中";
  if (status === "failed") return "重试中";
  return "完成";
}

function panelSyncStatusColor(status: AdminPanelSyncJobDto["status"]) {
  if (status === "running") return "blue";
  if (status === "failed") return "yellow";
  if (status === "completed") return "green";
  return "gray";
}
