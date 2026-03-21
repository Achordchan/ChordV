import type { AdminNodePanelInboundDto, AdminNodeRecordDto, ImportNodeInputDto, UpdateNodeInputDto } from "@chordv/shared";
import { request } from "./base";

export function importNode(input: ImportNodeInputDto) {
  return request<AdminNodeRecordDto>("/admin/nodes/import", {
    method: "POST",
    body: JSON.stringify(input)
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
    body: JSON.stringify(input)
  });
}

export function updateNode(nodeId: string, input: UpdateNodeInputDto) {
  return request<AdminNodeRecordDto>(`/admin/nodes/${nodeId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function refreshNode(nodeId: string) {
  return request<AdminNodeRecordDto>(`/admin/nodes/${nodeId}/refresh`, {
    method: "POST"
  });
}

export function probeNode(nodeId: string) {
  return request<AdminNodeRecordDto>(`/admin/nodes/${nodeId}/probe`, {
    method: "POST"
  });
}

export function probeAllNodes() {
  return request<AdminNodeRecordDto[]>("/admin/nodes/probe-all", {
    method: "POST"
  });
}

export function deleteNode(nodeId: string) {
  return request<{ ok: boolean }>(`/admin/nodes/${nodeId}`, {
    method: "DELETE"
  });
}
