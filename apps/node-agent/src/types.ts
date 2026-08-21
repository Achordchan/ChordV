export const AGENT_COMMAND_TYPES = [
  'ENSURE_USER',
  'ENABLE_USER',
  'DISABLE_USER',
  'REMOVE_USER',
  'RECONCILE_USERS',
  'REFRESH_QUOTA',
] as const;

export type AgentCommandType = (typeof AGENT_COMMAND_TYPES)[number];
export type NodeControlMode = 'xui_primary' | 'shadow_direct' | 'direct_primary' | 'rollback_pending';

export function isNodeControlMode(value: unknown): value is NodeControlMode {
  return value === 'xui_primary' || value === 'shadow_direct' || value === 'direct_primary' || value === 'rollback_pending';
}

export interface DesiredUser {
  bindingId: string;
  revision: string;
  email: string;
  uuid: string;
  flow?: 'xtls-rprx-vision' | '';
  enabled: boolean;
  quotaRemainingBytes: string;
  offlineAllowanceBytes: string;
}

export interface AbsoluteCounter {
  email: string;
  uplinkBytes: string;
  downlinkBytes: string;
}

export interface UsageSample {
  bindingId: string;
  counterGeneration: string;
  uplinkBytes: string;
  downlinkBytes: string;
  uplinkDeltaBytes: string;
  downlinkDeltaBytes: string;
}

export interface UsageBatch {
  bootId: string;
  sequence: string;
  sampledAt: string;
  samples: UsageSample[];
}

export interface AgentCommand {
  commandId: string;
  type: AgentCommandType;
  targetRevision: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CommandResult {
  commandId: string;
  status: 'completed' | 'failed';
  result?: Record<string, unknown>;
  error?: string;
}

export interface AgentConfigSnapshot {
  nodeId: string;
  revision: string;
  controlMode: NodeControlMode;
  users: DesiredUser[];
}

export interface UsageBatchAck {
  accepted: boolean;
  duplicate: boolean;
  ackThrough: string;
}

export interface AgentHeartbeat {
  bootId: string;
  version: string;
  configRevision: string;
  queueDepth: number;
  xrayStatus: 'unknown' | 'healthy' | 'degraded' | 'offline';
}

export interface SampleResult {
  batch: UsageBatch | null;
  disableEmails: string[];
}
