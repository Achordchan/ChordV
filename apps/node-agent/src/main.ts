import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AgentApiClient, requestRegister } from './api-client.js';
import { loadConfig, type AgentCredentials, type AgentConfig } from './config.js';
import { AgentRunner } from './runner.js';
import { AgentStore } from './store.js';
import { XtlsXrayAdapter } from './xray-adapter.js';

const AGENT_VERSION = process.env.npm_package_version || 'dev';

function detectArch(): 'linux-x64' | 'linux-arm64' {
  if (process.platform !== 'linux') return 'linux-x64';
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
}

function loadPersistedCredentials(path: string): AgentCredentials | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AgentCredentials>;
    if (parsed.agentId && parsed.nodeId && parsed.token) {
      return { agentId: parsed.agentId, nodeId: parsed.nodeId, token: parsed.token };
    }
  } catch {
    // corrupt/partial file: fall through to re-register if a token is available
  }
  return null;
}

function persistCredentials(path: string, credentials: AgentCredentials): void {
  writeFileSync(path, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort hardening; the initial mode already restricts reads
  }
}

/**
 * Resolve this boot's credentials: persisted file first (restart without
 * re-registering), then the one-time register token (first boot), then the
 * environment (operator-managed, pre-registration flow compatibility).
 */
async function resolveCredentials(config: AgentConfig): Promise<AgentCredentials> {
  const persisted = loadPersistedCredentials(config.credentialsPath);
  if (persisted) return persisted;
  if (config.registerToken) {
    console.log('[node-agent] 无本地凭据，正在使用注册令牌接入…');
    const response = await requestRegister(config.apiBaseUrl, {
      registerToken: config.registerToken,
      hostname: hostname(),
      arch: detectArch(),
      agentVersion: AGENT_VERSION,
      bootId: randomUUID(),
    });
    const credentials: AgentCredentials = {
      agentId: response.agentId,
      nodeId: response.nodeId,
      token: response.token,
    };
    persistCredentials(config.credentialsPath, credentials);
    console.log(`[node-agent] 注册成功 agent=${response.agentId} node=${response.nodeId}（凭据已持久化）`);
    return credentials;
  }
  if (config.agentId && config.nodeId && config.token) {
    return { agentId: config.agentId, nodeId: config.nodeId, token: config.token };
  }
  throw new Error('无可用凭据：本地凭据文件缺失且未提供 CHORDV_REGISTER_TOKEN');
}

async function main(): Promise<void> {
  const config = loadConfig();
  const credentials = await resolveCredentials(config);
  const bootId = randomUUID();
  const store = new AgentStore(config.databasePath, {
    nodeId: credentials.nodeId,
    bootId,
    defaultOfflineAllowanceBytes: config.offlineAllowanceBytes,
  });
  const xray = new XtlsXrayAdapter(config.xrayApiAddress, config.xrayInboundTag);
  const api = new AgentApiClient({
    baseUrl: config.apiBaseUrl,
    token: credentials.token,
    agentId: credentials.agentId,
    nodeId: credentials.nodeId,
  });

  if (process.argv.includes('--health')) {
    await xray.health();
    console.log(JSON.stringify({ ok: true, ...store.healthSnapshot() }));
    store.close();
    return;
  }

  const runner = new AgentRunner(config, store, api, xray);
  await runner.start();
  console.log(`[node-agent] 已启动，node=${credentials.nodeId} boot=${bootId}`);

  const shutdown = async (signal: string) => {
    console.log(`[node-agent] 收到 ${signal}，正在保存最后计量样本`);
    await runner.stop();
    store.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error(`[node-agent] 启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
