import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface AgentCredentials {
  agentId: string;
  nodeId: string;
  token: string;
}

export interface AgentConfig {
  agentId: string;
  nodeId: string;
  token: string;
  apiBaseUrl: string;
  xrayApiAddress: string;
  xrayInboundTag: string;
  databasePath: string;
  sampleIntervalMs: number;
  heartbeatIntervalMs: number;
  offlineAllowanceBytes: bigint;
  /** Set when the agent starts with a one-time registration token instead of credentials. */
  registerToken?: string;
  /** Where registered credentials are persisted (mode 600), enabling restarts without re-registering. */
  credentialsPath: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}

export function assertLocalXrayAddress(address: string): void {
  const normalized = address.toLowerCase();
  if (
    normalized.startsWith('unix:') ||
    normalized.startsWith('127.0.0.1:') ||
    normalized.startsWith('localhost:') ||
    normalized.startsWith('[::1]:')
  ) return;
  throw new Error('XRAY_API_ADDRESS 只能使用 Unix Socket 或本机 loopback 地址');
}

export function assertSafeApiBaseUrl(value: string): void {
  const url = new URL(value);
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('CHORDV_API_BASE_URL 在非本机环境必须使用 HTTPS');
  }
}

export function loadConfig(): AgentConfig {
  const xrayApiAddress = process.env.XRAY_API_ADDRESS?.trim() || '127.0.0.1:10085';
  assertLocalXrayAddress(xrayApiAddress);
  const offlineAllowance = process.env.AGENT_OFFLINE_ALLOWANCE_BYTES || String(64 * 1024 * 1024);
  const offlineAllowanceBytes = BigInt(offlineAllowance);
  if (offlineAllowanceBytes <= 0n) throw new Error('AGENT_OFFLINE_ALLOWANCE_BYTES 必须大于 0');

  const apiBaseUrl = required('CHORDV_API_BASE_URL').replace(/\/$/, '');
  assertSafeApiBaseUrl(apiBaseUrl);
  // Credentials may be absent on FIRST boot when a one-time register token is
  // supplied instead; the register exchange persists credentials for later boots.
  // A missing environment trio is NOT fatal by itself — the persisted credentials
  // file may hold them (checked later in main.ts); only fail when no source at
  // all is available.
  const agentId = process.env.CHORDV_AGENT_ID?.trim() || '';
  const nodeId = process.env.CHORDV_NODE_ID?.trim() || '';
  const token = process.env.CHORDV_AGENT_TOKEN?.trim() || '';
  const registerToken = process.env.CHORDV_REGISTER_TOKEN?.trim() || '';
  const hasEnvCredentials = Boolean(agentId && nodeId && token);
  const hasPartialCredentials = Boolean(agentId || nodeId || token);
  const partialAndRegister = hasPartialCredentials && !hasEnvCredentials && registerToken;
  if (partialAndRegister) {
    throw new Error('CHORDV_REGISTER_TOKEN 与既有凭据互斥：请仅提供注册令牌（首次接入）或完整凭据');
  }
  if (hasEnvCredentials && registerToken) {
    // Complete credentials plus a register token is a misconfiguration: the
    // register token would silently win at registration time only if the
    // persisted-credentials file were also missing, which is never the intended
    // combination. Fail loudly instead.
    throw new Error('CHORDV_REGISTER_TOKEN 与既有凭据互斥：请仅提供注册令牌（首次接入）或完整凭据');
  }
  const hasCredentialsFile = existsSync(
    resolve(process.env.AGENT_CREDENTIALS_PATH || './data/credentials.json')
  );
  if (!hasEnvCredentials && !registerToken && !hasCredentialsFile) {
    throw new Error(
      '缺少环境变量：需要 CHORDV_AGENT_ID/CHORDV_NODE_ID/CHORDV_AGENT_TOKEN，或首次启动提供 CHORDV_REGISTER_TOKEN，或存在已注册的本地凭据文件'
    );
  }
  return {
    agentId,
    nodeId,
    token,
    apiBaseUrl,
    xrayApiAddress,
    xrayInboundTag: process.env.XRAY_INBOUND_TAG?.trim() || 'vless-in',
    databasePath: resolve(process.env.AGENT_DATABASE_PATH || './data/node-agent.db'),
    ...(registerToken && !token ? { registerToken } : {}),
    credentialsPath: resolve(process.env.AGENT_CREDENTIALS_PATH || './data/credentials.json'),
    sampleIntervalMs: positiveInteger('AGENT_SAMPLE_INTERVAL_MS', 5_000),
    heartbeatIntervalMs: positiveInteger('AGENT_HEARTBEAT_INTERVAL_MS', 15_000),
    offlineAllowanceBytes,
  };
}
