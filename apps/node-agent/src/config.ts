import { resolve } from 'node:path';

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
  return {
    agentId: required('CHORDV_AGENT_ID'),
    nodeId: required('CHORDV_NODE_ID'),
    token: required('CHORDV_AGENT_TOKEN'),
    apiBaseUrl,
    xrayApiAddress,
    xrayInboundTag: process.env.XRAY_INBOUND_TAG?.trim() || 'vless-in',
    databasePath: resolve(process.env.AGENT_DATABASE_PATH || './data/node-agent.db'),
    sampleIntervalMs: positiveInteger('AGENT_SAMPLE_INTERVAL_MS', 5_000),
    heartbeatIntervalMs: positiveInteger('AGENT_HEARTBEAT_INTERVAL_MS', 15_000),
    offlineAllowanceBytes,
  };
}
