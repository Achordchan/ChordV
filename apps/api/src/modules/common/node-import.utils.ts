import { BadRequestException } from "@nestjs/common";
import * as net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import type { AdminNodeRecordDto, NodeProbeStatus, NodeSummaryDto } from "@chordv/shared";

export type ParsedVlessLink = {
  name: string;
  serverHost: string;
  serverPort: number;
  uuid: string;
  flow: string;
  realityPublicKey: string;
  shortId: string;
  serverName: string;
  fingerprint: string;
  spiderX: string;
};

export function normalizePanelApiBasePath(value: string | null | undefined) {
  const raw = value?.trim() || "/";
  if (raw === "/") {
    return "/";
  }
  return `/${raw.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

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

export function decodeSubscriptionText(raw: string) {
  if (raw.includes("vless://")) {
    return raw;
  }

  try {
    return Buffer.from(raw, "base64").toString("utf8");
  } catch {
    return raw;
  }
}

export function parseVlessLink(link: string): ParsedVlessLink {
  const parsed = new URL(link);
  const name = decodeURIComponent(parsed.hash.replace(/^#/, "")) || `${parsed.hostname}:${parsed.port}`;

  return {
    name,
    serverHost: parsed.hostname,
    serverPort: Number(parsed.port),
    uuid: decodeURIComponent(parsed.username),
    flow: parsed.searchParams.get("flow") || "xtls-rprx-vision",
    realityPublicKey: parsed.searchParams.get("pbk") || "",
    shortId: parsed.searchParams.get("sid") || "",
    serverName: parsed.searchParams.get("sni") || "",
    fingerprint: parsed.searchParams.get("fp") || "chrome",
    spiderX: decodeURIComponent(parsed.searchParams.get("spx") || "/")
  };
}

export function readRuntimeInboundId(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const inboundId = Reflect.get(value, "inboundId");
  if (typeof inboundId === "number" && Number.isFinite(inboundId) && inboundId > 0) {
    return inboundId;
  }
  return null;
}

export function toNodeId(host: string, port: number) {
  return `node_${host.replaceAll(".", "_").replaceAll("-", "_")}_${port}`;
}

export async function fetchSubscriptionNode(subscriptionUrl: string) {
  const timeoutMs = Number(process.env.CHORDV_SUBSCRIPTION_TIMEOUT_MS ?? 15000);
  const allowInsecureTls = (process.env.CHORDV_SUBSCRIPTION_ALLOW_INSECURE_TLS ?? "true").toLowerCase() === "true";
  const response = await undiciFetch(subscriptionUrl, {
    signal: AbortSignal.timeout(timeoutMs),
    dispatcher: createDispatcher(timeoutMs, allowInsecureTls)
  });

  if (!response.ok) {
    throw new BadRequestException(`订阅地址请求失败：HTTP ${response.status}`);
  }

  const raw = (await response.text()).trim();
  const decoded = decodeSubscriptionText(raw);
  const first = decoded
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.startsWith("vless://"));

  if (!first) {
    throw new BadRequestException("订阅内容里没有可用的 vless 节点");
  }

  return parseVlessLink(first);
}

export function toNodeSummary(row: {
  id: string;
  name: string;
  region: string;
  provider: string;
  tags: string[];
  recommended: boolean;
  latencyMs: number;
  probeLatencyMs?: number | null;
  protocol: string;
  security: string;
}): NodeSummaryDto {
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    provider: row.provider,
    tags: row.tags,
    recommended: row.recommended,
    latencyMs: row.probeLatencyMs ?? row.latencyMs,
    protocol: row.protocol as "vless",
    security: row.security as "reality"
  };
}

export function toAdminNodeRecord(row: {
  id: string;
  name: string;
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
  subscriptionUrl: string | null;
  gatewayStatus: "online" | "offline" | "degraded";
  statsLastSyncedAt: Date | null;
  panelBaseUrl: string | null;
  panelApiBasePath: string | null;
  panelUsername: string | null;
  panelPassword: string | null;
  panelInboundId: number | null;
  panelEnabled: boolean;
  panelStatus: "online" | "offline" | "degraded";
  panelLastSyncedAt: Date | null;
  panelError: string | null;
  probeStatus: NodeProbeStatus;
  probeCheckedAt: Date | null;
  probeError: string | null;
  createdAt: Date;
  updatedAt: Date;
}): AdminNodeRecordDto {
  return {
    ...toNodeSummary(row),
    subscriptionUrl: row.subscriptionUrl,
    gatewayStatus: row.gatewayStatus,
    statsLastSyncedAt: row.statsLastSyncedAt?.toISOString() ?? null,
    panelBaseUrl: row.panelBaseUrl,
    panelApiBasePath: row.panelApiBasePath,
    panelUsername: row.panelUsername,
    panelPassword: row.panelPassword,
    panelInboundId: row.panelInboundId,
    panelEnabled: row.panelEnabled,
    panelStatus: row.panelStatus,
    panelLastSyncedAt: row.panelLastSyncedAt?.toISOString() ?? null,
    panelError: row.panelError,
    serverName: row.serverName,
    serverHost: row.serverHost,
    serverPort: row.serverPort,
    shortId: row.shortId,
    spiderX: row.spiderX,
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

function createDispatcher(timeoutMs: number, allowInsecureTls: boolean) {
  return new Agent({
    connectTimeout: timeoutMs,
    connect: {
      rejectUnauthorized: !allowInsecureTls
    }
  });
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
