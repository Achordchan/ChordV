import type {
  AccessMode,
  AdminPolicyRecordDto,
  AdminSnapshotDto,
  AnnouncementDisplayMode,
  AnnouncementLevel,
  ConnectionMode,
  PlanScope,
  SubscriptionState,
  TeamMemberRole,
  TeamStatus,
  UserRole,
  UserStatus
} from "@chordv/shared";
import { addDays, toDateTimeLocal } from "./admin-format";

export type UserFormState = {
  email: string;
  password: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
};

export type PlanFormState = {
  name: string;
  scope: PlanScope;
  totalTrafficGb: number;
  renewable: boolean;
  isActive: boolean;
};

export type SubscriptionCreateFormState = {
  userId: string;
  planId: string;
  totalTrafficGb: number;
  usedTrafficGb: number;
  expireAt: string;
  state: SubscriptionState;
};

export type SubscriptionAdjustFormState = {
  totalTrafficGb: number;
  usedTrafficGb: number;
  expireAt: string;
  baseExpireAt: string;
  state: SubscriptionState;
};

export type SubscriptionRenewFormState = {
  expireAt: string;
  baseExpireAt: string;
  resetTraffic: boolean;
  totalTrafficGb: number | "";
};

export type SubscriptionChangePlanFormState = {
  scope: PlanScope;
  planId: string;
  totalTrafficGb: number;
  expireAt: string;
  baseExpireAt: string;
};

export type TeamFormState = {
  name: string;
  ownerUserId: string;
  status: TeamStatus;
};

export type TeamMemberFormState = {
  userId: string;
  role: TeamMemberRole;
};

export type TeamSubscriptionFormState = {
  planId: string;
  totalTrafficGb: number;
  expireAt: string;
};

export type NodeFormState = {
  subscriptionUrl: string;
  name: string;
  region: string;
  provider: string;
  tags: string;
  recommended: boolean;
  panelBaseUrl: string;
  panelApiBasePath: string;
  panelUsername: string;
  panelPassword: string;
  panelInboundId: number;
  panelEnabled: boolean;
};

export type AnnouncementFormState = {
  title: string;
  body: string;
  level: AnnouncementLevel;
  publishedAt: string;
  isActive: boolean;
  displayMode: AnnouncementDisplayMode;
  countdownSeconds: number;
};

export type PolicyFormState = {
  accessMode: AccessMode;
  defaultMode: ConnectionMode;
  modes: ConnectionMode[];
  blockAds: boolean;
  chinaDirect: boolean;
  aiServicesProxy: boolean;
};

export const modeOptions = [
  { value: "rule", label: "规则模式" },
  { value: "global", label: "全局代理" },
  { value: "direct", label: "直连模式" }
];

export const expireUnitOptions = [
  { value: "day", label: "日" },
  { value: "month", label: "月" },
  { value: "year", label: "年" }
];

export const subscriptionStateOptions = [
  { value: "active", label: "有效" },
  { value: "paused", label: "暂停" },
  { value: "expired", label: "到期" },
  { value: "exhausted", label: "流量耗尽" }
];

export const announcementLevelOptions = [
  { value: "info", label: "通知" },
  { value: "warning", label: "提醒" },
  { value: "success", label: "成功" }
];

export const displayModeOptions = [
  { value: "passive", label: "普通公告" },
  { value: "modal_confirm", label: "确认弹窗" },
  { value: "modal_countdown", label: "倒计时确认" }
];

export function emptyUserForm(): UserFormState {
  return {
    email: "",
    password: "",
    displayName: "",
    role: "user",
    status: "active"
  };
}

export function emptyPlanForm(): PlanFormState {
  return {
    name: "",
    scope: "personal",
    totalTrafficGb: 100,
    renewable: true,
    isActive: true
  };
}

export function emptySubscriptionCreateForm(snapshot?: AdminSnapshotDto | null): SubscriptionCreateFormState {
  const plan = snapshot?.plans.find((item) => item.isActive && item.scope === "personal") ?? snapshot?.plans.find((item) => item.scope === "personal");
  return {
    userId: snapshot?.users.find((item) => item.role === "user" && item.accountType === "personal" && item.currentSubscription === null)?.id ?? "",
    planId: plan?.id ?? "",
    totalTrafficGb: plan?.totalTrafficGb ?? 100,
    usedTrafficGb: 0,
    expireAt: toDateTimeLocal(addDays(new Date(), 30).toISOString()),
    state: "active"
  };
}

