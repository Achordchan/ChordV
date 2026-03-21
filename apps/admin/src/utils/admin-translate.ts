import type {
  AdminNodeRecordDto,
  AdminSubscriptionRecordDto,
  AnnouncementDisplayMode,
  AnnouncementLevel,
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

export function translateGatewayStatus(status: AdminNodeRecordDto["gatewayStatus"]) {
  if (status === "online") return "已就绪";
  if (status === "degraded") return "异常";
  return "未启动";
}

export function nodeGatewayColor(status: AdminNodeRecordDto["gatewayStatus"]) {
  if (status === "online") return "green";
  if (status === "degraded") return "yellow";
  return "red";
}

export function translatePanelStatus(status: AdminNodeRecordDto["panelStatus"]) {
  if (status === "online") return "在线";
  if (status === "degraded") return "异常";
  return "未配置";
}

export function nodePanelColor(status: AdminNodeRecordDto["panelStatus"]) {
  if (status === "online") return "green";
  if (status === "degraded") return "yellow";
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
