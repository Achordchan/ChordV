import type {
  AdminLeaseRevocationJobDto,
  AdminNodePanelInboundDto,
  AdminNodeRecordDto,
  AdminPanelSyncJobDto,
  ImportNodeInputDto,
  UpdateNodeInputDto
} from "@chordv/shared";
import { request } from "./base";

const PANEL_SYNC_ACTION_TIMEOUT_MS = 60 * 1000;
const ADMIN_READ_TIMEOUT_MS = 60 * 1000;

export function fetchAdminNodes() {
  return request<AdminNodeRecordDto[]>("/admin/nodes", {
    timeoutMs: ADMIN_READ_TIMEOUT_MS
  });
}

export function fetchAdminPanelSyncJobs() {
  return request<AdminPanelSyncJobDto[]>("/admin/nodes/panel-sync-jobs", {
    timeoutMs: ADMIN_READ_TIMEOUT_MS
  });
}

export function retryAdminPanelSyncJob(jobId: string) {
  return request<AdminPanelSyncJobDto[]>(`/admin/nodes/panel-sync-jobs/${jobId}/retry`, {
    method: "POST",
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function retryAdminPanelSyncJobsForNode(nodeId: string) {
  return request<AdminPanelSyncJobDto[]>(`/admin/nodes/${nodeId}/panel-sync-jobs/retry`, {
    method: "POST",
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function fetchAdminLeaseRevocationJobs() {
  return request<AdminLeaseRevocationJobDto[]>("/admin/nodes/lease-revocation-jobs", {
    timeoutMs: ADMIN_READ_TIMEOUT_MS
  });
}

export function retryAdminLeaseRevocationJob(jobId: string) {
  return request<AdminLeaseRevocationJobDto[]>(`/admin/nodes/lease-revocation-jobs/${jobId}/retry`, {
    method: "POST",
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function retryAdminLeaseRevocationJobsForNode(nodeId: string) {
  return request<AdminLeaseRevocationJobDto[]>(`/admin/nodes/${nodeId}/lease-revocation-jobs/retry`, {
    method: "POST",
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function importNode(input: ImportNodeInputDto) {
  return request<AdminNodeRecordDto>("/admin/nodes/import", {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function fetchNodePanelInbounds(input: {
  panelBaseUrl: string;
  panelApiBasePath?: string;
  panelUsername: string;
  panelPassword: string;
}) {
  return request<AdminNodePanelInboundDto[]>("/admin/nodes/panel-inbounds", {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function updateNode(nodeId: string, input: UpdateNodeInputDto) {
  return request<AdminNodeRecordDto>(`/admin/nodes/${nodeId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function refreshNode(nodeId: string) {
  return request<AdminNodeRecordDto>(`/admin/nodes/${nodeId}/refresh`, {
    method: "POST",
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function probeNode(nodeId: string) {
  return request<AdminNodeRecordDto>(`/admin/nodes/${nodeId}/probe`, {
    method: "POST",
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function probeAllNodes() {
  return request<AdminNodeRecordDto[]>("/admin/nodes/probe-all", {
    method: "POST",
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function deleteNode(nodeId: string) {
  return request<{ ok: boolean }>(`/admin/nodes/${nodeId}`, {
    method: "DELETE",
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}
