import { BadRequestException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { isIP } from "node:net";

/**
 * The control plane owns inbound POLICY (which port, which SNI to borrow); the
 * VPS owns the SECRETS (Reality key pair, shortId) and never sends the private
 * key back. These defaults let an operator deploy with an empty payload while
 * keeping every parameter visible and reproducible on this side.
 */
export const INBOUND_DEFAULTS = {
  inboundTag: "vless-in",
  listenPort: 443,
  dest: "www.microsoft.com:443",
  serverNames: ["www.microsoft.com"],
  flow: "xtls-rprx-vision",
  fingerprint: "chrome",
  spiderX: "/"
} as const;

export interface NormalizedInboundSpec {
  inboundTag: string;
  listenPort: number;
  dest: string;
  serverNames: string[];
  flow: string;
  fingerprint: string;
  spiderX: string;
  rotateKeys: boolean;
}

/**
 * uTLS fingerprints a client runtime can actually present. The server cannot
 * catch a bad one — the fingerprint is a client-side setting, so Xray accepts
 * the deployment either way and the node becomes activatable while every
 * generated config carries an unusable value.
 */
export const SUPPORTED_FINGERPRINTS = [
  "chrome", "firefox", "safari", "ios", "android", "edge", "360", "qq", "random", "randomized"
] as const;

const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function text(payload: Record<string, unknown>, key: string, fallback: string): string {
  const value = payload[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new BadRequestException(`入站参数 ${key} 必须是字符串`);
  return value.trim();
}

function hostname(value: string, label: string): string {
  if (!value || value.length > 253 || !HOSTNAME.test(value)) throw new BadRequestException(`入站参数 ${label} 不是合法域名：${value}`);
  return value;
}

function port(value: unknown, label: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535) {
    throw new BadRequestException(`入站参数 ${label} 必须是 1-65535 的端口`);
  }
  return value as number;
}

/**
 * QueueAgentCommandDto only checks that the payload is an object, so the
 * inbound spec is validated here before it is persisted on the job. What is
 * stored is what the agent's report is later compared against field by field —
 * so normalizing once, at enqueue time, is what makes that comparison mean
 * anything.
 */
export function normalizeInboundSpec(payload: Record<string, unknown>): NormalizedInboundSpec {
  const inboundTag = text(payload, "inboundTag", INBOUND_DEFAULTS.inboundTag);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(inboundTag)) throw new BadRequestException(`入站参数 inboundTag 不合法：${inboundTag}`);

  const dest = text(payload, "dest", INBOUND_DEFAULTS.dest);
  const separator = dest.lastIndexOf(":");
  if (separator <= 0) throw new BadRequestException(`入站参数 dest 必须是 host:port：${dest}`);
  const destHost = dest.slice(0, separator);
  hostname(destHost, "dest");
  port(Number(dest.slice(separator + 1)), "dest 端口", 0);
  // A loopback/private fallback target turns the node's public listener into a
  // tunnel to an internal service (the unauthenticated Xray gRPC API, cloud
  // metadata). The root helper enforces this again at deploy time — including
  // DNS rebinding, which only it can see from the node — so rejecting the
  // obvious literals here turns an admin mistake into a 400 instead of a
  // failed deployment.
  if (destHost.toLowerCase() === "localhost" || (isIP(destHost) !== 0 && !isPublicUnicastAddress(destHost))) {
    throw new BadRequestException(`入站参数 dest 不得指向回环或内网地址：${dest}`);
  }

  const rawNames = payload.serverNames ?? [...INBOUND_DEFAULTS.serverNames];
  if (!Array.isArray(rawNames) || rawNames.length < 1 || rawNames.length > 8) {
    throw new BadRequestException("入站参数 serverNames 必须是 1-8 个域名");
  }
  const serverNames = rawNames.map((name) => hostname(typeof name === "string" ? name.trim() : "", "serverNames"));

  const flow = text(payload, "flow", INBOUND_DEFAULTS.flow);
  if (flow !== "" && flow !== "xtls-rprx-vision") throw new BadRequestException(`入站参数 flow 不支持：${flow}`);
  const fingerprint = text(payload, "fingerprint", INBOUND_DEFAULTS.fingerprint);
  if (!(SUPPORTED_FINGERPRINTS as readonly string[]).includes(fingerprint)) {
    throw new BadRequestException(`入站参数 fingerprint 不受支持：${fingerprint}（可用：${SUPPORTED_FINGERPRINTS.join("、")}）`);
  }
  const spiderX = text(payload, "spiderX", INBOUND_DEFAULTS.spiderX);
  if (!spiderX.startsWith("/") || spiderX.length > 64 || /[\s"'\\]/.test(spiderX)) {
    throw new BadRequestException(`入站参数 spiderX 不合法：${spiderX}`);
  }
  if (payload.rotateKeys !== undefined && typeof payload.rotateKeys !== "boolean") {
    throw new BadRequestException("入站参数 rotateKeys 必须是布尔值");
  }

  return {
    inboundTag,
    listenPort: port(payload.listenPort, "listenPort", INBOUND_DEFAULTS.listenPort),
    dest,
    serverNames,
    flow,
    fingerprint,
    spiderX,
    rotateKeys: payload.rotateKeys === true
  };
}

/** Stable identity of a spec, so re-issuing the same deployment is a no-op. */
export function inboundSpecKey(nodeId: string, spec: NormalizedInboundSpec): string {
  const identity = { ...spec, serverNames: [...spec.serverNames].sort() };
  return `${nodeId}:ENSURE_INBOUND:${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32)}`;
}

/** Parses an IPv6 literal (including `::` compression and an embedded IPv4 tail) into 16 bytes. */
export function parseIPv6Bytes(value: string): number[] | null {
  const host = value.trim().replace(/^\[|\]$/g, "");
  if (isIP(host) !== 6) return null;
  const [head, tail] = host.split("::") as [string, string | undefined];
  const expand = (part: string): number[] => {
    if (!part) return [];
    const groups: number[] = [];
    for (const piece of part.split(":")) {
      if (piece.includes(".")) {
        // IPv4-mapped/compatible tail: ::ffff:192.168.1.1
        for (const octet of piece.split(".")) groups.push(Number(octet));
        continue;
      }
      const word = Number.parseInt(piece, 16);
      groups.push(word >> 8, word & 0xff);
    }
    return groups;
  };
  const front = expand(head);
  const back = tail === undefined ? [] : expand(tail);
  const missing = 16 - front.length - back.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return null;
  return [...front, ...new Array(missing).fill(0), ...back];
}

function isPublicIPv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

/**
 * Rejects addresses no client can reach, and addresses that would point the
 * whole user base at the wrong machine: loopback, private and CGNAT ranges,
 * link-local, multicast, and the R1 placeholder. The comparison is on parsed
 * BYTES, not on text: `0:0:0:0:0:0:0:1` is loopback spelled the long way, and
 * `::ffff:192.168.1.1` is a private IPv4 wearing an IPv6 costume — both would
 * slip past a prefix match and make an unreachable endpoint activatable.
 */
export function isPublicUnicastAddress(host: string): boolean {
  const family = isIP(host.trim().replace(/^\[|\]$/g, ""));
  if (family === 4) return isPublicIPv4(host.trim().split(".").map(Number));
  if (family !== 6) return false;
  const bytes = parseIPv6Bytes(host);
  if (!bytes) return false;
  // IPv4-mapped (::ffff:a.b.c.d) is an IPv4 address; judge it by IPv4 rules.
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPublicIPv4(bytes.slice(12));
  }
  if (bytes.every((byte) => byte === 0)) return false;               // ::
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return false; // ::1
  if ((bytes[0] & 0xfe) === 0xfc) return false;                      // fc00::/7 unique-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return false; // fe80::/10 link-local
  if (bytes[0] === 0xff) return false;                               // ff00::/8 multicast
  return true;
}

