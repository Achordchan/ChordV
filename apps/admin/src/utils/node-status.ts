import type { AdminNodeRecordDto } from "@chordv/shared";
import { agentStatusColor, nodeProbeColor, translateAgentStatus, translateProbeStatus } from "./admin-translate";

export type CompactNodeStatus = { color: string; label: string };

/**
 * Overview badge for a node. The control connection is what can actually act
 * on the node, so an offline or degraded agent must never be hidden behind a
 * healthy TCP probe — the overview's abnormal-node count already treats that
 * combination as abnormal. Whichever signal is unhealthy wins; when both are
 * healthy the agent status is the more specific one.
 */
export function compactNodeStatus(item: AdminNodeRecordDto): CompactNodeStatus {
  if (item.isActive === false) {
    return { color: "gray", label: "已禁用" };
  }

  const agentStatus = item.controlStatus ?? item.agent?.status;
  if (agentStatus !== "online" && agentStatus !== "active") {
    return { color: agentStatusColor(agentStatus), label: `Agent ${translateAgentStatus(agentStatus)}` };
  }

  if (item.probeStatus !== "healthy") {
    return { color: nodeProbeColor(item.probeStatus), label: translateProbeStatus(item.probeStatus) };
  }

  return { color: agentStatusColor(agentStatus), label: `Agent ${translateAgentStatus(agentStatus)}` };
}
