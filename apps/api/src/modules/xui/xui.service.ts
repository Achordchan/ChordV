import { BadGatewayException, BadRequestException, Injectable } from "@nestjs/common";
import { fetch as undiciFetch, Headers, FormData, type Dispatcher, Agent } from "undici";

const PANEL_TIMEOUT_MS = Number(process.env.CHORDV_XUI_TIMEOUT_MS ?? 15000);
const PANEL_USER_AGENT = "ChordV/0.1";
const DEFAULT_PANEL_PATH = "/";

type XuiNodeConfig = {
  id: string;
  panelBaseUrl: string | null;
  panelApiBasePath: string | null;
  panelUsername: string | null;
  panelPassword: string | null;
  panelInboundId: number | null;
};

type XuiClientPayload = {
  id: string;
  email: string;
  enable: boolean;
  flow: string;
  expiryTime: number;
  limitIp: number;
  totalGB: number;
  subId?: string;
  reset: number;
  tgId: string;
  comment: string;
};

type XuiInboundClient = {
  id: string;
  email: string;
  enable?: boolean;
  flow?: string;
  expiryTime?: number;
  limitIp?: number;
  totalGB?: number;
  subId?: string;
  reset?: number;
  tgId?: string;
  comment?: string;
};

type XuiInboundStat = {
  email: string;
  inboundId?: number;
  enable?: boolean;
  uuid?: string;
  up?: number | string;
  down?: number | string;
  total?: number | string;
  expiryTime?: number;
  reset?: number;
  lastOnline?: number;
};

type XuiInbound = {
  id: number;
  remark?: string;
  protocol?: string;
  port?: number;
  listen?: string;
  settings?: string;
  streamSettings?: string;
  clientStats?: XuiInboundStat[] | null;
};

