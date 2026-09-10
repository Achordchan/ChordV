import { useState } from "react";
import { Button, Collapse, Group, Loader, Progress, Stack, Text } from "@mantine/core";
import { IconCheck, IconChevronDown, IconChevronUp, IconCircle, IconRefresh, IconPlayerPause } from "@tabler/icons-react";
import type { SystemUpdateOperationDto } from "@chordv/shared";
import type { UpdateConnection } from "./operation-observer";
import { APPLICABLE_STEPS, OBSERVED_ONLY_STEPS, PHASE_STEPS, kindLabel, phaseDescription } from "./operation-presentation";
import styles from "./SystemUpdate.module.css";

export function OperationProgress({ operation, kind, observed, connection, onReconnect, onPause }: {
  operation: SystemUpdateOperationDto | null; kind: SystemUpdateOperationDto['kind']; observed: ReadonlySet<string>;
  connection: UpdateConnection; onReconnect: () => void; onPause: () => void;
}) {
  const [details, setDetails] = useState(false);
  const interrupted = connection === 'reconnecting' || connection === 'paused';
  const phase = operation?.phase;
  const phaseIndex = PHASE_STEPS.findIndex(step => step.phase === phase?.replace(/^rollback-/, ''));
  const title = connection === 'paused' ? '状态观察已暂停' : interrupted ? '正在恢复连接' : phase ? phaseDescription(phase) : `正在准备${kindLabel(kind)}`;
  return <Stack gap="sm" className={styles.progress}>
    <Group wrap="nowrap" align="flex-start" gap="sm">
      {connection === 'paused' ? <IconPlayerPause size={20} color="var(--mantine-color-gray-6)" /> : <Loader size={20} mt={2} />}
      <Stack gap={4} className={styles.grow}>
        <Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>{title}</Text>
        <Text size="xs" c="dimmed">{interrupted ? '操作结果尚未确认，当前任务保持锁定。' : '完成验证后将自动刷新页面。'}</Text>
        {interrupted && phase && <Text size="xs" c="dimmed">最后状态：{phaseDescription(phase)}</Text>}
      </Stack>
    </Group>
    {!interrupted && phase === 'downloading' && typeof operation?.progress === 'number' && <Stack gap={5}>
      <Progress value={operation.progress} size="sm" radius="xl" aria-label="更新包下载进度" />
      <Text size="xs" c="dimmed" ta="right">已下载 {operation.progress}%</Text>
    </Stack>}
    <Group justify="space-between" gap="xs">
      <Button variant="subtle" color="gray" size="compact-xs" rightSection={details ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
        aria-expanded={details} onClick={() => setDetails(value => !value)}>{details ? '收起步骤' : '查看步骤'}</Button>
      {interrupted && <Group gap={4}>
        {connection === 'reconnecting' && <Button variant="subtle" color="gray" size="compact-xs" onClick={onPause}>暂停重连</Button>}
        <Button variant="light" size="compact-xs" leftSection={<IconRefresh size={13} />} onClick={onReconnect}>重新连接</Button>
      </Group>}
    </Group>
    <Collapse in={details}>
      <Stack gap={2}>
        {PHASE_STEPS.filter(step => APPLICABLE_STEPS[kind].has(step.phase)).map(step => {
          const index = PHASE_STEPS.findIndex(value => value.phase === step.phase);
          const active = index === phaseIndex;
          const advanced = [...observed].some(item => !item.startsWith('rollback-') && PHASE_STEPS.findIndex(value => value.phase === item) > index);
          const done = OBSERVED_ONLY_STEPS.has(step.phase) ? observed.has(step.phase) && advanced : index < phaseIndex;
          const label = active ? '进行中' : done ? '已完成' : advanced && OBSERVED_ONLY_STEPS.has(step.phase) ? '未记录' : '等待';
          return <div className={styles.step} key={step.phase}>
            {done ? <IconCheck size={15} color="var(--mantine-color-teal-6)" /> : <IconCircle size={15} color={active ? 'var(--mantine-color-blue-6)' : 'var(--mantine-color-gray-4)'} />}
            <Text size="xs" fw={active ? 600 : 400} className={styles.stepLabel}>{step.label}</Text>
            <Text size="xs" c={active ? 'blue' : 'dimmed'} className={styles.nowrap}>{label}</Text>
          </div>;
        })}
      </Stack>
    </Collapse>
  </Stack>;
}
