import { BadRequestException } from "@nestjs/common";
import { isIP } from "node:net";
import { SUPPORTED_FINGERPRINTS, isPublicUnicastAddress } from "./agent-inbound";

/** Client-side parameters only. A sharing link does not reveal the server dest
 * or Reality private key. Its placeholder UUID is intentionally discarded. */
export interface PanelInboundSpec {
  mode: "validate_panel";
  inboundTag: string;
  listenPort: number;
  serverHost: string;
  realityPublicKey: string;
  shortId: string;
  serverNames: string[];
  flow: string;
  fingerprint: string;
  spiderX: string;
  panelVersion: string;
  tagOverrideConfirmed: boolean;
}

function host(value: string, label: string): string {
  const normalized = value.trim().replace(/^\[|\]$/g, "");
  if (isIP(normalized)) {
    if (!isPublicUnicastAddress(normalized)) throw new BadRequestException(`${label} 不得为内网或回环地址`);
  } else if (normalized.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(normalized)) {
    throw new BadRequestException(`${label} 不是合法公网地址或域名`);
  }
  return normalized;
}

export function normalizePanelInbound(input: Record<string, unknown>): PanelInboundSpec {
  const text = (key: string, fallback = "") => {
    const value = input[key] ?? fallback;
    if (typeof value !== "string") throw new BadRequestException(`入站参数 ${key} 必须是字符串`);
    return value.trim();
  };
  if (input.mode !== "validate_panel") throw new BadRequestException("必须显式选择面板入站校验模式");
  if (input.rotateKeys === true) throw new BadRequestException("面板入站校验不会轮换密钥");
  const listenPort = input.listenPort;
  if (!Number.isInteger(listenPort) || Number(listenPort) < 1 || Number(listenPort) > 65535) throw new BadRequestException("入站端口必须是 1-65535");
  const derived = `inbound-${listenPort}`;
  const inboundTag = text("inboundTag", derived);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(inboundTag)) throw new BadRequestException("入站 tag 格式错误");
  if (inboundTag !== derived && input.tagOverrideConfirmed !== true) throw new BadRequestException("自定义 tag 可能指向其他入站，必须确认覆盖警告");
  const panelVersion = text("panelVersion").replace(/^v/, "");
  const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(panelVersion);
  // "auto" defers the version check to the installer's local, read-only probe.
  // It is never interpreted as proof that the panel supports shared metering.
  // Match the installer's supported release family. 3.0.x was prerelease;
  // 3.1.0 is the first stable release with non-resetting traffic collection.
  if (panelVersion !== "auto" && (!version || Number(version[1]) !== 3 || Number(version[2]) < 1)) {
    throw new BadRequestException("面板版本必须为 3.1.0 或以上的 3.x 稳定版，请先升级并核对版本");
  }
  const realityPublicKey = text("realityPublicKey");
  if (!/^[A-Za-z0-9_-]{43}$/.test(realityPublicKey) || Buffer.from(realityPublicKey, "base64url").toString("base64url") !== realityPublicKey) {
    throw new BadRequestException("Reality 公钥必须是规范的 32 字节 base64url");
  }
  const shortId = text("shortId");
  if (!/^(?:[0-9a-f]{2}){0,8}$/.test(shortId)) throw new BadRequestException("shortId 必须是 0-8 字节十六进制");
  const names = input.serverNames;
  if (!Array.isArray(names) || names.length !== 1 || typeof names[0] !== "string") throw new BadRequestException("面板导入必须指定一个客户端 SNI");
  const serverNames = [host(names[0], "SNI")];
  const flow = text("flow");
  if (flow !== "" && flow !== "xtls-rprx-vision") throw new BadRequestException("不支持的 flow");
  const fingerprint = text("fingerprint", "chrome");
  if (!(SUPPORTED_FINGERPRINTS as readonly string[]).includes(fingerprint)) throw new BadRequestException("不支持的 fingerprint");
  const spiderX = text("spiderX", "/");
  if (!spiderX.startsWith("/") || spiderX.length > 64 || /[\s"'\\]/.test(spiderX)) throw new BadRequestException("spiderX 格式错误");
  return { mode: "validate_panel", inboundTag, listenPort: Number(listenPort), serverHost: host(text("serverHost"), "节点地址"),
    realityPublicKey, shortId, serverNames, flow, fingerprint, spiderX, panelVersion, tagOverrideConfirmed: input.tagOverrideConfirmed === true };
}

/** Parse without retaining or fetching the link; credentials never enter jobs. */
export function parsePanelLink(link: string, panelVersion: string, override?: string, confirmed = false): PanelInboundSpec {
  let url: URL;
  try { url = new URL(link.trim()); } catch { throw new BadRequestException("不是合法的 vless 分享链接"); }
  if (url.protocol !== "vless:" || !url.username || url.password) throw new BadRequestException("仅支持 vless 分享链接");
  if (url.pathname && url.pathname !== "/") throw new BadRequestException("分享链接不应携带路径");
  const q = url.searchParams;
  const allowed = new Set(["security", "type", "encryption", "pbk", "sid", "sni", "flow", "fp", "spx"]);
  const seen = new Set<string>();
  for (const [key] of q) {
    if (!allowed.has(key)) throw new BadRequestException(`不支持的链接参数 ${key}，拒绝静默丢弃`);
    if (seen.has(key)) throw new BadRequestException(`链接参数 ${key} 重复`);
    seen.add(key);
  }
  if (q.get("security") !== "reality" || !["tcp", "raw"].includes(q.get("type") ?? "tcp")) throw new BadRequestException("仅支持 TCP/RAW + Reality 入站");
  if (q.has("encryption") && q.get("encryption") !== "none") throw new BadRequestException("不支持额外 VLESS encryption");
  for (const key of ["pqv", "mldsa65Verify", "path", "serviceName"]) {
    if (q.get(key)) throw new BadRequestException(`此导入流程不支持参数 ${key}，拒绝静默丢弃`);
  }
  return normalizePanelInbound({ mode: "validate_panel", listenPort: Number(url.port), serverHost: url.hostname,
    realityPublicKey: q.get("pbk") ?? "", shortId: q.get("sid") ?? "", serverNames: [q.get("sni") ?? ""],
    flow: q.get("flow") ?? "", fingerprint: q.get("fp") ?? "chrome", spiderX: q.get("spx") ?? "/",
    panelVersion, ...(override ? { inboundTag: override } : {}), tagOverrideConfirmed: confirmed });
}

export function parsePanelReport(result: unknown, spec: PanelInboundSpec) {
  const report = (result as { inbound?: Record<string, unknown> } | null)?.inbound;
  if (!report || report.mode !== "validate_panel" || report.validated !== true) throw new BadRequestException("缺少面板入站只读校验结果");
  if (typeof report.inboundTag !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(report.inboundTag) ||
    (spec.tagOverrideConfirmed && report.inboundTag !== spec.inboundTag)) throw new BadRequestException("面板入站 tag 与确认目标不一致");
  for (const [key, expected] of Object.entries({ serverPort: spec.listenPort,
    serverHost: spec.serverHost, realityPublicKey: spec.realityPublicKey, shortId: spec.shortId,
    serverName: spec.serverNames[0], flow: spec.flow, fingerprint: spec.fingerprint, spiderX: spec.spiderX })) {
    if (report[key] !== expected) throw new BadRequestException(`面板入站校验结果 ${key} 与导入规格不一致`);
  }
  return { serverHost: spec.serverHost, serverPort: spec.listenPort, realityPublicKey: spec.realityPublicKey,
    shortId: spec.shortId, serverName: spec.serverNames[0], flow: spec.flow, fingerprint: spec.fingerprint, spiderX: spec.spiderX };
}
