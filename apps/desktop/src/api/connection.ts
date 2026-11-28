import type { ClientNodeProbeResultDto, ClientRoutingRuleDto, ClientRoutingRuleTestResultDto, ConnectionMode, CreateClientRoutingRuleInputDto, GeneratedRuntimeConfigDto, NodeSummaryDto, SessionLeaseStatusDto, UpdateClientRoutingRuleInputDto } from "@chordv/shared";
import { request } from "./http";
import { loadCommandInvoke } from "./native-commands";

export function fetchNodes(accessToken: string) {
  return request<NodeSummaryDto[]>("/client/nodes", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

export function reportNodeProbes(accessToken: string, results: ClientNodeProbeResultDto[]) {
  return request<{ ok: boolean }>("/client/nodes/probe-results", {
    method: "POST", headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ results: results.map(({ nodeId, status, latencyMs }) => ({ nodeId, status, latencyMs })) })
  });
}

export function fetchClientRuntime(accessToken: string, sessionId?: string | null) {
  const params = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  return request<GeneratedRuntimeConfigDto | null>(`/client/runtime${params}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

export function connectSession(input: {
  accessToken: string;
  nodeId: string;
  mode: ConnectionMode;
  strategyGroupId?: string;
}) {
  return request<GeneratedRuntimeConfigDto>("/client/session/connect", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`
    },
    body: JSON.stringify({
      nodeId: input.nodeId,
      mode: input.mode,
      strategyGroupId: input.strategyGroupId
    })
  });
}

export function fetchRoutingRules(accessToken: string) {
  return request<ClientRoutingRuleDto[]>("/client/routing-rules", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

export function createRoutingRule(accessToken: string, input: CreateClientRoutingRuleInputDto) {
  return request<ClientRoutingRuleDto>("/client/routing-rules", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(input)
  });
}

export function updateRoutingRule(
  accessToken: string,
  ruleId: string,
  input: UpdateClientRoutingRuleInputDto
) {
  return request<ClientRoutingRuleDto>(`/client/routing-rules/${encodeURIComponent(ruleId)}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(input)
  });
}

export function deleteRoutingRule(accessToken: string, ruleId: string) {
  return request<{ ok: true; deletedId: string }>(`/client/routing-rules/${encodeURIComponent(ruleId)}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

export async function testRoutingRule(input: {
  value: string;
  mode: ConnectionMode;
  features: GeneratedRuntimeConfigDto["features"];
  customRoutingRules: ClientRoutingRuleDto[];
}) {
  const invoke = await loadCommandInvoke();
  if (!invoke) {
    throw new Error("当前环境不支持本地 GEO 查询。");
  }
  return invoke<ClientRoutingRuleTestResultDto>("test_routing_rule", { input });
}

export function disconnectSession(accessToken: string, sessionId: string) {
  return request<{ ok: boolean; previousSessionId: string | null }>("/client/session/disconnect", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ sessionId })
  });
}

export function heartbeatSession(accessToken: string, sessionId: string) {
  return request<SessionLeaseStatusDto>("/client/session/heartbeat", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ sessionId })
  });
}
