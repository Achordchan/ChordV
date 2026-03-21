import type { AdminPlanRecordDto, CreatePlanInputDto, UpdatePlanInputDto, UpdatePlanSecurityInputDto } from "@chordv/shared";
import { request } from "./base";

export function createPlan(input: CreatePlanInputDto) {
  return request<AdminPlanRecordDto>("/admin/plans", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updatePlan(planId: string, input: UpdatePlanInputDto) {
  return request<AdminPlanRecordDto>(`/admin/plans/${planId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function updatePlanSecurity(planId: string, input: UpdatePlanSecurityInputDto) {
  return request<AdminPlanRecordDto>(`/admin/plans/${planId}/security`, {
    method: "PUT",
    body: JSON.stringify(input)
  });
}
