import type {
  ClientRuntimeEventDto,
  GeneratedRuntimeConfigDto,
  NodeSummaryDto,
  SubscriptionStatusDto
} from "@chordv/shared";
import { loadRuntimeStatus, type RuntimeNodeProbeResult, type RuntimeStatus } from "./runtime";
import { ERROR_CODE_LABEL, isCustomerSafeText, RUNTIME_REASON_CODES } from "./userFacingErrors";

export type GuidanceTone = "danger" | "warning" | "info";

export type ConnectionGuidanceCode =
  | "admin_paused"
  | "node_access_revoked"
  | "node_provisioning_pending"
  | "node_unavailable"
  | "subscription_expired"
  | "subscription_exhausted"
  | "subscription_paused"
  | "session_replaced"
  | "session_expired"
  | "session_invalid"
  | "team_access_revoked"
  | "account_disabled"
  | "client_rotated"
  | "desktop_external_vpn_conflict"
  | "desktop_external_proxy_conflict"
  | "windows_proxy_failed"
  | "windows_local_proxy_failed"
  | "android_vpn_permission_denied"
  | "android_vpn_setup_failed"
  | "android_runtime_start_failed"
  | "android_connectivity_failed"
  | "runtime_exited";

export type ConnectionGuidance = {
  code: ConnectionGuidanceCode;
  tone: GuidanceTone;
  title: string;
  message: string;
  actionLabel: string;
  recommendedNodeId?: string | null;
  /** 稳定的机器错误码，只作为「错误编号」次要展示。 */
  errorCode?: string | null;
  /** 原始失败文本，仅供日志 / 复制诊断使用，绝不能作为界面上的 detail 展示。 */
  diagnostic?: string | null;
};

