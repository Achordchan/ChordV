import type {
  AdminSubscriptionLinkStateDto,
  SubscriptionLinkPublicationStatusDto,
  SubscriptionLinkSettingsDto,
  UpdateSubscriptionLinkSettingsDto
} from "@chordv/shared";
import { request } from "./base";

const userLinkPath = (userId: string) => `/admin/users/${encodeURIComponent(userId)}/subscription-link`;

export function fetchSubscriptionLink(userId: string) {
  return request<AdminSubscriptionLinkStateDto>(userLinkPath(userId));
}

export function issueSubscriptionLink(userId: string) {
  return request<AdminSubscriptionLinkStateDto>(userLinkPath(userId), { method: "POST" });
}

export function resetSubscriptionLink(userId: string) {
  return request<AdminSubscriptionLinkStateDto>(`${userLinkPath(userId)}/reset`, { method: "POST" });
}

export function fetchSubscriptionLinkSettings() {
  return request<SubscriptionLinkSettingsDto>("/admin/subscription-link-settings");
}

export function saveSubscriptionLinkSettings(input: UpdateSubscriptionLinkSettingsDto) {
  return request<SubscriptionLinkSettingsDto>("/admin/subscription-link-settings", { method: "PUT", body: JSON.stringify(input) });
}

export function fetchSubscriptionLinkDistribution() {
  return request<SubscriptionLinkPublicationStatusDto>("/admin/subscription-link-settings/distribution");
}
