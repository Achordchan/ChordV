import * as net from "node:net";
import type { AdminNodeRecordDto, NodeProbeStatus, NodeSummaryDto } from "@chordv/shared";
import { getCountryLabelFromCode, resolveCountryCode } from "@chordv/shared";

export function normalizeOptionalString(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function normalizeTags(tags: string[] | undefined, name: string) {
  if (tags && tags.length > 0) {
    return tags.map((item) => item.trim()).filter(Boolean);
  }

  const lower = name.toLowerCase();
  if (lower.includes("hk") || lower.includes("香港")) return ["香港"];
  if (lower.includes("sg") || lower.includes("新加坡")) return ["新加坡"];
  if (lower.includes("jp") || lower.includes("日本")) return ["日本"];
  if (lower.includes("us") || lower.includes("美国")) return ["美国"];
  return ["导入"];
}

export function inferRegion(name: string, host: string) {
  const value = `${name} ${host}`.toLowerCase();
  if (value.includes("hk") || value.includes("hong kong") || value.includes("香港")) return "香港";
  if (value.includes("sg") || value.includes("singapore") || value.includes("新加坡")) return "新加坡";
  if (value.includes("jp") || value.includes("japan") || value.includes("日本")) return "日本";
  if (value.includes("us") || value.includes("united states") || value.includes("america") || value.includes("美国")) return "美国";
  return "未分组";
}

export function resolveNodeCountry(input: {
  countryCode?: string | null;
  region?: string | null;
  name: string;
  host: string;
}) {
  const countryCode = resolveCountryCode({
    countryCode: input.countryCode,
    region: input.region,
    name: input.name,
    host: input.host
  });
  const region = input.region?.trim() || getCountryLabelFromCode(countryCode) || inferRegion(input.name, input.host);

  return {
    countryCode,
    region: getCountryLabelFromCode(countryCode) ?? region
  };
}

export function toNodeSummary(row: {
  id: string;
  name: string;
  countryCode?: string | null;
  region: string;
  provider: string;
  tags: string[];
  isActive?: boolean;
  recommended: boolean;
  latencyMs: number;
  probeLatencyMs?: number | null;
  protocol: string;
  security: string;
}): NodeSummaryDto {
  return {
    id: row.id,
    name: row.name,
    countryCode: row.countryCode ?? resolveCountryCode({ region: row.region }),
    region: row.region,
    provider: row.provider,
    tags: row.tags,
    isActive: row.isActive ?? true,
    recommended: row.recommended,
    latencyMs: row.probeLatencyMs ?? row.latencyMs,
    protocol: row.protocol as "vless",
    security: row.security as "reality"
  };
}

export function toAdminNodeRecord(row: {
  id: string;
  name: string;
  countryCode?: string | null;
  region: string;
  provider: string;
  tags: string[];
  recommended: boolean;
  latencyMs: number;
  probeLatencyMs: number | null;
  protocol: string;
  security: string;
  serverHost: string;
  serverPort: number;
  serverName: string;
  shortId: string;
  spiderX: string;
  realityPublicKey?: string;
  flow?: string;
  fingerprint?: string;
  inboundAppliedRevision?: bigint | null;
  mldsa65Verify?: string | null;
  statsLastSyncedAt: Date | null;
  controlMode?: "xui_primary" | "shadow_direct" | "direct_primary" | "rollback_pending";
  controlStatus?: string;
  registrationStatus?: "pending_register" | "agent_ready" | null;
  agentLastSeenAt?: Date | null;
  agentConfigRevision?: bigint;
  nodeAgents?: Array<{
    id: string;
    agentId: string;
    nodeId: string;
    tokenPrefix: string;
    version: string | null;
    status: string;
    xrayStatus: string;
    bootId: string | null;
    configRevision: bigint;
    lastSequence: bigint;
    lastAckSequence: bigint;
    queueDepth: number;
    lastSeenAt: Date | null;
    revokedAt: Date | null;
  }>;
  probeStatus: NodeProbeStatus;
  probeCheckedAt: Date | null;
  probeError: string | null;
  createdAt: Date;
  updatedAt: Date;
}): AdminNodeRecordDto {
  const agent = row.nodeAgents?.[0] ?? null;
  return {
    ...toNodeSummary(row),
    statsLastSyncedAt: row.statsLastSyncedAt?.toISOString() ?? null,
    controlMode: row.controlMode ?? "direct_primary",
    controlStatus: row.controlStatus ?? "unknown",
    registrationStatus: row.registrationStatus ?? null,
    agentLastSeenAt: row.agentLastSeenAt?.toISOString() ?? null,
    agentConfigRevision: row.agentConfigRevision?.toString() ?? "0",
    agent: agent ? {
      id: agent.id,
      agentId: agent.agentId,
      nodeId: agent.nodeId,
      tokenPrefix: agent.tokenPrefix,
      version: agent.version,
      status: agent.status,
      xrayStatus: agent.xrayStatus,
      bootId: agent.bootId,
      configRevision: agent.configRevision.toString(),
      lastSequence: agent.lastSequence.toString(),
      lastAckSequence: agent.lastAckSequence.toString(),
      queueDepth: agent.queueDepth,
      lastSeenAt: agent.lastSeenAt?.toISOString() ?? null,
      revokedAt: agent.revokedAt?.toISOString() ?? null
    } : null,
    serverName: row.serverName,
    serverHost: row.serverHost,
    serverPort: row.serverPort,
    shortId: row.shortId,
    spiderX: row.spiderX,
    realityPublicKey: row.realityPublicKey ?? "",
    flow: row.flow ?? "",
    fingerprint: row.fingerprint ?? "",
    inboundAppliedRevision: row.inboundAppliedRevision != null ? row.inboundAppliedRevision.toString() : "0",
    mldsa65Verify: row.mldsa65Verify ?? null,
    probeStatus: row.probeStatus,
    probeLatencyMs: row.probeLatencyMs,
    probeCheckedAt: row.probeCheckedAt?.toISOString() ?? null,
    probeError: row.probeError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export async function probeNodeConnectivity(
  host: string,
  port: number,
  _serverName: string,
  _subscriptionUrl: string | null
): Promise<{ status: NodeProbeStatus; latencyMs: number | null; error: string | null }> {
  try {
    const latencyMs = await probeTcp(host, port);
    return {
      status: "healthy",
      latencyMs,
      error: null
    };
  } catch (error) {
    return {
      status: "offline",
      latencyMs: null,
      error: formatError(error)
    };
  }
}

function probeTcp(host: string, port: number) {
  return new Promise<number>((resolve, reject) => {
    const startedAt = Date.now();
    const socket = net.createConnection({ host, port });
    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    socket.setTimeout(5000);
    socket.once("connect", () => {
      const latency = Math.max(1, Date.now() - startedAt);
      cleanup();
      resolve(latency);
    });
    socket.once("timeout", () => {
      cleanup();
      reject(new Error("TCP 超时"));
    });
    socket.once("error", (error: Error) => {
      cleanup();
      reject(error);
    });
  });
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