type XuiInboundRuntime = {
  inboundId: number;
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

type XuiInboundSummary = {
  id: number;
  remark: string;
  port: number;
  protocol: string;
  clientCount: number;
};

type XuiRequestOptions = {
  path: string;
  method?: "GET" | "POST";
  node: XuiNodeConfig;
  body?: BodyInitLike;
  contentType?: string;
  useJson?: boolean;
};

type BodyInitLike = string | FormData;

type XuiSessionState = {
  cookieHeader: string;
};

type NormalizedXuiNodeConfig = XuiNodeConfig & {
  panelBaseUrl: string;
  panelApiBasePath: string;
  panelUsername: string;
  panelPassword: string;
};

@Injectable()
export class XuiService {
  private readonly sessions = new Map<string, XuiSessionState>();
  private readonly dispatcher: Dispatcher = new Agent({
    connectTimeout: PANEL_TIMEOUT_MS
  });

  async checkNodeHealth(node: XuiNodeConfig) {
    const inbound = await this.getInbound(node);
    return {
      inboundId: inbound.id,
      clientCount: this.extractInboundClients(inbound).length
    };
  }

  async ensureClient(
    node: XuiNodeConfig,
    payload: XuiClientPayload
  ): Promise<{ email: string; uuid: string; inboundId: number }> {
    const inbound = await this.getInbound(node);
    const existing = this.findInboundClient(inbound, payload.email);
    if (existing) {
      if (existing.id !== payload.id || existing.enable === false || (existing.expiryTime ?? 0) !== payload.expiryTime) {
        await this.updateClient(node, payload);
      }
      return {
        email: existing.email,
        uuid: existing.id,
        inboundId: inbound.id
      };
    }

    await this.addClient(node, payload);
    return {
      email: payload.email,
      uuid: payload.id,
      inboundId: inbound.id
    };
  }

  async setClientEnabled(node: XuiNodeConfig, clientId: string, email: string, enabled: boolean) {
    const inbound = await this.getInbound(node);
    const existing = this.findInboundClient(inbound, email);
    if (!existing) {
      if (enabled) {
        throw new BadGatewayException(`3x-ui 未找到客户端 ${email}`);
      }
      return;
    }

    if (existing.enable === enabled) {
      return;
    }

    await this.updateClient(node, {
      id: existing.id || clientId,
      email: existing.email || email,
      enable: enabled,
      flow: existing.flow ?? "",
      expiryTime: existing.expiryTime ?? 0,
      limitIp: existing.limitIp ?? 0,
      totalGB: existing.totalGB ?? 0,
      subId: existing.subId ?? "",
      reset: existing.reset ?? 0,
      tgId: existing.tgId ?? "",
      comment: existing.comment ?? ""
    });
  }

  async removeClient(node: XuiNodeConfig, clientId: string, email: string) {
    const inboundId = await this.resolveInboundId(node);
    const attempts = [
      { path: `/panel/api/inbounds/${inboundId}/delClient/${encodeURIComponent(clientId)}` },
      { path: `/panel/api/inbounds/delClient/${encodeURIComponent(clientId)}`, body: JSON.stringify({ id: inboundId }), contentType: "application/json" },
      { path: `/panel/api/inbounds/delClient/${inboundId}/${encodeURIComponent(clientId)}` },
      { path: `/panel/api/inbounds/delClientByEmail/${encodeURIComponent(email)}` },
      { path: `/panel/api/inbounds/delClient/${encodeURIComponent(email)}` }
    ];

    for (const attempt of attempts) {
      try {
        await this.request({
          node,
          path: attempt.path,
          method: "POST",
          body: attempt.body,
          contentType: attempt.contentType,
          useJson: true
        });
        return;
      } catch {
        continue;
      }
    }

    const inbound = await this.getInbound(node);
    const existing = this.findInboundClient(inbound, email);
    if (existing) {
      await this.updateClient(node, {
        id: existing.id,
        email: existing.email,
        enable: false,
        flow: existing.flow ?? "",
        expiryTime: existing.expiryTime ?? 0,
        limitIp: existing.limitIp ?? 0,
        totalGB: existing.totalGB ?? 0,
        subId: existing.subId ?? "",
        reset: existing.reset ?? 0,
        tgId: existing.tgId ?? "",
        comment: existing.comment ?? ""
      });
      return;
    }

    throw new BadGatewayException("删除 3x-ui 客户端失败");
  }

  async resetClientTraffic(node: XuiNodeConfig, email: string) {
    const inboundId = await this.resolveInboundId(node);
    const attempts = [
      { path: `/panel/api/inbounds/resetClientTraffic/${inboundId}/${encodeURIComponent(email)}` },
      { path: `/panel/api/inbounds/${inboundId}/resetClientTraffic/${encodeURIComponent(email)}` },
      {
        path: `/panel/api/inbounds/resetClientTraffic/${encodeURIComponent(email)}`,
        body: JSON.stringify({ id: inboundId }),
        contentType: "application/json"
      }
    ];

    for (const attempt of attempts) {
      try {
        await this.request({
          node,
          path: attempt.path,
          method: "POST",
          body: attempt.body,
          contentType: attempt.contentType,
          useJson: true
        });
        return;
      } catch {
        continue;
      }
    }

    throw new BadGatewayException(`重置 3x-ui 客户端流量失败：${email}`);
  }

  async listNodeUsage(node: XuiNodeConfig) {
    const inbound = await this.getInboundWithStats(node);
    const stats = this.extractClientStats(inbound);
    return stats.map((item) => ({
      xrayUserEmail: item.email.toLowerCase(),
      xrayUserUuid: item.uuid,
      uplinkBytes: toBigInt(item.up),
      downlinkBytes: toBigInt(item.down),
      sampledAt: new Date().toISOString()
    }));
  }

  async getClientUsage(node: XuiNodeConfig, email: string) {
    const inbound = await this.getInboundWithStats(node);
    const stat =
      this.extractClientStats(inbound).find((item) => item.email?.trim().toLowerCase() === email.trim().toLowerCase()) ??
      null;
    if (!stat) {
      return null;
    }
    return {
      xrayUserEmail: stat.email.toLowerCase(),
      xrayUserUuid: stat.uuid ?? undefined,
      uplinkBytes: toBigInt(stat.up),
      downlinkBytes: toBigInt(stat.down),
      sampledAt: new Date().toISOString()
    };
  }

  async getInbound(node: XuiNodeConfig): Promise<XuiInbound> {
    const inboundId = await this.resolveInboundId(node);
    const payload = await this.request({
      node,
      path: `/panel/api/inbounds/get/${inboundId}`,
      method: "GET"
    });
    const inbound = readObj(payload);
    if (!inbound) {
      throw new BadGatewayException("3x-ui 入站信息为空");
    }
    return inbound as XuiInbound;
  }

  private async getInboundWithStats(node: XuiNodeConfig): Promise<XuiInbound> {
    const inboundId = await this.resolveInboundId(node);
    const payload = await this.request({
      node,
      path: "/panel/api/inbounds/list",
      method: "GET"
    });
    const inbounds = readObj(payload);
    if (!Array.isArray(inbounds)) {
      throw new BadGatewayException("3x-ui 入站列表为空");
    }

    const inbound = inbounds.find((item) => item && typeof item === "object" && Reflect.get(item, "id") === inboundId);
    if (!inbound) {
      throw new BadGatewayException(`3x-ui 未找到入站 ${inboundId}`);
    }

    return inbound as XuiInbound;
  }

  async getInboundRuntime(node: XuiNodeConfig): Promise<XuiInboundRuntime> {
    const inbound = await this.getInbound(node);
    const clients = this.extractInboundClients(inbound);
    const settings = parseJsonRecord(inbound.settings);
    const streamSettings = parseJsonRecord(inbound.streamSettings);
    const realitySettings = parseJsonRecord(streamSettings?.realitySettings);
    const realityDerivedSettings = parseJsonRecord(realitySettings?.settings);
    const shortIds = Array.isArray(realitySettings?.shortIds)
      ? realitySettings?.shortIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    const serverNames = Array.isArray(realitySettings?.serverNames)
      ? realitySettings?.serverNames.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    const firstClient = clients[0];
    const panelHost = new URL(normalizeBaseUrl(normalizeNodeConfig(node).panelBaseUrl)).hostname;

    return {
      inboundId: inbound.id,
      name: readString(inbound.remark) ?? `${panelHost}:${inbound.port ?? 443}`,
      serverHost: readString(inbound.listen) ?? panelHost,
      serverPort: typeof inbound.port === "number" && Number.isFinite(inbound.port) ? inbound.port : 443,
      uuid: readString(firstClient?.id) ?? "",
      flow: readString(firstClient?.flow) ?? readString(settings?.flow) ?? "xtls-rprx-vision",
      realityPublicKey: readString(realityDerivedSettings?.publicKey) ?? "",
      shortId: shortIds[0] ?? "",
      serverName: readString(realityDerivedSettings?.serverName) ?? serverNames[0] ?? "",
      fingerprint: readString(realityDerivedSettings?.fingerprint) ?? "chrome",
      spiderX: readString(realityDerivedSettings?.spiderX) ?? "/"
    };
  }

  async listInbounds(node: XuiNodeConfig): Promise<XuiInboundSummary[]> {
    const payload = await this.request({
      node,
      path: "/panel/api/inbounds/list",
      method: "GET"
    });
    const inbounds = readObj(payload);
    if (!Array.isArray(inbounds)) {
      throw new BadGatewayException("3x-ui 入站列表为空");
    }

    return inbounds
      .filter((item): item is XuiInbound => Boolean(item && typeof item === "object"))
      .map((item) => ({
        id: typeof item.id === "number" ? item.id : 0,
        remark: readString(item.remark) ?? `入站 ${item.id ?? "-"}`,
        port: typeof item.port === "number" ? item.port : 0,
        protocol: readString(item.protocol) ?? "unknown",
        clientCount: this.extractInboundClients(item).length
      }))
      .filter((item) => item.id > 0);
  }

  private async addClient(node: XuiNodeConfig, client: XuiClientPayload) {
    const inboundId = await this.resolveInboundId(node);
    await this.request({
      node,
      path: "/panel/api/inbounds/addClient",
      method: "POST",
      body: JSON.stringify({
        id: inboundId,
        settings: JSON.stringify({
          clients: [client]
        })
      }),
      contentType: "application/json",
      useJson: true
    });
  }

  private async updateClient(node: XuiNodeConfig, client: XuiClientPayload) {
    const inboundId = await this.resolveInboundId(node);
    const attempts = [
      `/panel/api/inbounds/updateClient/${encodeURIComponent(client.id)}`,
      `/panel/api/inbounds/updateClient/${inboundId}/${encodeURIComponent(client.id)}`
    ];

    for (const path of attempts) {
      try {
        await this.request({
          node,
          path,
          method: "POST",
          body: JSON.stringify({
            id: inboundId,
            settings: JSON.stringify({
              clients: [client]
            })
          }),
          contentType: "application/json",
          useJson: true
        });
        return;
      } catch {
        continue;
      }
    }

    throw new BadGatewayException("更新 3x-ui 客户端失败");
  }

  private async request({ node, path, method = "GET", body, contentType, useJson = true }: XuiRequestOptions) {
    const normalized = normalizeNodeConfig(node);
    if (!this.sessions.has(this.sessionKey(normalized))) {
      await this.login(normalized);
    }

    let response = await this.performRequest(normalized, path, method, body, contentType);
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      this.sessions.delete(this.sessionKey(normalized));
      await this.login(normalized);
      response = await this.performRequest(normalized, path, method, body, contentType);
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw new BadGatewayException("3x-ui 面板接口路径错误，请检查面板地址或 API 基础路径");
      }
      const text = await response.text().catch(() => "");
      throw new BadGatewayException(`3x-ui 面板请求失败：HTTP ${response.status}${text ? ` ${text}` : ""}`);
    }

    if (!useJson) {
      return null;
    }

    const json = await response.json().catch(() => null);
    if (json && typeof json === "object" && "success" in json && Reflect.get(json, "success") === false) {
      throw new BadGatewayException(readString(Reflect.get(json, "msg")) || "3x-ui 面板返回失败");
    }
    return json;
  }

  private async performRequest(
    node: NormalizedXuiNodeConfig,
    path: string,
    method: "GET" | "POST",
    body?: BodyInitLike,
    contentType?: string
  ) {
    const headers = new Headers();
    headers.set("User-Agent", PANEL_USER_AGENT);
    const session = this.sessions.get(this.sessionKey(node));
    if (session?.cookieHeader) {
      headers.set("Cookie", session.cookieHeader);
    }
    if (body && contentType && !(body instanceof FormData)) {
      headers.set("Content-Type", contentType);
    }

    return undiciFetch(`${normalizeBaseUrl(node.panelBaseUrl)}${joinPanelPath(node.panelApiBasePath, path)}`, {
      method,
      body,
      headers,
      dispatcher: this.dispatcher,
      signal: AbortSignal.timeout(PANEL_TIMEOUT_MS)
    });
  }

  private async login(
    node: NormalizedXuiNodeConfig
  ) {
    const form = new FormData();
    form.set("username", node.panelUsername);
    form.set("password", node.panelPassword);
    form.set("twoFactorCode", "");

    const response = await undiciFetch(`${normalizeBaseUrl(node.panelBaseUrl)}${joinPanelPath(node.panelApiBasePath, "/login")}`, {
      method: "POST",
      body: form,
      headers: {
        "User-Agent": PANEL_USER_AGENT
      },
      dispatcher: this.dispatcher,
      signal: AbortSignal.timeout(PANEL_TIMEOUT_MS)
    });

    const responseText = await response.text().catch(() => "");
    const payload = parseJsonRecord(responseText);
    const loginMessage = readString(payload?.msg);
    const loginSuccess = typeof payload?.success === "boolean" ? payload.success : null;

    if (response.status === 404) {
      throw new BadGatewayException("3x-ui 登录接口不存在，请检查面板地址或 API 基础路径");
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403 || isCredentialError(loginMessage)) {
        throw new BadRequestException("3x-ui 账号或密码错误");
      }
      throw new BadGatewayException(`3x-ui 登录失败：HTTP ${response.status}`);
    }

    if (loginSuccess === false) {
      if (isCredentialError(loginMessage)) {
        throw new BadRequestException("3x-ui 账号或密码错误");
      }
      throw new BadGatewayException(loginMessage ? `3x-ui 登录失败：${loginMessage}` : "3x-ui 登录失败");
    }

    const cookies = response.headers.getSetCookie?.() ?? [];
    const cookieHeader = cookies.map((item) => item.split(";")[0]).filter(Boolean).join("; ");
    if (!cookieHeader) {
      const fallbackCookie = response.headers.get("set-cookie");
      if (fallbackCookie) {
        this.sessions.set(this.sessionKey(node), { cookieHeader: fallbackCookie.split(";")[0] });
        return;
      }
      if (isCredentialError(loginMessage)) {
        throw new BadRequestException("3x-ui 账号或密码错误");
      }
      throw new BadGatewayException("3x-ui 登录失败：未获取到会话 Cookie，请检查面板地址或登录接口路径");
    }

    this.sessions.set(this.sessionKey(node), { cookieHeader });
  }

  private extractInboundClients(inbound: XuiInbound) {
    const settings = parseJsonRecord(inbound.settings);
    const clients = settings?.clients;
    return Array.isArray(clients) ? (clients.filter((item) => item && typeof item === "object") as XuiInboundClient[]) : [];
  }

  private findInboundClient(inbound: XuiInbound, email: string) {
    return this.extractInboundClients(inbound).find((item) => item.email?.trim().toLowerCase() === email.trim().toLowerCase()) ?? null;
  }

  private extractClientStats(inbound: XuiInbound) {
    const clients = this.extractInboundClients(inbound);
    const direct = Array.isArray(inbound.clientStats) ? inbound.clientStats : [];
    const statsByEmail = new Map<string, XuiInboundStat>();

    for (const item of direct) {
      const email = item.email?.trim().toLowerCase();
      if (!email) {
        continue;
      }
      statsByEmail.set(email, item);
    }

    for (const client of clients) {
      const email = client.email?.trim().toLowerCase();
      if (!email || statsByEmail.has(email)) {
        continue;
      }
      statsByEmail.set(email, {
        email: client.email,
        uuid: client.id,
        enable: client.enable,
        up: 0,
        down: 0,
        total: 0
      });
    }

    if (statsByEmail.size > 0) {
      return Array.from(statsByEmail.values());
    }

    const settings = parseJsonRecord(inbound.settings);
    const stats = parseJsonRecord(settings?.clientStats);
    if (Array.isArray(stats)) {
      return stats as XuiInboundStat[];
    }

    return clients.map((item) => ({
      email: item.email,
      uuid: item.id,
      up: 0,
      down: 0,
      total: 0
    }));
  }

  private async resolveInboundId(node: XuiNodeConfig) {
    if (node.panelInboundId && node.panelInboundId > 0) {
      return node.panelInboundId;
    }

    const inbounds = await this.listInbounds(node);
    if (inbounds.length === 0) {
      throw new BadRequestException("3x-ui 面板没有可用入站，请先在面板创建入站");
    }
    if (inbounds.length === 1) {
      return inbounds[0].id;
    }
    throw new BadRequestException("未选择 3x-ui 入站，请先读取入站列表并选择目标入站");
  }

  private sessionKey(node: XuiNodeConfig) {
    return `${node.panelBaseUrl}|${node.panelApiBasePath}|${node.panelUsername}`;
  }
}

