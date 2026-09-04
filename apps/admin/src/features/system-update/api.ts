import type {
  SystemUpdateCheckDto,
  SystemUpdateOperationDto,
  SystemUpdateRollbackVersionDto,
  SystemUpdateStartResultDto
} from "@chordv/shared";
import { request } from "../../api/base";

export interface SystemRuntimeStatusDto {
  currentVersion: string;
  enabled: boolean;
  manifestConfigured: boolean;
}

export function fetchSystemVersion() {
  return request<SystemRuntimeStatusDto>("/admin/system/version");
}

export function checkSystemUpdate(force = false) {
  const query = force ? "?force=true" : "";
  return request<SystemUpdateCheckDto>(`/admin/system/check-update${query}`);
}

export async function fetchRollbackVersions() {
  const result = await request<{ versions: SystemUpdateRollbackVersionDto[] }>("/admin/system/rollback-versions");
  return result.versions;
}

export async function fetchSystemOperations(limit = 20) {
  const result = await request<{ operations: SystemUpdateOperationDto[] }>(
    `/admin/system/operations?limit=${encodeURIComponent(String(limit))}`
  );
  return result.operations;
}

export async function fetchSystemOperation(operationId: string) {
  const result = await request<{ operation: SystemUpdateOperationDto | null }>(
    `/admin/system/update-status?operationId=${encodeURIComponent(operationId)}`
  );
  return result.operation;
}

export function startSystemUpdate() {
  return request<SystemUpdateStartResultDto>("/admin/system/update", { method: "POST", body: "{}" });
}

export function startSystemRollback(version?: string) {
  return request<SystemUpdateStartResultDto>("/admin/system/rollback", {
    method: "POST",
    body: JSON.stringify(version ? { version } : {})
  });
}

export function startSystemRestart() {
  return request<SystemUpdateStartResultDto>("/admin/system/restart", { method: "POST", body: "{}" });
}
