import type {
  AdminLeaseRevocationJobDto,
  AdminNodeRecordDto,
  AgentCommandDto,
  CreateAgentNodeInputDto,
  CreateAgentNodeResultDto,
  UpdateNodeInputDto
} from "@chordv/shared";
import { request } from "./base";

const ADMIN_ACTION_TIMEOUT_MS = 60 * 1000;
const ADMIN_READ_TIMEOUT_MS = 60 * 1000;

export function fetchAdminNodes() {
  return request<AdminNodeRecordDto[]>("/admin/nodes", {
    timeoutMs: ADMIN_READ_TIMEOUT_MS
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
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

export function retryAdminLeaseRevocationJobsForNode(nodeId: string) {
  return request<AdminLeaseRevocationJobDto[]>(`/admin/nodes/${nodeId}/lease-revocation-jobs/retry`, {
    method: "POST",
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

// Agent-native onboarding: create a pending_register node + one-time
// registration token. The plaintext token returns exactly once.
export function createAgentNode(input: CreateAgentNodeInputDto) {
  return request<CreateAgentNodeResultDto>("/admin/nodes/agent-native", {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

// Re-mint the registration token for a still-pending node (admin "regenerate
// the install command"). Also returns the plaintext token exactly once.
export function issueNodeRegisterToken(nodeId: string) {
  return request<{ token: string; expiresAt: string }>(`/admin/nodes/${nodeId}/register-token`, {
    method: "POST",
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

export function updateNode(nodeId: string, input: UpdateNodeInputDto) {
  return request<AdminNodeRecordDto>(`/admin/nodes/${nodeId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

export function probeNode(nodeId: string) {
  return request<AdminNodeRecordDto>(`/admin/nodes/${nodeId}/probe`, {
    method: "POST",
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

export function probeAllNodes() {
  return request<AdminNodeRecordDto[]>("/admin/nodes/probe-all", {
    method: "POST",
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

export function deleteNode(nodeId: string) {
  return request<{ ok: boolean }>(`/admin/nodes/${nodeId}`, {
    method: "DELETE",
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

// R2-B inbound deployment: queue an ENSURE_INBOUND command for the node's
// agent. The response is the QUEUED command (with its targetRevision), not the
// deployment outcome — completion is observed by polling the node record until
// inboundAppliedRevision reaches that revision.
export function deployNodeInbound(nodeId: string, payload: Record<string, unknown>, expectedAppliedRevision: string) {
  return request<AgentCommandDto>(`/admin/nodes/${nodeId}/agent-commands`, {
    method: "POST",
    // expectedInboundAppliedRevision is the compare-and-swap guard: the server
    // rejects the enqueue when the node's applied revision moved past what
    // this form was built from (another administrator deployed meanwhile).
    body: JSON.stringify({ type: "ENSURE_INBOUND", payload, expectedInboundAppliedRevision: expectedAppliedRevision }),
    timeoutMs: ADMIN_ACTION_TIMEOUT_MS
  });
}

// The terminal outcome of one queued command: the deploy poll needs THIS
// command's status — a higher applied revision alone can belong to a later
// deployment while this one failed.
export function fetchNodeCommandOutcome(nodeId: string, commandId: string) {
  return request<{ status: string; lastError: string | null } | null>(`/admin/nodes/${nodeId}/agent-commands/${commandId}/outcome`, {
    timeoutMs: ADMIN_READ_TIMEOUT_MS
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