export function readError(message: string) {
  if (message.includes("Panel client is queued but not confirmed yet")) {
    return "节点开通同步中，请稍后重试。";
  }
  try {
    const parsed = JSON.parse(message) as { message?: string[] | string };
    if (Array.isArray(parsed.message)) {
      return parsed.message.join("，");
    }
    if (typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    return message;
  }

  return message;
}

export function sameGuidance(left: ConnectionGuidance | null, right: ConnectionGuidance | null) {
  if (!left || !right) {
    return left === right;
  }
  return guidanceKey(left) === guidanceKey(right);
}

export function guidanceKey(guidance: ConnectionGuidance) {
  return [guidance.code, guidance.message, guidance.recommendedNodeId ?? ""].join(":");
}

export function isSubscriptionBlocked(subscription: SubscriptionStatusDto | null) {
  if (!subscription) {
    return false;
  }
  return (
    subscription.state === "expired" ||
    subscription.state === "exhausted" ||
    subscription.state === "paused" ||
    subscription.remainingTrafficGb <= 0 ||
    subscription.stateReasonCode === "account_disabled" ||
    subscription.stateReasonCode === "team_access_revoked"
  );
}

export function deriveGuidanceFromSubscription(
  subscription: SubscriptionStatusDto,
  fallbackNodeId: string | null
): ConnectionGuidance | null {
  const stateReasonGuidance = deriveGuidanceFromSubscriptionStateReason(subscription, fallbackNodeId);
  if (stateReasonGuidance) {
    return stateReasonGuidance;
  }
  if (subscription.state === "expired") {
    return {
      code: "subscription_expired",
      tone: "danger",
      title: "订阅已到期",
      message: "你的订阅已到期，连接已停止。续费后即可继续使用，如有疑问请联系客服。",
      actionLabel: "订阅已到期",
      recommendedNodeId: fallbackNodeId
    };
  }
  if (subscription.state === "exhausted" || subscription.remainingTrafficGb <= 0) {
    return {
      code: "subscription_exhausted",
      tone: "danger",
      title: "流量已用尽",
      message: "本期流量已用完，连接已停止。请续费或等待流量重置后再使用。",
      actionLabel: "流量已用尽",
      recommendedNodeId: fallbackNodeId
    };
  }
  if (subscription.state === "paused") {
    return {
      code: "subscription_paused",
      tone: "warning",
      title: "订阅已暂停",
      message: "你的订阅已暂停，连接已停止。请联系客服恢复后再使用。",
      actionLabel: "订阅已暂停",
      recommendedNodeId: fallbackNodeId
    };
  }
  return null;
}

export function deriveGuidanceFromMessage(
  message: string,
  options: { fallbackNodeId: string | null }
): ConnectionGuidance | null {
  if (message.includes("当前节点授权已取消") || message.includes("当前节点已被取消授权")) {
    return {
      code: "node_access_revoked",
      tone: "warning",
      title: "节点已不可用",
      message: "当前节点已不在你的订阅范围内，请切换其他节点后重新连接。",
      actionLabel: "切换节点后重连",
      recommendedNodeId: options.fallbackNodeId
    };
  }
  if (
    message.includes("当前节点客户端已停用") ||
    message.includes("管理员已暂停当前连接") ||
    message.includes("连接已被管理员暂停")
  ) {
    return {
      code: "admin_paused",
      tone: "danger",
      title: "连接已被管理员暂停",
      message: "你的连接已被管理员暂停，请稍后重试或联系客服。",
      actionLabel: "重新连接",
      recommendedNodeId: options.fallbackNodeId
    };
  }
  if (message.includes("当前节点客户端凭据已更新") || message.includes("当前连接凭据已更新")) {
    return {
      code: "client_rotated",
      tone: "warning",
      title: "连接信息已更新",
      message: "你的连接信息已更新，请重新连接。",
      actionLabel: "重新连接",
      recommendedNodeId: options.fallbackNodeId
    };
  }
  if (message.includes("当前连接已被其他设备接管")) {
    return {
      code: "session_replaced",
      tone: "warning",
      title: "已在其他设备连接",
      message: "你的账号已在其他设备上连接，本设备已断开。如需在本设备使用，请重新连接。",
      actionLabel: "重新连接",
      recommendedNodeId: options.fallbackNodeId
    };
  }
  if (message.includes("当前订阅已到期")) {
    return {
      code: "subscription_expired",
      tone: "danger",
      title: "订阅已到期",
      message: "你的订阅已到期，连接已停止。续费后即可继续使用，如有疑问请联系客服。",
      actionLabel: "订阅已到期",
      recommendedNodeId: options.fallbackNodeId
    };
  }
  if (message.includes("当前订阅流量已用尽")) {
    return {
      code: "subscription_exhausted",
      tone: "danger",
      title: "流量已用尽",
      message: "本期流量已用完，连接已停止。请续费或等待流量重置后再使用。",
      actionLabel: "流量已用尽",
      recommendedNodeId: options.fallbackNodeId
    };
  }
  if (message.includes("当前订阅已暂停")) {
    return {
      code: "subscription_paused",
      tone: "warning",
      title: "订阅已暂停",
      message: "你的订阅已暂停，连接已停止。请联系客服恢复后再使用。",
      actionLabel: "订阅已暂停",
      recommendedNodeId: options.fallbackNodeId
    };
  }
  if (message.includes("当前成员已失去团队访问权限")) {
    return {
      code: "team_access_revoked",
      tone: "danger",
      title: "团队访问权限已失效",
      message: "你已失去当前团队的访问权限，请联系团队负责人处理。",
      actionLabel: "返回并刷新",
      recommendedNodeId: options.fallbackNodeId
    };
  }
  if (message.includes("当前账号已禁用")) {
    return {
      code: "account_disabled",
      tone: "danger",
      title: "账号已禁用",
      message: "当前账号已被停用，连接已停止。如有疑问请联系客服。",
      actionLabel: "返回并刷新",
      recommendedNodeId: options.fallbackNodeId
    };
  }
  if (message.includes("会话已过期") || message.includes("当前连接已过期")) {
    return {
      code: "session_expired",
      tone: "warning",
      title: "连接已过期",
      message: "当前连接已过期，请重新连接。",
      actionLabel: "重新连接",
      recommendedNodeId: options.fallbackNodeId
    };
  }
  if (message.includes("会话已失效") || message.includes("当前连接已失效") || message.includes("当前连接已断开")) {
    return {
      code: "session_invalid",
      tone: "warning",
      title: "连接已失效",
      message: "当前连接已失效，请重新连接。",
      actionLabel: "重新连接",
      recommendedNodeId: options.fallbackNodeId
    };
  }
  return null;
}

export function deriveGuidanceFromConnectFailure(
  message: string,
  fallbackNodeId: string | null,
  platformTarget: RuntimeStatus["platformTarget"] = "web"
): ConnectionGuidance | null {
  const existing = deriveGuidanceFromMessage(message, { fallbackNodeId });
  if (existing) {
    return existing;
  }
  const runtimeFailure = deriveGuidanceFromRuntimeFailure(message, fallbackNodeId);
  if (runtimeFailure) {
    return runtimeFailure;
  }
  if (message.includes("当前订阅未开通该节点")) {
    return {
      code: "node_access_revoked",
      tone: "warning",
      title: "节点未开通",
      message: "你的订阅暂不包含此节点，请切换其他节点后重新连接。",
      actionLabel: "切换节点后重连",
      recommendedNodeId: fallbackNodeId
    };
  }
  if (message.includes("节点开通同步中")) {
    return {
      code: "node_provisioning_pending",
      tone: "warning",
      title: "节点开通同步中",
      message: "节点正在开通，通常很快就能完成，请稍后重试。",
      actionLabel: "稍后重试",
      recommendedNodeId: fallbackNodeId,
      errorCode: "node_provisioning_pending"
    };
  }
  if (platformTarget === "android" && looksLikeGenericConnectFailure(message)) {
    return {
      code: "android_runtime_start_failed",
      tone: "danger",
      title: "连接启动失败",
      message: "连接没有成功建立，请重新连接；如仍失败，请联系客服并提供错误编号。",
      actionLabel: "重新连接",
      recommendedNodeId: fallbackNodeId,
      errorCode: extractRuntimeReasonCode(message) ?? "android_runtime_start_failed"
    };
  }
  if (looksLikeNodeUnavailable(message)) {
    return {
      code: "node_unavailable",
      tone: "warning",
      title: "节点暂不可用",
      message: "当前节点暂时无法连接，请切换其他节点后重试。",
      actionLabel: "切换节点后重连",
      recommendedNodeId: fallbackNodeId,
      errorCode: "node_unavailable"
    };
  }
  if (platformTarget === "android") {
    return {
      code: "android_runtime_start_failed",
      tone: "danger",
      title: "连接启动失败",
      message: "连接没有成功建立，请重新连接；如仍失败，请联系客服并提供错误编号。",
      actionLabel: "重新连接",
      recommendedNodeId: fallbackNodeId,
      errorCode: extractRuntimeReasonCode(message) ?? "android_runtime_start_failed"
    };
  }
  return null;
}

function looksLikeGenericConnectFailure(message: string) {
  return (
    message.includes("连接失败") ||
    message.includes("超时") ||
    message === "连接失败" ||
    message.includes("当前节点连接失败")
  );
}

function looksLikeNodeUnavailable(message: string) {
  return (
    message.includes("节点暂不可用") ||
    message.includes("节点不可用") ||
    message.includes("节点探测失败") ||
    message.includes("节点连接超时") ||
    message.includes("节点测速失败") ||
    message.includes("当前节点已离线") ||
    message.includes("当前节点已下线") ||
    message.includes("节点离线") ||
    message.includes("节点被禁用")
  );
}

export function deriveGuidanceFromRuntimeFailure(
  rawMessage: string,
  fallbackNodeId: string | null
): ConnectionGuidance | null {
  const guidance = deriveGuidanceFromRuntimeFailureText(rawMessage, fallbackNodeId);
  return guidance ? { ...guidance, diagnostic: rawMessage.trim() || null } : null;
}

function deriveGuidanceFromRuntimeFailureText(
  rawMessage: string,
  fallbackNodeId: string | null
): ConnectionGuidance | null {
  const message = readError(rawMessage);
  const runtimeReasonCode = extractRuntimeReasonCode(message);
  if (
    message.includes("external_vpn_conflict") ||
    message.includes("已有 VPN 正在运行") ||
    message.includes("请先断开后再连接 ChordV")
  ) {
    return {
      code: "desktop_external_vpn_conflict",
      tone: "warning",
      title: "检测到其他 VPN",
      message: "系统中已有其他 VPN 处于连接状态，请先断开它，再连接 ChordV。",
      actionLabel: "重试连接",
      recommendedNodeId: fallbackNodeId,
      errorCode: runtimeReasonCode ?? "external_vpn_conflict"
    };
  }

  if (
    message.includes("external_proxy_conflict") ||
    message.includes("系统代理已由其他应用占用")
  ) {
    return {
      code: "desktop_external_proxy_conflict",
      tone: "warning",
      title: "检测到其他代理软件",
      message: "系统代理正被其他应用占用，请先关闭该代理软件，再连接 ChordV。",
      actionLabel: "重试连接",
      recommendedNodeId: fallbackNodeId,
      errorCode: runtimeReasonCode ?? "external_proxy_conflict"
    };
  }

  if (
    message.includes("config_missing") ||
    message.includes("start_args_missing") ||
    message.includes("geo_resource_missing")
  ) {
    return {
      code: "android_runtime_start_failed",
      tone: "danger",
      title: "连接组件不完整",
      message: "连接所需的组件或配置不完整，请重新连接；如仍失败，请联系客服并提供错误编号。",
      actionLabel: "重试连接",
      recommendedNodeId: fallbackNodeId,
      errorCode: runtimeReasonCode ?? "config_missing"
    };
  }
  if (
    message.includes("vpn_permission_denied") ||
    message.includes("vpn_permission_lost") ||
    message.includes("未授予 Android VPN 权限") ||
    message.includes("Android VPN 权限") ||
    message.includes("需要授权 VPN")
  ) {
    const permissionLost = message.includes("vpn_permission_lost") || message.includes("系统回收了 VPN 权限");
    return {
      code: "android_vpn_permission_denied",
      tone: "warning",
      title: permissionLost ? "VPN 权限已失效" : "需要 VPN 权限",
      message: permissionLost
        ? "系统已收回 VPN 权限，连接已断开。请重新连接，并在系统弹窗中点击“允许”。"
        : "连接前需要授予 VPN 权限。请重新连接，并在系统弹窗中点击“允许”。",
      actionLabel: "重新连接",
      recommendedNodeId: fallbackNodeId,
      errorCode: runtimeReasonCode ?? "vpn_permission_denied"
    };
  }

  if (
    message.includes("建立 Android VPN 接口失败") ||
    message.includes("VPN 接口建立失败") ||
    message.includes("vpn_interface_establish_failed") ||
    message.includes("vpn_interface_not_ready") ||
    message.includes("Android VPN/TUN 启动失败") ||
    message.includes("调用 Android VPN/TUN 运行时失败")
  ) {
    return {
      code: "android_vpn_setup_failed",
      tone: "danger",
      title: "VPN 启动失败",
      message: "系统未能启动 VPN，连接未生效。请关闭其他 VPN 应用后重试。",
      actionLabel: "重新连接",
      recommendedNodeId: fallbackNodeId,
      errorCode: runtimeReasonCode ?? "vpn_interface_establish_failed"
    };
  }

  if (
    message.includes("service_start_failed") ||
    message.includes("android_runtime_start_failed") ||
    message.includes("libv2ray_start_failed") ||
    message.includes("Android 运行时插件未注册") ||
    message.includes("Android xray 进程未启动") ||
    message.includes("Android 运行时启动失败") ||
    message.includes("缺少 Android")
  ) {
    return {
      code: "android_runtime_start_failed",
      tone: "danger",
      title: "连接启动失败",
      message: "连接服务没有成功启动，请重新连接；如仍失败，请联系客服并提供错误编号。",
      actionLabel: "重新连接",
      recommendedNodeId: fallbackNodeId,
      errorCode: runtimeReasonCode ?? "android_runtime_start_failed"
    };
  }

  if (
    message.includes("runtime_stopped") ||
    message.includes("runtime_mismatch") ||
    message.includes("connectivity_check_failed") ||
    message.includes("Android VPN/TUN 尚未进入已连接状态") ||
    message.includes("连通性自检失败") ||
    message.includes("连接自检失败") ||
    message.includes("当前连接未生效")
  ) {
    return {
      code: "android_connectivity_failed",
      tone: "danger",
      title: "连接未生效",
      message: message.includes("runtime_stopped") || message.includes("runtime_mismatch")
        ? "后台连接服务已停止，连接已失效。请重新连接；如仍失败，请更换节点。"
        : "连接已建立，但网络检测没有通过。请重新连接；如仍失败，请更换节点。",
      actionLabel: "重新连接",
      recommendedNodeId: fallbackNodeId,
      errorCode: runtimeReasonCode ?? "android_connectivity_failed"
    };
  }

  if (
    message.includes("系统代理设置失败") ||
    message.includes("Windows 系统代理设置失败") ||
    message.includes("代理接管失败") ||
    message.includes("InternetSetOption") ||
    message.includes("WinINET")
  ) {
    return {
      code: "windows_proxy_failed",
      tone: "danger",
      title: "系统代理设置失败",
      message: "ChordV 未能设置系统代理，连接未生效。请检查安全软件是否拦截后重新连接。",
      actionLabel: "重新连接",
      recommendedNodeId: fallbackNodeId,
      errorCode: runtimeReasonCode ?? "windows_proxy_failed"
    };
  }

  if (
    message.includes("本地代理启动失败") ||
    message.includes("本地代理未就绪") ||
    message.includes("本地代理端口未就绪") ||
    message.includes("连通性检查失败") ||
    message.includes("代理连通性检查失败")
  ) {
    return {
      code: "windows_local_proxy_failed",
      tone: "danger",
      title: "本地代理启动失败",
      message: "本地代理没有成功启动，连接未生效。请重新连接；如仍失败，请联系客服并提供错误编号。",
      actionLabel: "重新连接",
      recommendedNodeId: fallbackNodeId,
      errorCode: runtimeReasonCode ?? "windows_local_proxy_failed"
    };
  }

  if (
    message.includes("内核已退出") ||
    message.includes("xray 已退出") ||
    message.includes("核心已退出") ||
    message.includes("内核进程已退出") ||
    message.includes("spawn") ||
    message.includes("启动 xray 失败")
  ) {
    return {
      code: "runtime_exited",
      tone: "danger",
      title: "连接意外中断",
      message: "连接服务意外停止，请重新连接；如仍失败，请联系客服并提供错误编号。",
      actionLabel: "重新连接",
      recommendedNodeId: fallbackNodeId,
      errorCode: runtimeReasonCode ?? "runtime_exited"
    };
  }

  return null;
}

export function composeRuntimeFailureText(status: RuntimeStatus) {
  const fragments = [status.reasonCode, status.lastError, status.recoveryHint];

  if (status.platformTarget === "android") {
    if (status.vpnActive === false) {
      fragments.push("Android VPN 接口未建立");
    }
    if (status.connectivityVerified === false) {
      fragments.push("connectivity_check_failed");
      fragments.push("连接自检失败");
    }
  }

  return fragments.filter(Boolean).join(" ");
}

export function deriveGuidanceFromRuntimeStatus(
  status: RuntimeStatus,
  fallbackNodeId: string | null
): ConnectionGuidance | null {
  if (status.platformTarget !== "android") {
    return null;
  }
  if (!status.reasonCode && !status.lastError && status.vpnActive !== false && status.connectivityVerified !== false) {
    return null;
  }
  return deriveGuidanceFromRuntimeFailure(composeRuntimeFailureText(status), fallbackNodeId);
}

export async function loadConnectFailureRuntimeStatus() {
  const first = await loadRuntimeStatus();
  if (!shouldRetryAndroidRuntimeStatus(first)) {
    return first;
  }

  let latest = first;
  for (let index = 0; index < 3; index += 1) {
    await waitForRuntimeStatus(180);
    latest = await loadRuntimeStatus();
    if (!shouldRetryAndroidRuntimeStatus(latest)) {
      return latest;
    }
  }

  return latest;
}

export function shouldRetryAndroidRuntimeStatus(status: RuntimeStatus) {
  if (status.platformTarget !== "android") {
    return false;
  }

  const hasSpecificFailure =
    Boolean(status.reasonCode) ||
    Boolean(status.lastError) ||
    status.vpnActive === false ||
    status.connectivityVerified === false;

  if (hasSpecificFailure) {
    return false;
  }

  return status.status === "idle" || status.status === "starting" || status.status === "connecting";
}

export function formatGuidanceMessage(guidance: ConnectionGuidance) {
  if (!guidance.errorCode) {
    return guidance.message;
  }
  return `${guidance.message}\n${ERROR_CODE_LABEL}：${guidance.errorCode}`;
}

export function isDialogOnlyGuidance(code: ConnectionGuidanceCode) {
  return code === "desktop_external_vpn_conflict" || code === "desktop_external_proxy_conflict";
}

/** 只有“其他 VPN/代理占用”这类冲突，才允许用户确认后强制接管系统代理。 */
export function canForceConnectGuidance(code: ConnectionGuidanceCode) {
  return code === "desktop_external_vpn_conflict" || code === "desktop_external_proxy_conflict";
}

export function extractRuntimeReasonCode(message: string) {
  return RUNTIME_REASON_CODES.find((code) => message.includes(code)) ?? null;
}

export function waitForRuntimeStatus(delayMs: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

export function deriveGuidanceFromRuntimeEvent(
  event: ClientRuntimeEventDto,
  fallbackNodeId: string | null
): ConnectionGuidance | null {
  // 服务端下发的说明只有在是客户可读的中文时才原样展示，否则使用本地文案。
  const message = isCustomerSafeText(event.reasonMessage) ? event.reasonMessage : null;

  switch (event.reasonCode) {
    case "admin_paused_connection":
      return {
        code: "admin_paused",
        tone: "danger",
        title: "连接已被管理员暂停",
        message: message ?? "你的连接已被管理员暂停，请稍后重试或联系客服。",
        actionLabel: "重新连接",
        recommendedNodeId: fallbackNodeId,
        errorCode: event.reasonCode ?? "admin_paused_connection"
      };
    case "node_access_revoked":
      return {
        code: "node_access_revoked",
        tone: "warning",
        title: "节点已不可用",
        message: message ?? "当前节点已不在你的订阅范围内，请切换其他节点后重新连接。",
        actionLabel: "切换节点后重连",
        recommendedNodeId: fallbackNodeId,
        errorCode: event.reasonCode ?? "node_access_revoked"
      };
    case "subscription_expired":
      return {
        code: "subscription_expired",
        tone: "danger",
        title: "订阅已到期",
        message: message ?? "你的订阅已到期，连接已停止。续费后即可继续使用，如有疑问请联系客服。",
        actionLabel: "订阅已到期",
        recommendedNodeId: fallbackNodeId,
        errorCode: event.reasonCode ?? "subscription_expired"
      };
    case "subscription_exhausted":
      return {
        code: "subscription_exhausted",
        tone: "danger",
        title: "流量已用尽",
        message: message ?? "本期流量已用完，连接已停止。请续费或等待流量重置后再使用。",
        actionLabel: "流量已用尽",
        recommendedNodeId: fallbackNodeId,
        errorCode: event.reasonCode ?? "subscription_exhausted"
      };
    case "subscription_paused":
      return {
        code: "subscription_paused",
        tone: "warning",
        title: "订阅已暂停",
        message: message ?? "你的订阅已暂停，连接已停止。请联系客服恢复后再使用。",
        actionLabel: "订阅已暂停",
        recommendedNodeId: fallbackNodeId,
        errorCode: event.reasonCode ?? "subscription_paused"
      };
    case "connection_taken_over":
      return {
        code: "session_replaced",
        tone: "warning",
        title: "已在其他设备连接",
        message: message ?? "你的账号已在其他设备上连接，本设备已断开。如需在本设备使用，请重新连接。",
        actionLabel: "重新连接",
        recommendedNodeId: fallbackNodeId,
        errorCode: event.reasonCode ?? "connection_taken_over"
      };
    case "account_disabled":
      return {
        code: "account_disabled",
        tone: "danger",
        title: "账号已禁用",
        message: message ?? "当前账号已被停用，连接已停止。如有疑问请联系客服。",
        actionLabel: "返回并刷新",
        recommendedNodeId: fallbackNodeId,
        errorCode: event.reasonCode ?? "account_disabled"
      };
    case "team_access_revoked":
      return {
        code: "team_access_revoked",
        tone: "danger",
        title: "团队访问权限已失效",
        message: message ?? "你已失去当前团队的访问权限，请联系团队负责人处理。",
        actionLabel: "返回并刷新",
        recommendedNodeId: fallbackNodeId,
        errorCode: event.reasonCode ?? "team_access_revoked"
      };
    case "runtime_credentials_rotated":
      return {
        code: "client_rotated",
        tone: "warning",
        title: "连接信息已更新",
        message: message ?? "你的连接信息已更新，请重新连接。",
        actionLabel: "重新连接",
        recommendedNodeId: fallbackNodeId,
        errorCode: event.reasonCode ?? "runtime_credentials_rotated"
      };
    case "session_expired":
      return {
        code: "session_expired",
        tone: "warning",
        title: "连接已过期",
        message: message ?? "当前连接已过期，请重新连接。",
        actionLabel: "重新连接",
        recommendedNodeId: fallbackNodeId,
        errorCode: event.reasonCode ?? "session_expired"
      };
    case "session_invalid":
    case "auth_invalid":
      return {
        code: "session_invalid",
        tone: "warning",
        title: "连接已失效",
        message: message ?? "当前连接已失效，请重新连接。",
        actionLabel: "重新连接",
        recommendedNodeId: fallbackNodeId,
        errorCode: event.reasonCode ?? "session_invalid"
      };
    default:
      return null;
  }
}

export function clearResolvedGuidance(
  current: ConnectionGuidance | null,
  subscription: SubscriptionStatusDto,
  nodes: NodeSummaryDto[]
) {
  if (!current) {
    return current;
  }
  if (
    current.code === "subscription_expired" &&
    subscription.state !== "expired" &&
    subscription.remainingTrafficGb > 0
  ) {
    return null;
  }
  if (
    current.code === "subscription_exhausted" &&
    subscription.state !== "exhausted" &&
    subscription.remainingTrafficGb > 0
  ) {
    return null;
  }
  if (current.code === "subscription_paused" && subscription.state !== "paused") {
    return null;
  }
  if (current.code === "account_disabled" && subscription.stateReasonCode !== "account_disabled") {
    return null;
  }
  if (current.code === "team_access_revoked" && subscription.stateReasonCode !== "team_access_revoked") {
    return null;
  }
  if ((current.code === "node_access_revoked" || current.code === "node_unavailable") && current.recommendedNodeId) {
    return nodes.some((node) => node.id === current.recommendedNodeId) ? current : null;
  }
  return current;
}

export function pickAlternativeNode(
  nodes: NodeSummaryDto[],
  currentNodeId: string | null,
  probeResults: Record<string, RuntimeNodeProbeResult>
) {
  const healthyAlternative =
    nodes.find((node) => node.id !== currentNodeId && probeResults[node.id]?.status === "healthy") ??
    nodes.find((node) => node.id !== currentNodeId);
  return healthyAlternative ?? null;
}

export function deriveGuidanceFromSubscriptionStateReason(
  subscription: SubscriptionStatusDto,
  fallbackNodeId: string | null
) {
  if (!subscription.stateReasonCode && !subscription.stateReasonMessage) {
    return null;
  }

  return (
    deriveGuidanceFromRuntimeEvent(
      {
        type: "subscription_updated",
        occurredAt: subscription.lastSyncedAt,
        reasonCode: subscription.stateReasonCode ?? null,
        reasonMessage: subscription.stateReasonMessage ?? null
      },
      fallbackNodeId
    ) ??
    (subscription.stateReasonMessage
      ? deriveGuidanceFromMessage(subscription.stateReasonMessage, { fallbackNodeId })
      : null)
  );
}

export function shouldAutoHandleRuntimeGuidance(status: RuntimeStatus, sessionId: string | null) {
  if (status.platformTarget !== "android") {
    return false;
  }
  if (!sessionId && !status.activeSessionId) {
    return false;
  }
  return (
    status.status !== "idle" &&
    status.status !== "connecting" &&
    status.status !== "starting" &&
    status.status !== "disconnecting"
  );
}

export function describeForegroundSyncFailure(reason: unknown) {
  const raw = reason instanceof Error ? readError(reason.message) : "应用回到前台后未能同步最新状态，请检查网络后重试。";
  if (
    raw.includes("Failed to fetch") ||
    raw.includes("Load failed") ||
    raw.includes("NetworkError") ||
    raw.includes("fetch")
  ) {
    return "应用回到前台后发现网络已中断，暂时无法同步最新状态。请检查网络后重试。";
  }
  return "应用回到前台后未能同步最新状态，请检查网络后重试。";
}