function normalizeNodeConfig(node: XuiNodeConfig) {
  if (!node.panelBaseUrl?.trim() || !node.panelUsername?.trim() || !node.panelPassword?.trim()) {
    throw new BadRequestException("节点缺少 3x-ui 面板配置");
  }

  return {
    ...node,
    panelBaseUrl: node.panelBaseUrl.trim().replace(/\/$/, ""),
    panelApiBasePath: normalizePanelBasePath(node.panelApiBasePath),
    panelUsername: node.panelUsername.trim(),
    panelPassword: node.panelPassword.trim()
  } satisfies NormalizedXuiNodeConfig;
}

function normalizePanelBasePath(input: string | null) {
  const raw = input?.trim() || DEFAULT_PANEL_PATH;
  if (raw === "/") {
    return "";
  }
  return `/${raw.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

function joinPanelPath(basePath: string, path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${basePath}${normalizedPath}`;
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/$/, "");
}

function parseJsonRecord(value: unknown): Record<string, any> | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, any>;
    } catch {
      return null;
    }
  }
  if (typeof value === "object") {
    return value as Record<string, any>;
  }
  return null;
}

function readObj(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if ("obj" in value) {
    return Reflect.get(value, "obj");
  }
  return value;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toBigInt(value: unknown) {
  if (typeof value === "bigint") {
    return value >= 0n ? value : 0n;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.max(0, Math.trunc(value)));
  }
  if (typeof value === "string" && value.trim()) {
    try {
      return BigInt(value.trim());
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function isCredentialError(message: string | null) {
  if (!message) {
    return false;
  }
  return /账号|账户|用户名|密码|credential|invalid|unauthorized|login/i.test(message);
}
