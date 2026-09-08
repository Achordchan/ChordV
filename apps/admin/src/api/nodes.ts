import type {
  AdminLeaseRevocationJobDto,
  AdminNodePanelInboundDto,
  AdminNodeRecordDto,
  AdminPanelSyncJobDto,
  AgentCommandDto,
  CreateAgentNodeInputDto,
  CreateAgentNodeResultDto,
  ImportNodeInputDto,
  SwitchNodeControlModeInputDto,
  SwitchNodeControlModeResultDto,
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

// Agent-native onboarding: create a pending_register node + one-time
// registration token. The plaintext token returns exactly once.
export function createAgentNode(input: CreateAgentNodeInputDto) {
  return request<CreateAgentNodeResultDto>("/admin/nodes/agent-native", {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

// Re-mint the registration token for a still-pending node (admin "regenerate
// the install command"). Also returns the plaintext token exactly once.
export function issueNodeRegisterToken(nodeId: string) {
  return request<{ token: string; expiresAt: string }>(`/admin/nodes/${nodeId}/register-token`, {
    method: "POST",
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

export function fetchNodePanelInbounds(input: {
  panelBaseUrl: string;
  panelApiBasePath?: string;
  panelUsername: string;
  panelPassword?: string;
  nodeId?: string;
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

export function switchNodeControlMode(nodeId: string, input: SwitchNodeControlModeInputDto) {
  return request<SwitchNodeControlModeResultDto>(`/admin/nodes/${nodeId}/control-mode`, {
    method: "POST",
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

// R2-B inbound deployment: queue an ENSURE_INBOUND command for the node's
// agent. The response is the QUEUED command (with its targetRevision), not the
// deployment outcome — completion is observed by polling the node record until
// inboundAppliedRevision reaches that revision.
export function deployNodeInbound(nodeId: string, payload: Record<string, unknown>) {
  return request<AgentCommandDto>(`/admin/nodes/${nodeId}/agent-commands`, {
    method: "POST",
    body: JSON.stringify({ type: "ENSURE_INBOUND", payload }),
    timeoutMs: PANEL_SYNC_ACTION_TIMEOUT_MS
  });
}

// The COMPLETE spec of the currently applied deployment (the last applied
// ENSURE_INBOUND job's payload). The node record is a lossy projection of it,
// and the reissue form prefills/preserves from the real thing.
export function fetchNodeInboundSpec(nodeId: string) {
  return request<{ spec: Record<string, unknown> | null }>(`/admin/nodes/${nodeId}/inbound-spec`, {
    timeoutMs: ADMIN_READ_TIMEOUT_MS
  });
}
