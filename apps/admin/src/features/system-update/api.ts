import type {
  SystemUpdateCheckDto,
  SystemUpdateOperationDto,
  SystemUpdateRollbackVersionDto,
  SystemUpdateStartResultDto
} from "@chordv/shared";
import { API_BASE, clearStoredAdminSession, getStoredAdminAccessToken, refreshAdminAccessToken, request } from "../../api/base";

export interface SystemRuntimeStatusDto {
  currentVersion: string;
  enabled: boolean;
  manifestConfigured: boolean;
}

async function readStatus<T>(path: string, signal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  // Keep the deadline through body consumption, not merely until headers arrive.
  const timer = setTimeout(() => controller.abort(new Error("状态读取超时")), 20_000);
  try { return await request<T>(path, { signal: controller.signal, cache: "no-store" }); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

export function fetchSystemVersion() {
  return readStatus<SystemRuntimeStatusDto>("/admin/system/version");
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
  const result = await readStatus<{ operations: SystemUpdateOperationDto[] }>(
    `/admin/system/operations?limit=${encodeURIComponent(String(limit))}`
  );
  return result.operations;
}

export async function fetchSystemOperation(operationId: string, signal?: AbortSignal) {
  const result = await readStatus<{ operation: SystemUpdateOperationDto | null }>(
    `/admin/system/update-status?operationId=${encodeURIComponent(operationId)}`, signal
  );
  return result.operation;
}

export async function openSystemOperationStream(operationId: string, signal: AbortSignal) {
  const open = () => fetch(`${API_BASE}/api/admin/system/update-events?operationId=${encodeURIComponent(operationId)}`, {
    headers: { Authorization: `Bearer ${getStoredAdminAccessToken()}` }, credentials: "include", signal
  });
  let response = await open();
  if (response.status === 401) {
    await response.body?.cancel();
    const refreshed = await refreshAdminAccessToken();
    if (signal.aborted) throw signal.reason;
    if (refreshed) response = await open();
    else clearStoredAdminSession({ notify: true });
  }
  return response;
}

export function startSystemUpdate(expectedVersion?: string) {
  return request<SystemUpdateStartResultDto>("/admin/system/update", {
    method: "POST",
    body: JSON.stringify(expectedVersion ? { expectedVersion } : {})
  });
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
