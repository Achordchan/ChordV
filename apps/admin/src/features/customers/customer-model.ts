import type { AdminSubscriptionRecordDto, AdminTeamRecordDto, AdminUserRecordDto, AdminTeamSubscriptionSummaryDto, UserSubscriptionSummaryDto } from "@chordv/shared";

export type CustomerRecord = {
  key: string;
  name: string;
  email: string;
  enabled: boolean;
  user?: AdminUserRecordDto;
  team?: AdminTeamRecordDto;
  subscription: AdminSubscriptionRecordDto | null;
  summary: UserSubscriptionSummaryDto | AdminTeamSubscriptionSummaryDto | null;
};

export function personalCustomer(user: AdminUserRecordDto, subscriptions: Map<string, AdminSubscriptionRecordDto>, byUser: Map<string, AdminSubscriptionRecordDto>): CustomerRecord {
  const subscription = (user.currentSubscription ? subscriptions.get(user.currentSubscription.id) : undefined) ?? byUser.get(user.id) ?? null;
  return { key: `personal:${user.id}`, name: user.displayName || user.email, email: user.email, enabled: user.status === "active", user,
    subscription, summary: subscription ?? user.currentSubscription };
}
export function teamCustomer(team: AdminTeamRecordDto, subscriptions: Map<string, AdminSubscriptionRecordDto>): CustomerRecord {
  const subscription = (team.currentSubscription ? subscriptions.get(team.currentSubscription.id) : undefined) ?? null;
  return { key: `team:${team.id}`, name: team.name, email: team.ownerEmail, enabled: team.status === "active", team,
    subscription, summary: subscription ?? team.currentSubscription };
}

export function customerNotice(customer: CustomerRecord): string | null {
  if (!customer.enabled) return `${customer.team ? "团队" : "账号"}已停用，订阅权益暂不可使用。`;
  const subscription = customer.subscription ?? customer.summary;
  if (!subscription) return "尚未开通订阅，开通后请分配节点授权。";
  if (subscription.stateReasonMessage) return subscription.stateReasonMessage;
  if (subscription.state === "paused") return "订阅已暂停，请查看订阅状态与调整记录。";
  if (subscription.state === "expired") return "订阅已到期，请续期后继续使用。";
  if (subscription.state === "exhausted") return "可用流量已耗尽，请调整额度或变更套餐。";
  const remaining = Date.parse(subscription.expireAt) - Date.now();
  if (Number.isFinite(remaining) && remaining >= 0 && remaining <= 7 * 86400000) {
    const days = Math.ceil(remaining / 86400000);
    return `订阅即将到期，还剩 ${days} 天。`;
  }
  if (customer.subscription && !customer.subscription.hasNodeAccess) return "尚未分配节点，当前订阅无法连接。";
  return null;
}
