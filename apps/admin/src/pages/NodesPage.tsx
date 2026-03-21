import { ActionIcon, Table, Text } from "@mantine/core";
import type { AccessMode, AdminNodeRecordDto } from "@chordv/shared";
import { IconBolt, IconPencil, IconRefresh, IconTrash } from "@tabler/icons-react";
import { DataTable } from "../features/shared/DataTable";
import { RowActions } from "../features/shared/RowActions";
import { SectionCard } from "../features/shared/SectionCard";
import { StatusBadge } from "../features/shared/StatusBadge";
import { formatDateTime } from "../utils/admin-format";
import { nodeGatewayColor, nodePanelColor, nodeProbeColor, translateGatewayStatus, translatePanelStatus, translateProbeStatus } from "../utils/admin-translate";

type NodesPageProps = {
  searchValue: string;
  onSearchChange: (value: string) => void;
  nodes: AdminNodeRecordDto[];
  currentAccessMode: AccessMode;
  probingNodeId: string | null;
  onProbeNode: (nodeId: string) => void;
  onRefreshNode: (nodeId: string) => void;
  onOpenNodeDrawer: (nodeId: string) => void;
  onDeleteNode: (node: AdminNodeRecordDto) => void;
};

export function NodesPage(props: NodesPageProps) {
  return (
    <SectionCard searchValue={props.searchValue} onSearchChange={props.onSearchChange}>
      <DataTable>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>节点</Table.Th>
            <Table.Th>地址</Table.Th>
            <Table.Th>3x-ui</Table.Th>
            {props.currentAccessMode === "relay" ? <Table.Th>中转</Table.Th> : null}
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
              <Table.Td>{item.serverHost}:{item.serverPort}</Table.Td>
              <Table.Td>
                <StatusBadge color={nodePanelColor(item.panelStatus)} label={translatePanelStatus(item.panelStatus)} />
              </Table.Td>
              {props.currentAccessMode === "relay" ? (
                <Table.Td>
                  <StatusBadge color={nodeGatewayColor(item.gatewayStatus)} label={translateGatewayStatus(item.gatewayStatus)} />
                </Table.Td>
              ) : null}
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
    </SectionCard>
  );
}
