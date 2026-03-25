import type { ClientBootstrapDto, NodeSummaryDto, SubscriptionStatusDto } from "@chordv/shared";
import { notifications } from "@mantine/notifications";
import type { SubscriptionServerProbe } from "../components/SubscriptionPanel";
import type { GuidanceTone, ConnectionGuidance } from "./connectionGuidance";
import type { RuntimeNodeProbeResult } from "./runtime";
import type { RuntimeAssetsUiState } from "./runtimeComponents";
import type { ServerProbeState } from "../hooks/useClientEvents";

export function primaryButtonLabel(
  status: string,
  subscription: SubscriptionStatusDto,
  guidance: ConnectionGuidance | null,
  selectedNodeOffline: boolean,
  runtimeAssets: RuntimeAssetsUiState
) {
  if (status === "connecting") return "连接中";
  if (status === "disconnecting") return "断开中";
  if (status === "connected" || status === "error") return "断开连接";
  if (subscription.state === "expired") return "订阅已到期";
  if (subscription.state === "exhausted" || subscription.remainingTrafficGb <= 0) return "流量已用尽";
  if (subscription.state === "paused") return "订阅已暂停";
  if (runtimeAssets.phase === "checking" || runtimeAssets.phase === "downloading") return "正在准备组件";
  if (runtimeAssets.phase === "failed") return "重试下载组件";
  if (selectedNodeOffline) return "切换节点后重连";
  if (guidance) return guidance.actionLabel;
  return "启动连接";
}

export function pickNode(
  nodes: NodeSummaryDto[],
  preferredId: string | null,
  probeResults?: Record<string, RuntimeNodeProbeResult>
) {
  if (preferredId) {
    const preferred = nodes.find((node) => node.id === preferredId);
    if (preferred) {
      return preferred;
    }
  }

  if (probeResults) {
    const healthy = nodes.find((node) => probeResults[node.id]?.status === "healthy");
    if (healthy) {
      return healthy;
    }
  }

  return nodes[0] ?? null;
}

export function loadLastNodeId(key: string) {
  return localStorage.getItem(key);
}

export function resolveDefaultMode(bootstrap: ClientBootstrapDto) {
  return bootstrap.policies.modes.includes(bootstrap.policies.defaultMode)
    ? bootstrap.policies.defaultMode
    : (bootstrap.policies.modes[0] ?? "rule");
}

export function loadRememberedCredentials(key: string) {
  const raw = localStorage.getItem(key);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { email?: string; password?: string };
    if (typeof parsed.email === "string" && typeof parsed.password === "string") {
      return {
        email: parsed.email,
        password: parsed.password
      };
    }
  } catch {
    return null;
  }

  return null;
}

export function saveRememberedCredentials(key: string, email: string, password: string) {
  localStorage.setItem(
    key,
    JSON.stringify({
      email,
      password
    })
  );
}

export function clearRememberedCredentials(key: string) {
  localStorage.removeItem(key);
}

export function toSubscriptionServerProbe(serverProbe: ServerProbeState): SubscriptionServerProbe {
  switch (serverProbe.status) {
    case "healthy":
      return {
        status: "healthy",
        label: "连接服务器正常",
        detail: serverProbe.elapsedMs !== null ? `连接服务器延迟 ${serverProbe.elapsedMs} ms` : "服务器连接正常"
      };
    case "slow":
      return {
        status: "slow",
        label: "连接服务器较慢",
        detail: serverProbe.elapsedMs !== null ? `连接服务器延迟 ${serverProbe.elapsedMs} ms` : "服务器有响应，但速度偏慢"
      };
    case "failed":
      return {
        status: "failed",
        label: "无法连接服务器",
        detail: serverProbe.errorMessage ?? "当前无法连接服务器，请检查网络或服务端状态"
      };
    default:
      return {
        status: "checking",
        label: "正在检查服务器连接",
        detail: "首次打开后会自动检查一次服务器连接"
      };
  }
}

export function showErrorToast(message: string) {
  notifications.show({
    color: "red",
    title: "操作失败",
    message
  });
}

export function toneToToastColor(tone: GuidanceTone) {
  if (tone === "danger") return "red";
  if (tone === "warning") return "yellow";
  return "cyan";
}
