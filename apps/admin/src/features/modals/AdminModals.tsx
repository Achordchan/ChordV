import { Badge, Button, Checkbox, Divider, Group, Modal, MultiSelect, Paper, SimpleGrid, Stack, Table, Text } from "@mantine/core";
import type { AdminNodeRecordDto, AdminTeamUsageRecordDto } from "@chordv/shared";
import { resolveCountryCode } from "@chordv/shared";
import { CountryFlag } from "../../components/CountryFlag";
import { formatDateTime, formatTrafficGb } from "../../utils/admin-format";

export function DeleteNodeModal(props: {
  target: AdminNodeRecordDto | null;
  submitting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const close = () => {
    if (!props.submitting) {
      props.onClose();
    }
  };

  return (
    <Modal opened={props.target !== null} onClose={close} title="停用节点" centered>
      <Stack>
        <Text>该操作会立即停用节点并隐藏入口。订阅已用流量会保留，不会因删除节点而清零。面板在线时后台清理远端客户端；面板失联时本地完成清理并停止无限重试。</Text>
        <Text fw={600}>{props.target?.name}</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={close} disabled={props.submitting}>
            取消
          </Button>
          <Button color="red" onClick={props.onConfirm} loading={props.submitting}>
            停用并清理
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function KickMemberModal(props: {
  opened: boolean;
  memberName: string | null;
  disableAccount: boolean;
  submitting: boolean;
  onDisableAccountChange: (checked: boolean) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal opened={props.opened} onClose={props.onClose} title="断开本 Team 连接" centered>
      <Stack>
        <Text>该操作只断开该成员在当前 Team 订阅下的连接；不会移出团队，也不会影响个人订阅或其他 Team。</Text>
        <Text fw={600}>{props.memberName}</Text>
        <Checkbox checked={props.disableAccount} onChange={(event) => props.onDisableAccountChange(event.currentTarget.checked)} label="同时禁用这个账号" />
        <Group justify="flex-end">
          <Button variant="default" onClick={props.onClose} disabled={props.submitting}>
            取消
          </Button>
          <Button color="red" onClick={props.onConfirm} loading={props.submitting}>
            确认断开本 Team 连接
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function TeamUsageDetailModal(props: {
  opened: boolean;
  target:
    | {
        teamName: string;
        userDisplayName: string;
        userEmail: string;
        entry: AdminTeamUsageRecordDto;
      }
    | null;
  onClose: () => void;
}) {
  return (
    <Modal opened={props.opened} onClose={props.onClose} title="成员流量明细" centered size="xl">
      <Stack>
        <Text fw={600}>{props.target?.userDisplayName}</Text>
        <Text size="sm" c="dimmed">
          {props.target ? `${props.target.teamName} · ${props.target.userEmail}` : ""}
        </Text>
        {props.target ? (
          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
            <Paper withBorder radius="lg" p="sm">
              <Text size="sm" c="dimmed">累计用量</Text>
              <Text fw={700}>{formatTrafficGb(props.target.entry.memberTotalUsedTrafficGb ?? props.target.entry.usedTrafficGb)} GB</Text>
            </Paper>
            <Paper withBorder radius="lg" p="sm">
              <Text size="sm" c="dimmed">节点数量</Text>
              <Text fw={700}>{props.target.entry.nodeBreakdown?.length ?? 0} 个</Text>
            </Paper>
            <Paper withBorder radius="lg" p="sm">
              <Text size="sm" c="dimmed">最近使用</Text>
              <Text fw={700}>{formatDateTime(props.target.entry.recordedAt)}</Text>
            </Paper>
          </SimpleGrid>
        ) : null}
        <Divider />
        {props.target?.entry.nodeBreakdown?.length ? (
          <Table highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>节点</Table.Th>
                <Table.Th>地区</Table.Th>
                <Table.Th>累计流量</Table.Th>
                <Table.Th>记录数</Table.Th>
                <Table.Th>最近同步</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {props.target.entry.nodeBreakdown.map((entry) => (
                <Table.Tr key={entry.nodeId}>
                  <Table.Td>
                    <Group gap="xs" wrap="nowrap">
                      <Text fw={600}>{entry.nodeName}</Text>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <CountryFlag code={resolveCountryCode({ region: entry.nodeRegion })} size="sm" />
                      <Badge variant="light">{entry.nodeRegion}</Badge>
                    </Group>
                  </Table.Td>
                  <Table.Td>{formatTrafficGb(entry.usedTrafficGb)} GB</Table.Td>
                  <Table.Td>{entry.recordCount} 条</Table.Td>
                  <Table.Td>{formatDateTime(entry.lastRecordedAt)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        ) : (
          <Text size="sm" c="dimmed">
            暂无明细
          </Text>
        )}
      </Stack>
    </Modal>
  );
}

export function NodeAccessEditorModal(props: {
  opened: boolean;
  ownerLabel: string | null;
  nodeOptions: Array<{ value: string; label: string }>;
  selection: string[];
  loading: boolean;
  saving: boolean;
  onSelectionChange: (value: string[]) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const busy = props.loading || props.saving;
  const close = () => {
    if (!busy) {
      props.onClose();
    }
  };

  return (
    <Modal opened={props.opened} onClose={close} title="节点授权" centered size="lg">
      <Stack>
        <Text size="sm" c="dimmed">
          {props.ownerLabel ?? "当前订阅"}
        </Text>
        <MultiSelect
          label="可用节点"
          placeholder={props.loading ? "正在加载节点..." : "选择当前订阅可用的节点"}
          searchable
          nothingFoundMessage="没有匹配节点"
          data={props.nodeOptions}
          value={props.selection}
          onChange={props.onSelectionChange}
          disabled={busy}
        />
        <Group justify="space-between">
          <Text size="sm" c={props.selection.length > 0 ? "dimmed" : "orange.7"}>
            {props.selection.length > 0 ? `已分配 ${props.selection.length} 个节点` : "当前订阅未分配节点"}
          </Text>
          <Group gap="xs">
            <Button variant="default" size="xs" onClick={props.onSelectAll} disabled={busy}>
              全选
            </Button>
            <Button variant="default" size="xs" onClick={props.onClear} disabled={busy}>
              清空
            </Button>
          </Group>
        </Group>
        <Group justify="flex-end">
          <Button variant="default" onClick={close} disabled={busy}>
            取消
          </Button>
          <Button onClick={props.onSave} loading={props.saving} disabled={busy}>
            保存
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
