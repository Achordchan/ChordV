import { DataSkeleton } from "../shared/DataSkeleton";
import { useState } from "react";
import { Alert, Badge, Button, Collapse, Divider, Group, Loader, Modal, Popover, ScrollArea, Stack, Text, Tooltip } from "@mantine/core";
import { IconCheck, IconHistory, IconRefresh, IconSettings } from "@tabler/icons-react";
import { useSystemUpdate, type BusyKind } from "./useSystemUpdate";
import { kindLabel, statusColor, statusLabel } from "./operation-presentation";
import { OperationProgress } from "./OperationProgress";
import { completionWarning } from "./page-refresh";
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
  const latestConfirmed = enabled && !inProgress && !state.checking && !state.error && Boolean(state.check && !state.check.hasUpdate && !state.check.cached && !state.check.warning);
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
    <Popover opened={opened} onChange={setOpened} position="top-start" width={340} offset={10} shadow="xs">
      <Popover.Target>
        <Tooltip label="后台系统版本" openDelay={400}>
          <button type="button" className={styles.versionEntry} data-attention={inProgress || Boolean(offer) || undefined}
            onClick={() => setOpened(value => !value)} aria-label="打开版本与更新" aria-expanded={opened} aria-haspopup="dialog">
            {inProgress ? <Loader size={15} color="#1c4d37" /> : <IconRefresh size={16} stroke={1.6} />}
            <span className={styles.entryLabel}>{inProgress ? `${kindLabel(state.busy!)}中` : '版本与更新'}</span>
            <span className={styles.entryVersion}>{offer && !inProgress ? '有更新' : `v${version}`}</span>
          </button>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown className={styles.panel}>
        <Stack gap={20}>
          <Group justify="space-between" wrap="nowrap">
            <Stack gap={2} className={styles.grow}>
              <Text fw={600} size="sm">{inProgress ? `${kindLabel(state.busy!)}进行中` : latestConfirmed ? '您已经是最新版' : !state.runtime ? '正在读取更新状态' : !enabled ? '在线更新未开启' : state.checking ? '正在检查更新…' : offer ? '发现新版本' : '暂未确认更新状态'}</Text>
              {inProgress && state.activeOp?.toVersion && <Text size="xs" c="dimmed">目标版本 v{state.activeOp.toVersion}</Text>}
            </Stack>
            {enabled && !inProgress && <Button size="compact-xs" variant="subtle" color="#1c4d37" loading={state.checking}
              leftSection={<IconRefresh size={14} />} onClick={() => void state.runCheck(true)}>检查更新</Button>}
          </Group>
          {!enabled && <div className={styles.unavailable}>
            <Text size="xs" c="dimmed">{state.runtime ? '当前环境无法检查在线更新。' : state.error ? '暂时无法连接后台' : '请稍候…'}</Text>
            {!state.runtime && state.error && <Button size="compact-xs" variant="subtle" color="#1c4d37" px={0} mt="xs" onClick={state.reconnect}>重新连接</Button>}
          </div>}
          {state.error && <Alert color="red" variant="light" p="sm"><Text size="xs" style={{ overflowWrap: 'anywhere' }}>{state.error}</Text></Alert>}
          {state.check?.warning && <Alert color="yellow" variant="light" p="sm"><Text size="xs">{state.check.warning}</Text></Alert>}

          {state.refreshRequired ? <Stack gap="sm" className={styles.progress}>
            <Text size="sm" fw={600}>后台任务已结束</Text>
            <Text size="xs" c="dimmed">暂未确认新版页面资源，自动刷新已暂停。可以重新确认，或手动刷新页面。</Text>
            <Group gap="xs"><Button size="xs" variant="default" onClick={state.reconnect}>重新确认</Button><Button size="xs" color="#1c4d37" onClick={state.reloadPage}>刷新页面</Button></Group>
          </Stack> : state.finishing ? <Group wrap="nowrap" className={styles.progress}><Loader size={18} color="#1c4d37" /><Text size="sm">操作已结束，正在确认新版页面并刷新…</Text></Group>
            : inProgress && <OperationProgress operation={state.activeOp} kind={state.busy!}
              connection={state.connection} onReconnect={state.reconnect} onPause={state.pause} />}

          {state.completion && completionWarning(state.completion) && <Alert color="orange" p="sm"><Text size="xs">{completionWarning(state.completion)}</Text></Alert>}
          {!inProgress && state.completion && <Alert color={state.completion.status === 'rolled_back' ? 'orange' : 'teal'} p="sm"
            icon={<IconCheck size={17} />} withCloseButton onClose={state.dismissCompletion}>
            {state.completion.status === 'rolled_back' ? `更新未通过验证，已恢复到 v${state.completion.version}。` : `已完成${kindLabel(state.completion.kind)}，当前版本 v${state.completion.version}。`}
          </Alert>}
          {enabled && !inProgress && offer && <Stack gap="sm">
            <Group gap="xs"><Text size="sm" fw={600}>可更新至 v{offer.version}</Text></Group>
            {!!offer.changelog.length && <ScrollArea.Autosize mah={160}><Stack gap={6}>
              {offer.changelog.map((line, index) => <Text size="xs" c="dimmed" key={index} style={{ overflowWrap: 'anywhere' }}>{line}</Text>)}
            </Stack></ScrollArea.Autosize>}
            <Button fullWidth size="sm" color="#1c4d37" disabled={!state.canUpdate} onClick={() => ask({ kind: 'update', version: offer.version,
              title: '确认更新', body: `将更新至 v${offer.version}，服务切换期间会短暂断开。完成验证后将自动刷新网页。` })}>更新到 v{offer.version}</Button>
          </Stack>}
          {enabled && <>
            <Divider color="#e4e8dd" />
            <Group justify="space-between" gap="xs">
              <Button size="compact-xs" variant="subtle" color="gray" leftSection={<IconHistory size={15} />} onClick={() => expand('history')} aria-expanded={history}>操作记录</Button>
              {!inProgress && <Button size="compact-xs" variant="subtle" color="gray" leftSection={<IconSettings size={15} />} onClick={() => expand('maintenance')} aria-expanded={maintenance}>维护操作</Button>}
            </Group>
            <Collapse in={history || (maintenance && !inProgress)}>
              {state.auxLoading ? <DataSkeleton rows={2}/> : state.auxError ? <Text size="xs" c="red">{state.auxError}</Text> : <Stack gap="sm">
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
    <Modal opened={!!confirm} onClose={() => { if (!submitting) setConfirm(null); }} title={confirm?.title} centered size="sm" classNames={{ content: styles.confirm, header: styles.confirmHeader, title: styles.confirmTitle }}>
      <Stack gap="md"><Text size="sm">{confirm?.body}</Text><Group justify="flex-end">
        <Button variant="default" disabled={submitting} onClick={() => setConfirm(null)}>取消</Button>
        <Button color="#1c4d37" loading={submitting} disabled={confirm?.kind === 'update' && !state.canUpdate} onClick={() => void proceed()}>确认{confirm ? kindLabel(confirm.kind) : ''}</Button>
      </Group></Stack>
    </Modal>
  </>;
}
