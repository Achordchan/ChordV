import { Alert, Button, Group, Progress, Stack, Text } from "@mantine/core";
import { IconAlertTriangle, IconCheck, IconDownload, IconLoader2 } from "@tabler/icons-react";
import {
  formatRuntimeAssetsMessage,
  formatRuntimeAssetsTitle,
  resolveRuntimeAssetsTone,
  type RuntimeAssetsUiState
} from "../lib/runtimeComponents";

type RuntimeAssetsBannerProps = {
  state: RuntimeAssetsUiState;
  onRetry?: (() => void) | null;
  compact?: boolean;
};

export function RuntimeAssetsBanner(props: RuntimeAssetsBannerProps) {
  if (props.state.phase === "idle" || props.state.phase === "ready") {
    return null;
  }

  const tone = resolveRuntimeAssetsTone(props.state.phase);

  return (
    <Alert
      color={toneToMantineColor(tone)}
      variant="light"
      radius="lg"
      className={`desktop-state-banner desktop-state-banner--${tone}`}
      icon={<BannerIcon phase={props.state.phase} />}
    >
      <Stack gap={props.compact ? 8 : 10}>
        <div>
          <Text fw={700}>{formatRuntimeAssetsTitle(props.state)}</Text>
          <Text size="sm" c="dimmed">
            {formatRuntimeAssetsMessage(props.state)}
          </Text>
        </div>

        {props.state.phase === "downloading" ? (
          <Stack gap={6}>
            <Progress value={downloadProgressValue(props.state)} animated />
            <Text size="xs" c="dimmed">
              {describeRuntimeAssetsProgress(props.state)}
            </Text>
          </Stack>
        ) : null}

        {props.state.phase === "checking" ? (
          <Text size="xs" c="dimmed">
            {describeRuntimeAssetsProgress(props.state)}
          </Text>
        ) : null}

        {props.state.phase === "failed" ? (
          <Group justify="space-between" align="center" gap="xs">
            <Text size="xs" c="dimmed">
              {props.state.errorCode ? `错误代码：${props.state.errorCode}` : "当前连接已被阻止"}
            </Text>
            {props.onRetry ? (
              <Button size="xs" variant="white" onClick={props.onRetry}>
                重试下载
              </Button>
            ) : null}
          </Group>
        ) : null}
      </Stack>
    </Alert>
  );
}

function toneToMantineColor(tone: "neutral" | "info" | "warning" | "danger" | "success") {
  if (tone === "info") return "blue";
  if (tone === "warning") return "yellow";
  if (tone === "danger") return "red";
  if (tone === "success") return "green";
  return "gray";
}

function BannerIcon(props: { phase: RuntimeAssetsUiState["phase"] }) {
  if (props.phase === "ready") {
    return <IconCheck size={18} />;
  }
  if (props.phase === "failed") {
    return <IconAlertTriangle size={18} />;
  }
  if (props.phase === "checking") {
    return <IconLoader2 size={18} />;
  }
  return <IconDownload size={18} />;
}

function describeRuntimeAssetsProgress(state: RuntimeAssetsUiState) {
  const fileName = state.fileName ?? componentLabel(state.currentComponent);
  const amount = `${formatByteSize(state.downloadedBytes)}${
    state.totalBytes ? ` / ${formatByteSize(state.totalBytes)}` : ""
  }`;
  if (state.phase === "checking") {
    if (state.message) {
      return state.message;
    }
    return fileName ? `正在检查 ${fileName}` : "正在检查连接所需组件";
  }
  return fileName ? `${fileName} · ${amount}` : amount;
}

function downloadProgressValue(state: RuntimeAssetsUiState) {
  if (!state.totalBytes || state.totalBytes <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, (state.downloadedBytes / state.totalBytes) * 100));
}

function componentLabel(component: RuntimeAssetsUiState["currentComponent"]) {
  if (component === "xray") return "xray 内核";
  if (component === "geoip") return "geoip.dat";
  if (component === "geosite") return "geosite.dat";
  return "";
}

function formatByteSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}
