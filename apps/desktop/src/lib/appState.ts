import type { ClientBootstrapDto, NodeSummaryDto, SubscriptionStatusDto } from "@chordv/shared";
import { notifications } from "./notifications";
import { describeUserError, formatUserError, type UserErrorContext } from "./userFacingErrors";
import { recordClientDiagnosticLog } from "../api/client";
import type { SubscriptionServerProbe } from "../components/SubscriptionPanel";
import type { GuidanceTone, ConnectionGuidance } from "./connectionGuidance";
import type { RuntimeNodeProbeResult, RuntimePlatform } from "./runtime";
import type { RuntimeAssetsUiState } from "./runtimeComponents";
import type { ServerProbeState } from "../hooks/useClientEvents";

export function primaryButtonLabel(
  status: string,
  subscription: SubscriptionStatusDto,
  guidance: ConnectionGuidance | null,
  selectedNodeOffline: boolean,
  runtimeAssets: RuntimeAssetsUiState,
  platformTarget: RuntimePlatform
) {
  if (status === "connecting") return "连接中";
  if (status === "disconnecting") return "断开中";
  if (status === "connected") return "断开连接";
  if (status === "error") {
    if (platformTarget === "android") {
      return guidance?.actionLabel ?? "重新连接";
    }
    return "断开连接";
  }
  if (subscription.state === "expired") return "订阅已到期";
  if (subscription.state === "exhausted" || subscription.remainingTrafficGb <= 0) return "流量已用尽";
  if (subscription.state === "paused") return "订阅已暂停";
  if (runtimeAssets.phase === "checking" || runtimeAssets.phase === "downloading") return "正在准备组件";
  if (runtimeAssets.phase === "failed") return "重试下载组件";
  if (selectedNodeOffline) return "切换节点后重连";
  if (guidance) return guidance.actionLabel;
  return "启动连接";
}

/** One read-only tray line: what is left and until when. */
export function formatTrayTrafficLine(subscription: SubscriptionStatusDto) {
  const remaining = Number.isFinite(subscription.remainingTrafficGb) ? Math.max(0, subscription.remainingTrafficGb) : 0;
  const amount = remaining >= 100 ? remaining.toFixed(0) : remaining.toFixed(1).replace(/\.0$/, "");
  const expireAt = new Date(subscription.expireAt);
  const prefix = subscription.ownerType === "team" ? "团队剩余" : "剩余";
  if (!Number.isFinite(expireAt.getTime())) return `${prefix} ${amount} GB`;
  const date = `${expireAt.getFullYear()}/${`${expireAt.getMonth() + 1}`.padStart(2, "0")}/${`${expireAt.getDate()}`.padStart(2, "0")}`;
  return `${prefix} ${amount} GB · ${date} 到期`;
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
    if (typeof parsed.email === "string" && parsed.email.trim()) {
      // 兼容旧版本：若本地仍有明文密码字段，读取后立即清除，避免继续落盘。
      if (typeof parsed.password === "string" && parsed.password.length > 0) {
        localStorage.setItem(key, JSON.stringify({ email: parsed.email.trim() }));
      }
      return {
        email: parsed.email.trim(),
        password: ""
      };
    }
  } catch {
    return null;
  }

  return null;
}

export function saveRememberedCredentials(key: string, email: string, _password?: string) {
  const normalizedEmail = email.trim();
  if (!normalizedEmail) {
    localStorage.removeItem(key);
    return;
  }
  localStorage.setItem(
    key,
    JSON.stringify({
      email: normalizedEmail
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
    case "failed":
      return {
        status: "failed",
        label: "无法连接服务器",
        detail: serverProbe.errorMessage ?? "当前无法连接服务器，请检查网络后重试。"
      };
    default:
      return {
        status: "checking",
        label: "正在检查服务器连接",
        detail: "首次打开后会自动检查一次服务器连接"
      };
  }
}

/**
 * 所有错误通知的统一出口：先经过面向客户的错误映射，原始文本只写入诊断日志，
 * 通知里只出现中文说明和可选的「错误编号」。
 */
export function showErrorToast(message: string | null | undefined, context: UserErrorContext = "general") {
  const error = describeUserError(message ?? "", { context });
  if (error.detail && (!error.known || error.detail !== error.message)) {
    void recordClientDiagnosticLog("user-error", `[${context}] code=${error.code ?? "-"} detail=${error.detail}`);
  }
  notifications.show({
    color: "red",
    title: error.title,
    message: formatUserError(error)
  });
}

export function toneToToastColor(tone: GuidanceTone) {
  if (tone === "danger") return "red";
  if (tone === "warning") return "yellow";
  return "cyan";
}
