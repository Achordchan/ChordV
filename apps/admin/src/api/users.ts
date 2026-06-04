import type { AdminUserRecordDto, CreateUserInputDto, UpdateUserInputDto, UpdateUserSecurityInputDto } from "@chordv/shared";
import { request } from "./base";

const PANEL_SYNC_ACTION_TIMEOUT_MS = 60 * 1000;

export function fetchAdminUsers() {
  return request<AdminUserRecordDto[]>("/admin/users");
}

export function createUser(input: CreateUserInputDto) {
  return request<AdminUserRecordDto>("/admin/users", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateUser(userId: string, input: UpdateUserInputDto) {
  return request<AdminUserRecordDto>(`/admin/users/${userId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function updateUserSecurity(userId: string, input: UpdateUserSecurityInputDto) {
  return request<AdminUserRecordDto>(`/admin/users/${userId}/security`, {
    method: "PUT",
    body: JSON.stringify(input),
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}
