import { Badge, Button, Divider, Group, Paper, SegmentedControl, SimpleGrid, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import type { ConnectionMode, GeneratedRuntimeConfigDto } from "@chordv/shared";
import { IconChartBar, IconPlugConnected, IconShieldCheckered } from "@tabler/icons-react";
import type { RuntimeStatus } from "../lib/runtime";

type ControlPanelProps = {
  modes: ConnectionMode[];
  mode: ConnectionMode;
  canConnect: boolean;
  modeLocked: boolean;
  primaryBusy: boolean;
  primaryLabel: string;
  desktopStatus: RuntimeStatus;
  runtime: GeneratedRuntimeConfigDto | null;
  error: string | null;
  runtimeAssetsPhase: "idle" | "checking" | "downloading" | "ready" | "failed";
  onModeChange: (mode: ConnectionMode) => void;
  onPrimaryAction: () => void;
  onOpenLogs: () => void;
};

export function ControlPanel(props: ControlPanelProps) {
  const isMobile = useMediaQuery("(max-width: 760px)");

  if (isMobile) {
    return (
      <Paper withBorder radius={30} p="lg" className="desktop-panel control-panel control-panel--mobile">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start">
            <Stack gap={4}>
              <Text size="sm" fw={700} c="cyan.8" className="control-panel__eyebrow">
                连接控制
              </Text>
              <Title order={1} className="control-panel__title">
                快速连接
              </Title>
            </Stack>
            <ThemeIcon
              size={48}
              radius="xl"
              variant={props.desktopStatus.status === "connected" ? "filled" : "light"}
              color={props.desktopStatus.status === "connected" ? "green" : "cyan"}
              className="control-panel__badge"
            >
              <IconShieldCheckered size={22} />
            </ThemeIcon>
          </Group>

          <StatusSurface
            status={props.desktopStatus.status}
            nodeName={props.runtime?.node.name ?? "未连接"}
            compact
          />

          <SegmentedControl
            fullWidth
            radius="xl"
            size="md"
            className="control-panel__mode-switch"
            value={props.mode}
            onChange={(value) => props.onModeChange(value as ConnectionMode)}
            disabled={props.modeLocked}
            data={props.modes.map((mode) => ({
              value: mode,
              label: translateMode(mode)
            }))}
          />

          <Button
            size="xl"
            radius="xl"
            className="primary-action control-primary-action"
            leftSection={<IconPlugConnected size={20} />}
            onClick={props.onPrimaryAction}
            loading={props.primaryBusy}
            color={props.desktopStatus.status === "connected" ? "green" : "cyan"}
            disabled={
              !props.canConnect &&
              props.runtimeAssetsPhase !== "failed" &&
              props.desktopStatus.status !== "connected" &&
              props.desktopStatus.status !== "error"
            }
          >
            {props.primaryLabel}
          </Button>

          <SimpleGrid cols={2} spacing="sm" verticalSpacing="sm" className="control-panel__ports">
            <MetricBlock label="HTTP 端口" value={props.runtime ? `${props.runtime.localHttpPort}` : "--"} compact />
            <MetricBlock label="SOCKS 端口" value={props.runtime ? `${props.runtime.localSocksPort}` : "--"} compact />
          </SimpleGrid>

          {props.error ? (
            <Paper withBorder radius="md" p="sm" style={{ borderColor: "rgba(239, 68, 68, 0.24)", background: "rgba(254, 242, 242, 0.9)" }}>
              <Text c="red.6" size="sm">
                {props.error}
              </Text>
            </Paper>
          ) : null}

          <Divider />

          <Group justify="space-between" align="center">
            <Text size="sm" c="dimmed">
              {readRuntimeInstallLabel(props.desktopStatus, props.runtimeAssetsPhase)}
            </Text>
            <Button
              size="sm"
              variant="subtle"
              leftSection={<IconChartBar size={15} />}
              className="control-log-button"
              onClick={props.onOpenLogs}
            >
              连接诊断
            </Button>
          </Group>
        </Stack>
      </Paper>
    );
  }

  return (
    <Paper withBorder radius="lg" p="md" className="desktop-panel">
      <Stack h="100%" gap="sm" className="control-shell">
        <Stack gap="sm">
          <div className="control-head">
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
            radius="md"
            className="primary-action control-primary-action"
            leftSection={<IconPlugConnected size={20} />}
            onClick={props.onPrimaryAction}
            loading={props.primaryBusy}
            color={props.desktopStatus.status === "connected" ? "green" : "cyan"}
            disabled={
              !props.canConnect &&
              props.runtimeAssetsPhase !== "failed" &&
              props.desktopStatus.status !== "connected" &&
              props.desktopStatus.status !== "error"
            }
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
            {readRuntimeInstallLabel(props.desktopStatus, props.runtimeAssetsPhase)}
          </Text>
          <Button
            size="compact-sm"
            variant="subtle"
            leftSection={<IconChartBar size={15} />}
            className="control-log-button"
            onClick={props.onOpenLogs}
          >
            连接诊断
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

function readRuntimeInstallLabel(
  desktopStatus: RuntimeStatus,
  runtimeAssetsPhase: ControlPanelProps["runtimeAssetsPhase"]
) {
  if (runtimeAssetsPhase === "checking" || runtimeAssetsPhase === "downloading") {
    return "内核准备中";
  }
  if (runtimeAssetsPhase === "failed") {
    return "内核准备失败";
  }
  if (!desktopStatus.xrayBinaryPath) {
    return "内核待准备";
  }
  if (desktopStatus.status === "idle") {
    return "内核已安装";
  }
  return "内核已启动";
}

function StatusSurface(props: { status: string; nodeName: string; compact?: boolean }) {
  return (
    <Paper
      radius="md"
      p={props.compact ? "md" : "sm"}
      className={props.compact ? "status-surface status-surface--compact" : "status-surface"}
      style={props.compact ? { borderRadius: 22 } : undefined}
    >
      <Stack gap={props.compact ? 8 : 6}>
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            当前状态
          </Text>
          <Badge variant="light" color={runtimeColor(props.status)}>
            {translateRuntimeStatus(props.status)}
          </Badge>
        </Group>
        <Text fw={700} size={props.compact ? "lg" : undefined} c={props.status === "connected" ? "green.7" : undefined}>
          {props.nodeName}
        </Text>
      </Stack>
    </Paper>
  );
}

function MetricBlock(props: { label: string; value: string; compact?: boolean }) {
  return (
    <Paper withBorder radius="md" p={props.compact ? "md" : "sm"}>
      <Text size="sm" c="dimmed">
        {props.label}
      </Text>
      <Text fw={700} mt="xs" size={props.compact ? "lg" : undefined}>
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
  if (status === "starting") return "启动中";
  if (status === "connecting") return "连接中";
  if (status === "connected") return "已连接";
  if (status === "disconnecting") return "断开中";
  if (status === "error") return "异常";
  return status;
}

function runtimeColor(status: string) {
  if (status === "connected") return "green";
  if (status === "starting" || status === "connecting" || status === "disconnecting") return "yellow";
  if (status === "error") return "red";
  return "gray";
}
