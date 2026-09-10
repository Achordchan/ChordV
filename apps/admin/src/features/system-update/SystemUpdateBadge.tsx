import { useState } from "react";
import { Alert, Badge, Button, Collapse, Divider, Group, Loader, Modal, Popover, ScrollArea, Stack, Text, Tooltip } from "@mantine/core";
import { IconArrowUp, IconCheck, IconChevronDown, IconHistory, IconRefresh, IconSettings } from "@tabler/icons-react";
import { useSystemUpdate, type BusyKind } from "./useSystemUpdate";
import { kindLabel, statusColor, statusLabel } from "./operation-presentation";
import { OperationProgress } from "./OperationProgress";
import styles from "./SystemUpdate.module.css";

type Confirmation = { kind: BusyKind; version?: string; title: string; body: string };
export function SystemUpdateBadge() {
  const [opened, setOpened] = useState(false);
  const [history, setHistory] = useState(false), [maintenance, setMaintenance] = useState(false);
  const [confirm, setConfirm] = useState<Confirmation | null>(null), [submitting, setSubmitting] = useState(false);
  const state = useSystemUpdate(opened);
  const inProgress = state.busy !== null;
  const version = state.runtime?.currentVersion ?? state.check?.currentVersion ?? '—';
  const enabled = Boolean(state.runtime?.enabled);
  const offer = state.check?.hasUpdate ? state.check.release : null;
  const ask = (value: Confirmation) => {
    if (inProgress || (value.kind === 'update' && !state.canUpdate)) return;
    setConfirm(value);
  };
  const proceed = async () => {
    if (!confirm || submitting || inProgress || (confirm.kind === 'update' && !state.canUpdate)) return;
    setSubmitting(true);
    try { await state.beginOperation(confirm.kind, confirm.version); }
    finally { setSubmitting(false); setConfirm(null); setOpened(true); }
  };
  const expand = (kind: 'history' | 'maintenance') => {
    if (kind === 'history') setHistory(value => !value); else setMaintenance(value => !value);
    void state.loadAux();
  };
  return <>
    <Popover opened={opened} onChange={setOpened} position="bottom-start" width={420} shadow="sm" withArrow>
      <Popover.Target>
        <Tooltip label="后台系统版本" openDelay={400}>
          <Button size="compact-xs" variant="light" color={inProgress ? 'blue' : offer ? 'orange' : 'gray'}
            onClick={() => setOpened(value => !value)} aria-label="打开系统更新" rightSection={<IconChevronDown size={13} />}
            leftSection={inProgress ? <Loader size={12} /> : offer ? <IconArrowUp size={13} /> : undefined}>
            {inProgress ? `${kindLabel(state.busy!)}中` : `v${version}`}
          </Button>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown className={styles.panel}>
        <Stack gap="md">
          <Group justify="space-between" wrap="nowrap">
            <Stack gap={2} className={styles.grow}>
              <Text size="xs" c="dimmed">后台系统</Text>
              <Text fw={650} size="lg">v{version}</Text>
              {inProgress && state.activeOp?.toVersion && <Text size="xs" c="dimmed">目标版本 v{state.activeOp.toVersion}</Text>}
            </Stack>
            {!inProgress && <Button size="xs" variant="default" loading={state.checking} disabled={!enabled}
              leftSection={<IconRefresh size={14} />} onClick={() => void state.runCheck(true)}>检查更新</Button>}
          </Group>
          {!enabled && <Alert color="gray" variant="light" p="sm">{state.runtime ? '当前环境未启用系统更新。' : state.error ? '暂时无法连接后台。' : '正在确认后台版本…'}
            {!state.runtime && state.error && <Button size="compact-xs" variant="subtle" ml="xs" onClick={state.reconnect}>重新连接</Button>}
          </Alert>}
          {state.error && <Alert color="red" variant="light" p="sm"><Text size="xs" style={{ overflowWrap: 'anywhere' }}>{state.error}</Text></Alert>}
          {state.check?.warning && <Alert color="yellow" variant="light" p="sm"><Text size="xs">{state.check.warning}</Text></Alert>}

          {state.refreshRequired ? <Stack gap="sm" className={styles.progress}>
            <Text size="sm" fw={600}>后台任务已结束</Text>
            <Text size="xs" c="dimmed">暂未确认新版页面资源，自动刷新已暂停。可以重新确认，或手动刷新页面。</Text>
            <Group gap="xs"><Button size="xs" variant="default" onClick={state.reconnect}>重新确认</Button><Button size="xs" onClick={state.reloadPage}>刷新页面</Button></Group>
          </Stack> : state.finishing ? <Group wrap="nowrap" className={styles.progress}><Loader size={20} /><Text size="sm">操作已结束，正在确认新版页面并刷新…</Text></Group>
            : inProgress && <OperationProgress operation={state.activeOp} kind={state.busy!} observed={state.observedPhases}
              connection={state.connection} onReconnect={state.reconnect} onPause={state.pause} />}

          {!inProgress && state.completion && <Alert color={state.completion.status === 'rolled_back' ? 'orange' : 'teal'} p="sm"
            icon={<IconCheck size={17} />} withCloseButton onClose={state.dismissCompletion}>
            {state.completion.status === 'rolled_back' ? `更新未通过验证，已恢复到 v${state.completion.version}。` : `已完成${kindLabel(state.completion.kind)}，当前版本 v${state.completion.version}。`}
          </Alert>}
          {enabled && !inProgress && offer && <Stack gap="sm">
            <Group gap="xs"><Text size="sm" fw={600}>可更新至 v{offer.version}</Text></Group>
            {!!offer.changelog.length && <ScrollArea.Autosize mah={160}><Stack gap={6}>
              {offer.changelog.map((line, index) => <Text size="xs" c="dimmed" key={index} style={{ overflowWrap: 'anywhere' }}>{line}</Text>)}
            </Stack></ScrollArea.Autosize>}
            <Button fullWidth size="sm" disabled={!state.canUpdate} onClick={() => ask({ kind: 'update', version: offer.version,
              title: '确认更新', body: `将更新至 v${offer.version}，服务切换期间会短暂断开。完成验证后将自动刷新网页。` })}>更新到 v{offer.version}</Button>
          </Stack>}
          {enabled && !inProgress && !offer && state.check && !state.checking && !state.check.warning && !state.completion &&
            <Group gap={6}><IconCheck size={16} color="var(--mantine-color-teal-6)" /><Text size="xs" c="dimmed">已是最新版本</Text></Group>}
          {enabled && <>
            <Divider />
            <Group justify="space-between">
              <Button size="compact-xs" variant="subtle" color="gray" leftSection={<IconHistory size={15} />} onClick={() => expand('history')} aria-expanded={history}>操作记录</Button>
              {!inProgress && <Button size="compact-xs" variant="subtle" color="gray" leftSection={<IconSettings size={15} />} onClick={() => expand('maintenance')} aria-expanded={maintenance}>维护操作</Button>}
            </Group>
            <Collapse in={history || (maintenance && !inProgress)}>
              {state.auxLoading ? <Loader size="sm" /> : state.auxError ? <Text size="xs" c="red">{state.auxError}</Text> : <Stack gap="sm">
                {history && <ScrollArea.Autosize mah={210}><Stack gap={0}>
                  {state.operations.length === 0 && <Text size="xs" c="dimmed">暂无操作记录</Text>}
                  {state.operations.map(op => <Group key={op.id} justify="space-between" wrap="nowrap" align="flex-start" className={styles.historyItem}>
                    <Stack gap={3} className={styles.grow}><Text size="xs">{kindLabel(op.kind)}{op.toVersion ? `至 v${op.toVersion}` : ''}</Text>
                      <Text size="xs" c="dimmed">{new Date(op.startedAt).toLocaleString()}</Text>
                      {op.failureReason && <Text size="xs" c="red" style={{ overflowWrap: 'anywhere' }}>{op.failureReason}</Text>}
                    </Stack><Badge size="xs" color={statusColor(op.status)} variant="light" className={styles.nowrap}>{statusLabel(op.status)}</Badge>
                  </Group>)}
                </Stack></ScrollArea.Autosize>}
                {maintenance && !inProgress && <Stack gap="sm">
                  <Group justify="space-between"><Text size="xs">重新启动后台服务</Text><Button size="compact-xs" variant="default" onClick={() => ask({ kind: 'restart', title: '确认重启', body: '重启期间后台会短暂断开，版本不会改变。' })}>重启服务</Button></Group>
                  {state.versions.filter(item => !item.isCurrent).map(item => <Group key={item.version} justify="space-between"><Text size="xs">v{item.version}</Text>
                    <Button size="compact-xs" variant="light" color="orange" onClick={() => ask({ kind: 'rollback', version: item.version,
                      title: '确认回滚', body: `回滚至 v${item.version} 并重启服务。已经执行的数据库迁移不会撤销。` })}>回滚到此版本</Button></Group>)}
                  {!state.versions.some(item => !item.isCurrent) && <Text size="xs" c="dimmed">没有可回滚的历史版本</Text>}
                </Stack>}
              </Stack>}
            </Collapse>
          </>}
        </Stack>
      </Popover.Dropdown>
    </Popover>
    <Modal opened={!!confirm} onClose={() => { if (!submitting) setConfirm(null); }} title={confirm?.title} centered size="sm">
      <Stack gap="md"><Text size="sm">{confirm?.body}</Text><Group justify="flex-end">
        <Button variant="default" disabled={submitting} onClick={() => setConfirm(null)}>取消</Button>
        <Button loading={submitting} disabled={confirm?.kind === 'update' && !state.canUpdate} onClick={() => void proceed()}>确认{confirm ? kindLabel(confirm.kind) : ''}</Button>
      </Group></Stack>
    </Modal>
  </>;
}
