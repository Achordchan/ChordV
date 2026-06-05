import type { AdminPlanRecordDto, CreatePlanInputDto, UpdatePlanInputDto, UpdatePlanSecurityInputDto } from "@chordv/shared";
import { request } from "./base";

const ADMIN_ACTION_TIMEOUT_MS = 60 * 1000;
const ADMIN_READ_TIMEOUT_MS = 60 * 1000;

export function fetchAdminPlans() {
  return request<AdminPlanRecordDto[]>("/admin/plans", {
    timeoutMs: ADMIN_READ_TIMEOUT_MS
  });
}

export function createPlan(input: CreatePlanInputDto) {
  return request<AdminPlanRecordDto>("/admin/plans", {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

export function updatePlan(planId: string, input: UpdatePlanInputDto) {
  return request<AdminPlanRecordDto>(`/admin/plans/${planId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

export function updatePlanSecurity(planId: string, input: UpdatePlanSecurityInputDto) {
  return request<AdminPlanRecordDto>(`/admin/plans/${planId}/security`, {
    method: "PUT",
    body: JSON.stringify(input),
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}