export interface InboundReportFields {
  serverHost: string;
  serverPort: number;
  realityPublicKey: string;
  shortId: string;
  serverName: string;
  flow: string;
  fingerprint: string;
  spiderX: string;
}

/**
 * Validates what the agent reported against what was ordered. These values
 * become the endpoint every client dials, so a mismatch is refused outright
 * rather than partially written: half-applied connection parameters would
 * produce a node that looks activatable and cannot connect.
 */
export function parseInboundReport(result: unknown, spec: NormalizedInboundSpec): InboundReportFields {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new BadRequestException("缺少入站部署结果");
  const value = (result as Record<string, unknown>).inbound;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestException("入站部署结果缺少 inbound 字段");
  const report = value as Record<string, unknown>;

  const serverHost = typeof report.serverHost === "string" ? report.serverHost.trim() : "";
  if (!isPublicUnicastAddress(serverHost)) throw new BadRequestException(`Agent 上报的公网地址不可用：${serverHost || "(空)"}`);
  const serverPort = report.serverPort;
  if (serverPort !== spec.listenPort) throw new BadRequestException(`Agent 上报的端口 ${String(serverPort)} 与下发的 ${spec.listenPort} 不一致`);
  const realityPublicKey = typeof report.realityPublicKey === "string" ? report.realityPublicKey.trim() : "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(realityPublicKey)) throw new BadRequestException("Agent 上报的 Reality 公钥格式错误");
  const shortId = typeof report.shortId === "string" ? report.shortId.trim() : "";
  if (!/^(?:[0-9a-f]{2}){1,8}$/.test(shortId)) throw new BadRequestException("Agent 上报的 shortId 格式错误");
  const serverName = typeof report.serverName === "string" ? report.serverName.trim() : "";
  if (!spec.serverNames.includes(serverName)) throw new BadRequestException(`Agent 上报的 serverName 不在下发列表中：${serverName || "(空)"}`);
  if (report.inboundTag !== spec.inboundTag) throw new BadRequestException("Agent 上报的 inboundTag 与下发不一致");
  if (report.flow !== spec.flow) throw new BadRequestException("Agent 上报的 flow 与下发不一致");
  if (report.fingerprint !== spec.fingerprint) throw new BadRequestException("Agent 上报的 fingerprint 与下发不一致");
  if (report.spiderX !== spec.spiderX) throw new BadRequestException("Agent 上报的 spiderX 与下发不一致");

  return {
    serverHost,
    serverPort: spec.listenPort,
    realityPublicKey,
    shortId,
    serverName,
    // flow is load-bearing, not cosmetic: getConfig() derives every provisioned
    // user's flow from the node, so leaving it empty while the inbound runs
    // xtls-rprx-vision would give every user a mismatched flow.
    flow: spec.flow,
    fingerprint: spec.fingerprint,
    spiderX: spec.spiderX
  };
}
