import type { AdminNodeRecordDto } from "@chordv/shared";
import { agentStatusColor, nodeProbeColor, translateAgentStatus, translateProbeStatus, translateXrayStatus } from "./admin-translate";

export type CompactNodeStatus = { color: string; label: string };

// controlStatus describes the core, not the Agent's transport connection.
export const nodeAgentStatus = (item: AdminNodeRecordDto) => item.agent?.status;
export const nodeXrayStatus = (item: AdminNodeRecordDto) => item.agent?.xrayStatus ?? item.controlStatus;

export function nodeAttention(item: AdminNodeRecordDto): 0 | 1 | 2 | 3 {
  if (item.isActive === false) return 3;
  const agent = nodeAgentStatus(item), xray = nodeXrayStatus(item);
  if ([agent,xray,item.probeStatus].some(status => status === "offline" || status === "degraded")) return 0;
  if (!["online","active"].includes(agent ?? "") || xray !== "healthy") return 1;
  return 2;
}

export function compactNodeStatus(item: AdminNodeRecordDto): CompactNodeStatus {
  if (item.isActive === false) {
    return { color: "gray", label: "已禁用" };
  }

  const agentStatus = nodeAgentStatus(item);
  if (agentStatus !== "online" && agentStatus !== "active") {
    return { color: agentStatusColor(agentStatus), label: `Agent ${translateAgentStatus(agentStatus)}` };
  }

  const xray = nodeXrayStatus(item);
  if (xray !== "healthy") {
    return {color:xray === "offline" ? "red" : xray === "degraded" ? "yellow" : "gray",label:`Xray ${translateXrayStatus(xray)}`};
  }

  if (item.probeStatus === "offline" || item.probeStatus === "degraded") {
    return { color: nodeProbeColor(item.probeStatus), label: translateProbeStatus(item.probeStatus) };
  }

  return { color: agentStatusColor(agentStatus), label: `Agent ${translateAgentStatus(agentStatus)}` };
}
