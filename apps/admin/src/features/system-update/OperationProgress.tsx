import { useState } from "react";
import { Button, Collapse, Group, Loader, Progress, Stack, Text } from "@mantine/core";
import { IconCheck, IconChevronDown, IconChevronUp, IconCircle, IconRefresh, IconPlayerPause } from "@tabler/icons-react";
import type { SystemUpdateOperationDto } from "@chordv/shared";
import type { UpdateConnection } from "./operation-observer";
import { operationProgress } from "./operation-presentation";
import styles from "./SystemUpdate.module.css";

export function OperationProgress({ operation, kind, connection, onReconnect, onPause }: {
  operation: SystemUpdateOperationDto | null; kind: SystemUpdateOperationDto['kind'];
  connection: UpdateConnection; onReconnect: () => void; onPause: () => void;
}) {
  const [details, setDetails] = useState(false);
  const progress = operationProgress(operation, kind, connection);
  return <Stack gap="sm" className={styles.progress}>
    <Group wrap="nowrap" align="flex-start" gap="sm">
      {connection === 'paused' ? <IconPlayerPause size={20} color="var(--mantine-color-gray-6)" /> : <Loader size={18} mt={2} color="#1c4d37" />}
      <Stack gap={4} className={styles.grow}>
        <Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>{progress.title}</Text>
        <Text size="xs" c="dimmed">{progress.description}</Text>
        {progress.lastConfirmed && <Text size="xs" c="dimmed">最后确认阶段：{progress.lastConfirmed}</Text>}
      </Stack>
    </Group>
    {progress.showDownloadProgress && typeof operation?.progress === 'number' && <Stack gap={5}>
      <Progress value={operation.progress} color="#1c4d37" size="xs" radius="sm" aria-label="更新包下载进度" />
      <Text size="xs" c="dimmed" ta="right">已下载 {operation.progress}%</Text>
    </Stack>}
    <Group justify="space-between" gap="xs">
      <Button variant="subtle" color="gray" size="compact-xs" rightSection={details ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
        aria-expanded={details} onClick={() => setDetails(value => !value)}>{details ? '收起步骤' : '查看步骤'}</Button>
      {progress.recovering && <Group gap={4}>
        {connection === 'reconnecting' && <Button variant="subtle" color="gray" size="compact-xs" onClick={onPause}>暂停重连</Button>}
        <Button variant="light" color="#1c4d37" size="compact-xs" leftSection={<IconRefresh size={13} />} onClick={onReconnect}>重新连接</Button>
      </Group>}
    </Group>
    <Collapse in={details}>
      <Stack gap={2}>
        {progress.steps.map(step => {
          const active = step.state === 'active';
          const done = step.state === 'completed';
          const label = active ? '进行中' : done ? '已完成' : step.state === 'unconfirmed' ? '待确认' : '等待';
          return <div className={styles.step} key={step.id}>
            {done ? <IconCheck size={15} color="var(--mantine-color-teal-6)" /> : <IconCircle size={15} color={active ? '#1c4d37' : 'var(--mantine-color-gray-4)'} />}
            <Text size="xs" fw={active ? 600 : 400} className={styles.stepLabel}>{step.label}</Text>
            <Text size="xs" c={active ? '#1c4d37' : 'dimmed'} className={styles.nowrap}>{label}</Text>
          </div>;
        })}
      </Stack>
    </Collapse>
  </Stack>;
}
