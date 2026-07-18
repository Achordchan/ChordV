import { createHash } from "node:crypto";
import { decryptPanelPassword } from "../common/panel-password-crypto";
import { BadGatewayException, BadRequestException, Injectable } from "@nestjs/common";
import { fetch as undiciFetch, Headers, FormData, type Dispatcher, Agent } from "undici";

const PANEL_TIMEOUT_MS = Number(process.env.CHORDV_XUI_TIMEOUT_MS ?? 30000);
const PANEL_USER_AGENT = "ChordV/0.1";
const DEFAULT_PANEL_PATH = "/";

class XuiPanelPathNotFoundError extends BadGatewayException {}

type XuiNodeConfig = {
  id: string;
  panelBaseUrl: string | null;
  panelApiBasePath: string | null;
  panelUsername: string | null;
  panelPassword: string | null;
  panelInboundId: number | null;
  panelRequestTimeoutMs?: number | null;
  panelAbortSignal?: AbortSignal | null;
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
  tgId: string | number;
  comment: string;
};

type XuiPanelClientPayload = Omit<XuiClientPayload, "tgId"> & {
  tgId: number;
};

type XuiClientRemovalStatus = "deleted" | "disabled" | "not_found";

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
  tgId?: string | number;
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
  mldsa65Verify: string;
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
  csrfToken?: string | null;
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
    const matches = this.findInboundClients(inbound, payload.email);
    const exactMatch = matches.find((item) => item.id === payload.id) ?? null;
    const existing = exactMatch ?? matches.find((item) => item.enable !== false) ?? matches[0] ?? null;
    if (matches.length > 1) {
      await this.removeInboundClients(node, inbound.id, matches.filter((item) => item !== existing));
    }
    if (existing) {
      const resolvedId = existing.id || payload.id;
      if (
        existing.enable === false ||
        (existing.expiryTime ?? 0) !== payload.expiryTime ||
        (existing.flow ?? "") !== payload.flow ||
        (existing.comment ?? "") !== payload.comment
      ) {
        await this.updateClient(
          node,
          {
            ...payload,
            id: resolvedId
          },
          resolvedId
        );
      }
      return {
        email: existing.email || payload.email,
        uuid: resolvedId,
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
    const matches = this.findInboundClients(inbound, email);
    if (matches.length === 0) {
      if (enabled) {
        throw new BadGatewayException(`3x-ui 未找到客户端 ${email}`);
      }
      return;
    }

    for (const existing of matches) {
      if (existing.enable === enabled) {
        continue;
      }
      await this.updateClient(
        node,
        {
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
        },
        existing.id || clientId
      );
    }
  }

  async removeClient(node: XuiNodeConfig, clientId: string, email: string): Promise<XuiClientRemovalStatus> {
    const directStatus = await this.removeClientByEmail(node, email);
    if (directStatus) {
      return directStatus;
    }

    let inbound: XuiInbound;
    try {
      inbound = await this.getInbound(node);
    } catch (error) {
      if (isPanelRecordNotFoundError(error) || isInboundMissingError(error)) {
        return "not_found";
      }
      throw error;
    }
    const matches = this.findInboundClients(inbound, email);
    if (matches.length === 0) {
      return "not_found";
    }
    return this.removeInboundClients(node, inbound.id, matches, clientId);
  }

  async resetClientTraffic(node: XuiNodeConfig, email: string): Promise<boolean> {
    const inboundId = await this.resolveInboundId(node);
    const inbound = await this.getInbound(node);
    if (this.findInboundClients(inbound, email).length === 0) {
      return false;
    }
    try {
      await this.request({
        node,
        path: `/panel/api/clients/resetTraffic/${encodeURIComponent(email)}`,
        method: "POST",
        useJson: true
      });
      return true;
    } catch (error) {
      if (!isPanelFallbackMissError(error)) {
        throw error;
      }
    }

    const attempts = [
      { path: `/panel/api/inbounds/resetClientTraffic/${inboundId}/${encodeURIComponent(email)}` },
      { path: `/panel/api/inbounds/${inboundId}/resetClientTraffic/${encodeURIComponent(email)}` },
      {
        path: `/panel/api/inbounds/resetClientTraffic/${encodeURIComponent(email)}`,
        body: JSON.stringify({ id: inboundId }),
        contentType: "application/json"
      }
    ];

    let lastResetFallbackError: unknown = null;
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
        return true;
      } catch (error) {
        lastResetFallbackError = error;
        if (!isPanelFallbackMissError(error)) {
          throw error;
        }
        continue;
      }
    }

    const refreshedInbound = await this.getInbound(node);
    if (this.findInboundClients(refreshedInbound, email).length === 0) {
      return false;
    }

    throw new BadGatewayException(
      `Reset 3x-ui client traffic failed: ${email}${lastResetFallbackError ? `: ${readErrorMessage(lastResetFallbackError)}` : ""}`
    );
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
    const serverPort = typeof inbound.port === "number" && Number.isFinite(inbound.port) ? inbound.port : null;
    const uuid = readString(firstClient?.id);
    const realityPublicKey =
      readString(realityDerivedSettings?.publicKey) ??
      readString(realitySettings?.publicKey) ??
      readString(streamSettings?.publicKey);
    const shortId =
      shortIds[0] ??
      readString(realityDerivedSettings?.shortId) ??
      readString(realitySettings?.shortId) ??
      readString(streamSettings?.shortId) ??
      "";
    const serverName =
      readString(realityDerivedSettings?.serverName) ??
      readString(realitySettings?.serverName) ??
      readString(streamSettings?.serverName) ??
      serverNames[0];
    const fingerprint =
      readString(realityDerivedSettings?.fingerprint) ??
      readString(realitySettings?.fingerprint) ??
      readString(streamSettings?.fingerprint) ??
      "chrome";
    const spiderX =
      readString(realityDerivedSettings?.spiderX) ??
      readString(realitySettings?.spiderX) ??
      readString(streamSettings?.spiderX) ??
      "/";
    const mldsa65Verify =
      readString(realityDerivedSettings?.mldsa65Verify) ??
      readString(realityDerivedSettings?.pqv) ??
      readString(realitySettings?.mldsa65Verify) ??
      readString(realitySettings?.pqv) ??
      readString(streamSettings?.mldsa65Verify) ??
      readString(streamSettings?.pqv) ??
      "";

    if (!serverPort) {
      throw new BadGatewayException("3x-ui 入站端口配置缺失");
    }
    if (!uuid) {
      throw new BadGatewayException("3x-ui 入站客户端 UUID 缺失");
    }
    if (!realityPublicKey) {
      throw new BadGatewayException("3x-ui Reality publicKey 配置缺失");
    }
    if (!serverName) {
      throw new BadGatewayException("3x-ui Reality serverName 配置缺失");
    }

    return {
      inboundId: inbound.id,
      name: readString(inbound.remark) ?? `${panelHost}:${inbound.port ?? 443}`,
      serverHost: resolveInboundServerHost(readString(inbound.listen), panelHost),
      serverPort,
      uuid,
      flow: readString(firstClient?.flow) ?? readString(settings?.flow) ?? "xtls-rprx-vision",
      realityPublicKey,
      shortId,
      serverName,
      fingerprint,
      spiderX,
      mldsa65Verify
    };
  }

  async listInbounds(
    node: XuiNodeConfig,
    options?: {
      forceRelogin?: boolean;
      strictCredentialCheck?: boolean;
    }
  ): Promise<XuiInboundSummary[]> {
    const payload = await this.request({
      node,
      path: "/panel/api/inbounds/list",
      method: "GET",
      forceRelogin: options?.forceRelogin,
      strictCredentialCheck: options?.strictCredentialCheck
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
    const panelClient = toPanelClientPayload(client);
    try {
      await this.request({
        node,
        path: "/panel/api/clients/add",
        method: "POST",
        body: JSON.stringify({
          client: panelClient,
          inboundIds: [inboundId]
        }),
        contentType: "application/json",
        useJson: true
      });
      return;
    } catch (error) {
      if (!isPanelFallbackMissError(error)) {
        throw error;
      }
    }

    await this.request({
      node,
      path: "/panel/api/inbounds/addClient",
      method: "POST",
      body: JSON.stringify({
        id: inboundId,
        settings: JSON.stringify({
          clients: [panelClient]
        })
      }),
      contentType: "application/json",
      useJson: true
    });
  }

  private async updateClient(node: XuiNodeConfig, client: XuiClientPayload, targetClientId?: string) {
    const inboundId = await this.resolveInboundId(node);
    const panelClient = toPanelClientPayload(client);
    try {
      const hydratedPanelClient = await this.hydratePanelClientPayload(node, client.email, panelClient);
      await this.request({
        node,
        path: `/panel/api/clients/update/${encodeURIComponent(client.email)}`,
        method: "POST",
        body: JSON.stringify(hydratedPanelClient),
        contentType: "application/json",
        useJson: true
      });
      return;
    } catch (error) {
      if (!isPanelFallbackMissError(error)) {
        throw error;
      }
    }

    const attempts = [
      `/panel/api/inbounds/updateClient/${encodeURIComponent(targetClientId ?? client.id)}`,
      `/panel/api/inbounds/updateClient/${inboundId}/${encodeURIComponent(targetClientId ?? client.id)}`
    ];

    let lastFallbackError: unknown = null;
    for (const path of attempts) {
      try {
        await this.request({
          node,
          path,
          method: "POST",
          body: JSON.stringify({
            id: inboundId,
            settings: JSON.stringify({
              clients: [panelClient]
            })
          }),
          contentType: "application/json",
          useJson: true
        });
        return;
      } catch (error) {
        lastFallbackError = error;
        if (!isPanelFallbackMissError(error)) {
          throw error;
        }
        continue;
      }
    }

    throw new BadGatewayException(
      `Update 3x-ui client failed${lastFallbackError ? `: ${readErrorMessage(lastFallbackError)}` : ""}`
    );
  }

  private async hydratePanelClientPayload(
    node: XuiNodeConfig,
    email: string,
    fallback: XuiPanelClientPayload
  ): Promise<Record<string, unknown> & XuiPanelClientPayload> {
    try {
      const payload = await this.request({
        node,
        path: `/panel/api/clients/get/${encodeURIComponent(email)}`,
        method: "GET",
        useJson: true
      });
      const existing = readPanelClientPayloadObject(readObj(payload));
      if (!existing) {
        return fallback;
      }
      return {
        ...existing,
        ...fallback,
        id: readString(existing.id) ?? fallback.id,
        email: readString(existing.email) ?? fallback.email
      };
    } catch (error) {
      if (!isPanelFallbackMissError(error)) {
        throw error;
      }
      return fallback;
    }
  }

  private async request({
    node,
    path,
    method = "GET",
    body,
    contentType,
    useJson = true,
    forceRelogin = false,
    strictCredentialCheck = false
  }: XuiRequestOptions & {
    forceRelogin?: boolean;
    strictCredentialCheck?: boolean;
  }) {
    const normalized = normalizeNodeConfig(node);
    const key = this.sessionKey(normalized);

    if (forceRelogin) {
      this.sessions.delete(key);
    }

    if (!this.sessions.has(key)) {
      await this.login(normalized, { strictCredentialCheck });
    }

    let response = await this.performRequest(normalized, path, method, body, contentType);
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      this.sessions.delete(key);
      await this.login(normalized, { strictCredentialCheck });
      response = await this.performRequest(normalized, path, method, body, contentType);
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw new XuiPanelPathNotFoundError("3x-ui 面板接口路径错误，请检查面板地址或 API 基础路径");
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
    headers.set("X-Requested-With", "XMLHttpRequest");
    const sessionKey = this.sessionKey(node);
    const session = this.sessions.get(sessionKey);
    if (method !== "GET") {
      const csrfToken = await this.ensureCsrfToken(node, session);
      if (csrfToken) {
        headers.set("X-CSRF-Token", csrfToken);
      }
    }
    const nextSession = this.sessions.get(sessionKey) ?? session;
    if (nextSession?.cookieHeader) {
      headers.set("Cookie", nextSession.cookieHeader);
    }
    if (body && contentType && !(body instanceof FormData)) {
      headers.set("Content-Type", contentType);
    }

    return this.fetchPanel(node, path, {
      method,
      body,
      headers,
      signal: createPanelRequestSignal(node)
    });
  }

  private async login(
    node: NormalizedXuiNodeConfig,
    options?: {
      strictCredentialCheck?: boolean;
    }
  ) {
    const csrfState = await this.fetchCsrfToken(node);
    const form = new URLSearchParams();
    form.set("username", node.panelUsername);
    form.set("password", node.panelPassword);
    form.set("twoFactorCode", "");

    const headers = new Headers();
    headers.set("User-Agent", PANEL_USER_AGENT);
    headers.set("X-Requested-With", "XMLHttpRequest");
    headers.set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
    if (csrfState.cookieHeader) {
      headers.set("Cookie", csrfState.cookieHeader);
    }
    if (csrfState.csrfToken) {
      headers.set("X-CSRF-Token", csrfState.csrfToken);
    }

    const response = await this.fetchPanel(node, "/login", {
      method: "POST",
      body: form.toString(),
      headers,
      signal: createPanelRequestSignal(node)
    });

    const responseText = await response.text().catch(() => "");
    const payload = parseJsonRecord(responseText);
    const loginMessage = readString(payload?.msg);
    const loginSuccess = typeof payload?.success === "boolean" ? payload.success : null;
    const strictCredentialCheck = options?.strictCredentialCheck ?? false;

    if (response.status === 404) {
      throw new BadGatewayException("3x-ui 登录接口不存在，请检查面板地址或 API 基础路径");
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403 || isCredentialError(loginMessage)) {
        if (response.status === 401 || isCredentialError(loginMessage)) {
          throw new BadRequestException("3x-ui 账号或密码错误");
        }
        throw new BadGatewayException("3x-ui 登录请求被面板拒绝，请检查面板路径或 CSRF 校验");
      }
      throw new BadGatewayException(`3x-ui 登录失败：HTTP ${response.status}`);
    }

    if (loginSuccess === false) {
      if (isCredentialError(loginMessage)) {
        throw new BadRequestException("3x-ui 账号或密码错误");
      }
      throw new BadGatewayException(loginMessage ? `3x-ui 登录失败：${loginMessage}` : "3x-ui 登录失败");
    }

    const cookieHeader = mergeCookieHeaders(csrfState.cookieHeader, readCookieHeader(response.headers));
    if (!cookieHeader) {
      if (isCredentialError(loginMessage)) {
        throw new BadRequestException("3x-ui 账号或密码错误");
      }
      if (strictCredentialCheck) {
        throw new BadGatewayException("3x-ui 登录失败：未获取到会话 Cookie，请检查面板地址或登录接口路径");
      }
      throw new BadGatewayException("3x-ui 登录失败：未获取到会话 Cookie，请检查面板地址或登录接口路径");
    }

    this.sessions.set(this.sessionKey(node), { cookieHeader, csrfToken: csrfState.csrfToken });
  }

  private async ensureCsrfToken(node: NormalizedXuiNodeConfig, session?: XuiSessionState) {
    if (session?.csrfToken) {
      return session.csrfToken;
    }

    const csrfState = await this.fetchCsrfToken(node, session?.cookieHeader);
    const cookieHeader = mergeCookieHeaders(session?.cookieHeader, csrfState.cookieHeader);
    const csrfToken = csrfState.csrfToken ?? session?.csrfToken ?? null;
    if (cookieHeader) {
      this.sessions.set(this.sessionKey(node), { cookieHeader, csrfToken });
    }
    return csrfToken;
  }

  private async fetchCsrfToken(node: NormalizedXuiNodeConfig, cookieHeader?: string | null) {
    try {
      const headers = new Headers();
      headers.set("User-Agent", PANEL_USER_AGENT);
      headers.set("X-Requested-With", "XMLHttpRequest");
      if (cookieHeader) {
        headers.set("Cookie", cookieHeader);
      }
      const response = await this.fetchPanel(node, "/csrf-token", {
        method: "GET",
        headers,
        signal: createPanelRequestSignal(node)
      });
      const responseText = await response.text().catch(() => "");
      const payload = parseJsonRecord(responseText);
      const token = response.ok && payload?.success === true ? readString(payload.obj) : null;
      return {
        csrfToken: token,
        cookieHeader: mergeCookieHeaders(cookieHeader, readCookieHeader(response.headers))
      };
    } catch {
      return {
        csrfToken: null,
        cookieHeader: cookieHeader ?? null
      };
    }
  }

  private async fetchPanel(
    node: NormalizedXuiNodeConfig,
    path: string,
    init: {
      method: "GET" | "POST";
      body?: BodyInitLike | URLSearchParams | null;
      headers: Headers;
      signal: AbortSignal;
    }
  ) {
    try {
      return await undiciFetch(`${normalizeBaseUrl(node.panelBaseUrl)}${joinPanelPath(node.panelApiBasePath, path)}`, {
        ...init,
        dispatcher: this.dispatcher
      });
    } catch (error) {
      throw new BadGatewayException(`3x-ui panel request failed: ${readPanelFetchErrorMessage(error)}`);
    }
  }

  private extractInboundClients(inbound: XuiInbound) {
    const settings = parseJsonRecord(inbound.settings);
    const clients = settings?.clients;
    return Array.isArray(clients) ? (clients.filter((item) => item && typeof item === "object") as XuiInboundClient[]) : [];
  }

  private findInboundClient(inbound: XuiInbound, email: string) {
    return this.findInboundClients(inbound, email)[0] ?? null;
  }

  private findInboundClients(inbound: XuiInbound, email: string) {
    const normalizedEmail = email.trim().toLowerCase();
    return this.extractInboundClients(inbound).filter((item) => item.email?.trim().toLowerCase() === normalizedEmail);
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
      const current = statsByEmail.get(email);
      if (!current) {
        statsByEmail.set(email, item);
        continue;
      }
      statsByEmail.set(email, {
        ...current,
        email: current.email || item.email,
        uuid: current.uuid || item.uuid,
        up: (toBigInt(current.up) + toBigInt(item.up)).toString(),
        down: (toBigInt(current.down) + toBigInt(item.down)).toString(),
        total: (toBigInt(current.total) + toBigInt(item.total)).toString()
      });
    }

    const settings = parseJsonRecord(inbound.settings);
    const settingsStats = settings?.clientStats;
    if (Array.isArray(settingsStats)) {
      for (const item of settingsStats as XuiInboundStat[]) {
        const email = item.email?.trim().toLowerCase();
        if (!email || statsByEmail.has(email)) {
          continue;
        }
        statsByEmail.set(email, item);
      }
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

  private async removeClientByEmail(node: XuiNodeConfig, email: string): Promise<XuiClientRemovalStatus | null> {
    try {
      await this.request({
        node,
        path: `/panel/api/clients/del/${encodeURIComponent(email)}`,
        method: "POST",
        useJson: true
      });
      return "deleted";
    } catch (error) {
      if (isPanelRecordNotFoundError(error)) {
        return null;
      }
      if (isPanelPathNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  private sessionKey(node: XuiNodeConfig) {
    return [
      node.panelBaseUrl ?? "",
      node.panelApiBasePath ?? "",
      node.panelUsername ?? "",
      hashCredential(node.panelPassword ?? "")
    ].join("|");
  }

  private async removeInboundClients(
    node: XuiNodeConfig,
    inboundId: number,
    clients: XuiInboundClient[],
    fallbackClientId?: string
  ): Promise<XuiClientRemovalStatus> {
    let deletedAny = false;
    let disabledAny = false;
    for (const client of clients) {
      const email = client.email?.trim();
      if (!email) {
        continue;
      }
      const resolvedClientId = client.id || fallbackClientId || email;
      let removed = false;
      try {
        await this.request({
          node,
          path: `/panel/api/clients/del/${encodeURIComponent(email)}`,
          method: "POST",
          useJson: true
        });
        removed = true;
        deletedAny = true;
      } catch (error) {
        if (isPanelRecordNotFoundError(error)) {
          removed = false;
        } else if (!isPanelPathNotFoundError(error)) {
          throw error;
        }
      }

      const attempts = [
        { path: `/panel/api/inbounds/${inboundId}/delClient/${encodeURIComponent(resolvedClientId)}` },
        {
          path: `/panel/api/inbounds/delClient/${encodeURIComponent(resolvedClientId)}`,
          body: JSON.stringify({ id: inboundId }),
          contentType: "application/json"
        },
        { path: `/panel/api/inbounds/delClient/${inboundId}/${encodeURIComponent(resolvedClientId)}` },
        { path: `/panel/api/inbounds/delClientByEmail/${encodeURIComponent(email)}` },
        { path: `/panel/api/inbounds/delClient/${encodeURIComponent(email)}` }
      ];

      if (!removed) {
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
            removed = true;
            deletedAny = true;
            break;
          } catch (error) {
            if (!isPanelFallbackMissError(error)) {
              throw error;
            }
            continue;
          }
        }
      }

      if (removed) {
        continue;
      }

      const refreshedInbound = await this.getInbound(node);
      const remaining = this.findInboundClients(refreshedInbound, email);
      if (remaining.length === 0) {
        deletedAny = true;
        continue;
      }

      for (const stale of remaining) {
        await this.updateClient(
          node,
          {
            id: stale.id || resolvedClientId,
            email: stale.email || email,
            enable: false,
            flow: stale.flow ?? "",
            expiryTime: stale.expiryTime ?? 0,
            limitIp: stale.limitIp ?? 0,
            totalGB: stale.totalGB ?? 0,
            subId: stale.subId ?? "",
            reset: stale.reset ?? 0,
            tgId: stale.tgId ?? "",
            comment: stale.comment ?? ""
          },
          stale.id || resolvedClientId
        );
        disabledAny = true;
      }
    }
    if (disabledAny) {
      return "disabled";
    }
    return deletedAny ? "deleted" : "not_found";
  }
}

function hashCredential(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeNodeConfig(node: XuiNodeConfig) {
  const panelPassword = decryptPanelPassword(node.panelPassword)?.trim() || "";
  if (!node.panelBaseUrl?.trim() || !node.panelUsername?.trim() || !panelPassword) {
    throw new BadRequestException("节点缺少 3x-ui 面板配置");
  }

  const panelLocation = normalizePanelLocation(node.panelBaseUrl, node.panelApiBasePath);
  return {
    ...node,
    panelBaseUrl: panelLocation.panelBaseUrl,
    panelApiBasePath: panelLocation.panelApiBasePath,
    panelUsername: node.panelUsername.trim(),
    panelPassword
  } satisfies NormalizedXuiNodeConfig;
}

function normalizePanelLocation(panelBaseUrl: string, panelApiBasePath: string | null) {
  const trimmedBaseUrl = panelBaseUrl.trim().replace(/\/+$/, "");
  const normalizedInputPath = normalizePanelBasePath(panelApiBasePath);

  try {
    const parsed = new URL(trimmedBaseUrl);
    const urlPath = normalizePanelBasePath(parsed.pathname);
    const normalizedBaseUrl = `${parsed.protocol}//${parsed.host}`;
    if (!urlPath) {
      return {
        panelBaseUrl: normalizedBaseUrl,
        panelApiBasePath: normalizedInputPath
      };
    }
    return {
      panelBaseUrl: normalizedBaseUrl,
      panelApiBasePath: mergePanelBasePaths(urlPath, normalizedInputPath)
    };
  } catch {
    return {
      panelBaseUrl: trimmedBaseUrl,
      panelApiBasePath: normalizedInputPath
    };
  }
}

function normalizePanelBasePath(input: string | null) {
  const raw = input?.trim() || DEFAULT_PANEL_PATH;
  if (raw === "/") {
    return "";
  }
  const path = readUrlPath(raw) ?? raw;
  const withoutSlashes = path.replace(/^\/+/, "").replace(/\/+$/, "");
  const withoutApiSuffix = withoutSlashes.replace(/(?:^|\/)panel\/api$/i, "");
  if (!withoutApiSuffix) {
    return "";
  }
  return `/${withoutApiSuffix.replace(/\/+$/, "")}`;
}

function readUrlPath(raw: string) {
  try {
    const parsed = new URL(raw);
    return parsed.pathname;
  } catch {
    return null;
  }
}

function mergePanelBasePaths(urlPath: string, inputPath: string) {
  if (!inputPath || inputPath === urlPath) {
    return urlPath;
  }
  if (inputPath.startsWith(`${urlPath}/`)) {
    return inputPath;
  }
  if (urlPath.startsWith(`${inputPath}/`)) {
    return urlPath;
  }
  return `${urlPath}${inputPath}`;
}

function joinPanelPath(basePath: string, path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${basePath}${normalizedPath}`;
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/$/, "");
}

function resolvePanelRequestTimeoutMs(node: XuiNodeConfig) {
  const timeoutMs = Number(node.panelRequestTimeoutMs);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : PANEL_TIMEOUT_MS;
}

function createPanelRequestSignal(node: XuiNodeConfig) {
  const timeoutSignal = AbortSignal.timeout(resolvePanelRequestTimeoutMs(node));
  if (!node.panelAbortSignal) {
    return timeoutSignal;
  }
  return AbortSignal.any([node.panelAbortSignal, timeoutSignal]);
}

function readCookieHeader(headers: Headers) {
  const cookies = headers.getSetCookie?.() ?? [];
  const cookieHeader = cookies.map((item) => item.split(";")[0]).filter(Boolean).join("; ");
  if (cookieHeader) {
    return cookieHeader;
  }
  const fallbackCookie = headers.get("set-cookie");
  return fallbackCookie ? fallbackCookie.split(";")[0] : null;
}

function mergeCookieHeaders(...headers: Array<string | null | undefined>) {
  const cookies = new Map<string, string>();
  for (const header of headers) {
    if (!header) {
      continue;
    }
    for (const cookie of header.split(/;\s*/)) {
      const normalized = cookie.trim();
      const separatorIndex = normalized.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }
      cookies.set(normalized.slice(0, separatorIndex), normalized);
    }
  }
  return Array.from(cookies.values()).join("; ") || null;
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

function readPanelClientPayloadObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if ("client" in value) {
    const client = Reflect.get(value, "client");
    return client && typeof client === "object" ? (client as Record<string, unknown>) : null;
  }
  if ("email" in value || "id" in value) {
    return value as Record<string, unknown>;
  }
  return null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readPanelFetchErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
}

function resolveInboundServerHost(listen: string | null, panelHost: string) {
  if (!listen || listen === "0.0.0.0" || listen === "::" || listen === "[::]") {
    return panelHost;
  }
  return listen;
}

function toPanelClientPayload(client: XuiClientPayload): XuiPanelClientPayload {
  return {
    ...client,
    limitIp: toFiniteInteger(client.limitIp),
    totalGB: toFiniteInteger(client.totalGB),
    expiryTime: toFiniteInteger(client.expiryTime),
    reset: toFiniteInteger(client.reset),
    tgId: toFiniteInteger(client.tgId)
  };
}

function toFiniteInteger(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
  }
  return 0;
}

function isPanelPathNotFoundError(error: unknown) {
  return error instanceof XuiPanelPathNotFoundError;
}

function isPanelFallbackMissError(error: unknown) {
  return isPanelPathNotFoundError(error) || isPanelRecordNotFoundError(error);
}

function isPanelRecordNotFoundError(error: unknown) {
  if (error instanceof Error && /record\s+not\s+found|not\s+found/i.test(error.message)) {
    return true;
  }
  if (error instanceof BadGatewayException) {
    const response = error.getResponse();
    if (typeof response === "string") {
      return /record\s+not\s+found|not\s+found/i.test(response);
    }
    if (response && typeof response === "object") {
      const message = Reflect.get(response, "message");
      return typeof message === "string" && /record\s+not\s+found|not\s+found/i.test(message);
    }
  }
  return false;
}

function isInboundMissingError(error: unknown) {
  const message = readExceptionMessage(error);
  return /inbound|入站|no available/i.test(message) && /not\s+found|missing|没有|未找到|no available/i.test(message);
}

function readExceptionMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (error instanceof BadGatewayException || error instanceof BadRequestException) {
    const response = error.getResponse();
    if (typeof response === "string") {
      return response;
    }
    if (response && typeof response === "object") {
      const message = Reflect.get(response, "message");
      if (Array.isArray(message)) {
        return message.join(" ");
      }
      if (typeof message === "string") {
        return message;
      }
    }
  }
  return "";
}

function readErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "unknown error";
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
