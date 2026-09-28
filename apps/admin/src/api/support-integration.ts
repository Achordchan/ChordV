import type {
  AdminSupportIntegrationConfigDto,
  AdminSupportIntegrationTestResultDto,
  UpdateAdminSupportIntegrationConfigInputDto
} from "@chordv/shared";
import { request } from "./base";

const ADMIN_READ_TIMEOUT_MS = 60 * 1000;
const ADMIN_ACTION_TIMEOUT_MS = 60 * 1000;

export function fetchSupportIntegrationConfig() {
  return request<AdminSupportIntegrationConfigDto>("/admin/support-integration", {
    timeoutMs: ADMIN_READ_TIMEOUT_MS
  });
}

export function updateSupportIntegrationConfig(input: UpdateAdminSupportIntegrationConfigInputDto) {
  return request<AdminSupportIntegrationConfigDto>("/admin/support-integration", {
    method: "PUT",
    body: JSON.stringify(input),
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

export function testSupportIntegration() {
  return request<AdminSupportIntegrationTestResultDto>("/admin/support-integration/test", {
    method: "POST",
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}