export function emptySubscriptionAdjustForm(): SubscriptionAdjustFormState {
  const now = toDateTimeLocal(new Date().toISOString());
  return {
    totalTrafficGb: 100,
    usedTrafficGb: 0,
    expireAt: now,
    baseExpireAt: now,
    state: "active"
  };
}

export function emptySubscriptionRenewForm(): SubscriptionRenewFormState {
  const next = toDateTimeLocal(addDays(new Date(), 30).toISOString());
  return {
    expireAt: next,
    baseExpireAt: next,
    resetTraffic: false,
    totalTrafficGb: ""
  };
}

export function emptySubscriptionChangePlanForm(): SubscriptionChangePlanFormState {
  return {
    scope: "personal",
    planId: "",
    totalTrafficGb: 100,
    expireAt: "",
    baseExpireAt: toDateTimeLocal(new Date().toISOString())
  };
}

export function emptyTeamForm(snapshot?: AdminSnapshotDto | null): TeamFormState {
  return {
    name: "",
    ownerUserId: snapshot?.users.find((item) => item.role === "user" && item.accountType === "personal" && item.currentSubscription === null)?.id ?? "",
    status: "active"
  };
}

export function emptyTeamMemberForm(): TeamMemberFormState {
  return {
    userId: "",
    role: "member"
  };
}

export function emptyTeamSubscriptionForm(): TeamSubscriptionFormState {
  return {
    planId: "",
    totalTrafficGb: 100,
    expireAt: toDateTimeLocal(addDays(new Date(), 30).toISOString())
  };
}

export function emptyNodeForm(): NodeFormState {
  return {
    subscriptionUrl: "",
    name: "",
    region: "",
    provider: "自有节点",
    tags: "",
    recommended: true,
    panelBaseUrl: "",
    panelApiBasePath: "/",
    panelUsername: "",
    panelPassword: "",
    panelInboundId: 1,
    panelEnabled: false
  };
}

export function emptyAnnouncementForm(): AnnouncementFormState {
  return {
    title: "",
    body: "",
    level: "info",
    publishedAt: toDateTimeLocal(new Date().toISOString()),
    isActive: true,
    displayMode: "passive",
    countdownSeconds: 0
  };
}

export function toPolicyForm(policy: AdminPolicyRecordDto): PolicyFormState {
  return {
    accessMode: policy.accessMode,
    defaultMode: policy.defaultMode,
    modes: policy.modes,
    blockAds: policy.features.blockAds,
    chinaDirect: policy.features.chinaDirect,
    aiServicesProxy: policy.features.aiServicesProxy
  };
}

type PlanCarrier = Pick<AdminSnapshotDto, "plans">;

export function applyPlanToCreateForm(snapshot: PlanCarrier, current: SubscriptionCreateFormState, planId: string): SubscriptionCreateFormState {
  const plan = snapshot.plans.find((item) => item.id === planId && item.scope === "personal");
  if (!plan) return { ...current, planId };
  return {
    ...current,
    planId,
    totalTrafficGb: plan.totalTrafficGb
  };
}

export function applyPlanToChangePlanForm(
  snapshot: PlanCarrier,
  current: SubscriptionChangePlanFormState,
  planId: string
): SubscriptionChangePlanFormState {
  const plan = snapshot.plans.find((item) => item.id === planId);
  if (!plan) return { ...current, planId };
  return {
    ...current,
    scope: plan.scope,
    planId,
    totalTrafficGb: plan.totalTrafficGb
  };
}

export function applyPlanToTeamSubscriptionForm(
  snapshot: PlanCarrier,
  current: TeamSubscriptionFormState,
  planId: string
): TeamSubscriptionFormState {
  const plan = snapshot.plans.find((item) => item.id === planId && item.scope === "team");
  if (!plan) return { ...current, planId };
  return {
    ...current,
    planId,
    totalTrafficGb: plan.totalTrafficGb
  };
}
