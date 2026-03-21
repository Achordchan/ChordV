import type { AdminUserRecordDto, CreateUserInputDto, UpdateUserInputDto, UpdateUserSecurityInputDto } from "@chordv/shared";
import { request } from "./base";

export function createUser(input: CreateUserInputDto) {
  return request<AdminUserRecordDto>("/admin/users", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateUser(userId: string, input: UpdateUserInputDto) {
  return request<AdminUserRecordDto>(`/admin/users/${userId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function updateUserSecurity(userId: string, input: UpdateUserSecurityInputDto) {
  return request<AdminUserRecordDto>(`/admin/users/${userId}/security`, {
    method: "PUT",
    body: JSON.stringify(input)
  });
}
