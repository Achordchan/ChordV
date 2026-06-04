import type { AdminPolicyRecordDto, AdminSnapshotDto, DashboardSnapshotDto, UpdatePolicyInputDto } from "@chordv/shared";
import { request } from "./base";

const ADMIN_ACTION_TIMEOUT_MS = 60 * 1000;
const ADMIN_READ_TIMEOUT_MS = 60 * 1000;

export function getAdminSnapshot() {
  return request<AdminSnapshotDto>("/admin/snapshot", {
    timeoutMs: ADMIN_READ_TIMEOUT_MS
  });
}

export function fetchAdminDashboard() {
  return request<DashboardSnapshotDto>("/admin/dashboard", {
    timeoutMs: ADMIN_READ_TIMEOUT_MS
  });
}

export function fetchAdminPolicy() {
  return request<AdminPolicyRecordDto>("/admin/policies", {
    timeoutMs: ADMIN_READ_TIMEOUT_MS
  });
}

export function updatePolicy(input: UpdatePolicyInputDto) {
  return request<AdminPolicyRecordDto>("/admin/policies", {
    method: "PATCH",
    body: JSON.stringify(input),
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}
