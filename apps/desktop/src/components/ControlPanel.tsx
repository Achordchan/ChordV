import { Badge, Button, Divider, Group, Paper, SegmentedControl, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useEffect, useState } from "react";
import type { ConnectionMode, GeneratedRuntimeConfigDto } from "@chordv/shared";
import { IconChartBar, IconPlugConnected, IconRoute, IconShieldCheckered } from "@tabler/icons-react";
import type { RuntimeStatus } from "../lib/runtime";
import { NoticeRow } from "./NoticeRow";
import {
  PRIMARY_FILL_COMPLETE_MS,
  resolvePrimaryFillPhase,
  shouldCompleteFill,
  type PrimaryBusyAction,
  type PrimaryFillPhase
} from "../lib/primaryActionFill";

type ControlPanelProps = {
  modes: ConnectionMode[];
  mode: ConnectionMode;
  canConnect: boolean;
  modeLocked: boolean;
  primaryBusy: boolean;
  busyAction?: PrimaryBusyAction;
  primaryLabel: string;
  desktopStatus: RuntimeStatus;
  runtime: GeneratedRuntimeConfigDto | null;
  error: string | null;
  runtimeAssetsPhase: "idle" | "checking" | "downloading" | "completed" | "ready" | "failed";
  onModeChange: (mode: ConnectionMode) => void;
  onPrimaryAction: () => void;
  onOpenRoutingRules: () => void;
  onOpenLogs: () => void;
};

export function ControlPanel(props: ControlPanelProps) {
  const isMobile = useMediaQuery("(max-width: 760px)");
  const fillPhase = usePrimaryFillPhase(props.desktopStatus.status, props.busyAction ?? null);
  const filling = fillPhase !== "idle";
  const primaryLabel =
    fillPhase === "connecting"
      ? props.runtimeAssetsPhase === "checking" || props.runtimeAssetsPhase === "downloading"
        ? props.primaryLabel
        : "正在连接…"
      : fillPhase === "disconnecting"
        ? "正在断开…"
        : fillPhase === "completing"
          ? "已连接"
          : props.primaryLabel;
  const renderPrimaryButton = (size: "md" | "xl") => (
    <Button
      size={size}
      className="primary-action control-primary-action"
      data-fill={filling ? fillPhase : undefined}
      data-disabled={filling || undefined}
      aria-disabled={filling || undefined}
      aria-busy={filling || props.primaryBusy || undefined}
      leftSection={<IconPlugConnected size={20} />}
      onClick={filling ? undefined : props.onPrimaryAction}
      loading={props.primaryBusy && !filling}
      color={props.desktopStatus.status === "connected" ? "green" : "cyan"}
      fullWidth
      disabled={
        !filling &&
        !props.canConnect &&
        props.runtimeAssetsPhase !== "failed" &&
        props.desktopStatus.status !== "connected" &&
        props.desktopStatus.status !== "error"
      }
    >
      {primaryLabel}
    </Button>
  );

  if (isMobile) {
    return (
      <Paper withBorder p="lg" className="desktop-panel control-panel control-panel--mobile">
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

          {renderPrimaryButton("xl")}

          <LocalProxyPorts runtime={props.runtime} />

          {props.error ? (
            <NoticeRow tone="danger" role="alert" className="control-error">
              {props.error}
            </NoticeRow>
          ) : null}

          <Divider />

          <Group justify="space-between" align="center">
            <Text size="sm" c="dimmed">
              {readRuntimeInstallLabel(props.desktopStatus, props.runtimeAssetsPhase)}
            </Text>
            <Group gap="xs" wrap="nowrap" className="control-footer-actions">
              <Button
                size="sm"
                variant="subtle"
                leftSection={<IconRoute size={15} />}
                className="control-routing-button"
                onClick={props.onOpenRoutingRules}
              >
                自定义分流
              </Button>
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
          </Group>
        </Stack>
      </Paper>
    );
  }

  return (
    <Paper withBorder p="md" className="desktop-panel control-panel">
      <Stack h="100%" gap={10} className="control-shell">
        <Stack gap={10} className="control-body">
          <div className="control-head">
            <Title order={3} className="panel-title">连接控制</Title>
          </div>

          <StatusSurface status={props.desktopStatus.status} nodeName={props.runtime?.node.name ?? "未连接"} />

          <SegmentedControl
            fullWidth
            className="control-panel__mode-switch"
            value={props.mode}
            onChange={(value) => props.onModeChange(value as ConnectionMode)}
            disabled={props.modeLocked}
            data={props.modes.map((mode) => ({
              value: mode,
              label: translateMode(mode)
            }))}
          />

          {renderPrimaryButton("md")}

          <LocalProxyPorts runtime={props.runtime} />

          {props.error ? (
            <NoticeRow tone="danger" role="alert" className="control-error">
              {props.error}
            </NoticeRow>
          ) : null}
        </Stack>

        <Group justify="space-between" className="control-footer">
          <Text size="sm" c="dimmed">
            {readRuntimeInstallLabel(props.desktopStatus, props.runtimeAssetsPhase)}
          </Text>
          <Group gap="xs" wrap="nowrap" className="control-footer-actions">
            <Button
              size="compact-sm"
              variant="subtle"
              leftSection={<IconRoute size={15} />}
              className="control-routing-button"
              onClick={props.onOpenRoutingRules}
            >
              自定义分流
            </Button>
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
        </Group>
      </Stack>
    </Paper>
  );
}

function usePrimaryFillPhase(status: string, busyAction: PrimaryBusyAction): PrimaryFillPhase {
  const phase = resolvePrimaryFillPhase(status, busyAction);
  const [trackedPhase, setTrackedPhase] = useState(phase);
  const [completing, setCompleting] = useState(false);
  if (trackedPhase !== phase) {
    // Adjusted during render so the green idle button never flashes before the sweep.
    setTrackedPhase(phase);
    setCompleting(shouldCompleteFill(trackedPhase, phase, status));
  }
  useEffect(() => {
    if (!completing) return;
    const timer = window.setTimeout(() => setCompleting(false), PRIMARY_FILL_COMPLETE_MS);
    return () => window.clearTimeout(timer);
  }, [completing]);
  return completing && phase === "idle" && status === "connected" ? "completing" : phase;
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
    <div className={props.compact ? "status-surface status-surface--compact" : "status-surface"}>
      <Stack gap={props.compact ? 8 : 4}>
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            当前状态
          </Text>
          <Badge variant="light" color={runtimeColor(props.status)}>
            {translateRuntimeStatus(props.status)}
          </Badge>
        </Group>
        <Text fw={650} size={props.compact ? "lg" : undefined} c={props.status === "connected" ? "green.7" : undefined} lineClamp={1}>
          {props.nodeName}
        </Text>
      </Stack>
    </div>
  );
}

/** Local proxy ports are reference information, so they sit under the connect
 * button as a single muted caption instead of metric cards. */
function LocalProxyPorts(props: { runtime: GeneratedRuntimeConfigDto | null }) {
  return (
    <div className="control-ports" aria-label="本地代理端口">
      <span className="control-ports__label">本地代理</span>
      <span>
        HTTP <span className="control-ports__value">{props.runtime ? props.runtime.localHttpPort : "--"}</span>
      </span>
      <span className="control-ports__separator" aria-hidden="true">·</span>
      <span>
        SOCKS <span className="control-ports__value">{props.runtime ? props.runtime.localSocksPort : "--"}</span>
      </span>
    </div>
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
