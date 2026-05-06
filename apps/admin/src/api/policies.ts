import type { AdminPolicyRecordDto, AdminSnapshotDto, DashboardSnapshotDto, UpdatePolicyInputDto } from "@chordv/shared";
import { request } from "./base";

export function getAdminSnapshot() {
  return request<AdminSnapshotDto>("/admin/snapshot");
}

export function fetchAdminDashboard() {
  return request<DashboardSnapshotDto>("/admin/dashboard");
}

export function fetchAdminPolicy() {
  return request<AdminPolicyRecordDto>("/admin/policies");
}

export function updatePolicy(input: UpdatePolicyInputDto) {
  return request<AdminPolicyRecordDto>("/admin/policies", {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}
