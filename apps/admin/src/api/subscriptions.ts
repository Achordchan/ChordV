import type {
  AdminSubscriptionRecordDto,
  ChangeSubscriptionPlanInputDto,
  ConvertSubscriptionToTeamInputDto,
  ConvertSubscriptionToTeamResultDto,
  CreateSubscriptionInputDto,
  ResetSubscriptionTrafficResultDto,
  RenewSubscriptionInputDto,
  SubscriptionNodeAccessDto,
  UpdateSubscriptionInputDto,
  UpdateSubscriptionNodeAccessInputDto
} from "@chordv/shared";
import { request } from "./base";

const PANEL_SYNC_ACTION_TIMEOUT_MS = 60 * 1000;

export function fetchAdminSubscriptions() {
  return request<AdminSubscriptionRecordDto[]>("/admin/subscriptions");
}

export function createSubscription(input: CreateSubscriptionInputDto) {
  return request<AdminSubscriptionRecordDto>("/admin/subscriptions", {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function renewSubscription(subscriptionId: string, input: RenewSubscriptionInputDto) {
  return request<AdminSubscriptionRecordDto>(`/admin/subscriptions/${subscriptionId}/renew`, {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function changeSubscriptionPlan(subscriptionId: string, input: ChangeSubscriptionPlanInputDto) {
  return request<AdminSubscriptionRecordDto>(`/admin/subscriptions/${subscriptionId}/change-plan`, {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function updateSubscription(subscriptionId: string, input: UpdateSubscriptionInputDto) {
  return request<AdminSubscriptionRecordDto>(`/admin/subscriptions/${subscriptionId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function getSubscriptionNodeAccess(subscriptionId: string) {
  return request<SubscriptionNodeAccessDto>(`/admin/subscriptions/${subscriptionId}/nodes`);
}

export function updateSubscriptionNodeAccess(subscriptionId: string, input: UpdateSubscriptionNodeAccessInputDto) {
  return request<SubscriptionNodeAccessDto>(`/admin/subscriptions/${subscriptionId}/nodes`, {
    method: "PUT",
    body: JSON.stringify(input),
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function resetSubscriptionTraffic(subscriptionId: string, userId?: string) {
  return request<ResetSubscriptionTrafficResultDto>(`/admin/subscriptions/${subscriptionId}/reset-traffic`, {
    method: "POST",
    body: JSON.stringify(userId ? { userId } : {}),
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function convertPersonalSubscriptionToTeam(subscriptionId: string, input: ConvertSubscriptionToTeamInputDto) {
  return request<ConvertSubscriptionToTeamResultDto>(`/admin/subscriptions/${subscriptionId}/convert-to-team`, {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}
