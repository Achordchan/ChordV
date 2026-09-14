import { DataSkeleton } from "../shared/DataSkeleton";
import { useState, useEffect } from "react";
import { IconSearch } from "@tabler/icons-react";
import usageStyles from "./MemberUsage.module.css";
import editorStyles from "../editors/EditorDialog.module.css";
import { Button, Checkbox, Group, Modal, TextInput, Stack, Table, Text } from "@mantine/core";
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
    <Modal opened={props.target !== null} onClose={close} title="删除节点" centered size={480} closeOnClickOutside={!props.submitting} closeOnEscape={!props.submitting} withCloseButton={!props.submitting} classNames={{content: editorStyles.content, header: editorStyles.header, title: editorStyles.title, body: editorStyles.body}}>
      <div className={editorStyles.nodeIdentity}><CountryFlag code={props.target?.countryCode}/><div><Text fw={600}>{props.target?.name}</Text><Text size="xs" c="dimmed" mt={4}>{props.target?.serverHost}:{props.target?.serverPort}</Text></div></div>
      <Stack gap="sm"><Text size="sm">删除后，该节点将无法继续使用。订阅已用流量记录会保留。</Text><details><summary style={{fontSize:13, color:"#74816b", cursor:"pointer"}}>远端清理说明</summary><Text size="sm" c="dimmed" mt="sm">面板在线时先停用节点并清理远端客户端；面板失联时仍会删除本地记录，远端残留需要自行检查。</Text></details></Stack>
      <footer className={editorStyles.footer}><Button variant="default" onClick={close} disabled={props.submitting}>取消</Button><Button color="red.8" onClick={props.onConfirm} loading={props.submitting}>删除节点</Button></footer>
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
  const target = props.target;
  const breakdown = target?.entry.nodeBreakdown ?? [];
  return <Modal opened={props.opened} onClose={props.onClose} title="成员流量明细" centered size={740}
    classNames={{content:editorStyles.content,header:editorStyles.header,title:editorStyles.title,body:editorStyles.body}}>
    {target ? <div className={usageStyles.body}>
      <header className={usageStyles.identity}><strong>{target.userDisplayName}</strong><p>{target.teamName} · {target.userEmail}</p></header>
      <dl className={usageStyles.summary}>
        <div className={usageStyles.total}><dt>累计用量</dt><dd>{formatTrafficGb(target.entry.memberTotalUsedTrafficGb ?? target.entry.usedTrafficGb)} <span>GB</span></dd></div>
        <div><dt>使用节点</dt><dd>{breakdown.length} 个</dd></div>
        <div><dt>最近使用</dt><dd>{formatDateTime(target.entry.recordedAt)}</dd></div>
      </dl>
      <h3 className={usageStyles.sectionTitle}>节点用量</h3>
      {breakdown.length ? <Table.ScrollContainer minWidth={560}><Table className={usageStyles.table}>
        <Table.Thead><Table.Tr><Table.Th>节点</Table.Th><Table.Th>累计流量</Table.Th><Table.Th>最近同步</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{breakdown.map(entry=><Table.Tr key={entry.nodeId}>
          <Table.Td><div className={usageStyles.node}><CountryFlag code={resolveCountryCode({region:entry.nodeRegion})}/><div><Text size="sm" fw={550}>{entry.nodeName}</Text><Text size="xs" c="dimmed">{entry.nodeRegion}</Text></div></div></Table.Td>
          <Table.Td><Text size="sm" fw={550}>{formatTrafficGb(entry.usedTrafficGb)} GB</Text><Text size="xs" c="dimmed" mt={4}>{entry.recordCount} 条记录</Text></Table.Td>
          <Table.Td><Text size="sm" c="dimmed">{formatDateTime(entry.lastRecordedAt)}</Text></Table.Td>
        </Table.Tr>)}</Table.Tbody>
      </Table></Table.ScrollContainer> : <Text className={usageStyles.empty}>暂无节点用量明细</Text>}
    </div> : <Text c="dimmed" py="lg">暂无成员用量数据</Text>}
  </Modal>;
}

export function NodeAccessEditorModal(props: {
  opened: boolean;
  ownerLabel: string | null;
  nodeOptions: Array<{ value: string; label: string; countryCode?: string | null }>;
  selection: string[];
  loading: boolean;
  saving: boolean;
  onSelectionChange: (value: string[]) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const [search, setSearch] = useState("");
  useEffect(() => { setSearch(""); }, [props.opened, props.ownerLabel]);
  const busy = props.loading || props.saving;
  const close = () => { if (!busy) props.onClose(); };
  const options = props.nodeOptions.filter(item => item.label.toLowerCase().includes(search.trim().toLowerCase()));
  return <Modal opened={props.opened} onClose={close} title="节点授权" centered size={600} closeOnClickOutside={!busy} closeOnEscape={!busy} withCloseButton={!busy}
    overlayProps={{ backgroundOpacity: .35, blur: 2 }} classNames={{ content: editorStyles.content, header: editorStyles.header, title: editorStyles.title, body: editorStyles.body }}>
    <div className={editorStyles.form}>
      <div className={editorStyles.context}><Text fw={600}>{props.ownerLabel ?? "当前订阅"}</Text><Text size="xs" c="dimmed">已选择 {props.selection.length} 个节点</Text></div>
      <TextInput aria-label="搜索可授权节点" placeholder="搜索节点名称、地区" leftSection={<IconSearch size={17}/>} value={search} disabled={busy} onChange={event => setSearch(event.currentTarget.value)}/>
      <Group justify="space-between" mt="md"><Text size="xs" c="dimmed">可用节点 · {props.nodeOptions.length}</Text><Group gap="xs"><Button size="compact-xs" variant="subtle" color="#1c4d37" onClick={props.onSelectAll} disabled={busy}>全选全部</Button><Button size="compact-xs" variant="subtle" color="gray" onClick={props.onClear} disabled={busy}>清空选择</Button></Group></Group>
      <div className={editorStyles.nodeOptions}>
        {props.loading ? <DataSkeleton rows={4}/>
          : options.map(item => <label key={item.value} className={editorStyles.nodeOption}>
            <Checkbox color="#1c4d37" aria-label={item.label} checked={props.selection.includes(item.value)} disabled={busy || (!props.selection.includes(item.value) && props.selection.length >= 100)}
              onChange={event => props.onSelectionChange(event.currentTarget.checked ? [...props.selection, item.value] : props.selection.filter(id => id !== item.value))}/>
            <CountryFlag code={item.countryCode} size="md"/><span>{item.label}</span>
          </label>)}
        {!props.loading && !options.length && <Text size="sm" c="dimmed" ta="center" py="xl">{search ? "没有匹配的节点" : "暂无可授权节点"}</Text>}
      </div>
      {!props.loading && !props.selection.length && <Text size="xs" c="orange.7" mt="md">保存空选择将移除此订阅的所有节点授权。</Text>}
      <footer className={editorStyles.footer}><Button variant="default" onClick={close} disabled={busy}>取消</Button><Button color="#1c4d37" onClick={props.onSave} loading={props.saving} disabled={busy}>保存授权</Button></footer>
    </div>
  </Modal>;
}
