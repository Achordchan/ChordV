import type { AdminPolicyRecordDto, AdminSnapshotDto, UpdatePolicyInputDto } from "@chordv/shared";
import { request } from "./base";

export function getAdminSnapshot() {
  return request<AdminSnapshotDto>("/admin/snapshot");
}

export function updatePolicy(input: UpdatePolicyInputDto) {
  return request<AdminPolicyRecordDto>("/admin/policies", {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}
