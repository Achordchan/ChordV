import type {
  AdminNodeRecordDto,
  AdminSubscriptionRecordDto,
  AnnouncementDisplayMode,
  AnnouncementLevel,
  NodeAgentCommandType,
  NodeAgentJobStatus,
  SubscriptionState,
  UserRole,
  UserStatus
} from "@chordv/shared";

export function translateRole(role: UserRole) {
  return role === "admin" ? "管理员" : "用户";
}

export function translateUserStatus(status: UserStatus) {
  return status === "active" ? "启用" : "禁用";
}

export function translateSubscriptionState(state: SubscriptionState) {
  if (state === "active") return "有效";
  if (state === "paused") return "暂停";
  if (state === "expired") return "到期";
  return "流量耗尽";
}

export function translateSourceAction(action: AdminSubscriptionRecordDto["sourceAction"]) {
  if (action === "created") return "新建";
  if (action === "renewed") return "续期";
  if (action === "plan_changed") return "变更套餐";
  return "校正";
}

export function translateRenewableState(renewable: boolean) {
  return renewable ? "支持续期" : "不支持续期";
}

export function getRenewActionText(renewable: boolean) {
  return renewable ? "续期" : "套餐不支持续期";
}

export function getRenewActionDescription(renewable: boolean) {
  return renewable ? "可在订阅页直接续期" : "该套餐已关闭订阅续期入口";
}

export function subscriptionStateColor(state: SubscriptionState) {
  if (state === "active") return "green";
  if (state === "paused") return "yellow";
  return "red";
}

export function translateProbeStatus(status: AdminNodeRecordDto["probeStatus"]) {
  if (status === "healthy") return "正常";
  if (status === "degraded") return "降级";
  if (status === "offline") return "离线";
  return "未检测";
}

export function nodeProbeColor(status: AdminNodeRecordDto["probeStatus"]) {
  if (status === "healthy") return "green";
  if (status === "degraded") return "yellow";
  if (status === "offline") return "red";
  return "gray";
}

export function translateAgentStatus(status?: string | null) {
  if (status === "online" || status === "active") return "在线";
  if (status === "degraded") return "异常";
  if (status === "offline") return "离线";
  return "等待心跳";
}

export function agentStatusColor(status?: string | null) {
  if (status === "online" || status === "active") return "green";
  if (status === "degraded") return "yellow";
  if (status === "offline") return "red";
  return "gray";
}

export function translateXrayStatus(status?: string | null) {
  if (status === "healthy") return "正常";
  if (status === "degraded") return "异常";
  if (status === "offline") return "离线";
  return "未知";
}

export function xrayStatusColor(status?: string | null) {
  if (status === "healthy") return "green";
  if (status === "degraded") return "yellow";
  if (status === "offline") return "red";
  return "gray";
}

export function translateAnnouncementLevel(level: AnnouncementLevel) {
  if (level === "info") return "通知";
  if (level === "warning") return "提醒";
  return "成功";
}

export function announcementLevelColor(level: AnnouncementLevel) {
  if (level === "info") return "blue";
  if (level === "warning") return "yellow";
  return "green";
}

export function translateDisplayMode(mode: AnnouncementDisplayMode, countdownSeconds: number) {
  if (mode === "modal_confirm") return "确认弹窗";
  if (mode === "modal_countdown") return `倒计时确认 · ${countdownSeconds}s`;
  return "普通公告";
}

export function translateNodeCommandType(commandType: NodeAgentCommandType) {
  if (commandType === "ENSURE_USER") return "下发用户";
  if (commandType === "ENABLE_USER") return "启用用户";
  if (commandType === "DISABLE_USER") return "停用用户";
  if (commandType === "REMOVE_USER") return "删除用户";
  if (commandType === "RECONCILE_USERS") return "对账用户";
  if (commandType === "REFRESH_QUOTA") return "刷新配额";
  return "部署入站";
}

export function translateNodeCommandStatus(status: NodeAgentJobStatus) {
  if (status === "pending") return "待执行";
  if (status === "running") return "执行中";
  if (status === "failed") return "失败";
  // Retry-exhausted: the operation never completed, so it is an unresolved
  // failure (red), not a neutral "cancelled".
  if (status === "cancelled") return "重试耗尽";
  return "已完成";
}

export function nodeCommandStatusColor(status: NodeAgentJobStatus) {
  if (status === "pending") return "yellow";
  if (status === "running") return "blue";
  if (status === "failed") return "red";
  if (status === "cancelled") return "red";
  return "green";
}
