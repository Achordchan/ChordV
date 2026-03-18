import { Badge, Button, Group, Paper, SegmentedControl, Stack, Text, Title } from "@mantine/core";
import type { ConnectionMode, GeneratedRuntimeConfigDto } from "@chordv/shared";
import { IconChartBar, IconPlugConnected } from "@tabler/icons-react";
import type { DesktopRuntimeStatus } from "../lib/runtime";

type ControlPanelProps = {
  modes: ConnectionMode[];
  mode: ConnectionMode;
  canConnect: boolean;
  modeLocked: boolean;
  primaryBusy: boolean;
  primaryLabel: string;
  desktopStatus: DesktopRuntimeStatus;
  runtime: GeneratedRuntimeConfigDto | null;
  error: string | null;
  onModeChange: (mode: ConnectionMode) => void;
  onPrimaryAction: () => void;
  onOpenLogs: () => void;
};

export function ControlPanel(props: ControlPanelProps) {
  return (
    <Paper withBorder radius="xl" p="md" className="desktop-panel">
      <Stack h="100%" gap="sm" className="control-shell">
        <Stack gap="sm">
          <div>
            <Title order={3}>连接控制</Title>
           
          </div>

          <StatusSurface status={props.desktopStatus.status} nodeName={props.runtime?.node.name ?? "未连接"} />

          <SegmentedControl
            fullWidth
            value={props.mode}
            onChange={(value) => props.onModeChange(value as ConnectionMode)}
            disabled={props.modeLocked}
            data={props.modes.map((mode) => ({
              value: mode,
              label: translateMode(mode)
            }))}
          />

          <Button
            size="lg"
            radius="xl"
            className="primary-action"
            leftSection={<IconPlugConnected size={20} />}
            onClick={props.onPrimaryAction}
            loading={props.primaryBusy}
            color={props.desktopStatus.status === "connected" ? "green" : "cyan"}
            disabled={!props.canConnect && props.desktopStatus.status !== "connected" && props.desktopStatus.status !== "error"}
          >
            {props.primaryLabel}
          </Button>

          <Group grow wrap="nowrap" className="control-metrics">
            <MetricBlock label="HTTP" value={props.runtime ? `${props.runtime.localHttpPort}` : "--"} />
            <MetricBlock label="SOCKS" value={props.runtime ? `${props.runtime.localSocksPort}` : "--"} />
          </Group>

          {props.error ? (
            <Text c="red.6" size="sm">
              {props.error}
            </Text>
          ) : null}
        </Stack>

        <Group justify="space-between" className="control-footer">
          <Text size="sm" c="dimmed">
            内核 {props.desktopStatus.xrayBinaryPath ? "已就绪" : "未安装"}
          </Text>
          <Button size="compact-sm" variant="subtle" leftSection={<IconChartBar size={15} />} onClick={props.onOpenLogs}>
            运行日志
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

function StatusSurface(props: { status: string; nodeName: string }) {
  return (
    <Paper radius="lg" p="sm" className="status-surface">
      <Stack gap={6}>
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            当前状态
          </Text>
          <Badge variant="light" color={runtimeColor(props.status)}>
            {translateRuntimeStatus(props.status)}
          </Badge>
        </Group>
        <Text fw={700} c={props.status === "connected" ? "green.7" : undefined}>
          {props.nodeName}
        </Text>
      </Stack>
    </Paper>
  );
}

function MetricBlock(props: { label: string; value: string }) {
  return (
    <Paper withBorder radius="lg" p="sm">
      <Text size="sm" c="dimmed">
        {props.label}
      </Text>
      <Text fw={700} mt="xs">
        {props.value}
      </Text>
    </Paper>
  );
}

function translateMode(mode: ConnectionMode) {
  if (mode === "global") return "全局";
  if (mode === "direct") return "直连";
  return "规则";
}

function translateRuntimeStatus(status: string) {
  if (status === "idle") return "空闲";
  if (status === "connecting") return "连接中";
  if (status === "connected") return "已连接";
  if (status === "disconnecting") return "断开中";
  if (status === "error") return "异常";
  return status;
}

function runtimeColor(status: string) {
  if (status === "connected") return "green";
  if (status === "connecting" || status === "disconnecting") return "yellow";
  if (status === "error") return "red";
  return "gray";
}
